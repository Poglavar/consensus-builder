module.exports = {
  apps: [{
    name: 'consensus-builder-api',
    script: 'index.js',
    cwd: '/var/www/consensus-builder-api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/www/consensus-builder-api/logs/err.log',
    out_file: '/var/www/consensus-builder-api/logs/out.log',
    log_file: '/var/www/consensus-builder-api/logs/combined.log',
    time: true
  }]
};
