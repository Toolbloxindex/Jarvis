-- AI-assisted extraction cache. Private like every base table: the collector
-- writes through the pooler; anon/authenticated get nothing. Keys are
-- sha256(normalised redacted text + schema/prompt version + model), so rows
-- hold model output (values and short quotes from redacted ad text), never
-- the ad text itself. Usage counters live in public.settings (ai.usage.*).
BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_extraction_cache (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  model text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_extraction_cache_created_idx ON public.ai_extraction_cache (created_at);

ALTER TABLE public.ai_extraction_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_extraction_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_extraction_cache TO service_role;
CREATE POLICY housewatch_service_access ON public.ai_extraction_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.ai_extraction_cache
  FOR EACH ROW EXECUTE FUNCTION public.housewatch_touch_updated_at();

-- Cached results older than `keep` are re-extracted on the next change, which
-- costs one request. 180 days keeps the table at a few MB at 300 ads a day.
CREATE OR REPLACE FUNCTION public.prune_ai_cache(keep interval DEFAULT interval '180 days') RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  removed bigint;
BEGIN
  IF keep IS NULL OR keep <= interval '0 seconds' THEN
    RAISE EXCEPTION 'keep must be a positive interval';
  END IF;
  DELETE FROM public.ai_extraction_cache WHERE updated_at < now() - keep;
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM public.settings WHERE key LIKE 'ai.usage.%' AND updated_at < now() - interval '7 days';
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_ai_cache(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_ai_cache(interval) TO service_role;

COMMIT;
