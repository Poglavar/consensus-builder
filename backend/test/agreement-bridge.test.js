// Unit tests for frontend/js/solana/agreement-bridge.js, the wallet side of the agreement program:
// the pure helpers (SOL amounts, explorer links, the minted record's account, the lens a mint names,
// what the program would accept now, the lens decision an account can record, Anchor errors), and
// mint / fund / attest / execute / cancel / expire over a fake wallet and connection with the real
// AgreementClient and web3 Transaction: every refusal comes before a wallet is asked to sign, and a
// mint sends the one create instruction the agreement and its sponsor call for.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { agreementAccountBytes } from './fixtures/agreement-account.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/agreement-client.js');
const Bridge = require('../../frontend/js/solana/agreement-bridge.js');

client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const { PublicKey } = web3;
const C = client.constants;
const keyOf = byte => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const SPONSOR = keyOf(7);
const STRANGER = keyOf(9);
const LENS = keyOf(11);
const PAYOUT = keyOf(13);
const CREDENTIAL = keyOf(17);
const ATTESTATION = keyOf(19);
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
// The plan the published agreement names (its content's planCid), which create stores as a hash.
const PLAN_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const ACCOUNT = client.getAgreementPda(CID, SPONSOR)[0].toBase58();
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ';
const nowSeconds = () => Math.floor(Date.now() / 1000);
const thrown = async fn => { try { await fn(); } catch (error) { return error; } return null; };

// ---- accounts as the chain holds them ------------------------------------------------------------

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const str = text => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text, 'utf8')]);

// An Agreement account (README offsets, fixtures/agreement-account.js): status/decision as codes,
// lamports as BigInt, a one-member lens unless `lenses` says otherwise.
function agreementData({ cid = CID, authority = SPONSOR, lens = LENS, lenses = [lens], payout = PAYOUT, deadline = 0, required = 1_000_000_000n, escrow = 0n, status = 0, decision = 0, ...rest } = {}) {
    return agreementAccountBytes({ cid, authority, lenses, payout, deadline, requiredLamports: required, escrowLamports: escrow, status, decision, ...rest });
}
// The terms a crowdfunding account carries: the sponsor's payout, no SOL escrow, the 20 USDC target.
const CROWD_TERMS = Object.freeze({ payout: SPONSOR, required: 0n, fundingMint: C.USDC_DEVNET_MINT, requiredFunding: 20_000_000n });

// The lens's AgreementDecision-v1 SAS attestation for this agreement.
function attestationData({ signer = LENS, decision = 'satisfied', sponsor = SPONSOR } = {}) {
    const payload = Buffer.concat([str(CID), str(sponsor), str(decision), str('sha256:receipts'), i64(nowSeconds() - 60)]);
    return Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 21), new PublicKey(CREDENTIAL).toBuffer(),
        client.getDecisionSchemaPda(CREDENTIAL)[0].toBuffer(), u32(payload.length), payload,
        new PublicKey(signer).toBuffer(), i64(nowSeconds() + 3600), Buffer.alloc(32)]);
}

// ---- the wallet, the connection and the window --------------------------------------------------

// A connection that holds `accounts` (address → { owner, data }) and answers the send tail.
function fakeConnection({ deployed = true, accounts = new Map(), simulation = { err: null, logs: [] }, confirmation = { value: { err: null } } } = {}) {
    const calls = [];
    const programKey = new PublicKey(C.AGREEMENT_PROGRAM_ID);
    return {
        calls,
        sent: [],
        getAccountInfo: vi.fn(async key => {
            const address = key.toBase58();
            if (address === C.AGREEMENT_PROGRAM_ID) return deployed ? { executable: true, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), data: Buffer.alloc(36) } : null;
            const account = accounts.get(address);
            return account ? { owner: account.owner || programKey, data: account.data } : null;
        }),
        getLatestBlockhash: vi.fn(async () => { calls.push('getLatestBlockhash'); return { blockhash: BLOCKHASH, lastValidBlockHeight: 99 }; }),
        // web3 1.x takes a legacy Transaction with signers, never a config object.
        simulateTransaction: vi.fn(async (transaction, ...rest) => { calls.push(`simulateTransaction/${rest.length}`); return { value: simulation }; }),
        sendRawTransaction: vi.fn(async () => { calls.push('sendRawTransaction'); return 'sig-1'; }),
        confirmTransaction: vi.fn(async () => {
            calls.push('confirmTransaction');
            if (confirmation instanceof Error) throw confirmation;
            return confirmation;
        })
    };
}

function fakeWindow({ wallet = SPONSOR, connection = fakeConnection(), web3Loaded = true } = {}) {
    const provider = wallet ? {
        publicKey: new PublicKey(wallet),
        signTransaction: vi.fn(async transaction => { connection.sent.push(transaction); return { serialize: () => Buffer.from('signed') }; })
    } : null;
    const win = {
        solanaWeb3: web3Loaded ? web3 : undefined,
        SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
        solanaWalletManager: {
            getProvider: () => provider,
            getCluster: () => 'devnet',
            getState: () => (wallet ? { status: 'connected', accounts: [wallet] } : { status: 'disconnected', accounts: [] })
        }
    };
    return { win, bridge: Bridge.browser(win), provider, connection };
}

