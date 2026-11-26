// Kamernet search and detail fields use the same displayed rental quote. The
// utility flag describes that quote; it does not break it into base and bills.
const FURNISHING = {1:'uncarpeted',2:'unfurnished',4:'furnished'};
const OCCUPATION = {1:'Student',2:'Working student',4:'Working',8:'Looking for a job'};
const GENDER = {1:'Male',2:'Female',8:'Not important'};
const LANGUAGE = {1:'Dutch',2:'English',4:'Spanish',8:'French',16:'Italian',32:'German',64:'Portuguese',128:'Chinese',256:'Russian',512:'Japanese',16384:'Vietnamese'};
const IDEAL_STAY = {1:'3 months',2:'6 months',3:'1 year',4:'2 years or more'};
const amount = value => Number.isFinite(value) && value > 0 ? value : null;
const text = value => typeof value === 'string' ? value.replace(/\s+/g,' ').trim() : '';
const sourceLabel = (label,value) => `Public Kamernet ${label}: ${value}.`;
function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value))return null;
  const day=value.slice(0,10);
  const timestamp=Date.parse(day+'T00:00:00Z');
  return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===day?day:null;
}
function priceScope(included){
  return included===true?'Including utilities':included===false?'Excluding utilities':'Utility coverage unspecified';
}
function nativeQuote(row){
  const rent=amount(row.totalRentalPrice)??amount(row.rentalPrice);
  const included=typeof row.utilitiesIncluded==='boolean'?row.utilitiesIncluded:null;
  return {rent,included,quote:rent===null?null:sourceLabel(`monthly rent (${priceScope(included).toLowerCase()})`,`€${rent}`)};
}

export function normalizeKamernetIndex(row){
  const {rent,included,quote}=nativeQuote(row);
  const start_date=validDate(row.availabilityStartDate);
  const end_date=validDate(row.availabilityEndDate);
  const area_m2=amount(row.surfaceArea);
  const furnished=FURNISHING[row.furnishingId]??null;
  const evidence={};
  if(quote){
    evidence.rent_advertised_total=quote;
    evidence.rent_known_monthly_min=quote;
    if(included===false)evidence.rent_base=quote;
    if(included!==null)evidence.rent_excludes_bills=quote;
  }
  if(start_date)evidence.start_date=sourceLabel('available from',start_date);
  if(end_date)evidence.end_date=sourceLabel('available until',end_date);
  if(area_m2!==null)evidence.area_m2=sourceLabel('area',`${area_m2} m²`);
  if(furnished)evidence.furnished=sourceLabel('furnishing',furnished);
  const postcode=text(row.postalCode).toUpperCase().replace(/^(\d{4})\s*([A-Z]{2})$/,'$1 $2');
  const lat=row.postalCodeLat,lng=row.postalCodeLong;
  const location=Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lng)&&Math.abs(lng)<=180&&
    Math.abs(lat-52)<0.2&&Math.abs(lng-4.36)<0.3
    ? {lat,lng,precision:'postcode',street:text(row.computedStreetName??row.street),postcode:/^[1-9]\d{3} [A-Z]{2}$/.test(postcode)?postcode:''}
    : null;
  return {
    rent_advertised_total:rent,rent_base:included===false?rent:null,rent_total:null,
    rent_known_monthly_min:rent,rent_excludes_bills:included===null?null:!included,
    start_date,start_month:null,start_kind:start_date?'earliest':null,end_date,area_m2,furnished,evidence,
    ...(location ? { location } : {}),
    priceText:rent!==null?`Advertised monthly rent (${priceScope(included).toLowerCase()}): €${rent}`:'',
  };
}

