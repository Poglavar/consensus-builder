// Reject unusable or foreign SAS accounts before an offer can be published or minted.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { client } from '../property-offers/onchain.js';
const authority = Keypair.fromSeed(new Uint8Array(32).fill(81)).publicKey;
const credential = Keypair.fromSeed(new Uint8Array(32).fill(82)).publicKey;
const owner = new PublicKey(client.constants.SAS_PROGRAM_ID);
const vec = value => { const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); };
function fixture() {
    return { authority, credential,
        credentialInfo: { owner, data: Buffer.concat([Buffer.from([0]), authority.toBuffer()]) },
        schemaInfo: { owner, data: Buffer.concat([Buffer.from([1]), credential.toBuffer(), vec('PropertyOfferDecision'), vec(''), vec('fields'), vec([1,2,3]), Buffer.from([0,1])]) } };
}
describe('property offer SAS preflight accounts', () => {
    it('accepts the active schema under the selected lens credential', () => {
        expect(client.validateDecisionSchema(fixture())).toBe(true);
    });
    it('rejects missing, foreign, truncated or paused schema accounts', () => {
        const cases = [
            f => { f.schemaInfo = null; },
            f => { f.schemaInfo.owner = authority; },
            f => { f.credentialInfo.data[1] ^= 1; },
            f => { f.schemaInfo.data[1] ^= 1; },
            f => { f.schemaInfo.data = f.schemaInfo.data.subarray(0,40); },
            f => { f.schemaInfo.data[f.schemaInfo.data.length - 2] = 1; }
        ];
        for (const change of cases) { const f = fixture(); change(f); expect(() => client.validateDecisionSchema(f)).toThrow(); }
    });
});
