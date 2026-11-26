import { isImmediateAvailability } from './matcher.mjs';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const cents = value => Math.round(value * 100) / 100;
const isoDay = value => {
  const day = typeof value === 'string' ? value.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/)?.[0] : null;
  if (!day || !Number.isFinite(Date.parse(day))) return null;
  return new Date(day).toISOString().slice(0, 10) === day ? day : null;
};

const monthNames = [
  ['january','januari'], ['february','februari'], ['march','maart'],
  ['april'], ['may','mei'], ['june','juni'], ['july','juli'], ['august','augustus'],
  ['september'], ['october','oktober'], ['november'], ['december'],
];

function dateAtStart(value) {
  const text = String(value ?? '').trim();
  const iso = text.match(/^\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (iso) return isoDay(iso);
  let match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (match) return isoDay(match[3]+'-'+match[2].padStart(2,'0')+'-'+match[1].padStart(2,'0'));
  match = text.match(/^(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})\b/i);
  if (!match) return null;
  const month = monthNames.findIndex(variants => variants.some(name=>name===match[2].toLowerCase() || name.slice(0,3)===match[2].toLowerCase())) + 1;
  return month ? isoDay(match[3]+'-'+String(month).padStart(2,'0')+'-'+match[1].padStart(2,'0')) : null;
}

const labels = list => Array.isArray(list)
  ? [...new Set(list.map(item=>item?.localizedNaam || item?.localizedName || item?.name).filter(value=>typeof value==='string'&&value))]
  : [];

function money(raw) {
  const input = String(raw).replace(/\s+/g,'');
  if (!/^\d+(?:[.,]\d+)*$/.test(input)) return null;
  const last = Math.max(input.lastIndexOf(','),input.lastIndexOf('.'));
  const hasCents = last >= 0 && input.length-last <= 3;
  const integer = (hasCents?input.slice(0,last):input).replace(/[.,]/g,'');
  const amount = Number(hasCents?integer+'.'+input.slice(last+1):integer);
  return positive(amount)?amount:null;
}

const priceAmount = '([0-9]+(?:[.,][0-9]+)*)';
const euro = '(?:€|EUR)\\s*'+priceAmount;
const rentWords = /^(?:rent(?:al price)?|base rent|huurprijs|kale huur(?:prijs)?|de kale huur)\b/i;
const evidenceLine = value => String(value).trim().replace(/\s+/g,' ').slice(0,320);
const propertyLines = body => String(body||'')
  .split(/\n|(?<=[.!?])\s+(?=(?:available|beschikbaar|base rent|kale huur|the rent|rent|rental price|huurprijs|service (?:charge|cost)|servicekosten|heating costs|advanced (?:heating|payment)|voorschot|stookkosten|parking space|parkeerplaats)\b)/i)
  .map(line=>line.trim().replace(/^[-·•*]\s*/, '')).filter(Boolean);
const nativeKnownCost = value => 'ROOMMATCH public offer lists €'+value+' per month before any excluded costs.';

