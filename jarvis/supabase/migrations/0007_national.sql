-- National expansion: homes from every Dutch city are public, and the site reads one region at a
-- time (homes near the chosen university) instead of the whole country.
--
-- public_listings gains `lat`/`lng`: the geocoded travel origin, else the source's own coordinates.
-- They are what region reads filter on (PostgREST range filters on the view). CREATE OR REPLACE
-- VIEW may only append columns, so the existing four keep their order and grants.

-- (Conversions are inlined: functions in a view run with the caller's EXECUTE rights.)
CREATE OR REPLACE VIEW public.public_listings WITH (security_barrier = true) AS
SELECT l.id, l.public_data || jsonb_build_object('duplicate_of', nullif(s.listing_id, l.id)) AS data,
  t.public_data AS travel,
  coalesce(h.history, '[]'::jsonb) AS history,
  coalesce(
    CASE WHEN jsonb_typeof(t.public_data #> '{result,origin,lat}') = 'number' THEN (t.public_data #>> '{result,origin,lat}')::double precision END,
    CASE WHEN jsonb_typeof(l.public_data #> '{location,lat}') = 'number' THEN (l.public_data #>> '{location,lat}')::double precision END
  ) AS lat,
  coalesce(
    CASE WHEN jsonb_typeof(t.public_data #> '{result,origin,lon}') = 'number' THEN (t.public_data #>> '{result,origin,lon}')::double precision END,
    CASE WHEN jsonb_typeof(l.public_data #> '{location,lng}') = 'number' THEN (l.public_data #>> '{location,lng}')::double precision END
  ) AS lng
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
WHERE btrim(coalesce(l.public_data->>'city', '')) <> ''
  AND l.public_data->>'listing_kind' IS DISTINCT FROM 'general_lead'
  AND l.public_data->>'wanted_ad' IS DISTINCT FROM 'true'
  AND l.public_data->>'sale_ad' IS DISTINCT FROM 'true';

-- Amenity catalogs are per student city now ('travel.catalog.<city>'); keep the older keys too.
CREATE OR REPLACE VIEW public.public_amenities WITH (security_barrier = true) AS
SELECT a.key AS catalog, p.place->>'name' AS name, p.place->>'kind' AS kind,
  (p.place->>'lat')::double precision AS lat, (p.place->>'lon')::double precision AS lon
FROM public.amenities a
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.data->'places') = 'array'
  THEN a.data->'places' ELSE '[]'::jsonb END) AS p(place)
WHERE a.key LIKE 'travel.catalog.%' AND p.place->>'kind' IN ('gym', 'supermarket');

GRANT SELECT ON public.public_listings, public.public_amenities TO anon, authenticated, service_role;
