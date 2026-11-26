// The local MCP's signed chain actions that mirror what a person does with a wallet in the app:
// each reaches the shared node adapter with the agent's key, behind UGT_MCP_LIVE and confirm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';

let dir, keypair, keyFile;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-chain-actions-'));
    keypair = Keypair.generate();
    keyFile = join(dir, 'wallet.json');
    writeFileSync(keyFile, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNT = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();
function tools(dependencies, env = {}) {
    return createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile, UGT_MCP_LIVE: '1', ...env },
        fetchImpl: vi.fn(() => { throw new Error('no API in this test'); }), createConnection: () => ({}), dependencies });
}

describe('local MCP chain actions', () => {
    it('takes back a resolved market\'s seed as its opener, behind live mode and confirm', async () => {
        const reclaimAgreementMarketSeed = vi.fn(async () => ({ replayed: false, signature: 'reclaim-fixture', amount: '988001000' }));
        const live = tools({ reclaimAgreementMarketSeed });
        expect(await live.reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET, confirm: true }))
            .toEqual({ replayed: false, signature: 'reclaim-fixture', amount: '988001000' });
        expect(reclaimAgreementMarketSeed).toHaveBeenCalledWith(expect.objectContaining({ subject: ACCOUNT, marketAddress: MARKET }));
        expect(reclaimAgreementMarketSeed.mock.calls[0][0].creatorKeypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
        await expect(live.reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET })).rejects.toThrow(/confirm must be true/);
        await expect(tools({ reclaimAgreementMarketSeed }, { UGT_MCP_LIVE: '' }).reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET, confirm: true }))
            .rejects.toThrow(/live actions are disabled/);
        expect(reclaimAgreementMarketSeed).toHaveBeenCalledTimes(1);
    });
});