// These formats are limited to explicit euro expressions and property-rent
// labels. A quoted figure by itself can be a deposit, a fee, or another room.
const DIGITS='\\d+(?:[.,]\\d+)*(?:[ \\u00a0]\\d{3})*';
const EURO=`(?:€\\s*${DIGITS}|(?:${DIGITS})\\s*(?:euros?\\b|EUR\\b|€))`;
function euroValue(quote){
  let digits=quote.match(new RegExp(DIGITS))?.[0]?.replace(/\s/g,'');
  if(!digits)return null;
  const tail=digits.match(/[.,](\d+)$/)?.[1];
  if(tail?.length===1||tail?.length===2){
    const split=digits.lastIndexOf(tail)-1;
    digits=digits.slice(0,split).replace(/[.,]/g,'')+'.'+tail;
  }else digits=digits.replace(/[.,]/g,'');
  return amount(Number(digits));
}
function quoteMatches(description,pattern){
  return [...description.matchAll(pattern)].map(m=>({amount:euroValue(m[1]),evidence:text(m[0]).slice(0,250)})).filter(x=>x.amount!==null);
}
const rentLabels='(?:monthly rent(?:al price)?|rent(?:al price)?|maandelijkse huurprijs|huurprijs|huur)';
function proseRent(description){
  const matches=quoteMatches(description,new RegExp(`\\b${rentLabels}\\s*(?:(?:is|of|bedraagt|comes to|zal zo[’']?n|per maand)\\s*)?[:=]?\\s*(?:approximately|ongeveer|around)?\\s*(${EURO})`,'gi'));
  return matches.filter(({evidence})=>!/\b(?:deposit|borg|security)\b/i.test(evidence));
}
function proseDeposit(description){
  return quoteMatches(description,new RegExp(`\\b(?:security deposit|deposit|waarborgsom|borgsom|borg)\\s*(?:(?:is|of|bedraagt)\\s*)?[:=]?\\s*(${EURO})`,'gi')).concat(
    quoteMatches(description,new RegExp(`\\b(?:amounting to|wat neerkomt op|oftewel)\\s*(${EURO})`,'gi')).filter(({evidence})=>{
      const at=description.indexOf(evidence);if(at<0)return false;
      return /\b(?:security deposit|deposit|waarborgsom|borgsom)\b/i.test(description.slice(Math.max(0,at-125),at));
    })
  );
}
function breakdownFor(description,rent){
  if(rent===null)return null;
  const pattern=new RegExp(`(${EURO})[,.\\s-]*(?:per month|per maand|p\\.m\\.)\\s*,?\\s*(?:plus|\\+)\\s*(${EURO})[,.\\s-]*(?:service(?: costs?| charges?)|servicekosten)\\b`,'gi');
  for(const m of description.matchAll(pattern)){
    const base=euroValue(m[1]), service=euroValue(m[2]);
    if(base!==null&&service!==null&&Math.abs(base+service-rent)<0.005)return {base,service,evidence:text(m[0])};
  }
  return null;
}
function preferences(data){
  const occupation=Array.isArray(data.candidateStatusId)?data.candidateStatusId.map(id=>OCCUPATION[id]).filter(Boolean):[];
  const languages=Array.isArray(data.desiredTenantLanguagesSpokenID)?data.desiredTenantLanguagesSpokenID.map(id=>LANGUAGE[id]).filter(Boolean):[];
  return {
    occupation,languages,gender:GENDER[data.candidateGenderId]??null,
    ageMin:amount(data.candidateMinAgeId),ageMax:amount(data.candidateMaxAgeId),
    idealStay:IDEAL_STAY[data.idealRentalPeriodId]??null,tenants:amount(data.suitableForNumberOfPersons),
  };
}

