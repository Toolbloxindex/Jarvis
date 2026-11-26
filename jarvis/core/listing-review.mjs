import {createHash} from 'node:crypto';
import {applyEvidenceBackedFacts,evaluateListing,DEFAULT_PROFILE} from './matcher.mjs';
import {presentPhotos} from './photos.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const SOURCE_FACT_KEYS=Object.freeze(['title','body','rent_total','rent_base','rent_excludes_bills','rent_known_monthly_min','monthly_costs','bills_missing','start_date','start_month','end_date','min_stay_months','max_stay_months','indefinite','student_allowed','registration','languages_required','age_min','age_max','degree_restriction','working_only','international_excluded','household_restriction_unverified','income_requirement','guarantor_mentioned','extraction_warnings','property_details_checked','source_evidence_ambiguous','availability','area_m2','furnished','deposit','evidence']);
const ADDITIONAL_SOURCE_FACTS=['city','start_kind','availability_periods','rent_advertised_total','included_costs','excluded_costs','one_time_costs','application_closes_at','contract_type','wanted_ad','sale_ad','listing_kind','source_preferences','estimated_monthly_total','rental_options_text','rent_after_allowance_text','initial_stay_months','weekdays_only','couples_allowed','pets_allowed'];
export const CHECKED_SOURCE_FACTS=Object.freeze([...SOURCE_FACT_KEYS,...ADDITIONAL_SOURCE_FACTS]);
export function sourceFingerprint(listing){return hash(CHECKED_SOURCE_FACTS.map(key=>[key,listing[key]??null]));}
export function profileFingerprint(profile=DEFAULT_PROFILE){const p={...DEFAULT_PROFILE,...profile};return hash(Object.keys(p).sort().map(key=>[key,p[key]]));}
export function sourceValues(listing){return {...listing,...(listing.owner_facts?.sourceValues||{})};}
export function sourceIsStale(listing,now=Date.now()){return listing.discovery===true&&(!Number.isFinite(Date.parse(listing.last_seen_at||''))||now-Date.parse(listing.last_seen_at)>86400000);}
export function reviewValidity(listing,profile=DEFAULT_PROFILE,now=Date.now()){
 const r=listing.owner_review;if(!r)return {valid:false,staleReason:null};
 if(r.fingerprint!==listing.fingerprint)return {...r,valid:false,staleReason:'The source evidence changed.'};
 if(r.profileFingerprint!==profileFingerprint(profile))return {...r,valid:false,staleReason:'Your search criteria changed.'};
 if(r.factsFingerprint!==hash(listing.owner_facts?.values||{}))return {...r,valid:false,staleReason:'The confirmed facts changed.'};
 if(listing.availability==='unavailable')return {...r,valid:false,staleReason:'The property is no longer available.'};
 if(r.decision==='approved'&&sourceIsStale(listing,now))return {...r,valid:false,staleReason:'Source evidence is over 24 hours old or has not been refreshed.'};
 if(r.decision==='approved'&&evaluateListing(listing,profile).status==='rejected')return {...r,valid:false,staleReason:'The listing conflicts with your search criteria.'};
 return {...r,valid:true,staleReason:null};
}
const money=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n);
const known=n=>typeof n==='number'&&Number.isFinite(n);
const date=value=>{const n=new Date(value+'T00:00:00Z');return Number.isFinite(n.valueOf())?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(n):value;};
const evidenceKeys=key=>key==='duration'?['min_stay_months','max_stay_months','indefinite']:key==='age'?['age_min','age_max']:[key];
const ownerConfirmed=(listing,key)=>evidenceKeys(key).some(k=>Object.hasOwn(listing.owner_facts?.values||{},k));
function excerpt(listing,key,pattern){
 if(ownerConfirmed(listing,key))return 'Confirmed by you'+(listing.owner_facts.note?': '+listing.owner_facts.note:'.');
 const evidence=evidenceKeys(key).map(k=>listing.evidence?.[k]).find(v=>typeof v==='string'&&v.trim());if(typeof evidence==='string'&&evidence.trim())return evidence.slice(0,320);
 const paragraphs=String(listing.body||'').split(/\n+|(?<=[.!?])\s+/);return paragraphs.find(p=>pattern?.test(p))?.trim().slice(0,280)||undefined;
}
function issueLabel(question){
 if(/exact move-in day/i.test(question))return 'Exact move-in day needs confirmation';
 if(/total monthly rent|all-in rent|mandatory monthly charge/i.test(question))return 'All-in monthly cost needs confirmation';
 if(/full tenancy start date|start date.*year/i.test(question))return 'Start date or year is missing';
 if(/stay of at least|rental period|tenancy length/i.test(question))return 'Minimum tenancy length is not established';
 if(/bachelor student|student.*accepted/i.test(question))return 'Bachelor-student eligibility needs confirmation';
 if(/still available|availability/i.test(question))return 'Current availability needs confirmation';
 if(/original property terms|full.*listing|full.*advertisement|complete advertisement|original description/i.test(question))return 'Complete source description needs checking';
 if(/income requirement/i.test(question))return 'Income requirement needs checking';
 if(/parental guarantee|guarantor/i.test(question))return 'Guarantor acceptance needs checking';
 return question;
}
function answered(question,l,profile){
 if(/total monthly rent including|confirm.*all-in rent/i.test(question))return known(l.rent_total)&&l.rent_excludes_bills!==true;
 if(/full tenancy start date, including year/i.test(question))return /^\d{4}-\d{2}-\d{2}$/.test(l.start_date||'');
 if(/exact move-in day/i.test(question))return /^\d{4}-\d{2}-\d{2}$/.test(l.start_date||'');
 if(/stay of at least/i.test(question))return l.indefinite===true||known(l.min_stay_months)&&l.min_stay_months>=(profile?.min_stay_months??12)||known(l.max_stay_months)&&l.max_stay_months>=(profile?.min_stay_months??12)||!!(l.start_date&&l.end_date);
 if(/bachelor student is accepted/i.test(question))return l.student_allowed===true&&!l.degree_restriction;
 if(/property is in Delft/i.test(question))return /^delft$/i.test(l.city||'');
 if(/still available/i.test(question))return l.availability==='available';
 return false;
}
export function reviewSummary(listing,profile=DEFAULT_PROFILE){
 const l=listing;const facts=[];const add=(key,label,value,pattern)=>{if(value!==null&&value!==undefined&&value!=='')facts.push({key,label,value:String(value),evidence:excerpt(l,key,pattern),confirmedByOwner:ownerConfirmed(l,key)});};
 add('rent_total','All-in / month',known(l.rent_total)?money(l.rent_total):null,/all.?in|inclusief|including|total.*rent/i);
 add('rent_base','Base rent / month',known(l.rent_base)?money(l.rent_base):null,/rent|huur|price|prijs/i);
 add('rent_known_monthly_min','Known monthly minimum',known(l.rent_known_monthly_min)&&!known(l.rent_total)?money(l.rent_known_monthly_min):null,/service|heating|rent|huur|cost|kosten/i);
 add('estimated_monthly_total','Estimated total / month',known(l.estimated_monthly_total)?money(l.estimated_monthly_total):null);
 if(Array.isArray(l.monthly_costs))for(const [i,cost]of l.monthly_costs.entries())if(known(cost.amount))facts.push({key:'monthly_costs.'+i,label:cost.label||'Monthly charge',value:money(cost.amount)+(cost.conditional?' if applicable':cost.estimated?' estimated / month':' / month'),evidence:typeof cost.evidence==='string'?cost.evidence.slice(0,320):undefined});
 add('rent_excludes_bills','Bills',l.rent_excludes_bills===true?'Excluded / added separately':l.rent_excludes_bills===false?'Included':null,/includ|exclud|inclusief|exclusief|gas|water|electri|internet/i);
 if(l.bills_missing?.length)add('bills_missing','Excluded costs',l.bills_missing.join(', '),/exclud|exclusief/i);
 add('start_date',l.start_kind==='fixed'?'Tenancy starts':'Available from',l.start_date?date(l.start_date):null,/available|beschikbaar|vanaf|start|per /i);
 if(!l.start_date&&/^\d{4}-(?:0[1-9]|1[0-2])$/.test(l.start_month||''))add('start_month','Move-in month',new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(l.start_month+'-01T00:00:00Z'))+' · exact day unconfirmed',/available|beschikbaar|vanaf|start|per /i);
 add('end_date','Available until',l.end_date?date(l.end_date):null,/until|tot |end|eind/i);
 if(Array.isArray(l.availability_periods)&&l.availability_periods.length)add('availability_periods','Calendar windows',l.availability_periods.map(period=>`${period.start?date(period.start):'Start not stated'} – ${period.end?date(period.end):'No end shown'}`).join(' · '));
 const duration=l.indefinite===true?'Indefinite':known(l.min_stay_months)&&known(l.max_stay_months)?`${l.min_stay_months}–${l.max_stay_months} months`:known(l.min_stay_months)?`At least ${l.min_stay_months} months`:known(l.max_stay_months)?`Up to ${l.max_stay_months} months`:null;
 add('duration','Tenancy',duration,/month|maand|year|jaar|indefinite|onbepaalde/i);
 if(known(l.initial_stay_months))add('initial_stay_months','Initial term',l.initial_stay_months+' months');
 if(l.weekdays_only)add('weekdays_only','Occupancy','Weekdays only');
 add('student_allowed','Students',l.student_allowed===true?'Accepted':l.student_allowed===false?'Excluded':null,/student|bachelor|master|promov/i);
 add('registration','Registration',l.registration===true?'Allowed':l.registration===false?'Not available':null,/registration|register|inschrij|inschrijf/i);
 add('languages_required','Required language',Array.isArray(l.languages_required)&&l.languages_required.length?l.languages_required.join(', '):null,/English|Dutch|Nederlands|language|spreek/i);
 add('availability','Availability',l.availability==='available'?'Shown as available':l.availability==='unavailable'?'Unavailable':null,/available|beschikbaar|verhuurd|rented/i);
 add('area_m2','Area',known(l.area_m2)?`${l.area_m2} m²`:null,/m²|m2|square|vierkante/i);
 add('furnished','Furnishing',l.furnished===true?'Furnished':l.furnished===false?'Unfurnished':typeof l.furnished==='string'?l.furnished:null,/furnish|gemeubileerd|gestoffeerd/i);
 add('deposit','Deposit',known(l.deposit)?money(l.deposit):typeof l.deposit==='string'?l.deposit:null,/deposit|borg/i);
 if(l.rental_options_text)add('rental_options_text','Advertised options',l.rental_options_text);
 if(l.rent_after_allowance_text)add('rent_after_allowance_text','Price after allowance',l.rent_after_allowance_text);
 if(Array.isArray(l.one_time_costs))for(const [i,cost] of l.one_time_costs.entries())if(known(cost.amount))facts.push({key:'one_time_costs.'+i,label:cost.label||'One-time charge',value:money(cost.amount),evidence:cost.evidence});
 if(l.included_costs?.length)add('included_costs','Included costs',l.included_costs.join(', '));
 if(l.excluded_costs?.length&&!l.bills_missing?.length)add('excluded_costs','Extra costs',l.excluded_costs.join(', '));
 if(l.contract_type)add('contract_type','Contract',l.contract_type);
 if(l.application_closes_at)add('application_closes_at','Response deadline',l.application_closes_at.slice(0,10));
 if(known(l.age_min)||known(l.age_max))add('age','Age requirement',[known(l.age_min)?`Minimum ${l.age_min}`:null,known(l.age_max)?`maximum ${l.age_max}`:null].filter(Boolean).join(', '),/age|jaar oud|leeftijd/i);
 if(l.degree_restriction)add('degree_restriction','Study restriction',l.degree_restriction,/master|postgraduate|bachelor|phd/i);
 if(l.income_requirement)add('income_requirement','Income requirement','Stated in the listing',/income|salary|inkomen|salaris/i);
 const assessment=evaluateListing(l,profile);const sourceComplete=l.property_details_checked!==false&&l.source_evidence_ambiguous!==true;
 const questions=(assessment.questions||[]).filter(q=>!answered(q,l,profile));
 const issues=[];if(l.listing_kind==='general_lead')return {facts,issues:[{key:'general_lead',label:'General housing promotion, not an individual property advertisement.',kind:'access'}],sourceComplete};const seen=new Set();for(const question of [...(assessment.reasons||[]),...questions]){const label=issueLabel(question);if(seen.has(label))continue;seen.add(label);const conflict=(assessment.reasons||[]).includes(question)||/conflict|exceeds|outside|restrict|excluded|shorter/i.test(question);const access=/account-specific|source|collector|original|complete.*advertisement|full.*listing/i.test(question);issues.push({key:'issue-'+issues.length,label,kind:conflict?'conflict':access?'access':'missing'});}
 return {facts,issues,sourceComplete};
}
export function presentListing(listing,profile=DEFAULT_PROFILE,now=Date.now()){
 listing=applyEvidenceBackedFacts(listing);
 if(listing.ai?.analysis&&Object.hasOwn(listing.ai.analysis,'summary')){
  const analysis={...listing.ai.analysis};
  delete analysis.summary;
  listing={...listing,ai:{...listing.ai,analysis}};
 }
 if(listing.source_detail_pending){
  const assessment=evaluateListing(listing,profile);
  listing={...listing,assessment,status:assessment.status};
 }
 return {...listing,photos:presentPhotos(listing),owner_review:listing.owner_review?reviewValidity(listing,profile,now):null,review_summary:reviewSummary(listing,profile),source_stale:sourceIsStale(listing,now)};
}
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function verifyRevision(listing,fingerprint){if(!listing)throw fail(404,'Listing not found.');if(typeof fingerprint!=='string'||fingerprint!==listing.fingerprint)throw fail(409,'This listing changed. Refresh it and review the current evidence.');}
function noteText(note){if(note===undefined)return '';if(typeof note!=='string'||note.length>2000||note.includes('\0'))throw fail(400,'Keep the review note under 2,000 characters.');return note.trim();}
export function decideListingReview(listing,input,{profile=DEFAULT_PROFILE,now=Date.now()}={}){
 verifyRevision(listing,input.fingerprint);if(!['approved','dismissed','reset'].includes(input.decision))throw fail(400,'Choose save, pass or restore.');
 const note=noteText(input.note===undefined?listing.owner_review?.note:input.note);if(input.decision==='reset')return null;
 // Legacy wire decisions now describe local Save/Pass preferences. A bookmark
 // cannot change eligibility or permission to contact anyone. Retain it even if
 // the source becomes stale, unavailable or unsuitable; present validity apart.
 return {decision:input.decision,fingerprint:listing.fingerprint,profileFingerprint:profileFingerprint(profile),factsFingerprint:hash(listing.owner_facts?.values||{}),at:new Date(now).toISOString(),note};
}
const EDITABLE=new Set(['rent_total','rent_base','rent_excludes_bills','start_date','end_date','min_stay_months','max_stay_months','indefinite','student_allowed','registration','languages_required','availability']);
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function confirmListingFacts(listing,input,{profile=DEFAULT_PROFILE,now=Date.now()}={}){
 verifyRevision(listing,input.fingerprint);const values=input.values;if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length)throw fail(400,'Change at least one listing fact.');
 const clean={};for(const [key,value]of Object.entries(values)){
  if(!EDITABLE.has(key))throw fail(400,'This listing field cannot be edited.');
  if(value===null){if(key==='availability'||key==='languages_required')throw fail(400,'Choose an availability value or language list.');clean[key]=null;continue;}
  if(['rent_total','rent_base'].includes(key)&&(!known(value)||value<0||value>10000))throw fail(400,'Monthly rent must be a number from 0 to 10,000.');
  if(['min_stay_months','max_stay_months'].includes(key)&&(!Number.isInteger(value)||value<1||value>120))throw fail(400,'Tenancy duration must be 1–120 months.');
  if(['start_date','end_date'].includes(key)&&!validDate(value))throw fail(400,'Use a real date including the year.');
  if(['rent_excludes_bills','indefinite','student_allowed','registration'].includes(key)&&typeof value!=='boolean')throw fail(400,'Choose yes, no or unknown.');
  if(key==='languages_required'&&(!Array.isArray(value)||value.length>10||value.some(v=>typeof v!=='string'||!/^\p{L}[\p{L} -]{0,59}$/u.test(v))))throw fail(400,'Enter language names only.');
  if(key==='availability'&&!['unconfirmed','available','unavailable'].includes(value))throw fail(400,'Choose a valid availability status.');
  clean[key]=key==='languages_required'?[...new Set(value.map(v=>v.trim()))]:value;
 }
 if(Object.hasOwn(clean,'rent_base'))clean.rent_known_monthly_min=known(clean.rent_base)?Math.round((clean.rent_base+(listing.monthly_costs||[]).filter(c=>!c.conditional&&known(c.amount)).reduce((sum,c)=>sum+c.amount,0))*100)/100:null;
 const original=sourceValues(listing);const baseValues={...(listing.owner_facts?.sourceValues||{})};for(const key of Object.keys(clean))if(!Object.hasOwn(baseValues,key))baseValues[key]=original[key]??null;
 const owner_facts={fingerprint:listing.fingerprint,values:{...(listing.owner_facts?.values||{}),...clean},sourceValues:baseValues,at:new Date(now).toISOString(),note:input.note===undefined?(listing.owner_facts?.note||''):noteText(input.note)};
 const candidate={...listing,...owner_facts.values};if(candidate.start_date&&candidate.end_date&&candidate.end_date<candidate.start_date)throw fail(400,'End date must follow the start date.');if(known(candidate.min_stay_months)&&known(candidate.max_stay_months)&&candidate.min_stay_months>candidate.max_stay_months)throw fail(400,'Minimum duration cannot exceed maximum duration.');
 if(known(candidate.rent_total)&&known(candidate.rent_base)&&candidate.rent_total<candidate.rent_base)throw fail(400,'All-in rent cannot be below base rent. Correct both fields if the source price was misread.');
 const assessment=evaluateListing(candidate,profile);return {...clean,owner_facts,owner_review:listing.owner_review??null,assessment,status:assessment.status,ai:null};
}
