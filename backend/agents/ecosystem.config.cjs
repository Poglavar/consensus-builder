// Opt-in PM2 schedules for the autonomous hackathon actors, land-event materializer, and the live
// prospective-market resolver. Secrets stay in backend/.env or protected key files; deploy-backend.sh
// deliberately restarts only the API app, so operators activate these jobs separately.
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
      AGENT_DAILY_ACTION_CAP: '4',
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
      NODE_ENV: 'production'
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
  }]
};