export function applyRoomTerms(listing, x) {
  const evidence = {...listing.evidence};
  // Keep the original text visible. Native current fields take precedence over
  // generic descriptions of the building and sometimes outdated roommate prose.
  const start_date = isoDay(x.availableFromDate);
  const end_date = isoDay(x.availableTillDate);
  const availability_text = String(x.availableFrom||'').trim()||null;
  const age = value => Number.isInteger(value) && value>0 && value<130 ? value : null;
  const area_m2 = positive(x.areaDwelling) ? x.areaDwelling : null;
  const rent_base = positive(x.netRent) ? x.netRent : null;
  const rent_advertised_total = positive(x.totalRent) ? x.totalRent : null;
  const monthly_costs = [
    ['Service charge',x.serviceCosts],
    ['Heating',x.heatingCosts],
    ['Energy advance',x.voorschotEnergielasten],
    ['Other recurring charges',x.additionalCosts],
  ].filter(([,amount])=>positive(amount)).map(([label,amount])=>({
    label,amount,conditional:false,evidence:'ROOMMATCH public offer: '+label+' €'+amount+' per month.',
  }));
  const rent_known_monthly_min = rent_advertised_total ?? (rent_base===null?null:cents(rent_base+monthly_costs.reduce((sum,cost)=>sum+cost.amount,0)));
  const included_costs = labels(x.servicecomponentenBinnenServicekosten);
  const excluded_costs = labels(x.servicecomponentenBuitenServicekosten);
  const furnishing = String(x.dwellingType?.localizedName || x.dwellingType?.name||'');
  let furnished = /^(?:gemeubileerd|furnished)$/i.test(furnishing)?'furnished'
    : /^(?:zelf inrichten|unfurnished)$/i.test(furnishing)?'unfurnished'
    : /^(?:gestoffeerd|upholstered)$/i.test(furnishing)?'upholstered':null;

  const body = String(listing.body||'');
  const directOffer = /\bdirect offer\b|\bdirect aanbod\b/i.test(body);
  const warnings = ['Personal ROOM qualification still requires an account-specific check.'];
  const roomRestriction = body.match(/(?:je moet aantonen dat je op dit moment in een andere gemeente dan Delft of in het buitenland woont|prove that you currently live in another municipality or abroad)/i);
  if (roomRestriction) warnings.push('This offer requires moving to Delft from another municipality or abroad for study.');
  if (directOffer && /(?:uitsluitend gasten en studenten van IHE Delft|only (?:for )?(?:guests|students) of IHE Delft)/i.test(body)) {
    warnings.push('The building description names IHE Delft guests and students. Confirm whether this individual offer is reserved for that institute.');
  }

  const furnishingConflict = furnished==='unfurnished' && /(?:deze (?:kamer|woning) is volledig gestoffeerd en gemeubileerd|(?:this room|this property) is fully furnished)/i.test(body);
  if (furnishingConflict) {
    furnished = 'conflicting';
    warnings.push('ROOMMATCH calls this unit self-furnished, but the offer text says it is fully furnished.');
  }

  const fees = [
    ['Rental administration',/(?:€|EUR)\s*(\d+(?:[.,]\d+)*)\s*verhuurkosten/i],
    ['End cleaning',/(?:€|EUR)\s*(\d+(?:[.,]\d+)*)\s*schoonmaakkosten/i],
    ['Linen package',/(?:(\d)\s*[x×]\s*)?(?:€|EUR)\s*(\d+(?:[.,]\d+)*)\s*bedlinnenpakket/i],
  ].flatMap(([label,regex],i)=>{
    const match=body.match(regex);
    if (!match) return [];
    const price=money(i===2?match[2]:match[1]);
    if (price==null) return [];
    const amount=cents(price*(i===2&&match[1]?Number(match[1]):1));
    return [{label,amount,evidence:evidenceLine(match[0])}];
  });
  const nativeFee = positive(x.eenmaligeKosten) ? x.eenmaligeKosten : null;
  const feesTotal = cents(fees.reduce((sum,fee)=>sum+fee.amount,0));
  let one_time_costs = nativeFee==null?[]:[{label:'One-time charges',amount:nativeFee,evidence:'ROOMMATCH public offer: €'+nativeFee+' one-time charges.'}];
  if (fees.length && (nativeFee===null || feesTotal===nativeFee)) one_time_costs=fees;
  if (fees.length && (nativeFee!==null && feesTotal!==nativeFee || nativeFee===null && x.eenmaligeKosten===0)) {
    warnings.push('The one-time cost in the ROOMMATCH feed and the offer text differ.');
  }

  const vacancyContract = body.match(/\b(?:verhuurd op basis van een leegstandscontract|contract under the vacancy act)\b/i);
  const contract_type = (vacancyContract?'Temporary vacancy contract':null) || x.typeContract?.localizedName || x.typeContract?.localizedLabel ||
    (directOffer && x.tijdelijkVerhuur===1?'Temporary Direct Offer':null);
  if(vacancyContract)evidence.contract_type=evidenceLine(vacancyContract[0]);
  const explicitStudentRule = body.match(/(?:word(?:t|en) (?:alleen )?verhuurd aan (?:Nederlandse en internationale )?voltijdstudenten(?: en stagiairs)?|(?:students? (?:are )?(?:welcome|allowed|accepted)|studenten (?:welkom|toegestaan)))/i);
  if (explicitStudentRule) evidence.student_allowed=evidenceLine(explicitStudentRule[0]);
  else if (/campuscontract/i.test(contract_type||'')) evidence.student_allowed='ROOMMATCH contract type: '+contract_type+'.';
  else delete evidence.student_allowed;
  const student_allowed = explicitStudentRule || /campuscontract/i.test(contract_type||'') ? true : null;
  // A short source clause can coexist with lease max/min, but the source's
  // earliest date is not the old publication or originally requested start.
  for (const field of ['start_date','start_month','start_kind','end_date','rent_base','rent_total','age_min','age_max','area_m2',
    'rent_excludes_bills','furnished','degree_restriction','languages_required','registration','deposit','rent_known_monthly_min']) delete evidence[field];
  if (start_date) evidence.start_date='ROOMMATCH available from: '+start_date+'.';
  if (end_date) evidence.end_date='ROOMMATCH available until: '+end_date+'.';
  if (availability_text) evidence.availability_text='ROOMMATCH availability: '+availability_text+'.';
  if (rent_base!==null) evidence.rent_base='ROOMMATCH net monthly rent: €'+rent_base+'.';
  if (rent_known_monthly_min!==null) evidence.rent_known_monthly_min=rent_advertised_total===null
    ? 'ROOMMATCH net rent plus listed recurring charges: €'+rent_known_monthly_min+' per month.'
    : nativeKnownCost(rent_advertised_total);
  if (rent_advertised_total!==null) evidence.rent_advertised_total=nativeKnownCost(rent_advertised_total);
  if (area_m2!==null) evidence.area_m2='ROOMMATCH areaDwelling: '+area_m2+' m².';
  if (furnished!==null) evidence.furnished='ROOMMATCH furnishing: '+furnishing+(furnishingConflict?' (offer text says fully furnished).':'.');
  if (age(x.minimumAge)!==null) evidence.age_min='ROOMMATCH minimum age: '+x.minimumAge+'.';
  if (age(x.maximumAge)!==null) evidence.age_max='ROOMMATCH maximum age: '+x.maximumAge+'.';
  if (excluded_costs.length) evidence.rent_excludes_bills='ROOMMATCH lists excluded costs: '+excluded_costs.join(', ')+'.';
  if (positive(x.borg)) evidence.deposit='ROOMMATCH public offer deposit: €'+x.borg+'.';
  const noExtension = /geen verlenging mogelijk|(?:cannot|may not) (?:be )?extend|no extension/i.test(body);
  if (/\bbegin master\b/i.test(body) && /\b(?:huisgenoot|instemming)\b/i.test(body)) warnings.push('Roommate text mentions a preference for a master’s student. Verify whether this is current.');
  const application_closes_at = typeof x.closingDate==='string' && Number.isFinite(Date.parse(x.closingDate)) ? x.closingDate : null;

  return {...listing,evidence,extraction_warnings:[...new Set(warnings)],start_date,start_month:null,
    start_kind:start_date||availability_text?'earliest':null,end_date,availability_text,application_closes_at,
    age_min:age(x.minimumAge),age_max:age(x.maximumAge),area_m2,furnished,contract_type,one_time_costs,
    indefinite:vacancyContract||x.tijdelijkVerhuur===1?false:listing.indefinite??null,
    min_stay_months:directOffer||x.tijdelijkVerhuur===1||explicitStudentRule?listing.min_stay_months:null,
    max_stay_months:directOffer||x.tijdelijkVerhuur===1||explicitStudentRule?listing.max_stay_months:null,
    extension_allowed:noExtension?false:null,student_allowed,degree_restriction:null,languages_required:[],registration:null,
    income_requirement:positive(x.minimumIncome)?true:null,deposit:positive(x.borg)?x.borg:null,
    rent_base,rent_total:null,rent_advertised_total,rent_known_monthly_min,
    rent_excludes_bills:excluded_costs.length?true:null,monthly_costs,included_costs,excluded_costs,bills_missing:excluded_costs,
  };
}

