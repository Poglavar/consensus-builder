// PostgreSQL backed points LMSR ledger. Tokens authorize accounts; public agent IDs do not.
import { createHash, randomUUID, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');
const BettingContract = require('../../frontend/js/bets/betting-contract.js');
export const LMSR = require('../../frontend/js/bets/lmsr.js');
export const STARTING_BALANCE = 1_000_000_000n;
export const B = 100_000_000n;
export const SEED = LMSR.maxLoss(B);
export const WALLET_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const TOKEN = /^[a-f0-9]{64}$/i;
const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const digest = token => createHash('sha256').update(token).digest('hex');
export function validateRealm(run) {
  if (run === undefined || run === null || run === '') return '';
  if (typeof run !== 'string' || !SLUG.test(run)) throw Object.assign(new Error('invalid simulationRun'), { status: 400 });
  return run;
}
export function parseSource(source) {
  if (!source || typeof source !== 'object' || !ACCOUNT.test(source.account || '')
    || typeof source.cid !== 'string' || !source.cid || source.cid.length > 120
    || typeof source.city !== 'string' || !source.city || source.city.length > 80
    || !Number.isSafeInteger(source.closesAt) || source.closesAt <= 0
    || !Number.isSafeInteger(source.chainTime) || source.chainTime < 0
    || !Number.isFinite(new Date(source.closesAt * 1000).getTime())
    || source.graceSeconds !== 0 || !['active', 'executed', 'cancelled', 'expired'].includes(source.chainStatus)
    || (source.executedAt !== null && (!Number.isSafeInteger(source.executedAt) || source.executedAt <= 0))
    || (source.chainStatus === 'executed' && (!Number.isSafeInteger(source.executedAt)
        || source.executedAt <= 0 || source.executedAt > source.chainTime))
    || !Array.isArray(source.insiders)) {
    throw Object.assign(new Error('invalid agreement source'), { status: 503 });
  }
  return source;
}
export async function transaction(pool, fn) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const out = await fn(db); await db.query('COMMIT'); return out; }
  catch (e) { await db.query('ROLLBACK').catch(()=>{}); throw e; } finally { db.release(); }
}
export async function accountFromToken(db, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw Object.assign(new Error('valid bearer token required'), { status: 401 });
  const { rows } = await db.query('SELECT * FROM consensus.points_account WHERE token_hash=$1', [digest(token)]);
  if (!rows[0]) throw Object.assign(new Error('unknown token'), { status: 401 });
  return rows[0];
}
function amount(v, name) { if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) throw Object.assign(new Error(`${name} must be an integer string`),{status:400}); return BigInt(v); }
export function outcomeFor(source, nowSeconds) {
  try { return BettingContract.executionOutcome(source,source,Math.min(nowSeconds,source.chainTime)); }
  catch (error) { throw Object.assign(new Error(error.message),{status:503}); }
}
export const canTrade = (source,market,nowSeconds)=>BettingContract.canTrade(source,market,nowSeconds);
export const payout = BettingContract.payout;
export async function ensureMarket(db, source, realm='') {
  await db.query(`INSERT INTO consensus.points_market
    (agreement_account,simulation_run,agreement_cid,city,closes_at,grace_seconds,b,seed,vault)
    VALUES($1,$2,$3,$4,$5,0,$6,$7,$7) ON CONFLICT(agreement_account,simulation_run) DO NOTHING`,
  [source.account,realm,source.cid,source.city,source.closesAt,String(B),String(SEED)]);
  const {rows}=await db.query('SELECT * FROM consensus.points_market WHERE agreement_account=$1 AND simulation_run=$2 FOR UPDATE',[source.account,realm]);
  const m=rows[0]; if(m.agreement_cid!==source.cid||m.closes_at!==String(source.closesAt)||m.b!==String(B)) throw Object.assign(new Error('agreement terms differ from frozen points market'),{status:409});
  return m;
}
export function marketShape(m) { return {address:`points:${m.id}`,model:'lmsr',asset:'points',b:String(m.b),qYes:String(m.q_yes),qNo:String(m.q_no),seed:String(m.seed),closesAt:Number(m.closes_at),graceSeconds:0,resolved:m.resolved,outcome:m.outcome||null,paidOut:String(m.paid_out)}; }
export function walletChallengeMessage({account,wallet,nonce,expiresAt}) {
  return `Consensus Builder points wallet link\naccount:${account}\nwallet:${wallet}\nnonce:${nonce}\nexpiresAt:${expiresAt}`;
}
export function verifyWalletSignature({wallet,message,signature}) {
  try {
    const pub=new PublicKey(wallet);
    if(!Buffer.isBuffer(signature)||signature.length!==64) return false;
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pub.toBytes())]),format:'der',type:'spki'});
    return verifySignature(null,Buffer.from(message,'utf8'),key,signature);
  } catch { return false; }
}
export { randomUUID, UUID, amount, digest };
