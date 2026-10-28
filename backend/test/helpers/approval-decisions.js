// Signed owner-decision fixtures for approval tests: four owners across three parcels (C co-owned,
// with a second signer for C), a lens member attesting rights and authority from a static registry
// (lens-rights-registry/v1, the member's --rights file), wallets that sign, and the published agreement
// every decision is taken on: decisions sign its CID (agreement-decision/v1, plan-design-agreement.md
// M2), so a counter-agreement over the same land has decisions of its own. The attester reads its
// registry per request (lens/approval.js), so evidence and decisions are async.
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApprovalAttester, fileRegistry } from '../../lens/approval.js';

const require = createRequire(import.meta.url);
const approval = require('../../../frontend/js/proposals/approval.js');
const proof = require('../../../frontend/js/proposals/approval-proof.js');
const relay = require('../../../frontend/js/proposals/approval-relay.js');
const LensCore = require('../../../frontend/js/lens-core.js');
const Cid = require('../../../frontend/js/cid.js');

export const NOW = Math.floor(Date.now() / 1000) - 60;
export const at = offsetSeconds => new Date((NOW + offsetSeconds) * 1000).toISOString();

export function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const address = LensCore.base58Encode(new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')));
    return { address, signText: text => LensCore.base58Encode(new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey))) };
}
export const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet(), c2: wallet() };
export const memberKeypair = Keypair.generate();
export const MEMBER = memberKeypair.publicKey.toBase58();
export const outsider = Keypair.generate();

export const parcels = [
    { parcelId: 'parcel-a', areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
    { parcelId: 'parcel-b', areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
    { parcelId: 'parcel-c', areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
];
export const PARCEL_IDS = parcels.map(parcel => parcel.parcelId);
// Owner C has two signers: its own wallet and a second one (e.g. a representative).
export const registryFile = {
    schema: 'lens-rights-registry/v1', parcels,
    signers: [...['a', 'b', 'c', 'd'].map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })),
        { ownerId: 'owner-c', wallet: wallets.c2.address }]
};
// The member's registry source, as lens/run.mjs builds it from --rights.
export const registry = fileRegistry(registryFile);
export const approvalConfig = {
    schema: 'proposal-approval/v1',
    rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: parcels.map(p => ({ ...p, complete: true })) },
    policy: { type: 'unanimous' }
};

// The design the agreement links (a parcel layout over the three parcels), by its CID.
export const DESIGN_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'parcel-layout', title: 'Lay out the block' });
// The named plan/v1 the agreement references by CID: the one design above.
export const PLAN = { schema: 'plan/v1', title: 'Lay out the block', designCids: [DESIGN_CID], view: { at: '45.8,15.97,17', mode: '2d' } };
export const PLAN_CID = Cid.cidOfObject(PLAN);
const shareOf = text => {
    const [numerator, denominator] = text.split('/').map(Number);
    return numerator / denominator;
};

// The published agreement/v1 object (AgreementRecord.published): its plan CID, the input land with its
// holders, and the owners' rule with the lens. What the index stores as the row's content.
export function agreementContent(overrides = {}) {
    return JSON.parse(JSON.stringify({
        schema: 'agreement/v1', title: 'Block readjustment', author: 'Test author', sponsor: null, city: 'test-city',
        createdAt: '2026-10-21T10:00:00.000Z',
        planCid: PLAN_CID,
        inputs: {
            parcels: parcels.map(parcel => ({
                parcelId: parcel.parcelId, areaM2: parcel.areaM2,
                holders: parcel.owners.map(owner => ({ ownerKey: owner.ownerId, displayName: owner.ownerId, share: shareOf(owner.share) }))
            })),
            openGroundM2: 0
        },
        outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: true, approvalConfig, lens: [MEMBER] },
        deadline: null,
        ...overrides
    }));
}
export const AGREEMENT_CID = Cid.cidOfObject(agreementContent());
// The same land and rule under other terms: another object, so another CID.
export const COUNTER_AGREEMENT_CID = Cid.cidOfObject(agreementContent({ title: 'Counter-agreement', money: { currency: 'EUR', lines: [{ ownerKey: 'owner-b', amountCents: 50000 }] } }));

// The agreement-like object the decision functions take (approval.js, approval-relay.js,
// approval-anchor.js): the engine's subject plus the CID decisions sign and the lifecycle.
export const agreement = (overrides = {}) => JSON.parse(JSON.stringify({
    agreementCid: AGREEMENT_CID, lifecycleStatus: 'Active',
    cadastreParcelIds: PARCEL_IDS, approvalConfig, lens: [MEMBER], ...overrides
}));

export function attesterFor(keypair = memberKeypair) {
    return createApprovalAttester({ keypair, registry, clock: { nowSeconds: () => NOW } });
}
export async function evidenceFor(who, ownerId, item = agreement(), attester = attesterFor()) {
    const contextHash = approval.contextHash(item);
    const challenged = attester.issueChallenge({ wallet: who.address, contextHash });
    const facts = await attester.attestAuthority({ wallet: who.address, challenge: challenged.challenge, signature: who.signText(challenged.message),
        cadastreParcelIds: item.cadastreParcelIds, approvalConfig: item.approvalConfig, lens: item.lens });
    return { rights: facts.rights, authority: facts.authority.find(fact => fact.ownerId === ownerId) };
}
// One wallet-signed decision on `item`'s CID, `offset` seconds after NOW.
export async function decision(who, ownerId, { decision: kind = 'approve', offset = 0, item = agreement(), evidence } = {}) {
    const receipt = { ownerId, actorId: who.address, evidence: evidence || await evidenceFor(who, ownerId, item),
        decidedAt: at(offset), decision: kind, providerId: relay.LENS_PROVIDER };
    const statement = approval.decisionContent(item, receipt);
    return { ...receipt, decisionProof: { scheme: proof.DECISION_SCHEME, signature: who.signText(proof.decisionMessage(statement)) } };
}