// A proposed agreement as the store keeps it.
const proposed = (extra = {}) => ({
    id: 'ag-1', deadline: null, inputs: { parcels: [], openGroundM2: 0 },
    rule: { electorate: 'owners', binding: true, lens: [LENS] },
    published: { cid: CID, publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test', sponsor: SPONSOR, content: { planCid: PLAN_CID } },
    onchain: null, ...extra
});
const minted = (extra = {}) => proposed({ onchain: { chain: 'solana', cluster: 'devnet', account: ACCOUNT }, ...extra });
const mintedOn = (data, extra = {}) => fakeConnection({ accounts: new Map([[ACCOUNT, { data }]]), ...extra });

// The instruction a transaction the wallet was asked to sign carries, decoded.
function sentInstruction(connection) {
    expect(connection.sent).toHaveLength(1);
    const [instruction] = connection.sent[0].instructions;
    expect(connection.sent[0].instructions).toHaveLength(1);
    return instruction;
}

vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('pure helpers', () => {
    it('reads SOL as exact lamports, and nothing it cannot hold', () => {
        expect(Bridge.lamportsFromSol(1.5)).toBe(1_500_000_000n);
        expect(Bridge.lamportsFromSol(0.000000001)).toBe(1n);
        expect(Bridge.lamportsFromSol(0)).toBeNull();
        expect(Bridge.lamportsFromSol(0, { allowZero: true })).toBe(0n);
        for (const bad of [-1, 0.0000000001, Number.NaN, Infinity, '1', null, 1e10]) {
            expect(Bridge.lamportsFromSol(bad), String(bad)).toBeNull();
        }
        expect(Bridge.solOf(1_500_000_000n)).toBe(1.5);
        expect(Bridge.solOf('2000000000')).toBe(2);
        expect(Bridge.solOf(undefined)).toBe(0);
    });

    it('links an account or a transaction on its cluster\'s explorer', () => {
        expect(Bridge.explorerUrl({ account: ACCOUNT })).toBe(`https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`);
        expect(Bridge.explorerUrl({ signature: 'sig 1', cluster: 'testnet' })).toBe('https://explorer.solana.com/tx/sig%201?cluster=testnet');
        expect(Bridge.explorerUrl({ account: ACCOUNT, cluster: 'mainnet-beta' })).toBe(`https://explorer.solana.com/address/${ACCOUNT}`);
    });

    it('finds the Solana account a minted record names, and nothing else', () => {
        expect(Bridge.onchainRef(minted())).toEqual({ cluster: 'devnet', account: ACCOUNT });
        expect(Bridge.onchainRef(minted({ onchain: { chain: 'solana', cluster: ' devnet ', account: ` ${ACCOUNT} `, status: 'active' } })))
            .toEqual({ cluster: 'devnet', account: ACCOUNT });
        for (const onchain of [null, { chain: 'evm', cluster: 'devnet', account: ACCOUNT }, { chain: 'solana', cluster: '', account: ACCOUNT }, { chain: 'solana', cluster: 'devnet' }]) {
            expect(Bridge.onchainRef(proposed({ onchain })), JSON.stringify(onchain)).toBeNull();
        }
        expect(Bridge.onchainRef(null)).toBeNull();
    });

    it('mints the rule\'s lens set and threshold, or for a community vote the first lens member configured', () => {
        const none = { lenses: [], lensThreshold: 0 };
        expect(Bridge.mintLenses(proposed({ rule: { electorate: 'owners', lens: ['not-a-key', { address: LENS }, PAYOUT] } }))).toEqual({ lenses: [LENS, PAYOUT], lensThreshold: 1 });
        expect(Bridge.mintLenses(proposed({ rule: { electorate: 'owners', lens: [LENS, PAYOUT, SPONSOR], lensThreshold: 2 } }))).toEqual({ lenses: [LENS, PAYOUT, SPONSOR], lensThreshold: 2 });
        expect(Bridge.mintLenses(proposed({ rule: { electorate: 'owners', lens: [] } }), [LENS])).toEqual(none);
        expect(Bridge.mintLenses(proposed({ rule: { electorate: 'community', lens: [] } }), [{ address: 'nope' }, { address: PAYOUT }, { address: LENS }])).toEqual({ lenses: [PAYOUT], lensThreshold: 1 });
        expect(Bridge.mintLenses(proposed({ rule: { electorate: 'community' } }))).toEqual(none);
        expect(Bridge.mintLenses(null)).toEqual(none);
    });

    it('counts the contributions an escrow credits towards a target', () => {
        expect(Bridge.fundingCredited(null)).toBe(0n);
        expect(Bridge.fundingCredited({ totalDonated: 30n, totalRefunded: 5n })).toBe(25n);
        expect(Bridge.fundingCredited({ totalDonated: 5n, totalRefunded: 5n })).toBe(0n);
    });

    it('says what the program would accept now, from the account and the connected wallet', () => {
        const value = (fields = {}) => client.readAgreement(agreementData(fields));
        const now = 1_790_000_000;
        const actions = (fields, options = {}) => Bridge.chainActions(value(fields), { wallet: SPONSOR, nowSeconds: now, ...options });
        expect(actions()).toEqual({ fund: true, attest: false, confirmAsMember: false, member: false, confirmFunding: false, execute: false, cancel: true, expire: false, authority: true, funded: false,
            lensMet: false, fundingMet: true, credited: null, deadlinePassed: false });
        // The lens member's own wallet can confirm while its confirmation is open, not after.
        expect(actions({}, { wallet: LENS })).toMatchObject({ confirmAsMember: true, member: true });
        expect(actions({ lensConfirmed: [LENS] }, { wallet: LENS })).toMatchObject({ confirmAsMember: false, member: true });
        expect(actions({ deadline: now - 1 }, { wallet: LENS })).toMatchObject({ confirmAsMember: false });
        expect(actions({}, { attestation: ATTESTATION })).toMatchObject({ attest: true });
        expect(actions({}, { wallet: STRANGER, attestation: ATTESTATION })).toMatchObject({ fund: false, cancel: false, attest: true, authority: false });
        expect(actions({}, { wallet: null, attestation: ATTESTATION })).toMatchObject({ fund: false, attest: false, cancel: false, execute: false, expire: false });
        // Recorded: no second attest, no cancel; execute once the escrow holds what it needs.
        expect(actions({ decision: 1 }, { attestation: ATTESTATION })).toMatchObject({ attest: false, cancel: false, execute: false });
        expect(actions({ decision: 1, escrow: 1_000_000_000n })).toMatchObject({ execute: true, funded: true });
        expect(actions({ decision: 1, required: 0n })).toMatchObject({ execute: true, funded: true });
        // Past the deadline only expiry is left (cancel stays the sponsor's while undecided).
        expect(actions({ deadline: now - 1, decision: 1, escrow: 1_000_000_000n }, { attestation: ATTESTATION }))
            .toEqual({ fund: false, attest: false, confirmAsMember: false, member: false, confirmFunding: false, execute: false, cancel: false, expire: true, authority: true, funded: true,
                lensMet: false, fundingMet: true, credited: null, deadlinePassed: true });
        expect(actions({ deadline: now - 1 })).toMatchObject({ cancel: true, expire: true });
        // A closed agreement accepts nothing.
        for (const status of [1, 2, 3]) {
            expect(actions({ status, deadline: now - 1 }, { attestation: ATTESTATION }), String(status))
                .toMatchObject({ fund: false, attest: false, execute: false, cancel: false, expire: false });
        }
        expect(Bridge.chainActions(null, { wallet: SPONSOR })).toMatchObject({ fund: false, cancel: false, expire: false, authority: false });
        // A lens of three with threshold 2: attest while short of it, not once two members confirmed.
        const trio = { lenses: [LENS, STRANGER, PAYOUT], lensThreshold: 2 };
        expect(actions({ ...trio, lensConfirmed: [LENS] }, { attestation: ATTESTATION })).toMatchObject({ attest: true, lensMet: false });
        expect(actions({ ...trio, lensConfirmed: [LENS, PAYOUT] }, { attestation: ATTESTATION })).toMatchObject({ attest: false, lensMet: true });
        // A contribution target: confirmable by anyone once the escrow credits it, recorded once.
        const target = { ...CROWD_TERMS, lenses: [], lensThreshold: 0 };
        const escrow = (donated, refunded = 0n) => ({ totalDonated: donated, totalRefunded: refunded });
        expect(actions(target, { wallet: STRANGER, escrow: escrow(20_000_000n) })).toMatchObject({ confirmFunding: true, lensMet: true, fundingMet: false, credited: 20_000_000n });
        expect(actions(target, { wallet: STRANGER, escrow: escrow(25_000_000n, 6_000_000n) })).toMatchObject({ confirmFunding: false, credited: 19_000_000n });
        expect(actions(target, { wallet: STRANGER })).toMatchObject({ confirmFunding: false, credited: 0n });
        expect(actions({ ...target, fundingMet: true }, { wallet: STRANGER, escrow: escrow(20_000_000n) })).toMatchObject({ confirmFunding: false, fundingMet: true });
        expect(actions(target, { wallet: null, escrow: escrow(20_000_000n) })).toMatchObject({ confirmFunding: false });
        expect(actions({ ...target, deadline: now - 1 }, { wallet: STRANGER, escrow: escrow(20_000_000n) })).toMatchObject({ confirmFunding: false, expire: true });
    });

    it('picks the lens decision the account can record from a member\'s listed attestations', () => {
        const value = client.readAgreement(agreementData());
        const listed = (extra = {}) => ({ kind: 'decision', address: ATTESTATION, authority: LENS, expiry: nowSeconds() + 60,
            payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' }, ...extra });
        const fits = listed();
        expect(Bridge.decisionAttestationOf([listed({ kind: 'ownership' }), fits], { cid: CID, value })).toBe(fits);
        expect(Bridge.decisionAttestationOf([listed({ expiry: null })], { cid: CID, value })).not.toBeNull();
        for (const other of [listed({ authority: STRANGER }), listed({ payload: { agreementCid: 'bafkreiother', sponsor: SPONSOR } }),
            listed({ payload: { agreementCid: CID, sponsor: STRANGER } }), listed({ expiry: 1 })]) {
            expect(Bridge.decisionAttestationOf([other], { cid: CID, value }), JSON.stringify(other)).toBeNull();
        }
        expect(Bridge.decisionAttestationOf([fits], { cid: CID, value: null })).toBeNull();
        // Any member whose confirmation is open; a member already counted is not asked again.
        const trio = client.readAgreement(agreementData({ lenses: [STRANGER, LENS], lensThreshold: 2, lensConfirmed: [STRANGER] }));
        expect(Bridge.decisionAttestationOf([listed({ authority: STRANGER }), fits], { cid: CID, value: trio })).toBe(fits);
        expect(Bridge.decisionAttestationOf([listed({ authority: STRANGER })], { cid: CID, value: trio })).toBeNull();
        expect(Bridge.decisionAttestationOf([fits], { cid: CID, value: trio, member: STRANGER })).toBeNull();
        expect(Bridge.decisionAttestationOf(null, { cid: CID, value })).toBeNull();
    });

    it('reads the Anchor error a failed simulation logged', () => {
        expect(Bridge.anchorError(['Program log: Instruction: Create', 'Program log: AnchorError occurred. Error Code: DeadlinePassed. Error Number: 6002. Error Message: The agreement\'s deadline has passed.']))
            .toEqual({ code: 'DeadlinePassed', number: 6002, message: 'The agreement\'s deadline has passed' });
        expect(Bridge.anchorError(['Program log: ok'])).toBeNull();
        expect(Bridge.anchorError(null)).toBeNull();
    });
});

describe('minting', () => {
    const records = require('../../frontend/js/agreement-record.js');
    const pledge = require('../../frontend/js/solana/pledge-client.js');
    const cids = require('../../frontend/js/cid.js');
    function crowdfunding(deadline = nowSeconds() + 3600, apartments) {
        const content = require('../../frontend/js/plan-record.js').create('District', [CID], { at: '43.797866,77.087621,16', mode: '2d' });
        const local = { schema: 'agreement/v1', id: 'district-funding', title: 'Developer funding', city: 'alatau', sponsor: SPONSOR, plan: { cid: cids.cidOfObject(content), content },
            designs: [{ proposalId: 'p', cid: CID }], inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'KZT', lines: [] },
            rule: { electorate: 'investors', binding: true, lens: [LENS], settlement: null, approvalConfig: null },
            funding: { targetUsdcAtomic: '20000000', contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'VGVybXM=' },
                ...(apartments ? { apartments } : {}) }, deadline: new Date(deadline * 1000).toISOString() };
        const cid = records.publishedCid(local);
        const address = client.getAgreementPda(cid, SPONSOR)[0].toBase58();
        return { agreement: { ...local, published: { cid, sponsor: SPONSOR, apiBase: 'https://api.example.test', content: records.published(local) } }, address, cid, deadline };
    }

    it('mints the published crowdfunding terms with zero SOL and contributes devnet USDC using the original program', async () => {
        const { agreement, address, cid, deadline } = crowdfunding();
        const { win, bridge, connection } = fakeWindow();
        win.AgreementRecord = records;
        await bridge.mint({ agreement, lenses: [STRANGER], lensThreshold: 1, payout: PAYOUT, requiredLamports: 999n });
        expect(sentInstruction(connection).data).toEqual(client.buildCreateIx({ authority: SPONSOR, cid, planCid: agreement.plan.cid, lenses: [LENS], lensThreshold: 1, deadline, openGround: false,
            requiredLamports: 0n, payout: SPONSOR, fundingMint: C.USDC_DEVNET_MINT, requiredFunding: 20_000_000n }).instruction.data);
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, deadline }) }]]);
        const investor = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts }) });
        Object.assign(investor.win, { AgreementRecord: records, SolanaPledgeClient: pledge.configure({ web3 }), crypto: globalThis.crypto });
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        await investor.bridge.donate({ agreement, amountAtomic: 1000001n });
        const ixs = investor.connection.sent[0].instructions;
        expect(ixs.map(i => i.programId.toBase58())).toEqual([pledge.constants.PROGRAM_ID, pledge.constants.PROGRAM_ID]);
        expect(Buffer.from(ixs[1].data).readBigUInt64LE(ixs[1].data.length - 8)).toBe(1000001n);
        expect(investor.provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('opens escrow with the developer listing, then asks the buyer to sign one deposit and unit claim', async () => {
        const unit = { unitId: 'a4-c-23', label: 'Apartment A4-C-23', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::23',
            at: '45.7665,15.9722,19', priceUsdcAtomic: '200000000', depositUsdcAtomic: '20000000',
            drawing: { name: 'floor.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') } };
        const { agreement, address, cid, deadline } = crowdfunding(undefined, { projectId: 'courtyard', units: [unit] });
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, deadline }) }]]);
        const client = pledge.configure({ web3 });
        const [offer] = client.apartmentOffers(agreement.funding, SPONSOR, records);
        const developer = fakeWindow({ connection: fakeConnection({ accounts }) });
        developer.win.AgreementRecord = records;
        developer.win.SolanaPledgeClient = { ...client, readApartmentInventory: async () => [{ ...offer, status: 'unlisted' }] };
        await developer.bridge.listApartment({ agreement, unitId: unit.unitId });
        const discriminators = transaction => transaction.instructions.map(ix => Array.from(ix.data.slice(0, 8)));
        expect(discriminators(developer.connection.sent[0])).toEqual([client.IX_DISCRIMINATORS.create_donation_escrow, client.IX_DISCRIMINATORS.list_apartment]);

        const buyer = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts }) });
        buyer.win.AgreementRecord = records;
        const readApartmentInventory = vi.fn(async () => [{ ...offer, status: 'available' }]);
        buyer.win.SolanaPledgeClient = { ...client, readApartmentInventory, readDonationEscrow: async () => ({ proposal: address }) };
        const intent = { agreement, expectedBuyer: STRANGER, unitId: unit.unitId };
        await expect(buyer.bridge.donate({ agreement, amountAtomic: 1n })).rejects.toMatchObject({ code: 'apartment-required' });
        buyer.win.LensPicker = { loadDirectory: async () => ({ members: [{ key: LENS, serviceUrl: 'https://lens.example' }] }) };
        const proof = { address: ATTESTATION, credential: keyOf(21), authority: LENS, expiry: nowSeconds() + 60,
            payload: { counterpartyQualified: 1, cid, offer: offer.account, termsHash: offer.termsHash, buyer: STRANGER, seller: SPONSOR } };
        buyer.win.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'qualification_pending' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ...proof, authority: SPONSOR }) })
            .mockResolvedValueOnce({ ok: true, json: async () => proof });
        await expect(buyer.bridge.reserveApartment(intent)).rejects.toMatchObject({ code: 'qualification-pending' });
        await expect(buyer.bridge.reserveApartment(intent)).rejects.toMatchObject({ code: 'invalid-qualification' });
        expect(buyer.provider.signTransaction).not.toHaveBeenCalled();
        const receipt = await buyer.bridge.reserveApartment(intent);
        expect(discriminators(buyer.connection.sent[0])).toEqual([client.IX_DISCRIMINATORS.donate, client.IX_DISCRIMINATORS.reserve_apartment]);
        expect(Buffer.from(buyer.connection.sent[0].instructions[0].data).readBigUInt64LE(40)).toBe(BigInt(unit.depositUsdcAtomic));
        const escrow = client.getDonationEscrowPda(address)[0];
        const position = client.getDonationPositionPda(escrow, STRANGER, client.hashBytes(offer.unitKey))[0].toBase58();
        expect(receipt).toMatchObject({ position, signature: 'sig-1' });
        readApartmentInventory.mockResolvedValue([{ ...offer, status: 'reserved', buyer: STRANGER, position }]);
        await expect(buyer.bridge.reserveApartment(intent)).resolves.toMatchObject({ signature: null, position });
        expect(buyer.provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('reads a published apartment round at the account its CID and developer derive, not the one the index names', async () => {
        const unit = { unitId: 'a4-c-23', label: 'Apartment A4-C-23', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::23',
            at: '45.7665,15.9722,19', priceUsdcAtomic: '200000000', depositUsdcAtomic: '20000000',
            drawing: { name: 'floor.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') } };
        const { agreement, address, cid, deadline } = crowdfunding(undefined, { projectId: 'courtyard', units: [unit] });
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, deadline }) }]]);
        const reader = fakeWindow({ wallet: null, connection: fakeConnection({ accounts }) });
        const readApartmentInventory = vi.fn(async () => [{ unitId: unit.unitId, status: 'reserved', buyer: STRANGER }]);
        Object.assign(reader.win, { AgreementRecord: records, SolanaPledgeClient: { ...pledge.configure({ web3 }), readApartmentInventory } });
        // The index's claimed account is ignored: the chain account is the PDA of the CID and the developer.
        const row = { cid, content: { sponsor: SPONSOR, funding: agreement.funding }, onchain: { chain: 'solana', cluster: 'devnet', account: STRANGER } };
        await expect(reader.bridge.apartmentRound(row)).resolves.toMatchObject({ account: address, status: 'Active',
            units: [{ unitId: unit.unitId, status: 'reserved', buyer: STRANGER }] });
        expect(readApartmentInventory).toHaveBeenCalledWith(expect.anything(), address, SPONSOR, agreement.funding, records);
        const otherTarget = { ...row, content: { ...row.content, funding: { ...agreement.funding, targetUsdcAtomic: '1' } } };
        await expect(reader.bridge.apartmentRound(otherTarget)).rejects.toMatchObject({ code: 'funding-mismatch' });
        const unminted = fakeWindow({ wallet: null });
        Object.assign(unminted.win, { AgreementRecord: records, SolanaPledgeClient: { ...pledge.configure({ web3 }), readApartmentInventory } });
        await expect(unminted.bridge.apartmentRound(row)).resolves.toBeNull();
        await expect(reader.bridge.apartmentRound({ cid, content: { sponsor: SPONSOR, funding: { targetUsdcAtomic: '1' } } })).rejects.toMatchObject({ code: 'unknown-unit' });
        expect(readApartmentInventory).toHaveBeenCalledTimes(1);
    });

    it('explains investor funding failures only when the devnet account reads establish them', async () => {
        const { agreement, address, deadline } = crowdfunding();
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const accounts = new Map([[address, { data: agreementData({ cid: agreement.published.cid, ...CROWD_TERMS, deadline }) }]]);
        const simulation = { err: 'InvalidAccountForFee', logs: [] };
        const connection = fakeConnection({ accounts, simulation });
        connection.getMultipleParsedAccounts = vi.fn().mockResolvedValue({ value: [null, null] });
        const { win, bridge, provider } = fakeWindow({ wallet: STRANGER, connection });
        Object.assign(win, { AgreementRecord: records, SolanaPledgeClient: pledge.configure({ web3 }), crypto: globalThis.crypto });
        const attempt = () => thrown(() => bridge.donate({ agreement, amountAtomic: 1000001n }));
        const error = await attempt();
        expect(error).toMatchObject({ code: 'insufficient-balance', missingSol: true, missingUsdc: true });
        expect(error.message).toContain('devnet SOL');
        expect(error.message).toContain('devnet USDC');
        const [keys, commitment] = connection.getMultipleParsedAccounts.mock.calls[0];
        expect(keys.map(key => key.toBase58())).toEqual([STRANGER, pledge.getAssociatedTokenAddress(STRANGER, pledge.constants.USDC_DEVNET_MINT).toBase58()]);
        expect(commitment).toBe('confirmed');

        // The same fee error with an existing program-owned payer cannot be fixed by adding SOL.
        const payer = { lamports: 100000000, owner: web3.SystemProgram.programId };
        connection.getMultipleParsedAccounts.mockResolvedValueOnce({ value: [{ ...payer, owner: new PublicKey(C.AGREEMENT_PROGRAM_ID) }, null] });
        expect(await attempt()).toMatchObject({ code: 'simulation-failed', simulationError: 'InvalidAccountForFee' });
        connection.getMultipleParsedAccounts.mockRejectedValueOnce(new Error('RPC unavailable'));
        expect(await attempt()).toMatchObject({ code: 'simulation-failed' });

        // A wallet with SOL can still lack all or some of the amount it entered.
        simulation.err = { InstructionError: [1, { Custom: 3012 }] };
        simulation.logs = ['Program log: AnchorError caused by account: donor_token_account. Error Code: AccountNotInitialized.'];
        connection.getMultipleParsedAccounts.mockResolvedValueOnce({ value: [payer, null] });
        expect(await attempt()).toMatchObject({ code: 'insufficient-balance', missingSol: false, missingUsdc: true });
        const token = { owner: new PublicKey(pledge.constants.TOKEN_PROGRAM_ID), data: { parsed: { info: {
            mint: pledge.constants.USDC_DEVNET_MINT, owner: STRANGER, tokenAmount: { amount: '1000000' }
        } } } };
        simulation.err = { InstructionError: [1, { Custom: 1 }] };
        simulation.logs = ['Program log: Error: insufficient funds'];
        connection.getMultipleParsedAccounts.mockResolvedValueOnce({ value: [payer, token] });
        expect(await attempt()).toMatchObject({ code: 'insufficient-balance', missingUsdc: true });
        simulation.logs = ['Program log: Error: account frozen'];
        const reads = connection.getMultipleParsedAccounts.mock.calls.length;
        expect(await attempt()).toMatchObject({ code: 'simulation-failed' });
        expect(connection.getMultipleParsedAccounts).toHaveBeenCalledTimes(reads);
        expect(provider.signTransaction).not.toHaveBeenCalled();
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    it('can cancel a contribution during simulation or wallet approval before broadcasting it', async () => {
        const { agreement, address, deadline } = crowdfunding();
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const accounts = new Map([[address, { data: agreementData({ cid: agreement.published.cid, ...CROWD_TERMS, deadline }) }]]);
        const { win, bridge, provider, connection } = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts }) });
        Object.assign(win, { AgreementRecord: records, SolanaPledgeClient: pledge.configure({ web3 }), crypto: globalThis.crypto });
        const duringSimulation = new AbortController();
        connection.simulateTransaction.mockImplementationOnce(async () => {
            duringSimulation.abort();
            return { value: { err: null, logs: [] } };
        });
        const stopped = await thrown(() => bridge.donate({ agreement, amountAtomic: 1n, signal: duringSimulation.signal }));
        expect(stopped).toBe(duringSimulation.signal.reason);
        expect(provider.signTransaction).not.toHaveBeenCalled();
        const duringApproval = new AbortController();
        provider.signTransaction.mockImplementationOnce(async () => { duringApproval.abort(); return {}; });
        const cancelled = await thrown(() => bridge.donate({ agreement, amountAtomic: 1n, signal: duringApproval.signal }));
        expect(cancelled).toBe(duringApproval.signal.reason);
        expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });

    it('blocks changed contract bytes, wrong network, payout or deadline, and late contributions before asking the wallet', async () => {
        const { agreement, address, cid, deadline } = crowdfunding();
        const accounts = new Map();
        const { win, bridge, provider } = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts }) });
        win.AgreementRecord = records;
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const contribute = (row = agreement) => bridge.donate({ agreement: row, amountAtomic: 1000001n });
        for (const wrong of [{ payout: STRANGER }, { lens: STRANGER }, { lenses: [LENS, STRANGER] }, { deadline: deadline + 1 }, { required: 5n },
            { requiredFunding: 19_000_000n }, { fundingMint: STRANGER }]) {
            accounts.set(address, { data: agreementData({ cid, ...CROWD_TERMS, deadline, ...wrong }) });
            await expect(contribute()).rejects.toMatchObject({ code: 'funding-mismatch' });
        }
        await expect(contribute({ ...agreement, funding: { ...agreement.funding, contract: { ...agreement.funding.contract, data: 'WA==' } } })).rejects.toMatchObject({ code: 'funding-mismatch' });
        accounts.set(address, { data: agreementData({ cid, ...CROWD_TERMS, deadline }) });
        win.solanaWalletManager.getCluster = () => 'mainnet-beta';
        await expect(contribute()).rejects.toMatchObject({ code: 'wrong-cluster' });
        win.solanaWalletManager.getCluster = () => 'devnet';
        const late = crowdfunding(nowSeconds() - 10);
        accounts.set(late.address, { data: agreementData({ cid: late.cid, ...CROWD_TERMS, deadline: late.deadline }) });
        await expect(contribute({ ...late.agreement, onchain: { ...agreement.onchain, account: late.address } })).rejects.toMatchObject({ code: 'deadline-passed' });
        expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it('recovers the existing investor position after a lost confirmation without signing a second transfer', async () => {
        const { agreement, address, cid, deadline } = crowdfunding();
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, deadline }) }]]);
        const connection = fakeConnection({ accounts, confirmation: new Error('timeout') });
        const { win, bridge, provider } = fakeWindow({ wallet: STRANGER, connection });
        const readPosition = vi.fn(async () => ({ amount: 5000001n, refunded: false }));
        Object.assign(win, { AgreementRecord: records, SolanaPledgeClient: { ...pledge.configure({ web3 }), readDonationPosition: readPosition }, crypto: globalThis.crypto });
        const contribution = { agreement, amountAtomic: 5000001n };
        await expect(bridge.donate(contribution)).rejects.toMatchObject({ code: 'confirmation-unknown' });
        await expect(bridge.donate(contribution)).resolves.toMatchObject({ account: address, signature: null });
        const originalId = connection.sent[0].instructions[1].data.slice(8, 40);
        expect(readPosition.mock.calls[0][3]).toEqual(originalId);
        expect(provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('refunds the connected investor’s outstanding positions in a wallet-sized transaction', async () => {
        const { agreement, address } = crowdfunding();
        agreement.onchain = { chain: 'solana', cluster: 'devnet', account: address };
        const { win, bridge, connection } = fakeWindow({ wallet: STRANGER });
        const deposits = Array.from({length: 9}, (_, i) => ({ donationId: Uint8Array.from({length: 32}, () => i), refunded: i === 0 }));
        const listDonationPositions = vi.fn().mockResolvedValue(deposits);
        Object.assign(win, { AgreementRecord: records, SolanaPledgeClient: { ...pledge.configure({ web3 }), listDonationPositions } });
        await bridge.refundDonations({ agreement });
        expect(listDonationPositions).toHaveBeenCalledWith(connection, address, STRANGER);
        const transaction = connection.sent[0];
        expect(transaction.instructions).toHaveLength(Bridge.MAX_REFUNDS_PER_TX);
        expect(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1232);
    });

    it('sends create from the sponsor\'s wallet at its address, for this CID, lens, deadline, escrow and payout', async () => {
        const deadline = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
        const { bridge, provider, connection } = fakeWindow();
        const states = [];
        const result = await bridge.mint({ agreement: proposed({ deadline, inputs: { parcels: [], openGroundM2: 12 } }), lenses: [LENS],
            requiredLamports: 2_000_000_000n, payout: PAYOUT, onStatus: status => states.push(status.state) });
        // No input parcels: nothing to anchor before the create.
        expect(result).toEqual({ signature: 'sig-1', account: ACCOUNT, cluster: 'devnet', explorerUrl: 'https://explorer.solana.com/tx/sig-1?cluster=devnet',
            inputAnchors: { anchored: [], alreadyAnchored: [], skipped: [] } });
        expect(states).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(connection.calls).toEqual(['getLatestBlockhash', 'simulateTransaction/0', 'sendRawTransaction', 'confirmTransaction']);
        expect(provider.signTransaction).toHaveBeenCalledTimes(1);
        const instruction = sentInstruction(connection);
        const expected = client.buildCreateIx({ authority: SPONSOR, cid: CID, planCid: PLAN_CID, lenses: [LENS], lensThreshold: 1, deadline: client.toDeadlineSeconds(deadline),
            openGround: true, requiredLamports: 2_000_000_000n, payout: PAYOUT }).instruction;
        expect(instruction.programId.toBase58()).toBe(C.AGREEMENT_PROGRAM_ID);
        expect(Buffer.from(instruction.data)).toEqual(Buffer.from(expected.data));
        expect(instruction.keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, SPONSOR, C.SYSTEM_PROGRAM_ID]);
        expect(connection.sent[0].feePayer.toBase58()).toBe(SPONSOR);
    });

    it('gives an agreement without a deadline one 90 days from now, as the program requires one', async () => {
        const { bridge, connection } = fakeWindow();
        const before = Math.floor(Date.now() / 1000);
        await bridge.mint({ agreement: proposed({ deadline: null }), lenses: [LENS], payout: PAYOUT });
        const after = Math.floor(Date.now() / 1000);
        // create data: discriminator (8), cid and plan_cid (u32 length + bytes each), lenses (u32 count +
        // 32 each), the u8 threshold, then the i64 deadline.
        const sent = Number(Buffer.from(sentInstruction(connection).data).readBigInt64LE(8 + 4 + CID.length + 4 + PLAN_CID.length + 4 + 32 + 1));
        expect(sent).toBeGreaterThanOrEqual(before + C.DEFAULT_DEADLINE_SECONDS);
        expect(sent).toBeLessThanOrEqual(after + C.DEFAULT_DEADLINE_SECONDS);
    });

    it('returns the account without sending when the agreement is already on chain at its address', async () => {
        const connection = mintedOn(agreementData());
        const { bridge, provider } = fakeWindow({ connection });
        await expect(bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT }))
            .resolves.toEqual({ signature: null, account: ACCOUNT, cluster: 'devnet', explorerUrl: `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet` });
        expect(provider.signTransaction).not.toHaveBeenCalled();
        expect(connection.calls).toEqual([]);
    });

    it('refuses before any wallet is asked to sign', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const cases = [
            ['not-proposed', fakeWindow(), { agreement: proposed({ published: null }) }],
            // Without the published object there is no plan CID for the account to store.
            ['not-proposed', fakeWindow(), { agreement: proposed({ published: { ...proposed().published, content: null } }) }],
            ['already-minted', fakeWindow(), { agreement: minted() }],
            ['no-sponsor', fakeWindow(), { agreement: proposed({ published: { ...proposed().published, sponsor: null } }) }],
            ['wallet-required', fakeWindow({ wallet: null }), {}],
            ['not-sponsor', fakeWindow({ wallet: STRANGER }), {}],
            ['no-lens', fakeWindow(), { lenses: [] }],
            ['lens-invalid', fakeWindow(), { lenses: [LENS, LENS] }],
            ['lens-invalid', fakeWindow(), { lenses: [LENS, PAYOUT], lensThreshold: 3 }],
            ['deadline-passed', fakeWindow(), { agreement: proposed({ deadline: past }) }],
            ['deadline-passed', fakeWindow(), { deadline: past }],
            // The epoch (what NO_DEADLINE meant) is a passed deadline now, not "none".
            ['deadline-passed', fakeWindow(), { deadline: new Date(0).toISOString() }],
            ['program-not-deployed', fakeWindow({ connection: fakeConnection({ deployed: false }) }), {}],
            ['web3-unavailable', fakeWindow({ web3Loaded: false }), {}]
        ];
        for (const [code, { bridge, provider, connection }, options] of cases) {
            const error = await thrown(() => bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT, ...options }));
            expect(error?.code, code).toBe(code);
            expect(error.message, code).toBeTruthy();
            if (provider) expect(provider.signTransaction, code).not.toHaveBeenCalled();
            expect(connection.sendRawTransaction, code).not.toHaveBeenCalled();
        }
    });

    it('words the refusals the user can act on', async () => {
        expect((await thrown(() => fakeWindow({ wallet: STRANGER }).bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT }))).message)
            .toBe(`Only the sponsor’s wallet (${SPONSOR.slice(0, 4)}…${SPONSOR.slice(-4)}) can mint this agreement.`);
        expect((await thrown(() => fakeWindow({ connection: fakeConnection({ deployed: false }) }).bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT }))).message)
            .toBe('The agreement program is not deployed on Solana devnet yet.');
        expect((await thrown(() => fakeWindow({ wallet: null }).bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT }))).message)
            .toBe('Connect a Solana wallet first.');
    });

    it('names the program\'s error when the simulation fails, and signs nothing', async () => {
        const connection = fakeConnection({ simulation: { err: { InstructionError: [0, { Custom: 6011 }] }, logs: ['Program log: AnchorError occurred. Error Code: InvalidPayout. Error Number: 6011. Error Message: The payout must be a real account other than the agreement itself.'] } });
        const { bridge, provider } = fakeWindow({ connection });
        const error = await thrown(() => bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT }));
        expect(error).toMatchObject({ code: 'simulation-failed', programError: 'InvalidPayout' });
        expect(error.message).toBe('The transaction would fail: The payout must be a real account other than the agreement itself');
        expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it('says whether a sent transaction failed or its confirmation is unknown', async () => {
        const failed = fakeWindow({ connection: fakeConnection({ confirmation: { value: { err: { InstructionError: [0, 'Custom'] } } } }) });
        expect(await thrown(() => failed.bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT })))
            .toMatchObject({ code: 'confirmation-failed', signature: 'sig-1', explorerUrl: 'https://explorer.solana.com/tx/sig-1?cluster=devnet' });
        const timedOut = fakeWindow({ connection: fakeConnection({ confirmation: new Error('block height exceeded') }) });
        expect(await thrown(() => timedOut.bridge.mint({ agreement: proposed(), lenses: [LENS], payout: PAYOUT })))
            .toMatchObject({ code: 'confirmation-unknown', signature: 'sig-1' });
    });
});

