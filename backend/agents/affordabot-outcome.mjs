#!/usr/bin/env node
// Bot monitor checks Affordabot's durable run, mirrored publications and outreach queue together.
import 'dotenv/config';
import { createPool } from '../db/connection.cjs';
const pool=createPool();
try {
    const {rows}=await pool.query(`SELECT status,started_at,summary,
      (SELECT max(p.created_at) FROM proposal p WHERE p.proposal_data->'agent'->>'persona'='affordabot') AS last_published_at
      FROM consensus.agent_run WHERE persona='affordabot' ORDER BY started_at DESC LIMIT 1`);
    const r=rows[0], s=r?.summary || {}, posts=Object.values(s.posts || {}), outreach=s.outreach || [];
    const publicationAgeHours=r?.last_published_at ? Math.max(0,(Date.now()-Date.parse(r.last_published_at))/3600000) : 999999;
    const complete = r?.status==='done' && ['completed','no-picks'].includes(s.outcome)
      && (!posts.length || (posts.every(p=>p.proposalId && p.id) && outreach.length===posts.length));
    console.log(JSON.stringify({runStatus:complete?'completed':'failed',lastRunStartedAt:r?.started_at || null,
       publicationAgeHours,outcome:s.outcome || null,published:posts.length,queued:outreach.length,lastPublishedAt:r?.last_published_at || null}));
} finally {await pool.end();}
