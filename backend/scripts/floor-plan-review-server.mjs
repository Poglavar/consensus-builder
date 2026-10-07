#!/usr/bin/env node
// Local read-only preview of the agency archive; the production route lives in backend/index.js.
import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { setupFloorPlanArchiveRoute } from '../routes/floor-plan-archive.js';
if(process.argv.includes('--help')||!process.argv.includes('--port')) {console.log('Usage: node scripts/floor-plan-review-server.mjs --port PORT');process.exit(0);}
const port=Number(process.argv[process.argv.indexOf('--port')+1]);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,...(process.env.PGHOST?{host:process.env.PGHOST}:{})});
const app=express();
app.use((req,res,next)=>{if(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin||''))res.set('Access-Control-Allow-Origin',req.headers.origin);next();});
setupFloorPlanArchiveRoute(app,pool);
app.use((error,_req,res,_next)=>{console.error(error.message);res.status(500).json({error:'Archive read failed'});});
app.listen(port,'127.0.0.1',()=>console.log(`Floor-plan archive on http://localhost:${port}`));