describe('after the mint', () => {
    it('reads the account checked against the agreement\'s sponsor, and null when it is gone', async () => {
        const { bridge } = fakeWindow({ connection: mintedOn(agreementData({ escrow: 250_000_000n })) });
        await expect(bridge.read(minted())).resolves.toMatchObject({ address: ACCOUNT, cid: CID, authority: SPONSOR, escrowLamports: 250_000_000n, status: 'Active' });
        await expect(fakeWindow().bridge.read(minted())).resolves.toBeNull();
        const squatted = fakeWindow({ connection: mintedOn(agreementData({ authority: STRANGER })) });
        await expect(squatted.bridge.read(minted())).rejects.toThrow(/belongs to/);
        expect(await thrown(() => squatted.bridge.read(proposed()))).toMatchObject({ code: 'not-minted' });
    });

    it('lists the agreements naming a plan from the wallet cluster\'s chain, by the plan CID hash', async () => {
        const connection = fakeConnection();
        connection.getProgramAccounts = vi.fn(async () => [{ pubkey: new PublicKey(ACCOUNT), account: { data: agreementData({ planCid: PLAN_CID }) } }]);
        const { win, bridge } = fakeWindow({ connection });
        const found = await bridge.agreementsForPlan(PLAN_CID);
        expect(found).toEqual([expect.objectContaining({ address: ACCOUNT, cid: CID, planCidHash: client.planCidHash(PLAN_CID) })]);
        expect(win.SolanaChainDataLoader.getConnection).toHaveBeenCalledWith('devnet');
        expect(connection.getProgramAccounts.mock.calls[0][0].toBase58()).toBe(C.AGREEMENT_PROGRAM_ID);
        expect(connection.getProgramAccounts.mock.calls[0][1].filters).toEqual(client.planFilters(PLAN_CID));
    });

    it('lets only the sponsor fund and cancel', async () => {
        const fund = fakeWindow({ connection: mintedOn(agreementData()) });
        await expect(fund.bridge.fund({ agreement: minted(), lamports: 500_000_000n })).resolves.toMatchObject({ signature: 'sig-1', account: ACCOUNT });
        expect(Buffer.from(sentInstruction(fund.connection).data))
            .toEqual(Buffer.from(client.buildFundIx({ agreement: ACCOUNT, authority: SPONSOR, lamports: 500_000_000n }).data));
        for (const action of ['fund', 'cancel']) {
            const stranger = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData()) });
            expect(await thrown(() => stranger.bridge[action]({ agreement: minted(), lamports: 1n })), action).toMatchObject({ code: 'not-authority' });
            expect(stranger.provider.signTransaction).not.toHaveBeenCalled();
        }
        const cancel = fakeWindow({ connection: mintedOn(agreementData()) });
        await cancel.bridge.cancel({ agreement: minted() });
        expect(sentInstruction(cancel.connection).keys.map(key => [key.pubkey.toBase58(), key.isSigner])).toEqual([[ACCOUNT, false], [SPONSOR, true]]);
    });

    it('lets anyone execute to the payout fixed at mint, and expire back to the sponsor', async () => {
        const execute = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData({ decision: 1, escrow: 1_000_000_000n })) });
        await execute.bridge.execute({ agreement: minted() });
        expect(sentInstruction(execute.connection).keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, PAYOUT]);
        const expire = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData({ deadline: nowSeconds() - 60 })) });
        await expire.bridge.expire({ agreement: minted() });
        expect(sentInstruction(expire.connection).keys.map(key => [key.pubkey.toBase58(), key.isSigner])).toEqual([[ACCOUNT, false], [SPONSOR, false]]);
        expect(await thrown(() => fakeWindow().bridge.execute({ agreement: minted() }))).toMatchObject({ code: 'account-missing' });
    });

    it('records the lens decision only when the program would accept it', async () => {
        const sas = owner => ({ owner: new PublicKey(C.SAS_PROGRAM_ID), data: attestationData(owner) });
        const accounts = (attestation = sas()) => new Map([[ACCOUNT, { data: agreementData() }], [ATTESTATION, attestation]]);
        const ok = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts: accounts() }) });
        await expect(ok.bridge.attest({ agreement: minted(), attestation: ATTESTATION })).resolves.toMatchObject({ signature: 'sig-1', decision: 'satisfied' });
        expect(sentInstruction(ok.connection).keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, ATTESTATION, CREDENTIAL]);
        const refusals = [
            ['attestation-missing', null, fakeConnection({ accounts: new Map([[ACCOUNT, { data: agreementData() }]]) }), {}],
            ['precheck-failed', 'wrong-lens', fakeConnection({ accounts: accounts(sas({ signer: STRANGER })) }), {}],
            ['precheck-failed', 'unknown-decision', fakeConnection({ accounts: accounts(sas({ decision: 'refused' })) }), {}],
            ['precheck-failed', 'credential-mismatch', fakeConnection({ accounts: accounts() }), { credential: STRANGER }],
            ['precheck-failed', 'decision-recorded', fakeConnection({ accounts: new Map([[ACCOUNT, { data: agreementData({ decision: 1 }) }], [ATTESTATION, sas()]]) }), {}]
        ];
        for (const [code, reason, connection, options] of refusals) {
            const { bridge, provider } = fakeWindow({ connection });
            const error = await thrown(() => bridge.attest({ agreement: minted(), attestation: ATTESTATION, ...options }));
            expect(error, `${code} ${reason}`).toMatchObject(reason ? { code, reason } : { code });
            expect(provider.signTransaction).not.toHaveBeenCalled();
        }
    });

    it('finds the lens decision at the service of the member the account names', async () => {
        const value = client.readAgreement(agreementData());
        const { win, bridge } = fakeWindow();
        const listed = { kind: 'decision', address: ATTESTATION, authority: LENS, expiry: nowSeconds() + 60, payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' } };
        const fetchAttestations = vi.fn(async () => ({ status: 200, attestations: [listed] }));
        win.LensPicker = { loadDirectory: async () => ({ members: [{ key: STRANGER, serviceUrl: 'https://other.example' }, { key: LENS, serviceUrl: 'https://lens.example' }] }) };
        win.LensServiceClient = { fetchAttestations };
        await expect(bridge.findAttestation(minted(), value)).resolves.toEqual({ address: ATTESTATION, decision: 'satisfied', member: LENS });
        expect(fetchAttestations).toHaveBeenCalledWith({ serviceUrl: 'https://lens.example', filter: { kind: 'decision', agreementCid: CID } });
        await expect(bridge.findAttestation(minted(), null)).resolves.toBeNull();
        fetchAttestations.mockResolvedValueOnce({ status: 200, attestations: [{ ...listed, authority: STRANGER }] });
        await expect(bridge.findAttestation(minted(), value)).resolves.toBeNull();
        fetchAttestations.mockResolvedValueOnce({ status: 502, attestations: null, outcome: { message: 'bad gateway' } });
        expect(await thrown(() => bridge.findAttestation(minted(), value))).toMatchObject({ code: 'lens-unavailable', message: 'The lens member could not be asked for its decision: bad gateway' });
        win.LensPicker = { loadDirectory: async () => ({ members: [{ key: LENS }] }) };
        await expect(bridge.findAttestation(minted(), value)).resolves.toBeNull();
    });

    it('asks each lens member whose confirmation is open, and nobody once the threshold is met', async () => {
        const value = client.readAgreement(agreementData({ lenses: [STRANGER, PAYOUT, LENS], lensThreshold: 2, lensConfirmed: [STRANGER] }));
        const { win, bridge } = fakeWindow();
        const listed = { kind: 'decision', address: ATTESTATION, authority: LENS, expiry: nowSeconds() + 60, payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' } };
        const fetchAttestations = vi.fn(async ({ serviceUrl }) => (serviceUrl === 'https://down.example'
            ? { status: 502, attestations: null, outcome: { message: 'bad gateway' } } : { status: 200, attestations: [listed] }));
        win.LensPicker = { loadDirectory: async () => ({ members: [{ key: STRANGER, serviceUrl: 'https://confirmed.example' },
            { key: PAYOUT, serviceUrl: 'https://down.example' }, { key: LENS, serviceUrl: 'https://lens.example' }] }) };
        win.LensServiceClient = { fetchAttestations };
        await expect(bridge.findAttestation(minted(), value)).resolves.toEqual({ address: ATTESTATION, decision: 'satisfied', member: LENS });
        expect(fetchAttestations.mock.calls.map(([call]) => call.serviceUrl)).toEqual(['https://down.example', 'https://lens.example']);
        const met = client.readAgreement(agreementData({ lenses: [STRANGER, LENS], lensThreshold: 1, lensConfirmed: [STRANGER] }));
        fetchAttestations.mockClear();
        await expect(bridge.findAttestation(minted(), met)).resolves.toBeNull();
        expect(fetchAttestations).not.toHaveBeenCalled();
    });

    it('confirms a reached contribution target for anyone, and refuses one the escrow has not reached', async () => {
        const pledge = require('../../frontend/js/solana/pledge-client.js').configure({ web3 });
        const crowd = { rule: { electorate: 'owners', binding: true, lens: [] } };
        const data = agreementData({ ...CROWD_TERMS, lenses: [], lensThreshold: 0, required: 0n });
        const vault = keyOf(23);
        const withEscrow = (escrow, fields = data) => {
            const window = fakeWindow({ wallet: STRANGER, connection: mintedOn(fields) });
            window.win.SolanaPledgeClient = { ...pledge, readDonationEscrow: vi.fn(async () => escrow) };
            return window;
        };
        const ok = withEscrow({ vault, totalDonated: 21_000_000n, totalRefunded: 1_000_000n });
        await expect(ok.bridge.confirmFunding({ agreement: minted(crowd) })).resolves.toMatchObject({ signature: 'sig-1', account: ACCOUNT });
        const instruction = sentInstruction(ok.connection);
        expect(Buffer.from(instruction.data)).toEqual(Buffer.from(client.encodeConfirmFundingData()));
        expect(instruction.keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, pledge.getDonationEscrowPda(ACCOUNT)[0].toBase58(), vault]);
        for (const [code, window] of [
            ['funding-short', withEscrow({ vault, totalDonated: 19_999_999n, totalRefunded: 0n })],
            ['funding-short', withEscrow(null)],
            ['nothing-to-confirm', withEscrow({ vault, totalDonated: 30_000_000n, totalRefunded: 0n }, agreementData({ ...CROWD_TERMS, lenses: [], lensThreshold: 0, fundingMet: true }))],
            ['nothing-to-confirm', withEscrow({ vault, totalDonated: 30_000_000n, totalRefunded: 0n }, agreementData())]
        ]) {
            expect(await thrown(() => window.bridge.confirmFunding({ agreement: minted(crowd) })), code).toMatchObject({ code });
            expect(window.provider.signTransaction).not.toHaveBeenCalled();
        }
    });

    it('knows the connected wallet without asking it', () => {
        const { provider, bridge } = fakeWindow();
        expect(bridge.connectedWallet()).toBe(SPONSOR);
        provider.publicKey = null;
        expect(bridge.connectedWallet()).toBeNull();
        expect(fakeWindow({ wallet: null }).bridge.connectedWallet()).toBeNull();
    });
});

