BEGIN;

CREATE TABLE public.sources (
  id text PRIMARY KEY,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.listings (
  id text PRIMARY KEY,
  identity text NOT NULL UNIQUE,
  source_id text NOT NULL REFERENCES public.sources(id),
  source_url text NOT NULL,
  duplicate_of text REFERENCES public.listings(id) ON DELETE SET NULL,
  data jsonb NOT NULL,
  public_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_url_idx ON public.listings (source_url, created_at DESC);
CREATE INDEX listings_source_idx ON public.listings (source_id, created_at DESC);
CREATE INDEX listings_created_idx ON public.listings (created_at DESC, id);
CREATE INDEX listings_duplicate_idx ON public.listings (duplicate_of) WHERE duplicate_of IS NOT NULL;

CREATE TABLE public.listing_sources (
  source_listing_id text PRIMARY KEY REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_id text NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES public.sources(id),
  source_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_sources_listing_idx ON public.listing_sources(listing_id);

CREATE TABLE public.listing_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id text NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('price', 'availability')),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_history_listing_idx ON public.listing_history (listing_id, id);
CREATE INDEX listing_history_time_idx ON public.listing_history (changed_at);

CREATE TABLE public.travel_cache (
  listing_id text PRIMARY KEY REFERENCES public.listings(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  public_data jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.amenities (
  key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.settings (
  key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.collector_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked integer NOT NULL DEFAULT 0 CHECK (checked >= 0),
  added integer NOT NULL DEFAULT 0 CHECK (added >= 0),
  changed integer NOT NULL DEFAULT 0 CHECK (changed >= 0),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collector_runs_finished_idx ON public.collector_runs (finished_at DESC) WHERE finished_at IS NOT NULL;

CREATE TABLE public.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_time_idx ON public.events (created_at);
CREATE TABLE public.mail (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.subscriptions (
  endpoint text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.notifications (
  id text PRIMARY KEY,
  unique_key text NOT NULL UNIQUE,
  data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_queue_idx ON public.notifications (updated_at) WHERE status IN ('pending', 'failed') AND attempts < 5;
CREATE TABLE public.groups (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.housewatch_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sources','listings','listing_sources','listing_history','travel_cache',
    'amenities','settings','collector_runs','events','mail','subscriptions','notifications','groups'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', table_name);
    EXECUTE format('CREATE POLICY housewatch_service_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', table_name);
    IF table_name NOT IN ('listing_history', 'events') THEN
      EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.housewatch_touch_updated_at()', table_name);
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON SEQUENCE public.listing_history_id_seq, public.events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.listing_history_id_seq, public.events_id_seq TO service_role;

CREATE FUNCTION public.housewatch_sync_listing_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO public.listing_sources(source_listing_id, listing_id, source_id, source_url)
  VALUES (NEW.id, coalesce(NEW.duplicate_of, NEW.id), NEW.source_id, NEW.source_url)
  ON CONFLICT (source_listing_id) DO UPDATE SET listing_id = excluded.listing_id,
    source_id = excluded.source_id, source_url = excluded.source_url
  WHERE (listing_sources.listing_id, listing_sources.source_id, listing_sources.source_url)
    IS DISTINCT FROM (excluded.listing_id, excluded.source_id, excluded.source_url);
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_listing_source
AFTER INSERT OR UPDATE OF duplicate_of, source_id, source_url ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.housewatch_sync_listing_source();

CREATE FUNCTION public.housewatch_listing_snapshot(data jsonb, keys text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(jsonb_strip_nulls(data)) WHERE key = ANY(keys)
$$;

CREATE FUNCTION public.housewatch_record_listing_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  price_keys constant text[] := ARRAY['rent_base','rent_total','rent_advertised_total'];
  availability_keys constant text[] := ARRAY['availability','start_date','start_month','end_date','availability_periods'];
  before_price jsonb := public.housewatch_listing_snapshot(OLD.public_data, price_keys);
  after_price jsonb := public.housewatch_listing_snapshot(NEW.public_data, price_keys);
  before_availability jsonb := public.housewatch_listing_snapshot(OLD.public_data, availability_keys);
  after_availability jsonb := public.housewatch_listing_snapshot(NEW.public_data, availability_keys);
BEGIN
  IF before_price IS DISTINCT FROM after_price THEN
    INSERT INTO public.listing_history (listing_id, kind, before_data, after_data)
    VALUES (NEW.id, 'price', before_price, after_price);
  END IF;
  IF before_availability IS DISTINCT FROM after_availability THEN
    INSERT INTO public.listing_history (listing_id, kind, before_data, after_data)
    VALUES (NEW.id, 'availability', before_availability, after_availability);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_listing_history AFTER UPDATE OF data ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.housewatch_record_listing_history();

-- Base rows remain private. The owner-privileged view projects only the curated
-- payloads and bounded history fields. The API roles receive SELECT on the view.
CREATE VIEW public.public_listings WITH (security_barrier = true) AS
SELECT l.id, l.public_data || jsonb_build_object('duplicate_of', nullif(s.listing_id, l.id)) AS data,
  t.public_data AS travel,
  coalesce(h.history, '[]'::jsonb) AS history
FROM public.listings l
JOIN public.listing_sources s ON s.source_listing_id = l.id
LEFT JOIN public.travel_cache t ON t.listing_id = l.id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'listingId', listing_id, 'kind', kind, 'before', before_data,
    'after', after_data, 'changedAt', changed_at
  ) ORDER BY id) AS history
  FROM public.listing_history WHERE listing_id = l.id
) h ON true
WHERE lower(btrim(l.public_data->>'city')) = 'delft'
  AND l.public_data->>'listing_kind' IS DISTINCT FROM 'general_lead'
  AND l.public_data->>'wanted_ad' IS DISTINCT FROM 'true'
  AND l.public_data->>'sale_ad' IS DISTINCT FROM 'true';

CREATE VIEW public.public_amenities WITH (security_barrier = true) AS
SELECT a.key AS catalog, p.place->>'name' AS name, p.place->>'kind' AS kind,
  (p.place->>'lat')::double precision AS lat, (p.place->>'lon')::double precision AS lon
FROM public.amenities a
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.data->'places') = 'array'
  THEN a.data->'places' ELSE '[]'::jsonb END) AS p(place)
WHERE a.key IN ('travel.catalog.local', 'travel.catalog.v1') AND p.place->>'kind' IN ('gym', 'supermarket');

-- The invoker view uses an explicit RLS SELECT policy and a timestamp-only grant.
CREATE POLICY public_collector_freshness ON public.collector_runs
  FOR SELECT TO anon, authenticated USING (finished_at IS NOT NULL);
GRANT SELECT (finished_at) ON public.collector_runs TO anon, authenticated;
CREATE VIEW public.public_feed_status WITH (security_invoker = true) AS
SELECT max(finished_at) AS finished_at FROM public.collector_runs;

REVOKE ALL ON public.public_listings, public.public_amenities, public.public_feed_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.public_listings, public.public_amenities, public.public_feed_status TO anon, authenticated, service_role;

CREATE FUNCTION public.prune_history(keep interval DEFAULT interval '12 months') RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  removed bigint;
  cutoff timestamptz;
BEGIN
  IF keep IS NULL OR keep <= interval '0 seconds' THEN
    RAISE EXCEPTION 'keep must be a positive interval';
  END IF;
  cutoff := now() - keep;
  DELETE FROM public.listing_history WHERE changed_at < cutoff;
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM public.events WHERE created_at < cutoff;
  DELETE FROM public.collector_runs WHERE coalesce(finished_at, started_at) < cutoff
    AND id IS DISTINCT FROM (
      SELECT id FROM public.collector_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1
    );
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.housewatch_touch_updated_at(),
  public.housewatch_sync_listing_source(), public.housewatch_listing_snapshot(jsonb, text[]),
  public.housewatch_record_listing_history(), public.prune_history(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.housewatch_touch_updated_at(),
  public.housewatch_sync_listing_source(), public.housewatch_listing_snapshot(jsonb, text[]),
  public.housewatch_record_listing_history(), public.prune_history(interval) TO service_role;

COMMIT;
