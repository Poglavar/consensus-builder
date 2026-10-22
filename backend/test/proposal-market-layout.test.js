// Source-of-truth cross-checks of what proposal_market reads. Since M3 its subject (the IDL's
// `proposal` account) is an Agreement account of the agreement program, read with
// agreement::read_agreement_view: the agreement crate's own offsets, with no layout mirrored in this
// program. The agreement struct in Rust, the reader's offsets, the agreement IDL, the JS codec
// (frontend/js/solana/agreement-client.js) and the test encoder (fixtures/agreement-account.js) are
// pinned to each other here, so a field moved in one of them and not the others fails. The market's
// own IDL is pinned to its source below.
import { afterAll, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agreementRustLayout, readSolana, rustFnBody } from './helpers/agreement-layout.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountBytes } from './fixtures/agreement-account.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const layout = agreementRustLayout();
const agreementIdl = JSON.parse(readSolana('idl/agreement.json'));
const marketRs = readSolana('programs/proposal_market/src/lib.rs');
const lmsrRs = readSolana('programs/proposal_market/src/lmsr_market.rs');
const marketCargo = readSolana('programs/proposal_market/Cargo.toml');
const marketIdl = JSON.parse(readSolana('idl/proposal_market.json'));

// The codec resolves web3 relative to frontend/js/solana, where the package is not installed.
agreementClient.configure({ web3 });
afterAll(() => { agreementClient.configure({ web3: null }); });

function anchorDiscriminator(prefix, name) {
    return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
}

const keyOf = byte => new web3.PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const keyAt = (bytes, offset) => new web3.PublicKey(bytes.subarray(offset, offset + 32)).toBase58();
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const SPONSOR = keyOf(7);
const LENS = keyOf(11);
const PAYOUT = keyOf(13);

describe('the Agreement account the market and pledge programs read', () => {
    it('declares its fields in the order the IDL and the JS codec decode, status at byte 136', () => {
        const idlFields = agreementIdl.types.find(type => type.name === 'Agreement').type.fields.map(field => field.name);
        expect(layout.fields.map(field => field.name)).toEqual(idlFields);
        const { authority, lens, payout, deadline, status, decision, cid } = layout.offsets;
        expect({ authority, lens, payout, deadline, status, decision, cid }).toEqual(agreementClient.AGREEMENT_OFFSETS);
        expect(status).toBe(136);
    });

    it('reads authority, lens and status at offsets its own constants derive from the struct', () => {
        expect(layout.offsets.authority).toBe(8);
        expect(layout.LENS_OFFSET).toBe(layout.offsets.lens);
        expect(layout.STATUS_OFFSET).toBe(layout.offsets.status);
        const reader = rustFnBody(layout.source, 'read_agreement_view');
        expect(reader).toContain('*account.owner != crate::ID');
        expect(reader).toContain('data.len() <= STATUS_OFFSET');
        expect(reader).toContain('data[..8] != Agreement::DISCRIMINATOR');
        expect(reader).toContain('authority: key_at(8)?');
        expect(reader).toContain('lens: key_at(LENS_OFFSET)?');
        expect(reader).toContain('status: data[STATUS_OFFSET]');
    });

    it('reads exactly what the JS encoder writes and the codec decodes, for every status', () => {
        const discriminator = anchorDiscriminator('account', 'Agreement');
        expect(Array.from(agreementClient.ACCOUNT_DISCRIMINATORS.Agreement)).toEqual(discriminator);
        expect(agreementIdl.accounts.find(account => account.name === 'Agreement').discriminator).toEqual(discriminator);
        for (const [name, code] of Object.entries(layout.statusCodes)) {
            const bytes = agreementAccountBytes({ cid: CID, authority: SPONSOR, lens: LENS, payout: PAYOUT, status: code, deadline: 1_795_000_000 });
            expect(bytes.length).toBeGreaterThan(layout.STATUS_OFFSET);
            expect(Array.from(bytes.subarray(0, 8))).toEqual(discriminator);
            expect(keyAt(bytes, layout.offsets.authority)).toBe(SPONSOR);
            expect(keyAt(bytes, layout.LENS_OFFSET)).toBe(LENS);
            expect(bytes[layout.STATUS_OFFSET], name).toBe(code);
            expect(agreementClient.readAgreement(bytes)).toMatchObject({
                authority: SPONSOR, lens: LENS, payout: PAYOUT, statusCode: code, status: name, deadline: 1_795_000_000, cid: CID
            });
        }
    });

    it('codes its status as the codec and the markets name it', () => {
        expect(layout.statusCodes).toEqual({ Active: 0, Executed: 1, Cancelled: 2, Expired: 3 });
        expect(agreementClient.STATUS_NAMES).toEqual(Object.keys(layout.statusCodes));
        const C = agreementClient.constants;
        expect([C.STATUS_ACTIVE, C.STATUS_EXECUTED, C.STATUS_CANCELLED, C.STATUS_EXPIRED]).toEqual(Object.values(layout.statusCodes));
        expect(layout.decisionCodes).toEqual({ Pending: C.DECISION_PENDING, Satisfied: C.DECISION_SATISFIED });
    });

    it('is owned by the program id the JS codec derives addresses and filters with', () => {
        expect(agreementIdl.address).toBe(layout.programId);
        expect(agreementClient.constants.AGREEMENT_PROGRAM_ID).toBe(layout.programId);
        expect(AGREEMENT_PROGRAM_ID).toBe(layout.programId);
        const tomlIds = [...readSolana('Anchor.toml').matchAll(/^agreement = "([^"]+)"/gm)].map(match => match[1]);
        expect(tomlIds).toEqual([layout.programId, layout.programId]);
    });
});

