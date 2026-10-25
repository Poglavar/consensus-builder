// Local-only harness for headless and headed points previews.
// Only the agreement source is simulated; account, trade, settlement and claim routes use local PostgreSQL.
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import database from '../db/connection.cjs';
import { buildContests } from '../markets/contests.js';
import { setupBetsPointsRoutes } from '../routes/bets-points.js';
import { setupBetsEventsRoute } from '../routes/bets-events.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
dotenv.config({ path: resolve(root, '.env'), quiet: true });
const host = process.env.POINTS_PREVIEW_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Points preview must bind loopback only');
const target = database.describeDatabase();
if (!database.isLocalDatabase() || target.database !== 'geodata') throw new Error('Refusing preview: DATABASE_URL must target local geodata');
const run = process.env.POINTS_PREVIEW_RUN;
if (!/^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(run || '')) throw new Error('Set a unique POINTS_PREVIEW_RUN slug');
const account = new PublicKey(Buffer.alloc(32, 23)).toBase58();
const cid = `simulated-points-${randomBytes(4).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);
const createdAt = new Date().toISOString();
let simulatedClock = null;
const source = { account, cid, city: 'San Francisco (simulated preview)', closesAt: now() + 7200,
  chainTime: now(), graceSeconds: 0, chainStatus: 'active', executedAt: null, insiders: [] };
let dropNextTradeResponse = false;
const app = express(); app.use(cors({ origin: ['http://localhost:5681','http://127.0.0.1:5681'] })); app.use(express.json());
app.get('/health', (_req,res) => res.json({status:'ok', mode:'simulated-agreement-real-postgres-ledger', simulationRun:run, account, label:'SIMULATION ONLY'}));
app.get('/markets', (req,res) => {
  if (!['sf','san_francisco'].includes(req.query.city)) return res.status(404).json({error:'unknown city'});
  const entry = { cid, city: source.city, title:'SIMULATED: points preview agreement', description:'SIMULATION ONLY — local preview; no public agreement or people represented.',
    account, deadline:new Date(source.closesAt*1000).toISOString(), createdAt, chainStatus:source.chainStatus,
    inputParcelIds:[], sponsor:null };
  res.set('Cache-Control','no-store').json({...buildContests({city:'sf',agreements:[entry]}),simulation:{label:'SIMULATION ONLY',source:'harness-controlled; no chain RPC'}});
});
app.post('/__simulation/state', (req,res) => {
  const {chainStatus, executedAt, chainTime, closesAt} = req.body || {};
  if (!['active','executed','cancelled','expired'].includes(chainStatus)) return res.status(400).json({error:'invalid simulated state'});
  source.chainStatus=chainStatus; source.executedAt=executedAt ?? (chainStatus==='executed' ? now()-1 : null);
  simulatedClock=Number.isSafeInteger(chainTime) ? chainTime : null;
  source.chainTime=simulatedClock ?? now(); if(Number.isSafeInteger(closesAt)) source.closesAt=closesAt;
  res.json({label:'SIMULATION ONLY', source:{...source}});
});
app.post('/__simulation/lose-next-trade-response', (_req,res) => { dropNextTradeResponse = true; res.json({label:'SIMULATION ONLY',armed:true}); });
const pool=database.createPool({max:4,connectionTimeoutMillis:5000});
app.use('/bets/points', (req,res,next) => {
  const supplied = req.method === 'GET' ? req.query.simulationRun : req.body?.simulationRun;
  if (supplied !== run) return res.status(403).json({error:'simulation_run_required',message:'This local preview accepts only its isolated simulationRun.'});
  next();
});
app.use('/bets/points/trade', (req,res,next) => {
  if (!dropNextTradeResponse) return next();
  dropNextTradeResponse = false;
  // The real route commits before res.json(). Replace that response after the commit with a
  // simulated upstream failure, hiding the receipt while retaining the browser's request ID.
  const send = res.json.bind(res);
  res.json = () => { res.status(502); return send({error:'simulated_response_lost',message:'The receipt response was interrupted after commit.'}); };
  next();
});
setupBetsPointsRoutes(app,pool,{readAgreement:async a=>{if(a!==account)throw Object.assign(new Error('unknown simulated agreement'),{status:404}); return {...source,chainTime:simulatedClock ?? now()};}});
setupBetsEventsRoute(app,pool);
const server=app.listen(Number(process.env.POINTS_PREVIEW_PORT||4684),host,()=>console.log(`points-preview listening http://${host}:${server.address().port} (simulation only; local PostgreSQL)`));
async function stop(){server.close(async()=>{try { await pool.query('DELETE FROM consensus.bet_event WHERE actor_mode = $1 AND simulation_run=$2',['simulated',run]); await pool.query('DELETE FROM consensus.points_wallet_challenge WHERE account_id IN (SELECT id FROM consensus.points_account WHERE simulation_run=$1)',[run]); await pool.query('DELETE FROM consensus.points_transaction WHERE account_id IN (SELECT id FROM consensus.points_account WHERE simulation_run=$1)',[run]); await pool.query('DELETE FROM consensus.points_position WHERE account_id IN (SELECT id FROM consensus.points_account WHERE simulation_run=$1)',[run]); await pool.query('DELETE FROM consensus.points_market WHERE simulation_run=$1',[run]); await pool.query('DELETE FROM consensus.points_account WHERE simulation_run=$1',[run]); } finally { await pool.end(); process.exit(0); }}); server.closeAllConnections?.();}
process.once('SIGTERM',stop); process.once('SIGINT',stop);
