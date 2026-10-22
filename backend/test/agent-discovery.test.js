// What the support and society agents read (agents/discovery.js): the index's agreements per city,
// de-duplicated by CID and newest first, each with the chain account its sponsor and CID derive, and the
// accounts' statuses read from the chain in batches. Only the chain's word counts: an account owned by
// another program, holding another CID or another sponsor fails the whole read and changes nothing.
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { cidOfObject } from '../cid.js';
import { AGREEMENT_PAGE, agreementSummary, discoverAgreements, isMinted, isOpen, readAgreementStatuses } from '../agents/discovery.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { selectSupportAction } from '../agents/supporter-picker.js';
import { agreementAccountBytes, agreementAccountInfo } from './fixtures/agreement-account.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sponsors = [0, 1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());
const cidOf = n => cidOfObject({ schema: 'agreement/v1', title: `Agreement ${n}` });

// One GET /agreements row (routes/agreements.js serializeAgreementRow).
function row(n, { sponsor = sponsors[n % sponsors.length], createdAt = `2026-10-${String(10 + n).padStart(2, '0')}T08:00:00.000Z`, ...extra } = {}) {
    const designCid = cidOfObject({ schema: 'design/v1', title: `Design ${n}` });
    return {
        cid: cidOf(n), city: 'zagreb', title: `Agreement ${n}`, author: `author-${n}`,
        designCids: [designCid], inputParcelIds: [`HR-1-${n}`], parcelSourceId: null,
        deadline: '2026-11-01T00:00:00.000Z', status: 'active', onchain: null, createdAt,
        content: {
            schema: 'agreement/v1', title: `Agreement ${n}`, author: `author-${n}`, sponsor, createdAt,
            designs: [{ cid: designCid, goal: 'buildings', title: `Design ${n}` }],
            rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [] }
        },
        ...extra
    };
}

describe('agreementSummary', () => {
    it('keys an agreement by its CID and derives its chain account from sponsor and CID', () => {
        const summary = agreementSummary(row(1));
        expect(summary).toMatchObject({
            cid: cidOf(1), name: 'Agreement 1', city: 'zagreb', author: 'author-1', sponsor: sponsors[1],
            account: agreementAccountOf(cidOf(1), sponsors[1]), deadline: '2026-11-01T00:00:00.000Z',
            designCids: row(1).designCids, inputParcelIds: ['HR-1-1'], chainStatus: null
        });
        // The same CID under another sponsor is another account: the PDA commits to both.
        expect(agreementSummary(row(1, { content: { ...row(1).content, sponsor: sponsors[2] } })).account)
            .not.toBe(summary.account);
    });

    it('has no account without a usable sponsor, and refuses a row without its CID', () => {
        expect(agreementSummary(row(1, { content: { ...row(1).content, sponsor: null } }))).toMatchObject({ sponsor: null, account: null });
        expect(agreementSummary(row(1, { content: { ...row(1).content, sponsor: 'not-a-wallet' } })).account).toBeNull();
        expect(() => agreementSummary({ ...row(1), cid: null })).toThrow(/missing its CID/);
        // Design CIDs come from the content when the row does not list them.
        expect(agreementSummary({ ...row(2), designCids: undefined }).designCids).toEqual(row(2).designCids);
    });
});

describe('discoverAgreements', () => {
    it('reads each city once, merges by CID and orders newest first', async () => {
        const shared = row(5);
        const index = {
            listAgreements: vi.fn(async ({ city }) => ({
                agreements: city === 'zagreb' ? [shared, row(1)] : [row(3), { ...shared, title: 'second copy' }],
                count: 2
            }))
        };
        const log = vi.fn();
        const result = await discoverAgreements({ index, cities: ['zagreb', null], log });
        expect(index.listAgreements.mock.calls.map(([args]) => args)).toEqual([
            { city: 'zagreb', limit: AGREEMENT_PAGE }, { city: null, limit: AGREEMENT_PAGE }
        ]);
        expect(result.map(item => item.cid)).toEqual([cidOf(5), cidOf(3), cidOf(1)]);
        // The first copy of a CID is the one kept.
        expect(result[0].name).toBe('Agreement 5');
        expect(log).not.toHaveBeenCalled();
    });

    it('says so when a page is cut at the index limit, never silently', async () => {
        const rows = Array.from({ length: AGREEMENT_PAGE }, (_, n) => row(n, { content: { ...row(n).content, sponsor: null } }));
        const log = vi.fn();
        const result = await discoverAgreements({ index: { listAgreements: async () => ({ agreements: rows }) }, cities: [null], log });
        expect(result).toHaveLength(AGREEMENT_PAGE);
        expect(log).toHaveBeenCalledWith(`all cities: read the newest ${AGREEMENT_PAGE} agreements (the index answers at most that many)`);
    });
});

