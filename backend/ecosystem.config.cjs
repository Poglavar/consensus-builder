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
      API_PORT: 3000,
      // The origin baked into stored image URLs (proposal thumbnails). Without it,
      // resolveThumbnailBaseUrl() falls back to the request's Host header — which the client
      // controls — so a spoofed Host on POST /proposals would permanently store an attacker's
      // origin as that proposal's screenshot_url. It is a public URL, not a secret, so it lives
      // here (versioned, deployed) rather than in a hand-edited .env.
      PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz'
    },
    error_file: '/root/code/consensus-builder/backend/logs/err.log',
    out_file: '/root/code/consensus-builder/backend/logs/out.log',
    log_file: '/root/code/consensus-builder/backend/logs/combined.log',
    time: true
  }]
};
