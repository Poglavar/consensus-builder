// An agent discovers an agreement, stakes and claims with only RPC; the UGT API is unreachable.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const codec = require('../../frontend/js/solana/agreement-client.js');
describe('local MCP without the API', () => {
    it('uses chain identities for discovery, staking and claiming, with the usual cap', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mcp-chain-'));
        try {
            const keypair = Keypair.generate(), wallet = keypair.publicKey.toBase58(), cid = cidOfObject({ agreement: 'test' });
            const address = agreementAccountOf(cid, wallet), keyFile = join(dir, 'wallet.json');
            writeFileSync(keyFile, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
            const bytes = Buffer.alloc(codec.constants.AGREEMENT_ACCOUNT_SPACE);
            Buffer.from(codec.ACCOUNT_DISCRIMINATORS.Agreement).copy(bytes);
            for (const offset of [8, 40, 72]) keypair.publicKey.toBuffer().copy(bytes, offset);
            bytes.writeUInt32LE(cid.length, 228); bytes.write(cid, 232);
            const connection = { getProgramAccounts: vi.fn(async () => [{ pubkey: new PublicKey(address), account: { data: bytes } }]) };
            const fetchImpl = vi.fn(() => { throw new Error('UGT API is offline'); });
            const buyAgreementShares = vi.fn(async () => ({ signature: 'stake-fixture' }));
            const claimAgreementMarket = vi.fn(async () => ({ signature: 'claim-fixture' }));
            const tools = createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile, UGT_MCP_LIVE: '1' }, fetchImpl,
                createConnection: () => connection, dependencies: { buyAgreementShares, claimAgreementMarket,
                    readAgreementAccount: vi.fn(async () => ({ address, cid, status: 'Active', deadline: 0 })) } });
            const found = await tools.listChainAgreements();
            expect(found.agreements[0]).toMatchObject({ cid, address, authority: wallet });
            await tools.betOnAccount({ agreementAccount: address, side: 'yes', amountUsdc: '0.05', confirm: true });
            await tools.claim({ agreementAccount: address, side: 'yes', confirm: true });
            expect(buyAgreementShares).toHaveBeenCalledWith(expect.objectContaining({ subject: address, amountAtomic: 50000n }));
            expect(claimAgreementMarket).toHaveBeenCalledWith(expect.objectContaining({ subject: address }));
            await expect(tools.betOnAccount({ agreementAccount: address, side: 'yes', amountUsdc: '1', confirm: true })).rejects.toThrow(/exceeds/);
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(await tools.capabilities()).toMatchObject({ mode: 'local', next: { tool: 'ugt_help' } });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
