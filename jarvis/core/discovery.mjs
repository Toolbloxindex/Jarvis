import { listingTravelKey } from './travel.mjs';
import { isDeepStrictEqual } from 'node:util';
import {parse,parseFragment} from 'parse5';
import {setTimeout as delay} from 'node:timers/promises';
import {parseListingText,evaluateListing,draftIntroduction,DEFAULT_PROFILE} from './matcher.mjs';
import {normalizePhotos} from './photos.mjs';
import {matchesHousingAnywhereEntity,housingAnywhereTitle,normalizeHousingAnywhere} from './discovery-housinganywhere.mjs';
import {applyRoomTerms,applyAgencyTerms} from './discovery-room-agents.mjs';
import {normalizeKamernetIndex,normalizeKamernetDetail} from './discovery-kamernet.mjs';

export const SOURCES=Object.freeze([
 {id:'kamernet',name:'Kamernet',origin:'https://kamernet.nl',kind:'next',indexes:['/en/for-rent/room-delft?radius=1','/en/for-rent/studio-delft?radius=1','/en/for-rent/apartment-delft?radius=1'],detail:/^\/en\/for-rent\/(?:room|studio|apartment)-delft\/[^/]+\/(?:room|studio|apartment)-\d+$/i,contact:'Paid contact access is held; no subscription will be purchased.'},
 {id:'housinganywhere',name:'HousingAnywhere',origin:'https://housinganywhere.com',kind:'html',indexes:['/s/Delft--Netherlands'],detail:/^\/room\/[^/]+\/nl\/Delft\//i,description:'descriptionContainer',contact:'Dutch landlord messaging requires a paid subscription and is disabled. Public tracking continues without purchase.'},
 {id:'roommatch',name:'ROOMMATCH / DUWO',origin:'https://www.roommatch.nl',kind:'room',apiOrigin:'https://roommatching-aanbodapi.zig365.nl',indexes:['https://roommatching-aanbodapi.zig365.nl/api/v1/actueel-aanbod?limit=100&page=0'],detail:/^\/aanbod\/studentenwoningen\/details\b/,contact:'Use the existing ROOM account; no automatic applications are verified.'},
 {id:'funda',name:'Funda',origin:'https://www.funda.nl',kind:'html',indexes:['/zoeken/huur?selected_area=delft'],detail:/^\/detail\/huur\/delft\//,contact:'Automatic contact route unverified.'},
 {id:'pararius',name:'Pararius',origin:'https://www.pararius.com',kind:'html',indexes:['/apartments/delft'],detail:/^\/(?:apartment|studio|room)-for-rent\/delft\//,contact:'Automatic contact route unverified.'},
 {id:'bjornd',name:'Björnd Makelaardij',origin:'https://www.bjornd.nl',kind:'agent',indexes:['/nl/realtime-listings/consumer'],detail:/^\/nl\/woningaanbod\/details\//,description:'tab-omschrijving',contact:'Agent contact route unverified.'},
 {id:'verra',name:'Verra Makelaars',origin:'https://www.verra.nl',kind:'agent',indexes:['/nl/realtime-listings/consumer'],detail:/^\/nl\/woningaanbod\/woning\/delft\//,description:'tab-omschrijving',contact:'Agent contact route unverified.'},
 {id:'huizenbalie',name:'Huizenbalie',origin:'https://huizenbalie.nl',kind:'html',indexes:['/property-status/te-huur/'],detail:/^\/woning\/[^/]+-delft(?:-\d+)?\/$/i,description:'property-content',contact:'Agent contact route unverified.'},
 {id:'facebook',name:'Facebook groups',origin:'https://www.facebook.com',kind:'account',indexes:[],contact:'Owner allows housing-listing collection only. No joining, reactions, posts, messages or account changes are permitted.'}
]);
const attrs=(n,k)=>n.attrs?.find(a=>a.name===k)?.value||'';
const walk=(n,fn)=>{fn(n);for(const c of n.childNodes||[])walk(c,fn);};
const skip=new Set(['script','style','nav','footer','noscript','svg','form','button']);
const blocks=new Set(['p','div','section','li','tr','br','h1','h2','h3','dt','dd']);
export const plain=n=>n.nodeName==='#text'?n.value:skip.has(n.tagName)?'':(n.childNodes||[]).map(plain).join(blocks.has(n.tagName)?'\n':' ');
const tidy=s=>s.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
const decode=s=>tidy(plain(parseFragment(String(s||''))));
function nodes(doc,fn){const out=[];walk(doc,n=>{if(fn(n))out.push(n);});return out;}
function scriptJSON(doc,id){const n=nodes(doc,n=>n.tagName==='script'&&attrs(n,'id')===id)[0];return n?JSON.parse((n.childNodes||[]).map(x=>x.value||'').join('')):null;}
// Parse a JSON-like hydration object without evaluating page JavaScript.
export function preloadedState(html){
 try{const match=/window\.__PRELOADED_STATE__\s*=\s*/.exec(html);if(!match)return null;const rest=html.slice(match.index+match[0].length).replace(/^\(+/,'');if(rest[0]!=='{')return null;let depth=0,quoted=false,escaped=false,end=0;
  for(let i=0;i<rest.length;i++){const c=rest[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&!--depth){end=i+1;break;}}
  if(!end)return null;const data=rest.slice(0,end).replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g,m=>m==='undefined'?'null':m);return JSON.parse(data);
 }catch{return null;}
}
export function challengePage(html){return /<title[^>]*>[^<]*(?:just a moment|access denied|almost there|je bent bijna|attention required)/i.test(html)||/cf-chl-|captcha-delivery\.com|id=["']px-captcha/i.test(html);}
export function allowedURL(source,value){try{
 const u=new URL(value,source.origin);
 if(u.origin!==source.origin||u.username||u.password||!source.detail.test(u.pathname))return null;
 u.hash='';
 if(source.id==='housinganywhere')u.search='';
 return u.href;
}catch{return null;}}
function date(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(0,10):null;}
function roomLocation(offer){
 const lat=offer.latitude,lng=offer.longitude;
 const postcode=/^[1-9]\d{3}\s?[A-Z]{2}$/i.test(offer.postalcode||'')?offer.postalcode.toUpperCase():'';
 return Number.isFinite(lat)&&Math.abs(lat-52)<0.2&&Number.isFinite(lng)&&Math.abs(lng-4.36)<0.3
  ? {lat,lng,precision:'postcode',postcode,street:offer.street||''} : null;
}
export function parseIndex(source,html,url){
 if(challengePage(html))throw Object.assign(new Error('The site returned a browser verification challenge.'),{status:'blocked'});
 if(source.kind==='room'){
  const response=JSON.parse(html);if(!Array.isArray(response.data)||!response._metadata)throw new Error('ROOMMATCH public feed format changed.');
  const meta=response._metadata;const current=Number(meta.page)||0;const next=[];
  if(current+1<Number(meta.page_count)){const u=new URL(url);u.searchParams.set('page',current+1);next.push(u.href);}
  const candidates=response.data.filter(x=>/^delft$/i.test(x.city?.name||'')&&x.rentBuy==='Huur'&&!x.toewijzingIsGeannuleerd&&x.isGepubliceerd!==false).map(x=>({url:source.origin+'/aanbod/studentenwoningen/details?dwellingID='+encodeURIComponent(x.id),title:[x.street,x.houseNumber,x.houseNumberAddition,'Delft'].filter(Boolean).join(' '),city:'Delft',address:x.street?[x.street,[x.houseNumber,x.houseNumberAddition].filter(Boolean).join('-')].filter(Boolean).join(' '):null,rent_base:x.netRent,start_date:date(x.availableFromDate),end_date:date(x.availableTillDate),indexStamp:JSON.stringify([x.totalRent,x.availableFromDate,x.availableTillDate,x.closingDate]),inlineProperty:x}));
  return {candidates,complete:next.length===0,next,total:meta.total_search_count};
 }
 if(source.kind==='agent'){
  const all=JSON.parse(html);if(!Array.isArray(all)||all.length&&(!('isRentals'in all[0])||!('city'in all[0])))throw new Error('Public feed format changed.');
  return {candidates:all.filter(x=>x.isRentals===true&&/^delft$/i.test(x.city)&&/^(?:beschikbaar|available)$/i.test(x.status)).map(x=>({url:allowedURL(source,x.url),title:`${x.address}, ${x.city}`,address:x.address||null,priceText:decode(x.price),city:x.city,indexStamp:String(x.changed||''),photos:normalizePhotos(source.id,[...(Array.isArray(x.photos)?x.photos:[]),x.photo].filter(Boolean))})).filter(x=>x.url),complete:true,next:[]};
 }
 const doc=parse(html);const next=[];
 if(source.kind==='next'){
  const page=scriptJSON(doc,'__NEXT_DATA__')?.props?.pageProps?.targetPageProps;
  const feed=page?.findListingsResponse;if(!feed||!Array.isArray(feed.listings))throw new Error('Public search format changed.');
  if(!/^delft$/i.test(page.allFilters?.cityName||''))throw new Error('Search did not establish Delft-only results.');
  const anchors=nodes(doc,n=>n.tagName==='a').map(n=>attrs(n,'href'));
  const candidates=[...feed.listings,...(feed.topAdListings||[])].filter(x=>/^delft$/i.test(x.city)).map(x=>{
   const link=anchors.find(a=>new RegExp(`/(?:room|studio|apartment)-${x.listingId}(?:$|[?#])`).test(a));
   return {url:allowedURL(source,link||''),title:`${x.street}, Delft`,address:x.street||null,city:'Delft',...normalizeKamernetIndex(x),indexStamp:JSON.stringify([x.totalRentalPrice,x.utilitiesIncluded,x.availabilityStartDate,x.availabilityEndDate,x.isReactForFree]),contactFree:x.isReactForFree===true};
  }).filter(x=>x.url);
  const current=Number(page.allFilters.pageNo)||1;const count=Number(page.allFilters.listingsPerPage)||17;
  if(current*count<feed.total){const u=new URL(url);u.searchParams.set('pageNo',current+1);next.push(u.href);}
  return {candidates,complete:current*count>=feed.total,next,total:feed.total};
 }
 const ha=source.id==='housinganywhere'?preloadedState(html)?.search:null;
 const anchors=nodes(doc,n=>n.tagName==='a');const candidates=anchors.map(n=>({url:allowedURL(source,attrs(n,'href')),title:tidy(plain(n)).slice(0,160),city:'Delft'})).filter(x=>x.url);
 for(const n of anchors){try{const u=new URL(attrs(n,'href'),url);if(u.origin!==source.origin)continue;if(attrs(n,'rel').split(' ').includes('next')||attrs(n,'class').split(' ').includes('next')||/^(?:next|volgende|›|»)$/i.test(tidy(plain(n))))next.push(u.href);}catch{}}
 if(!candidates.length&&!ha?.pageInfo&&!anchors.some(n=>/\/woning\//.test(attrs(n,'href'))))throw Object.assign(new Error(source.id==='roommatch'?'The public search page requires a rendered collector; no account-specific coverage is established.':'No original Delft property links could be verified in this page.'),{status:'attention'});
 let complete=false;
 if(ha?.pageInfo){const info=ha.pageInfo;if(!/^delft$/i.test(ha.loadState?.cityCanonical||'')||!Number.isFinite(info.offset)||!Number.isFinite(info.total)||!(info.limit>0))throw new Error('HousingAnywhere search scope could not be verified.');if(info.offset+info.limit<info.total){const u=new URL(url);u.searchParams.set('page',Math.floor(info.offset/info.limit)+2);next.push(u.href);}else complete=true;}
 return {candidates,complete,next:[...new Set(next)]};
}
export function extractPropertyPhotos(source,html,candidate={},doc=parse(html)){
 let values=[];
 if(source.kind==='room')values=(candidate.inlineProperty?.pictures||[]).map(p=>p?.uri).filter(p=>typeof p==='string');
 else if(source.kind==='next'){
  const data=scriptJSON(doc,'__NEXT_DATA__')?.props?.pageProps?.targetPageProps?.listingDetails;
  // imageList belongs to this property, whereas landlordPhotoKey and suggested
  // listings are deliberately outside the photo collection path.
  if(data&&/^delft$/i.test(data.computedCityName||''))values=(data.imageList||[]).filter(v=>typeof v==='string'&&/^[a-z0-9-]{10,100}$/i.test(v)).map(id=>'https://resources.kamernet.nl/image/'+id);
 }else if(source.id==='housinganywhere'){
  const entity=preloadedState(html)?.listing?.entity;
  if(entity)values=(entity.photoURLList||[]).filter(p=>p&&typeof p.url==='string').map(p=>p.url);
 }
 const inGallery=n=>{for(let p=n.parentNode;p;p=p.parentNode){const cls=attrs(p,'class');if(source.kind==='next'&&/\bGallery_root__/.test(cls)||source.kind==='agent'&&cls.split(/\s+/).includes('swiper-container-aanbod')||source.id==='huizenbalie'&&cls.split(/\s+/).includes('single-property-slider'))return true;}return false;};
 for(const n of nodes(doc,n=>n.tagName==='img'&&inGallery(n))){let value=attrs(n,'data-src')||attrs(n,'src');try{const u=new URL(value,source.origin);value=u.pathname==='/_next/image'?(u.searchParams.get('url')||''):u.href;}catch{}values.push(value);}
 return normalizePhotos(source.id,values,source.origin);
}
export function parseDetail(source,html,candidate){
 if(challengePage(html))throw Object.assign(new Error('Property page requires browser verification.'),{status:'blocked'});
 const doc=parse(html);let title=candidate.title;let description='';let structured={};let featureLines=[];let kamernetDetails;
 const haEntity=source.id==='housinganywhere'?preloadedState(html)?.listing?.entity:null;
 if(haEntity&&!matchesHousingAnywhereEntity(haEntity,candidate))throw new Error('HousingAnywhere did not confirm the original Delft property.');
 if(source.kind==='room'){
  const x=candidate.inlineProperty;if(!x||typeof x.infoveld!=='string')throw new Error('ROOMMATCH description unavailable.');
  description=decode(x.infoveld)+'\n'+decode(x.infoveldBewoners)+'\n'+[x.rentDuration?.name,x.dwellingType?.name,x.woningsoort?.name,...(x.doelgroepen||[]).map(d=>d.name)].filter(Boolean).join('\n');
  structured={start_date:date(x.availableFromDate),end_date:date(x.availableTillDate),age_min:x.minimumAge,age_max:x.maximumAge};
  structured.location=roomLocation(x);
  if(x.minimumIncome>0)structured.income_requirement=true;
  if(/student/i.test(x.woningsoort?.name||''))structured.student_allowed=true;
  structured.extraction_warnings=['Personal ROOM qualification still requires an account-specific check.'];
  structured.availability_text=typeof x.availableFrom==='string'?x.availableFrom:null;
  structured.area_m2=Number.isFinite(x.areaDwelling)&&x.areaDwelling>0?x.areaDwelling:null;
  structured.rent_advertised_total=Number.isFinite(x.totalRent)?x.totalRent:null;
  structured.rent_known_monthly_min=Number.isFinite(x.totalRent)?x.totalRent:Number.isFinite(x.netRent)?x.netRent:null;
  structured.monthly_costs=[['Service charge',x.serviceCosts],['Heating',x.heatingCosts],['Other recurring charges',x.additionalCosts]].filter(([,amount])=>Number.isFinite(amount)&&amount>0).map(([label,amount])=>({label,amount,conditional:false,evidence:'Public ROOM offer '+label+': EUR '+amount+' per month.'}));
  structured.included_costs=(x.servicecomponentenBinnenServicekosten||[]).map(c=>c.localizedNaam||c.name).filter(Boolean);
  structured.excluded_costs=(x.servicecomponentenBuitenServicekosten||[]).map(c=>c.localizedNaam||c.name).filter(Boolean);
  structured.source_evidence={rent_advertised_total:Number.isFinite(x.totalRent)?'Public ROOM offer totalRent: EUR '+x.totalRent+' per month.':null,rent_known_monthly_min:Number.isFinite(x.totalRent)?'Public ROOM offer totalRent: EUR '+x.totalRent+' per month; all mandatory extras are not established.':null,start_date:date(x.availableFromDate)?'Public ROOM offer availableFromDate: '+date(x.availableFromDate):null,end_date:date(x.availableTillDate)?'Public ROOM offer availableTillDate: '+date(x.availableTillDate):null,area_m2:structured.area_m2?'Public ROOM offer areaDwelling: '+structured.area_m2+' m².':null};
 }else if(source.kind==='next'){
  const data=scriptJSON(doc,'__NEXT_DATA__')?.props?.pageProps?.targetPageProps?.listingDetails;
  const id=new URL(candidate.url).pathname.match(/-(\d+)$/)?.[1];
  if(!data||!/^delft$/i.test(data.computedCityName||'')||!id||String(data.listingId)!==id)throw new Error('Original detail did not establish the listed Delft property.');
  kamernetDetails=data;
  description=decode(data.englishDescription||data.dutchDescription);title=data.englishTitle||data.dutchTitle||title;
 }else{
  // Read the original property's labelled facts as well as its description.
  // Agent pages expose availability/area/furnishing in dt/dd feature rows.
  const facts=[];for(const dt of nodes(doc,n=>n.tagName==='dt')){const siblings=dt.parentNode?.childNodes||[];const following=siblings.slice(siblings.indexOf(dt)+1);const dd=following.find(n=>n.tagName==='dd'||n.tagName==='dt');if(dd?.tagName!=='dd')continue;const label=tidy(plain(dt)).toLowerCase(),value=tidy(plain(dd));if(value.length>500)continue;facts.push({label,value});}
  const fact=(...labels)=>facts.find(f=>labels.includes(f.label))?.value;
  const price=fact('prijs','huurprijs','rental price');if(price)featureLines.push('Rental price: '+price);
  const available=fact('oplevering','beschikbaar per','beschikbaar vanaf','aanvaarding','available from');if(available){featureLines.push('Available from '+available);structured.availability_text=available;}
  const area=fact('woonoppervlakte','living area');const areaValue=area?.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/);if(areaValue){structured.area_m2=Number(areaValue[1].replace(',','.'));}
  const furnishing=fact('inrichting','furnishing');if(furnishing){featureLines.push('Furnishing: '+furnishing);if(/^gestoffeerd$/i.test(furnishing))structured.furnished='upholstered';else if(/gemeubileerd|furnished/i.test(furnishing)&&!/^ongemeubileerd|unfurnished/i.test(furnishing))structured.furnished='furnished';else if(/ongemeubileerd|unfurnished|kaal/i.test(furnishing))structured.furnished='unfurnished';}
  const bedrooms=fact('slaapkamers','aantal slaapkamers','bedrooms');if(/^\d+$/.test(bedrooms||''))structured.bedrooms=Number(bedrooms);
  const energy=fact('energielabel','energy label');if(energy)structured.energy_label=energy;
  const postcode=fact('postcode','postal code');if(/^[1-9]\d{3}\s?[A-Z]{2}$/i.test(postcode||''))structured.postcode=postcode.toUpperCase();
  const address=fact('adres','address');if(address)structured.address=address;
  const city=fact('plaats','city');
  if(city&&candidate.city&&city.toLowerCase()!==candidate.city.toLowerCase()) throw new Error('The detail address does not match the index city.');
  if(facts.length)structured.source_features=Object.fromEntries(facts.filter(f=>['prijs','huurprijs','oplevering','beschikbaar per','beschikbaar vanaf','aanvaarding','woonoppervlakte','inrichting','slaapkamers','energielabel'].includes(f.label)).map(f=>[f.label,f.value]));
  structured.source_evidence={...(structured.source_evidence||{}),...(structured.area_m2?{area_m2:'Woonoppervlakte: '+area}:{}),...(structured.furnished?{furnished:'Inrichting: '+furnishing}:{})};
  const section=nodes(doc,n=>attrs(n,'id')===source.description||attrs(n,'class').split(/\s+/).some(c=>c===source.description||source.description&&c.includes(source.description)))[0];
  if(section)description=tidy(plain(section));
  if(!description){const ld=nodes(doc,n=>n.tagName==='script'&&attrs(n,'type')==='application/ld+json');for(const node of ld){try{const j=JSON.parse((node.childNodes||[]).map(n=>n.value||'').join(''));if(/Accommodation|Apartment|Residence|Product/.test([j['@type']].flat().join(' '))&&j.description){description=decode(j.description);title=j.name||title;break;}}catch{}}}
  const heading=nodes(doc,n=>n.tagName==='h1')[0];if(heading)title=tidy(plain(heading));
 }
 if(haEntity){
  if(typeof haEntity.description==='string'&&haEntity.description.trim())description=decode(haEntity.description);
  title=housingAnywhereTitle(haEntity);
 }
 if(description.length<100&&!(source.kind==='room'&&candidate.inlineProperty||haEntity||kamernetDetails&&description.trim()))throw new Error('A full property description was not available.');
 const ldDescriptions=[];for(const n of nodes(doc,n=>n.tagName==='script'&&attrs(n,'type')==='application/ld+json')){try{const data=JSON.parse((n.childNodes||[]).map(c=>c.value||'').join(''));if(/Accommodation|Apartment|Residence/.test([data['@type']].flat().join(' '))&&data.description)ldDescriptions.push(decode(data.description));}catch{}}
 if(ldDescriptions.length)description+='\n'+ldDescriptions.filter(text=>!description.includes(text)).join('\n');
 title=String(title||candidate.url).replace(/\s+/g,' ').trim();
 const price=kamernetDetails?'':candidate.priceText|| (Number.isFinite(candidate.rent_base)?`Advertised search price: EUR ${candidate.rent_base}`:'');
 const body=[title,price,...featureLines,description].filter(Boolean).join('\n');
 let listing=parseListingText(body,source.id,candidate.url);
 const extra=structured.extraction_warnings||[];delete structured.extraction_warnings;const sourceEvidence=structured.source_evidence||{};delete structured.source_evidence;
 listing={...listing,...Object.fromEntries(Object.entries(structured).filter(([,v])=>v!==null)),extraction_warnings:[...listing.extraction_warnings,...extra],title:String(title||candidate.url).slice(0,200),city:candidate.city||listing.city,address:structured.address||candidate.address||null};
 if(Number.isFinite(candidate.rent_base)){listing.rent_base=candidate.rent_base;listing.evidence.rent_base='Original search feed advertised rent: EUR '+candidate.rent_base+' per month.';}
 listing.evidence={...listing.evidence,...Object.fromEntries(Object.entries(sourceEvidence).filter(([,v])=>v!=null))};
 if(source.kind==='room')listing=applyRoomTerms(listing,candidate.inlineProperty);
 if(['verra','bjornd','huizenbalie'].includes(source.id))listing=applyAgencyTerms(listing,source.id);
 if(haEntity)listing=normalizeHousingAnywhere(haEntity,candidate,listing);
 if(kamernetDetails)listing={...listing,...normalizeKamernetDetail(kamernetDetails,candidate,listing,description)};
 const photos=extractPropertyPhotos(source,html,candidate,doc);
 return {...listing,body,photos:photos.length?photos:normalizePhotos(source.id,candidate.photos),photo_version:1,property_details_checked:true,source_evidence_ambiguous:false};
}
export function robotRules(text,agent='housewatch'){
 const groups=[];let g=null,started=false;
 for(let line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){line=line.split('#')[0].trim();const m=line.match(/^([\w-]+)\s*:\s*(.*)$/);if(!m)continue;const k=m[1].toLowerCase(),v=m[2].trim();
  if(k==='user-agent'){if(!g||started){g={agents:[],rules:[],delay:0};groups.push(g);started=false;}g.agents.push(v.toLowerCase());}
  else if(g){started=true;if(['allow','disallow'].includes(k)&&v)g.rules.push({allow:k==='allow',path:v});if(k==='crawl-delay')g.delay=Math.max(g.delay,Number(v)||0);}
 }
 const score=g=>Math.max(-1,...g.agents.map(a=>a==='*'?0:agent.includes(a)?a.length:-1));const best=Math.max(-1,...groups.map(score));const selected=groups.filter(g=>score(g)===best&&best>=0);
 return {rules:selected.flatMap(g=>g.rules),delay:Math.max(0,...selected.map(g=>g.delay))};
}
export function robotsAllow(policy,path){let best=null;for(const rule of policy.rules){const terminal=rule.path.endsWith('$');const value=terminal?rule.path.slice(0,-1):rule.path;const re=new RegExp('^'+value.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+(terminal?'$':''));if(re.test(path)&&(!best||value.replaceAll('*','').length>best.size||value.replaceAll('*','').length===best.size&&rule.allow))best={size:value.replaceAll('*','').length,allow:rule.allow};}return best?.allow!==false;}
const UA='Housewatch/0.1 (read-only housing verification)';
export function createSourceFetcher(source,{fetchImpl=fetch,paceMs=2000,onResponse}={}){
 const policies=new Map(),last=new Map();const origins=new Set([source.origin,...(source.apiOrigin?[source.apiOrigin]:[])]);
 async function raw(url){let current=new URL(url);const original=current.origin;for(let i=0;i<4;i++){
   if(!origins.has(current.origin)||current.origin!==original||current.username||current.password)throw new Error('Cross-origin source navigation is held.');
   const policy=policies.get(current.origin);
   if(policy&&!robotsAllow(policy,current.pathname+current.search))throw Object.assign(new Error('This path is disallowed by the source crawl policy.'),{status:'policy_blocked'});
   const wait=Math.max(paceMs,(policy?.delay||0)*1000)-(Date.now()-(last.get(current.origin)||0));if(wait>0)await delay(wait);last.set(current.origin,Date.now());
   const res=await fetchImpl(current,{headers:{'User-Agent':UA,Accept:'text/html,application/json,text/plain'},redirect:'manual',signal:AbortSignal.timeout(20000)});
   if([301,302,303,307,308].includes(res.status)){current=new URL(res.headers.get('location'),current);continue;}
   if(!res.ok&&!onResponse)throw sourceHttpError(res);
   const chunks=[];let size=0;if(res.body)for await(const c of res.body){size+=c.length;if(size>5000000){if(!res.ok)throw sourceHttpError(res);throw new Error('Source response exceeded the size limit.');}chunks.push(Buffer.from(c));}
   const body=Buffer.concat(chunks).toString('utf8');
   await onResponse?.({url:current.href,status:res.status,type:res.headers.get('content-type'),body});
   if(!res.ok)throw sourceHttpError(res);
   return body;
  }throw new Error('Source redirected too many times.');}
 return async url=>{const origin=new URL(url).origin;if(!origins.has(origin))throw new Error('Unknown source origin.');if(!policies.has(origin)){try{const text=await raw(origin+'/robots.txt');if(/<html|<!doctype/i.test(text))throw new Error('Crawl policy could not be verified.');policies.set(origin,robotRules(text));}catch(e){if(e.httpStatus===404)policies.set(origin,{rules:[],delay:0});else throw e;}}return raw(url);};
}
function sourceHttpError(response){
 const seconds=Number(response.headers.get('retry-after'));
 const retryAt=seconds>0?Date.now()+seconds*1000:Date.parse(response.headers.get('retry-after')??'');
 return Object.assign(new Error(`Source returned HTTP ${response.status}.`),{status:[401,403,429].includes(response.status)?'blocked':'attention',httpStatus:response.status,retryAt});
}
export async function discoveryState(store){
 const sources=await Promise.all(SOURCES.map(async s=>({id:s.id,name:s.name,url:s.origin,enabled:await store.getConfig('discovery.enabled.'+s.id,true),contact:s.contact,...await store.getConfig('discovery.health.'+s.id,{status:s.kind==='account'?'needs_login':'not_checked'})})));
 return {enabled:await store.getConfig('discovery.enabled',true),intervalMinutes:await store.getConfig('discovery.intervalMinutes',5),sources};
}
function summary(source,c){
 const body=[c.title,c.city,c.priceText||'',c.start_date?`Available from ${c.start_date}`:'','Only a public index summary has been checked.'].join('\n');
 const parsed=parseListingText(body,source.id,c.url);
 const rentBase=source.kind==='next'?c.rent_base??null:c.rent_base??(parsed.rent_total===null?parsed.rent_base:null);
 return {...parsed,title:c.title||'Delft property',city:c.city,address:c.address||null,body,
  rent_base:rentBase,rent_total:null,rent_advertised_total:c.rent_advertised_total??null,
  rent_known_monthly_min:c.rent_known_monthly_min??parsed.rent_known_monthly_min??rentBase,
  location:c.inlineProperty?roomLocation(c.inlineProperty):c.location??null,
  evidence:{...parsed.evidence,...c.evidence},photos:source.kind==='room'?extractPropertyPhotos(source,'',c):normalizePhotos(source.id,c.photos),
  photo_version:source.kind==='room'||c.photos?.length?1:0,property_details_checked:false,source_evidence_ambiguous:true};
}
export async function runPublicDiscovery(store,{profile=DEFAULT_PROFILE,now=Date.now(),sources=SOURCES,fetchSource,force=false,detailLimit=6}={}){
 const changedListing=(before,after,{isNew=false,isChanged=false}={})=>{
  const origin=listingTravelKey(after);
  const moved=origin!==listingTravelKey(before);
  if(origin&&(isNew||moved)) result.travelIds.push(after.id);
  if(isNew) result.added++;
  else if(isChanged||moved||before?.availability!==after.availability||before?.source_detail_pending!==after.source_detail_pending||
    !isDeepStrictEqual(before?.photos??[],after.photos??[])) result.changed++;
 };
 const result={enabled:await store.getConfig('discovery.enabled',true),checked:0,added:0,changed:0,sources:[],travelIds:[]};if(!result.enabled)return result;
 for(const source of sources){const key='discovery.health.'+source.id;const previous=await store.getConfig(key,{});
  if(!(await store.getConfig('discovery.enabled.'+source.id,true))){result.sources.push({id:source.id,status:'disabled'});continue;}
  if(source.kind==='account'){const health=await store.getConfig(key,{status:'not_checked',accountRequired:true,message:'Read-only Facebook group collection has not yet been tested. An account session alone does not establish coverage.'});result.sources.push({id:source.id,...health});continue;}
  if(previous.nextCheckAt&&Date.parse(previous.nextCheckAt)>now&&(!force||['blocked','policy_blocked'].includes(previous.status))){result.sources.push({id:source.id,...previous,skipped:true});continue;}
  const get=fetchSource?url=>fetchSource(source,url):createSourceFetcher(source);let details=0,attempts=0,errors=0;let next=[],complete=false;const found=new Map();let pages=0;
  try{
   const queue=source.indexes.map(p=>new URL(p,source.origin).href);const seen=new Set();const continuation=await store.getConfig('discovery.continuation.'+source.id,[]);queue.push(...continuation.filter(u=>[source.origin,source.apiOrigin].includes(new URL(u).origin)));
   while(queue.length&&pages<12){const url=queue.shift();if(seen.has(url))continue;seen.add(url);const parsed=parseIndex(source,await get(url),url);pages++;for(const c of parsed.candidates)found.set(c.url,c);queue.push(...parsed.next.filter(u=>!seen.has(u)));complete=parsed.complete&&queue.length===0;}
   next=queue;await store.setConfig('discovery.continuation.'+source.id,next.slice(0,20));
   const oldRows=(await store.getListings(source.id)).filter(l=>l.source===source.id&&l.discovery===true);
   const oldMap=new Map(oldRows.map(l=>[allowedURL(source,l.url)||l.url,l]));
   const checkKey=c=>'discovery.checked.'+source.id+'.'+c.url;
   const depth=async c=>{
    const row=oldMap.get(c.url),check=await store.getConfig(checkKey(c),{});
    const stamp=c.indexStamp||'';
    const fresh=row?.property_details_checked&&row.extraction_version===2&&row.photo_version===1&&row.availability!=='unavailable'&&
      now-Date.parse(check.at)<6*3600000&&check.stamp===stamp;
    return {c,row,stamp,fresh,changedStamp:!!(stamp&&check.stamp&&check.stamp!==stamp),retryLater:check.failedStamp===stamp&&Date.parse(check.retryAt)>now,
      priority:!row?.property_details_checked?0:check.stamp!==stamp?1:2, lastAttempt:Date.parse(check.at)||0};
   };
   const candidates=(await Promise.all([...found.values()].map(depth))).sort((a,b)=>a.priority-b.priority||a.lastAttempt-b.lastAttempt);
   let detailsPending=0;
   for(const {c,row:old,stamp,fresh,changedStamp,retryLater} of candidates){
    const seenAt=new Date(now).toISOString();
    const visible={last_seen_at:seenAt,availability:'available',contact_policy:source.contact,contact_access:c.contactFree===true?'explicitly_free':'unverified'};
    if(fresh){changedListing(old,await store.updateListing(old.id,{...visible,source_detail_pending:false}));continue;}
    let listing;
    if(!retryLater&&(source.kind==='room'||attempts<detailLimit)){
     attempts++;
     try {
      listing=parseDetail(source,source.kind==='room'?'<html></html>':await get(c.url),c);
      details++;
     } catch(e) {
      errors++;
      if(['blocked','policy_blocked'].includes(e.status))throw e;
      const previousCheck=await store.getConfig(checkKey(c),{});
      await store.setConfig(checkKey(c),{...previousCheck,failedStamp:stamp,retryAt:new Date(now+30*60000).toISOString()});
     }
     if(listing) await store.setConfig(checkKey(c),{at:seenAt,stamp});
    }
    if(!listing){
     detailsPending++;
     if(old){changedListing(old,await store.updateListing(old.id,{...visible,source_detail_pending:changedStamp||old.source_detail_pending===true}));continue;}
     listing=summary(source,c);
    }
    if(c.start_date&&!listing.start_date){listing.start_date=c.start_date;listing.start_kind='earliest';}
    if(c.end_date&&!listing.end_date)listing.end_date=c.end_date;
    if(listing.start_kind==='immediate'&&!listing.start_date){
     listing.start_date=old?.start_kind==='immediate'&&old.start_date?old.start_date:seenAt.slice(0,10);
    }
    const assessment=evaluateListing(listing,profile);const ai=assessment.status!=='rejected'&&listing.property_details_checked&&await store.getConfig('codex.enabled',false)?{state:'queued'}:null;
    const saved=await store.upsertListing({...listing,source:source.id,source_id:old?.source_id??c.url,url:c.url,discovery:true,source_detail_pending:false,availability:'available',last_seen_at:new Date(now).toISOString(),assessment,status:assessment.status,draft:draftIntroduction(listing,profile),ai,application_status:'held_unverified_adapter',contact_access:c.contactFree===true?'explicitly_free':'unverified',contact_policy:source.contact});
    if(saved.isNew&&assessment.status==='review') result.reviewAdded=(result.reviewAdded||0)+1;
    let current=saved.listing;
    if(!saved.isNew&&!saved.isChanged){
     current=await store.updateListing(saved.listing.id,{...listing,ai:old?.ai??ai,...visible,source_detail_pending:false});
     const updated=evaluateListing(current,profile);
     await store.updateListing(current.id,{assessment:updated,status:updated.status,reasons:updated.reasons,questions:updated.questions});
    }
    changedListing(old,current,saved);
    if(assessment.status==='eligible'&&(saved.isNew||saved.isChanged))await store.enqueueNotification('match:'+saved.listing.id+':'+saved.listing.fingerprint,{title:'New Delft housing match',body:listing.title+' — confirmed terms match your search.',url:'/#listing='+saved.listing.id,type:'match'});
   }
   if(complete)for(const old of oldRows)if(!found.has(allowedURL(source,old.url)||old.url)&&old.availability!=='unavailable'){
    const removed=await store.updateListing(old.id,{availability:'unavailable',status:'rejected',assessment:{status:'rejected',reasons:['The source no longer lists this property as available.'],questions:[]}});
    changedListing(old,removed);
   }
   const interval=await store.getConfig('discovery.intervalMinutes',5);const health={status:errors||next.length||detailsPending?'partial':'connected',checkedAt:new Date(now).toISOString(),nextCheckAt:new Date(now+interval*60000).toISOString(),pagesChecked:pages,propertiesFound:found.size,detailsChecked:details,detailsPending,errors,failures:0,coverage:complete?'complete_public_feed':'bounded_public_pages',backlogPages:next.length,message:`Public discovery found ${found.size} Delft properties. ${details} full descriptions checked this cycle.${detailsPending?' '+detailsPending+' detail checks pending.':''} ${complete?'The returned public feed was covered.':'Coverage is limited to the checked public pages.'}`};await store.setConfig(key,health);result.sources.push({id:source.id,...health});result.checked++;
  }catch(error){if(error?.name==='PostgresError'||error?.code?.startsWith('ERR_SQLITE')) throw error;const failures=(previous.failures||0)+1;const blocked=['blocked','policy_blocked'].includes(error.status);const minutes=blocked?Math.min(360,30*2**Math.min(4,failures-1)):Math.min(60,5*2**Math.min(3,failures-1));const health={...previous,status:error.status||'attention',checkedAt:new Date(now).toISOString(),nextCheckAt:new Date(Math.max(now+minutes*60000,error.retryAt||0)).toISOString(),failures,message:error.message,pagesChecked:pages,propertiesFound:found.size,detailsChecked:details};await store.setConfig(key,health);result.sources.push({id:source.id,...health});}
 }
 if(result.added||result.changed)await store.addEvent('listings_discovered',{added:result.added,changed:result.changed,sourceIds:result.sources.filter(s=>['connected','partial'].includes(s.status)&&!s.skipped).map(s=>s.id)});
 if(result.reviewAdded)await store.enqueueNotification('review-digest:'+new Date(now).toISOString().slice(0,10),{title:'New Delft candidates to review',body:`${result.reviewAdded} new property candidate(s) have unconfirmed terms. They are not verified eligible matches.`,url:'/#review',type:'review'});
 return result;
}
