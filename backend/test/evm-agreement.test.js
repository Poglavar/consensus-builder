// Unit tests for frontend/js/chain/evm-agreement.js (docs/blockchain-flows.md, R4): the agreement key
// against a hand-built abi.encode, ETH amounts, what the contract would accept now, a `get` Record
// decoded through the real ABI into the panel's shape, the lens decision a member lists, decoded
// contract errors, and the browser actions over a fake wallet and contract.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as ethers from 'ethers';

const require = createRequire(import.meta.url);
const Bridge = require('../../frontend/js/chain/evm-agreement.js');
const LensCore = require('../../frontend/js/lens-core.js');

const SPONSOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const LENS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const STRANGER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const CONTRACT = '0xe9bd361f00CDE963659a81c8e4F6b21d696f9302';
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const UID = `0x${'5e'.repeat(32)}`;
const NOW = 1_790_000_000;
const WEI = 10n ** 18n;

// abi.encode(address, string) by hand: the padded address, the string's offset (0x40), its length
// and its bytes right-padded to a 32-byte word.
function encodeByHand(address, text) {
    const word = hex => hex.padStart(64, '0');
    const bytes = Buffer.from(text, 'utf8');
    const padded = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    return `0x${word(address.slice(2).toLowerCase())}${word('40')}${word(bytes.length.toString(16))}${padded}`;
}

// A Record as the contract's `get` returns it, decoded through the bridge's own ABI.
function decodedRecord(overrides = {}) {
    const iface = new ethers.Interface(Bridge.AGREEMENT_ABI);
    const record = {
        sponsor: SPONSOR, lens: LENS, payout: SPONSOR, deadline: 0n, createdAt: BigInt(NOW - 100), requiredWei: WEI, escrowWei: 0n,
        status: 0, openGround: false, decision: 0, decisionAttestedAt: 0n, decisionObservedAt: 0n, decisionAttestation: ethers.ZeroHash,
        decisionHash: ethers.ZeroHash, executedAt: 0n, cid: CID, ...overrides
    };
    return iface.decodeFunctionResult('get', iface.encodeFunctionResult('get', [record]))[0];
}
const valueOf = overrides => Bridge.valueOf(decodedRecord(overrides), { key: Bridge.keyOf(SPONSOR, CID, ethers), chainId: '84532', contract: CONTRACT, ethers });

