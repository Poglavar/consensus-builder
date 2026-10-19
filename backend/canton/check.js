// CLI check: reproduces the purchase flow using ONLY the backend/canton module
// (token.js + ledger.js), proving the reusable client works end-to-end against
// the live 5n sandbox. Not a route — a manual verification tool.
//
// Run (Canton config read from backend/.env):
//   node backend/canton/check.js
// Optionally set DAR_PATH to upload the DAR first.

import './load-env.js';
import { readFile } from 'node:fs/promises';
import { cantonConfig } from './token.js';
import {
  uploadDar, allocateParty, grantActAs, createContract, exerciseChoice, activeContracts,
} from './ledger.js';

const env = process.env;
const PKG = env.PACKAGE_REF || '#consensus-builder-daml';
const PARCEL_ID = env.PARCEL_ID || `PARCEL-${Date.now()}`;
const PRICE = env.PRICE || '100.0';
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const main = async () => {
  const cfg = cantonConfig(env);
  if (!cfg.ledgerApiUrl || !cfg.userId) throw new Error('missing CANTON_LEDGER_API_URL / CANTON_USER_ID in backend/.env');
  log(`ledger=${cfg.ledgerApiUrl} userId=${cfg.userId} pkg=${PKG}`);

  if (env.DAR_PATH) {
    log(`uploading DAR ${env.DAR_PATH} ...`);
    await uploadDar(cfg, await readFile(env.DAR_PATH));
  }

  const tag = `${Date.now()}`;
  const lens = await allocateParty(cfg, `Lens-${tag}`);
  const owner = await allocateParty(cfg, `Owner-${tag}`);
  const buyer = await allocateParty(cfg, `Buyer-${tag}`);
  for (const p of [lens, owner, buyer]) await grantActAs(cfg, cfg.userId, p);
  log(`parties allocated + actAs granted to user ${cfg.userId}`);

  log('1) lens creates OwnershipCertificate ...');
  await createContract(cfg, {
    templateId: `${PKG}:Proposal:OwnershipCertificate`,
    args: { lens, owner, parcelId: PARCEL_ID }, actAs: lens,
  });
  const [cert] = await activeContracts(cfg, lens, `${PKG}:Proposal:OwnershipCertificate`);
  if (!cert) throw new Error('cert not visible to lens');
  log(`   cert ${cert.contractId}`);

  log('2) buyer creates PurchaseProposal (owner as observer) ...');
  const IMAGE_URI = env.IMAGE_URI || 'ipfs://bafyCheckScriptMetadata';
  await createContract(cfg, {
    templateId: `${PKG}:Proposal:PurchaseProposal`,
    args: { buyer, owner, lens, parcelId: PARCEL_ID, price: PRICE, certCid: cert.contractId, imageUri: IMAGE_URI },
    actAs: buyer,
  });

  log('3) owner visibility check ...');
  const [proposal] = await activeContracts(cfg, owner, `${PKG}:Proposal:PurchaseProposal`);
  if (!proposal) throw new Error('proposal NOT visible to owner');
  log(`   ✓ owner sees proposal ${proposal.contractId}`);
  const seenUri = proposal.createArgument?.imageUri;
  if (seenUri !== IMAGE_URI) throw new Error(`imageUri not on the ledger: ${JSON.stringify(seenUri)}`);
  log(`   ✓ imageUri round-tripped: ${seenUri}`);

  log('4) owner exercises Accept ...');
  await exerciseChoice(cfg, {
    templateId: `${PKG}:Proposal:PurchaseProposal`, contractId: proposal.contractId,
    choice: 'Accept', actAs: owner,
  });

  log('5) confirming Sale + archival ...');
  const sales = await activeContracts(cfg, owner, `${PKG}:Proposal:Sale`);
  const stillProposed = await activeContracts(cfg, owner, `${PKG}:Proposal:PurchaseProposal`);
  if (!sales.length) throw new Error('Sale not created');
  if (stillProposed.length) throw new Error('proposal not archived');
  log(`   ✓ Sale ${sales[0].contractId}; proposal archived.`);

  log('CHECK OK — backend/canton module verified end-to-end on DevNet.');
};

main().catch((e) => { console.error('CHECK FAILED:', e?.message || e); process.exit(1); });
