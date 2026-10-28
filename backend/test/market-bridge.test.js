// Canonical LMSR wallet reads, quote limits, and uncertain transaction receipts.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const bridgeSource = fs.readFileSync(new URL('../../frontend/js/solana/market-bridge.js', import.meta.url), 'utf8');
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const programId = new web3.PublicKey('GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB');
const associatedTokenProgram = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const tokenProgram = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function setup(options = {}) {
    class Transaction {
        constructor(config) { this.config = config; this.instructions = []; }
        add(instruction) { this.instructions.push(instruction); return this; }
    }
    const proposal = options.proposal || web3.Keypair.generate().publicKey;
    const sponsor = options.sponsor || web3.Keypair.generate().publicKey;
    const wallet = options.wallet || web3.Keypair.generate().publicKey;
    const lens = options.lens || web3.Keypair.generate().publicKey;
    const mint = new web3.PublicKey(USDC);
    const marketAddress = web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr'), proposal.toBuffer(), sponsor.toBuffer()], programId)[0];
    const traderAta = web3.PublicKey.findProgramAddressSync([wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram)[0];
    const sponsorAta = web3.PublicKey.findProgramAddressSync([sponsor.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram)[0];
    const agreement = { authority: sponsor.toBase58(), lens: lens.toBase58(), cid: 'bafkreiabc', status: options.status || 'Active',
        deadline: options.deadline ?? 1_900_000_000, executedAt: options.executedAt ?? 0 };
    const rawMarket = options.market === null ? null : {
        kind: 0, proposal: proposal.toBase58(), creator: sponsor.toBase58(), stakeMint: options.stakeMint || USDC,
        vault: web3.Keypair.generate().publicKey.toBase58(), b: 100_000_000n, qYes: 12_000_000n, qNo: 9_000_000n,
        seed: 69_314_720n, closesAt: BigInt(agreement.deadline), graceSeconds: 0, maxPosition: 0n,
        paidOut: 1_000n, resolved: Boolean(options.resolved), outcome: options.outcome ?? 0
    };
    const client = {
        constants: { SIDE_NO: 0, SIDE_YES: 1, OUTCOME_VOID: 2, KIND_PROPOSAL: 0, ASSOCIATED_TOKEN_PROGRAM_ID: associatedTokenProgram.toBase58(), TOKEN_PROGRAM_ID: tokenProgram.toBase58() },
        getMarketPda: vi.fn((subject, creator) => [web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr'), new web3.PublicKey(subject).toBuffer(), new web3.PublicKey(creator).toBuffer()], programId)[0]]),
        getPositionPda: vi.fn((market, owner, side) => [web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr_position'), new web3.PublicKey(market).toBuffer(), new web3.PublicKey(owner).toBuffer(), Buffer.from([side])], programId)[0]]),
        getAssociatedTokenAddress: vi.fn((owner, tokenMint) => web3.PublicKey.findProgramAddressSync([new web3.PublicKey(owner).toBuffer(), tokenProgram.toBuffer(), new web3.PublicKey(tokenMint).toBuffer()], associatedTokenProgram)[0]),
        readMarket: vi.fn(async (_connection, address) => new web3.PublicKey(address).equals(marketAddress) ? rawMarket : null),
        readPosition: vi.fn(async (_connection, _market, _owner, side) => options.positions?.[side] ?? null),
        readPositionAccount: vi.fn(info => info.data),
        buildCreateLmsrMarketIx: vi.fn(args => ({ kind: 'create-lmsr', args })),
        buildBuyIx: vi.fn(args => ({ kind: 'buy', args })),
        buildSellIx: vi.fn(args => ({ kind: 'sell', args })),
        buildResolveLmsrIx: vi.fn(args => ({ kind: 'resolve', args })),
        buildClaimLmsrIx: vi.fn(args => ({ kind: 'claim', args }))
    };
    const calls = [];
    const connection = {
        getSlot: vi.fn(async () => 88),
        getBlockTime: vi.fn(async () => options.now ?? 1_800_000_000),
        getBalance: vi.fn(async () => options.solBalance ?? 1_000_000_000),
        getAccountInfo: vi.fn(async address => {
            const s = address.toBase58();
            if (s === traderAta.toBase58() && options.traderAtaExists !== false) return { data: Buffer.from([1]) };
            if (s === sponsorAta.toBase58() && options.sponsorAtaExists !== false) return { data: Buffer.from([1]) };
            return null;
        }),
        getTokenAccountBalance: vi.fn(async address => {
            if (options.balanceError) throw options.balanceError;
            const amount = address.equals(sponsorAta) ? options.sponsorBalance ?? '1000000000' : options.tokenBalance ?? '1000000000';
            return { value: { amount } };
        }),
        getMultipleAccountsInfo: vi.fn(async keys => keys.map((_key, index) => options.multipleAccounts?.[index] || null)),
        getLatestBlockhash: vi.fn(async () => ({ blockhash: 'blockhash', lastValidBlockHeight: 10 }),),
        simulateTransaction: vi.fn(async tx => { calls.push(['simulate', tx]); return options.simulation || { value: { err: null } }; }),
        sendRawTransaction: vi.fn(async () => { calls.push(['send']); return 'tx-signature'; }),
        confirmTransaction: vi.fn(async () => {
            calls.push(['confirm']);
            if (options.confirmError) throw options.confirmError;
            return options.confirmation || { value: { err: null } };
        })
    };
    const provider = { publicKey: wallet, signTransaction: vi.fn(async tx => ({ serialize: () => Buffer.from(tx.instructions.map(i => i.kind || 'ata').join(',')) })) };
    const window = {
        solanaWeb3: { ...web3, Transaction },
        SolanaLmsrClient: client,
        SolanaChainDataLoader: { getVerifiedConnection: vi.fn(async cluster => { if (cluster !== 'devnet') throw new Error('bad cluster'); return connection; }) },
        AgreementClient: { fetchAgreement: vi.fn(async (_connection, { address }) => new web3.PublicKey(address).equals(proposal) ? agreement : null) },
        Lmsr: { maxLoss: vi.fn(() => 69_314_720n) },
        solanaWalletManager: { getCluster: vi.fn(() => options.cluster || 'devnet'), getProvider: vi.fn(() => provider) }
    };
    vm.runInNewContext(bridgeSource, { window, Buffer, Uint8Array, BigInt, Date });
    return { bridge: window.SolanaMarketBridge, window, client, connection, provider, calls, proposal, sponsor, wallet, lens, marketAddress, traderAta, sponsorAta, rawMarket, agreement };
}

afterEach(() => vi.restoreAllMocks());

describe('Solana LMSR market bridge', () => {
    it('summarizes the verified sponsor-bound LMSR market and exposes live agreement state without a market', async () => {
        const ctx = setup();
        await expect(ctx.bridge.readSummary(ctx.proposal)).resolves.toMatchObject({
            market: { address: ctx.marketAddress.toBase58(), model: 'lmsr', asset: 'devnet-usdc', b: '100000000',
                qYes: '12000000', qNo: '9000000', seed: '69314720', maxPosition: '0', paidOut: '1000',
                closesAt: 1_900_000_000, graceSeconds: 0, resolved: false, outcome: null, creator: ctx.sponsor.toBase58() },
            marketAddress: ctx.marketAddress.toBase58(), sponsor: ctx.sponsor.toBase58(), chainStatus: 'active',
            deadline: '2030-03-17T17:46:40.000Z', wallet: ctx.wallet.toBase58()
        });
        expect(ctx.client.getMarketPda).toHaveBeenCalledWith(ctx.proposal, ctx.sponsor.toBase58());
        expect(ctx.client.readMarket).toHaveBeenCalledWith(ctx.connection, ctx.marketAddress, undefined);
        expect(ctx.client.readPosition).toHaveBeenCalledTimes(2);
        expect(ctx.window.SolanaChainDataLoader.getVerifiedConnection).toHaveBeenCalledWith('devnet');

        const noMarket = setup({ market: null, deadline: 0 });
        await expect(noMarket.bridge.readSummary(noMarket.proposal)).resolves.toMatchObject({
            market: null, marketAddress: noMarket.marketAddress.toBase58(), chainStatus: 'active', deadline: null
        });
        await expect(noMarket.bridge.readAgreementState(noMarket.proposal)).resolves.toMatchObject({
            sponsor: noMarket.sponsor.toBase58(), lens: noMarket.lens.toBase58(), chainStatus: 'active', deadline: null,
            cid: 'bafkreiabc', executedAt: 0
        });

        const wrong = setup({ market: null });
        wrong.client.readMarket.mockResolvedValue({ ...wrong.rawMarket, creator: wrong.wallet.toBase58() });
        await expect(wrong.bridge.readSummary(wrong.proposal)).rejects.toThrow(/canonical agreement market terms/);
    });

    it('batches strict positions from {account,sponsor,marketAddress} rows and rejects noncanonical addresses', async () => {
        const position = { market: 'm', owner: 'w', side: 1, amount: 200n, claimed: false };
        const ctx = setup({ multipleAccounts: [{ data: position }, null] });
        const rows = [{ account: ctx.proposal, sponsor: ctx.sponsor, marketAddress: ctx.marketAddress }];
        await expect(ctx.bridge.readPositions(rows)).resolves.toMatchObject({
            [ctx.proposal.toBase58()]: { yes: position, no: null }
        });
        expect(ctx.connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
        expect(ctx.client.readPositionAccount).toHaveBeenCalledTimes(1);
        await expect(ctx.bridge.readPositions([{ ...rows[0], marketAddress: ctx.wallet }])).rejects.toThrow(/not canonical/);
        await expect(ctx.bridge.readPositions([{ account: ctx.proposal, sponsor: ctx.sponsor }])).rejects.toThrow(/needs account, sponsor, and marketAddress/);
    });

    it('creates only for the sponsor with a future Active deadline and enough USDC seed plus SOL', async () => {
        const ctx = setup({ wallet: undefined, market: null, sponsorAtaExists: true, sponsorBalance: '70000000' });
        // The sponsor is also the connected wallet in this isolated creation scenario.
        ctx.window.solanaWalletManager.getProvider = () => ({ ...ctx.provider, publicKey: ctx.sponsor });
        const statuses = [];
        const result = await ctx.bridge.createMarket({ proposal: ctx.proposal, onStatus: item => statuses.push(item.state) });
        expect(ctx.client.buildCreateLmsrMarketIx).toHaveBeenCalledWith({
            proposal: ctx.proposal, creator: ctx.sponsor.toBase58(), stakeMint: USDC, b: 100_000_000n,
            closesAt: 1_900_000_000, graceSeconds: 0, maxPosition: 0n, programId: undefined
        });
        expect(result.transactionHash).toBe('tx-signature');
        expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);

        const notSponsor = setup();
        await expect(notSponsor.bridge.createMarket({ proposal: notSponsor.proposal })).rejects.toMatchObject({ code: 'NOT_SPONSOR' });
        expect(notSponsor.connection.getLatestBlockhash).not.toHaveBeenCalled();
        const cutoff = setup({ wallet: undefined, now: 1_900_000_000 });
        cutoff.window.solanaWalletManager.getProvider = () => ({ ...cutoff.provider, publicKey: cutoff.sponsor });
        await expect(cutoff.bridge.createMarket({ proposal: cutoff.proposal })).rejects.toMatchObject({ code: 'INVALID_DEADLINE' });
        const noAta = setup({ wallet: undefined, market: null, sponsorAtaExists: false });
        noAta.window.solanaWalletManager.getProvider = () => ({ ...noAta.provider, publicKey: noAta.sponsor });
        await expect(noAta.bridge.createMarket({ proposal: noAta.proposal })).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        const insufficientSeed = setup({ wallet: undefined, market: null, sponsorBalance: '100' });
        insufficientSeed.window.solanaWalletManager.getProvider = () => ({ ...insufficientSeed.provider, publicKey: insufficientSeed.sponsor });
        await expect(insufficientSeed.bridge.createMarket({ proposal: insufficientSeed.proposal })).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        const noSol = setup({ wallet: undefined, market: null, solBalance: 0 });
        noSol.window.solanaWalletManager.getProvider = () => ({ ...noSol.provider, publicKey: noSol.sponsor });
        await expect(noSol.bridge.createMarket({ proposal: noSol.proposal })).rejects.toMatchObject({ code: 'INSUFFICIENT_SOL' });
    });

    it('preflights buy maxCost and sell minReturn without changing the caller quote or ignoring the deadline', async () => {
        const ctx = setup({ positions: { 1: { amount: 50n, claimed: false } } });
        const statuses = [];
        await ctx.bridge.buy({ proposal: ctx.proposal, side: 1, shares: 7n, maxCost: 900n, onStatus: item => statuses.push(item.state) });
        expect(ctx.client.buildBuyIx).toHaveBeenCalledWith({ market: ctx.marketAddress, proposal: ctx.proposal, owner: ctx.wallet,
            stakeMint: USDC, side: 1, shares: 7n, maxCost: 900n, programId: undefined });
        expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);

        await ctx.bridge.sell({ proposal: ctx.proposal, side: 1, shares: 20n, minReturn: 440n });
        expect(ctx.client.buildSellIx).toHaveBeenCalledWith({ market: ctx.marketAddress, proposal: ctx.proposal, owner: ctx.wallet,
            stakeMint: USDC, side: 1, shares: 20n, minReturn: 440n, programId: undefined });
        const balanceFailure = setup({ tokenBalance: '10' });
        await expect(balanceFailure.bridge.buy({ proposal: balanceFailure.proposal, side: 1, shares: 7n, maxCost: 11n })).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        const noPosition = setup({ positions: { 1: { amount: 2n } } });
        await expect(noPosition.bridge.sell({ proposal: noPosition.proposal, side: 1, shares: 3n, minReturn: 1n })).rejects.toThrow(/enough shares/);
        const cutoff = setup({ now: 1_900_000_000 });
        await expect(cutoff.bridge.buy({ proposal: cutoff.proposal, side: 1, shares: 1n, maxCost: 1n })).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
        expect(cutoff.client.buildBuyIx).not.toHaveBeenCalled();
        await expect(setup({ cluster: 'mainnet-beta' }).bridge.buy({ proposal: ctx.proposal, side: 1, shares: 1n, maxCost: 1n })).rejects.toMatchObject({ code: 'WRONG_NETWORK' });
    });

    it('returns zero only for a missing ATA and propagates token RPC errors', async () => {
        const missing = setup({ traderAtaExists: false });
        await expect(missing.bridge.readStakeBalance()).resolves.toBe(0n);
        expect(missing.connection.getTokenAccountBalance).not.toHaveBeenCalled();
        const error = new Error('RPC unavailable');
        const failed = setup({ balanceError: error });
        await expect(failed.bridge.readStakeBalance()).rejects.toBe(error);
    });

    it('resolves and claims VOID positions, creating a missing recipient ATA idempotently', async () => {
        const resolve = setup();
        await resolve.bridge.resolve({ proposal: resolve.proposal });
        expect(resolve.client.buildResolveLmsrIx).toHaveBeenCalledWith({ market: resolve.marketAddress, proposal: resolve.proposal,
            schema: web3.SystemProgram.programId, programId: undefined });

        const claim = setup({ resolved: true, outcome: 2, traderAtaExists: false, positions: { 0: { amount: 5n, claimed: false } } });
        const result = await claim.bridge.claim({ proposal: claim.proposal, side: 0 });
        expect(claim.client.buildClaimLmsrIx).toHaveBeenCalledWith({ market: claim.marketAddress, owner: claim.wallet, stakeMint: USDC, side: 0, programId: undefined });
        const instructions = claim.calls[0][1].instructions;
        expect(instructions.map(instruction => instruction.kind)).toEqual([undefined, 'claim']);
        expect(instructions[0].programId.equals(associatedTokenProgram)).toBe(true);
        expect([...instructions[0].data]).toEqual([1]);
        expect(result.transactionHash).toBe('tx-signature');

        const noPay = setup({ resolved: true, outcome: 2, positions: { 0: { amount: 1n, claimed: false } } });
        await expect(noPay.bridge.claim({ proposal: noPay.proposal, side: 0 })).rejects.toThrow(/no payable claim/);
        const loser = setup({ resolved: true, outcome: 1, positions: { 0: { amount: 100n, claimed: false } } });
        await expect(loser.bridge.claim({ proposal: loser.proposal, side: 0 })).rejects.toThrow(/no payable claim/);
        const already = setup({ resolved: true, outcome: 0, positions: { 0: { amount: 100n, claimed: true } } });
        await expect(already.bridge.claim({ proposal: already.proposal, side: 0 })).rejects.toThrow(/no claimable position/);
    });

    it('keeps confirmation timeout as unknown after successful submit', async () => {
        const ctx = setup({ confirmError: new Error('timed out') });
        const states = [];
        await expect(ctx.bridge.buy({ proposal: ctx.proposal, side: 1, shares: 2n, maxCost: 5n, onStatus: item => states.push(item.state) }))
            .rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN', transactionHash: 'tx-signature' });
        expect(states).toEqual(['preparing', 'awaiting_signature', 'submitted']);
        expect(ctx.provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('reports stale quotes before signing and lost send acknowledgements as uncertain', async () => {
        const stale = setup({ simulation: { value: { err: { InstructionError: [0, { Custom: 6031 }] },
            logs: ['Program log: AnchorError. Error Code: CostExceedsMax. Error Number: 6031.'] } } });
        await expect(stale.bridge.buy({ proposal: stale.proposal, side: 1, shares: 2n, maxCost: 5n }))
            .rejects.toMatchObject({ code: 'STALE_QUOTE' });
        expect(stale.provider.signTransaction).not.toHaveBeenCalled();
        const lost = setup();
        lost.connection.sendRawTransaction.mockRejectedValue(new Error('connection lost'));
        await expect(lost.bridge.buy({ proposal: lost.proposal, side: 1, shares: 2n, maxCost: 5n }))
            .rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN' });
        expect(lost.provider.signTransaction).toHaveBeenCalledTimes(1);
    });
});