describe('EvmAgreementBridge (pure)', () => {
    it('keys an agreement as keccak256(abi.encode(sponsor, cid)), in any letter case of the sponsor', () => {
        const expected = ethers.keccak256(encodeByHand(SPONSOR, CID));
        expect(Bridge.keyOf(SPONSOR, CID, ethers)).toBe(expected);
        expect(Bridge.keyOf(SPONSOR.toLowerCase(), CID, ethers)).toBe(expected);
        expect(Bridge.keyOf(STRANGER, CID, ethers)).not.toBe(expected);
        expect(() => Bridge.keyOf('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', CID, ethers)).toThrow(/Not an EVM address/);
    });

    it('converts ETH to wei exactly and back for display', () => {
        expect(Bridge.unitsFrom(1.5)).toBe(3n * WEI / 2n);
        expect(Bridge.unitsFrom(0.1)).toBe(WEI / 10n);
        expect(Bridge.unitsFrom('0.000000000000000001')).toBe(1n);
        expect(Bridge.unitsFrom(1e-7)).toBe(100_000_000_000n);
        expect(Bridge.unitsFrom(0)).toBeNull();
        expect(Bridge.unitsFrom(0, { allowZero: true })).toBe(0n);
        for (const bad of [-1, Number.NaN, Infinity, '1.0000000000000000001', 'abc', null]) expect(Bridge.unitsFrom(bad), String(bad)).toBeNull();
        expect(Bridge.amountOf(3n * WEI / 2n)).toBe(1.5);
        expect(Bridge.amountOf('250000000000000000')).toBe(0.25);
        expect([Bridge.currency, Bridge.decimals, Bridge.family]).toEqual(['ETH', 18, 'evm']);
    });

    it('reads a minted agreement record and links its transaction or contract', () => {
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        expect(Bridge.onchainRef({ onchain: { chain: 'evm', chainId: 84532, account: key } })).toEqual({ chainId: '84532', account: key, contract: null });
        expect(Bridge.onchainRef({ onchain: { chain: 'evm', chainId: '0x14a34', account: key, contract: CONTRACT } })).toEqual({ chainId: '84532', account: key, contract: CONTRACT });
        expect(Bridge.onchainRef({ onchain: { chain: 'solana', cluster: 'devnet', account: key } })).toBeNull();
        expect(Bridge.onchainRef({ onchain: { chain: 'evm', chainId: '84532', account: '0x12' } })).toBeNull();
        expect(Bridge.explorerUrl({ signature: '0xtx', chainId: '84532' })).toBe('https://sepolia.basescan.org/tx/0xtx');
        expect(Bridge.explorerUrl({ account: key, chainId: '84532', contract: CONTRACT })).toBe(`https://sepolia.basescan.org/address/${CONTRACT}`);
        expect(Bridge.explorerUrl({ account: key, chainId: '84532' })).toBeNull();
        expect(Bridge.explorerUrl({ signature: '0xtx', chainId: '31337' })).toBeNull();
    });

    it('names an EVM lens member only', () => {
        const proposed = rule => ({ published: { cid: CID, sponsor: SPONSOR }, rule });
        expect(Bridge.mintLens(proposed({ electorate: 'owners', lens: ['9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', { address: LENS }] }))).toBe(LENS);
        expect(Bridge.mintLens(proposed({ electorate: 'community' }), [{ address: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB' }, { address: STRANGER }])).toBe(STRANGER);
        expect(Bridge.mintLens(proposed({ electorate: 'owners', lens: ['GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB'] }))).toBeNull();
    });

    it('decodes a get Record into the shape the panel reads from a Solana account', () => {
        const value = valueOf({ escrowWei: WEI / 4n, deadline: BigInt(NOW + 60), openGround: true });
        expect(value).toMatchObject({
            cid: CID, authority: SPONSOR, lens: LENS, payout: SPONSOR, deadline: NOW + 60, createdAt: NOW - 100,
            requiredLamports: WEI, escrowLamports: WEI / 4n, statusCode: 0, status: 'Active', decisionCode: 0, decision: 'Pending',
            decisionAttestation: null, decisionHash: null, executedAt: 0, openGround: true, currency: 'ETH', decimals: 18, chainId: '84532', contract: CONTRACT
        });
        const executed = valueOf({ status: 1, decision: 1, decisionAttestation: UID, executedAt: BigInt(NOW) });
        expect(executed).toMatchObject({ status: 'Executed', decision: 'Satisfied', decisionAttestation: UID, executedAt: NOW });
    });

    it('reads through a contract: null when absent, refused when it holds another CID or sponsor', async () => {
        const record = decodedRecord();
        const contract = { exists: vi.fn(async () => true), get: vi.fn(async () => record) };
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        await expect(Bridge.readAgreement(contract, { key, cid: CID, sponsor: SPONSOR.toLowerCase(), ethers })).resolves.toMatchObject({ status: 'Active', address: key });
        expect(contract.get).toHaveBeenCalledWith(key);
        await expect(Bridge.readAgreement(contract, { key, cid: 'bafkreiother', ethers })).rejects.toMatchObject({ code: 'cid-mismatch' });
        await expect(Bridge.readAgreement(contract, { key, sponsor: STRANGER, ethers })).rejects.toMatchObject({ code: 'sponsor-mismatch' });
        contract.exists.mockResolvedValueOnce(false);
        await expect(Bridge.readAgreement(contract, { key, ethers })).resolves.toBeNull();
    });

    it('allows what the contract would accept now', () => {
        const actions = (overrides, wallet = SPONSOR, attestation = null) => Bridge.chainActions(valueOf(overrides), { wallet, nowSeconds: NOW, attestation });
        const on = list => Object.entries(list).filter(([name, allowed]) => allowed === true && ['fund', 'attest', 'execute', 'cancel', 'expire'].includes(name)).map(([name]) => name);
        expect(on(actions({}))).toEqual(['fund', 'cancel']);
        expect(on(actions({}, SPONSOR.toLowerCase()))).toEqual(['fund', 'cancel']);
        expect(on(actions({}, STRANGER))).toEqual([]);
        expect(on(actions({}, null, UID))).toEqual([]);
        expect(on(actions({}, STRANGER, UID))).toEqual(['attest']);
        expect(on(actions({ decision: 1 }))).toEqual(['fund']);
        expect(on(actions({ decision: 1, escrowWei: WEI }, STRANGER))).toEqual(['execute']);
        expect(on(actions({ deadline: BigInt(NOW) }, STRANGER))).toEqual(['expire']);
        expect(on(actions({ deadline: BigInt(NOW) }))).toEqual(['cancel', 'expire']);
        expect(on(actions({ status: 2 }))).toEqual([]);
        expect(actions({ decision: 1, escrowWei: WEI })).toMatchObject({ authority: true, funded: true, deadlinePassed: false });
    });

    it('finds the EAS decision a member lists for this chain, CID and sponsor', () => {
        const value = valueOf();
        const entry = (overrides = {}) => ({ kind: 'decision', chain: 'evm', chainId: 84532, uid: UID, authority: LENS, payload: { agreementCid: CID, sponsor: SPONSOR.toLowerCase(), decision: 'satisfied' }, ...overrides });
        // The member's listing passes through LensCore as the page reads it.
        const listed = list => LensCore.normalizeAttestations({ attestations: list });
        const find = (list, chainId = '84532') => Bridge.decisionAttestationOf(listed(list), { cid: CID, value, chainId, nowSeconds: NOW });
        expect(listed([entry()])[0]).toMatchObject({ address: UID, uid: UID, chain: 'evm', chainId: '84532', authority: LENS });
        expect(find([entry()])).toMatchObject({ uid: UID });
        expect(find([entry()], '11155111')).toBeNull();
        expect(find([entry({ chain: undefined, address: 'SolanaAttestation1111111111111111111111111' })])).toBeNull();
        expect(find([entry({ kind: 'ownership' })])).toBeNull();
        expect(find([entry({ payload: { agreementCid: 'bafkreiother', sponsor: SPONSOR } })])).toBeNull();
        expect(find([entry({ payload: { agreementCid: CID, sponsor: STRANGER } })])).toBeNull();
        expect(find([entry({ uid: '0x1234' })])).toBeNull();
        expect(find([entry({ expiry: NOW - 1 })])).toBeNull();
        expect(find([entry({ kind: 'ownership' }), entry()])).toMatchObject({ uid: UID });
    });

    it('names the contract error a call reverts with', () => {
        const iface = new ethers.Interface(Bridge.AGREEMENT_ABI);
        expect(Bridge.revertReason({ data: iface.encodeErrorResult('EscrowShort', [1n, 2n]) }, iface)).toBe('EscrowShort(1, 2)');
        expect(Bridge.revertReason({ error: { data: iface.encodeErrorResult('NotSponsor', []) } }, iface)).toBe('NotSponsor');
        expect(Bridge.revertReason({ revert: { name: 'DeadlinePassed', args: [] } })).toBe('DeadlinePassed');
        expect(Bridge.revertReason({ shortMessage: 'missing revert data' }, iface)).toBe('missing revert data');
    });
});

// ---- browser actions over a fake wallet and contract ------------------------------------------

// A fake Agreement contract holding `records` by key, whose writes record what they were sent with.
function fakeChain({ wallet = SPONSOR, walletChain = '84532', records = new Map(), revert = null } = {}) {
    const sent = [];
    const iface = new ethers.Interface(Bridge.AGREEMENT_ABI);
    const write = name => Object.assign(async (...args) => {
        sent.push([name, ...args]);
        if (name === 'create') records.set(Bridge.keyOf(wallet, args[0], ethers), decodedRecord({ sponsor: wallet, lens: args[1], payout: args[5], requiredWei: args[4] }));
        return { hash: `0x${name}tx`, wait: async () => ({ status: 1 }) };
    }, {
        staticCall: async () => { if (revert) throw Object.assign(new Error('execution reverted'), { data: iface.encodeErrorResult(revert, []) }); }
    });
    class Contract {
        constructor(address, abi, runner) { this.address = address; this.runner = runner; this.interface = iface; }
        async exists(key) { return records.has(key); }
        async get(key) { return records.get(key); }
    }
    for (const name of ['create', 'fund', 'attest', 'execute', 'cancel', 'expire']) Contract.prototype[name] = write(name);
    const fakeEthers = {
        ...ethers,
        Contract,
        BrowserProvider: class { async getSigner() { return { getAddress: async () => wallet }; } }
    };
    const win = {
        ethers: fakeEthers,
        walletManager: { getState: () => ({ status: 'connected', accounts: [wallet.toLowerCase()], chainId: walletChain }), getProvider: () => ({}) },
        EvmAdapter: {
            ensureEthers: async () => fakeEthers,
            walletChainId: () => walletChain,
            contractAddresses: async chainId => (chainId === '84532' ? { Agreement: CONTRACT } : {})
        },
        ChainDataLoader: { getProviderForChain: async () => ({}) }
    };
    return { bridge: Bridge.browser(win), sent, records };
}
const proposed = (extra = {}) => ({ id: 'a1', published: { cid: CID, sponsor: SPONSOR }, deadline: null, inputs: { openGroundM2: 12 }, ...extra });
const mintedOn = key => proposed({ onchain: { chain: 'evm', chainId: '84532', account: key } });
const thrown = async work => { try { await work(); } catch (error) { return error; } return null; };

describe('EvmAgreementBridge (browser)', () => {
    it('mints as the sponsor through a simulation first, with the Solana bridge\'s status phases, and only once', async () => {
        const { bridge, sent } = fakeChain();
        const phases = [];
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const minted = await bridge.mint({ agreement: proposed(), lens: LENS, required: WEI, payout: STRANGER.toLowerCase(), onStatus: ({ state }) => phases.push(state) });
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        expect(minted).toEqual({ signature: '0xcreatetx', account: key, chainId: '84532', contract: CONTRACT, explorerUrl: 'https://sepolia.basescan.org/tx/0xcreatetx' });
        expect(phases).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(sent).toEqual([['create', CID, LENS, 0, true, WEI, STRANGER]]);
        // Created before: the same key, no second transaction.
        await expect(bridge.mint({ agreement: proposed(), lens: LENS, required: WEI, payout: SPONSOR })).resolves.toMatchObject({ signature: null, account: key });
        expect(sent.length).toBe(1);
        // The ref now links the contract, which the mint looked up.
        expect(bridge.onchainRef(mintedOn(key))).toEqual({ chainId: '84532', account: key, contract: CONTRACT });
        expect(bridge.connectedWallet()).toBe(SPONSOR);
        info.mockRestore();
    });

    it('refuses what the contract would refuse before any wallet is asked', async () => {
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        expect(await thrown(() => fakeChain({ wallet: STRANGER }).bridge.mint({ agreement: proposed(), lens: LENS, payout: SPONSOR }))).toMatchObject({ code: 'not-sponsor' });
        expect(await thrown(() => fakeChain().bridge.mint({ agreement: proposed(), lens: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', payout: SPONSOR }))).toMatchObject({ code: 'no-lens' });
        expect(await thrown(() => fakeChain().bridge.mint({ agreement: proposed({ deadline: '2020-01-01T00:00:00Z' }), lens: LENS, payout: SPONSOR }))).toMatchObject({ code: 'deadline-passed' });
        expect(await thrown(() => fakeChain({ walletChain: '11155111' }).bridge.mint({ agreement: proposed(), lens: LENS, payout: SPONSOR })))
            .toMatchObject({ code: 'contract-missing', message: 'The agreement contract is not deployed on Sepolia.' });
        expect(await thrown(() => fakeChain({ walletChain: '11155111' }).bridge.execute({ agreement: mintedOn(key) })))
            .toMatchObject({ code: 'wrong-chain', message: 'Switch the wallet to Base Sepolia to act on this agreement.' });
        expect(await thrown(() => fakeChain().bridge.execute({ agreement: mintedOn(key) }))).toMatchObject({ code: 'account-missing' });

        const records = new Map([[key, decodedRecord()]]);
        const stranger = fakeChain({ wallet: STRANGER, records });
        expect(await thrown(() => stranger.bridge.fund({ agreement: mintedOn(key), amount: WEI }))).toMatchObject({ code: 'not-authority' });
        expect(await thrown(() => stranger.bridge.attest({ agreement: mintedOn(key), attestation: { uid: '0x12' } }))).toMatchObject({ code: 'precheck-failed', reason: 'invalid-uid' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const refused = fakeChain({ wallet: STRANGER, records, revert: 'DecisionPending' });
        expect(await thrown(() => refused.bridge.execute({ agreement: mintedOn(key) }))).toMatchObject({ code: 'simulation-failed', reason: 'DecisionPending', message: 'The transaction would fail: DecisionPending' });
        expect(refused.sent).toEqual([]);
        warn.mockRestore();
        expect(stranger.sent).toEqual([]);
    });

    it('funds, attests, executes, cancels and expires the agreement at its key', async () => {
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const sponsor = fakeChain({ records: new Map([[key, decodedRecord()]]) });
        await expect(sponsor.bridge.fund({ agreement: mintedOn(key), lamports: WEI })).resolves.toMatchObject({ signature: '0xfundtx', account: key, chainId: '84532' });
        await sponsor.bridge.attest({ agreement: mintedOn(key), attestation: UID });
        await sponsor.bridge.attest({ agreement: mintedOn(key), attestation: { uid: UID } });
        await sponsor.bridge.cancel({ agreement: mintedOn(key) });
        const anyone = fakeChain({ wallet: STRANGER, records: new Map([[key, decodedRecord()]]) });
        await anyone.bridge.execute({ agreement: mintedOn(key) });
        await anyone.bridge.expire({ agreement: mintedOn(key) });
        expect(sponsor.sent).toEqual([['fund', key, { value: WEI }], ['attest', key, UID], ['attest', key, UID], ['cancel', key]]);
        expect(anyone.sent).toEqual([['execute', key], ['expire', key]]);
        await expect(anyone.bridge.read(mintedOn(key))).resolves.toMatchObject({ status: 'Active', authority: SPONSOR, contract: CONTRACT });
        await expect(anyone.bridge.read({ agreement: mintedOn(key) })).resolves.toMatchObject({ status: 'Active' });
        info.mockRestore();
    });

    it('finds the lens decision at the service of the member whose EVM address is the lens', async () => {
        const key = Bridge.keyOf(SPONSOR, CID, ethers);
        const value = valueOf();
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const listed = { kind: 'decision', chain: 'evm', chainId: '84532', uid: UID, address: UID, payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' } };
        const fetchAttestations = vi.fn(async () => ({ status: 200, attestations: [listed] }));
        // A member with no EVM address is not the lens of an EVM agreement, whatever else it lists.
        const members = LensCore.normalizeDirectory({ members: [
            { key: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ', addresses: { solana: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ', evm: null }, serviceUrl: 'https://other.example' },
            { key: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', addresses: { solana: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', evm: LENS.toLowerCase() }, serviceUrl: 'https://lens.example' }] });
        const win = { LensCore, LensPicker: { loadDirectory: async () => ({ members }) }, LensServiceClient: { fetchAttestations } };
        // The lookup needs no wallet or contract: the directory and the member's service are enough.
        const withLens = Bridge.browser(win);
        await expect(withLens.findAttestation(mintedOn(key), value)).resolves.toEqual({ uid: UID, address: UID, decision: 'satisfied', member: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB' });
        expect(fetchAttestations).toHaveBeenCalledWith({ serviceUrl: 'https://lens.example', filter: { kind: 'decision', agreementCid: CID } });
        fetchAttestations.mockResolvedValueOnce({ status: 502, attestations: null, outcome: { message: 'bad gateway' } });
        expect(await thrown(() => withLens.findAttestation(mintedOn(key), value))).toMatchObject({ code: 'lens-unavailable' });
        await expect(withLens.findAttestation(mintedOn(key), null)).resolves.toBeNull();
        info.mockRestore();
    });
});
