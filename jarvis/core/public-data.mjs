const publicFields = [
  'id', 'source', 'url', 'city', 'title', 'body', 'address', 'postcode', 'neighbourhood',
  'location', 'listing_kind', 'created_at', 'updated_at', 'last_seen_at', 'wanted_ad', 'sale_ad',
  'availability', 'area_m2', 'bedrooms', 'furnished', 'min_stay_months', 'max_stay_months', 'indefinite',
  'rent_base', 'rent_total', 'rent_advertised_total', 'rent_excludes_bills', 'deposit', 'registration',
  'bills_missing', 'monthly_costs', 'start_date', 'start_kind', 'start_month', 'end_date', 'availability_periods',
  'photos', 'features', 'energy_label', 'source_detail_pending', 'source_evidence_ambiguous',
  'property_details_checked', 'student_allowed', 'working_only', 'degree_restriction', 'couples_allowed',
  'pets_allowed', 'source_preferences', 'extraction_warnings', 'restrictions', 'evidence',
];

function select(object, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

function publicText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/^[ \t]*(?:contact|e-?mail|phone|telephone|telefoon|whatsapp)\s*:[^\n]*/gim, '')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[contact removed]')
    .replace(/(?:\+\d{1,3}[\s.-]*)?(?:\(0\)[\s.-]*)?\b(?:06|6)[\s.-]*(?:\d[\s.-]*){8}\b/g, '[contact removed]');
}

export function publicListingData(listing) {
  const projected = select(listing, publicFields);
  for (const key of ['title', 'body', 'address']) if (key in projected) projected[key] = publicText(projected[key]);
  for (const key of ['restrictions', 'features', 'extraction_warnings']) {
    if (Array.isArray(projected[key])) projected[key] = projected[key].map(publicText);
  }
  if (projected.location) projected.location = select(projected.location, ['lat', 'lng', 'precision', 'street', 'houseNumber', 'postcode', 'neighbourhood']);
  if (projected.evidence) projected.evidence = Object.fromEntries(Object.entries(
    select(projected.evidence, ['student_allowed', 'working_only', 'degree_restriction', 'pets_allowed', 'couples_allowed']),
  ).map(([key, value]) => [key, publicText(value)]));
  if (projected.source_preferences) projected.source_preferences = select(projected.source_preferences, ['occupation', 'tenants']);
  if (Array.isArray(projected.availability_periods)) projected.availability_periods = projected.availability_periods
    .filter(Boolean).map(period => select(period, ['start', 'end']));
  if (Array.isArray(projected.monthly_costs)) projected.monthly_costs = projected.monthly_costs.map(cost =>
    ({ ...select(cost, ['amount', 'conditional']), label: publicText(cost.label) }));
  if (Array.isArray(projected.photos)) projected.photos = projected.photos.flatMap(photo =>
    typeof photo === 'string' ? [photo] : typeof photo?.url === 'string' ? [{ url: photo.url }] : []);
  return projected;
}

export function publicTravelData(record) {
  if (!record?.key || record.manual || !record.result) return null;
  const { key, expires, result } = record;
  return {
    key, expires,
    result: {
      ...select(result, ['status', 'mapVersion', 'campusSignature', 'checkedAt', 'sampleDeparture', 'transitEnabled']),
      ...(result.travelTimes ? { travelTimes: Object.fromEntries(Object.entries(result.travelTimes).map(([id, route]) =>
        [id, select(route, ['walk', 'bike', 'transit', 'km', 'approximate', 'source'])])) } : {}),
      origin: result.origin ? select(result.origin, ['lat', 'lon', 'precision']) : null,
      destinations: (result.destinations ?? []).map(destination => ({
        ...select(destination, ['id', 'name', 'kind', 'lat', 'lon']),
        routes: Object.fromEntries(Object.entries(destination.routes ?? {}).map(([mode, route]) =>
          [mode, select(route, ['status', 'seconds'])])),
      })),
    },
  };
}