// A lens member whose key is the connected wallet (a city authority) confirms the agreement itself:
// its SAS credential and decision schema the first time, its AgreementDecision-v1, attest, and when that
// completes the lens, execute and, for a crowdfunding round, the USDC release, in as few approvals as fit.
describe('confirmAsMember', () => {
    const records = require('../../frontend/js/agreement-record.js');
    const pledge = require('../../frontend/js/solana/pledge-client.js').configure({ web3 });
    const cids = require('../../frontend/js/cid.js');
    const plan = require('../../frontend/js/agreement-decision-plan.js');
    const relay = require('../../frontend/js/proposals/approval-relay.js');
    const CHAIN_NOW = nowSeconds() - 5;
    function round(deadline = nowSeconds() + 3600) {
        const content = require('../../frontend/js/plan-record.js').create('District', [CID], { at: '43.797866,77.087621,16', mode: '2d' });
        const local = { schema: 'agreement/v1', id: 'district-funding', title: 'Developer funding', city: 'alatau', sponsor: SPONSOR, plan: { cid: cids.cidOfObject(content), content },
            designs: [{ proposalId: 'p', cid: CID }], inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'KZT', lines: [] },
            rule: { electorate: 'investors', binding: true, lens: [LENS], settlement: null, approvalConfig: null },
            funding: { targetUsdcAtomic: '20000000', contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'VGVybXM=' } }, deadline: new Date(deadline * 1000).toISOString() };
        const cid = records.publishedCid(local);
        const address = client.getAgreementPda(cid, SPONSOR)[0].toBase58();
        return { agreement: { ...local, published: { cid, sponsor: SPONSOR, apiBase: 'https://api.example.test' }, onchain: { chain: 'solana', cluster: 'devnet', account: address } }, address, cid, deadline };
    }
    function memberWindow({ wallet = LENS, accounts, escrow = null, receipts = [] }) {
        const connection = fakeConnection({ accounts });
        connection.getSlot = vi.fn(async () => 1234);
        connection.getBlockTime = vi.fn(async () => CHAIN_NOW);
        const window = fakeWindow({ wallet, connection });
        Object.assign(window.win, {
            AgreementRecord: records, AgreementDecisionPlan: plan, crypto: globalThis.crypto,
            SolanaPledgeClient: { ...pledge, readDonationEscrow: vi.fn(async () => escrow) },
            ProposalApprovalRelay: { ...relay, pull: vi.fn(async () => receipts) }
        });
        return window;
    }
    const sentPrograms = connection => connection.sent.flatMap(tx => tx.instructions.map(ix => [ix.programId.toBase58(), ix.data[0]]));

    it('lets the city approve a funded round, executing it and releasing the contributions to the developer', async () => {
        const { agreement, address, cid, deadline } = round();
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, lenses: [LENS], deadline }) }]]);
        const vault = keyOf(23);
        const { bridge, connection, provider } = memberWindow({ accounts, escrow: { vault, totalDonated: 20_000_000n, totalRefunded: 0n, beneficiary: SPONSOR, released: false, totalReleased: 0n, mint: C.USDC_DEVNET_MINT } });
        const done = await bridge.confirmAsMember({ agreement });
        expect(done).toMatchObject({ executed: true, released: true });
        const sas = C.SAS_PROGRAM_ID, agreementProgram = C.AGREEMENT_PROGRAM_ID, pledgeProgram = pledge.constants.PROGRAM_ID;
        const programs = sentPrograms(connection);
        // credential, schema (SAS 0, 1), then confirm_funding, the attestation (SAS 6), attest, execute, release.
        expect(programs.map(([program]) => program)).toEqual([sas, sas, agreementProgram, sas, agreementProgram, agreementProgram, pledgeProgram]);
        expect(programs.filter(([program]) => program === sas).map(([, d]) => d)).toEqual([0, 1, 6]);
        expect(provider.signTransaction.mock.calls.length).toBeLessThanOrEqual(2);
        // The attestation states this member's own decision at the chain's time, for this CID and sponsor.
        const attestation = connection.sent.flatMap(tx => tx.instructions).find(ix => ix.programId.toBase58() === sas && ix.data[0] === 6);
        const payload = attestation.data.subarray(1 + 32 + 4, attestation.data.length - 8);
        const decoded = client.readDecisionAttestation(Buffer.concat([Buffer.from([2]), Buffer.alloc(96), Buffer.from(attestation.data.subarray(33, 37)), payload, Buffer.alloc(32), Buffer.alloc(8), Buffer.alloc(32)])).fields;
        expect(decoded).toEqual({ agreementCid: cid, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `decided-by:${LENS}`, sourceObservedAt: CHAIN_NOW });
        expect(done.attestation).toBe(client.getAttestationPda({ credential: client.getLensCredentialPda(LENS), schema: client.getDecisionSchemaPda(client.getLensCredentialPda(LENS))[0], nonce: client.decisionNonce(decoded) }).toBase58());
    });

    it('records only the decision while the round is short of its target, and skips a registered member\'s setup', async () => {
        const { agreement, address, cid, deadline } = round();
        const credential = client.getLensCredentialPda(LENS).toBase58();
        const schema = client.getDecisionSchemaPda(credential)[0].toBase58();
        const sasOwned = { owner: new PublicKey(C.SAS_PROGRAM_ID), data: Buffer.alloc(8) };
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, lenses: [LENS], deadline }) }], [credential, sasOwned], [schema, sasOwned]]);
        const { bridge, connection, provider } = memberWindow({ accounts, escrow: { vault: keyOf(23), totalDonated: 5_000_000n, totalRefunded: 0n, beneficiary: SPONSOR, released: false } });
        await expect(bridge.confirmAsMember({ agreement })).resolves.toMatchObject({ executed: false, released: false });
        expect(provider.signTransaction).toHaveBeenCalledTimes(1);
        expect(sentPrograms(connection).map(([program, d]) => `${program === C.SAS_PROGRAM_ID ? 'sas' : 'agreement'}:${d}`))
            .toEqual(['sas:6', `agreement:${client.IX_DISCRIMINATORS.attest[0]}`]);
    });

    // An agreement the authority decides alone (no owner test), its id the authority's wallet key, which
    // is also the lens: no rights snapshot and no signed decision, one transaction decides and executes.
    function authorityLed(authorityId, deadline = nowSeconds() + 3600) {
        const content = require('../../frontend/js/plan-record.js').create('District', [CID], { at: '43.797866,77.087621,16', mode: '2d' });
        const local = { schema: 'agreement/v1', id: 'district-authority', title: 'City plan', city: 'alatau', sponsor: SPONSOR, plan: { cid: cids.cidOfObject(content), content },
            designs: [{ proposalId: 'p', cid: CID }], inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'KZT', lines: [] },
            rule: { electorate: 'owners', binding: true, lens: [LENS], approvalConfig: { schema: 'proposal-approval/v1', rights: null,
                policy: { type: 'rules', tests: [], authorities: [{ authorityId }] } } },
            deadline: new Date(deadline * 1000).toISOString() };
        const cid = records.publishedCid(local);
        const address = client.getAgreementPda(cid, SPONSOR)[0].toBase58();
        return { agreement: { ...local, published: { cid, sponsor: SPONSOR, apiBase: 'https://api.example.test' }, onchain: { chain: 'solana', cluster: 'devnet', account: address } }, address, cid, deadline };
    }

    it('lets an authority that is its own lens member decide alone and execute in one transaction, with no rights snapshot', async () => {
        const { agreement, address, cid, deadline } = authorityLed(LENS);
        const accounts = new Map([[address, { data: agreementData({ cid, lenses: [LENS], deadline, required: 0n }) }]]);
        const { bridge, connection, provider } = memberWindow({ accounts });
        const done = await bridge.confirmAsMember({ agreement });
        expect(done).toMatchObject({ executed: true });
        expect(provider.signTransaction).toHaveBeenCalledTimes(1);
        const sas = C.SAS_PROGRAM_ID;
        expect(sentPrograms(connection).map(([program, d]) => (program === sas ? `sas:${d}` : `agreement:${d}`)))
            .toEqual(['sas:0', 'sas:1', 'sas:6', `agreement:${client.IX_DISCRIMINATORS.attest[0]}`, `agreement:${client.IX_DISCRIMINATORS.execute[0]}`]);
        const attestation = connection.sent.flatMap(tx => tx.instructions).find(ix => ix.programId.toBase58() === sas && ix.data[0] === 6);
        const payload = attestation.data.subarray(1 + 32 + 4, attestation.data.length - 8);
        const decoded = client.readDecisionAttestation(Buffer.concat([Buffer.from([2]), Buffer.alloc(96), Buffer.from(attestation.data.subarray(33, 37)), payload, Buffer.alloc(32), Buffer.alloc(8), Buffer.alloc(32)])).fields;
        expect(decoded).toEqual({ agreementCid: cid, sponsor: SPONSOR, decision: 'satisfied',
            evidenceRef: require('../../frontend/js/proposals/approval.js').decisionEvidenceRef({ counted: [], decidedBy: LENS }), sourceObservedAt: CHAIN_NOW });
    });

    it('refuses a lens member whose key is not the required authority: the authority has not decided', async () => {
        const { agreement, address, cid, deadline } = authorityLed(STRANGER);
        const accounts = new Map([[address, { data: agreementData({ cid, lenses: [LENS], deadline, required: 0n }) }]]);
        const { bridge, provider } = memberWindow({ accounts });
        expect(await thrown(() => bridge.confirmAsMember({ agreement }))).toMatchObject({ code: 'member-refused', reason: 'rule_not_met' });
        expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it('refuses a wallet outside the lens, and an owners\' agreement whose signed decisions do not pass, before any signature', async () => {
        const { agreement, address, cid, deadline } = round();
        const accounts = new Map([[address, { data: agreementData({ cid, ...CROWD_TERMS, lenses: [LENS], deadline }) }]]);
        const stranger = memberWindow({ wallet: STRANGER, accounts });
        expect(await thrown(() => stranger.bridge.confirmAsMember({ agreement }))).toMatchObject({ code: 'not-lens-member' });
        expect(stranger.provider.signTransaction).not.toHaveBeenCalled();
        const owners = memberWindow({ accounts: new Map([[ACCOUNT, { data: agreementData({ required: 0n }) }]]) });
        expect(await thrown(() => owners.bridge.confirmAsMember({ agreement: minted() }))).toMatchObject({ code: 'member-refused' });
        expect(owners.win.ProposalApprovalRelay.pull).toHaveBeenCalled();
        expect(owners.provider.signTransaction).not.toHaveBeenCalled();
    });
});
