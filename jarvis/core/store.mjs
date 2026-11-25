import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {sourceFingerprint,sourceValues,CHECKED_SOURCE_FACTS} from './listing-review.mjs';
import {evaluateListing,DEFAULT_PROFILE} from './matcher.mjs';
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
    const identity = input.source_id ? `${input.source}:${input.source_id}` : canonical || `${input.source}:${createHash('sha256').update(`${input.title ?? ''}\n${input.body ?? ''}`).digest('hex')}`;
    let old = decode(this.db.prepare('SELECT data FROM listings WHERE identity=?').get(identity));
    // A cross-platform copy must still be reviewed, but is linked to the original application.
    const fingerprint = sourceFingerprint(input);
    if (old && (old.fingerprint===fingerprint || sourceFingerprint(sourceValues(old))===fingerprint)) {
      // Listing photos and routing hints can change independently of housing terms.
      // Update presentation only: preserve decisions, corrections and AI evidence.
      const presentation=Object.fromEntries(['photos','photo_version','address'].filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
      const listing=Object.keys(presentation).some(k=>JSON.stringify(presentation[k])!==JSON.stringify(old[k]))?this.updateListing(old.id,presentation):old;
      return { listing, isNew: false, isChanged: false };
    }
    const previous=old?sourceValues(old):{};delete previous.owner_facts;delete previous.owner_review;
    const data = { ...previous, ...input, ai:old?.ai?.state==='complete'&&old.title===input.title&&old.body===input.body?old.ai:input.ai, owner_facts:null,owner_review:old?.owner_review??null, url: canonical, id: old?.id ?? input.id ?? randomUUID(), identity, fingerprint, created_at: old?.created_at ?? now(), updated_at: now() };
    if (!old) {
      const facebookKey=facebookOfferKey(input);
      const duplicate = (canonical||facebookKey)&&this.getListings().find(l => canonical&&l.url===canonical||facebookKey&&facebookOfferKey(l)===facebookKey);
      if (duplicate) data.duplicate_of = duplicate.id;
    }
    this.db.prepare('INSERT INTO listings VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data').run(data.id, identity, JSON.stringify(data));
    return { listing: data, isNew: !old, isChanged: !!old };
  }
  hasListingsTable() { return !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='listings'").get(); }
  getListings() { return this.hasListingsTable() ? this.db.prepare('SELECT data FROM listings ORDER BY rowid DESC').all().map(decode) : []; }
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
    let result = { ...old, ...patch, id: old.id, identity: old.identity, updated_at: now() };
    // Owner corrections are a local layer over original evidence. Repeated feed
    // refreshes cannot overwrite them; changed evidence invalidates that layer.
    if(!ownerEdit){
      const original=sourceValues(old);
      const changed=CHECKED_SOURCE_FACTS.some(key=>Object.hasOwn(patch,key)&&JSON.stringify(patch[key]??null)!==JSON.stringify(original[key]??null));
      if(changed){
        result={...original,...patch,id:old.id,identity:old.identity,updated_at:now(),owner_facts:null,owner_review:Object.hasOwn(patch,'owner_review')?patch.owner_review:old.owner_review??null,ai:null};
        if(old.ai?.state==='complete'&&result.title===old.title&&result.body===old.body)result.ai=old.ai;
        result.fingerprint=sourceFingerprint(result);const assessment=evaluateListing(result,this.getConfig('profile',DEFAULT_PROFILE));result.assessment=assessment;result.status=assessment.status;
      }else if(old.owner_facts?.values){result={...result,...old.owner_facts.values,owner_facts:old.owner_facts};}
    }else if(patch.owner_facts?.values){result={...result,...patch.owner_facts.values};}
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
  close() { this.db.close(); }
}
export function canonicalUrl(value) {
  try { const u=new URL(value); if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return ''; u.hash=''; for(const key of [...u.searchParams.keys()]) if(/^(utm_|fbclid|ref$|source$)/i.test(key))u.searchParams.delete(key); return u.toString().replace(/\/$/,''); } catch { return ''; }
}
