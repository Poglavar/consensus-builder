// Opt-in PM2 schedules for the autonomous hackathon actors (several runs a day each since 2026-10-11:
// every job passes --slot auto, so a run id is <day>-h<UTC hour>-<persona> and each run is its own
// checkpoint; the proposers rotate through cities worldwide, see agents/area-plan.js), land-event materializer, the live
// prospective-market resolver, the society personas (preservationist-01, speculator-01; opt-in until
// their keys exist) and the (inactive) notary-01 and lifecycle-01 lens members. Secrets stay in backend/.env
// or protected key files; deploy-backend.sh deliberately restarts only the API app, so operators
// activate these jobs separately.
const lensEnv = {
  NODE_ENV: 'production',
  X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ'
};

const LOGS = {
  error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
  out_file: '/root/code/consensus-builder/backend/logs/agents.log',
  merge_logs: true,
  time: true
};

// A proposer persona on the same runner and caps as densifier-01 (one proposal a run: mint, pay,
// market, stake; up to 3 retirements of its own stale proposals).
function proposerJob(name, persona, cron) {
  return {
    name,
    script: 'agents/run.mjs',
    args: `--live --controller algorithm --persona ${persona} --candidates 4 --slot auto --api https://api.urbangametheory.xyz`,
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: cron,
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      AGENT_DAILY_ACTION_CAP: '13',
      AGENT_DAILY_USDC_CAP: '0.35',
      AGENT_PROPOSAL_FEE_USDC: '0.05',
      AGENT_RETIRE_AFTER_DAYS: '3',
      AGENT_LIFECYCLE_LENS_SERVICE_URL: 'http://127.0.0.1:3096',
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
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: cron,
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      AGENT_SOCIETY_ACTION_CAP: caps.actions,
      AGENT_SOCIETY_USDC_CAP: caps.usdc
    },
    ...LOGS
  };
}

module.exports = {
  apps: [{
    name: 'consensus-builder-agents',
    script: 'agents/run.mjs',
    // The lens comes from the attester directory (GET /agent/lenses/members), which the two lens
    // member services below fill when they start; an empty directory refuses to mint, so if they are
    // down the daily run fails at the lens step rather than minting with the proposer as its own lens.
    args: '--live --controller algorithm --persona densifier-01 --candidates 4 --slot auto --api https://api.urbangametheory.xyz',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '0 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      // 4 for the day's proposal (mint, pay, market, stake) + 3 retirements × (cancel, resolve, claim).
      // Retirements spend no USDC; the USDC cap below still bounds the proposal.
      AGENT_DAILY_ACTION_CAP: '13',
      AGENT_DAILY_USDC_CAP: '0.35',
      AGENT_PROPOSAL_FEE_USDC: '0.05',
      AGENT_RETIRE_AFTER_DAYS: '3',
      // The lifecycle member (consensus-builder-lifecycle-member) issues the retire phase's expiry
      // verdicts; AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN must be in backend/.env on the host, since a
      // URL without the token makes the run refuse before it reads anything.
      AGENT_LIFECYCLE_LENS_SERVICE_URL: 'http://127.0.0.1:3096',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz'
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-supporter',
    script: 'agents/support-run.mjs',
    args: '--live --persona supporter-01 --slot auto --api https://api.urbangametheory.xyz',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '45 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      AGENT_SUPPORT_USDC_CAP: '0.25'
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
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
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '20 */2 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      // One NO stake (0.01 USDC) plus a possible market creation, after collecting any winnings.
      AGENT_SOCIETY_ACTION_CAP: '3',
      AGENT_SOCIETY_USDC_CAP: '0.01'
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
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
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '40 */3 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz',
      // One pledge or one revoke per invocation (a pledge is a soft 0.05 USDC commitment), after
      // collecting any winnings.
      AGENT_SOCIETY_ACTION_CAP: '2',
      AGENT_SOCIETY_USDC_CAP: '0.05'
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
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
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '*/20 * * * *',
    kill_timeout: 600000,
    env: { NODE_ENV: 'production' },
    error_file: '/root/code/consensus-builder/backend/logs/tx-sync-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/tx-sync.log',
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-land-oracle',
    script: 'scripts/sync-land-events.mjs',
    args: '--live',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '30 2 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      LAND_ORACLE_RUN_STATS: '/root/code/consensus-builder/backend/logs/land-oracle-stats.json'
      // No RPC URL here. This job lists AcceptanceRecords with getProgramAccounts, which the Alchemy
      // free tier (SOLANA_RPC_URL) refuses, so it runs wholly on SOLANA_PROGRAM_ACCOUNTS_RPC_URL from
      // backend/.env (Helius devnet), as does the prospective resolver; every other job stays on
      // Alchemy. From 2026-10-04 to 2026-10-10 it was pinned to public devnet here instead, which
      // throttled its transaction sync and failed the run.
    },
    // Own log files, not the shared agents.log: the oracle prints its full JSON result (20+ KB),
    // which buried the persona runner's success sentinel past the monitor's tail window.
    error_file: '/root/code/consensus-builder/backend/logs/land-oracle-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/land-oracle.log',
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-prospective-resolver',
    script: 'blockchain/solana/scripts/prospective-external-market.mjs',
    args: '--settle --live',
    cwd: '/root/code/consensus-builder',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '45 * * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      SOLANA_KEYPAIR: '/root/.config/solana/court-oracle.json',
      PROSPECTIVE_BETTOR_KEYPAIR: '/root/.config/solana/ugt-persona-01.json',
      PROSPECTIVE_MARKET_STATE: '/root/.config/solana/ugt-prospective-court-v2.json',
      PROSPECTIVE_RUN_STATS: '/root/code/consensus-builder/backend/logs/prospective-resolver-stats.json'
    },
    error_file: '/root/code/consensus-builder/backend/logs/prospective-resolver-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/prospective-resolver.log',
    merge_logs: true,
    time: true
  }, {
    // INACTIVE, opt-in: the notary-01 reference lens member (backend/lens/, lens-model.md). Not
    // scheduled and never restarted. Start it with `pm2 start agents/ecosystem.config.cjs --only
    // consensus-builder-lens-member` only after the notary-01 key exists, its SAS credential and the
    // ParcelOwnership-v1/ProposalVerdict-v1 schemas are registered (scripts/register-lens-schemas.mjs),
    // sas-lib is installed and X402_* is set; until then a live member cannot issue anything.
    name: 'consensus-builder-lens-member',
    script: 'agents/lens-member-run.mjs',
    args: '--persona notary-01 --live',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    kill_timeout: 30000,
    env: lensEnv,
    error_file: '/root/code/consensus-builder/backend/logs/lens-member-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/lens-member.log',
    merge_logs: true,
    time: true
  }, {
    // INACTIVE, opt-in: the lifecycle-01 lens member (kind lifecycle) whose expiry verdicts the
    // proposer's retire phase requests. Not scheduled and never restarted. Start it with `--only
    // consensus-builder-lifecycle-member` only after the lifecycle-01 key exists, its SAS credential
    // and the ProposalVerdict-v1 schema are registered (scripts/register-lens-schemas.mjs) and
    // AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN is set in backend/.env; then set
    // AGENT_LIFECYCLE_LENS_SERVICE_URL=http://127.0.0.1:3096 for the proposer as well.
    name: 'consensus-builder-lifecycle-member',
    script: 'agents/lens-member-run.mjs',
    args: '--persona lifecycle-01 --live',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    kill_timeout: 30000,
    env: lensEnv,
    error_file: '/root/code/consensus-builder/backend/logs/lens-member-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/lens-member.log',
    merge_logs: true,
    time: true
  }]
};
