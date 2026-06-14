// Canton DevNet OIDC token manager: exchanges client-credentials for a JWT and
// caches it until shortly before expiry. The 5n sandbox token lives ~8h; callers
// (see ledger.js) also force-refresh on a 401. Secret stays server-side only.

// Config from env. CANTON_-prefixed names win; unprefixed fall back so the same
// vars used by the spike (.env) work for the CLI check too.
export function cantonConfig(env = process.env) {
  return {
    ledgerApiUrl: (env.CANTON_LEDGER_API_URL || env.LEDGER_API_URL || '').replace(/\/$/, ''),
    tokenUrl: env.CANTON_TOKEN_URL || env.TOKEN_URL,
    grantType: env.CANTON_GRANT_TYPE || env.GRANT_TYPE || 'client_credentials',
    clientId: env.CANTON_CLIENT_ID || env.CLIENT_ID,
    clientSecret: env.CANTON_CLIENT_SECRET || env.CLIENT_SECRET,
    audience: env.CANTON_AUDIENCE || env.AUDIENCE,
    scope: env.CANTON_SCOPE || env.SCOPE || 'daml_ledger_api',
    userId: env.CANTON_USER_ID || env.USER_ID, // Canton ledger user (e.g. "6")
  };
}

const cache = new Map(); // clientId -> { token, expMs }
const REFRESH_SKEW_MS = 60_000; // refresh a minute before expiry

export async function getAccessToken(cfg = cantonConfig(), { force = false } = {}) {
  if (!cfg.tokenUrl || !cfg.clientId) throw new Error('canton token: missing tokenUrl/clientId config');
  const now = Date.now();
  const hit = cache.get(cfg.clientId);
  if (!force && hit && hit.expMs - now > REFRESH_SKEW_MS) return hit.token;

  const body = new URLSearchParams({ grant_type: cfg.grantType, client_id: cfg.clientId, scope: cfg.scope });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  if (cfg.audience) body.set('audience', cfg.audience);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`canton token: ${res.status} ${await res.text()}`);
  const j = await res.json();
  if (!j.access_token) throw new Error(`canton token: no access_token in response`);
  const ttlMs = (j.expires_in ? Number(j.expires_in) : 3600) * 1000;
  cache.set(cfg.clientId, { token: j.access_token, expMs: now + ttlMs });
  return j.access_token;
}

// Test/visibility helper — not used in the hot path.
export function _tokenCache() { return cache; }
