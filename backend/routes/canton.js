// Canton chain option — REST surface over backend/canton. The OIDC secret stays server-side; the
// browser only ever sees this API.
//
// The server's credentials can act as ANY party, so this surface must never be an open proxy for
// them. There is no per-party authentication yet, therefore:
//   - every write (create proposal, accept on behalf of an owner, allocate a party) requires the
//     server-side admin token (header `x-canton-admin-token`, compared in constant time against
//     CANTON_ADMIN_TOKEN); with no token configured, writes are refused outright;
//   - party-scoped reads are limited to the demo PUBLIC party unless the admin token is presented;
//   - everything is rate limited per IP.
// Routes are only registered when CANTON_ENABLED=true (index.js), which is currently off.

import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { ledgerEnd } from '../canton/ledger.js';
import { listProposalsForParty, listSalesForParty, createProposal, acceptProposal, allocateDemoParty, listParcelCounts, knownPublicParty } from '../canton/proposals.js';
import { ccviewParty } from '../canton/ccview.js';

export const CANTON_ADMIN_HEADER = 'x-canton-admin-token';
export const CANTON_RATE_WINDOW_MS = 60 * 1000;
export const CANTON_RATE_MAX = 120;

export function sendCantonUnavailable(res, operation, error) {
  // Keep the upstream response (which may contain OAuth/provider detail) in
  // server logs, not in the public API response.
  console.error(`[canton] ${operation} failed:`, error);
  return res.status(503).json({
    error: 'Canton ledger is temporarily unavailable',
    code: 'canton_unavailable',
  });
}

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();

// Constant-time: both sides are hashed to a fixed length first, so neither the comparison time nor
// an early length mismatch leaks anything about the configured token.
export function isCantonAdmin(req, env = process.env) {
  const expected = env.CANTON_ADMIN_TOKEN;
  const presented = req.get ? req.get(CANTON_ADMIN_HEADER) : req.headers?.[CANTON_ADMIN_HEADER];
  if (!expected || typeof presented !== 'string' || !presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function requireCantonAdmin(req, res, next) {
  if (!process.env.CANTON_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Canton writes are disabled on this server.', code: 'canton_writes_disabled' });
  }
  if (!isCantonAdmin(req)) {
    return res.status(401).json({ error: 'Canton write requires the admin token.', code: 'canton_admin_required' });
  }
  next();
}

// Resolve the party a read may use: anything for the admin, otherwise only the public party.
async function authorizePartyRead(req, res, party) {
  if (!party || typeof party !== 'string') {
    res.status(400).json({ error: 'party query param required' });
    return false;
  }
  if (isCantonAdmin(req)) return true;
  const publicParty = await knownPublicParty();
  if (!publicParty || party !== publicParty) {
    res.status(403).json({ error: 'Only the public party can be read without the admin token.', code: 'canton_party_forbidden' });
    return false;
  }
  return true;
}

export function setupCantonRoute(app) {
  app.use('/canton', rateLimit({
    windowMs: CANTON_RATE_WINDOW_MS,
    limit: CANTON_RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // req.ip (nginx real_ip + trust proxy 1), IPv6 bucketed to its allocation.
    keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
    handler: (req, res) => res.status(429).json({ error: 'Too many requests, please try again later.' }),
  }));

  // Connectivity check — confirms token exchange + Ledger API reachability.
  app.get('/canton/ledger-end', async (_req, res) => {
    try {
      res.json({ offset: await ledgerEnd() });
    } catch (e) {
      sendCantonUnavailable(res, 'ledger-end', e);
    }
  });

  app.get('/canton/proposals', async (req, res) => {
    const party = req.query.party;
    try {
      if (!(await authorizePartyRead(req, res, party))) return;
      res.json({ party, proposals: await listProposalsForParty(party) });
    } catch (e) {
      sendCantonUnavailable(res, 'proposals-list', e);
    }
  });

  app.get('/canton/sales', async (req, res) => {
    const party = req.query.party;
    try {
      if (!(await authorizePartyRead(req, res, party))) return;
      res.json({ party, sales: await listSalesForParty(party) });
    } catch (e) {
      sendCantonUnavailable(res, 'sales-list', e);
    }
  });

  // Create a proposal. Body: { parcelId, price, buyer?, owner?, lens? }.
  // Blank parties are auto-allocated (demo). Relies on app-level express.json().
  app.post('/canton/proposals', requireCantonAdmin, async (req, res) => {
    const { parcelId, price, buyer, owner, lens, imageUri } = req.body || {};
    if (!parcelId || price == null) return res.status(400).json({ error: 'parcelId and price are required' });
    try {
      res.json(await createProposal({ parcelId, price, buyer, owner, lens, imageUri }));
    } catch (e) {
      sendCantonUnavailable(res, 'proposal-create', e);
    }
  });

  // Owner accepts a proposal. Body: { owner }. Acts AS `owner` with server credentials, hence admin-only.
  app.post('/canton/proposals/:cid/accept', requireCantonAdmin, async (req, res) => {
    const owner = (req.body || {}).owner;
    if (!owner) return res.status(400).json({ error: 'owner is required' });
    try {
      res.json(await acceptProposal(req.params.cid, owner));
    } catch (e) {
      sendCantonUnavailable(res, 'proposal-accept', e);
    }
  });

  // Allocate a fresh demo party (for the "stranger" perspective). Body: { hint? }.
  app.post('/canton/parties', requireCantonAdmin, async (req, res) => {
    try {
      res.json(await allocateDemoParty((req.body || {}).hint));
    } catch (e) {
      sendCantonUnavailable(res, 'party-allocate', e);
    }
  });

  // Public parcel→proposal-count signal (existence only; no terms). Drives the
  // map's "show proposal count" labels for Canton. Read from on-ledger markers.
  app.get('/canton/parcel-counts', async (_req, res) => {
    try {
      res.json({ counts: await listParcelCounts() });
    } catch (e) {
      sendCantonUnavailable(res, 'parcel-counts', e);
    }
  });

  // CCView explorer summary for a party (Canton Coin balance + activity). The
  // API key stays server-side; the browser only gets the compact summary + URL.
  app.get('/canton/ccview/:party', async (req, res) => {
    try {
      if (!(await authorizePartyRead(req, res, req.params.party))) return;
      res.json(await ccviewParty(req.params.party));
    } catch (e) {
      sendCantonUnavailable(res, 'ccview', e);
    }
  });
}
