#!/usr/bin/env node
// Read-only review queue: one draft per published proposal, never sends email or X messages.
import 'dotenv/config';
import { createPool } from '../db/connection.cjs';
if (!process.argv.includes('--list')) { console.log('Usage: node agents/affordabot-outreach.mjs --list (read-only; sends nothing)'); process.exit(0); }
const pool=createPool();
try {
    const {rows}=await pool.query(`SELECT run_id, status, summary->'outreach' AS outreach FROM consensus.agent_run WHERE persona='affordabot' AND summary ? 'outreach' ORDER BY started_at DESC LIMIT 30`);
    console.log(JSON.stringify(rows,null,2));
} finally { await pool.end(); }
