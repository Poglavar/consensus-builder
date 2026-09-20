// Opt-in PM2 schedule for the autonomous hackathon persona. Starting this file runs once
// immediately, then daily at 02:00 UTC. Secrets stay in backend/.env and the signing key stays at
// the persona's keypairPath; deploy-backend.sh deliberately restarts only the API app.
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
    time: true
  }]
};
