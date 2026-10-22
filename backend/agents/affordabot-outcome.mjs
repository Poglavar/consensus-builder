#!/usr/bin/env node
// Bot monitor checks Affordabot's durable run, its published agreements and outreach queue together.
import 'dotenv/config';
import { createPool } from '../db/connection.cjs';
const pool=createPool();
try {
    const {rows}=await pool.query(`SELECT status,started_at,summary,
      (SELECT max(a.created_at) FROM consensus.agreement a WHERE a.author='affordabot') AS last_published_at
      FROM consensus.agent_run WHERE persona='affordabot' ORDER BY started_at DESC LIMIT 1`);
    const r=rows[0], s=r?.summary || {}, published=Object.values(s.agreements || {}).filter(a=>a?.cid && a.indexedAt), outreach=s.outreach || [];
    const publicationAgeHours=r?.last_published_at ? Math.max(0,(Date.now()-Date.parse(r.last_published_at))/3600000) : 999999;
    const complete = r?.status==='done' && ['completed','no-picks'].includes(s.outcome)
      && (!published.length || outreach.length===published.length);
    console.log(JSON.stringify({runStatus:complete?'completed':'failed',lastRunStartedAt:r?.started_at || null,
       publicationAgeHours,outcome:s.outcome || null,published:published.length,queued:outreach.length,lastPublishedAt:r?.last_published_at || null}));
} finally {await pool.end();}
