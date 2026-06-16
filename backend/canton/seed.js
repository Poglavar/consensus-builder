// Seed a demo scenario on DevNet: allocate lens/owner/buyer, attest ownership,
// and create one active PurchaseProposal (owner as observer). Prints the party
// IDs so they can be plugged into canton.html / the party switcher. Does NOT
// accept, so the proposal stays active for display.
//
//   (Canton config from backend/.env)
//   DAR_PATH=../../blockchain/daml/.daml/dist/consensus-builder-daml-0.2.0.dar node backend/canton/seed.js

import './load-env.js';
import { readFile } from 'node:fs/promises';
import { cantonConfig } from './token.js';
import { uploadDar, allocateParty, grantActAs, createContract, activeContracts } from './ledger.js';

const main = async () => {
  const cfg = cantonConfig(process.env);
  if (!cfg.ledgerApiUrl || !cfg.userId) throw new Error('missing CANTON_* config in backend/.env');
  const PKG = cfg.packageRef;
  const parcelId = process.env.PARCEL_ID || `PARCEL-${Date.now()}`;
  const price = process.env.PRICE || '100.0';

  if (process.env.DAR_PATH) await uploadDar(cfg, await readFile(process.env.DAR_PATH));

  const tag = `${Date.now()}`;
  const lens = await allocateParty(cfg, `Lens-${tag}`);
  const owner = await allocateParty(cfg, `Owner-${tag}`);
  const buyer = await allocateParty(cfg, `Buyer-${tag}`);
  for (const p of [lens, owner, buyer]) await grantActAs(cfg, cfg.userId, p);

  await createContract(cfg, { templateId: `${PKG}:Proposal:OwnershipCertificate`, args: { lens, owner, parcelId }, actAs: lens });
  const [cert] = await activeContracts(cfg, lens, `${PKG}:Proposal:OwnershipCertificate`);
  await createContract(cfg, {
    templateId: `${PKG}:Proposal:PurchaseProposal`,
    args: { buyer, owner, lens, parcelId, price, certCid: cert.contractId }, actAs: buyer,
  });

  console.log(JSON.stringify({ parcelId, price, lens, owner, buyer }, null, 2));
  console.error(`\nView as owner: http://localhost:3000/canton.html?party=${encodeURIComponent(owner)}`);
};

main().catch((e) => { console.error('SEED FAILED:', e?.message || e); process.exit(1); });
