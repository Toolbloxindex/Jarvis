import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
import {CAMPUSES, streetTablePlan, streetTableURL, parseStreetTable, tableRoute, campusTravelTimes, nearbyCampuses, nearDelftRail} from './university-travel.mjs';
import {STUDENT_CITIES} from '../lib/universities.ts';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const POSTCODE = /\b[1-9]\d{3}\s?[A-Z]{2}\b/i;
/** Amenities are catalogued per student city: a box of about 26 × 26 km around its centre. */
const CATALOG_HALF = {lat:0.12, lon:0.19};
/** Homes farther than this from every student city get no supermarket/gym catalog. */
const CATALOG_REACH_M = 30_000;
/** Daily cap on public OSRM table requests (two per home: walk + bike). */
const OSRM_DAILY = Number(process.env.HOUSEWATCH_OSRM_DAILY ?? 1500);
const USER_AGENT = 'Housewatch/0.1 (housing travel estimates)';
const MAP_VERSION = 3;
const CAMPUS_SIGNATURE = createHash('sha256').update(JSON.stringify(CAMPUSES)).digest('hex');
const AMENITIES_VERSION = 2;
const chains = {
  gym: ['Basic-Fit','TrainMore','SportCity','Anytime Fitness','Fit For Free','Snap Fitness','BigGym','David Lloyd'],
  supermarket: ['Albert Heijn','Jumbo','Lidl','Aldi','PLUS','Dirk','Hoogvliet','Vomar','SPAR','Coop','DekaMarkt','Ekoplaza','Nettorama'],
};
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\d]/gu,'');
const point = p => Number.isFinite(p?.lat) && Math.abs(p.lat)<=90 && Number.isFinite(p?.lon) && Math.abs(p.lon)<=180;
const value = n => Number.isFinite(n) && n>=0;

function metres(a,b) {
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat-a.lat)*radians/2)**2 +
    Math.cos(a.lat*radians)*Math.cos(b.lat*radians)*Math.sin((b.lon-a.lon)*radians/2)**2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1,h)));
}

