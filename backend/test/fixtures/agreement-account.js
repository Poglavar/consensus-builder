// Test helper: the bytes of an `agreement` program Agreement account, field by field in the order of
// blockchain/solana/programs/agreement/README.md ("Agreement account": discriminator, authority, lens,
// payout, deadline, created_at, required/escrow lamports, status, open_ground, decision, decision times,
// attestation, hash, executed_at, bump, cid), padded to the 296-byte account, so tests decode exactly
// what the program writes with frontend/js/solana/agreement-client.js readAgreement.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../../frontend/js/solana/agreement-client.js');

export const AGREEMENT_PROGRAM_ID = agreementClient.constants.AGREEMENT_PROGRAM_ID;
export const AGREEMENT_ACCOUNT_SPACE = agreementClient.constants.AGREEMENT_ACCOUNT_SPACE;
const DEFAULT_KEY = '11111111111111111111111111111111';

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const key = value => new PublicKey(value).toBuffer();
const str = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); };

/**
 * @param fields status/decision as codes (0 Active, 1 Executed, 2 Cancelled, 3 Expired; 0 Pending,
 *   1 Satisfied), lamports as anything BigInt takes, times as unix seconds
 */
export function agreementAccountBytes({
    cid,
    authority,
    lens = DEFAULT_KEY,
    payout = authority,
    deadline = 0,
    createdAt = 1_760_000_000,
    requiredLamports = 0,
    escrowLamports = 0,
    status = 0,
    openGround = false,
    decision = 0,
    decisionAttestedAt = 0,
    decisionObservedAt = 0,
    decisionAttestation = DEFAULT_KEY,
    decisionHash = Buffer.alloc(32),
    executedAt = 0,
    bump = 255,
    padTo = AGREEMENT_ACCOUNT_SPACE
} = {}) {
    if (!cid || !authority) throw new Error('agreementAccountBytes: cid and authority are required');
    const content = Buffer.concat([
        Buffer.from(agreementClient.ACCOUNT_DISCRIMINATORS.Agreement),
        key(authority), key(lens), key(payout),
        i64(deadline), i64(createdAt), u64(requiredLamports), u64(escrowLamports),
        Buffer.from([status, openGround ? 1 : 0, decision]),
        i64(decisionAttestedAt), i64(decisionObservedAt), key(decisionAttestation), Buffer.from(decisionHash),
        i64(executedAt), Buffer.from([bump]), str(cid)
    ]);
    return Buffer.concat([content, Buffer.alloc(Math.max(0, padTo - content.length))]);
}

/** An account info as a connection returns it: owned by the agreement program unless `owner` says otherwise. */
export function agreementAccountInfo(fields, { owner = AGREEMENT_PROGRAM_ID, lamports = 3_000_000 } = {}) {
    return { owner: new PublicKey(owner), lamports, executable: false, data: agreementAccountBytes(fields) };
}
