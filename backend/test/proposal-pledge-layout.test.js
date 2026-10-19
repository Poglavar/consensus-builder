// Pins the ProposalPledge source, IDL, address-book, and discriminator contracts together.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const solana = path.resolve(here, '../../blockchain/solana');
const nftSource = readFileSync(path.join(solana, 'programs/proposal_nft/src/lib.rs'), 'utf8');
const pledgeSource = readFileSync(path.join(solana, 'programs/proposal_pledge/src/lib.rs'), 'utf8');
const nftIdl = JSON.parse(readFileSync(path.join(solana, 'idl/proposal_nft.json'), 'utf8'));
const pledgeIdl = JSON.parse(readFileSync(path.join(solana, 'idl/proposal_pledge.json'), 'utf8'));

function fields(source, header) {
    const start = source.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start + header.length, source.indexOf('}', start)).split('\n')
        .map(line => line.trim()).filter(line => line.startsWith('pub '))
        .map(line => {
            const match = line.match(/^pub (\w+): ([^,]+),?$/);
            return { name: match[1], type: match[2] };
        });
}
function disc(prefix, name) {
    return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
}

describe('proposal_pledge source/IDL contract', () => {
    it('mirrors proposal_nft through status and pins its program/discriminator', () => {
        const proposal = fields(nftSource, 'pub struct Proposal {');
        const head = fields(pledgeSource, 'struct ProposalHead {');
        expect(head.at(-1).name).toBe('status');
        expect(head).toEqual(proposal.slice(0, head.length).map(field => field.name === 'status' ? { ...field, type: 'u8' } : field));
        const nftAddress = nftSource.match(/declare_id!\("([^"]+)"\)/)[1];
        expect(pledgeSource).toContain(`PROPOSAL_NFT_PROGRAM_ID: Pubkey = pubkey!("${nftAddress}")`);
        expect(nftIdl.address).toBe(nftAddress);
        expect(pledgeSource).toContain(`PROPOSAL_DISCRIMINATOR: [u8; 8] = [${nftIdl.accounts.find(a => a.name === 'Proposal').discriminator.join(', ')}]`);
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