function addressInput(text, defaultCity, allowStreet=false) {
  if(typeof text !== 'string' || !text.trim() || text.length>120) return null;
  const postcode = text.match(POSTCODE);
  let prefix = postcode ? text.slice(0,postcode.index) : text;
  const town = postcode ? text.slice(postcode.index+postcode[0].length).trim() : null;
  prefix = prefix.trim().replace(/[,;]+$/,'').trim();
  const address = prefix.match(/^([\p{L}][\p{L}\d .'’\-]{1,66}?)\s+(\d{1,5})([a-z]|[-/ ]+(?:[a-z]\d{0,4}|\d{1,4}[a-z]?)(?=[\s,]|$))?(?:[,\s]+([\p{L}][\p{L} '’-]{1,30}))?$/iu);
  const code = postcode?.[0].toUpperCase().replace(/\s/g,'');
  if(!address && !code && allowStreet && defaultCity && /^[\p{L}][\p{L}\d .'’\-]{1,66}$/u.test(prefix)) {
    return {street:prefix,city:defaultCity,query:prefix+' '+defaultCity};
  }
  if(!address && (!code || prefix || (town && !/^[\p{L} '-]{2,31}$/u.test(town)))) return null;
  const city = town || address?.[4] || (code ? '' : defaultCity);
  if(!code && !city) return null;
  const street = address?.[1];
  const house = address ? address[2]+(address[3]||'').replace(/^[-/ ]+/, '') : undefined;
  return {street,house,city,code,query:[street,house,code,city].filter(Boolean).join(' ')};
}

export function listingAddress(listing) {
  // A description can mention a university, shop, or contact address. Only use explicit property fields or an address title.
  const body = String(listing.body || '').slice(0,4000);
  const labels = [...body.matchAll(/^\s*(?:property address|adres|address|postcode|postal code)\s*:\s*([^\n]+)$/gim)];
  // Kamernet titles are "Street, City": the part before the city is a usable street.
  const suffix = listing.city ? ', ' + listing.city : null;
  const streetTitle = listing.source==='kamernet' && suffix && String(listing.title || '').toLowerCase().endsWith(suffix.toLowerCase())
    ? listing.title.slice(0,-suffix.length) : null;
  const address = listing.address || streetTitle;
  const postcode = listing.postcode || listing.location?.postcode;
  const candidates = [postcode && address && !POSTCODE.test(address) ? addressInput(address + ', ' + postcode, listing.city) : null,
    addressInput(address,listing.city,true), addressInput(postcode,listing.city),
    ...[listing.title,...labels.map(m=>m[1])].map(text=>addressInput(text,listing.city))].filter(Boolean);
  const addresses = candidates.filter(p=>p.house);
  const unique = new Set(addresses.map(p=>normalize(p.street)+':'+normalize(p.house)));
  const codes = [...new Set(candidates.map(p=>p.code).filter(Boolean))];
  if(unique.size>1 || codes.length>1) return null;
  return addresses.find(p=>p.code) || addresses[0] || candidates.find(p=>p.code) || candidates[0] || null;
}

async function getJson(fetcher,url,{timeout=5500,limit=1_500_000}={}) {
  const response = await fetcher(url,{redirect:'error',headers:{'user-agent':USER_AGENT,accept:'application/json'},signal:AbortSignal.timeout(timeout)});
  // OSRM uses HTTP 400 for an unsnappable point or missing route.
  if(!response.ok && !(response.status===400 && url.hostname==='routing.openstreetmap.de')) throw new Error('Provider request failed');
  if(!response.body) throw new Error('Provider returned no data');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if(size>limit) throw new Error('Provider response exceeded the limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function pdokPoint(doc) {
  const match = /^POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(doc.centroide_ll || '');
  if(!match) return null;
  const p = {lat:Number(match[2]),lon:Number(match[1])};
  return point(p) ? p : null;
}

async function geocode(fetcher,input) {
  const url = new URL('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free');
  const type=input.house?'adres':input.code?'postcode':'weg';
  url.search = new URLSearchParams({
    q:input.query, fq:'type:'+type, rows:'12',
    fl:'weergavenaam,straatnaam,huisnummer,huisletter,huisnummertoevoeging,postcode,woonplaatsnaam,wijknaam,buurtnaam,centroide_ll',
  });
  if(input.code) url.searchParams.append('fq','postcode:'+input.code);
  const data = await getJson(fetcher,url);
  if(!Array.isArray(data?.response?.docs)) throw new Error('Invalid geocoder response');
  const matches = data.response.docs.filter(doc=>{
    if(input.code && normalize(input.code)!==normalize(doc.postcode)) return false;
    if(input.city && normalize(input.city)!==normalize(doc.woonplaatsnaam)) return false;
    if(!input.street) return true;
    if(normalize(doc.straatnaam)!==normalize(input.street)) return false;
    return !input.house || normalize([doc.huisnummer,doc.huisletter,doc.huisnummertoevoeging].filter(Boolean).join(''))===normalize(input.house);
  }).map(doc=>({p:pdokPoint(doc),doc})).filter(({p})=>p);
  if(!matches.length) return null;
  const {p,doc} = matches[0];
  if(matches.some(match=>metres(p,match.p)>30)) return null;
  return {...p,label:doc.weergavenaam || input.query,precision:input.house?'address':input.code?'postcode':'street',
    ...(districtName(doc) ? {district:districtName(doc)} : {})};
}

/** A readable district for "Room in …": PDOK's wijk (e.g. "Wijk 21 Hof van Delft" → "Hof van Delft"), else buurt. */
export function districtName(doc) {
  for (const value of [doc?.wijknaam, doc?.buurtnaam]) {
    const name = String(value ?? '').replace(/^wijk\s+\d+\s*/i,'').replace(/^buurt\s+\d+\s*/i,'').trim();
    if (name && name.length <= 48 && !/^\d+$/.test(name)) return name;
  }
  return null;
}

function chainFor(tags,kind) {
  const brand = normalize(tags.brand);
  const name = normalize(tags.name);
  return chains[kind].find(chain=>{
    const key = normalize(chain);
    if(brand) return brand===key || (chain==='Albert Heijn' && brand==='ah');
    if(chain==='Albert Heijn' && String(tags.name || '').match(/^AH(?:\s+(?!to\s+go\b).+)?$/i)) return true;
    if(name===key) return true;
    if(!name.startsWith(key)) return false;
    // A branch name may include its street, but a partial brand word is not enough.
    const escaped = chain.replace(/[.*+?^$${}()|[\]\\]/g,'\\$&').replace(/-/g,'[- ]?');
    return new RegExp('^'+escaped+'(?:\\s|[-(])','i').test(tags.name || '');
  });
}

function webLink(input) {
  if(typeof input!=='string' || input.length>400) return undefined;
  try {
    const url=new URL(input);
    if(url.protocol==='https:' && !url.username && !url.password) return url.href;
  } catch {}
}

/** The student city whose amenity catalog covers this point, if any. */
export function catalogCity(origin) {
  const near = STUDENT_CITIES.map(city=>({city,d:metres(origin,{lat:city.lat,lon:city.lng})})).sort((a,b)=>a.d-b.d)[0];
  return near && near.d<=CATALOG_REACH_M ? near.city : null;
}
export const catalogKey = city => 'travel.catalog.' + city.id;

async function loadPlaces(fetcher,localFile,city) {
  if(localFile){
    try {
      const local=JSON.parse(await readFile(localFile,'utf8'));
      return catalogPlaces(local);
    } catch {
      // If the local map data has not been installed yet, try the public source.
    }
  }
  const south=(city.lat-CATALOG_HALF.lat).toFixed(4), north=(city.lat+CATALOG_HALF.lat).toFixed(4);
  const west=(city.lng-CATALOG_HALF.lon).toFixed(4), east=(city.lng+CATALOG_HALF.lon).toFixed(4);
  const bbox = [south,west,north,east].join(',');
  const query = `[out:json][timeout:25];(nwr["shop"="supermarket"](${bbox});nwr["leisure"="fitness_centre"](${bbox}););out center;`;
  // The main Overpass server is often slow (30 s+ measured); public mirrors carry the same OSM data.
  // Try each in turn so one busy server does not leave every home without nearby amenities.
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const url = new URL(endpoint);
    url.searchParams.set('data',query);
    try {
      return catalogPlaces(await getJson(fetcher,url,{timeout:30000}));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No amenities provider answered');
}
const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export function catalogPlaces(data, { requireBoth = true } = {}) {
  if(data?.remark || !Array.isArray(data?.elements)) throw new Error('Incomplete amenities response');
  const places = data.elements.flatMap(item=>{
    const tags = item.tags || {};
    const kind = tags.shop==='supermarket' ? 'supermarket' : 'gym';
    const brand = chainFor(tags,kind);
    const p = item.center || item;
    if(!brand || !point(p) || tags.disused==='yes' || tags.access==='private' || tags['was:shop'] || tags['was:leisure']) return [];
    const name = String(tags.name || brand).slice(0,90);
    const address = [tags['addr:street'],tags['addr:housenumber']].filter(Boolean).join(' ');
    return [{
      lat:p.lat,lon:p.lon,kind,name,detail:address || (name!==brand ? brand : ''),
      website:webLink(tags.website) || webLink(tags['contact:website']),
    }];
  });
  if(requireBoth && (!places.some(p=>p.kind==='gym') || !places.some(p=>p.kind==='supermarket'))) throw new Error('Incomplete amenities catalog');
  return places;
}

export function nearest(places,origin,kind) {
  const candidates = places.filter(p=>p.kind===kind).map(p=>({p,distance:metres(origin,p)}));
  return candidates.sort((a,b)=>a.distance-b.distance)[0]?.p;
}

async function streetTable(fetcher,plan,mode) {
  const data = await getJson(fetcher,streetTableURL(mode,plan),{timeout:15000,limit:2_000_000});
  return parseStreetTable(data,mode,plan);
}

const amsterdam = new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',
});
const localParts = time => Object.fromEntries(amsterdam.formatToParts(time).map(({type,value})=>[type,Number(value)]));
function sampleDeparture(now) {
  const {year,month,day} = localParts(now);
  for(let offset=0;offset<8;offset++){
    const date = new Date(Date.UTC(year,month-1,day+offset,8,30));
    if(date.getUTCDay()===0 || date.getUTCDay()===6) continue;
    const time = date.valueOf() - (localParts(date).hour-8)*60*MINUTE;
    if(time>=now) return time;
  }
}

function compactPath(points) {
  if(points.length<2 || !points.every(point)) return null;
  const count=Math.min(180,points.length);
  return Array.from({length:count},(_,i)=>{
    const {lat,lon}=points[Math.round(i*(points.length-1)/(count-1))];
    return [Number(lat.toFixed(6)),Number(lon.toFixed(6))];
  });
}

function decodeGeometry({points,precision}={}) {
  if(typeof points!=='string' || ![5,6,7].includes(precision)) return null;
  let cursor=0,lat=0,lon=0;
  function delta() {
    let result=0,shift=0;
    while(cursor<points.length && shift<=30) {
      const character=points.charCodeAt(cursor++)-63;
      if(character<0 || character>63) break;
      result += (character&31)*2**shift;
      if(character<32) return result%2 ? -(result+1)/2 : result/2;
      shift+=5;
    }
    throw new Error('Invalid trip geometry');
  }
  try {
    const scale=10**precision;
    const path=[];
    let distance=0;
    while(cursor<points.length) {
      lat+=delta();
      lon+=delta();
      const p={lat:lat/scale,lon:lon/scale};
      if(!point(p)) return null;
      if(path.length) distance+=metres(path.at(-1),p);
      path.push(p);
    }
    return path.length>=2 ? {distance,path:compactPath(path)} : null;
  } catch { return null; }
}

const publicModes = new Set([
  'BUS','TRAM','SUBWAY','SUBURBAN','RAIL','FERRY','COACH',
  'HIGHSPEED_RAIL','LONG_DISTANCE','NIGHT_RAIL','REGIONAL_RAIL',
]);
async function transitRoute(fetcher,base,from,to,departure) {
  const url = new URL('/api/v6/plan',base);
  url.search = new URLSearchParams({
    fromPlace:`${from.lat},${from.lon}`,toPlace:`${to.lat},${to.lon}`,
    time:new Date(departure).toISOString(),timetableView:'false',
    transitModes:'BUS,TRAM,RAIL,FERRY,COACH',maxTravelTime:'90',timeout:'4',detailedLegs:'true',
  });
  const data = await getJson(fetcher,url);
  if(!Array.isArray(data.itineraries)) throw new Error('Invalid timetable response');
  const itineraries = data.itineraries.filter(i=>Array.isArray(i.legs) && i.legs.some(leg=>publicModes.has(leg.mode)))
    .map(i=>({legs:i.legs,seconds:(Date.parse(i.endTime)-departure)/1000,start:Date.parse(i.startTime)}))
    .filter(i=>i.start>=departure-59_000 && value(i.seconds) && i.seconds<=90*60)
    .sort((a,b)=>a.seconds-b.seconds);
  if(!itineraries.length) return {status:'no_route'};
  const trip=itineraries[0];
  const legs=trip.legs.map(leg=>{
    const kind=publicModes.has(leg.mode) ? 'transit' : 'walk';
    const geometry=decodeGeometry(leg.legGeometry || undefined);
    const distance=kind==='walk' && value(leg.distance) ? leg.distance : geometry?.distance;
    return {kind,distance,points:geometry?.path};
  });
  return {
    status:'ok',seconds:trip.seconds,
    metres:legs.every(leg=>value(leg.distance)) ? legs.reduce((sum,leg)=>sum+leg.distance,0) : null,
    approximateDistance:true,
    segments:legs.filter(leg=>leg.points).map(({kind,points})=>({kind,points})),
    partialPath:legs.some(leg=>!leg.points && leg.distance!==0),
  };
}

function error(status,message) { return Object.assign(new Error(message),{status}); }
function fallbackOrigin(input) {
  return input ? {label:input.query,precision:input.house?'unverified':input.code?'postcode':'street'} : null;
}

const motisEndpoint = value => /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(value || '') ? value : null;

function options(listing,record) {
  const listed=listingAddress(listing);
  const input=record?.manual || listed;
  const location=record?.manual ? null : listing.location;
  const candidate = location && {lat:location.lat,lon:location.lng,
    precision:location.precision === 'exact' ? 'address' : location.precision ?? 'postcode'};
  const origin = point(candidate) ? candidate : null;
  const originStamp = origin ? `|${origin.lat},${origin.lon},${origin.precision}` : '';
  const key=input || origin ? createHash('sha256').update(normalize(input?.query) + originStamp).digest('hex') : null;
  return {input,key,listed,origin,manual:!!record?.manual};
}

function currentTravelTimes(cached, now) {
  if (!cached?.travelTimes) return undefined;
  if (!cached.transitEnabled || Date.parse(cached.sampleDeparture) > now) return cached.travelTimes;
  return Object.fromEntries(Object.entries(cached.travelTimes).map(([id, route]) => [id, {...route, transit:null}]));
}

export function listingTravelKey(listing) {
  return listing ? options(listing).key : null;
}

export function travelDisplay(listing, record, {
  now = Date.now, transitEnabled = !!motisEndpoint(process.env.HOUSEWATCH_MOTIS_URL),
} = {}) {
  if(listing.listing_kind==='general_lead') return {status:'not_property'};
  const {input,key,listed,origin,manual}=options(listing,record);
  const cached=key && record?.key===key ? record.result : null;
  return {
    status:cached?.status || (input||origin?'ready':'needs_location'),
    origin:cached?.origin || origin || fallbackOrigin(input), manual, hasListingLocation:!!(listed||origin),
    destinations:cached?.destinations || CAMPUSES.map(campus=>({...campus,routes:{}})),
    travelTimes:currentTravelTimes(cached, now()),
    sampleDeparture:cached?.sampleDeparture,
    checkedAt:cached?.checkedAt,
    isStale:!!cached && (cached.mapVersion!==MAP_VERSION || cached.campusSignature!==CAMPUS_SIGNATURE || now()>=record.expires ||
      cached.transitEnabled!==transitEnabled || (transitEnabled && !(Date.parse(cached.sampleDeparture)>now()))),
  };
}

export function createTravelService(db,{
  fetcher=fetch,motis=process.env.HOUSEWATCH_MOTIS_URL,localPlaces=process.env.HOUSEWATCH_AMENITIES_FILE,now=Date.now,streetInterval=2000,
  // PDOK Locatieserver is a government API built for this; a lighter pace than the volunteer OSRM.
  geocodeInterval=Math.min(streetInterval,400),
  osrmDaily=OSRM_DAILY,
}={}) {
  const active = new Map();
  const placesPending = new Map();
  let streetQueue=Promise.resolve(), nextStreetRequest=0;
  let geocodeQueue=Promise.resolve(), nextGeocode=0;
  function lookup(input) {
    const work=geocodeQueue.then(async()=>{
      if(nextGeocode>now()) await wait(nextGeocode-now());
      nextGeocode=now()+geocodeInterval;
      return geocode(fetcher,input);
    });
    geocodeQueue=work.catch(()=>{});
    return work;
  }
  const motisBase = motisEndpoint(motis);
  const show = (listing, record) => travelDisplay(listing, record, { now, transitEnabled: !!motisBase });

  async function display(listing) {
    const record = listing.listing_kind === 'general_lead' ? null : await db.getConfig('travel.listing.' + listing.id);
    return show(listing, record);
  }
  async function summary(listing) {
    const travel=await display(listing), routes=travel.destinations?.[0]?.routes || {};
    const campus=Object.fromEntries(Object.entries(routes)
      .filter(([mode,route])=>route.status==='ok' && (mode!=='transit' || Date.parse(travel.sampleDeparture)>now()))
      .map(([mode,route])=>[mode,route.seconds]));
    return {status:travel.status, approximate:['postcode','street'].includes(travel.origin?.precision), campus};
  }
  async function catalog(origin) {
    const city=localPlaces ? null : catalogCity(origin);
    if(!localPlaces && !city) return [];
    const key=localPlaces?'travel.catalog.local':catalogKey(city);
    const cached=await db.getConfig(key);
    if(cached?.places && cached.expires>now() && cached.mapVersion===AMENITIES_VERSION) return cached.places;
    if(cached?.retryAfter>now()) return cached.places || [];
    if(!placesPending.has(key)) placesPending.set(key,loadPlaces(fetcher,localPlaces,city).then(async places=>{
      await db.setConfig(key,{places,city:city?.id,expires:now()+7*DAY,mapVersion:AMENITIES_VERSION});
      return places;
    }, async ()=>{
      const places=cached?.expires>now()-30*DAY ? cached.places : [];
      await db.setConfig(key,{places,city:city?.id,expires:cached?.expires,mapVersion:cached?.mapVersion,retryAfter:now()+30*MINUTE});
      return places;
    }).finally(()=>{placesPending.delete(key);}));
    return placesPending.get(key);
  }
  function queueStreet(plan,mode) {
    const work=streetQueue.then(async()=>{
      const budget=await db.getConfig('travel.streetBudget',{});
      const today=new Date(now()).toISOString().slice(0,10);
      const count=budget.day===today ? budget.count : 0;
      if(count>=osrmDaily || budget.resumeAt>now()) return {status:'unavailable'};
      if(nextStreetRequest>now()) await wait(nextStreetRequest-now());
      nextStreetRequest=now()+streetInterval;
      await db.setConfig('travel.streetBudget',{day:today,count:count+1});
      try { return await streetTable(fetcher,plan,mode); }
      catch {
        await db.setConfig('travel.streetBudget',{day:today,count:count+1,resumeAt:now()+2*MINUTE});
        return {status:'unavailable'};
      }
    });
    streetQueue=work.catch(()=>{});
    return work;
  }

  async function check(listing,body) {
    if(!body || typeof body!=='object' || Array.isArray(body)) throw error(400,'Enter an address or postcode.');
    if(listing.listing_kind==='general_lead') throw error(400,'This lead does not name an individual property.');
    const id=listing.id;
    const inProgress=active.get(id);
    if(inProgress) {
      if(body.location===undefined) return inProgress;
      throw error(429,'Travel times are being calculated. Try again in a moment.');
    }
    if(active.size>=3) throw error(429,'Several travel calculations are running. Try again in a moment.');
    const calculation=tryCheck(listing,body);
    active.set(id,calculation);
    try {
      return await calculation;
    } finally {
      active.delete(id);
    }
  }

  async function tryCheck(listing,body) {
    const storage='travel.listing.'+listing.id;
    const saved=await db.getConfig(storage);
    const manual=body.location===null ? null : body.location===undefined ? saved?.manual :
      addressInput(body.location,listing.city || '');
    if(body.location!=null && !manual) throw error(400,'Enter a street and house number or a full Dutch postcode.');
    const {input,key,origin}=options(listing,{manual});
    if(!input&&!origin) {
      if(body.location===null) await db.setConfig(storage,null);
      return show(listing,body.location===null ? null : saved);
    }
    const existing=show(listing,saved);
    if(saved?.key===key && existing.checkedAt && !existing.isStale && !!manual===!!saved.manual) return existing;
    return calculate(listing,{storage,saved,manual,input,key,sourceOrigin:origin});
  }

  async function calculate(listing,{storage,saved,manual,input,key,sourceOrigin}) {
    const {id}=listing;
    let origin;
    try {
      origin=sourceOrigin || (saved?.key===key && saved.result?.origin?.lat!=null ? saved.result.origin : await lookup(input));
      if(!origin&&!manual&&input.house&&input.street&&input.city){
        origin=await lookup({street:input.street,city:input.city,query:input.street+' '+input.city});
      }
    }
    catch { throw error(503,'The address lookup is temporarily unavailable. Try the map links or check again later.'); }
    if(!origin) throw error(422,'No matching address. Check the house number and city or enter the full postcode.');
    const places=await catalog(origin);
    // Route only to campuses a student could commute to; the UI estimates the rest from distance.
    const campuses=nearbyCampuses(origin);
    const destinations=[...campuses,nearest(places,origin,'gym'),nearest(places,origin,'supermarket')].filter(Boolean);
    const plan=streetTablePlan([origin],destinations,!motisBase && nearDelftRail(origin));
    const tableKey=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const reuse=saved?.key===key && saved.streetExpires>now() && saved.streetTables?.key===tableKey;
    const departure=sampleDeparture(now());
    const cachedOrQueue=mode=>!destinations.length ? {status:'no_route'} :
      reuse && saved.streetTables[mode]?.status==='ok' ? saved.streetTables[mode] : queueStreet(plan,mode);
    const [walk,bike,transit]=await Promise.all([
      cachedOrQueue('walk'),
      cachedOrQueue('bike'),
      motisBase ? Promise.all(destinations.map(destination=>transitRoute(fetcher,motisBase,origin,destination,departure)
        .catch(()=>({status:'unavailable'})))) : undefined,
    ]);
    const travelTimes=campusTravelTimes(0,origin,destinations,plan,{walk,bike,transit});
    const rows=destinations.map((destination,index)=>{
      const route=travelTimes[destination.id];
      const estimated=route?.source==='estimated' ? {status:'estimated',seconds:route.transit*60} : {status:'link'};
      return {...destination,routes:{walk:tableRoute(walk,0,index),bike:tableRoute(bike,0,index),transit:transit?.[index] ?? estimated}};
    });
    const latest=await db.getListing(id);
    if(!latest || latest.listing_kind==='general_lead' || options(latest,{manual}).key!==key) throw error(409,'The listing location changed. Open its details again.');
    const limited=rows.some(row=>Object.values(row.routes).some(route=>route.status==='unavailable'));
    const at=now();
    const amenitiesMissing=!!catalogCity(origin) && rows.length<campuses.length+2;
    const cacheDuration=limited || amenitiesMissing ? 10*MINUTE :
      motisBase ? DAY : 7*DAY;
    const expires=Math.min(at+cacheDuration,motisBase?departure:Infinity);
    const streetExpires=reuse ? saved.streetExpires : at+7*DAY;
    const result={status:'checked',origin,destinations:rows,travelTimes,transitEnabled:!!motisBase,mapVersion:MAP_VERSION,campusSignature:CAMPUS_SIGNATURE,
      checkedAt:new Date(at).toISOString(),sampleDeparture:motisBase?new Date(departure).toISOString():undefined};
    const record={key,manual,expires,streetExpires,streetTables:{key:tableKey,walk,bike},result};
    await db.setConfig(storage,record);
    return show(latest,record);
  }
  return {display,summary,check};
}