function discountBasedRent(description){
  return /\b(?:after (?:subtracting|deducting|deduction of|receiving)?\s*(?:the )?(?:rent|housing) allowance|na aftrek van (?:de )?huurtoeslag|na verrekening van (?:de )?huurtoeslag)\b/i.test(description);
}
function scopedCosts(description){
  const utilityInclusion=/\b(?:includ(?:ing|es|ed) (?:all )?(?:utilities|gas(?:,?\s+water)?(?:\s+and electricity)?)|(?:including all|includes all) (?:costs|charges)|inclusief (?:alle (?:bijkomende )?kosten|gas[\s,/]+water[\s,/]+(?:licht|elektra|elektriciteit)))\b/i.test(description);
  const all=/\b(?:including all (?:utilities and other )?(?:costs|bills|charges)|includes all (?:costs|charges)|all costs are included|all-in rent|inclusief alle (?:bijkomende )?kosten)\b/i.test(description);
  const municipal=/\b(?:municipal (?:user|resident) taxes|municipal taxes for residents|gemeentelijke gebruikersbelastingen)\b/i;
  const excludedTax=municipal.test(description)&&/\b(?:only|excluding|excluded|not included|except(?:ion of)?|uitgezonderd|niet inbegrepen|exclusief)\b/i.test(description);
  const utilityExclusions=/\b(?:utility costs are excluded|excl(?:uding|usief)?\.?\s*(?:utilities|gas|g\s*\/\s*w\s*\/\s*[le])|uitgezonderd (?:gas|water|elektra))\b/i.test(description);
  return {all,utilityInclusion,utilityExclusions,excludedTax};
}
function explicitRoomArea(description){
  const m=description.match(/\b(?:kamer|room)(?:\s+(?:is|of|van|measures|oppervlakte)|\s*[:(]|[^\n.!?]{0,75}\bis)\s*(?:ongeveer\s*|approximately\s*|circa\s*|[~≈+\-]+\s*)?(\d{1,3}(?:[.,]\d+)?)\s*(?:m(?:\^?2|²)|square met(?:res|ers)|vierkante meter)(?![\w²])/i);
  return m?{value:amount(Number(m[1].replace(',','.'))),evidence:text(m[0])}:null;
}

function corroboratedArea(description,sourceArea){
  const matches=[...description.matchAll(/\b(\d{1,3}(?:[.,]\d+)?)\s*(?:m(?:\^?2|²)|square met(?:res|ers)|vierkante meter)(?![\w²])/gi)];
  const unique=[...new Set(matches.map(m=>Number(m[1].replace(',','.'))))];
  if(unique.length!==1||!amount(unique[0])||sourceArea!==null&&Math.abs(sourceArea-unique[0])>1)return null;
  return {value:unique[0],evidence:matches[0][0]};
}

function calendarHint(description,when){
  const cue=when==='start'?'available (?:from|on)|vanaf|beschikbaar (?:vanaf|per)':'available until|until|tot(?: en met)?|t\\/m';
  const months='january|januari|february|februari|march|maart|april|may|mei|june|juni|july|juli|august|augustus|september|october|oktober|november|december';
  return description.match(new RegExp(`\\b(?:${cue})\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+)?(${months})\\b`,'i'));
}
const CALENDAR_MONTHS=['january januari','february februari','march maart','april','may mei','june juni','july juli','august augustus','september','october oktober','november','december'];
function disagreesWithCalendar(hint,date){
  if(!hint||!date)return false;
  const month=CALENDAR_MONTHS.findIndex(names=>names.split(' ').includes(hint[2].toLowerCase()))+1;
  return month!==Number(date.slice(5,7))||!!(hint[1]&&Number(hint[1])!==Number(date.slice(8,10)));
}

export function normalizeKamernetDetail(data,candidate,listing,description){
  const prose=typeof description==='string'?description:listing.body||'';
  const native=normalizeKamernetIndex(data);
  const sourceFacts={...native};
  delete sourceFacts.priceText;
  const patch={...sourceFacts,city:data.computedCityName||candidate.city||listing.city,
    wanted_ad:false,sale_ad:false,
    source_preferences:preferences(data),deposit:amount(data.deposit),
    extraction_warnings:[...new Set(listing.extraction_warnings||[])],monthly_costs:[],bills_missing:[...new Set(listing.bills_missing||[])]};
  const evidence={...listing.evidence,...sourceFacts.evidence};
  patch.evidence=evidence;
  const warn=message=>{if(!patch.extraction_warnings.includes(message))patch.extraction_warnings.push(message);};
  const set=(k,v,quote)=>{patch[k]=v;if(quote)evidence[k]=quote;else delete evidence[k];};
  if(typeof data.candidatePetsAllowed==='boolean'){
    if(typeof listing.pets_allowed==='boolean'&&listing.pets_allowed!==data.candidatePetsAllowed){
      warn('Kamernet and the advertiser’s description disagree on pets.');
      set('pets_allowed',null);
    }
    else set('pets_allowed',data.candidatePetsAllowed,sourceLabel('pets allowed',data.candidatePetsAllowed?'yes':'no'));
  }
  const retain=(k,v,quote)=>{if(v!==null&&v!==undefined)set(k,v,quote);};
  if(patch.city) evidence.city=sourceLabel('property city',patch.city);
  if(patch.rent_base===null)delete evidence.rent_base;
  delete evidence.rent_total;
  if(patch.deposit!==null)evidence.deposit=sourceLabel('deposit',`€${patch.deposit}`);
  else delete evidence.deposit;

  const got=nativeQuote(data);
  const cost=scopedCosts(prose);
  const advertised=proseRent(prose);
  const amounts=[...new Set(advertised.map(x=>x.amount))];
  const additional=amount(data.agencyFee)??amount(data.internetAdditionalCosts)??amount(data.registrationCost);
  const additionalLabel=text(data.agencyFeeDescriptionEN||data.agencyFeeDescriptionNL)||'additional costs';
  const includedNotes=additional===null?null:sourceLabel(additionalLabel,`€${additional}`);
  if(additional!==null){
    warn(`The source lists €${additional} in ${additionalLabel}. Frequency and whether it is required are unconfirmed.`);
    evidence.unclassified_additional_charge=includedNotes;
  }else if(text(data.agencyFeeDescriptionEN||data.agencyFeeDescriptionNL)&&!got.included){
    warn(`The source lists ${additionalLabel} separately without an amount.`);
  }
  if(cost.excludedTax){
    patch.bills_missing=[...new Set([...patch.bills_missing,'municipal user taxes'])];
    patch.rent_excludes_bills=true;
    evidence.rent_excludes_bills='The advertiser excludes municipal user taxes.';
  }
  const breakdown=breakdownFor(prose,got.rent);
  const incompatiblePrice=got.rent!==null&&amounts.length===1&&amounts[0]!==got.rent&&!breakdown;
  const conflictingUtilities=(got.included===false&&cost.utilityInclusion)||(got.included===true&&cost.utilityExclusions);
  const priceConditional=discountBasedRent(prose);
  if(priceConditional){
    for(const k of ['rent_advertised_total','rent_base','rent_total','rent_known_monthly_min','rent_excludes_bills'])set(k,null);
    warn('The stated price is after a housing allowance. Confirm the gross monthly cost.');
  }else if(incompatiblePrice){
    const original=advertised[0];
    set('rent_base',null);
    set('rent_known_monthly_min',Math.min(got.rent,original.amount),`${got.quote} ${original.evidence}`);
    warn(`The Kamernet price (€${got.rent}) and advertiser’s monthly rent (€${original.amount}) differ.`);
  }else if(breakdown){
    set('rent_base',breakdown.base,breakdown.evidence);
    patch.monthly_costs=[{label:'Service charge',amount:breakdown.service,conditional:false,evidence:breakdown.evidence}];
  }
  if(conflictingUtilities){
    set('rent_excludes_bills',null);
    set('rent_base',null);
    warn('The structured utility label and the advertiser’s description disagree.');
  }
  const allCostQuote=prose.split(/\n|(?<=[.!?])\s+/).find(part=>scopedCosts(part).all&&proseRent(part).some(x=>x.amount===got.rent));
  const allCostsAgree=allCostQuote&&!priceConditional&&!incompatiblePrice&&!conflictingUtilities&&!cost.excludedTax&&!patch.bills_missing.length&&additional===null&&
    !text(data.agencyFeeDescriptionEN||data.agencyFeeDescriptionNL);
  if(allCostsAgree){
    set('rent_total',got.rent,text(allCostQuote).slice(0,250));
    set('rent_excludes_bills',false,text(allCostQuote).slice(0,250));
  }
  if(got.included===true&&additional===null&&text(data.agencyFeeDescriptionEN||data.agencyFeeDescriptionNL)){
    warn(`The source lists ${additionalLabel} separately without confirming whether it is included.`);
  }
  const deposits=proseDeposit(prose);
  const depositAmounts=[...new Set(deposits.map(x=>x.amount))];
  if(depositAmounts.length===1){
    if(patch.deposit===null)set('deposit',depositAmounts[0],deposits[0].evidence);
    else if(patch.deposit!==depositAmounts[0]){
      warn(`The listed deposit (€${patch.deposit}) and the deposit in the description (€${depositAmounts[0]}) differ.`);
      set('deposit',null);
    }
  }

  const proseStart=validDate(listing.start_date),proseEnd=validDate(listing.end_date);
  if(proseStart&&native.start_date&&proseStart!==native.start_date)warn('The advertiser’s start date and the Kamernet calendar differ.');
  else if(proseStart&&!native.start_date)set('start_date',proseStart,listing.evidence?.start_date);
  if(proseEnd&&native.end_date&&proseEnd!==native.end_date)warn('The advertiser’s end date and the Kamernet calendar differ.');
  else if(proseEnd&&!native.end_date)set('end_date',proseEnd,listing.evidence?.end_date);
  if(patch.start_date&&proseStart===patch.start_date&&listing.start_kind==='fixed')patch.start_kind='fixed';
  else if(patch.start_date)patch.start_kind='earliest';
  else if(listing.start_month){patch.start_month=listing.start_month;patch.start_kind=listing.start_kind;}
  const startHint=calendarHint(prose,'start'),endHint=calendarHint(prose,'end');
  if(!proseStart&&disagreesWithCalendar(startHint,native.start_date))warn(`The advertiser mentions ${startHint[0]}, while the Kamernet calendar starts ${native.start_date}.`);
  if(!proseEnd&&disagreesWithCalendar(endHint,native.end_date))warn(`The advertiser mentions ${endHint[0]}, while the Kamernet calendar ends ${native.end_date}.`);
  if(!native.end_date&&!proseEnd&&endHint)warn(`The advertiser says ${endHint[0]}, but a full end date is not stated.`);
  const term=prose.match(/\b(?:at least (?:a|an|one) year|(?:a|an|one) year at least)\b/i);
  if(term&&!/\b(?:notice|opzegtermijn)\b/i.test(prose.slice(Math.max(0,term.index-30),term.index+term[0].length+30)))
    set('min_stay_months',12,term[0]);
  const typedRegistration=typeof data.isRegistrationAllowed==='boolean'?data.isRegistrationAllowed:null;
  const register=prose.match(/\b(?:je (?:kan|kunt) je inschrijven|je (?:kan|kunt) je wel inschrijven|inschrijven is mogelijk)\b/i);
  if(typedRegistration!==null&&listing.registration!=null&&typedRegistration!==listing.registration){set('registration',null);warn('Kamernet registration setting disagrees with the advertiser’s description.');}
  else retain('registration',typedRegistration??listing.registration??(register?true:null),register?.[0]??(typedRegistration!==null?sourceLabel('registration allowed',typedRegistration?'yes':'no'):listing.evidence?.registration));
  // "Indefinite registration" does not make the rental term indefinite.
  if(listing.indefinite===true&&/\binschrijven voor onbepaalde tijd\b/i.test(prose)&&!/(?:huur(?:periode|contract)|contract)\s+(?:voor )?onbepaalde tijd/i.test(prose))set('indefinite',null);
  if(listing.student_allowed==null&&patch.source_preferences.occupation.includes('Student')){
    set('student_allowed',true,'Student is explicitly listed among the Kamernet ideal tenant occupations.');
  }
  const dutch=prose.match(/\b(?:only dutch[ -]speaking(?: students?)?|dutch[ -]speaking only|dutch speakers only|dutch only)\b/i);
  if(dutch)set('languages_required',[...new Set([...(listing.languages_required||[]),'Dutch'])],dutch[0]);
  const age=prose.match(/\b(?:end of (?:your )?bsc|eind van je bsc|begin msc)\b[^\n]{0,55}?\((\d{2})\+\)/i);
  if(age)set('age_min',Number(age[1]),age[0]);
  else if(/\b(?:we wonen|we live|housemates are)\b[^\n.!?]{0,110}\b(?:leeftijd|aged?)\s+\d{2}\s*[-–]\s*\d{2}/i.test(prose)&&!/(?:minimum age|minimale leeftijd|must be aged|moet.*leeftijd)/i.test(prose)){
    set('age_min',null);set('age_max',null);
  }
  const gender=prose.match(/\b(?:looking for a (?:female student|male subtenant|female tenant)|(?:op zoek naar|zoeken)\s+(?:een )?(?:\d+(?:de|e) )?(?:\([^\n)]{1,50}\)\s*)?(?:mannelijke (?:huisgenoot|onderhuurder)|vrouwelijke (?:studente|huisgenoot))|uitsluitend voor een vrouw|ben jij een man, bachelor student|(?:kamerzoekende meiden|room seeking men))\b/i);
  if(gender&&listing.household_restriction_unverified!==true)set('household_restriction_unverified',true,gender[0]);
  const roomArea=explicitRoomArea(prose);
  const similarArea=corroboratedArea(prose,native.area_m2);
  if(roomArea?.value&&(data.listingTypeId===1||/\/room-\d+(?:$|[?#])/.test(candidate.url||''))&&roomArea.value!==native.area_m2){
    set('area_m2',roomArea.value,roomArea.evidence);
  }else if(similarArea&&similarArea.value!==native.area_m2)set('area_m2',similarArea.value,similarArea.evidence);
  const upholstered=prose.match(/\bgestoffeerde? (?:kamer|studio|appartement)\b|\b(?:kamer|studio|appartement)\b[^\n.!?]{0,55}\bgestoffeerd\b/i);
  if(upholstered&&native.furnished!=='furnished')set('furnished','upholstered',upholstered[0]);
  else if(upholstered)warn('The advertised furnishing differs between the Kamernet category and the advertiser’s description.');
  else if(native.furnished===null)retain('furnished',listing.furnished,listing.evidence?.furnished);
  if(native.end_date&&listing.indefinite===true) set('indefinite',null);
  return patch;
}
