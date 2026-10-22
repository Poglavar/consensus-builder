// Contests group a city's published agreements by the qualified input parcels they share and put each
// minted agreement's market beside it (markets/contests.js); these tests pin the market subject (the
// PDA of the agreement's sponsor and CID), the grouping, the entry states, the ordering and the public
// shape GET /markets serves.
import { describe, expect, it } from 'vitest';
import {
    HR_CADASTRE,
    buildContests,
    contestId,
    groupByLand,
    normalizeParcelIds,
    parcelRefsOf,
    parcelSourceOf,
    subjectAccountOf
} from '../markets/contests.js';
import { agreementAccountOf } from '../agreements/onchain.js';
import { cidOfObject } from '../cid.js';

const SPONSOR = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const STRANGER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const CID = cidOfObject({ schema: 'agreement/v1', title: 'Riverside deal' });
const NOW = new Date('2026-10-09T00:00:00Z');
const SOON = '2026-10-20T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';

// An agreement as routes/markets.js rowToAgreement hands it over; `account` set means minted.
const agreement = (overrides = {}) => ({
    cid: 'cid-1', city: 'zagreb', title: 'One', author: 'a', designTitles: [], inputParcelIds: ['P1'], parcelSourceId: null,
    deadline: LATER, createdAt: '2026-10-01T00:00:00.000Z', screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null,
    account: null, chainStatus: null, ...overrides
});
const minted = (cid, account, overrides = {}) => agreement({ cid, account, chainStatus: 'active', ...overrides });
const market = (address, yesPool, noPool, resolved = false, outcome = 0) => ({ address, market: { yesPool, noPool, resolved, outcome } });
const cidsOf = contest => contest.agreements.map(entry => entry.cid);

describe('subjectAccountOf', () => {
    const account = agreementAccountOf(CID, SPONSOR);
    const pointer = { chain: 'solana', cluster: 'devnet', account };

    it('is the indexed account only when it is the PDA of the agreement\'s sponsor and CID', () => {
        expect(subjectAccountOf({ cid: CID, sponsor: SPONSOR, onchain: pointer })).toBe(account);
        // Another wallet's account for the same CID can never record the lens decision.
        const squatted = agreementAccountOf(CID, STRANGER);
        expect(squatted).not.toBe(account);
        expect(subjectAccountOf({ cid: CID, sponsor: SPONSOR, onchain: { ...pointer, account: squatted } })).toBeNull();
        expect(subjectAccountOf({ cid: cidOfObject({ other: true }), sponsor: SPONSOR, onchain: pointer })).toBeNull();
    });

    it('needs a devnet Solana pointer and a sponsor wallet', () => {
        for (const onchain of [null, undefined, 'x', { ...pointer, chain: 'evm' }, { ...pointer, cluster: 'mainnet-beta' }, { ...pointer, account: null }]) {
            expect(subjectAccountOf({ cid: CID, sponsor: SPONSOR, onchain })).toBeNull();
        }
        for (const sponsor of [null, undefined, '', 'not-a-wallet']) expect(subjectAccountOf({ cid: CID, sponsor, onchain: pointer })).toBeNull();
        expect(subjectAccountOf()).toBeNull();
    });
});

