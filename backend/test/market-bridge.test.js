// Canonical LMSR wallet reads, quote limits, and uncertain transaction receipts.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const lmsr = require('../../frontend/js/bets/lmsr.js');
const codec = require('../../frontend/js/solana/lmsr-client.js').configure({ web3 });
const bridgeSource = fs.readFileSync(new URL('../../frontend/js/solana/market-bridge.js', import.meta.url), 'utf8');
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const programId = new web3.PublicKey('9S7jXSkWyDYF1W95E8JYDwjpqR9tfXZiMKc6L3NGgJ71');
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
    const marketAddress = codec.getMarketPda(proposal, sponsor, { stakeMint: mint, b: 100_000_000n, closesAt: options.deadline ?? 1_900_000_000 })[0];
    const traderAta = web3.PublicKey.findProgramAddressSync([wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram)[0];
    const sponsorAta = web3.PublicKey.findProgramAddressSync([sponsor.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram)[0];
    const agreement = { authority: sponsor.toBase58(), lens: lens.toBase58(), lenses: options.lenses || [lens.toBase58()], cid: 'bafkreiabc', status: options.status || 'Active',
        deadline: options.deadline ?? 1_900_000_000, executedAt: options.executedAt ?? 0 };
    const rawMarket = options.market === null ? null : {
        kind: 0, proposal: proposal.toBase58(), creator: sponsor.toBase58(), stakeMint: options.stakeMint || USDC,
        vault: web3.Keypair.generate().publicKey.toBase58(), b: 100_000_000n, qYes: 12_000_000n, qNo: 9_000_000n,
        seed: 69_314_720n, closesAt: BigInt(agreement.deadline), graceSeconds: 0, maxPosition: 0n,
        paidOut: 1_000n, resolved: Boolean(options.resolved), outcome: options.outcome ?? 0
    };
    const client = {
        constants: { SIDE_NO: 0, SIDE_YES: 1, OUTCOME_VOID: 2, KIND_PROPOSAL: 0, ASSOCIATED_TOKEN_PROGRAM_ID: associatedTokenProgram.toBase58(), TOKEN_PROGRAM_ID: tokenProgram.toBase58() },
        getPositionPda: vi.fn((market, owner, side) => [web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr_position'), new web3.PublicKey(market).toBuffer(), new web3.PublicKey(owner).toBuffer(), Buffer.from([side])], programId)[0]]),
        getAssociatedTokenAddress: vi.fn((owner, tokenMint) => web3.PublicKey.findProgramAddressSync([new web3.PublicKey(owner).toBuffer(), tokenProgram.toBuffer(), new web3.PublicKey(tokenMint).toBuffer()], associatedTokenProgram)[0]),
        readMarket: vi.fn(async (_connection, address) => new web3.PublicKey(address).equals(marketAddress) ? rawMarket : null),
        readPosition: vi.fn(async (_connection, _market, _owner, side) => options.positions?.[side] ?? null),
        readPositionAccount: vi.fn(info => info.data),
        buildCreateLmsrMarketIx: vi.fn(args => ({ kind: 'create-lmsr', keys: codec.buildCreateLmsrMarketIx(args).keys, args })),
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
        Lmsr: { maxLoss: vi.fn(lmsr.maxLoss) },
        solanaWalletManager: { getCluster: vi.fn(() => options.cluster || 'devnet'), getProvider: vi.fn(() => provider) }
    };
    vm.runInNewContext(bridgeSource, { window, Buffer, Uint8Array, BigInt, Date });
    return { bridge: window.SolanaMarketBridge, window, client, connection, provider, calls, proposal, sponsor, wallet, lens, marketAddress, traderAta, sponsorAta, rawMarket, agreement };
}

afterEach(() => vi.restoreAllMocks());

describe('Solana LMSR market bridge', () => {
    it('summarizes the verified sponsor-bound LMSR market and exposes live agreement state without a market', async () => {
        const ctx = setup();
        const summary = await ctx.bridge.readSummary(ctx.proposal, { marketAddress: ctx.marketAddress });
        expect(summary.market).toMatchObject({ address: ctx.marketAddress.toBase58(), b: '100000000', creatorRole: 'sponsor' });
        expect(summary.lenses).toEqual([ctx.lens.toBase58()]);
        expect(ctx.client.readPosition).toHaveBeenCalledTimes(2);
        expect((await ctx.bridge.readSummary(ctx.proposal)).marketAddress).toBeNull();
        await expect(ctx.bridge.readSummary(ctx.proposal, { marketAddress: ctx.wallet })).rejects.toThrow(/not found/);
        ctx.client.readMarket.mockResolvedValue({ ...ctx.rawMarket, proposal: ctx.wallet.toBase58() });
        await expect(ctx.bridge.readSummary(ctx.proposal, { marketAddress: ctx.marketAddress })).rejects.toThrow(/does not match/);
    });

    it('keys wallet positions by market and requires a market address', async () => {
        const position = { amount: 200n, claimed: false };
        const ctx = setup({ multipleAccounts: [{ data: position }, null, null, null] });
        const other = web3.Keypair.generate().publicKey;
        const result = await ctx.bridge.readPositions([ctx.marketAddress, other].map(marketAddress => ({ account: ctx.proposal, marketAddress })));
        expect(result).toEqual({ [ctx.marketAddress]: { yes: position, no: null }, [other]: { yes: null, no: null } });
        await expect(ctx.bridge.readPositions([{ account: ctx.proposal }])).rejects.toThrow(/marketAddress/);
    });

    it('opens distinct chosen terms as an independent wallet and replays only the funded address', async () => {
        const ctx = setup();
        const args = { proposal: ctx.proposal, b: 7_000_000n, closesAt: 1_810_000_000 };
        const first = await ctx.bridge.createMarket(args);
        const second = await ctx.bridge.createMarket({ ...args, closesAt: args.closesAt + 1 });
        expect(first.marketAddress).not.toBe(second.marketAddress);
        expect(ctx.client.buildCreateLmsrMarketIx).toHaveBeenCalledWith(expect.objectContaining({
            creator: ctx.wallet.toBase58(), b: args.b, closesAt: args.closesAt }));
        ctx.client.readMarket.mockResolvedValue({ ...ctx.rawMarket, creator: ctx.wallet.toBase58(), b: args.b, closesAt: BigInt(args.closesAt), seed: lmsr.maxLoss(args.b) });
        await expect(ctx.bridge.createMarket(args)).resolves.toMatchObject({ replayed: true, marketAddress: first.marketAddress });
        expect(ctx.provider.signTransaction).toHaveBeenCalledTimes(2);
        const poor = setup({ tokenBalance: '1' });
        await expect(poor.bridge.createMarket({ proposal: poor.proposal, b: args.b })).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        expect(poor.provider.signTransaction).not.toHaveBeenCalled();
    });

    it('preflights buy maxCost and sell minReturn without changing the caller quote or ignoring the deadline', async () => {
        const ctx = setup({ positions: { 1: { amount: 50n, claimed: false } } });
        const statuses = [];
        await ctx.bridge.buy({ proposal: ctx.proposal, marketAddress: ctx.marketAddress, side: 1, shares: 7n, maxCost: 900n, onStatus: item => statuses.push(item.state) });
        expect(ctx.client.buildBuyIx).toHaveBeenCalledWith({ market: ctx.marketAddress, proposal: ctx.proposal, owner: ctx.wallet,
            stakeMint: USDC, side: 1, shares: 7n, maxCost: 900n, programId: undefined });
        expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);

        await ctx.bridge.sell({ proposal: ctx.proposal, marketAddress: ctx.marketAddress, side: 1, shares: 20n, minReturn: 440n });
        expect(ctx.client.buildSellIx).toHaveBeenCalledWith({ market: ctx.marketAddress, proposal: ctx.proposal, owner: ctx.wallet,
            stakeMint: USDC, side: 1, shares: 20n, minReturn: 440n, programId: undefined });
        const balanceFailure = setup({ tokenBalance: '10' });
        await expect(balanceFailure.bridge.buy({ proposal: balanceFailure.proposal, marketAddress: balanceFailure.marketAddress, side: 1, shares: 7n, maxCost: 11n })).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        const noPosition = setup({ positions: { 1: { amount: 2n } } });
        await expect(noPosition.bridge.sell({ proposal: noPosition.proposal, marketAddress: noPosition.marketAddress, side: 1, shares: 3n, minReturn: 1n })).rejects.toThrow(/enough shares/);
        const cutoff = setup({ now: 1_900_000_000 });
        await expect(cutoff.bridge.buy({ proposal: cutoff.proposal, marketAddress: cutoff.marketAddress, side: 1, shares: 1n, maxCost: 1n })).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
        expect(cutoff.client.buildBuyIx).not.toHaveBeenCalled();
        // Any lens member is an insider, not only the first.
        const member = web3.Keypair.generate().publicKey;
        const insider = setup({ wallet: member, lenses: [web3.Keypair.generate().publicKey.toBase58(), member.toBase58()] });
        await expect(insider.bridge.buy({ proposal: insider.proposal, marketAddress: insider.marketAddress, side: 1, shares: 1n, maxCost: 1n })).rejects.toMatchObject({ code: 'INSIDER_TRADE' });
        expect(insider.client.buildBuyIx).not.toHaveBeenCalled();
        await expect(setup({ cluster: 'mainnet-beta' }).bridge.buy({ proposal: ctx.proposal, marketAddress: ctx.marketAddress, side: 1, shares: 1n, maxCost: 1n })).rejects.toMatchObject({ code: 'WRONG_NETWORK' });
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
        await resolve.bridge.resolve({ proposal: resolve.proposal, marketAddress: resolve.marketAddress });
        expect(resolve.client.buildResolveLmsrIx).toHaveBeenCalledWith({ market: resolve.marketAddress, proposal: resolve.proposal, evidence: [],
            schema: web3.SystemProgram.programId, programId: undefined });

        const claim = setup({ resolved: true, outcome: 2, traderAtaExists: false, positions: { 0: { amount: 5n, claimed: false } } });
        const result = await claim.bridge.claim({ proposal: claim.proposal, marketAddress: claim.marketAddress, side: 0 });
        expect(claim.client.buildClaimLmsrIx).toHaveBeenCalledWith({ market: claim.marketAddress, owner: claim.wallet, stakeMint: USDC, side: 0, programId: undefined });
        const instructions = claim.calls[0][1].instructions;
        expect(instructions.map(instruction => instruction.kind)).toEqual([undefined, 'claim']);
        expect(instructions[0].programId.equals(associatedTokenProgram)).toBe(true);
        expect([...instructions[0].data]).toEqual([1]);
        expect(result.transactionHash).toBe('tx-signature');

        const noPay = setup({ resolved: true, outcome: 2, positions: { 0: { amount: 1n, claimed: false } } });
        await expect(noPay.bridge.claim({ proposal: noPay.proposal, marketAddress: noPay.marketAddress, side: 0 })).rejects.toThrow(/no payable claim/);
        const loser = setup({ resolved: true, outcome: 1, positions: { 0: { amount: 100n, claimed: false } } });
        await expect(loser.bridge.claim({ proposal: loser.proposal, marketAddress: loser.marketAddress, side: 0 })).rejects.toThrow(/no payable claim/);
        const already = setup({ resolved: true, outcome: 0, positions: { 0: { amount: 100n, claimed: true } } });
        await expect(already.bridge.claim({ proposal: already.proposal, marketAddress: already.marketAddress, side: 0 })).rejects.toThrow(/no claimable position/);
    });

    it('keeps confirmation timeout as unknown after successful submit', async () => {
        const ctx = setup({ confirmError: new Error('timed out') });
        const states = [];
        await expect(ctx.bridge.buy({ proposal: ctx.proposal, marketAddress: ctx.marketAddress, side: 1, shares: 2n, maxCost: 5n, onStatus: item => states.push(item.state) }))
            .rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN', transactionHash: 'tx-signature' });
        expect(states).toEqual(['preparing', 'awaiting_signature', 'submitted']);
        expect(ctx.provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('reports stale quotes before signing and lost send acknowledgements as uncertain', async () => {
        const stale = setup({ simulation: { value: { err: { InstructionError: [0, { Custom: 6031 }] },
            logs: ['Program log: AnchorError. Error Code: CostExceedsMax. Error Number: 6031.'] } } });
        await expect(stale.bridge.buy({ proposal: stale.proposal, marketAddress: stale.marketAddress, side: 1, shares: 2n, maxCost: 5n }))
            .rejects.toMatchObject({ code: 'STALE_QUOTE' });
        expect(stale.provider.signTransaction).not.toHaveBeenCalled();
        const lost = setup();
        lost.connection.sendRawTransaction.mockRejectedValue(new Error('connection lost'));
        await expect(lost.bridge.buy({ proposal: lost.proposal, marketAddress: lost.marketAddress, side: 1, shares: 2n, maxCost: 5n }))
            .rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN' });
        expect(lost.provider.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('lets only the opener of a resolved market take back what its payouts leave of the seed', async () => {
        const sponsor = web3.Keypair.generate().publicKey;
        const withReclaim = ctx => Object.assign(ctx.client, { reclaimableSeed: codec.reclaimableSeed,
            buildReclaimSeedIx: vi.fn(args => ({ kind: 'reclaim', args })) }) && ctx;
        const opener = withReclaim(setup({ sponsor, wallet: sponsor, resolved: true, outcome: 1, sponsorAtaExists: false, traderAtaExists: false }));
        // vault 1 000 000 000, YES owed 12 000 000 less 1 000 paid out
        expect(await opener.bridge.readReclaimableSeed({ proposal: opener.proposal, marketAddress: opener.marketAddress }))
            .toEqual({ creator: sponsor.toBase58(), resolved: true, amount: 988_001_000n });
        const receipt = await opener.bridge.reclaimSeed({ proposal: opener.proposal, marketAddress: opener.marketAddress });
        expect(receipt).toMatchObject({ transactionHash: 'tx-signature', amount: 988_001_000n });
        expect(opener.client.buildReclaimSeedIx).toHaveBeenCalledWith(expect.objectContaining({ creator: sponsor, stakeMint: USDC }));
        const sent = opener.calls.find(([kind]) => kind === 'simulate')[1].instructions;
        expect(sent.map(instruction => instruction.kind || 'ata')).toEqual(['ata', 'reclaim']);

        const bettor = withReclaim(setup({ sponsor, resolved: true, outcome: 1 }));
        await expect(bettor.bridge.reclaimSeed({ proposal: bettor.proposal, marketAddress: bettor.marketAddress }))
            .rejects.toMatchObject({ code: 'NOT_MARKET_CREATOR' });
        const open = withReclaim(setup({ sponsor, wallet: sponsor }));
        expect((await open.bridge.readReclaimableSeed({ proposal: open.proposal, marketAddress: open.marketAddress })).amount).toBe(0n);
        await expect(open.bridge.reclaimSeed({ proposal: open.proposal, marketAddress: open.marketAddress }))
            .rejects.toMatchObject({ code: 'MARKET_OPEN' });
        const taken = withReclaim(setup({ sponsor, wallet: sponsor, resolved: true, outcome: 1, tokenBalance: '11999000' }));
        await expect(taken.bridge.reclaimSeed({ proposal: taken.proposal, marketAddress: taken.marketAddress }))
            .rejects.toMatchObject({ code: 'NOTHING_TO_RECLAIM' });
        expect([bettor, open, taken].every(ctx => !ctx.calls.length)).toBe(true);
    });
});
