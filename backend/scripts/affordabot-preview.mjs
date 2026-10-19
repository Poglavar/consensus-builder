#!/usr/bin/env node
// Loopback-only preview of the real Affordabot route and the feature worktree's frontend.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/connection.cjs';
import { setupAffordabotRoute } from '../routes/affordabot.js';
if(!process.argv.includes('--port')||process.argv.includes('--help')){console.log('Usage: node --env-file=.env scripts/affordabot-preview.mjs --port PORT');process.exit(0);}
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
const pool=createPool({statement_timeout:30000,max:2}),app=express();
app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use(express.json({limit:'32kb'}));setupAffordabotRoute(app,pool);
app.use(express.static(fileURLToPath(new URL('../../frontend',import.meta.url))));
const server=app.listen(port,'127.0.0.1',()=>console.log(`Affordabot preview: http://localhost:${port}/affordabot.html`));
const stop=()=>{server.close(()=>pool.end().then(()=>process.exit(0)));};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
