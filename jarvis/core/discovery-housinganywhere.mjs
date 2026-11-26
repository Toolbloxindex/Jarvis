const UTILITY_LABELS = {
  'electricity-bill': 'Electricity',
  'gas-bill': 'Gas',
  'internet-bill': 'Internet',
  'water-bill': 'Water',
  'utility-bills': 'Utilities',
  'broadcasting-bill': 'Television',
};

const COST_LABELS = {
  ...UTILITY_LABELS,
  'cleaning-service': 'Cleaning service',
  'administration-fee': 'Administration fee',
  'membership-fee': 'Membership fee',
  'other-additional-costs': 'Additional charges',
  parking: 'Parking',
};

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const cents = value => Number.isSafeInteger(value) && value >= 0 && value < 100_000_000 ? value : null;
const tidy = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const citySlug = value => tidy(value).toLowerCase().replace(/[\s-]+/g, '-');

/** The entity is the published Dutch property the candidate link points to (same id and city). */
export function matchesHousingAnywhereEntity(entity, candidate) {
  if (!entity || !positiveInteger(entity.id) || entity.currency !== 'EUR' || !tidy(entity.city) ||
      (candidate.city && citySlug(entity.city) !== citySlug(candidate.city)) ||
      entity.isDeleted === true || entity.isHidden === true ||
      (entity.stateLabel && entity.stateLabel !== 'published')) return false;
  try {
    const url = new URL(candidate.url);
    // The URL's city segment can be a local spelling; the entity id and city check above decide.
    const match = url.pathname.match(/^\/room\/ut(\d+)\/nl\/[^/]+(?:\/|$)/i);
    return url.origin === 'https://housinganywhere.com' && !url.username && !url.password &&
      Number(match?.[1]) === entity.id;
  } catch {
    return false;
  }
}

export function housingAnywhereTitle(entity) {
  const type = tidy(entity.unitTypeType).toLowerCase();
  const kind = type.startsWith('private room') ? 'Private room' :
    type === 'apartment' ? 'Apartment' : type === 'studio' ? 'Studio' :
    type === 'shared room' ? 'Shared room' : type === 'house' ? 'House' : 'Rental';
  const street = tidy(entity.street);
  return (kind + ' in ' + (street ? street + ', ' : '') + (tidy(entity.city) || 'the Netherlands')).slice(0, 160);
}

function datePart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const date = value.slice(0, 10);
  const timestamp = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
  return date;
}

function normalizeCalendar(periods) {
  if (!Array.isArray(periods) || !periods.length || periods.length > 100) return null;
  const mapped = [];
  for (const period of periods) {
    const start = datePart(period?.from);
    const end = datePart(period?.to);
    if (!start || !end || end < start || start === '9999-12-31' || end === '0001-01-01') return null;
    mapped.push({start:start === '0001-01-01' ? null : start, end:end === '9999-12-31' ? null : end});
  }
  return mapped.sort((a,b) => (a.start || '').localeCompare(b.start || ''));
}

function squareMetres(input) {
  if (typeof input !== 'number' && !/^\d{1,4}(?:[.,]\d+)?$/.test(input || '')) return null;
  const area = Number(String(input).replace(',', '.'));
  return Number.isFinite(area) && area > 0 && area <= 10_000 ? area : null;
}

