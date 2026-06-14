// Domain reads for the Canton purchase model: list a party's active
// PurchaseProposals / Sales from the ledger ACS and map them to plain DTOs.
// (CCView indexing does not cover application contracts, only Canton Coin /
// network data, so we read the ledger directly via backend/canton/ledger.js.)

import { cantonConfig } from './token.js';
import { activeContracts, allocateParty, grantActAs, createContract } from './ledger.js';

const templateId = (cfg, entity) => `${cfg.packageRef}:Proposal:${entity}`;

function mapProposal(ev) {
  const a = ev.createArgument || {};
  return {
    contractId: ev.contractId,
    parcelId: a.parcelId,
    price: a.price,
    buyer: a.buyer,
    owner: a.owner,
    lens: a.lens,
  };
}

function mapSale(ev) {
  const a = ev.createArgument || {};
  return { contractId: ev.contractId, parcelId: a.parcelId, price: a.price, buyer: a.buyer, owner: a.owner };
}

// Active purchase proposals visible to `party` (as buyer, owner-observer, or lens).
export async function listProposalsForParty(party, cfg = cantonConfig()) {
  const evs = await activeContracts(cfg, party, templateId(cfg, 'PurchaseProposal'));
  return evs.map(mapProposal);
}

// Completed sales visible to `party`.
export async function listSalesForParty(party, cfg = cantonConfig()) {
  const evs = await activeContracts(cfg, party, templateId(cfg, 'Sale'));
  return evs.map(mapSale);
}

// Create a proposal: lens attests ownership, then buyer offers (owner as observer).
// Any party left blank is freshly allocated on our validator (demo convenience);
// all acting parties are granted actAs to the configured user. Returns the ids +
// the new proposal's contractId.
export async function createProposal(args, cfg = cantonConfig()) {
  const parcelId = args.parcelId;
  const price = String(args.price);
  if (!parcelId || args.price == null) throw new Error('parcelId and price are required');

  const tag = `${Date.now()}`;
  const lens = args.lens || (await allocateParty(cfg, `Lens-${tag}`));
  const owner = args.owner || (await allocateParty(cfg, `Owner-${tag}`));
  const buyer = args.buyer || (await allocateParty(cfg, `Buyer-${tag}`));
  for (const p of [lens, owner, buyer]) await grantActAs(cfg, cfg.userId, p);

  await createContract(cfg, { templateId: templateId(cfg, 'OwnershipCertificate'), args: { lens, owner, parcelId }, actAs: lens });
  const certs = await activeContracts(cfg, lens, templateId(cfg, 'OwnershipCertificate'));
  const cert = certs.find((c) => c.createArgument?.parcelId === parcelId && c.createArgument?.owner === owner) || certs.at(-1);
  if (!cert) throw new Error('certificate not found after create');

  await createContract(cfg, {
    templateId: templateId(cfg, 'PurchaseProposal'),
    args: { buyer, owner, lens, parcelId, price, certCid: cert.contractId }, actAs: buyer,
  });
  const props = await activeContracts(cfg, buyer, templateId(cfg, 'PurchaseProposal'));
  const created = props.find((p) => p.createArgument?.parcelId === parcelId && p.createArgument?.owner === owner);

  return { parcelId, price, lens, owner, buyer, proposalContractId: created?.contractId };
}
