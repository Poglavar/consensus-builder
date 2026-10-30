// Opt-in PM2 schedules for the autonomous hackathon actors (several runs a day each since 2026-10-11:
// every job passes --slot auto, so a run id is <day>-h<UTC hour>-<persona> and each run is its own
// checkpoint; the proposers rotate through cities worldwide, see agents/area-plan.js), land-event materializer, the live
// prospective-market resolver, the society personas (preservationist-01, speculator-01; opt-in until
// their keys exist) and the opt-in notary-01 and lifecycle-01 lens member services. Secrets stay in backend/.env
// or protected key files; deploy-backend.sh deliberately restarts only the API app, so operators
// activate these jobs separately.
// A live proposer run operates the lifecycle-01 lens member (its approval facts and its
// AgreementDecision-v1) and refuses to start without AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN, which it reads
// from backend/.env on the host (agents/README.md, "Lens").
const path = require('node:path');
const HOME_DIR = require('node:os').homedir();
const REPO_ROOT = path.join(HOME_DIR, 'code', 'consensus-builder');
const BACKEND_ROOT = path.join(REPO_ROOT, 'backend');
const SOLANA_CONFIG = path.join(HOME_DIR, '.config', 'solana');

const apiEnv = require('../ecosystem.config.cjs').apps.find(app => app.name === 'consensus-builder-api').env;
const botEnv = {
  AGENT_SOL_FUNDING_ENABLED: '1',
  AGENT_USDC_FUNDING_ENABLED: '1',
  SOLANA_RPC_MAX_ACCOUNTS: apiEnv.SOLANA_RPC_MAX_ACCOUNTS
};
const lensEnv = {
  ...botEnv,
  NODE_ENV: 'production',
  X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ'
};

const LOGS = {
  error_file: path.join(BACKEND_ROOT, 'logs', 'agents-error.log'),
  out_file: path.join(BACKEND_ROOT, 'logs', 'agents.log'),
  merge_logs: true,
  time: true
};

// A proposer persona on the same runner and caps as densifier-01. Each run first settles up to
// AGENT_SETTLE_MAX_PER_RUN of its own earlier agreements (decide, lens decision, attest, execute or
// expire, resolve, claim), then proposes: with --seed-owners each picked parcel nobody owns is registered
// to the persona in the devnet owner registry, so its binding owners' agreement is one it can decide
// itself (agents/README.md, "Settlement phase" and "Owner registry").
function proposerJob(name, persona, cron) {
  return {
    name,
    script: 'agents/run.mjs',
    args: `--live --controller algorithm --persona ${persona} --candidates 4 --slot auto --seed-owners --api https://api.urbangametheory.xyz`,
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: cron,
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      // A pick takes at most 3 signed actions (create+fund, seed top-up, market), each settled agreement at
      // most 4 (attest, execute or expire, resolve, claim): 3 + 3 × 4.
      AGENT_DAILY_ACTION_CAP: '15',
      AGENT_SETTLE_MAX_PER_RUN: '3',
      AGENT_DAILY_USDC_CAP: '0.35',
      AGENT_MARKET_SEED_USDC_CAP: '3.5',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz'
    },
    ...LOGS
  };
}

// A society persona (agents/policies/<role>.js) with its per-invocation caps.
function societyJob(name, persona, cron, caps) {
  return {
    name,
    script: 'agents/society-run.mjs',
    args: `--live --persona ${persona} --slot auto --api https://api.urbangametheory.xyz`,
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: cron,
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      AGENT_SOCIETY_ACTION_CAP: caps.actions,
      AGENT_SOCIETY_USDC_CAP: caps.usdc
    },
    ...LOGS
  };
}