function normalizePrice(entity, result, put, warn) {
  const advertised = cents(entity.price);
  const costs = entity.costs?.costs;
  const monthly = costs && typeof costs === 'object' && !Array.isArray(costs) ?
    Object.entries(costs).filter(([, cost]) => cost?.payableAt === 'monthly') : [];
  const isRequiredTenantCost = ([, cost]) => cost.required === true && cost.payableBy === 'tenant';
  const required = monthly.filter(isRequiredTenantCost);
  const completeCosts = costs && typeof costs === 'object' && !Array.isArray(costs) &&
    Object.keys(costs).length > 0 && required.every(([, cost]) => cents(cost.value) !== null);
  const extraTotal = required.reduce((sum, [, cost]) => sum + (cents(cost.value) ?? 0), 0);
  const actualExtra = required.reduce((sum, [, cost]) =>
    sum + (cost.isEstimated === true ? 0 : cents(cost.value) ?? 0), 0);
  const includedUtilities = monthly.filter(([name,cost]) =>
    UTILITY_LABELS[name] && cost.payableBy === 'included-in-rent');
  const excludedUtilities = required.filter(([name]) => UTILITY_LABELS[name]);
  const allBillsIncluded = entity.utilities === 'I' && includedUtilities.length > 0 && !excludedUtilities.length;
  const someBillsExcluded = ['P','E'].includes(entity.utilities) || excludedUtilities.length > 0;
  const consistentCosts = completeCosts && cents(entity.costs.requiredPerMonth) === extraTotal;
  const priced = advertised !== null && advertised > 0 ? advertised / 100 : null;

  if (completeCosts && !consistentCosts) warn('The advertised monthly charge total differs from the itemized charges.');
  if (entity.utilities === 'I' && excludedUtilities.length) warn('Source price labels conflict with utilities listed as extra.');
  const exactTotal = priced !== null && allBillsIncluded && consistentCosts && extraTotal === 0;
  const priceEvidence = priced === null ? null : 'HousingAnywhere advertised monthly rent: EUR ' + priced + '.';
  put('rent_advertised_total', priced, priceEvidence);
  put('rent_base', allBillsIncluded ? null : priced, priceEvidence);
  put('rent_total', exactTotal ? priced : null,
    exactTotal ? priceEvidence + ' Listed bills are included and extra mandatory monthly charges total EUR 0.' : null);
  put('rent_excludes_bills', someBillsExcluded ? true : allBillsIncluded ? false : null,
    someBillsExcluded ? 'HousingAnywhere lists some required utilities separately from rent.' :
      allBillsIncluded ? 'HousingAnywhere lists bills as included in rent.' : null);
  const floor = priced === null ? null : (advertised + (consistentCosts ? actualExtra : 0)) / 100;
  put('rent_known_monthly_min', floor, priceEvidence && (actualExtra > 0 && consistentCosts ?
    priceEvidence + ' Adds fixed mandatory monthly charges of EUR ' + actualExtra / 100 + '.' : priceEvidence));
  put('estimated_monthly_total', priced !== null && consistentCosts && extraTotal > actualExtra ?
    (advertised + extraTotal) / 100 : null);

  result.monthly_costs = monthly.filter(([, cost]) => cost.payableBy === 'tenant' && cents(cost.value) > 0)
    .map(([name,cost]) => {
      const label = COST_LABELS[name] || 'Additional monthly charge';
      const amount = cost.value / 100;
      const estimated = cost.isEstimated === true;
      return {label, amount, estimated, conditional:cost.required !== true,
        evidence:'HousingAnywhere itemized ' + label.toLowerCase() + ': EUR ' + amount +
          ' per month' + (estimated ? ' (estimated).' : '.')};
    });
  result.included_costs = includedUtilities.map(([name]) => UTILITY_LABELS[name]);
  result.excluded_costs = excludedUtilities.map(([name]) => UTILITY_LABELS[name]);
  result.bills_missing = result.excluded_costs.map(label => label.toLowerCase());

  const security = costs?.['security-deposit'];
  const deposit = security?.payableBy === 'tenant' && security.payableAt === 'move-in' &&
    security.required === true && security.refundable === true && cents(security.value) > 0 ? security.value / 100 : null;
  if (deposit !== null) {
    if (typeof result.deposit === 'number' && result.deposit !== deposit) {
      warn('The description and booking details state different deposits. Confirm the deposit before applying.');
    }
    put('deposit', deposit, 'HousingAnywhere booking costs: EUR ' + deposit + ' refundable security deposit at move-in.');
  }
}

