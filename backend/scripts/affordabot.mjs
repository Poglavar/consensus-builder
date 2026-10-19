#!/usr/bin/env node
// Run a bounded housing scan manually or from a scheduler; stdout is the portable research artifact.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createPool } from '../db/connection.cjs';
import { scanHousing } from '../affordabot/scan.js';
const args=process.argv.slice(2);
if(!args.length||args.includes('--help')){
    console.log('Usage: node --env-file=.env scripts/affordabot.mjs --scan [--config FILE] [--output FILE]\nConfig: {bbox, minAreaM2, maxAreaM2, sampleLimit, limit, reform, assumptions}. No posting or paid model calls.');
    process.exit(0);
}
const opts={};
for(let i=0;i<args.length;i++){
    if(args[i]==='--scan'){opts.scan=true;continue;}
    if(!['--config','--output'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Invalid arguments; use --help');
    opts[args[i].slice(2)]=args[++i];
}
if(!opts.scan)throw new Error('--scan is required');
const config=opts.config?JSON.parse(await readFile(opts.config,'utf8')):{};
const pool=createPool({statement_timeout:30000,max:1});
try{
    console.error(`[${new Date().toISOString()}] Affordabot: starting bounded scan`);
    const result=await scanHousing(pool,config),artifact=JSON.stringify(result,null,2)+'\n';
    if(opts.output){const temp=`${opts.output}.tmp-${process.pid}`;await writeFile(temp,artifact);await rename(temp,opts.output);}
    else process.stdout.write(artifact);
    console.error(`[${new Date().toISOString()}] ${result.status}: ${result.scanned} parcels, ${result.candidates.length} leads, ${result.failures.length} failures; LLM $0`);
    if(result.failures.length)process.exitCode=1;
}finally{await pool.end();}
