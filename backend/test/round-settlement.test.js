// A developer's crowdfunding round in the settlement phase (lifecycle-actions.js): once its target is
// reached, a lens member whose wallet the runner holds (service.confirmsFundedRounds) confirms it with
// chain-actions.js confirmAsLensMember, which also confirms the target, executes and releases in its one
// transaction, so no separate confirm-funding, execute or release step is planned. Without that wallet
// the round waits for its lens, as before.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { executeSettlement, inspectSettlement } from '../agents/lifecycle-actions.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { roundConfirmingMembers } from '../agents/run.mjs';
import { createAgreementChain } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const USDC = require('../../frontend/js/solana/agreement-client.js').constants.USDC_DEVNET_MINT;
const NOW = Math.floor(Date.now() / 1000);

let chain, developer, member, MEMBER;
beforeEach(() => {
    chain = createAgreementChain();
    developer = Keypair.generate();
    member = Keypair.generate();
    MEMBER = member.publicKey.toBase58();
});

function round(seed, { lensConfirmed = [] } = {}) {
    const cid = Cid.cidOfObject({ schema: 'agreement/v1', title: seed });
    const sponsor = developer.publicKey.toBase58();
    const account = agreementAccountOf(cid, sponsor);
    chain.putAgreement(account, { cid, authority: sponsor, lenses: [MEMBER], lensThreshold: 1, lensConfirmed, payout: sponsor, fundingMint: USDC,
        requiredFunding: 5_000_000n, fundingMet: false, deadline: NOW + 3 * 86400, requiredLamports: 0n, escrowLamports: 0n, status: 0, decision: 0 });
    return { cid, account, content: { sponsor, rule: { electorate: 'investors', binding: true, lens: [MEMBER] } }, pickId: `pick-${seed}` };
}
const readers = credited => ({ readDonation: async () => ({ released: false, totalDonated: credited, totalRefunded: 0n }), readMarket: async () => null, readPosition: async () => null });

describe('a funded apartment round in the developer\'s settlement', () => {
    const inspect = (item, extra) => inspectSettlement({ connection: chain.connection, owner: developer.publicKey.toBase58(), agreement: item, nowSeconds: NOW, ...extra });

    it('plans the lens member\'s one confirmation once the target is reached', async () => {
        const item = round('reached');
        expect(await inspect(item, { memberKeys: [MEMBER], readers: readers(6_000_000n) }))
            .toMatchObject({ state: 'decidable', outcome: 'YES', steps: ['confirm-member'], member: MEMBER });
    });
    it('waits for contributions, and for its lens when the runner holds no member wallet', async () => {
        const item = round('waiting');
        expect(await inspect(item, { memberKeys: [MEMBER], readers: readers(4_000_000n) })).toMatchObject({ state: 'awaiting-contributions', steps: [] });
        expect(await inspect(item, { memberKeys: [], readers: readers(6_000_000n) })).toMatchObject({ state: 'awaiting-lens', steps: ['confirm-funding'] });
        // The member already confirmed: no second confirmation of its own.
        expect(await inspect(round('confirmed', { lensConfirmed: [MEMBER] }), { memberKeys: [MEMBER], readers: readers(6_000_000n) }))
            .toMatchObject({ steps: ['confirm-funding', 'execute', 'release-donations'] });
    });
    it('signs the confirmation with the member\'s wallet through chain-actions', async () => {
        const item = { ...round('sign'), steps: ['confirm-member'], member: MEMBER, outcome: 'YES' };
        const confirmAsLensMember = vi.fn(async () => ({ signature: 'sig', executed: true, released: true }));
        const record = await executeSettlement({ connection: chain.connection, ownerKeypair: developer, item, memberSigner: key => (key === MEMBER ? member : null),
            perform: (_action, run) => run(), checkpoint: async () => {}, adapters: { confirmAsLensMember } });
        expect(confirmAsLensMember).toHaveBeenCalledWith(expect.objectContaining({ memberKeypair: member, agreement: { cid: item.cid, content: item.content } }));
        expect(record.memberConfirmation).toEqual({ signature: 'sig', executed: true, released: true });
        await expect(executeSettlement({ connection: chain.connection, ownerKeypair: developer, item, memberSigner: () => null,
            perform: (_action, run) => run(), checkpoint: async () => {}, adapters: { confirmAsLensMember } })).rejects.toThrow(/needs lens member/);
    });
});

describe('which lens members confirm funded rounds', () => {
    it('only a lens member persona that says so and whose key file is on this host', () => {
        const personas = [
            { name: 'a', role: 'lens-member', wallet: 'A', keypairPath: '~/a.json', service: { confirmsFundedRounds: true } },
            { name: 'b', role: 'lens-member', wallet: 'B', keypairPath: '~/b.json', service: {} },
            { name: 'c', role: 'lens-member', wallet: 'C', keypairPath: '~/missing.json', service: { confirmsFundedRounds: true } },
            { name: 'd', role: 'proposer', wallet: 'D', keypairPath: '~/d.json', service: { confirmsFundedRounds: true } }
        ];
        expect(Object.keys(roundConfirmingMembers(personas, file => !file.endsWith('missing.json')))).toEqual(['A']);
    });
});