const currency = new RegExp(euro,'i');
const explicitAvailability = /^(?:available(?:\s+from|\s+on)?|beschikbaar(?:\s+vanaf|\s+per)?)\s*:?\s*(?:(?:from|per|vanaf|on)\s+)?/i;
const rentExclusion = /\b(?:excl\.?|exclusief|exclud(?:es|ing|ed)|exclusive of)\b/i;
const recurring = /\b(?:per month|per maand|monthly|maandelijks)\b|p\.m\./i;
const oneTime = /\b(?:one[ -]time|one[ -]off|eenmalig\w*|deposit|borg(?:som)?)\b/i;
const utilityWords = /utilities|nutsvoorzieningen|(?:gas\s*,\s*water\s*(?:and|en)\s*(?:electricity|elektra))|energiekosten/i;
const kindOfCost = [
  ['Service charge',/^(?:excluding\s+|exclusief\s+)?(?:service costs?|service charges?|servicekosten)/i],
  ['Heating',/^(?:heating\s+costs?|advanced payment for heating|advanced heating costs?|stookkosten|voorschot\s+(?:stookkosten|verwarming)|verwarming)/i],
  ['Utilities',utilityWords],
  ['Parking',/park(?:ing|eerplaats|eerruimte|eerkosten)/i],
];