export function normalizeHousingAnywhere(entity, candidate, listing) {
  if (!matchesHousingAnywhereEntity(entity,candidate)) {
    throw new Error('Original HousingAnywhere details do not match the advertised property.');
  }
  const result = {
    ...listing,
    evidence:{...listing.evidence},
    extraction_warnings:[...(listing.extraction_warnings || [])],
    title:housingAnywhereTitle(entity),
    city:tidy(entity.city),
    // Street is public; hidden house numbers in the source state are not copied.
    address:tidy(entity.street).slice(0, 100) || null,
  };
  const warn = message => {
    if (!result.extraction_warnings.includes(message)) result.extraction_warnings.push(message);
  };
  const put = (key,value,evidence) => {
    result[key] = value;
    if (evidence) result.evidence[key] = evidence;
    else delete result.evidence[key];
  };
  normalizePrice(entity,result,put,warn);

  const periods = normalizeCalendar(entity.bookablePeriods);
  // The native property calendar is independent of dates mentioned in prose (for
  // example, when a refurbishment was completed) or search-card dates without years.
  put('availability_periods', periods, periods ?
    'HousingAnywhere availability calendar: ' + periods.map(({start,end}) =>
      (start || 'start unconfirmed') + ' to ' + (end || 'open')).join('; ') + '.' : null);
  put('start_date', null);
  put('start_month', null);
  put('end_date', null);
  put('start_kind', null);
  if (!periods) warn('HousingAnywhere did not publish a complete availability calendar for this property.');

  const nativeMinimum = positiveInteger(entity.minimumStayMonths) && entity.minimumStayMonths <= 120 ?
    entity.minimumStayMonths : null;
  const nativeMaximum = positiveInteger(entity.maximumStay) && entity.maximumStay <= 120 ? entity.maximumStay : null;
  const describedMinimum = listing.min_stay_months ??
    (/\bnot shorter than (?:one|a) month\b/i.test(entity.description || '') ? 1 : null);
  const describedMaximum = listing.max_stay_months;
  for (const [field,native,described,label] of [
    ['min_stay_months',nativeMinimum,describedMinimum,'minimum'],
    ['max_stay_months',nativeMaximum,describedMaximum,'maximum'],
  ]) {
    if (native !== null && described != null && native !== described) {
      put(field,null);
      warn('The HousingAnywhere calendar and description state different ' + label + ' stays (' +
        native + ' and ' + described + ' months).');
    } else if (native !== null) {
      put(field,native,'HousingAnywhere rental terms: ' + label + ' stay of ' + native + ' months.');
    } else if (described != null && result[field] == null) {
      put(field,described,'The description states the stay is not shorter than a month.');
    }
  }

  const facilities = entity.facilities || {};
  const tenant = facilities.tenant_status;
  if (tenant === 'working professionals only') {
    put('student_allowed',false,'HousingAnywhere tenant type: working professionals only.');
    put('working_only',true,'HousingAnywhere tenant type: working professionals only.');
  } else if (tenant === 'students only' || tenant === 'any') {
    if (listing.student_allowed === false || listing.working_only === true) {
      put('student_allowed',null);
      put('working_only',null);
      warn('The HousingAnywhere tenant type and description differ on whether students are accepted.');
    } else {
      put('student_allowed',true,'HousingAnywhere tenant type: ' +
        (tenant === 'students only' ? 'students only.' : 'students and working professionals.'));
    }
  }
  if (facilities.registration_possible === 'yes' || facilities.registration_possible === 'no') {
    const allowed = facilities.registration_possible === 'yes';
    if (typeof listing.registration === 'boolean' && listing.registration !== allowed) {
      put('registration',null);
      warn('The HousingAnywhere facilities and description differ on whether registration is possible.');
    } else put('registration',allowed,'HousingAnywhere facilities: registration ' + (allowed ? 'possible.' : 'not possible.'));
  }
  for (const [field,value,label] of [['age_min',entity.minAge,'minimum'],['age_max',entity.maxAge,'maximum']]) {
    if (positiveInteger(value) && value <= 120) put(field,value,'HousingAnywhere tenant requirements: ' + label + ' age ' + value + '.');
  }
  const room = /^(?:private|shared) room\b/i.test(entity.unitTypeType || '');
  const area = squareMetres(room ? facilities.bedroom_size : facilities.total_size);
  if (area !== null) put('area_m2',area,'HousingAnywhere ' + (room ? 'bedroom' : 'property') + ' size: ' + area + ' m².');
  if (/^\d{1,2}$/.test(String(facilities.bedroom_count ?? ''))) {
    const bedrooms = Number(facilities.bedroom_count);
    put('bedrooms',bedrooms,'HousingAnywhere details: ' + bedrooms + ' bedroom(s).');
  }
  if (facilities.bedroom_furnished === 'yes' && (room || facilities.lroom_furniture === 'yes')) {
    put('furnished','furnished','HousingAnywhere facility details list furniture.');
  } else if (facilities.bedroom_furnished === 'no' && (room || facilities.lroom_furniture === 'no')) {
    put('furnished','unfurnished','HousingAnywhere facility details list the rental as unfurnished.');
  }
  return result;
}
