import { randomUUID } from 'node:crypto';
import { facebookOfferKey } from './facebook-terms.mjs';
import { DEFAULT_PROFILE } from './matcher.mjs';
import { publicListingData, publicTravelData } from './public-data.mjs';
import { canonicalUrl, listingIdentity, planListingUpsert, listingUpdate } from './store-listings.mjs';

const travelPrefix = 'travel.listing.';
const healthPrefix = 'discovery.health.';
const aiCachePrefix = 'ai.cache.';
// Amenity catalogs (one per student city since the national expansion, plus the older local/v1
// keys) live in the amenities table, which the public_amenities view exposes.
const isCatalog = key => /^travel\.catalog\.[a-z0-9-]+$/.test(key);
const iso = value => value == null ? null : new Date(value).toISOString();
const alertReady = row => row.status === 'pending' ||
  Date.now() - Date.parse(row.updated_at) > Math.min(3600000, 60000 * 2 ** row.attempts);

export class StorePg {
  constructor(sql) { this.sql = sql; }

  async getConfig(key, fallback = null) {
    const sql = this.sql;
    let rows;
    if (key.startsWith(travelPrefix)) {
      rows = await sql`SELECT data FROM public.travel_cache WHERE listing_id = ${key.slice(travelPrefix.length)}`;
    } else if (isCatalog(key)) {
      rows = await sql`SELECT data FROM public.amenities WHERE key = ${key}`;
    } else if (key.startsWith(healthPrefix)) {
      rows = await sql`SELECT health AS data FROM public.sources WHERE id = ${key.slice(healthPrefix.length)}`;
    } else if (key.startsWith(aiCachePrefix)) {
      rows = await sql`SELECT data FROM public.ai_extraction_cache WHERE key = ${key.slice(aiCachePrefix.length)}`;
    } else {
      rows = await sql`SELECT data FROM public.settings WHERE key = ${key}`;
    }
    return rows[0]?.data ?? fallback;
  }

  async setConfig(key, value) {
    const sql = this.sql;
    if (key.startsWith(travelPrefix)) {
      const id = key.slice(travelPrefix.length);
      if (value === null) {
        await sql`DELETE FROM public.travel_cache WHERE listing_id = ${id}`;
      } else {
        await sql`INSERT INTO public.travel_cache (listing_id, data, public_data)
          VALUES (${id}, ${sql.json(value)}, ${sql.json(publicTravelData(value))})
          ON CONFLICT (listing_id) DO UPDATE SET data = excluded.data, public_data = excluded.public_data`;
      }
    } else if (isCatalog(key)) {
      await sql`INSERT INTO public.amenities (key, data) VALUES (${key}, ${sql.json(value)})
        ON CONFLICT (key) DO UPDATE SET data = excluded.data`;
    } else if (key.startsWith(healthPrefix)) {
      await sql`INSERT INTO public.sources (id, health) VALUES (${key.slice(healthPrefix.length)}, ${sql.json(value)})
        ON CONFLICT (id) DO UPDATE SET health = excluded.health`;
    } else if (key.startsWith(aiCachePrefix)) {
      await sql`INSERT INTO public.ai_extraction_cache (key, model, data) VALUES (${key.slice(aiCachePrefix.length)},
        ${String(value?.model ?? '')}, ${sql.json(value)}) ON CONFLICT (key) DO UPDATE SET data = excluded.data`;
    } else {
      await sql`INSERT INTO public.settings (key, data) VALUES (${key}, ${sql.json(value)})
        ON CONFLICT (key) DO UPDATE SET data = excluded.data`;
    }
  }

  async getListings(source) {
    const sql = this.sql;
    const rows = source === undefined
      ? await sql`SELECT data FROM public.listings ORDER BY created_at DESC, id`
      : await sql`SELECT data FROM public.listings WHERE source_id = ${source} ORDER BY created_at DESC, id`;
    return rows.map(row => row.data);
  }

