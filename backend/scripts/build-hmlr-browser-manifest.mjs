// Builds land-to-ZIP scopes and a global native-ID routing directory. Parcel geometry is
// consumed one feature at a time and is never written to disk.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hmlrRoutingProjection } from '../parcels/hmlr-routing-projection.js';
import { fetchHmlrCatalogue, pinHmlrAuthority } from '../parcels/hmlr-catalogue.js';
import { officialArchiveFetch, boundedBytes } from '../parcels/gml-snapshot-source.js';
import { readGmlZipMember } from '../parcels/gml-zip-reader.js';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';
import { HMLR_BROWSER_GROUND_POLICY } from '../parcels/hmlr-browser-ground.js';
import { createHmlrArchiveScopeBuilder, validateHmlrArchiveScope } from '../parcels/hmlr-archive-scope.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const atomic = async (path, data) => { const temp=`${path}.${process.pid}.tmp`; await writeFile(temp,data); await rename(temp,path); };
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const numericCmp=(a,b)=>a.length-b.length||cmp(a,b);
const log=message=>console.log(`[${new Date().toISOString()}] [hmlr-browser-manifest] ${message}`);
const MAX_AUTHORITY_FEATURES=1_500_000;

export function projectNativeBounds(bounds) {
    if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3])throw new Error('Invalid native HMLR extent.');
    const project=hmlrRoutingProjection, points=[];
    const steps=Math.max(1,Math.ceil(Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1])/1000));
    for(let i=0;i<=steps;i++){const t=i/steps,x=bounds[0]+(bounds[2]-bounds[0])*t,y=bounds[1]+(bounds[3]-bounds[1])*t;
        points.push(project.forward([x,bounds[1]]),project.forward([x,bounds[3]]),project.forward([bounds[0],y]),project.forward([bounds[2],y]));}
    const out=[Math.min(...points.map(p=>p[0]))-.01,Math.min(...points.map(p=>p[1]))-.01,Math.max(...points.map(p=>p[0]))+.01,Math.max(...points.map(p=>p[1]))+.01];
    if(out[0]<-9||out[1]<49||out[2]>3||out[3]>61)throw new Error('HMLR authority extent falls outside the verified England bounds.');
    return out.map(v=>Math.round(v*1e6)/1e6);
}
export function canonicalId(value){const s=String(value);if(!/^\d{1,64}$/.test(s))throw new Error('Invalid native HMLR ID.');return s.replace(/^0+(?=\d)/,'');}
export function bucketForId(id){return id.length<4?id:id.slice(0,4);}
export function makeCore(sourceDate,authorities,buckets){return {schemaVersion:2,sourceDate,policy:HMLR_BROWSER_GROUND_POLICY,authorities,idDirectory:buckets};}
function checkpointPayload(value){const {metadataSha256,...payload}=value;return payload;}
function checkpointHash(value){const {ids,...metadata}=checkpointPayload(value);return sha(JSON.stringify({metadata,idsSha256:value.idsSha256}));}
function validCheckpoint(value,a,sourceDate){
 try{
  if(!value||value.schemaVersion!==2||value.name!==a.name||value.endpoint!==a.endpoint||value.sourceDate!==sourceDate
   ||value.etag!==a.expectedEtag||value.bytes!==a.expectedBytes||!/^[a-f0-9]{64}$/.test(value.archiveSha256||'')
   ||!Number.isSafeInteger(value.featureCount)||value.featureCount<1||value.featureCount>MAX_AUTHORITY_FEATURES
   ||!Array.isArray(value.ids)||value.ids.length!==value.featureCount
   ||value.ids.some((id,i)=>canonicalId(id)!==id||(i>0&&numericCmp(value.ids[i-1],id)>=0))
   ||value.idsSha256!==sha(JSON.stringify(value.ids))||value.metadataSha256!==checkpointHash(value))return false;
  const bounds=value.nativeBounds,projected=value.bounds;
  if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]
    ||JSON.stringify(projectNativeBounds(bounds))!==JSON.stringify(projected))return false;
  validateHmlrArchiveScope(value.scope,value);
  const scopeJson=JSON.stringify(value.scope);
  if(value.scopeSha256!==sha(scopeJson)||value.scopeBytes!==Buffer.byteLength(scopeJson)||value.scopeBytes>16*1024*1024)return false;
  return true;
 }catch{return false;}
}
export function parseCliArgs(args){
 const seen=new Set();let out,baseUrl,run=false;
 for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--run'){if(run)throw new Error('Duplicate --run flag.');run=true;continue;}
  if(!['--out','--base-url'].includes(arg))throw new Error(`Unknown argument ${arg}.`);
  if(seen.has(arg))throw new Error(`Duplicate ${arg} flag.`);seen.add(arg);const value=args[++i];
  if(!value||value.startsWith('--'))throw new Error(`${arg} requires a value.`);if(arg==='--out')out=value;else baseUrl=value;
 }
 if(!run)return null;if(!out||!baseUrl)throw new Error('--run requires --out and --base-url.');
 return {out,baseUrl};
}

