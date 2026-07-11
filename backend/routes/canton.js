// Canton chain option — read endpoints (step 2). Lists a party's proposals/sales
// from the ledger via backend/canton. The OIDC secret stays server-side; the
// browser only ever sees this REST surface. Write endpoints come in a later step.

import { ledgerEnd } from '../canton/ledger.js';
import { listProposalsForParty, listSalesForParty, createProposal, acceptProposal, allocateDemoParty, listParcelCounts } from '../canton/proposals.js';
import { ccviewParty } from '../canton/ccview.js';

export function setupCantonRoute(app) {
  // Connectivity check — confirms token exchange + Ledger API reachability.
  app.get('/canton/ledger-end', async (_req, res) => {
    try {
      res.json({ offset: await ledgerEnd() });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/canton/proposals', async (req, res) => {
    const party = req.query.party;
    if (!party) return res.status(400).json({ error: 'party query param required' });
    try {
      res.json({ party, proposals: await listProposalsForParty(party) });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/canton/sales', async (req, res) => {
    const party = req.query.party;
    if (!party) return res.status(400).json({ error: 'party query param required' });
    try {
      res.json({ party, sales: await listSalesForParty(party) });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Create a proposal. Body: { parcelId, price, buyer?, owner?, lens? }.
  // Blank parties are auto-allocated (demo). Relies on app-level express.json().
  app.post('/canton/proposals', async (req, res) => {
    const { parcelId, price, buyer, owner, lens, imageUri } = req.body || {};
    if (!parcelId || price == null) return res.status(400).json({ error: 'parcelId and price are required' });
    try {
      res.json(await createProposal({ parcelId, price, buyer, owner, lens, imageUri }));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Owner accepts a proposal. Body: { owner }.
  app.post('/canton/proposals/:cid/accept', async (req, res) => {
    const owner = (req.body || {}).owner;
    if (!owner) return res.status(400).json({ error: 'owner is required' });
    try {
      res.json(await acceptProposal(req.params.cid, owner));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Allocate a fresh demo party (for the "stranger" perspective). Body: { hint? }.
  app.post('/canton/parties', async (req, res) => {
    try {
      res.json(await allocateDemoParty((req.body || {}).hint));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Public parcel→proposal-count signal (existence only; no terms). Drives the
  // map's "show proposal count" labels for Canton. Read from on-ledger markers.
  app.get('/canton/parcel-counts', async (_req, res) => {
    try {
      res.json({ counts: await listParcelCounts() });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // CCView explorer summary for a party (Canton Coin balance + activity). The
  // API key stays server-side; the browser only gets the compact summary + URL.
  app.get('/canton/ccview/:party', async (req, res) => {
    try {
      res.json(await ccviewParty(req.params.party));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });
}
