// The Solana proposal parser in frontend/js/solana/chain-data-loader.js must decode `lens:
// Vec<Pubkey>` instead of returning []. The account bytes are Borsh-encoded field by field from the
// committed proposal_nft IDL, so a layout change in the IDL breaks this test rather than the app.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as web3 from '@solana/web3.js';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_nft.json'), 'utf8'));
const PROPOSAL_FIELDS = IDL.types.find(type => type.name === 'Proposal').type.fields;

const keyOf = byte => new web3.PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function str(s) { const bytes = Buffer.from(s, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); }

function encodeField(type, value) {
    if (type === 'u64') return u64(value);
    if (type === 'u8' || type === 'bool') return Buffer.from([Number(value)]);
    if (type === 'pubkey') return Buffer.from(new web3.PublicKey(value).toBytes());
    if (type === 'string') return str(value);
    if (type.vec) return Buffer.concat([u32(value.length), ...value.map(item => encodeField(type.vec, item))]);
    if (type.defined) return Buffer.from([value]); // fieldless enum: u8 variant index
    if (type.array) return Buffer.from(value);
    throw new Error(`unhandled IDL type ${JSON.stringify(type)}`);
}

function encodeProposal(values, { padTo = 0, extra = Buffer.alloc(0) } = {}) {
    const body = Buffer.concat([
        Buffer.alloc(8, 1), // discriminator (not checked by the parser)
        ...PROPOSAL_FIELDS.map(field => {
            if (!(field.name in values)) throw new Error(`test value missing for ${field.name}`);
            return encodeField(field.type, values[field.name]);
        }),
        extra
    ]);
    return padTo > body.length ? Buffer.concat([body, Buffer.alloc(padTo - body.length)]) : body;
}

const VALUES = {
    proposal_id: 42,
    owner: keyOf(3),
    parcel_ids: ['HR-335550-1/1', 'HR-335550-2/1'],
    is_conditional: true,
    image_uri: 'ipfs://meta',
    acceptance_possible: true,
    status: 0,
    sol_balance: 5,
    token_balance: 0,
    acceptance_count: 1,
    accepted_parcels: ['HR-335550-1/1'],
    lens: [keyOf(7), keyOf(9)],
    bump: 253,
    verdict_may_execute: false,
    site_hash: Array(32).fill(0),
    open_ground: false,
    open_ground_cleared: false,
    layout_version: 3
};

let loader;
beforeAll(() => {
    // The loader is a classic browser script: give it the globals the page gives it.
    globalThis.window = {
        solanaWeb3: web3,
        LensCore: require('../../frontend/js/lens-core.js'),
        ProposalChainStatus: require('../../frontend/js/proposals/chain-status.js')
    };
    require('../../frontend/js/solana/chain-data-loader.js');
    loader = globalThis.window.SolanaChainDataLoader;
});

describe('Solana proposal parser lens', () => {
    it('the IDL still places lens after accepted_parcels and before bump', () => {
        const names = PROPOSAL_FIELDS.map(field => field.name);
        expect(names.indexOf('lens')).toBe(names.indexOf('accepted_parcels') + 1);
        expect(names[names.indexOf('lens') + 1]).toBe('bump');
    });

    it('decodes the lens keys from a fixed-size, zero-padded account', () => {
        const parsed = loader.parseProposalAccount(encodeProposal(VALUES, { padTo: 4096 }), 'Proposal1111');
        expect(parsed).toMatchObject({
            cadastreParcelIds: VALUES.parcel_ids,
            acceptedParcels: VALUES.accepted_parcels,
            owner: VALUES.owner,
            lens: VALUES.lens,
            lensError: null
        });
    });

    it('the IDL appends verdict_may_execute right after bump (v2), then the v3 site fields', () => {
        const names = PROPOSAL_FIELDS.map(field => field.name);
        expect(names[names.indexOf('bump') + 1]).toBe('verdict_may_execute');
        expect(names.slice(names.indexOf('verdict_may_execute') + 1)).toEqual(['site_hash', 'open_ground', 'open_ground_cleared', 'layout_version']);
    });

    it('decodes the v3 site fields; zero bytes (a v1/v2-era account) read as no site and closed ground', () => {
        const site = loader.parseProposalAccount(encodeProposal({
            ...VALUES, parcel_ids: [], accepted_parcels: [], site_hash: Array(32).fill(0x5c), open_ground: true, open_ground_cleared: true
        }, { padTo: 4096 }), 'Proposal1111');
        expect(site).toMatchObject({ cadastreParcelIds: [], siteHash: '5c'.repeat(32), openGround: true, openGroundCleared: true, layoutVersion: 3, lensError: null });
        const none = loader.parseProposalAccount(encodeProposal(VALUES, { padTo: 4096 }), 'Proposal1111');
        expect(none).toMatchObject({ siteHash: null, openGround: false, openGroundCleared: false, layoutVersion: 3 });
        const legacy = loader.parseProposalAccount(encodeProposal({ ...VALUES, layout_version: 0 }, { padTo: 4096 }), 'Proposal1111');
        expect(legacy).toMatchObject({ siteHash: null, openGround: false, openGroundCleared: false, layoutVersion: 0 });
    });

    it('decodes verdict_may_execute; a zero byte (v1-era account) reads false', () => {
        const on = loader.parseProposalAccount(encodeProposal({ ...VALUES, verdict_may_execute: true }, { padTo: 4096 }), 'Proposal1111');
        expect(on.verdictMayExecute).toBe(true);
        expect(on.lens).toEqual(VALUES.lens);
        const off = loader.parseProposalAccount(encodeProposal(VALUES, { padTo: 4096 }), 'Proposal1111');
        expect(off.verdictMayExecute).toBe(false);
    });

    it('decodes Expired (3) as a status', () => {
        const parsed = loader.parseProposalAccount(encodeProposal({ ...VALUES, status: 3 }, { padTo: 4096 }), 'Proposal1111');
        expect(parsed.status).toBe('Expired');
    });

    it('tolerates fields appended after layout_version', () => {
        const parsed = loader.parseProposalAccount(encodeProposal(VALUES, { extra: Buffer.from([1, 9, 9, 9]) }), 'Proposal1111');
        expect(parsed.lens).toEqual(VALUES.lens);
        expect(parsed.verdictMayExecute).toBe(false);
    });

    it('reports a truncated lens instead of inventing one', () => {
        const full = encodeProposal(VALUES);
        const parsed = loader.parseProposalAccount(full.subarray(0, full.length - 40), 'Proposal1111');
        expect(parsed.lens).toEqual([]);
        expect(parsed.lensError).toMatch(/does not fit/);
        // everything before the lens is still read
        expect(parsed.acceptedParcels).toEqual(VALUES.accepted_parcels);
    });
});
