// Canton chain option — read endpoints (step 2). Lists a party's proposals/sales
// from the ledger via backend/canton. The OIDC secret stays server-side; the
// browser only ever sees this REST surface. Write endpoints come in a later step.

import { ledgerEnd } from '../canton/ledger.js';
import { listProposalsForParty, listSalesForParty, createProposal } from '../canton/proposals.js';

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
    const { parcelId, price, buyer, owner, lens } = req.body || {};
    if (!parcelId || price == null) return res.status(400).json({ error: 'parcelId and price are required' });
    try {
      res.json(await createProposal({ parcelId, price, buyer, owner, lens }));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });
}
