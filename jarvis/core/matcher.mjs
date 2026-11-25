import {normalizeFacebookTerms} from './facebook-terms.mjs';

/** Conservative, evidence-based housing rules. Missing terms never become facts. */
export const DEFAULT_PROFILE = Object.freeze({
  name: 'Housing applicant', university: 'your university', programme: 'degree programme', student: true,
  age_at_move_in: null, languages: null,
  max_rent_total: Infinity, start_min: '2000-01-01', start_max: '2099-12-31',
  min_stay_months: 1, preferred_end: '2099-12-31', city: 'Delft',
  parents_pay: false, guarantor_confirmed: false, registration_required: null,
});
export const EXTRACTION_EVIDENCE_VERSION = 1;

const MONTHS = {january:1,januari:1,jan:1,february:2,februari:2,feb:2,march:3,maart:3,mar:3,april:4,apr:4,may:5,mei:5,june:6,juni:6,jun:6,july:7,juli:7,jul:7,august:8,augustus:8,aug:8,september:9,sep:9,sept:9,october:10,oktober:10,oct:10,okt:10,november:11,nov:11,december:12,dec:12};
const MONTH_RE = Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|');
const DATE_RE = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_RE})\\.?\\s+\\d{4}|(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4})`;

function validDate(y,m,d) {
  const date = new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d
    ? `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
}
function parseDate(value) {
  if (typeof value!=='string'||!value) return null;
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(+m[1],+m[2],+m[3]);
  m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return validDate(+m[3],+m[2],+m[1]);
  m = value.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?\\s+(\\d{4})$`,'i'));
  if (m) return validDate(+m[3],MONTHS[m[2].toLowerCase()],+m[1]);
  m = value.match(new RegExp(`^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})$`,'i'));
  return m ? validDate(+m[3],MONTHS[m[1].toLowerCase()],+m[2]) : null;
}
function money(value) {
  let s=value.replace(/\s/g,'');
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?$/.test(s)) {
    s=s.replace(/[.,](?=\d{3}(?:[.,]|$))/g,'');
  }
  if (s.includes(',') && !s.includes('.')) s=s.replace(',','.');
  const n=Number(s);
  return Number.isFinite(n) && n>=0 ? n : null;
}
function number(v) { return typeof v==='number' && Number.isFinite(v); }
function addMonths(iso,n) {
  const d=new Date(`${iso}T00:00:00Z`); const day=d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+n);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,last)); return d.toISOString().slice(0,10);
}
function safeUrl(value) {
  try { const u=new URL(value); return ['https:','http:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}

/** Parse explicit English/Dutch terms only. Conflicting extraction is marked for review. */
export function parseListingText(text,source='manual',url=null) {
  const body=String(text ?? '').slice(0,100_000);
  const listing={source:String(source),url:safeUrl(url),title:body.split(/\r?\n/).find(s=>s.trim())?.trim().slice(0,180) || 'Housing listing',body,
    rent_total:null,rent_base:null,rent_excludes_bills:null,start_date:null,start_month:null,start_kind:null,end_date:null,max_stay_months:null,
    min_stay_months:null,indefinite:null,student_allowed:null,registration:null,languages_required:[],age_min:null,age_max:null,contact_email:null,
    degree_restriction:null,working_only:null,international_excluded:null,household_restriction_unverified:null,
    income_requirement:null,guarantor_mentioned:null,area_m2:null,furnished:null,deposit:null,wanted_ad:false,sale_ad:false,
    initial_stay_months:null,weekdays_only:null,
    city:/\bdelft\b/i.test(body)?'Delft':null,extraction_warnings:[]};
  listing.evidence={};listing.monthly_costs=[];listing.bills_missing=[];listing.rent_known_monthly_min=null;
  const excerpt=(index,length=80)=>body.slice(Math.max(0,index-45),Math.min(body.length,index+length+120)).trim().slice(0,240);
  const prefixAmounts=[...body.matchAll(/(?:€|EUR(?=\s|\d))[ \t]*(\d+(?:[.,]\d+)*(?:[ \u00a0]\d{3})*)/gi)];
  const suffixAmounts=[...body.matchAll(/\b(\d+(?:[.,]\d+)*(?:[ \u00a0]\d{3})*)[ \t]*(?:EUR(?:O(?:S)?)?\b|€)/gi)];
  const amounts=[];for(const m of [...prefixAmounts,...suffixAmounts].sort((a,b)=>a.index-b.index)){
    if(amounts.some(a=>m.index<a.index+a.length&&m.index+m[0].length>a.index))continue;
    const value=money(m[1]);if(value!==null)amounts.push({value,index:m.index,length:m[0].length});
  }
  const cities='Delft|Rotterdam|Den Haag|The Hague|Leiden|Rijswijk|Schiedam|Voorburg|Delfgauw|Pijnacker|Nootdorp';
  const modifiers='is|a|an|nice|cozy|cosy|spacious|modern|furnished|unfurnished|fully|newly|renovated|available|for|rent|te|huur|beschikbaar|gestoffeerde|gemeubileerde|gestoffeerd|gemeubileerd|large|small|single|double|student|offered|located|situated|gelegen';
  const propertyLocation=body.slice(0,1600).match(new RegExp(`\\b(?:room|studio|apartment|flat|house|property|sublet|kamer|woning|appartement)\\b(?:\\s+(?:${modifiers})){0,10}\\s+(?:in|te)\\s+(?:(?:north|south|east|west|central|noord|zuid|oost|centrum)[ -]+)?(${cities})\\b`,'i'));
  const labelledLocation=body.slice(0,1600).match(new RegExp(`\\b(?:city|plaats|location|locatie)\\s*:\\s*(${cities})\\b`,'i'));
  const titleLocation=body.split(/\r?\n/,1)[0].match(new RegExp(`,\\s*(${cities})(?:\\s*[,–-]\\s*(?:Netherlands|Nederland))?[.!]?\\s*$`,'i'));
  const location=labelledLocation||titleLocation||propertyLocation;if(location){const canonical=cities.split('|').find(c=>c.toLowerCase()===location[1].toLowerCase());listing.city=canonical;listing.evidence.city=location[0];}

  const costTypes=[['Service charge',/(?:service(?:\s+(?:costs?|charge))?|servicekosten)[^\d€]{0,25}$/i],['Heating',/(?:heating(?:\s+costs?)?|stookkosten|voorschot\s+(?:stookkosten|verwarming)|verwarming)[^\d€]{0,25}$/i],['Utilities',/(?:utilities|energy costs|energiekosten|gas water (?:and )?electricity)[^\d€]{0,25}$/i],['Parking',/(?:parking(?:\s+(?:space|place|costs?))?|parkeerplaats|parkeerkosten)[^\d€]{0,35}$/i]];
  for(const a of amounts){
    const before=body.slice(Math.max(0,a.index-90),a.index),after=body.slice(a.index+a.length,a.index+a.length+100);
    const lineStart=body.lastIndexOf('\n',a.index)+1,lineEnd=body.indexOf('\n',a.index);a.line=body.slice(lineStart,lineEnd<0?body.length:lineEnd);
    a.before=before;a.after=after;const clauseStart=Math.max(body.lastIndexOf('\n',a.index),body.lastIndexOf(';',a.index))+1;const clauseEnds=[body.indexOf('\n',a.index),body.indexOf(';',a.index)].filter(n=>n>=0);a.clause=body.slice(clauseStart,clauseEnds.length?Math.min(...clauseEnds):body.length);
    a.deposit=/(?:deposit|borg(?:som)?)[^\d€]{0,20}$/i.test(before)||/^\s*(?:deposit|borg(?:som)?)\b/i.test(after);
    a.notRent=a.deposit||/(?:income|salary|inkomen|salaris|bedlinnenpakket|schoonmaakkosten|verhuurkosten)[^\d€]{0,20}$/i.test(before);
    const cost=costTypes.find(([,re])=>re.test(before));
    if(cost){a.notRent=true;const conditional=cost[0]==='Parking'||/optional|optioneel|in case|if you|indien|bij bezit|aanvullend|additional available/i.test(a.clause);const included=/\b(?:incl(?:uding|usief)?\.?|included)\s*$/i.test(before);const oneTime=/one[ -]off|one[ -]time|eenmalig|deposit|borg/i.test(a.clause);
      if(!oneTime&&!included){const old=listing.monthly_costs.find(c=>c.label===cost[0]&&c.amount===a.value);if(!old)listing.monthly_costs.push({label:cost[0],amount:a.value,conditional,evidence:excerpt(a.index,a.length)});}
    }
    if(a.deposit&&listing.deposit==null){listing.deposit=a.value;listing.evidence.deposit=excerpt(a.index,a.length);}
    a.score=(/(?:rent(?:al price)?|huur(?:prijs)?|monthly rent|advertised search price)\s*[:=]?\s*$/i.test(before)?12:0)+(/^\s*(?:p\.?\s*m\.?|per month|a month|per maand|\/month|monthly)\b/i.test(after)?9:0)+(a.line.trim().startsWith(body.slice(a.index,a.index+a.length))&&a.line.length<90?7:0);
  }
  const rentAmounts=amounts.filter(a=>!a.notRent);const selected=rentAmounts.sort((a,b)=>b.score-a.score||a.index-b.index)[0];
  if(selected&&(selected.score>0||rentAmounts.length===1)){
    listing.rent_base=selected.value;listing.evidence.rent_base=excerpt(selected.index,selected.length);
    const context=body.slice(Math.max(0,selected.index-50),selected.index+selected.length+100);
    const excluded=/\b(?:excl(?:uding|usief)?\.?|excluding)\s*(?:(?:all|alle)\s+)?(?:bills|utilities|g\s*[/,]\s*w\s*[/,]\s*[el]|gas|water|electricity|elektriciteit|energy|energie|service(?:kosten| costs)?)/i.test(context)||/^\s*p\.?m\.?\s+ex(?:cl)?\.?/i.test(selected.after);
    const included=/\b(?:all[ -]?in(?:clusive)?|all (?:utilities|bills) (?:are )?included|incl(?:uding|usief)?\.?\s*(?:(?:all|alle)\s+)?(?:bills|utilities|g\s*[/,]\s*w\s*[/,]\s*[el]|gas.{0,30}(?:electricity|elektriciteit)|service(?:kosten| costs)?\s*(?:and|en)\s*(?:utilities|gwe)))\b/i.test(context);
    listing.rent_excludes_bills=excluded?true:included?false:null;
    if(included&&!excluded){listing.rent_total=selected.value;listing.evidence.rent_total=excerpt(selected.index,selected.length);}
    if(included&&excluded)listing.extraction_warnings.push('Price includes conflicting included/excluded cost wording.');
    const categories=new Map();for(const c of listing.monthly_costs.filter(c=>!c.conditional)){const old=categories.get(c.label);if(old&&old.amount!==c.amount)listing.extraction_warnings.push('Conflicting '+c.label.toLowerCase()+' amounts are stated.');if(!old)categories.set(c.label,c);}
    listing.rent_known_monthly_min=listing.rent_total??Math.round((selected.value+[...categories.values()].reduce((sum,c)=>sum+c.amount,0))*100)/100;
    listing.evidence.rent_known_monthly_min=[listing.evidence.rent_base,...[...categories.values()].map(c=>c.evidence)].join(' | ').slice(0,500);
  }
  for(const line of body.split(/\n|;/)){if(!/\b(?:exclud(?:e[ds]?|ing)|excl(?:usief)?\.?|exclusief)\b/i.test(line))continue;
    for(const [label,re]of [['electricity',/electricity|elektra|elektriciteit|\blicht\b/i],['water',/\bwater\b/i],['gas',/\bgas\b/i],['internet',/internet|wifi/i],['television',/television|televisie/i]])if(re.test(line)&&!listing.bills_missing.includes(label))listing.bills_missing.push(label);
  }
  const from=body.match(new RegExp(`(?:available\\s+(?:from|on)|start(?:s|ing)?(?:\\s+date)?(?:\\s+on)?(?:\\s+the)?|move[ -]?in|beschikbaar\\s+(?:vanaf|per)|ingangsdatum|vanaf|per)\\s*[:=]?\\s*(${DATE_RE})`,'i'));
  const until=body.match(new RegExp(`(?:available\\s+until|until|end(?:ing)?(?:\\s+date)?|tot(?:\\s+en\\s+met)?|einddatum)\\s*[:=]?\\s*(${DATE_RE})`,'i'));
  const startKind=quote=>/^(?:available\b|beschikbaar\b|vanaf\b|from\b)/i.test(quote)?'earliest':'fixed';
  if(from){listing.start_date=parseDate(from[1]);listing.start_kind=startKind(from[0]);listing.evidence.start_date=from[0];}
  if(until){listing.end_date=parseDate(until[1]);listing.evidence.end_date=until[0];}
  const range=body.match(new RegExp(`(${DATE_RE})\\s*(?:to|until|till|–|—|-|t/m|tot(?: en met)?)\\s*(${DATE_RE})`,'i'));
  if(range){listing.start_date=parseDate(range[1]);listing.start_kind='fixed';listing.end_date=parseDate(range[2]);listing.evidence.start_date=listing.evidence.end_date=range[0];}
  const sharedYear=body.match(new RegExp(`(?:from|vanaf|available|beschikbaar)\\s*(?:from\\s*)?[*_]*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?\\s*(?:to|until|till|–|—|-|t/m|tot(?: en met)?)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?\\s+(\\d{4})`,'i'));
  if(sharedYear){const sm=MONTHS[sharedYear[2].toLowerCase()],em=MONTHS[sharedYear[4].toLowerCase()],year=+sharedYear[5];listing.start_date=validDate(year-(sm>em?1:0),sm,+sharedYear[1]);listing.start_kind=startKind(sharedYear[0]);listing.end_date=validDate(year,em,+sharedYear[3]);listing.evidence.start_date=listing.evidence.end_date=sharedYear[0];}
  // A stated month/year is useful evidence without inventing an exact day.
  // Require availability wording so publication dates and viewing dates do not
  // become tenancy dates. Approximate day wording remains month precision.
  if(!listing.start_date){
    const monthStart=body.match(new RegExp(`(?:available\\b[^\\n.!?]{0,50}?\\b(?:from|on)|available|availability|start(?:ing)?(?:\\s+date)?|move[ -]?in|beschikbaar\\s+(?:vanaf|per)|ingangsdatum|vanaf|per)\\s*[:=]?\\s*(?:(?:early|mid|late|medio|begin|eind|beginning(?:\\s+of)?|end\\s+of)[ -]+)?(?:[~≈]?\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+)?(${MONTH_RE})\\.?(?:\\s*\\([^\\n)]{0,60}\\))?\\s+(\\d{4})\\b`,'i'));
    const context=monthStart?body.slice(Math.max(0,monthStart.index-35),monthStart.index+monthStart[0].length):'';
    if(monthStart&&!/\b(?:viewings?|bezichtig\w*|posted|publication|not available|niet beschikbaar)\b/i.test(context)){listing.start_month=`${monthStart[2]}-${String(MONTHS[monthStart[1].toLowerCase()]).padStart(2,'0')}`;listing.start_kind=startKind(monthStart[0]);listing.evidence.start_month=monthStart[0];}
  }
  const units='(months?|maand(?:en)?|years?|jaar)';
  const duration=body.match(new RegExp('(?:rental\\s+(?:period|duration)|huurperiode|huurduur|contract)\\s*[:=]?\\s*(?:(?:for|of|van)\\s+)?(\\d+)\\s*'+units+'\\b','i'));
  const maximum=body.match(new RegExp('(?:max(?:imum|imaal)?\\.?|up to|at most)\\s*(?:(?:stay|rental period|rental duration|huurduur|huurperiode)\\s*)?[:=]?\\s*(?:(?:of|van)\\s*)?(\\d+)\\s*'+units+'\\b','i'));
  const minimum=[...body.matchAll(new RegExp('(?:min(?:imum|imaal|imale)?\\.?|at least|ten minste)\\s*(?:(?:stay|rental period|rental duration|huurduur|huurperiode)\\s*)?[:=]?\\s*(?:(?:of|van)\\s*)?(\\d+)\\s*'+units+'\\b','gi'))].find(m=>!/^\s*(?:old|oud|of age|notice|opzeg)/i.test(body.slice(m.index+m[0].length)));
  const durationMonths=m=>+m[1]*(/^(?:year|jaar)/i.test(m[2])?12:1);
  if(duration&&!/(?:minimum|minimale|minimaal|maximum|maximale|maximaal)\s*$/i.test(body.slice(Math.max(0,duration.index-25),duration.index))){listing.max_stay_months=durationMonths(duration);listing.evidence.max_stay_months=duration[0];}
  if(duration&&/\b(?:we (?:will )?start with|we starten met|initially)\b/i.test(body.slice(Math.max(0,duration.index-42),duration.index))&&
     /\b(?:can (?:extend|renew)|kunnen we [^.!?\n]{0,45}verlengen)\b/i.test(body.slice(duration.index,duration.index+240))){
   listing.initial_stay_months=durationMonths(duration);
   listing.evidence.initial_stay_months=duration[0];
   listing.max_stay_months=null;
   delete listing.evidence.max_stay_months;
   listing.extraction_warnings.push('An initial stay is stated. Extension depends on a later agreement.');
  }
  if(maximum&&!/^\s*(?:notice|opzeg)/i.test(body.slice(maximum.index+maximum[0].length,maximum.index+maximum[0].length+35))){listing.max_stay_months=durationMonths(maximum);listing.evidence.max_stay_months=maximum[0];}
  if(minimum&&!/^\s*(?:notice|opzeg)/i.test(body.slice(minimum.index+minimum[0].length,minimum.index+minimum[0].length+35))){listing.min_stay_months=durationMonths(minimum);listing.evidence.min_stay_months=minimum[0];}
  if(/\b(?:indefinite|permanent contract|permanent tenancy|onbepaalde tijd)\b/i.test(body)&&!/\b(?:no|not|geen|niet)\s+(?:an?\s+)?(?:indefinite|permanent contract|permanent tenancy|onbepaalde tijd)\b/i.test(body))listing.indefinite=true;
  if(/\b(?:no students|students (?:are )?(?:not allowed|not accepted|excluded)|not (?:suitable|available|open) (?:for|to) students|geen studenten|studenten (?:niet toegestaan|uitgesloten))\b/i.test(body)) listing.student_allowed=false;
  else if(/\b(?:(?:ideal|suitable|perfect) for students|geschikt voor studenten|students (?:are )?(?:welcome|allowed|accepted)|student(?:s|en)? (?:housing|room)|geschikt voor studenten|studenten welkom|studentenkamer|(?:room|housing|accommodation|kamers?|woningen?) (?:only )?(?:for|voor) (?:bachelor )?(?:students?|studenten)|(?:full[ -]?time|voltijd)studenten?|(?:full[ -]?time\s+)?students only|ideal.{0,80}students|verhuurd aan.{0,50}studenten|(?:Dutch|international|Nederlandse|internationale).{0,20}studenten)\b/i.test(body)) listing.student_allowed=true;
  const advancedDegree=body.match(/\b(?:master'?s?\s*(?:students?)?\s*(?:or|and|\/)?\s*(?:phd|postdoc)|master'?s? students only|alleen masterstudenten|uitsluitend masterstudenten|no bachelor(?:'?s)? students|not (?:suitable|available) for bachelor(?:'?s)? students|geen bachelorstudenten|requirements?\s*[:–-]?\s*(?:being|be|must be)\s+(?:a )?master'?s? student|(?:looking for|must be)[^.!?\n]{0,65}\bmaster'?s? student\s*(?:&|and)\s*(?:at least|min(?:imum)?))\b/i);
  if(advancedDegree&&!/\b(?:preferably|preference|bij voorkeur|ideally)\b/i.test(body.slice(Math.max(0,advancedDegree.index-45),advancedDegree.index+advancedDegree[0].length))){
   listing.degree_restriction='postgraduate';listing.student_allowed=true;
   listing.evidence.degree_restriction=advancedDegree[0];
  }
  if(/\b(?:no registration(?! (?:fees|costs))|registration (?:is )?not (?:possible|allowed)|(?:you )?(?:can(?:not|'t|’t)|can not) register|geen inschrijving|inschrijven (?:is )?niet mogelijk|inschrijving niet mogelijk)\b/i.test(body)) listing.registration=false;
  else if(/\b(?:registration (?:is )?(?:possible|allowed|included)|inschrijven (?:is )?mogelijk|inschrijving mogelijk|mogelijkheid tot inschrijv(?:ing|en)|registration with the municipality (?:is )?possible)\b/i.test(body)) listing.registration=true;
  const requirements=[['Dutch',/(?:\bdutch[- ]speaking\s+(?:only|required)|\bdutch\s+(?:required|mandatory|speakers only)|\bonly dutch speakers|\bnederlandstalig(?:e)?\s+(?:huisgenoot|student)|\bnederlands spreken\s+(?:verplicht|vereist)|\balleen nederlandstalig)/i],['English',/\b(?:english[- ]speaking (?:only|required)|english (?:required|mandatory|speakers only))\b/i],['Portuguese',/\b(?:portuguese[- ]speaking (?:only|required)|portuguese (?:required|mandatory))\b/i]];
  for(const [language,re] of requirements) if(re.test(body)) listing.languages_required.push(language);
  const ageRange=body.match(/(?:age(?:d|s)?|leeftijd)\s*[:=]?\s*(\d{2})\s*[-–]\s*(\d{2})/i);
  if(ageRange) {listing.age_min=+ageRange[1];listing.age_max=+ageRange[2];}
  const ageMin=body.match(/(?:minimum age|minimale leeftijd|age(?:d)?|leeftijd)\s*[:=]?\s*(\d{2})\s*\+?|\b(\d{2})\s*\+\s*(?:years?(?: old)?|jaar(?: oud)?)|\b(?:at least|minimaal)\s+(\d{2})\s+(?:years? old|jaar oud)\b/i);
  if(ageMin){listing.age_min=+(ageMin[1]||ageMin[2]||ageMin[3]);listing.evidence.age_min=ageMin[0];}
  if(/\b(?:working professionals? only|working people only|alleen werkenden|uitsluitend werkenden)\b/i.test(body)) listing.working_only=true;
  const weekdays=body.match(/\b(?:weekdays only|only available on weekdays|you (?:must|have to) leave (?:on|at) weekends|in het weekend ga je (?:weer )?naar huis)\b/i);
  if(weekdays){listing.weekdays_only=true;listing.evidence.weekdays_only=weekdays[0];}
  if(/\b(?:female(?:s)? only|male(?:s)? only|women only|men only|only (?:female|male) (?:students?|tenants?|housemates?)|alleen (?:vrouwen|mannen|meisjes|jongens)|uitsluitend (?:vrouwen|mannen|meisjes|jongens))\b/i.test(body)) listing.household_restriction_unverified=true;
  if(/\b(?:no internationals|dutch (?:citizens|nationals) only|alleen nederlandse (?:studenten|huurders)|geen internationals)\b/i.test(body)) listing.international_excluded=true;
  if(/\b(?:guarantor|guarantee|garantsteller|garantstelling|borgsteller)\b/i.test(body)) listing.guarantor_mentioned=true;
  if(/(?:income|inkomen|salary|salaris).{0,45}(?:\d\s*[x×]|times|keer|minimum|minimaal)|(?:minimum|minimaal).{0,25}(?:income|inkomen|salary|salaris)/i.test(body)) listing.income_requirement=true;
  const areas=[...body.matchAll(/\b(\d{1,3}(?:[.,]\d+)?)\s*(?:m²|m2|sqm|square met(?:res|ers)|vierkante meters?)(?![\p{L}\p{N}])/giu)];
  const livingArea=areas.length===1?areas[0]:areas.find(a=>/^\s+(?:of living space|woonoppervlakte)\b/i.test(body.slice(a.index+a[0].length)));
  if(livingArea){listing.area_m2=Number(livingArea[1].replace(',','.'));listing.evidence.area_m2=excerpt(livingArea.index,livingArea[0].length);}
  const furnished=/(?<!not )\b(?:furnished|gemeubileerd)\b/i.test(body),unfurnished=/\b(?:unfurnished|not furnished|ongemeubileerd|zelf inrichten)\b/i.test(body);
  if(furnished||unfurnished){listing.furnished=furnished&&unfurnished?'conflicting':furnished?'furnished':'unfurnished';if(furnished&&unfurnished)listing.extraction_warnings.push('The advertisement contains conflicting furnished/unfurnished wording.');}
  for(const field of ['student_allowed','registration','indefinite','languages_required','income_requirement','degree_restriction','age_min','furnished']){if(listing[field]!=null&&(!Array.isArray(listing[field])||listing[field].length)){const key={student_allowed:/student/i,registration:/registr|inschr/i,indefinite:/indefinite|permanent|onbepaalde/i,languages_required:/speaking|speakers|required|verplicht|nederlandstalig/i,income_requirement:/income|inkomen|salary|salaris/i,degree_restriction:/master|phd|bachelor/i,age_min:/age|leeftijd|jaar oud/i,furnished:/furnished|gemeubileerd|zelf inrichten/i}[field];const match=body.match(key);if(match)listing.evidence[field]=excerpt(match.index,match[0].length);}}
  listing.extraction_version=2;
  const email=body.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/i);
  if(email) listing.contact_email=email[0];
  if(/\b(?:i(?:['’]m| am)|we(?:['’]re| are))\s+(?:still\s+)?(?:looking|searching)\s+for\s+(?:a\s+|an\s+|any\s+)?(?:room|studio|apartment|housing|accommodation)|\b(?:room|studio|apartment|housing) wanted\b|\b(?:ik|wij|we) (?:ben|zijn) op zoek naar (?:een )?(?:kamer|woning|appartement)\b/i.test(body.slice(0,800))) listing.wanted_ad=true;
  if(source==='facebook'&&/\b(?:for sale|te koop|asking price|vraagprijs)\b/i.test(body)&&!/\b(?:for rent|te huur|sublet(?:ting)?)\b/i.test(body.slice(0,300)))listing.sale_ad=true;
  if(source==='facebook'&&/^(?:[\s\p{S}]*)(?:looking|searching) for (?:an? )?(?:[^\n.!?]{0,50}\s)?(?:room|studio|apartment|housing|accommodation)\b/iu.test(body))listing.wanted_ad=true;
  if(listing.wanted_ad||listing.sale_ad){
   for(const key of ['rent_base','rent_total','rent_known_monthly_min','rent_excludes_bills','deposit']){listing[key]=null;delete listing.evidence[key];}
   listing.monthly_costs=[];listing.bills_missing=[];
  }
  return source==='facebook'?normalizeFacebookTerms(listing):listing;
}

export function applyEvidenceBackedFacts(listing) {
  const extraction=listing.ai?.state==='complete'?listing.ai.extraction:null;
  if(!extraction||extraction.version!==EXTRACTION_EVIDENCE_VERSION||!listing.fingerprint||extraction.fingerprint!==listing.fingerprint)return listing;
  const facts={},evidence={...listing.evidence};
  for(const [key,value] of Object.entries(extraction.fields||{})){
    if(Object.hasOwn(listing.owner_facts?.values||{},key))continue;
    if(listing[key]!=null&&!(Array.isArray(listing[key])&&!listing[key].length))continue;
    facts[key]=value;
    if(extraction.evidence?.[key])evidence[key]=extraction.evidence[key];
  }
  return {...listing,...facts,evidence};
}

export function evaluateListing(listing,profile=DEFAULT_PROFILE) {
  const p={...DEFAULT_PROFILE,...profile};
  const l=applyEvidenceBackedFacts(listing||{}); const reasons=[]; const questions=[];
  const reject=message=>reasons.push(message); const review=message=>questions.push(message);
  if(l.availability==='unavailable')reject('The original source no longer lists this property as available.');
  if(l.end_date&&parseDate(l.end_date)&&l.end_date<p.start_min)reject('The advertised tenancy ends before the earliest approved move-in date.');
  if(l.collection_only&&l.availability!=='available')review('Confirm that this housing offer is still available.');
  if(l.source_evidence_ambiguous===true) review('Original property terms are not fully established; the collector must verify the individual listing before applying.');
  if(l.source_detail_pending===true)review('The listing index changed. A fresh check of the full advertisement is pending.');
  if(l.wanted_ad) reject('This post is seeking housing.');
  if(l.sale_ad) reject('The property is advertised for sale.');
  if(l.city && l.city.toLowerCase()!==p.city.toLowerCase()) reject(`The listing is outside ${p.city}.`);
  else if(!l.city) review('Confirm that the property is in Delft.');
  if(number(l.rent_total)) {
    if(l.rent_total>p.max_rent_total) reject(`All-in rent exceeds €${p.max_rent_total}/month.`);
    if(l.rent_excludes_bills===true) review('The stated total conflicts with excluded bills; confirm the all-in rent.');
  } else {
    if(number(l.rent_base)&&l.rent_base>p.max_rent_total) reject(`Base rent already exceeds €${p.max_rent_total}/month.`);
    if(number(l.rent_known_monthly_min)&&l.rent_known_monthly_min>p.max_rent_total)reject(`The known rent and mandatory monthly charges already exceed €${p.max_rent_total}/month.`);
    review(l.bills_missing?.length?`Confirm the cost of the explicitly excluded ${l.bills_missing.join(', ')}; the known monthly subtotal is ${number(l.rent_known_monthly_min)?'€'+l.rent_known_monthly_min:'not established'}.`:'Confirm total monthly rent including mandatory bills and charges.');
  }
  const periods=Array.isArray(l.availability_periods)?l.availability_periods.filter(period=>
   period&&(period.start===null||parseDate(period.start))&&(period.end===null||parseDate(period.end))&&
   (!period.start||!period.end||period.start<=period.end)):[];
  if(periods.length){
   const viable=periods.some(({start,end})=>{
    const moveIn=start&&start>p.start_min?start:p.start_min;
    return moveIn<=p.start_max&&(!end||end>=addMonths(moveIn,p.min_stay_months));
   });
   if(!viable)reject(`No advertised availability window supports a ${p.min_stay_months}-month stay from your dates.`);
   else if(!periods.some(({start,end})=>{const moveIn=start&&start>p.start_min?start:p.start_min;return start&&moveIn<=p.start_max&&(!end||end>=addMonths(moveIn,p.min_stay_months));}))review('Confirm that the open calendar period starts within your move-in window.');
  } else if(l.start_date && parseDate(l.start_date)) {
    if(l.start_date>p.start_max||l.start_date<p.start_min&&l.start_kind!=='earliest')reject(`The stated tenancy start falls outside the approved ${p.start_min} to ${p.start_max} window.`);
    else if(l.start_date<p.start_min)review('Available earlier. Confirm the landlord accepts a move-in within your dates.');
  } else if(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(l.start_month||'')){
    const [year,month]=l.start_month.split('-').map(Number);const first=l.start_month+'-01';const last=l.start_month+'-'+new Date(Date.UTC(year,month,0)).getUTCDate();
    if(first>p.start_max||last<p.start_min&&l.start_kind!=='earliest')reject(`The stated move-in month (${l.start_month}) falls outside the approved ${p.start_min} to ${p.start_max} window.`);
    else if(last<p.start_min)review('Available earlier. Confirm the landlord accepts a move-in within your dates.');
    else review(`Confirm the exact move-in day within the stated ${l.start_month} month.`);
  } else review('Confirm the full tenancy start date, including year.');
  if(number(l.max_stay_months)&&l.max_stay_months<p.min_stay_months) reject(`The advertised maximum stay is shorter than ${p.min_stay_months} months.`);
  const earliestStart=l.start_date&&parseDate(l.start_date)&&l.start_date>p.start_min?l.start_date:p.start_min;
  const end=l.end_date&&parseDate(l.end_date);
  if(!periods.length&&end&&end<addMonths(earliestStart,p.min_stay_months))reject(`The tenancy ends too soon for a ${p.min_stay_months}-month stay from your move-in window.`);
  else if(!(end&&l.start_date) && !(number(l.max_stay_months)&&l.max_stay_months>=p.min_stay_months) && !(number(l.min_stay_months)&&l.min_stay_months>=p.min_stay_months) && l.indefinite!==true)review(`Confirm that a stay of at least ${p.min_stay_months} months is available.`);
  if(l.student_allowed===false) reject('Students are explicitly excluded.');
  else if(l.student_allowed!==true) review('Confirm that a bachelor student is accepted.');
  if(l.degree_restriction==='postgraduate') reject('The listing restricts applicants to postgraduate students.');
  if(l.working_only===true) reject('The listing is restricted to working applicants.');
  if(l.weekdays_only===true) reject('The room is available on weekdays only.');
  if(l.international_excluded===true) reject('The listing explicitly excludes international applicants or requires Dutch nationality.');
  if(l.household_restriction_unverified===true) review('Verify the explicitly stated household restriction against facts you have chosen to supply; do not infer eligibility from your name.');
  if(number(l.age_min)&&number(p.age_at_move_in)&&p.age_at_move_in<l.age_min) reject(`Minimum age is ${l.age_min}; profile age at move-in is ${p.age_at_move_in}.`);
  if(number(l.age_max)&&number(p.age_at_move_in)&&p.age_at_move_in>l.age_max) reject(`Maximum age is ${l.age_max}.`);
  if(Array.isArray(l.languages_required)&&Array.isArray(p.languages)) {
    for(const lang of l.languages_required) if(!p.languages.some(x=>x.toLowerCase()===String(lang).toLowerCase())) reject(`The listing requires ${lang}; this language is not in the approved profile.`);
  } else if(l.languages_required?.length || !Array.isArray(l.languages_required)) review('Check the listing’s language requirements.');
  if(l.income_requirement===true) review('Verify the stated income requirement; parental support is not automatically qualifying income.');
  if(l.guarantor_mentioned===true&&!p.guarantor_confirmed) review('Confirm whether the required parental guarantee can be provided and accepted.');
  if(number(l.min_stay_months)&&number(l.max_stay_months)&&l.min_stay_months>l.max_stay_months) review('Minimum and maximum rental periods conflict.');
  if(l.registration===false) {
    if(p.registration_required===true) reject('Address registration is unavailable.');
    else review('Address registration is unavailable; clarify whether this meets your needs before applying.');
  }
  if(p.registration_required===true&&l.registration==null)review('Confirm that municipal address registration is allowed.');
  for(const warning of l.extraction_warnings||[]) review(warning);
  return {status:reasons.length?'rejected':questions.length?'review':'eligible',reasons,questions};
}

/** Re-read stored source text without network or AI. Structured source fields
 * absent from prose remain intact; parser mistakes never overwrite new evidence.
 * Current owner review/fact overlays remain the caller's responsibility.
 */
export function reparseListingEvidence(old,profile=DEFAULT_PROFILE){
 const parsed=parseListingText(old.body||'',old.source,old.url);const merged={...old,...parsed,title:old.title||parsed.title};
  const structuredFields=['city','rent_base','rent_total','rent_excludes_bills','start_date','start_month','end_date','student_allowed','registration','age_min','age_max','indefinite','degree_restriction','working_only','international_excluded','income_requirement','guarantor_mentioned','household_restriction_unverified','area_m2','deposit','furnished'];
 for(const key of structuredFields)if(parsed[key]==null&&old[key]!=null)merged[key]=old[key];
 if(!parsed.languages_required?.length&&old.languages_required?.length)merged.languages_required=old.languages_required;
 if(parsed.min_stay_months==null&&old.min_stay_months!=null)merged.min_stay_months=old.min_stay_months;
 if(parsed.max_stay_months==null&&parsed.min_stay_months==null&&old.max_stay_months!=null)merged.max_stay_months=old.max_stay_months;
 // Repeated generic source warning used by the old ROOM extractor is obsolete.
 const sourceWarnings=(old.extraction_warnings||[]).filter(w=>/structured|account-specific/i.test(w)&&!w.includes('and every mandatory monthly charge'));
 merged.extraction_warnings=[...new Set([...parsed.extraction_warnings,...sourceWarnings])];
 merged.evidence={...(old.evidence||{}),...parsed.evidence};
 if(!parsed.monthly_costs.length&&old.monthly_costs?.length)merged.monthly_costs=old.monthly_costs;
 if(old.source==='roommatch'&&Number.isFinite(old.rent_advertised_total))merged.rent_known_monthly_min=old.rent_advertised_total;
 else if(parsed.rent_known_monthly_min==null&&Number.isFinite(merged.rent_base))merged.rent_known_monthly_min=merged.rent_base;
 merged.extraction_version=old.property_details_checked?1:2;
 merged.assessment=evaluateListing(merged,profile);merged.status=merged.assessment.status;merged.ai=null;
 return merged;
}

export function draftIntroduction(listing={},profile=DEFAULT_PROFILE) {
  const p={...DEFAULT_PROFILE,...profile};
  const property=String(listing.title||'your property').replace(/[\r\n\t]/g,' ').slice(0,120);
  const day=value=>new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}T00:00:00Z`));
  const month=value=>new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}T00:00:00Z`));
  return `Hi, I’m ${p.name}, a ${p.university} ${p.programme} student. I’m interested in ${property} and am looking for a tenancy starting between ${day(p.start_min)} and ${day(p.start_max)}. I’d ideally stay through ${month(p.preferred_end)}, with a minimum stay of ${p.min_stay_months} months.${p.parents_pay ? '\n\nMy parents will cover my rent.' : ''}\n\nIs the property available for that period? I’d be happy to introduce myself further or arrange a viewing.\n\nBest,\n${p.name}`;
}
