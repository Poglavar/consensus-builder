// The agent's EVM agreement mint (agents/evm-agreement-minter.js) over a fake Agreement contract that
// keeps records like Agreement.sol: create with the escrow as its value, fund the shortfall on a rerun,
// sign nothing when the escrow already holds it, and refuse other terms, an own lens or a refusal the
// simulation names, before anything is sent.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { mintEvmAgreement } from '../agents/evm-agreement-minter.js';

const require = createRequire(import.meta.url);
const EvmAgreement = require('../../frontend/js/chain/evm-agreement.js');

const SPONSOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const LENS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const CONTRACT = '0xe9bd361f00CDE963659a81c8e4F6b21d696f9302';
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const NOW = 1_790_000_000;
const DEADLINE = '2099-01-01T00:00:00.000Z';
const KEY = EvmAgreement.keyOf(SPONSOR, CID, ethers);

// A fake Agreement contract: records by key, every method with a staticCall, sent transactions logged.
function fakeContract({ refuse = null } = {}) {
    const records = new Map();
    const sent = [];
    const recordOf = key => records.get(key);
    const methods = {
        create(cid, lens, deadline, openGround, requiredWei, payout, overrides = {}) {
            if (refuse === 'create') throw Object.assign(new Error('reverted'), { revert: { name: 'InvalidDeadline', args: [] } });
            const key = EvmAgreement.keyOf(SPONSOR, cid, ethers);
            if (records.has(key)) throw Object.assign(new Error('reverted'), { revert: { name: 'AgreementExists', args: [] } });
            return () => records.set(key, { sponsor: SPONSOR, lens, payout, deadline: BigInt(deadline), createdAt: BigInt(NOW), requiredWei,
                escrowWei: overrides.value || 0n, status: 0, openGround, decision: 0, decisionAttestedAt: 0n, decisionObservedAt: 0n,
                decisionAttestation: ethers.ZeroHash, decisionHash: ethers.ZeroHash, executedAt: 0n, cid });
        },
        fund(key, overrides = {}) {
            const record = recordOf(key);
            if (!overrides.value) throw Object.assign(new Error('reverted'), { revert: { name: 'NothingToFund', args: [] } });
            return () => { record.escrowWei += overrides.value; };
        }
    };
    const contract = {
        interface: new ethers.Interface(EvmAgreement.AGREEMENT_ABI),
        exists: async key => records.has(key),
        get: async key => ({ ...recordOf(key) }),
        records,
        sent
    };
    for (const [name, prepare] of Object.entries(methods)) {
        contract[name] = async (...args) => {
            const apply = prepare(...args);
            apply();
            const hash = `0x${String(sent.length + 1).padStart(64, '0')}`;
            sent.push({ method: name, args, hash });
            return { hash, wait: async () => ({ status: 1 }) };
        };
        contract[name].staticCall = async (...args) => { prepare(...args); };
    }
    return contract;
}

const signerOf = contract => ({ contract, chainId: '84532', address: CONTRACT, wallet: SPONSOR });

describe('mintEvmAgreement', () => {
    it('creates the agreement with the escrow as its value, then signs nothing on a rerun', async () => {
        const contract = fakeContract();
        const minted = await mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS.toLowerCase(), deadline: DEADLINE, wei: '5000', openGround: true, nowSeconds: NOW });
        expect(contract.sent).toHaveLength(1);
        const [{ method, args }] = contract.sent;
        expect(method).toBe('create');
        expect(args.slice(0, 6)).toEqual([CID, LENS, Math.floor(Date.parse(DEADLINE) / 1000), true, 5000n, SPONSOR]);
        expect(args[6]).toEqual({ value: 5000n });
        expect(minted).toMatchObject({ chainId: '84532', contract: CONTRACT, account: KEY, created: true, signature: contract.sent[0].hash,
            createSignature: contract.sent[0].hash, fundedWei: '5000', requiredWei: '5000', escrowWei: '5000', status: 'Active' });
        expect(minted.explorerUrl).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/);

        const again = await mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS, deadline: DEADLINE, wei: '5000', nowSeconds: NOW });
        expect(contract.sent).toHaveLength(1);
        expect(again).toMatchObject({ account: KEY, created: false, signature: null, createSignature: null, fundedWei: '0', escrowWei: '5000' });
    });

    it('funds only the shortfall of an existing agreement with the same terms', async () => {
        const contract = fakeContract();
        await mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS, deadline: DEADLINE, wei: '5000', nowSeconds: NOW });
        contract.records.get(KEY).escrowWei = 2000n;
        const topped = await mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS, deadline: DEADLINE, wei: '5000', nowSeconds: NOW });
        expect(contract.sent.map(item => item.method)).toEqual(['create', 'fund']);
        expect(contract.sent[1].args).toEqual([KEY, { value: 3000n }]);
        expect(topped).toMatchObject({ created: false, signature: contract.sent[1].hash, createSignature: null, fundedWei: '3000', escrowWei: '5000' });
    });

    it('refuses other terms, its own lens, a past deadline and a refusal the simulation names, signing nothing', async () => {
        const contract = fakeContract();
        await mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS, deadline: DEADLINE, wei: '5000', nowSeconds: NOW });
        await expect(mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: LENS, deadline: DEADLINE, wei: '9000', nowSeconds: NOW }))
            .rejects.toMatchObject({ code: 'terms-differ', message: expect.stringMatching(/required wei 5000/) });
        await expect(mintEvmAgreement({ signer: signerOf(contract), cid: CID, lens: SPONSOR, wei: '0', nowSeconds: NOW }))
            .rejects.toMatchObject({ code: 'own-lens' });
        await expect(mintEvmAgreement({ signer: signerOf(fakeContract()), cid: CID, lens: LENS, deadline: '2020-01-01T00:00:00Z', wei: '0', nowSeconds: NOW }))
            .rejects.toMatchObject({ code: 'deadline-passed' });
        const refusing = fakeContract({ refuse: 'create' });
        await expect(mintEvmAgreement({ signer: signerOf(refusing), cid: CID, lens: LENS, wei: '0', nowSeconds: NOW }))
            .rejects.toMatchObject({ code: 'simulation-failed', reason: 'InvalidDeadline' });
        expect(refusing.sent).toEqual([]);
        expect(contract.sent).toHaveLength(1);
    });
});
