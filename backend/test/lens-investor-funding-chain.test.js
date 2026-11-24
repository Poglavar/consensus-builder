import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { cidOfObject } from '../cid.js';
import { createInvestorFundingChain } from '../lens/investor-funding-chain.js';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { encodeAgreementAccount } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3 });
const pledgeClient = require('../../frontend/js/solana/pledge-client.js').configure({ web3 });
const key = value => Buffer.from(new web3.PublicKey(value).toBytes());
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };

function fixture({ vaultAmount = 1_000_000n, state = 1 } = {}) {
    const sponsor = Keypair.generate().publicKey.toBase58();
    const lens = Keypair.generate().publicKey.toBase58();
    const deadline = 2_000_000_000;
    const content = { schema: 'agreement/v1', sponsor, deadline, title: 'Funded plan' };
    const cid = cidOfObject(content);
    const account = agreementClient.getAgreementPda(cid, sponsor)[0].toBase58();
    const escrow = pledgeClient.getDonationEscrowPda(account)[0].toBase58();
    const vault = pledgeClient.getAssociatedTokenAddress(escrow, pledgeClient.constants.USDC_DEVNET_MINT).toBase58();
    const escrowData = Buffer.concat([Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.DonationEscrow), key(account), key(sponsor),
        key(pledgeClient.constants.USDC_DEVNET_MINT), key(vault), u64(1_000_000n), u64(0n), u64(0n), u64(1n), u64(1n), Buffer.from([0, 255])]);
    const vaultData = Buffer.alloc(165); key(pledgeClient.constants.USDC_DEVNET_MINT).copy(vaultData, 0); key(escrow).copy(vaultData, 32);
    vaultData.writeBigUInt64LE(vaultAmount, 64); vaultData[108] = state;
    return { sponsor, lens, cid, account, escrow, vault, agreementData: encodeAgreementAccount({ authority: sponsor, lens, payout: sponsor, deadline, cid }), escrowData, vaultData };
}

function adapter(row, unitAccounts = []) {
    const rpc = {
        getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
        getMultipleAccountsInfoAndContext: vi.fn(async () => ({ context: { slot: 12345 }, value: [
            { owner: new web3.PublicKey(agreementClient.constants.AGREEMENT_PROGRAM_ID), data: row.agreementData },
            { owner: new web3.PublicKey(pledgeClient.constants.PROGRAM_ID), data: row.escrowData },
            { owner: new web3.PublicKey(pledgeClient.constants.TOKEN_PROGRAM_ID), data: row.vaultData },
            ...unitAccounts
        ] })),
        getBlockTime: vi.fn(async slot => slot === 12345 ? 1_900_000_000 : null)
    };
    return { rpc, chain: createInvestorFundingChain({ connection: rpc }) };
}

describe('finalized investor funding chain adapter', () => {
    it('decodes Agreement, DonationEscrow and initialized USDC ATA from one finalized slot', async () => {
        const row = fixture(); const { rpc, chain } = adapter(row);
        const found = await chain.observe({ cid: row.cid, sponsor: row.sponsor, account: row.account });
        expect(found).toMatchObject({ slot: 12345, blockTime: 1_900_000_000, escrow: row.escrow, vault: row.vault, vaultUsdcAtomic: 1_000_000n,
            agreement: { cid: row.cid, authority: row.sponsor, payout: row.sponsor }, donation: { proposal: row.account, beneficiary: row.sponsor, vault: row.vault } });
        expect(rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(expect.any(Array), 'finalized');
    });

    it('reads every offered apartment alongside its round and escrow at the same finalized slot', async () => {
        const row = fixture();
        const pdf = { name: 'floor.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') };
        const unit = (id, deposit) => ({ unitId: id, label: id, xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::' + id,
            at: '45.7665,15.9722,19', priceUsdcAtomic: '5000000', depositUsdcAtomic: deposit, drawing: pdf });
        const funding = { targetUsdcAtomic: '1000000', contract: pdf, apartments: { projectId: 'courtyard',
            units: [unit('a', '600000'), unit('b', '400000')] } };
        const offers = pledgeClient.apartmentOffers(funding, row.sponsor, require('../../frontend/js/agreement-record.js'));
        const first = offers[0];
        const buyer = Keypair.generate().publicKey;
        const position = pledgeClient.getDonationPositionPda(row.escrow, buyer, pledgeClient.hashBytes(first.unitKey))[0];
        const listing = { owner: new web3.PublicKey(pledgeClient.constants.PROGRAM_ID), data: Buffer.concat([
            Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.ApartmentUnit), key(row.sponsor), Buffer.from(first.unitKey, 'hex'),
            key(row.account), Buffer.from(first.termsHash, 'hex'), u64(first.deposit), key(buyer), key(position), Buffer.from([255]), key(Keypair.generate().publicKey)
        ]) };
        const { rpc, chain } = adapter(row, [listing, null]);
        const found = await chain.observe({ cid: row.cid, sponsor: row.sponsor, account: row.account, funding });
        expect(rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
        expect(rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(
            [row.account, row.escrow, row.vault, ...offers.map(offer => offer.account)].map(address => new web3.PublicKey(address)), 'finalized');
        expect(found.vaultUsdcAtomic).toBe(1_000_000n);
        expect(found.reservations).toMatchObject([
            { unitId: 'a', status: 'reserved', buyer: buyer.toBase58(), position: position.toBase58(), deposit: '600000' },
            { unitId: 'b', status: 'unlisted', buyer: null, deposit: '400000' }
        ]);
    });

    it('rejects a frozen or uninitialized canonical vault before it reaches the lens', async () => {
        for (const state of [0, 2]) {
            const row = fixture({ state }); const { chain } = adapter(row);
            await expect(chain.observe({ cid: row.cid, sponsor: row.sponsor, account: row.account })).rejects.toThrow(/initialized and unfrozen/);
        }
    });
});
