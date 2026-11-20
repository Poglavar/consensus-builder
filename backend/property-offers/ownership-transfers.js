import { createHash } from 'node:crypto';
import { canonicalBytes, cidOf } from '../cid.js';
import { LensError } from '../lens/errors.js';
import { decodeSignature } from '../lens/identity/devnet-registry.js';
import { readOwnership, registryParcelKey } from './ownership.js';
import { validateOfferAccount } from './onchain.js';

const digest = value => createHash('sha256').update(canonicalBytes(value)).digest('hex');
const ambiguous = () => new LensError(409, 'transfer_chain_conflict', 'The lens has conflicting ownership transfers for this parcel.');

function holders(rows) {
    return rows.map(({ owner, ownerCount, establishedAt, evidenceRef = null, evidenceOfferCid, evidenceLens }) => ({
        owner, ownerCount, establishedAt, evidenceRef,
        ...(evidenceOfferCid ? { evidenceOfferCid, evidenceLens } : {})
    }))
        .sort((a, b) => a.owner.localeCompare(b.owner));
}

const previousOf = (key, owners) => digest({ key, owners });
export function ownershipTransferBasis(refs, sets, network = null) {
    const parcels = refs.map(ref => {
        const key = registryParcelKey(ref);
        const owners = holders(sets.get(JSON.stringify([ref.sourceId, ref.id, ref.snapshotId || null])) || []);
        return { ref, previous: previousOf(key, owners), owners };
    });
    return { parcels, ownershipHash: digest({ network, parcels }) };
}

// A lens supplies its trusted roots and its finalized transfer evidence. The parcel key stays
// constant across the chain. A competing successor leaves the parcel unresolved for this lens.
export function resolveOwnershipTransfers(roots, records) {
    const successors = new Map();
    for (const { proof, observedAt, terminal } of records) {
        if (terminal !== 'settled') continue;
        const evidenceRef = cidOf(canonicalBytes(proof));
        for (const parcel of proof.parcels) {
            const key = registryParcelKey(parcel.ref);
            if (!roots.has(key)) continue;
            const matching = successors.get(parcel.previous) || [];
            matching.push({ owner: proof.buyer, ownerCount: 1, establishedAt: observedAt, evidenceRef,
                evidenceOfferCid: proof.cid, evidenceLens: proof.lens, parcelUid: key });
            successors.set(parcel.previous, matching);
        }
    }
    const result = new Map(roots);
    for (const [key, rows] of roots) {
        let current = rows;
        const visited = new Set();
        for (;;) {
            const prior = previousOf(key, holders(current));
            const next = successors.get(prior);
            if (!next) break;
            if (visited.has(prior) || next.length !== 1) throw ambiguous();
            visited.add(prior);
            current = next;
        }
        result.set(key, current);
    }
    return result;
}

function settledFor(record, account) {
    const { proof, decision } = record;
    const allPaid = (1 << account.payouts.length) - 1;
    return account.decisionAttestation === decision && account.buyer === proof.buyer && account.seller === proof.seller
        && account.payoutsHash === proof.payoutsHash && account.termsHash === proof.termsHash
        && account.escrowLamports === 0n && account.payoutsReleased === account.payouts.length && account.paidBitmap === allPaid;
}

export function createOwnershipTransfers({ store, authority, network, loadOffer, readFinalized }) {
    async function reconcile(record) {
        if (record.terminal) return record;
        const offer = await loadOffer(record.cid);
        const result = offer && await readFinalized(offer);
        if (!result || !['Settled', 'Cancelled', 'Expired'].includes(result.account.status)) return record;
        const { account, observedAt } = result;
        validateOfferAccount(offer, account);
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) return record;
        if (account.status === 'Settled' && !settledFor(record, account)) {
            throw new LensError(409, 'transfer_settlement_mismatch', 'The finalized settlement differs from the signed ownership transfer.');
        }
        const terminal = account.status === 'Settled' ? 'settled' : 'void';
        return store.observe(authority, network, record.cid, { terminal, observedAt });
    }

    async function resolve(roots, { db, refresh = true } = {}) {
        if (!roots.size) return roots;
        const records = await store.list(authority, network, [...roots.keys()], db);
        const resolved = [];
        for (const record of records) resolved.push(refresh ? await reconcile(record) : record);
        return resolveOwnershipTransfers(roots, resolved);
    }

    return {
        network,
        resolve,
        async reserve({ offer, fields, basis, consents, decision, identity }) {
            const { cid, offer: address, termsHash, payoutsHash, buyer, seller } = fields;
            const keys = basis.parcels.map(parcel => registryParcelKey(parcel.ref));
            const proof = { schema: 'parcel-ownership-transfer/v1', cid, offer: address, lens: authority,
                network, termsHash, payoutsHash, buyer, seller, ownershipHash: basis.ownershipHash, parcels: basis.parcels,
                consents: consents.map(({ owner, signature }) => ({ owner, signature: decodeSignature(signature).toString('base64') }))
                    .sort((a, b) => a.owner.localeCompare(b.owner)) };
            await store.reserve({ lens: authority, network, cid, keys, proof, decision }, async db => {
                const roots = await identity.rootOwnerSets(keys, db);
                const current = await resolve(roots, { db, refresh: false });
                const sets = await readOwnership(offer.content.parcels, { ownerSets: async () => current });
                if (ownershipTransferBasis(offer.content.parcels, sets, network).ownershipHash !== basis.ownershipHash) {
                    throw new LensError(409, 'ownership_changed', 'Ownership evidence changed. Review the offer and collect fresh seller signatures.');
                }
            });
        },
        async evidence(cid) {
            const record = await store.get(authority, network, cid);
            if (!record) return null;
            const final = await reconcile(record);
            if (final.terminal !== 'settled') return null;
            return { id: cidOf(canonicalBytes(final.proof)), proof: final.proof, decision: final.decision, observedAt: final.observedAt };
        }
    };
}
