// Incremental public-site crawl with durable discovery and immutable source bytes.
import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import { extractPageEvidence } from './page-evidence.js';
import { fetchPublic } from './fetch-public.js';
import { enqueue,saveObservation,coverage } from './archive.js';
import { verifySiteFromPage } from './agency-sites.js';
import { countPendingTargets, createTargetSelector } from './crawl-queue.js';
const sameSite=(a,b)=>new URL(a).hostname.replace(/^www\./,'')===new URL(b).hostname.replace(/^www\./,'');
export function discoverTargets(target,response,evidence) {
 if(target.kind==='asset') return [];
 const type=response.headers.contentType || '';
 if(/xml/i.test(type)||/^\s*<\?xml|<urlset|<sitemapindex/.test(response.body.toString('utf8',0,500))) {
  const $=cheerio.load(response.body.toString(),{xmlMode:true});
  return $('loc').toArray().map(el=>({url:$(el).text().trim(),kind:$(el).parent().is('sitemap')?'sitemap':'page',priority:/zagreb|sesvete/i.test($(el).text())?45:(/novograd|new-build|projekt|project/i.test($(el).text())?30:10)})).filter(x=>{try{return sameSite(x.url,target.url);}catch{return false;}});
 }
 const links=(evidence.links || []).filter(link=>sameSite(link.url,response.finalUrl || target.url)
  && !/\.(?:css|js|woff2?|zip|mp4|svg|png|jpe?g|webp|pdf|avif)(?:$|\?)/i.test(link.url)
  && !/logout|login|prijava|register|registracija|cart|wp-admin|\?s=|[?&](?:sort|order|share)=/i.test(link.url));
 return [...links.map(link=>({url:link.url,kind:'page',priority:{project:30,listing:20,pagination:25,contact:55,other:0}[link.kind] || 0})),
  ...(evidence.assets || []).filter(asset=>['floor-plan','document'].includes(asset.kind) || (evidence.listing && asset.listingOwned===true && asset.kind==='image' && asset.listingGallery)).map(asset=>({url:asset.url,kind:'asset',priority:asset.kind==='image'?15:100}))];
}
export async function crawl(db,{maxPages=1000,maxMinutes=45,agencyId=null,fetcher=fetchPublic,log=console.log,now=Date.now,selectTarget=null,discoveryOnly=false,assetOnly=false,matchedAssetsOnly=false}={}) {
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Another floor-plan crawl is already running.');
 const pageBudget=Number.isFinite(maxPages)?Math.max(0,Math.floor(maxPages)):1000;
 const timeBudgetMinutes=Number.isFinite(maxMinutes)?Math.max(0,maxMinutes):45;
 const id=randomUUID(),started=now(),counters={fetched:0,unchanged:0,changed:0,discovered:0,failed:0,blocked:0},errors=[];
 const nextTarget=selectTarget || createTargetSelector({agencyId,discoveryOnly,assetOnly,matchedAssetsOnly});
 try {
  await db.query(`UPDATE floor_plan.run SET status='interrupted',finished_at=now(),updated_at=now() WHERE status='running'`);
  await db.query(`INSERT INTO floor_plan.run(id,status) VALUES($1,'running')`,[id]);
  while(counters.fetched<pageBudget && now()-started<timeBudgetMinutes*60000) {
   const target=await nextTarget(db);
   if(!target) break;
   counters.fetched++;
   try {
    // Fresh asset bytes detect replaced plans even when the URL remains unchanged.
    const response=await fetcher(target.url,{etag:target.kind==='asset'?null:target.etag,lastModified:target.kind==='asset'?null:target.last_modified});
    if(response.notModified && target.current_sha256) {
     counters.unchanged++;
     await db.query(`UPDATE floor_plan.target SET state='ok',failure=NULL,http_status=304,last_fetched_at=now(),next_check_at=now()+interval '1 day',updated_at=now() WHERE url=$1`,[target.url]);
    } else {
     const html=/html/i.test(response.headers.contentType || '');
     const evidence=html && response.body?extractPageEvidence(response.body.toString(),response.finalUrl || target.url):{assets:[],links:[],listing:null};
     if(response.blockedReason || evidence.blocked) throw Object.assign(new Error(response.blockedReason || evidence.blockedReason),{blocked:true,httpStatus:response.status});
     if(response.status<200||response.status>=300||!response.body?.length) throw Object.assign(new Error(`HTTP ${response.status}: empty or unsuccessful source`),{httpStatus:response.status});
     if(target.kind==='asset' && html) throw new Error('Expected asset but received HTML.');
     await db.query('BEGIN');
     try {
      const saved=await saveObservation(db,target,response,evidence,id);
      counters[saved.changed?'changed':'unchanged']++;
      if(target.kind==='asset') await db.query(`UPDATE floor_plan.target SET next_check_at=now()+interval '30 days',updated_at=now() WHERE url=$1`,[target.url]);
      if(html) await verifySiteFromPage(db,target,response.body.toString(),response.finalUrl);
      const discovered=discoverTargets(target,response,evidence);
      for(const item of discovered) {
       if(await enqueue(db,item.url,{agencyId:target.agency_id,kind:item.kind,priority:item.priority,from:target.url})) counters.discovered++;
       else if(saved.changed && item.kind==='asset' && evidence.listing && evidence.assets.some(asset=>asset.url===item.url && asset.listingOwned===true)) {
        await db.query(`UPDATE floor_plan.target SET next_check_at=LEAST(next_check_at,now()),agency_id=COALESCE(agency_id,$2),updated_at=now() WHERE url=$1`,[item.url,target.agency_id]);
       }
      }
      await db.query('COMMIT');
     } catch(error) {await db.query('ROLLBACK');throw error;}
    }
   } catch(error) {
    counters[error.blocked?'blocked':'failed']++;
    if(errors.length<100) errors.push({url:target.url,error:error.message});
    await db.query(`UPDATE floor_plan.target SET state=$2,failure=$3,http_status=$4,last_fetched_at=now(),next_check_at=now()+interval '1 day',updated_at=now() WHERE url=$1`,[target.url,error.blocked?'blocked':([404,410].includes(error.httpStatus)?'gone':'error'),error.message,error.httpStatus || null]);
   }
   await db.query(`UPDATE floor_plan.run SET counters=$2,errors=$3,updated_at=now() WHERE id=$1`,[id,JSON.stringify(counters),JSON.stringify(errors)]);
   log(JSON.stringify({at:new Date().toISOString(),run:id,...counters,elapsedSeconds:Math.round((now()-started)/1000),current:target.url}));
  }
  const {pending,deferredUnmatchedAssets}=await countPendingTargets(db,{agencyId,discoveryOnly,assetOnly,matchedAssetsOnly});
  const status=counters.failed||counters.blocked||pending?'partial':'complete';
  const result={id,status,counters,pending,deferredUnmatchedAssets,errors,coverage:await coverage(db)};
  await db.query(`UPDATE floor_plan.run SET status=$2,counters=$3,errors=$4,finished_at=now(),updated_at=now() WHERE id=$1`,[id,status,JSON.stringify({...counters,pending,deferredUnmatchedAssets}),JSON.stringify(errors)]);
  return result;
 } catch(error) {
  await db.query(`UPDATE floor_plan.run SET status='failed',errors=$2,finished_at=now(),updated_at=now() WHERE id=$1`,[id,JSON.stringify([...errors,{error:error.message}])]);
  throw error;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl'))`);}
}
