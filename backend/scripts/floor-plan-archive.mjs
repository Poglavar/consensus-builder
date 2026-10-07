#!/usr/bin/env node
// Runs the evidence archive; no paid calls or unreviewed model publication.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { importAgencies,enqueue,coverage } from '../floor-plans/archive.js';
import { crawl } from '../floor-plans/crawler.js';
import { importUnitModels } from '../floor-plans/unit-models.js';
import { daily } from '../floor-plans/daily.js';
import { reparseListings } from '../floor-plans/reparse.js';
import { processAssets } from '../floor-plans/process-assets.js';
import { matchBuildingCandidates } from '../floor-plans/building-links.js';
import { importSites,importWebsiteCandidates,verifyArchivedSites } from '../floor-plans/agency-sites.js';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
if(args.includes('--help')||!args.length) {
 console.log(`Usage: node scripts/floor-plan-archive.mjs <init|import|sites|websites|verify-sites|models|crawl|extract|match|reparse|daily|status|enqueue> [options]
 init                         Apply archive DDL as geo_user
 import --registry FILE [--websites FILE]
 enqueue --url URL [--agency ID] [--kind home|page|asset|sitemap]
 crawl [--max-pages 1000] [--max-minutes 45] [--agency ID]
 sites --file FILE            Import directory-linked site candidates
 websites --file FILE         Import registry-mapped website search candidates
 verify-sites                 Recheck legal identity on archived home/contact pages
 models --file FILE           Import reviewed unit geometry against archived source hashes
 extract [--max-assets 100]    OCR and source linework into reviewable drafts
 match                        Suggest building candidates from property coordinates
 reparse                      Rebuild current listing associations from archived HTML
 daily [--max-pages 5000] [--max-minutes 120] [--max-assets 500]
 status                       Print coverage and recent run
Environment: backend/.env, PGHOST override or DATABASE_URL. Public sources only.
Incomplete/blocked crawl exits 2 and preserves prior evidence.`);process.exit(0);
}
dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const connectionString=process.env.DATABASE_URL;
const client=new pg.Client(connectionString?{connectionString,...(process.env.PGHOST?{host:process.env.PGHOST}:{})}:undefined);
const json=async path=>JSON.parse(await readFile(path,'utf8'));
await client.connect();
try {
 const action=args[0];let result;
 if(action==='init') {await client.query(await readFile(new URL('../db/floor-plan-archive.sql',import.meta.url),'utf8'));result={initialized:true};}
 else if(action==='import') {const matches=args.includes('--websites')?await json(option('--websites')):[];result=await importAgencies(client,await json(option('--registry')),Array.isArray(matches)?matches:matches.records || matches.matches || []);}
 else if(action==='verify-sites') result=await verifyArchivedSites(client);
 else if(action==='websites') result=await importWebsiteCandidates(client,await json(option('--file')));
 else if(action==='sites') result=await importSites(client,await json(option('--file')));
 else if(action==='models') result=await importUnitModels(client,await json(option('--file')));
 else if(action==='enqueue') result={enqueued:await enqueue(client,option('--url'),{agencyId:args.includes('--agency')?Number(option('--agency')):null,kind:args.includes('--kind')?option('--kind'):'page',priority:100})};
 else if(action==='extract') {result=await processAssets(client,{maxAssets:args.includes('--max-assets')?Number(option('--max-assets')):100});if(result.status!=='complete') process.exitCode=2;}
 else if(action==='match') result=await matchBuildingCandidates(client);
 else if(action==='reparse') result=await reparseListings(client);
 else if(action==='daily') {result=await daily(client,{maxPages:args.includes('--max-pages')?Number(option('--max-pages')):5000,maxMinutes:args.includes('--max-minutes')?Number(option('--max-minutes')):120,maxAssets:args.includes('--max-assets')?Number(option('--max-assets')):500});if(result.status!=='complete') process.exitCode=2;}
 else if(action==='crawl') {
  const maxPages=args.includes('--max-pages')?Number(option('--max-pages')):1000,maxMinutes=args.includes('--max-minutes')?Number(option('--max-minutes')):45;
  if(!Number.isInteger(maxPages)||maxPages<1||!Number.isFinite(maxMinutes)||maxMinutes<=0) throw new Error('Positive crawl limits required.');
  result=await crawl(client,{maxPages,maxMinutes,agencyId:args.includes('--agency')?Number(option('--agency')):null});
  if(result.status!=='complete') process.exitCode=2;
 } else if(action==='status') result={coverage:await coverage(client),lastRun:(await client.query('SELECT id,status,counters,finished_at,updated_at FROM floor_plan.run ORDER BY created_at DESC LIMIT 1')).rows[0] || null,pipeline:(await client.query('SELECT * FROM floor_plan.pipeline_run ORDER BY created_at DESC LIMIT 1')).rows[0] || null};
 else throw new Error(`Unknown action: ${action}`);
 console.log(JSON.stringify(result,null,2));
} finally {await client.end();}
