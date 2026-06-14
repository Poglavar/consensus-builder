// Domain reads for the Canton purchase model: list a party's active
// PurchaseProposals / Sales from the ledger ACS and map them to plain DTOs.
// (CCView indexing does not cover application contracts, only Canton Coin /
// network data, so we read the ledger directly via backend/canton/ledger.js.)

import { cantonConfig } from './token.js';
import { activeContracts } from './ledger.js';

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