function sourceCost(line) {
  const match=line.match(currency);
  if (!match || oneTime.test(line)) return null;
  const amount=money(match[1]);
  if (amount===null) return null;
  const type=kindOfCost.find(([,pattern])=>pattern.test(line))?.[0];
  if (!type) return null;
  // Mentioning power inside an explanatory rent exclusion is not a charge.
  if (type==='Utilities' && !recurring.test(line) && !/\b(?:advance payment|voorschot|fixed fee|vaste vergoeding)\b/i.test(line)) return null;
  // A clause can require parking only for car owners. Skip a charge quoted
  // as present inside the stated rent rather than add it twice.
  if (rentWords.test(line)) return null;
  const parkingConditional=type==='Parking' && /\b(?:if |in case|indien|bij bezit|optional|optioneel|available|te huur|vanaf)\b/i.test(line);
  const parkingMandatory=type==='Parking' && /\b(?:mandatory|required|verplichte?)\b/i.test(line);
  const included=/^(?:included|including|inclusief)\b/i.test(line);
  if (included) return null;
  const conditional=(type==='Parking'&&(!parkingMandatory||parkingConditional))||
    /\b(?:if applicable|optional|optioneel)\b/i.test(line);
  return {label:type,amount,conditional,evidence:evidenceLine(line)};
}

function normalizeMonthlyCosts(lines, warnings) {
  const monthly_costs=[];
  for (const line of lines) {
    const cost=sourceCost(line);
    if (cost&&!monthly_costs.some(old=>old.label===cost.label && old.amount===cost.amount && old.conditional===cost.conditional)) monthly_costs.push(cost);
  }
  const mandatory=label=>monthly_costs.filter(c=>c.label===label && !c.conditional);
  const heating=mandatory('Heating');
  const service=mandatory('Service charge');
  const sorted=values=>values.map(c=>c.amount).sort((a,b)=>a-b);
  if (heating.length===2 && service.length===2 && JSON.stringify(sorted(heating))===JSON.stringify(sorted(service))
      && heating[0].amount===service[1].amount && service[0].amount===heating[1].amount) {
    const amount=cents(heating[0].amount+service[0].amount);
    warnings.push('The two descriptions swap heating and service charges; their combined monthly cost is €'+amount+'.');
    return [...monthly_costs.filter(c=>!heating.includes(c)&&!service.includes(c)),{
      label:'Heating and service charges',amount,conditional:false,evidence:evidenceLine([...heating,...service].map(c=>c.evidence).join(' | ')),
    }];
  }
  return monthly_costs;
}

