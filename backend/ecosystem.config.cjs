module.exports = {
  apps: [{
    name: 'consensus-builder-api',
    script: 'server.js',
    cwd: '/root/code/consensus-builder/backend',
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      API_PORT: 3000
    },
    error_file: '/root/code/consensus-builder/backend/logs/err.log',
    out_file: '/root/code/consensus-builder/backend/logs/out.log',
    log_file: '/root/code/consensus-builder/backend/logs/combined.log',
    time: true
  }]
};
