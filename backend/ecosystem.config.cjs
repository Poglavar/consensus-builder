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
      PUBLIC_API_BASE_URL: 'https://api.urbangametheory.xyz',
      // --- AI scene render (paid, per-image) ---
      // The model is pinned server-side: /ai-scene/render ignores whatever model the client sends
      // and always uses this one, and /ai-scene/models reports it so the UI greys out the picker.
      // Leaving it unset would let visitors pick any allowlisted model — including the expensive
      // ones — so it must stay set in production. Change it here (versioned, deployed), not by hand.
      AI_SCENE_FORCED_MODEL: 'gemini-2.5-flash-image',
      // Per-IP limits on the paid endpoint (keyed on CF-Connecting-IP, the true visitor behind
      // Cloudflare). Cooldown counts every attempt; the quota counts only successful renders.
      AI_SCENE_COOLDOWN_MS: 20000,        // at most one render per IP per 20s
      AI_SCENE_QUOTA_MAX: 10,             // at most 10 successful renders per IP...
      AI_SCENE_QUOTA_WINDOW_MS: 86400000  // ...per rolling 24h
    },
    error_file: '/root/code/consensus-builder/backend/logs/err.log',
    out_file: '/root/code/consensus-builder/backend/logs/out.log',
    log_file: '/root/code/consensus-builder/backend/logs/combined.log',
    time: true
  }]
};