  async getListing(id) {
    const sql = this.sql;
    const [row] = await sql`SELECT data FROM public.listings WHERE id = ${id}`;
    return row?.data ?? null;
  }

  async getListingHistory() {
    const sql = this.sql;
    const rows = await sql`SELECT listing_id,kind,before_data,after_data,changed_at FROM public.listing_history ORDER BY id`;
    return rows.map(row => ({
      listingId: row.listing_id, kind: row.kind, before: row.before_data,
      after: row.after_data, changedAt: iso(row.changed_at),
    }));
  }

  async upsertListing(input) {
    const canonical = canonicalUrl(input.url);
    const identity = listingIdentity(input, canonical);
    return this.sql.begin(async sql => {
      // Serialize the lookup and insert, including duplicates with different identities.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('housewatch:listings', 0))`;
      const [match] = await sql`SELECT data FROM public.listings WHERE identity = ${identity} FOR UPDATE`;
      const old = match?.data;
      const { data, presentation } = planListingUpsert(input, old, identity, canonical);
      if (!data) {
        const listing = presentation ? listingUpdate(old, presentation) : old;
        if (presentation) await this.writeListing(sql, listing);
        return { listing, isNew: false, isChanged: false };
      }
      if (!old) {
        const [alias] = canonical
          ? await sql`SELECT id FROM public.listings WHERE source_url = ${canonical} ORDER BY created_at DESC, id LIMIT 1`
          : [];
        const key = facebookOfferKey(input);
        const duplicate = alias?.id ?? (key && (await new StorePg(sql).getListings()).find(row => facebookOfferKey(row) === key)?.id);
        if (duplicate) data.duplicate_of = duplicate;
      }
      await this.writeListing(sql, data);
      return { listing: data, isNew: !old, isChanged: !!old };
    });
  }

  async writeListing(sql, data) {
    await sql`INSERT INTO public.sources (id) VALUES (${data.source}) ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO public.listings (id, identity, source_id, source_url, duplicate_of, data, public_data, created_at)
      VALUES (${data.id}, ${data.identity}, ${data.source}, ${data.url}, ${data.duplicate_of ?? null},
        ${sql.json(data)}, ${sql.json(publicListingData(data))}, ${data.created_at})
      ON CONFLICT (identity) DO UPDATE SET data = excluded.data, public_data = excluded.public_data,
        source_id = excluded.source_id, source_url = excluded.source_url, duplicate_of = excluded.duplicate_of`;
  }

  async updateListing(id, patch, { ownerEdit = false } = {}) {
    return this.sql.begin(async sql => {
      const [row] = await sql`SELECT data FROM public.listings WHERE id = ${id} FOR UPDATE`;
      if (!row) return null;
      const profile = await new StorePg(sql).getConfig('profile', DEFAULT_PROFILE);
      const listing = listingUpdate(row.data, patch, ownerEdit, profile);
      await this.writeListing(sql, listing);
      return listing;
    });
  }

