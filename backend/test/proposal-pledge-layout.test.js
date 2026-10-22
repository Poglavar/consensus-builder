// Pins the ProposalPledge source, IDL, address-book, and discriminator contracts together, and what
// the program reads of its subject: since M3 an Agreement account of the agreement program, read with
// agreement::read_agreement_view (the agreement crate's offsets; proposal-market-layout.test.js pins
// that reader to the agreement struct, its IDL, the JS codec and the test encoder). The beneficiary is
// the agreement's authority, the sponsor, and the status codes are the agreement program's.
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agreementRustLayout, readSolana, rustFnBody } from './helpers/agreement-layout.js';
import { agreementAccountBytes } from './fixtures/agreement-account.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const solana = path.resolve(here, '../../blockchain/solana');
const layout = agreementRustLayout();
const pledgeSource = readFileSync(path.join(solana, 'programs/proposal_pledge/src/lib.rs'), 'utf8');
const pledgeCargo = readSolana('programs/proposal_pledge/Cargo.toml');
const pledgeIdl = JSON.parse(readFileSync(path.join(solana, 'idl/proposal_pledge.json'), 'utf8'));

// The codec resolves web3 relative to frontend/js/solana, where the package is not installed.
agreementClient.configure({ web3 });
afterAll(() => { agreementClient.configure({ web3: null }); });

function disc(prefix, name) {
    return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
}

describe('proposal_pledge source/IDL contract', () => {
    it('reads its subject through agreement::read_agreement_view: the sponsor as beneficiary, the status byte', () => {
        const reader = rustFnBody(pledgeSource, 'read_subject');
        expect(reader).toContain('agreement::read_agreement_view(subject)');
        expect(reader).toContain('Ok((view.authority, view.status))');
        for (const name of ['Active', 'Executed', 'Cancelled', 'Expired']) {
            expect(pledgeSource).toContain(`pub const STATUS_${name.toUpperCase()}: u8 = agreement::AgreementStatus::${name} as u8;`);
        }
        expect(pledgeSource).not.toMatch(/ProposalHead|PROPOSAL_NFT_PROGRAM_ID|PROPOSAL_DISCRIMINATOR|proposal_nft::|STATUS_OFFSET/);
        expect(pledgeCargo).toContain('agreement = { path = "../agreement", features = ["no-entrypoint"] }');
        expect(pledgeCargo).not.toMatch(/^proposal_nft\s*=/m);
        // The source says where the status byte is; it says the reader's offset.
        expect(Number(pledgeSource.match(/status at offset (\d+)/)[1])).toBe(layout.STATUS_OFFSET);
        // What the reader takes as the beneficiary is where the encoder writes the sponsor, and the
        // codec reads it back as the authority.
        expect(rustFnBody(layout.source, 'read_agreement_view')).toContain('authority: key_at(8)?');
        const sponsor = new web3.PublicKey(Uint8Array.from({ length: 32 }, () => 7)).toBase58();
        const bytes = agreementAccountBytes({ cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', authority: sponsor, status: 1 });
        expect(new web3.PublicKey(bytes.subarray(layout.offsets.authority, layout.offsets.authority + 32)).toBase58()).toBe(sponsor);
        expect(bytes[layout.STATUS_OFFSET]).toBe(layout.statusCodes.Executed);
        expect(agreementClient.readAgreement(bytes)).toMatchObject({ authority: sponsor, status: 'Executed' });
    });

    it('pins the new program id in Anchor.toml and the frontend address book', () => {
        const declared = pledgeSource.match(/declare_id!\("([^"]+)"\)/)[1];
        expect(pledgeIdl.address).toBe(declared);
        const toml = readFileSync(path.join(solana, 'Anchor.toml'), 'utf8');
        expect([...toml.matchAll(/proposal_pledge = "([^"]+)"/g)].map(m => m[1])).toEqual([declared, declared]);
        const addresses = JSON.parse(readFileSync(path.resolve(here, '../../frontend/contracts/addresses.json'), 'utf8'));
        expect(addresses['solana-devnet'].ProposalPledge).toBe(declared);
    });

    it('has funded-donation and soft-pledge lifecycles with Anchor discriminators', () => {
        expect(pledgeIdl.instructions.map(ix => ix.name).sort()).toEqual([
            'create_donation_escrow', 'create_pledge_book', 'donate', 'fulfill_pledge',
            'refund_donation', 'release_donations', 'revoke_pledge', 'set_pledge', 'void_pledge'
        ]);
        for (const ix of pledgeIdl.instructions) expect(ix.discriminator).toEqual(disc('global', ix.name));
        expect(pledgeIdl.accounts.map(account => account.name).sort()).toEqual([
            'DonationEscrow', 'DonationPosition', 'Donor', 'PledgeBook', 'PledgeCommitment'
        ]);
        for (const account of pledgeIdl.accounts) expect(account.discriminator).toEqual(disc('account', account.name));
        for (const instructionName of ['create_donation_escrow', 'create_pledge_book']) {
            const mint = pledgeIdl.instructions.find(ix => ix.name === instructionName).accounts.find(account => account.name === 'mint');
            expect(mint.address).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
        }
    });
});
