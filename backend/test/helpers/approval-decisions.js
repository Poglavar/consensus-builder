// Signed owner-decision fixtures for approval tests: four owners across three parcels (C co-owned,
// with a second signer for C), a lens member attesting rights and authority, and wallets that sign.
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApprovalAttester, normalizeRegistry } from '../../lens/approval.js';

const require = createRequire(import.meta.url);
const approval = require('../../../frontend/js/proposals/approval.js');
const proof = require('../../../frontend/js/proposals/approval-proof.js');
const relay = require('../../../frontend/js/proposals/approval-relay.js');
const LensCore = require('../../../frontend/js/lens-core.js');

export const NOW = Math.floor(Date.now() / 1000) - 60;
export const at = offsetSeconds => new Date((NOW + offsetSeconds) * 1000).toISOString();
export const TERMS = 'consent1-sha256:terms-1';

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
// Owner C has two signers: its own wallet and a second one (e.g. a representative).
export const registry = normalizeRegistry({
    schema: 'lens-rights-registry/v1', parcels,
    signers: [...['a', 'b', 'c', 'd'].map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })),
        { ownerId: 'owner-c', wallet: wallets.c2.address }]
});
export const approvalConfig = {
    schema: 'proposal-approval/v1',
    rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: parcels.map(p => ({ ...p, complete: true })) },
    policy: { type: 'unanimous' }
};
export const proposal = (overrides = {}) => JSON.parse(JSON.stringify({
    proposalId: 'relay-proposal', serverProposalId: '41', lifecycleStatus: 'Active',
    cadastreParcelIds: ['parcel-a', 'parcel-b', 'parcel-c'], approvalConfig, lens: [MEMBER], ...overrides
}));

export function attesterFor(keypair = memberKeypair) {
    return createApprovalAttester({ keypair, registry, clock: { nowSeconds: () => NOW } });
}
export function evidenceFor(who, ownerId, item = proposal(), attester = attesterFor()) {
    const contextHash = approval.contextHash(item);
    const challenged = attester.issueChallenge({ wallet: who.address, contextHash });
    const facts = attester.attestAuthority({ wallet: who.address, challenge: challenged.challenge, signature: who.signText(challenged.message),
        cadastreParcelIds: item.cadastreParcelIds, approvalConfig: item.approvalConfig, lens: item.lens });
    return { rights: facts.rights, authority: facts.authority.find(fact => fact.ownerId === ownerId) };
}
export function decision(who, ownerId, { decision: kind = 'approve', offset = 0, terms = TERMS, item = proposal(), evidence } = {}) {
    const receipt = { ownerId, actorId: who.address, effectHash: terms, evidence: evidence || evidenceFor(who, ownerId, item),
        acceptedAt: at(offset), decision: kind, providerId: relay.LENS_PROVIDER };
    const statement = approval.decisionContent(item, receipt);
    return { ...receipt, decisionProof: { scheme: proof.DECISION_SCHEME, signature: who.signText(proof.decisionMessage(statement)) } };
}
