import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROFILE } from './matcher.mjs';
import { canonicalUrl, listingIdentity, planListingUpsert, listingUpdate } from './store-listings.mjs';

export { canonicalUrl } from './store-listings.mjs';
import {facebookOfferKey} from './facebook-terms.mjs';

const now = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.data) : null;
const priceFields = ['rent_base', 'rent_total', 'rent_advertised_total'];
const availabilityFields = ['availability', 'start_date', 'start_month', 'end_date', 'availability_periods'];
const snapshotFields = [...priceFields, ...availabilityFields];
const snapshot = row => `json_object(${snapshotFields.map(key => `'${key}', json_extract(${row}.data, '$.${key}')`).join(', ')})`;
const changed = fields => fields.map(key => `json_extract(OLD.data, '$.${key}') IS NOT json_extract(NEW.data, '$.${key}')`).join(' OR ');

export class Store {
  constructor(path = './data/housing.sqlite', { readOnly = false, existing = false } = {}) {
    if (readOnly || existing) {
      const uri = pathToFileURL(path);
      uri.searchParams.set('mode', readOnly ? 'ro' : 'rw');
      this.db = new DatabaseSync(uri.href, { readOnly });
      this.db.exec('PRAGMA busy_timeout=5000;');
      return;
    }
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(endpoint TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,unique_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_runs(
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        checked INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0,
        changed INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS collector_runs_finished_at ON collector_runs(finished_at);

      CREATE TABLE IF NOT EXISTS listing_history(
        id INTEGER PRIMARY KEY, listing_id TEXT NOT NULL, kind TEXT NOT NULL,
        before_data TEXT NOT NULL, after_data TEXT NOT NULL, changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS listing_history_listing_id ON listing_history(listing_id);
      CREATE TRIGGER IF NOT EXISTS record_listing_history AFTER UPDATE OF data ON listings
      BEGIN
        INSERT INTO listing_history(listing_id,kind,before_data,after_data,changed_at)
          SELECT NEW.id,'price',${snapshot('OLD')},${snapshot('NEW')},json_extract(NEW.data,'$.updated_at')
          WHERE ${changed(priceFields)};
        INSERT INTO listing_history(listing_id,kind,before_data,after_data,changed_at)
          SELECT NEW.id,'availability',${snapshot('OLD')},${snapshot('NEW')},json_extract(NEW.data,'$.updated_at')
          WHERE ${changed(availabilityFields)};
      END;`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  getConfig(key, fallback = null) { return decode(this.db.prepare('SELECT data FROM config WHERE key=?').get(key)) ?? fallback; }
  setConfig(key, value) { this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); }
  upsertListing(input) {
    const canonical = input.url ? canonicalUrl(input.url) : '';
    const identity = listingIdentity(input, canonical);
    const old = decode(this.db.prepare('SELECT data FROM listings WHERE identity=?').get(identity));
    const { data, presentation } = planListingUpsert(input, old, identity, canonical);
    if (!data) {
      const listing = presentation ? this.updateListing(old.id, presentation) : old;
      return { listing, isNew: false, isChanged: false };
    }
    if (!old) {
      const facebookKey=facebookOfferKey(input);
      const duplicate = (canonical||facebookKey)&&this.getListings().find(l => canonical&&l.url===canonical||facebookKey&&facebookOfferKey(l)===facebookKey);
      if (duplicate) data.duplicate_of = duplicate.id;
    }
    this.db.prepare('INSERT INTO listings VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data').run(data.id, identity, JSON.stringify(data));
    return { listing: data, isNew: !old, isChanged: !!old };
  }
  hasListingsTable() { return !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='listings'").get(); }
  getListings(source) {
    if (!this.hasListingsTable()) return [];
    const rows = this.db.prepare('SELECT data FROM listings ORDER BY rowid DESC').all().map(decode);
    return source === undefined ? rows : rows.filter(row => row.source === source);
  }
  getListing(id) { return this.hasListingsTable() ? decode(this.db.prepare('SELECT data FROM listings WHERE id=?').get(id)) : null; }
  getListingHistory() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='listing_history'").get()) return [];
    return this.db.prepare('SELECT listing_id,kind,before_data,after_data,changed_at FROM listing_history ORDER BY id').all()
      .map(row => ({
        listingId: row.listing_id,
        kind: row.kind,
        before: JSON.parse(row.before_data),
        after: JSON.parse(row.after_data),
        changedAt: row.changed_at,
      }));
  }
  updateListing(id, patch, {ownerEdit=false}={}) {
    const old = this.getListing(id); if (!old) return null;
    const result = listingUpdate(old, patch, ownerEdit, this.getConfig('profile', DEFAULT_PROFILE));
    this.db.prepare('UPDATE listings SET data=? WHERE id=?').run(JSON.stringify(result), id); return result;
  }
  addEvent(kind, detail) { this.db.prepare('INSERT INTO events(kind,data,created_at) VALUES(?,?,?)').run(kind, JSON.stringify(detail), now()); }
  getEvents() { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all().map(r => ({ id:r.id, kind:r.kind, detail:JSON.parse(r.data), created_at:r.created_at })); }
  hasMail(id) { return !!this.db.prepare('SELECT id FROM mail WHERE id=?').get(id); }
  saveMail(id, object) { this.db.prepare('INSERT INTO mail VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(object)); }
  saveSubscription(sub) { this.db.prepare('INSERT INTO subscriptions VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data').run(sub.endpoint, JSON.stringify(sub)); }
  getSubscriptions() { return this.db.prepare('SELECT data FROM subscriptions').all().map(decode); }
  deleteSubscription(endpoint) { this.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint); }
  enqueueNotification(key, payload) {
    return !!this.db.prepare('INSERT OR IGNORE INTO notifications(id,unique_key,data,status,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(), key, JSON.stringify(payload), 'pending', now()).changes;
  }
  getPendingNotifications() {
    return this.db.prepare("SELECT * FROM notifications WHERE status IN ('pending','failed') AND attempts<5 ORDER BY updated_at LIMIT 30").all().filter(r => r.status === 'pending' || Date.now() - Date.parse(r.updated_at) > Math.min(3600000, 60000 * 2 ** r.attempts)).map(r => ({...JSON.parse(r.data), id:r.id, unique_key:r.unique_key, payload:JSON.parse(r.data), status:r.status, attempts:r.attempts}));
  }
  markNotification(id, status, error = null) { this.db.prepare('UPDATE notifications SET status=?,error=?,attempts=attempts+1,updated_at=? WHERE id=?').run(status, error, now(), id); }
  getGroups() { return this.db.prepare('SELECT data FROM groups ORDER BY rowid').all().map(decode); }
  upsertGroup(group) { const old=decode(this.db.prepare('SELECT data FROM groups WHERE id=?').get(group.id)); this.db.prepare('INSERT INTO groups VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(group.id,JSON.stringify({...old,...group})); }
  updateGroup(id, patch) { const old=this.getGroups().find(g=>g.id===id); if(!old)return null; this.upsertGroup({...old,...patch,id:old.id}); return this.getGroups().find(g=>g.id===id); }
  startCollectorRun() {
    const id = randomUUID();
    this.db.prepare('INSERT INTO collector_runs(id, started_at) VALUES(?,?)').run(id, now());
    return id;
  }
  finishCollectorRun(id, { checked = 0, added = 0, changed = 0, error = null } = {}) {
    this.db.prepare('UPDATE collector_runs SET finished_at=?,checked=?,added=?,changed=?,error=? WHERE id=?')
      .run(now(), checked, added, changed, error, id);
  }
  latestCollectorRun() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collector_runs'").get()) return null;
    return this.db.prepare('SELECT max(finished_at) AS finished FROM collector_runs').get().finished;
  }
  claimTravelCheck(id, at, cooldownMs) {
    return !!this.db.prepare(`INSERT INTO config(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data
      WHERE CAST(config.data AS INTEGER) <= ?`).run('travel.cooldown.' + id, String(at), at - cooldownMs).changes;
  }
  close() { this.db.close(); }
}