describe('parcelSourceOf and parcelRefsOf', () => {
    it('takes the named source, else the city\'s default catalogue source, else the Croatian cadastre', () => {
        expect(parcelSourceOf({ parcelSourceId: 'hr-cadastre' })).toEqual(HR_CADASTRE);
        expect(parcelSourceOf({ city: 'san_francisco' })).toEqual({ sourceId: 'us-ca-sf-datasf-active-parcels', snapshotId: null });
        expect(parcelSourceOf({ city: 'london' })).toEqual({ sourceId: 'gb-hmlr-browser-v1', snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(parcelSourceOf({ city: 'zagreb' })).toEqual(HR_CADASTRE);
        // An unknown named source qualifies nothing.
        expect(parcelSourceOf({ city: 'zagreb', parcelSourceId: 'unknown-provider' })).toBeNull();
    });

    it('qualifies each normalized input parcel with that source', () => {
        expect(parcelRefsOf(agreement({ inputParcelIds: [' P2 ', 'P1', 'P1', ''] }))).toEqual([
            { ...HR_CADASTRE, parcelId: 'P1' }, { ...HR_CADASTRE, parcelId: 'P2' }
        ]);
        expect(parcelRefsOf(agreement({ parcelSourceId: 'unknown-provider' }))).toEqual([]);
        expect(normalizeParcelIds([' P1 ', 'P1', '', null, 'P0'])).toEqual(['P0', 'P1']);
    });
});

describe('groupByLand', () => {
    it('joins agreements transitively through shared parcels and keeps the rest apart', () => {
        const groups = groupByLand([
            agreement({ cid: 'a', inputParcelIds: ['P1', 'P2'] }),
            agreement({ cid: 'b', inputParcelIds: ['P2', 'P3'] }),
            agreement({ cid: 'c', inputParcelIds: ['P3'] }),
            agreement({ cid: 'd', inputParcelIds: ['P9'] }),
            // Open ground only: its own contest.
            agreement({ cid: 'e', inputParcelIds: [] })
        ]);
        expect(groups.map(group => group.map(entry => entry.cid).sort())).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
    });

    it('matches only qualified references: the same raw id from another source or an unknown one stays apart', () => {
        const rows = [
            agreement({ cid: 'hr', inputParcelIds: ['P1'] }),
            agreement({ cid: 'hr-named', inputParcelIds: ['P1'], parcelSourceId: 'hr-cadastre' }),
            agreement({ cid: 'sf', inputParcelIds: ['P1'], city: 'san_francisco' }),
            agreement({ cid: 'unknown', inputParcelIds: ['P1'], parcelSourceId: 'unknown-provider' }),
            agreement({ cid: 'unknown-too', inputParcelIds: ['P1'], parcelSourceId: 'unknown-provider' })
        ];
        expect(groupByLand(rows).map(group => group.map(row => row.cid).sort()))
            .toEqual([['hr', 'hr-named'], ['sf'], ['unknown'], ['unknown-too']]);
    });
});

describe('contestId', () => {
    it('depends on the land, not on which agreements happen to be in the contest', () => {
        const p1 = { sourceId: 'hr-cadastre', snapshotId: null, parcelId: 'P1' };
        const p2 = { sourceId: 'hr-cadastre', snapshotId: null, parcelId: 'P2' };
        expect(contestId([p2, p1])).toBe(contestId([p1, p2]));
        expect(contestId([p1, p1, p2])).toBe(contestId([p1, p2]));
        expect(contestId([p1])).not.toBe(contestId([p2]));
        expect(contestId([p1])).not.toBe(contestId([{ ...p1, snapshotId: '2026' }]));
        expect(contestId([p1])).toMatch(/^c-[0-9a-f]{12}$/);
        // Without qualified land the id is scoped to an agreement CID.
        expect(contestId([], 'cid-1')).not.toBe(contestId([], 'cid-2'));
        expect(contestId([], 'cid-1')).toBe(contestId(['not a ref'], 'cid-1'));
    });
});

describe('buildContests', () => {
    it('keeps only contests with a minted agreement; an unminted rival stays beside it without a pool', () => {
        const out = buildContests({
            city: 'zagreb', now: NOW,
            agreements: [
                minted('minted', 'ACCT-A', { inputParcelIds: ['L1'], createdAt: '2026-10-03T00:00:00.000Z', designTitles: ['Six storeys'] }),
                agreement({ cid: 'rival', inputParcelIds: ['L1'], createdAt: '2026-10-04T00:00:00.000Z' }),
                agreement({ cid: 'nobody-minted', inputParcelIds: ['L4'] })
            ],
            markets: new Map([['ACCT-A', market('MKT-A', 250000n, 50000n)]])
        });
        expect(out).toMatchObject({ city: 'zagreb', generatedAt: '2026-10-09T00:00:00.000Z' });
        expect(out.contests.map(cidsOf)).toEqual([['minted', 'rival']]);
        expect(out.summary).toEqual({ contests: 1, agreements: 2, markets: 1, openMarkets: 1, poolAtomic: '300000' });
        const [contest] = out.contests;
        expect(contest).toMatchObject({
            parcelIds: ['L1'], parcelRefs: [{ ...HR_CADASTRE, parcelId: 'L1' }], agreementCount: 2, mintedCount: 1, marketCount: 1,
            openMarketCount: 1, poolAtomic: '300000', latestCreatedAt: '2026-10-04T00:00:00.000Z'
        });
        expect(contest.agreements[0]).toEqual({
            kind: 'agreement', cid: 'minted', account: 'ACCT-A', title: 'One', author: 'a', city: 'zagreb',
            status: 'active', chainStatus: 'active', deadline: LATER, createdAt: '2026-10-03T00:00:00.000Z',
            designTitles: ['Six storeys'], screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null,
            parcelIds: ['L1'], parcelRefs: [{ ...HR_CADASTRE, parcelId: 'L1' }],
            market: { address: 'MKT-A', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null },
            bettable: true, canOpenMarket: false, contest: contest.id
        });
        expect(contest.agreements[1]).toMatchObject({ cid: 'rival', account: null, chainStatus: null, market: null, bettable: false, canOpenMarket: false, status: 'active' });
    });

    it('takes bets and opens pools only while the account is Active on chain and the deadline lies ahead', () => {
        const entryOf = (input, markets = new Map()) => buildContests({ city: 'zagreb', now: NOW, agreements: [input], markets }).contests[0].agreements[0];
        const pool = new Map([['ACCT', market('MKT', 1n, 1n)]]);
        // Active and dated ahead: a pool takes bets, a missing one can be opened.
        expect(entryOf(minted('a', 'ACCT'), pool)).toMatchObject({ bettable: true, canOpenMarket: false, status: 'active' });
        expect(entryOf(minted('a', 'ACCT'))).toMatchObject({ bettable: false, canOpenMarket: true, market: null });
        // No deadline: still live.
        expect(entryOf(minted('a', 'ACCT', { deadline: null }), pool)).toMatchObject({ bettable: true, deadline: null });
        // The deadline passed while the account is still Active: the agreement can no longer execute.
        expect(entryOf(minted('a', 'ACCT', { deadline: PAST }), pool)).toMatchObject({ bettable: false, canOpenMarket: false, status: 'expired', chainStatus: 'active' });
        expect(entryOf(minted('a', 'ACCT', { deadline: PAST }))).toMatchObject({ canOpenMarket: false });
        // A status nobody observed is no evidence that a bet can still win.
        expect(entryOf(minted('a', 'ACCT', { chainStatus: null }), pool)).toMatchObject({ bettable: false, canOpenMarket: false, status: 'active' });
        // A terminal status is the word shown, whatever the deadline says.
        for (const chainStatus of ['executed', 'cancelled', 'expired']) {
            expect(entryOf(minted('a', 'ACCT', { chainStatus, deadline: LATER }), pool)).toMatchObject({ status: chainStatus, chainStatus, bettable: false, canOpenMarket: false });
        }
        // A resolved pool takes no bets.
        expect(entryOf(minted('a', 'ACCT'), new Map([['ACCT', market('MKT', 1n, 1n, true, 1)]])))
            .toMatchObject({ bettable: false, market: { resolved: true, outcome: 'yes' } });
        expect(entryOf(minted('a', 'ACCT', { chainStatus: 'cancelled' }), new Map([['ACCT', market('MKT', 1n, 1n, true, 0)]])))
            .toMatchObject({ market: { resolved: true, outcome: 'no' } });
    });

    it('never reports a chain status for an unminted agreement', () => {
        const { contests } = buildContests({
            city: 'zagreb', now: NOW,
            agreements: [minted('m', 'ACCT', { inputParcelIds: ['X'] }), agreement({ cid: 'u', inputParcelIds: ['X'], chainStatus: 'executed' })]
        });
        expect(contests[0].agreements.find(entry => entry.cid === 'u')).toMatchObject({ account: null, chainStatus: null, status: 'active' });
    });

    it('serializes pools as decimal strings so the JSON never loses a u64', () => {
        const big = (1n << 63n) + 7n;
        const out = buildContests({ city: 'zagreb', now: NOW, agreements: [minted('a', 'ACCT')], markets: new Map([['ACCT', market('MKT', big, 1n)]]) });
        expect(out.contests[0].agreements[0].market.yesPool).toBe(big.toString());
        expect(out.contests[0].poolAtomic).toBe((big + 1n).toString());
        expect(out.summary.poolAtomic).toBe((big + 1n).toString());
        expect(() => JSON.stringify(out)).not.toThrow();
    });
});

describe('row order inside a contest and of contests (the Bets sheet\'s order)', () => {
    const accounts = Array.from({ length: 9 }, (_, index) => `ACCT-${index}`);
    const input = () => ({
        city: 'zagreb', now: NOW,
        agreements: [
            // Four settled pools, the biggest on the land.
            minted('settled-big', accounts[0], { inputParcelIds: ['R1'], chainStatus: 'cancelled' }),
            minted('settled-bigger', accounts[1], { inputParcelIds: ['R1'], chainStatus: 'executed' }),
            minted('settled-mid', accounts[2], { inputParcelIds: ['R1'], chainStatus: 'expired' }),
            minted('settled-small', accounts[3], { inputParcelIds: ['R1'], chainStatus: 'cancelled' }),
            // Rows still in play, with small pools or none.
            minted('open-undated', accounts[4], { inputParcelIds: ['R1'], deadline: null }),
            minted('open-late', accounts[5], { inputParcelIds: ['R1'], deadline: LATER }),
            minted('open-soon', accounts[6], { inputParcelIds: ['R1'], deadline: SOON }),
            minted('needs-market', accounts[7], { inputParcelIds: ['R1'], deadline: null }),
            minted('settling', accounts[8], { inputParcelIds: ['R1'], chainStatus: 'cancelled', deadline: null }),
            agreement({ cid: 'not-minted', inputParcelIds: ['R1'], createdAt: '2026-10-03T00:00:00.000Z' })
        ],
        markets: new Map([
            [accounts[0], market('M0', 0n, 5_000_000n, true, 0)],
            [accounts[1], market('M1', 9_000_000n, 0n, true, 1)],
            [accounts[2], market('M2', 1_000_000n, 1_000_000n, true, 0)],
            [accounts[3], market('M3', 0n, 500_000n, true, 0)],
            [accounts[4], market('M4', 10_000n, 0n)],
            [accounts[5], market('M5', 1n, 0n)],
            [accounts[6], market('M6', 0n, 0n)],
            [accounts[7], { address: 'M7', market: null }],
            [accounts[8], market('M8', 25_000n, 25_000n)]
        ])
    });

    it('puts rows in play first, the soonest deadline leading, and settled pools after them however big', () => {
        const [contest] = buildContests(input()).contests;
        expect(cidsOf(contest)).toEqual([
            'open-soon', 'open-late',                          // in play, dated: soonest deadline first
            'settling', 'open-undated', 'needs-market',        // in play, no deadline: bigger pool first
            'settled-bigger', 'settled-big', 'settled-mid', 'settled-small', // settled: bigger pool first
            'not-minted'                                       // nothing to do
        ]);
        expect(contest.agreements[0]).toMatchObject({ bettable: true, deadline: SOON });
        expect(contest).toMatchObject({ agreementCount: 10, mintedCount: 9, marketCount: 8, openMarketCount: 3 });
    });

    it('comes out in the same order from any arrival order', () => {
        const reversed = input();
        reversed.agreements.reverse();
        expect(cidsOf(buildContests(reversed).contests[0])).toEqual(cidsOf(buildContests(input()).contests[0]));
    });

    it('never lets a contest of settled pools lead one where a bet can go in', () => {
        const { contests } = buildContests({
            city: 'zagreb', now: NOW,
            agreements: [
                minted('settled-huge', 'ACCT-X', { inputParcelIds: ['X1'], chainStatus: 'executed' }),
                minted('open-tiny', 'ACCT-Y', { inputParcelIds: ['Y1'] })
            ],
            markets: new Map([['ACCT-X', market('MA', 90_000_000n, 1n, true, 1)], ['ACCT-Y', market('MB', 1n, 0n)]])
        });
        expect(contests.map(contest => contest.agreements[0].cid)).toEqual(['open-tiny', 'settled-huge']);
    });
});
