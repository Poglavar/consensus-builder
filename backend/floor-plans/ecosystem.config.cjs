// Daily bounded archive job; PM2 starts the initial pilot when --enable registers it.
const path = require('node:path');

const backendDir = path.resolve(__dirname, '..');
const python = path.join(backendDir, '.venv-floor-plans', 'bin', 'python');

module.exports = {
  apps: [{
    name: 'consensus-builder-floor-plan-daily',
    cwd: backendDir,
    script: 'scripts/floor-plan-archive.mjs',
    interpreter: process.execPath,
    args: [
      'daily',
      '--max-pages', '10000',
      '--max-minutes', '180',
      '--max-assets', '100',
      '--ai-budget-usd', '5',
      '--ai-chunk-size', '1',
      '--run-stats', path.join(backendDir, 'logs', 'floor-plan-run-stats.json')
    ],
    env: {
      TZ: 'UTC',
      FLOOR_PLAN_PYTHON: python
    },
    cron_restart: '0 6 * * *',
    autorestart: false,
    watch: false,
    time: true,
    out_file: path.join(backendDir, 'logs', 'floor-plan-daily.out.log'),
    error_file: path.join(backendDir, 'logs', 'floor-plan-daily.err.log'),
    merge_logs: true
  }]
};
