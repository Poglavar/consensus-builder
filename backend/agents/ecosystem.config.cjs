// Opt-in PM2 schedules for the autonomous hackathon actors, land-event materializer, the live
// prospective-market resolver, and the (inactive) notary-01 lens member. Secrets stay in backend/.env
// or protected key files; deploy-backend.sh deliberately restarts only the API app, so operators
// activate these jobs separately.
module.exports = {
  apps: [{
    name: 'consensus-builder-agents',
    script: 'agents/run.mjs',
    args: '--live --controller algorithm --persona densifier-01 --candidates 4 --api https://api.urbangametheory.xyz',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '0 2 * * *',
    kill_timeout: 900000,
    env: {
      NODE_ENV: 'production',
      // 4 for the day's proposal (mint, pay, market, stake) + 3 retirements × (cancel, resolve, claim).
      // Retirements spend no USDC; the USDC cap below still bounds the proposal.
      AGENT_DAILY_ACTION_CAP: '13',
      AGENT_DAILY_USDC_CAP: '0.35',
      AGENT_PROPOSAL_FEE_USDC: '0.05',
      AGENT_API_BASE: 'https://api.urbangametheory.xyz'
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
    merge_logs: true,
    time: true
  }, {
    name: 'consensus-builder-supporter',
    script: 'agents/support-run.mjs',
    args: '--live --persona supporter-01 --api https://api.urbangametheory.xyz',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: '15 2 * * *',
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
    },
    error_file: '/root/code/consensus-builder/backend/logs/agents-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/agents.log',
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
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/root/code/consensus-builder/backend/logs/lens-member-error.log',
    out_file: '/root/code/consensus-builder/backend/logs/lens-member.log',
    merge_logs: true,
    time: true
  }]
};