const missingBills = [
  ['heating',/heating|verwarming|stookkosten/i],
  ['electricity',/electricity|elektra|elektriciteit|\blicht\b/i],
  ['water',/\bwater\b/i],['gas',/\bgas\b/i],
  ['internet',/internet|\bwifi\b|wi-fi/i],
  ['television',/television|televisie|\btv\b/i],
  ['municipal taxes',/(?:municipal|municipality|city) tax(?:es)?|gemeentelijke belasting/i],
];

export function applyAgencyTerms(listing, source, options={}) {
  if (!['verra','bjornd','huizenbalie'].includes(source)) return listing;
  const evidence={...listing.evidence};
  let warnings=(listing.extraction_warnings||[]).filter(w=>!/Conflicting (?:heating|service charge) amounts/i.test(w));
  const lines=propertyLines(listing.body);
  const sourceFeatures=listing.source_features||{};
  const featureAvailability=options.availability||sourceFeatures.oplevering||sourceFeatures.aanvaarding||sourceFeatures['beschikbaar vanaf']||sourceFeatures['beschikbaar per']||listing.availability_text;
  // Relative or numeric values in unrelated clauses such as this year's price
  // changes never override the availability label.
  const explicitLine=lines.find(line=>explicitAvailability.test(line)&&dateAtStart(line.replace(explicitAvailability,'')));
  const fixedStart=/^(?:lease|tenancy|rental agreement|huurcontract|huurovereenkomst)\s+(?:must start|must commence|moet ingaan)\s*(?:on\s+|op\s+)?/i;
  const fixedLine=lines.find(line=>fixedStart.test(line)&&dateAtStart(line.replace(fixedStart,'')));
  const fixedDate=fixedLine?dateAtStart(fixedLine.replace(fixedStart,'')):null;
  const start_date=fixedDate||dateAtStart(featureAvailability)||dateAtStart(explicitLine?.replace(explicitAvailability,''));
  const availability_text=String(featureAvailability||(!start_date?lines.find(line=>/^available immediately|^per direct beschikbaar|^beschikbaar:? per direct/i.test(line)):'')||'').trim()||null;
  delete evidence.start_date;
  delete evidence.start_month;
  if (fixedDate) evidence.start_date=evidenceLine(fixedLine);
  else if (start_date) evidence.start_date=dateAtStart(featureAvailability)
    ? 'Property availability: '+featureAvailability
    : evidenceLine(explicitLine);
  const immediate=!start_date&&(isImmediateAvailability(availability_text)||(!featureAvailability&&listing.start_kind==='immediate'));
  const start_kind=fixedDate?'fixed':immediate?'immediate':start_date||availability_text?'earliest':null;

  const exactBase=lines.find(line=>/^(?:base rent|kale huur(?:prijs)?)\b/i.test(line)&&currency.test(line));
  const featurePrice=options.price||sourceFeatures.prijs||sourceFeatures.huurprijs;
  const priced=exactBase?.match(currency);
  const featureAmount=typeof featurePrice==='string'?featurePrice.match(currency):null;
  const partialInclusion=!exactBase&&typeof featurePrice==='string'&&/\b(?:inc|incl|including|inclusief)\b/i.test(featurePrice);
  const rent_base=partialInclusion?null:((priced||featureAmount)?money((priced||featureAmount)[1]):listing.rent_base??null);
  if (rent_base===null) delete evidence.rent_base;
  else if (priced) evidence.rent_base=evidenceLine(exactBase);
  else if (featureAmount) evidence.rent_base='Property monthly rent: '+evidenceLine(featurePrice);

  const advertisedLine=lines.find(line=>/^(?:totale maandelijkse huur|total monthly rent)\b/i.test(line)&&currency.test(line));
  const advertised=advertisedLine?money(advertisedLine.match(currency)[1]):partialInclusion&&featureAmount?money(featureAmount[1]):null;
  if (advertisedLine) evidence.rent_advertised_total=evidenceLine(advertisedLine);
  else if (advertised!==null) evidence.rent_advertised_total='Advertised recurring price: '+evidenceLine(featurePrice);

  const monthly_costs=normalizeMonthlyCosts(lines,warnings);
  const totalsByLabel=new Map();
  for(const cost of monthly_costs.filter(c=>!c.conditional)){
    const current=totalsByLabel.get(cost.label);
    if(current!==undefined && current!==cost.amount) warnings.push('Different monthly amounts are listed for '+cost.label.toLowerCase()+'.');
    totalsByLabel.set(cost.label,current===undefined?cost.amount:Math.min(current,cost.amount));
  }
  const recurringCharges=[...totalsByLabel.values()].reduce((a,b)=>a+b,0);
  let rent_known_monthly_min=advertised??rent_base;
  // A stated complete subtotal above already includes the line items, whereas
  // an advertised partly included price still excludes explicit extras.
  if (rent_known_monthly_min!==null && !advertisedLine) rent_known_monthly_min=cents(rent_known_monthly_min+recurringCharges);
  if (rent_known_monthly_min!==null) {
    evidence.rent_known_monthly_min=[advertisedLine||evidence.rent_advertised_total||evidence.rent_base,
      ...monthly_costs.filter(c=>!c.conditional).map(c=>c.evidence)].filter(Boolean).join(' | ').slice(0,500);
  }
  const exclusions=lines.filter(line=>rentExclusion.test(line) && (rentWords.test(line)||/^(?:excluding|exclusief)\b/i.test(line)));
  const exclusionClauses=exclusions.map(line=>{
    const start=line.match(rentExclusion);
    return line.slice(start.index+start[0].length).split(/(?<=[a-z])[.;](?=\s|$)/i,1)[0];
  });
  const bills_missing=missingBills.filter(([,pattern])=>exclusionClauses.some(line=>pattern.test(line))).map(([label])=>label);
  if (partialInclusion && exclusions.some(line=>utilityWords.test(line))) {
    warnings.push('The price feature indicates an inclusion, while the description says utilities are excluded.');
  }
  const saysExcluded=exclusions.some(line=>rentWords.test(line)||utilityWords.test(line))||
    (typeof featurePrice==='string'&&/\bp\.m\.\s*ex\./i.test(featurePrice));
  const rent_excludes_bills=saysExcluded||bills_missing.length?true:listing.rent_excludes_bills??null;
  const rent_total=rent_excludes_bills!==false?null:listing.rent_total??null;
  if (rent_total===null) delete evidence.rent_total;
  if (rent_excludes_bills && exclusions.length) evidence.rent_excludes_bills=evidenceLine(exclusions[0]);

  let furnished=listing.furnished??null;
  // Some furnished temporary lets use the agent's default upholstered feature.
  const ifFurnished=lines.find(line=>/this is a fully furnished short-stay apartment|dit betreft een volledig gemeubileerd short-stay appartement/i.test(line));
  const seasonalPrice=lines.find(line=>/(?:advertised price is only valid|geadverteerde prijs is uitsluitend geldig)/i.test(line));
  if (seasonalPrice) warnings.push('The advertised price applies only during the stated season.');
  if (/impression photos of a similar property|impressiefoto(?:['’]s)? van een vergelijkbare woning/i.test(listing.body||'')) {
    warnings.push('The source says the photos illustrate a similar property.');
  }
  if (ifFurnished && furnished!=='furnished') {
    furnished='furnished';
    evidence.furnished=evidenceLine(ifFurnished);
    if (options.furnishing && /gestoffeerd/i.test(options.furnishing)) warnings.push('The description says fully furnished; the features only say upholstered.');
  }
  if (furnished==='upholstered') warnings=warnings.filter(w=>!/conflicting furnished\/unfurnished/i.test(w));
  const one_time_costs=[];
  const cleaningLine=lines.find(line=>oneTime.test(line)&&/cleaning|eindschoonmaak/i.test(line)&&currency.test(line));
  if (cleaningLine) {
    const amount=money(cleaningLine.match(currency)[1]);
    if (amount!==null) one_time_costs.push({label:'End cleaning',amount,evidence:evidenceLine(cleaningLine)});
  }
  let deposit=listing.deposit??null;
  const depositLine=lines.find(line=>/\b(?:deposit|waarborgsom)\b/i.test(line)&&/\d+\s*(?:maand|months?)/i.test(line));
  if(deposit===null&&depositLine){
    const monthNumbers=depositLine.match(/\b\d+(?=\s*(?:maand|months?))/gi);
    if(monthNumbers?.length) deposit=[...new Set(monthNumbers)].join('–')+(monthNumbers.length===1&&monthNumbers[0]==='1'?' month of rent':' months of rent');
    evidence.deposit=evidenceLine(depositLine);
  }
  let max_stay_months=listing.max_stay_months??null;
  if(max_stay_months!==null && evidence.max_stay_months && lines.some(line=>/\bminim(?:um|aal)\b/i.test(line)&&line.toLowerCase().includes(evidence.max_stay_months.toLowerCase()))){
    max_stay_months=null;
    delete evidence.max_stay_months;
  }
  const supportStudent=lines.some(line=>/\b(?:students? (?:are )?(?:welcome|allowed|accepted)|studenten welkom|studenten toegestaan|geschikt voor studenten|suitable for students)\b/i.test(line));
  let student_allowed=listing.student_allowed??null;
  if(student_allowed===true&&!listing.degree_restriction&&!supportStudent) {
    student_allowed=null;
    delete evidence.student_allowed;
  }
  const incomeLine=lines.find(line=>/income requirement|inkomenseis|financially stable|financieel stabiel/i.test(line));
  if(incomeLine) evidence.income_requirement=evidenceLine(incomeLine);
  const bedroomsText=String(options.bedrooms??sourceFeatures['aantal slaapkamers']??'');
  const combinedRoom=lines.some(line=>/combined living and sleeping area|gecombineerde woon- en slaapruimte/i.test(line));
  const bedrooms=/^\d+$/.test(bedroomsText)?Number(bedroomsText):listing.bedrooms??(combinedRoom?0:null);
  const areaLine=lines.find(line=>/^(?:woonoppervlakte(?: volgens [^:]*)?|registered living area(?: according to [^:]*)?|living area)\s*:/i.test(line));
  const labelledArea=areaLine?.match(/:\s*(?:ca\.?\s*)?(\d+(?:[.,]\d+)?)\s*m[2²](?!\d)/i);
  let area_m2=listing.area_m2??null;
  if(labelledArea&&positive(Number(labelledArea[1].replace(',','.')))){
    area_m2=Number(labelledArea[1].replace(',','.'));
    evidence.area_m2=evidenceLine(areaLine);
  }

  return {...listing,evidence,extraction_warnings:[...new Set(warnings)],start_date,start_month:null,start_kind,availability_text,
    rent_base,rent_total,rent_known_monthly_min,rent_advertised_total:advertised,rent_excludes_bills,monthly_costs,bills_missing,
    max_stay_months,area_m2,furnished,deposit,one_time_costs,student_allowed,bedrooms,income_requirement:incomeLine?true:listing.income_requirement??null,
    contract_type:ifFurnished?'Short stay':listing.contract_type??null,
  };
}