module.exports = {
  apps: [{...proposerJob('consensus-builder-affordabot', 'affordabot', '20 7 * * *'), args:'--live --controller algorithm --persona affordabot --candidates 4 --seed-owners --api https://api.urbangametheory.xyz', env:{...proposerJob('', '', '').env, AGENT_DAILY_USDC_CAP:'0.02'}}, {
    name: 'consensus-builder-agents',
    script: 'agents/run.mjs',
    // Every agreement names one lens: the lifecycle-01 member this runner operates, reached at its
    // persona's service.url. If that member is down, the run fails at its approval or decision step.
    args: '--live --controller algorithm --persona densifier-01 --candidates 4 --slot auto --seed-owners --api https://api.urbangametheory.xyz',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '0 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      // 3 for the day's pick (create+fund, seed top-up, market) + up to 3 settled agreements × 4 (attest,
      // execute or expire, resolve, claim). Market seed has a separate bounded devnet allowance.
      AGENT_DAILY_ACTION_CAP: '15',
      AGENT_SETTLE_MAX_PER_RUN: '3',
      AGENT_DAILY_USDC_CAP: '0.35',
      AGENT_MARKET_SEED_USDC_CAP: '3.5',
      // The settlement's decision steps go through the operated lifecycle-01 member (consensus-builder-
      // lifecycle-member): AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN must be in backend/.env on the host, or
      // the live run refuses to start.
      AGENT_API_BASE: 'https://api.urbangametheory.xyz'
    },
    error_file: path.join(BACKEND_ROOT, 'logs', 'agents-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'agents.log'),
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-supporter',
    script: 'agents/support-run.mjs',
    args: '--live --persona supporter-01 --slot auto --api https://api.urbangametheory.xyz',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '45 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      AGENT_SUPPORT_USDC_CAP: '0.25'
    },
    error_file: path.join(BACKEND_ROOT, 'logs', 'agents-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'agents.log'),
    merge_logs: true,
    time: true
  }, {
    // OPT-IN until keys exist: the contrarian society persona (agents/policies/contrarian.js) bets
    // NO on the densest active proposal by another actor. Start it with `pm2 start
    // agents/ecosystem.config.cjs --only consensus-builder-preservationist` only after
    // ~/.config/solana/ugt-preservationist-01.json exists, its wallet is set in personas.json and
    // funded with devnet SOL + USDC; until then a live run refuses before reading anything.
    name: 'consensus-builder-preservationist',
    script: 'agents/society-run.mjs',
    args: '--live --persona preservationist-01 --slot auto --api https://api.urbangametheory.xyz',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '20 */2 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      // One NO stake (0.01 USDC) plus a possible market creation, after collecting any winnings.
      AGENT_SOCIETY_ACTION_CAP: '3',
      AGENT_SOCIETY_USDC_CAP: '0.01'
    },
    error_file: path.join(BACKEND_ROOT, 'logs', 'agents-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'agents.log'),
    merge_logs: true,
    time: true
  }, {
    // OPT-IN until keys exist: the speculator society persona (agents/policies/speculator.js)
    // pledges behind the market favourite and revokes when the market turns or the proposal ages.
    // Start it with `--only consensus-builder-speculator` only after
    // ~/.config/solana/ugt-speculator-01.json exists and its wallet is set in personas.json.
    name: 'consensus-builder-speculator',
    script: 'agents/society-run.mjs',
    args: '--live --persona speculator-01 --slot auto --api https://api.urbangametheory.xyz',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '40 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      ...botEnv,
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      // One pledge or one revoke per invocation (a pledge is a soft 0.05 USDC commitment), after
      // collecting any winnings.
      AGENT_SOCIETY_ACTION_CAP: '2',
      AGENT_SOCIETY_USDC_CAP: '0.05'
    },
    error_file: path.join(BACKEND_ROOT, 'logs', 'agents-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'agents.log'),
    merge_logs: true,
    time: true
  },
  // Added 2026-10-11: a second proposer and a rival that answers other agents' proposals on the same
  // land (contests), a second contrarian and a backer that bets YES on the underdog.
  proposerJob('consensus-builder-builder', 'builder-02', '30 1-22/3 * * *'),
  proposerJob('consensus-builder-gentle', 'gentle-01', '15 2-23/3 * * *'),
  societyJob('consensus-builder-skeptic', 'skeptic-02', '50 1-23/2 * * *', { actions: '3', usdc: '0.02' }),
  societyJob('consensus-builder-backer', 'backer-01', '10 1-23/2 * * *', { actions: '3', usdc: '0.02' }),
  {
    // Tops up consensus.solana_transaction (every persona wallet and program in the address book),
    // which the public activity feed and the globe's carousel read; before 2026-10-11 only the daily
    // land-oracle run and explorer page loads refreshed it, so a bet could take a day to appear.
    name: 'consensus-builder-tx-sync',
    script: 'scripts/sync-transactions.mjs',
    args: '--run',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '*/20 * * * *',
    kill_timeout: 600000,
    env: { NODE_ENV: 'production' },
    error_file: path.join(BACKEND_ROOT, 'logs', 'tx-sync-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'tx-sync.log'),
    merge_logs: true,
    time: true
  }, {
    // The land-event oracle on the agreement program (plan-design-agreement.md M3): every 15 minutes one
    // applied pass of oracle/agreement-lifecycle-job.mjs refreshes consensus.agreement.onchain from each
    // minted agreement's account and writes the land events of terminal ones (agreement_lifecycle, and
    // agreement_executed per input parcel: parcel history). Idempotent, so an overlapping or repeated
    // run writes nothing twice. It replaced the daily proposal lifecycle run (scripts/sync-land-events.mjs).
    name: 'consensus-builder-land-oracle',
    script: 'oracle/agreement-lifecycle-job.mjs',
    args: '--once --apply',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '*/15 * * * *',
    kill_timeout: 600000,
    env: {
      NODE_ENV: 'production',
      // The run-stats artifact the operations page and the monitor read, written by every applied pass.
      LAND_ORACLE_RUN_STATS: path.join(BACKEND_ROOT, 'logs', 'land-oracle-stats.json')
      // Chain reads use SOLANA_RPC_URL (devnet) and SOLANA_RPC_MAX_ACCOUNTS from backend/.env.
    },
    // Own log files, not the shared agents.log.
    error_file: path.join(BACKEND_ROOT, 'logs', 'land-oracle-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'land-oracle.log'),
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-prospective-resolver',
    script: 'blockchain/solana/scripts/prospective-external-market.mjs',
    args: '--settle --live',
    cwd: REPO_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '45 * * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      SOLANA_KEYPAIR: path.join(SOLANA_CONFIG, 'court-oracle.json'),
      PROSPECTIVE_BETTOR_KEYPAIR: path.join(SOLANA_CONFIG, 'ugt-persona-01.json'),
      PROSPECTIVE_MARKET_STATE: path.join(SOLANA_CONFIG, 'ugt-prospective-court-v2.json'),
      PROSPECTIVE_RUN_STATS: path.join(BACKEND_ROOT, 'logs', 'prospective-resolver-stats.json')
    },
    error_file: path.join(BACKEND_ROOT, 'logs', 'prospective-resolver-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'prospective-resolver.log'),
    merge_logs: true,
    time: true
  }, {
    // Opt-in: the notary-01 reference lens member (backend/lens/, lens-model.md), a long-running
    // HTTP service (running on prod), so PM2 brings it back after a crash, backing off between
    // tries. Start it with `pm2 start agents/ecosystem.config.cjs --only
    // consensus-builder-lens-member` only after the notary-01 key exists, its SAS credential and the
    // ParcelOwnership-v1/AgreementDecision-v1 schemas are registered (scripts/register-lens-schemas.mjs),
    // sas-lib is installed and X402_* is set; until then a live member cannot issue anything.
    name: 'consensus-builder-lens-member',
    script: 'agents/lens-member-run.mjs',
    args: '--persona notary-01 --live',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    min_uptime: '30s',
    max_restarts: 10,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 30000,
    env: lensEnv,
    error_file: path.join(BACKEND_ROOT, 'logs', 'lens-member-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'lens-member.log'),
    merge_logs: true,
    time: true
  }, {
    // Opt-in: the lifecycle-01 lens member (kind lifecycle), the lens the proposers operate: it signs the
    // approval facts of their agreements, checked against the devnet owner registry
    // (consensus.lens_devnet_owner, read per request; no rights file), and issues AgreementDecision-v1
    // when its operator asks (POST /lens/agreements/:cid/decision). A long-running service like the one
    // above and restarted the same way. Start it with `--only consensus-builder-lifecycle-member` only
    // after the lifecycle-01 key exists, its SAS credential and the AgreementDecision-v1 schema are
    // registered (scripts/register-lens-schemas.mjs) and AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN is set in
    // backend/.env; the proposers reach it at the persona's service.url (agents/personas.json).
    name: 'consensus-builder-lifecycle-member',
    script: 'agents/lens-member-run.mjs',
    args: '--persona lifecycle-01 --live',
    cwd: BACKEND_ROOT,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    min_uptime: '30s',
    max_restarts: 10,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 30000,
    env: lensEnv,
    error_file: path.join(BACKEND_ROOT, 'logs', 'lens-member-error.log'),
    out_file: path.join(BACKEND_ROOT, 'logs', 'lens-member.log'),
    merge_logs: true,
    time: true
  }]
};
