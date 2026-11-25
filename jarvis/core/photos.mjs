import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const HOSTS={kamernet:['resources.kamernet.nl'],housinganywhere:['housinganywhere.imgix.net'],roommatch:['www.roommatch.nl','roommatch.nl'],room:['www.roommatch.nl','roommatch.nl'],bjornd:['media01.ogonline.nl','media02.ogonline.nl','media03.ogonline.nl'],verra:['media01.ogonline.nl','media02.ogonline.nl','media03.ogonline.nl'],huizenbalie:['huizenbalie.nl','www.huizenbalie.nl'],funda:['cloud.funda.nl','images.funda.nl'],pararius:['images.pararius.com','images.pararius.nl']};
export const MAX_PHOTOS=8;
const MAX_BYTES=5*1024*1024,CACHE_BYTES=120*1024*1024;
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function photoURL(source,value,base){
 try{
  const u=new URL(value,base);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.href.length>4096)return null;
  const host=u.hostname.toLowerCase();if(!(HOSTS[source]?.includes(host)||source==='facebook'&&/^(?:[a-z0-9-]+\.)+fbcdn\.net$/.test(host)))return null;
  if(/(?:^|\/)(?:logo|avatar|profile|placeholder|icon|tracking|pixel)(?:[_.\/-]|$)/i.test(u.pathname)||/\.svg$/i.test(u.pathname))return null;
  if(source==='facebook'&&/\/(?:p|cp)\d+x\d+\//.test(u.pathname)&&/t1\./.test(u.pathname))return null;
  u.hash='';return u.href;
 }catch{return null;}
}
export function normalizePhotos(source,values=[],base){
 const seen=new Set(),result=[];
 for(const value of Array.isArray(values)?values:[]){const url=photoURL(source,typeof value==='string'?value:value?.url,base);if(!url||seen.has(url))continue;seen.add(url);result.push({url,alt:'Property photo '+(result.length+1)});if(result.length>=MAX_PHOTOS)break;}
 return result;
}
export function presentPhotos(listing){return normalizePhotos(listing.source,listing.photos).map((p,i)=>({url:'/api/listings/'+encodeURIComponent(listing.id)+'/photos/'+i+'?v='+createHash('sha256').update(p.url).digest('hex').slice(0,12),alt:p.alt}));}
function imageType(data){
 if(data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return 'image/jpeg';
 if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(data.toString('ascii',4,8)==='ftyp'&&/avif|avis/.test(data.toString('ascii',8,32)))return 'image/avif';
 return null;
}
export function createPhotoLoader(dataDir,{fetchImage=fetch}={}){
 const dir=join(dataDir,'photo-cache'),pending=new Map(),waiting=[];let active=0;
 async function acquire(){if(active<3){active++;return;}if(waiting.length>=18)throw fail(429,'Photos are loading. Try again in a moment.');await new Promise(resolve=>waiting.push(resolve));}
 function release(){const next=waiting.shift();if(next)next();else active--;}
 async function prune(){const files=await readdir(dir);const entries=await Promise.all(files.filter(f=>/^[a-f0-9]{64}\.img$/.test(f)).map(async f=>({file:join(dir,f),...(await stat(join(dir,f)))})));let total=entries.reduce((n,e)=>n+e.size,0);for(const e of entries.sort((a,b)=>a.mtimeMs-b.mtimeMs)){if(total<=CACHE_BYTES)break;await unlink(e.file).catch(()=>{});total-=e.size;}}
 async function load(source,value){
  const url=photoURL(source,value);if(!url)throw fail(404,'No verified property photo is available.');
  const key=createHash('sha256').update(url).digest('hex'),file=join(dir,key+'.img');
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   await mkdir(dir,{recursive:true,mode:0o700});
   try{const info=await stat(file);if(info.size<=MAX_BYTES&&Date.now()-info.mtimeMs<86400000){const data=await readFile(file);const type=imageType(data);if(type)return {data,type};}}catch{}
   await acquire();
   try{
    let target=url,response;const signal=AbortSignal.timeout(12000);
    for(let hop=0;hop<4;hop++){
     response=await fetchImage(target,{redirect:'manual',signal,headers:{accept:'image/avif,image/webp,image/jpeg,image/png','user-agent':'Housewatch/1.0 property-photo viewer'}});
     if([301,302,303,307,308].includes(response.status)){const next=photoURL(source,response.headers.get('location'),target);await response.body?.cancel();if(!next)throw fail(502,'The source photo is unavailable.');target=next;continue;}break;
    }
    if(!response.ok||!/^image\/(?:jpeg|png|webp|avif)(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw fail(502,'The source photo is unavailable.');}
    if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw fail(502,'The source photo is too large.');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw fail(502,'The source photo is too large.');chunks.push(chunk);}const data=Buffer.concat(chunks);const type=imageType(data);if(!type)throw fail(502,'The source did not return a supported property photo.');
    const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,data,{mode:0o600});await rename(temporary,file);await prune().catch(()=>{});return {data,type};
   }finally{release();}
  })().catch(error=>{if(error.status)throw error;throw fail(502,'The source photo is unavailable.');}).finally(()=>pending.delete(key));pending.set(key,task);return task;
 }
 return load;
}
