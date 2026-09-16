// Source-of-truth cross-checks for the proposal_market Anchor program, which reads proposal_nft's
// Proposal account by a hand-mirrored prefix struct instead of declare_program!. If anyone reorders
// or retypes a field in proposal_nft::Proposal ahead of `status`, changes its discriminator, or
// moves the program, the market would misread every proposal — so the two Rust files and the two
// checked-in IDLs are pinned to each other here, the same way chain-status-codec.test.js pins the
// status enum.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const solanaDir = path.resolve(here, '../../blockchain/solana');
const proposalNftRs = readFileSync(path.join(solanaDir, 'programs/proposal_nft/src/lib.rs'), 'utf8');
const marketRs = readFileSync(path.join(solanaDir, 'programs/proposal_market/src/lib.rs'), 'utf8');
const proposalNftIdl = JSON.parse(readFileSync(path.join(solanaDir, 'idl/proposal_nft.json'), 'utf8'));
const marketIdl = JSON.parse(readFileSync(path.join(solanaDir, 'idl/proposal_market.json'), 'utf8'));

// `pub name: Type,` lines of one struct body, in order.
function structFields(source, header) {
    const start = source.indexOf(header);
    expect(start, `struct header not found: ${header}`).toBeGreaterThan(-1);
    const body = source.slice(start + header.length, source.indexOf('}', start));
    return body.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('pub '))
        .map(line => {
            const m = line.match(/^pub (\w+): ([^,]+),?$/);
            expect(m, `unparsed field line: ${line}`).not.toBeNull();
            return { name: m[1], type: m[2].trim() };
        });
}

function anchorDiscriminator(prefix, name) {
    return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
}

describe('proposal_market reads proposal_nft::Proposal by a mirrored prefix', () => {
    it('mirrors the exact field order and types up to and including status', () => {
        const proposal = structFields(proposalNftRs, 'pub struct Proposal {');
        const head = structFields(marketRs, 'struct ProposalHead {');

        expect(head.length).toBeGreaterThan(0);
        expect(head.at(-1).name).toBe('status');
        const prefix = proposal.slice(0, head.length);
        // The status enum is a unit borsh enum: one byte, which the mirror reads as u8.
        const normalised = prefix.map(f => (f.name === 'status' ? { ...f, type: 'u8' } : f));
        expect(head).toEqual(normalised);
        expect(proposal[head.length - 1].type).toBe('ProposalStatus');
    });

    it('pins the Proposal discriminator to the checked-in proposal_nft IDL and to Anchor\'s formula', () => {
        const constant = marketRs.match(/PROPOSAL_DISCRIMINATOR: \[u8; 8\] = \[([^\]]+)\]/);
        expect(constant).not.toBeNull();
        const bytes = constant[1].split(',').map(s => Number(s.trim()));
        const idlAccount = proposalNftIdl.accounts.find(a => a.name === 'Proposal');
        expect(bytes).toEqual(idlAccount.discriminator);
        expect(bytes).toEqual(anchorDiscriminator('account', 'Proposal'));
    });

    it('pins the proposal_nft program id to that program\'s declare_id and IDL address', () => {
        const constant = marketRs.match(/PROPOSAL_NFT_PROGRAM_ID: Pubkey = pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
        const declared = proposalNftRs.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
        expect(constant).not.toBeNull();
        expect(constant[1]).toBe(declared[1]);
        expect(constant[1]).toBe(proposalNftIdl.address);
    });

    it('pins the status variant indices to the proposal_nft enum order', () => {
        const enumStart = proposalNftRs.indexOf('pub enum ProposalStatus {');
        const enumBody = proposalNftRs.slice(enumStart, proposalNftRs.indexOf('}', enumStart));
        const variants = [...enumBody.matchAll(/(\w+) = (\d+)/g)].map(m => [m[1], Number(m[2])]);
        expect(Object.fromEntries(variants)).toEqual({ Active: 0, Executed: 1, Cancelled: 2, Expired: 3 });
        expect(marketRs).toMatch(/STATUS_ACTIVE: u8 = 0;/);
        expect(marketRs).toMatch(/STATUS_EXECUTED: u8 = 1;/);
        expect(marketRs).toMatch(/STATUS_CANCELLED: u8 = 2;/);
    });
});

describe('the checked-in proposal_market IDL matches the program source', () => {
    it('declares the same program id as lib.rs, Anchor.toml and the frontend address book', () => {
        const declared = marketRs.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1];
        expect(marketIdl.address).toBe(declared);
        const anchorToml = readFileSync(path.join(solanaDir, 'Anchor.toml'), 'utf8');
        const tomlIds = [...anchorToml.matchAll(/proposal_market = "([^"]+)"/g)].map(m => m[1]);
        expect(tomlIds).toEqual([declared, declared]);
        const addresses = JSON.parse(readFileSync(path.resolve(here, '../../frontend/contracts/addresses.json'), 'utf8'));
        expect(addresses['solana-devnet'].ProposalMarket).toBe(declared);
    });

    it('exposes exactly the four instructions and two accounts with Anchor-formula discriminators', () => {
        expect(marketIdl.instructions.map(i => i.name).sort()).toEqual(['claim', 'create_market', 'resolve', 'stake']);
        for (const ix of marketIdl.instructions) {
            expect(ix.discriminator).toEqual(anchorDiscriminator('global', ix.name));
        }
        expect(marketIdl.accounts.map(a => a.name).sort()).toEqual(['Market', 'Position']);
        for (const account of marketIdl.accounts) {
            expect(account.discriminator).toEqual(anchorDiscriminator('account', account.name));
        }
    });

    it('lays out Market and Position exactly as the client decoder expects', () => {
        const fields = name => marketIdl.types.find(t => t.name === name).type.fields.map(f => [f.name, f.type]);
        expect(fields('Market')).toEqual([
            ['proposal', 'pubkey'], ['stake_mint', 'pubkey'], ['vault', 'pubkey'],
            ['yes_pool', 'u64'], ['no_pool', 'u64'], ['resolved', 'bool'], ['outcome', 'u8'], ['bump', 'u8']
        ]);
        expect(fields('Position')).toEqual([
            ['market', 'pubkey'], ['owner', 'pubkey'], ['side', 'u8'], ['amount', 'u64'], ['claimed', 'bool'], ['bump', 'u8']
        ]);
    });
});
