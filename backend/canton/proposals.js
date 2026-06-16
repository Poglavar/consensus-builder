// Domain reads for the Canton purchase model: list a party's active
// PurchaseProposals / Sales from the ledger ACS and map them to plain DTOs.
// (CCView indexing does not cover application contracts, only Canton Coin /
// network data, so we read the ledger directly via backend/canton/ledger.js.)

import { readFile, writeFile } from 'node:fs/promises';
import { cantonConfig } from './token.js';
import { activeContracts, allocateParty, grantActAs, createContract, exerciseChoice } from './ledger.js';

const templateId = (cfg, entity) => `${cfg.packageRef}:Proposal:${entity}`;

// The public "registry" party that observes ProposalMarker contracts, giving the
// app a parcel→count signal without disclosing proposal terms. It is a single,
// STABLE, SHARED identity (unlike on-demand demo parties) — markers carry it as
// observer and we read its ACS — so it must be reused, not re-created per call.
const PUBLIC_HINT = 'CantonPublic';
const PUBLIC_FILE = new URL('./.public-party.json', import.meta.url);
let publicPartyCache = null;

async function getPublicParty(cfg = cantonConfig()) {
  if (cfg.publicParty) return cfg.publicParty;          // explicit override wins
  if (publicPartyCache) return publicPartyCache;
  try {
    const saved = JSON.parse(await readFile(PUBLIC_FILE, 'utf8'));
    if (saved && saved.party) { publicPartyCache = saved.party; return publicPartyCache; }
  } catch (_) { /* no local cache yet */ }

  // Allocate on a fresh validator — allocation is the ONLY response that returns
  // the full party id (this validator truncates ids in list/rights/error
  // responses). If the party already exists here, the full id can't be recovered
  // via the API, so it must be provided explicitly.
  let party;
  try {
    party = await allocateParty(cfg, PUBLIC_HINT);
  } catch (e) {
    if (/already (exist|allocat)/i.test(String((e && e.message) || e))) {
      throw new Error(
        'Public party already exists on this validator but its full id is not '
        + 'recoverable via the API. Set CANTON_PUBLIC_PARTY to the full id '
        + '(saved in backend/canton/.public-party.json on the machine that first '
        + 'allocated it).',
      );
    }
    throw e;
  }
  try { await grantActAs(cfg, cfg.userId, party); } catch (_) { /* best-effort */ }
  try { await writeFile(PUBLIC_FILE, JSON.stringify({ party }), 'utf8'); } catch (_) { }
  publicPartyCache = party;
  return party;
}

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
  // lens is Optional Party → a string when set, null/undefined when not.
  return { contractId: ev.contractId, parcelId: a.parcelId, price: a.price, buyer: a.buyer, owner: a.owner, lens: a.lens || undefined };
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

  const tag = Date.now().toString(36).slice(-5); // short, readable, unique-per-create
  const lens = args.lens || (await allocateParty(cfg, `Lens-${tag}`));
  const owner = args.owner || (await allocateParty(cfg, `Owner-${tag}`));
  const buyer = args.buyer || (await allocateParty(cfg, `Buyer-${tag}`));
  // Grant actAs for parties we host. A party supplied from another participant
  // (e.g. a self-custody Loop wallet owner) can't be granted here and doesn't
  // need to be — it's only an observer; it acts via its own wallet. Best-effort.
  for (const p of [lens, owner, buyer]) {
    try { await grantActAs(cfg, cfg.userId, p); } catch (_) { /* not hosted by us */ }
  }

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

  // Public existence signal (Option B): a marker observed by the public party,
  // carrying only the parcel + opaque proposal cid (no terms).
  if (created?.contractId) {
    const publicParty = await getPublicParty(cfg);
    await createContract(cfg, {
      templateId: templateId(cfg, 'ProposalMarker'),
      args: { buyer, public: publicParty, parcelId, proposalCid: created.contractId }, actAs: buyer,
    });
  }

  return { parcelId, price, lens, owner, buyer, proposalContractId: created?.contractId };
}

// Owner accepts a proposal → archives it, creates the Sale. Returns the owner's sales.
export async function acceptProposal(contractId, owner, cfg = cantonConfig()) {
  if (!contractId || !owner) throw new Error('contractId and owner are required');
  await exerciseChoice(cfg, { templateId: templateId(cfg, 'PurchaseProposal'), contractId, choice: 'Accept', actAs: owner });
  await archiveMarkerFor(contractId, cfg); // drop the public existence signal
  const sales = await activeContracts(cfg, owner, templateId(cfg, 'Sale'));
  return { ok: true, sales: sales.map(mapSale) };
}

// Archive the public marker for a (now accepted/withdrawn) proposal. Best-effort.
async function archiveMarkerFor(proposalCid, cfg = cantonConfig()) {
  try {
    const publicParty = await getPublicParty(cfg);
    const markers = await activeContracts(cfg, publicParty, templateId(cfg, 'ProposalMarker'));
    const m = markers.find((x) => x.createArgument?.proposalCid === proposalCid);
    if (m) {
      await exerciseChoice(cfg, {
        templateId: templateId(cfg, 'ProposalMarker'), contractId: m.contractId,
        choice: 'ArchiveMarker', actAs: m.createArgument.buyer,
      });
    }
  } catch (_) { /* marker cleanup is non-critical */ }
}

// Public parcel→count map from active markers (read as the public party). The
// existence signal for the map; no proposal terms are exposed.
export async function listParcelCounts(cfg = cantonConfig()) {
  const publicParty = await getPublicParty(cfg);
  const markers = await activeContracts(cfg, publicParty, templateId(cfg, 'ProposalMarker'));
  const counts = {};
  for (const m of markers) {
    const pid = m.createArgument?.parcelId;
    if (pid) counts[pid] = (counts[pid] || 0) + 1;
  }
  return counts;
}

// Allocate a fresh party we host (granted actAs to the configured user). Used by
// the UI's "stranger" perspective to show that a non-stakeholder sees nothing.
export async function allocateDemoParty(hint, cfg = cantonConfig()) {
  const party = await allocateParty(cfg, hint || `Party-${Date.now()}`);
  await grantActAs(cfg, cfg.userId, party);
  return { party };
}