async function catalogue(fetcher){return fetchHmlrCatalogue({fetchArchive:fetcher});}
async function boundedResponse(response,limit,signal){try{return await boundedBytes(response,limit,signal);}catch(error){await response.body?.cancel().catch(()=>{});throw error;}}
const sortedCatalogue=cat=>({...cat,authorities:[...cat.authorities].sort((a,b)=>cmp(a.name,b.name))});
export async function buildManifest({out,baseUrl,fetcher=officialArchiveFetch,catalogueFn=catalogue,parse=parseGmlParcels,pin=pinHmlrAuthority}){
 if(!out||!baseUrl)throw new Error('Output directory and explicit HTTPS base URL are required.');
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Base URL must be an explicit HTTPS URL.');
 await mkdir(join(out,'checkpoints'),{recursive:true});
 const cat=sortedCatalogue(await catalogueFn(fetcher)), authorities=[]; let failures=[];
 // Pin the complete national catalogue before opening any archive payload.
 const pins=[]; for(let i=0;i<cat.authorities.length;i++){const a=cat.authorities[i];pins.push(await pin(a,{fetchArchive:fetcher}));log(`pinned ${i+1}/${cat.authorities.length} ${a.name}`);}
 const stage=join(out,'id-stage');await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
 const started=Date.now();let finished=0;
 for(let index=0;index<pins.length;index++){
  const authorityStarted=Date.now(),a=pins[index], key=sha(a.expectedEtag), path=join(out,'checkpoints',`${a.name}.${key}.json`); let checkpoint,resumed=false;
  try{checkpoint=JSON.parse(await readFile(path,'utf8'));if(validCheckpoint(checkpoint,a,cat.sourceDate))resumed=true;else checkpoint=null;}catch{checkpoint=null;}
  if(!checkpoint)try{
   const signal=AbortSignal.timeout(10*60*1000),response=await fetcher(a.endpoint,{signal});
   if(response.status!==200||!response.ok||response.headers.get('etag')!==a.expectedEtag||Number(response.headers.get('content-length'))!==a.expectedBytes){await response.body?.cancel().catch(()=>{});throw new Error('Archive revision differs from pinned catalog.');}
   const bytes=await boundedResponse(response,128*1024*1024,signal),archiveSha256=sha(bytes),ids=new Set();let extent=null;
   const project=hmlrRoutingProjection,scopeBuilder=createHmlrArchiveScopeBuilder(point=>project.forward(point));
   const parsed=await parse(readGmlZipMember(bytes,1024*1024*1024,signal),{coordinateMode:'native',idField:'INSPIREID',maxBytes:1024*1024*1024,maxFeatures:MAX_AUTHORITY_FEATURES,signal,onFeature:f=>{ids.add(canonicalId(f.properties.INSPIREID));scopeBuilder.addGeometry(f.geometry);const g=f.geometry,coords=g.type==='Polygon'?[g.coordinates]:g.coordinates;for(const poly of coords)for(const ring of poly)for(const [x,y] of ring)extent=extent?[Math.min(extent[0],x),Math.min(extent[1],y),Math.max(extent[2],x),Math.max(extent[3],y)]:[x,y,x,y];}});
   const list=[...ids].sort(numericCmp); if(!list.length||parsed.featureCount!==list.length||parsed.numberMatched!==list.length||parsed.numberReturned!==list.length||!extent||!parsed.sourceTimestamp||parsed.sourceTimestamp.slice(0,10)!==cat.sourceDate)throw new Error('Archive is empty, duplicated, partial, or from a different edition.');
   const scope=scopeBuilder.finish(archiveSha256),scopeJson=JSON.stringify(scope),scopeBytes=Buffer.byteLength(scopeJson);
   if(scopeBytes>16*1024*1024)throw new Error('Authority land scope exceeds 16 MiB.');
   checkpoint={schemaVersion:2,name:a.name,endpoint:a.endpoint,sourceDate:cat.sourceDate,etag:a.expectedEtag,bytes:a.expectedBytes,archiveSha256,featureCount:list.length,nativeBounds:extent,bounds:projectNativeBounds(extent),scope,scopeSha256:sha(scopeJson),scopeBytes,ids:list,idsSha256:sha(JSON.stringify(list))};
   validateHmlrArchiveScope(scope,checkpoint);checkpoint.metadataSha256=checkpointHash(checkpoint);await atomic(path,JSON.stringify(checkpoint));
  }catch(error){failures.push(`${a.name}: ${error.message}`);log(`FAILED ${index+1}/${pins.length} ${a.name}: ${error.message}`);continue;}
  const rows=new Map();for(const id of checkpoint.ids){const bucket=bucketForId(id);if(!rows.has(bucket))rows.set(bucket,[]);rows.get(bucket).push(`${id}\t${index}\n`);}
  for(const [bucket,lines] of rows)await appendFile(join(stage,`${bucket}.ndjson`),lines.join(''));
  authorities.push({name:a.name,endpoint:a.endpoint,etag:a.expectedEtag,bytes:a.expectedBytes,archiveSha256:checkpoint.archiveSha256,featureCount:checkpoint.featureCount,nativeBounds:checkpoint.nativeBounds,bounds:checkpoint.bounds,scope:{sha256:checkpoint.scopeSha256,bytes:checkpoint.scopeBytes}});
  await atomic(join(stage,`${index}.scope.json`),JSON.stringify(checkpoint.scope));
  finished++;const elapsed=Date.now()-started,average=elapsed/finished,eta=Math.ceil((average*(pins.length-index-1))/1000);
  log(`${resumed?'resumed':'processed'} ${index+1}/${pins.length} ${a.name}; ${checkpoint.featureCount} IDs, ${checkpoint.bytes} archive bytes; estimated ${eta}s remaining (authority ${Date.now()-authorityStarted}ms)`);
 }
 if(failures.length)throw new Error(`Incomplete HMLR manifest; no publication: ${failures.join('; ')}`);
 const root=join(out,'staging');await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});const directory={};
 for(const file of (await readdir(stage)).filter(file=>file.endsWith('.ndjson')).sort(cmp)){const bucket=file.slice(0,-7), lines=(await readFile(join(stage,file),'utf8')).trimEnd().split('\n'),map=new Map();for(const line of lines){const [id,idx]=line.split('\t');if(!map.has(id))map.set(id,[]);map.get(id).push(Number(idx));}const ordered=Object.fromEntries([...map.keys()].sort(numericCmp).map(id=>[id,[...new Set(map.get(id))].sort((a,b)=>a-b)])),json=JSON.stringify(ordered),bytes=Buffer.byteLength(json);if(bytes>16*1024*1024)throw new Error(`ID bucket ${bucket} exceeds 16 MiB.`);const hash=sha(json),filename=`${bucket}.${hash}.json`;await atomic(join(root,filename),json);directory[bucket]={sha256:hash,bytes};}
 const scopeSample=cat.authorities.length<250;
 const core=makeCore(cat.sourceDate,authorities,directory),releaseId=sha(JSON.stringify(core));
 const latest=sortedCatalogue(await catalogueFn(fetcher));if(JSON.stringify(latest)!==JSON.stringify(cat))throw new Error('HMLR catalogue changed before publication.');
 for(const a of pins){const check=await pin({name:a.name,endpoint:a.endpoint},{fetchArchive:fetcher});if(check.expectedEtag!==a.expectedEtag||check.expectedBytes!==a.expectedBytes)throw new Error('HMLR archive pin changed before publication.');}
 const release=join(out,releaseId);await mkdir(join(release,'ids'),{recursive:true});for(const [bucket,info] of Object.entries(directory)){const filename=`${bucket}.${info.sha256}.json`;await atomic(join(release,'ids',filename),await readFile(join(root,filename)));info.url=`${base.href.replace(/\/$/,'')}/${releaseId}/ids/${filename}`;}
 await mkdir(join(release,'scopes'),{recursive:true});
 for(let index=0;index<authorities.length;index++){const info=authorities[index].scope,filename=`${index}.${info.sha256}.json`;await atomic(join(release,'scopes',filename),await readFile(join(stage,`${index}.scope.json`)));info.url=`${base.href.replace(/\/$/,'')}/${releaseId}/scopes/${filename}`;}
 const manifest={...core,releaseId,...(scopeSample?{scopeSample:true}:{})};await atomic(join(release,'manifest.json'),JSON.stringify(manifest));if(!scopeSample)await atomic(join(out,'manifest.json'),JSON.stringify(manifest));return manifest;
}
async function main(){const options=parseCliArgs(process.argv.slice(2));if(!options){console.log('Usage: node backend/scripts/build-hmlr-browser-manifest.mjs --run --out <ignored-dir> --base-url https://host/path');return;}await buildManifest(options);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