  async addEvent(kind, detail) {
    const sql = this.sql;
    await sql`INSERT INTO public.events (kind, data) VALUES (${kind}, ${sql.json(detail)})`;
  }
  async getEvents() {
    const sql = this.sql;
    const rows = await sql`SELECT id,kind,data,created_at FROM public.events ORDER BY id DESC LIMIT 100`;
    return rows.map(row => ({ id: Number(row.id), kind: row.kind, detail: row.data, created_at: iso(row.created_at) }));
  }
  async hasMail(id) {
    const sql = this.sql;
    return !!(await sql`SELECT id FROM public.mail WHERE id = ${id}`).length;
  }
  async saveMail(id, object) {
    const sql = this.sql;
    await sql`INSERT INTO public.mail (id, data) VALUES (${id}, ${sql.json(object)})
      ON CONFLICT (id) DO UPDATE SET data = excluded.data`;
  }
  async saveSubscription(subscription) {
    const sql = this.sql;
    await sql`INSERT INTO public.subscriptions (endpoint, data)
      VALUES (${subscription.endpoint}, ${sql.json(subscription)}) ON CONFLICT (endpoint) DO UPDATE SET data = excluded.data`;
  }
  async getSubscriptions() {
    const sql = this.sql;
    return (await sql`SELECT data FROM public.subscriptions`).map(row => row.data);
  }
  async deleteSubscription(endpoint) {
    const sql = this.sql;
    await sql`DELETE FROM public.subscriptions WHERE endpoint = ${endpoint}`;
  }
  async enqueueNotification(key, payload) {
    const sql = this.sql;
    const rows = await sql`INSERT INTO public.notifications (id, unique_key, data)
      VALUES (${randomUUID()}, ${key}, ${sql.json(payload)}) ON CONFLICT (unique_key) DO NOTHING RETURNING id`;
    return rows.length > 0;
  }
  async getPendingNotifications() {
    const sql = this.sql;
    const rows = await sql`SELECT * FROM public.notifications WHERE status IN ('pending','failed')
      AND attempts < 5 ORDER BY updated_at LIMIT 30`;
    return rows.filter(alertReady).map(row => ({
      ...row.data, id: row.id, unique_key: row.unique_key, payload: row.data, status: row.status, attempts: row.attempts,
    }));
  }
  async markNotification(id, status, error = null) {
    const sql = this.sql;
    await sql`UPDATE public.notifications SET status = ${status}, error = ${error}, attempts = attempts + 1 WHERE id = ${id}`;
  }
  async getGroups() {
    const sql = this.sql;
    return (await sql`SELECT data FROM public.groups ORDER BY id`).map(row => row.data);
  }
  async upsertGroup(group) {
    const sql = this.sql;
    await sql`INSERT INTO public.groups (id, data) VALUES (${group.id}, ${sql.json(group)})
      ON CONFLICT (id) DO UPDATE SET data = groups.data || excluded.data`;
  }
  async updateGroup(id, patch) {
    const sql = this.sql;
    const [row] = await sql`UPDATE public.groups SET data = data || ${sql.json({ ...patch, id })}
      WHERE id = ${id} RETURNING data`;
    return row?.data ?? null;
  }

  async startCollectorRun() {
    const sql = this.sql;
    const id = randomUUID();
    await sql`INSERT INTO public.collector_runs (id) VALUES (${id})`;
    return id;
  }
  async finishCollectorRun(id, { checked = 0, added = 0, changed = 0, error = null } = {}) {
    const sql = this.sql;
    await sql`UPDATE public.collector_runs SET finished_at = now(), checked = ${checked}, added = ${added},
      changed = ${changed}, error = ${error} WHERE id = ${id}`;
  }
  async latestCollectorRun() {
    const sql = this.sql;
    const [row] = await sql`SELECT max(finished_at) AS finished FROM public.collector_runs`;
    return iso(row?.finished);
  }
  async claimTravelCheck(id, at, cooldownMs) {
    const sql = this.sql;
    const rows = await sql`INSERT INTO public.settings (key, data)
      VALUES (${'travel.cooldown.' + id}, ${sql.json(at)})
      ON CONFLICT (key) DO UPDATE SET data = excluded.data
      WHERE settings.data::bigint <= ${at - cooldownMs} RETURNING key`;
    return rows.length > 0;
  }
  async pruneHistory(keep = '12 months') {
    const sql = this.sql;
    const [row] = await sql`SELECT public.prune_history(${keep}::interval) AS removed`;
    return Number(row.removed);
  }
  async pruneAiCache(keep = '180 days') {
    const sql = this.sql;
    const [{ present }] = await sql`SELECT to_regclass('public.ai_extraction_cache') IS NOT NULL AS present`;
    if (!present) return 0;
    const [row] = await sql`SELECT public.prune_ai_cache(${keep}::interval) AS removed`;
    return Number(row.removed);
  }
  async close() { await this.sql.end({ timeout: 2 }); }
}