describe('proposal_market reads its subject only through agreement::read_agreement_view', () => {
    it('takes its status codes from the agreement crate', () => {
        for (const name of ['Active', 'Executed', 'Cancelled', 'Expired']) {
            expect(marketRs).toContain(`pub const STATUS_${name.toUpperCase()}: u8 = agreement::AgreementStatus::${name} as u8;`);
        }
    });

    it('reads every subject with the shared reader and mirrors no layout of its own', () => {
        expect(rustFnBody(marketRs, 'read_subject')).toContain('agreement::read_agreement_view(subject)');
        expect(lmsrRs).toContain('read_subject(');
        for (const source of [marketRs, lmsrRs]) {
            expect(source).not.toMatch(/ProposalHead|ProposalLensView|PROPOSAL_NFT_PROGRAM_ID|PROPOSAL_DISCRIMINATOR|proposal_nft::/);
            expect(source).not.toMatch(/read_agreement_view\(.*\)\s*\.\s*data|STATUS_OFFSET|LENS_OFFSET/);
        }
        expect(marketCargo).toContain('agreement = { path = "../agreement", features = ["no-entrypoint"] }');
        expect(marketCargo).not.toMatch(/^proposal_nft\s*=/m);
        // The source says where the status byte is; it says the reader's offset.
        expect(Number(marketRs.match(/status\s+(?:\/\/\s+)?at offset (\d+)/)[1])).toBe(layout.STATUS_OFFSET);
    });
});

describe('the checked-in proposal_market IDL matches the program source', () => {
    it('declares the same program id as lib.rs, Anchor.toml and the frontend address book', () => {
        const declared = marketRs.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1];
        expect(marketIdl.address).toBe(declared);
        const anchorToml = readFileSync(path.join(here, '../../blockchain/solana/Anchor.toml'), 'utf8');
        const tomlIds = [...anchorToml.matchAll(/proposal_market = "([^"]+)"/g)].map(m => m[1]);
        expect(tomlIds).toEqual([declared, declared]);
        const addresses = JSON.parse(readFileSync(path.resolve(here, '../../frontend/contracts/addresses.json'), 'utf8'));
        expect(addresses['solana-devnet'].ProposalMarket).toBe(declared);
    });

    it('exposes the parimutuel, external-evidence and LMSR instructions with Anchor-formula discriminators', () => {
        expect(marketIdl.instructions.map(i => i.name).sort()).toEqual([
            'buy', 'claim', 'claim_external', 'claim_lmsr', 'create_external_market', 'create_lmsr_external_market',
            'create_lmsr_market', 'create_market', 'reclaim_seed', 'resolve', 'resolve_external', 'resolve_lmsr',
            'sell', 'stake', 'stake_external'
        ]);
        for (const ix of marketIdl.instructions) {
            expect(ix.discriminator).toEqual(anchorDiscriminator('global', ix.name));
        }
        expect(marketIdl.accounts.map(a => a.name).sort()).toEqual(['ExternalMarket', 'LmsrMarket', 'Market', 'Position']);
        for (const account of marketIdl.accounts) {
            expect(account.discriminator).toEqual(anchorDiscriminator('account', account.name));
        }
    });

    it('lays out legacy and external markets exactly as the client decoders expect', () => {
        const fields = name => marketIdl.types.find(t => t.name === name).type.fields.map(f => [f.name, f.type]);
        expect(fields('Market')).toEqual([
            ['proposal', 'pubkey'], ['stake_mint', 'pubkey'], ['vault', 'pubkey'],
            ['yes_pool', 'u64'], ['no_pool', 'u64'], ['resolved', 'bool'], ['outcome', 'u8'], ['bump', 'u8']
        ]);
        expect(fields('Position')).toEqual([
            ['market', 'pubkey'], ['owner', 'pubkey'], ['side', 'u8'], ['amount', 'u64'], ['claimed', 'bool'], ['bump', 'u8']
        ]);
        expect(fields('ExternalMarket')).toEqual([
            ['stake_mint', 'pubkey'], ['vault', 'pubkey'],
            ['recipe_hash', { array: ['u8', 32] }], ['subject_hash', { array: ['u8', 32] }],
            ['yes_value_hash', { array: ['u8', 32] }], ['no_value_hash', { array: ['u8', 32] }],
            ['credential', 'pubkey'], ['schema', 'pubkey'], ['trusted_attester', 'pubkey'],
            ['yes_pool', 'u64'], ['no_pool', 'u64'], ['closes_at', 'i64'],
            ['resolved', 'bool'], ['outcome', 'u8'], ['evidence', 'pubkey'],
            ['evidence_hash', { array: ['u8', 32] }], ['resolved_at', 'i64'], ['bump', 'u8']
        ]);
    });
});
