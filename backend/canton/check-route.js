// CLI check for the read ENDPOINTS: seeds a proposal on DevNet, mounts only the
// canton route on a throwaway Express app, and hits the HTTP endpoints — proving
// the route layer (not just the module) works. No DB / full app boot needed.
//
//   set -a; . ../../blockchain/daml/spike/.env; set +a
//   node backend/canton/check-route.js

import express from 'express';
import { cantonConfig } from './token.js';
import { allocateParty, grantActAs, createContract, activeContracts, exerciseChoice } from './ledger.js';
import { setupCantonRoute } from '../routes/canton.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const main = async () => {
  const cfg = cantonConfig(process.env);
  if (!cfg.ledgerApiUrl || !cfg.userId) throw new Error('source blockchain/daml/spike/.env first');
  const PKG = cfg.packageRef;
  const parcelId = `PARCEL-${Date.now()}`;

  // --- seed a proposal addressed to an owner ---
  const tag = `${Date.now()}`;
  const lens = await allocateParty(cfg, `Lens-${tag}`);
  const owner = await allocateParty(cfg, `Owner-${tag}`);
  const buyer = await allocateParty(cfg, `Buyer-${tag}`);
  for (const p of [lens, owner, buyer]) await grantActAs(cfg, cfg.userId, p);
  await createContract(cfg, { templateId: `${PKG}:Proposal:OwnershipCertificate`, args: { lens, owner, parcelId }, actAs: lens });
  const [cert] = await activeContracts(cfg, lens, `${PKG}:Proposal:OwnershipCertificate`);
  await createContract(cfg, {
    templateId: `${PKG}:Proposal:PurchaseProposal`,
    args: { buyer, owner, lens, parcelId, price: '100.0', certCid: cert.contractId }, actAs: buyer,
  });
  log(`seeded proposal for owner ${owner.slice(0, 24)}…`);

  // --- mount only the canton route and call it over HTTP ---
  const app = express();
  setupCantonRoute(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };

  try {
    const end = await get('/canton/ledger-end');
    if (!end.body.offset) throw new Error(`ledger-end failed: ${JSON.stringify(end)}`);
    log(`GET /canton/ledger-end -> offset ${end.body.offset}`);

    const props = await get(`/canton/proposals?party=${encodeURIComponent(owner)}`);
    const found = (props.body.proposals || []).find((x) => x.parcelId === parcelId);
    if (!found) throw new Error(`proposal not returned by endpoint: ${JSON.stringify(props.body).slice(0, 300)}`);
    log(`GET /canton/proposals -> ✓ found ${found.contractId.slice(0, 16)}… price=${found.price} buyer=${found.buyer.slice(0, 16)}…`);

    const bad = await get('/canton/proposals');
    if (bad.status !== 400) throw new Error(`missing-party should 400, got ${bad.status}`);
    log(`GET /canton/proposals (no party) -> 400 as expected`);

    // accept, then sales endpoint should report it
    await exerciseChoice(cfg, { templateId: `${PKG}:Proposal:PurchaseProposal`, contractId: found.contractId, choice: 'Accept', actAs: owner });
    const sales = await get(`/canton/sales?party=${encodeURIComponent(owner)}`);
    const sale = (sales.body.sales || []).find((x) => x.parcelId === parcelId);
    if (!sale) throw new Error(`sale not returned after Accept: ${JSON.stringify(sales.body).slice(0, 300)}`);
    log(`GET /canton/sales -> ✓ found sale ${sale.contractId.slice(0, 16)}…`);

    log('ROUTE CHECK OK — /canton read endpoints verified against DevNet.');
  } finally {
    server.close();
  }
};

main().catch((e) => { console.error('ROUTE CHECK FAILED:', e?.message || e); process.exit(1); });