describe('readAgreementStatuses', () => {
    const summaries = () => [row(0), row(1), row(2), row(3, { content: { ...row(3).content, sponsor: null } })].map(agreementSummary);
    const info = (summary, status, extra = {}) => agreementAccountInfo({ cid: summary.cid, authority: summary.sponsor, status, ...extra });
    function chain(byAccount) {
        return { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => byAccount.get(key.toBase58()) ?? null)) };
    }

    it('reads the minted accounts in batches and takes the status from the chain, not the index', async () => {
        const agreements = summaries();
        const connection = chain(new Map([
            [agreements[0].account, info(agreements[0], 1)],
            [agreements[1].account, info(agreements[1], 0)]
        ]));
        const out = await readAgreementStatuses(agreements, connection, { env: { SOLANA_RPC_MAX_ACCOUNTS: '2' } });
        expect(out).toBe(agreements);
        // Three accounts in batches of two; the agreement without a sponsor has none to read.
        expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([2, 1]);
        expect(connection.getMultipleAccountsInfo.mock.calls.flatMap(([keys]) => keys.map(key => key.toBase58())))
            .toEqual(agreements.slice(0, 3).map(item => item.account));
        expect(agreements.map(item => item.chainStatus)).toEqual(['executed', 'active', null, null]);
        expect(agreements.map(isMinted)).toEqual([true, true, false, false]);
        // The index still said active for the executed one: a supporter never picks it.
        const choice = selectSupportAction({ day: '2026-10-22', persona: { name: 'supporter-01' }, agreements: [agreements[0]], now: NOW });
        expect(choice.selected).toBeNull();
    });

    it.each([
        ['owned by another program', summary => ({ ...agreementAccountInfo({ cid: summary.cid, authority: summary.sponsor }), owner: PublicKey.default }), /not owned by the agreement program/],
        ['not an Agreement account', summary => ({ ...agreementAccountInfo({ cid: summary.cid, authority: summary.sponsor }), data: Buffer.alloc(296) }), /is not an Agreement account/],
        ['holding another CID', summary => agreementAccountInfo({ cid: cidOf(99), authority: summary.sponsor }), /holds bafkrei/],
        ['holding another sponsor', summary => agreementAccountInfo({ cid: summary.cid, authority: sponsors[3] }), new RegExp(`holds .* of ${sponsors[3]}`)],
        ['truncated', summary => ({ ...agreementAccountInfo({ cid: summary.cid, authority: summary.sponsor }), data: agreementAccountBytes({ cid: summary.cid, authority: summary.sponsor }).subarray(0, 140) }), /truncated/]
    ])('fails the whole read on an account %s and changes nothing', async (_label, bad, message) => {
        const agreements = summaries();
        const connection = chain(new Map([
            [agreements[0].account, info(agreements[0], 0)],
            [agreements[1].account, bad(agreements[1])]
        ]));
        await expect(readAgreementStatuses(agreements, connection)).rejects.toThrow(message);
        expect(agreements.map(item => item.chainStatus)).toEqual([null, null, null, null]);
    });

    it('propagates an RPC failure and calls nothing for agreements without accounts', async () => {
        await expect(readAgreementStatuses(summaries(), { getMultipleAccountsInfo: async () => { throw new Error('RPC offline'); } }))
            .rejects.toThrow('RPC offline');
        const connection = { getMultipleAccountsInfo: vi.fn() };
        const unminted = [agreementSummary(row(3, { content: { ...row(3).content, sponsor: null } }))];
        expect(await readAgreementStatuses(unminted, connection)).toBe(unminted);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });
});

describe('isOpen', () => {
    it('is Active on chain and before the deadline (or with none)', () => {
        const base = { account: 'account', chainStatus: 'active', deadline: '2026-10-22T12:00:01Z' };
        expect(isOpen(base, NOW)).toBe(true);
        expect(isOpen({ ...base, deadline: null }, NOW)).toBe(true);
        expect(isOpen({ ...base, deadline: '2026-10-22T12:00:00Z' }, NOW)).toBe(false);
        for (const chainStatus of ['executed', 'cancelled', 'expired', null]) expect(isOpen({ ...base, chainStatus }, NOW)).toBe(false);
    });
});
