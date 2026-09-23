module.exports = {
  apps: [{
    name: 'consensus-builder-api',
    script: 'server.js',
    cwd: '/root/code/consensus-builder/backend',
    // Cluster mode is required for PM2's zero-downtime reload. One steady-state
    // worker preserves the service's current memory and rate-limit behaviour;
    // PM2 only overlaps old/new workers while a release is being activated.
    exec_mode: 'cluster',
    instances: 1,
    autorestart: true,
    watch: false,
    kill_timeout: 15000,
    listen_timeout: 10000,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      API_PORT: 3000,
      // Injected by deploy-backend.sh from the checked-out revision. PM2 only forwards values
      // declared in this env block when restarting from the ecosystem file, so declaring it here
      // keeps the public hackathon proof manifest tied to the exact deployed commit.
      RELEASE_SHA: process.env.RELEASE_SHA || null,
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
      // The prompt is pinned server-side too: a prompt sent by the client is accepted and then
      // DISCARDED in favour of the canonical one, so calling the endpoint directly with a crafted
      // prompt cannot steer the paid model. The UI makes its textarea read-only to match, and the
      // response carries warning:"prompt_overridden" whenever a differing prompt was thrown away.
      AI_SCENE_FORCE_PROMPT: '1',
      // Hard lifetime ceiling on total spend, enforced from the ai_scene_spend ledger (survives
      // restarts). Once reached, /ai-scene/render returns 402 budget_exhausted and spends nothing.
      AI_SCENE_BUDGET_USD: 10,
      // Per-IP limits on the paid endpoint (keyed on CF-Connecting-IP, the true visitor behind
      // Cloudflare). Cooldown counts every attempt; the quota counts only successful renders.
      AI_SCENE_COOLDOWN_MS: 20000,        // at most one render per IP per 20s
      AI_SCENE_QUOTA_MAX: 10,             // at most 10 successful renders per IP...
      AI_SCENE_QUOTA_WINDOW_MS: 86400000, // ...per rolling 24h
      // --- Agents functionality for UGT: x402 paid proposal and verified-fact gates ---
      // These values are public (network id, facilitator, treasury pubkey, prices). The CDP
      // API key id + secret stay in the server-local .env. With any required value unset the route
      // answers 503 and nothing is charged. Devnet for the hackathon. The price is a commit, never
      // a hand edit.
      X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
      X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
      X402_PRICE_PROPOSAL: '$0.05',
      X402_PRICE_ORACLE_FACT: '$0.01',
      // --- Canton chain option: DISABLED ---
      // Its OAuth client is rejected by the token endpoint (invalid_grant; 132/132 requests failed
      // in one week), so /canton/* is not registered at all and nothing calls the token endpoint.
      // Flip to 'true' (here, versioned) once the credentials work again; the code is intact.
      CANTON_ENABLED: 'false'
    },
    error_file: '/root/code/consensus-builder/backend/logs/err.log',
    out_file: '/root/code/consensus-builder/backend/logs/out.log',
    log_file: '/root/code/consensus-builder/backend/logs/combined.log',
    time: true
  }]
};
