// Test helper: the bytes of a proposal_nft Proposal account laid out field by field from the
// checked-in IDL order (discriminator, proposal_id, owner, parcel_ids, is_conditional, image_uri,
// acceptance_possible, status, sol_balance, token_balance, acceptance_count, accepted_parcels, lens,
// bump, verdict_may_execute), so oracle tests read the same layout the programs write.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const str = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); };
const vec = (items, encode) => Buffer.concat([u32(items.length), ...items.map(encode)]);

export const PROPOSAL_DISCRIMINATOR = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);

export function proposalAccountBytes({
    status = 0,
    owner = '11111111111111111111111111111111',
    parcelIds = ['HR-1'],
    acceptedParcels = [],
    lens = [],
    verdictMayExecute = false
} = {}) {
    return Buffer.concat([
        PROPOSAL_DISCRIMINATOR,
        u64(7),
        new PublicKey(owner).toBuffer(),
        vec(parcelIds, str),
        Buffer.from([1]),
        str('https://example.test/proposal'),
        Buffer.from([status === 0 ? 1 : 0]),
        Buffer.from([status]),
        u64(0), u64(0), u64(acceptedParcels.length),
        vec(acceptedParcels, str),
        vec(lens, key => new PublicKey(key).toBuffer()),
        Buffer.from([254]),
        Buffer.from([verdictMayExecute ? 1 : 0])
    ]);
}
