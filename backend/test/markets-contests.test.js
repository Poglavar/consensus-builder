// Contests group a city's published agreements by the overlapping ground their designs take (among
// agreements sharing a qualified input parcel) and put each minted agreement's market beside it
// (markets/contests.js); these tests pin the market subject (the PDA of the agreement's sponsor and
// CID), the grouping, the entry states, the ordering and the public shape GET /markets serves.
import { describe, expect, it } from 'vitest';
import {
    HR_CADASTRE,
    buildContests,
    contestId,
    designCidsToCompare,
    groupByLand,
    landOverlap,
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
const market = (address, qYes, qNo, resolved = false, outcome = 0, chainStatus = 'active', deadline = LATER, b = 100_000_000n) => ({ sponsor: SPONSOR, lenses: [STRANGER], chainStatus, deadline, markets: [{ address, market: { kind: 0, b, qYes, qNo, seed: 69_314_720n, closesAt: Math.floor(Date.parse(deadline || LATER) / 1000),
    graceSeconds: 0, maxPosition: 0n, paidOut: 0n, creator: SPONSOR, resolved, outcome } }] });
const cidsOf = contest => contest.agreements.map(entry => entry.cid);
// Designs whose ground overlaps, for tests about something else than the grouping.
const everywhere = () => true;

// A design site: a rectangle given in metres east and north of a point in Zagreb.
const M_LNG = 1 / (111320 * Math.cos(45.8 * Math.PI / 180));
const M_LAT = 1 / 110540;
const box = (x0, y0, x1, y1) => {
    const [w, s, e, n] = [15.97 + x0 * M_LNG, 45.8 + y0 * M_LAT, 15.97 + x1 * M_LNG, 45.8 + y1 * M_LAT];
    return { type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] };
};
const land = sites => new Map(Object.entries(sites).map(([cid, site]) => [cid, site.type ? { site, toleranceM: 0 } : site]));
const groupCids = groups => groups.map(group => group.map(entry => entry.cid).sort()).sort((a, b) => a[0].localeCompare(b[0]));

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
    // One large parcel (state land, say) under every agreement here, with designs anywhere on it.
    const onGov = (cid, designCids) => agreement({ cid, inputParcelIds: ['GOV'], designCids });

    it('keeps agreements on one large parcel apart when their designs stand apart', () => {
        const overlaps = landOverlap(land({ 'D-north': box(0, 0, 20, 20), 'D-south': box(0, 120, 20, 140) }));
        expect(groupCids(groupByLand([onGov('north', ['D-north']), onGov('south', ['D-south'])], overlaps)))
            .toEqual([['north'], ['south']]);
    });

    it('joins agreements whose design sites overlap, and those sharing a design', () => {
        const overlaps = landOverlap(land({ 'D-a': box(0, 0, 20, 20), 'D-b': box(10, 10, 30, 30), 'D-far': box(200, 0, 220, 20) }));
        expect(groupCids(groupByLand([
            onGov('a', ['D-a']), onGov('b', ['D-far', 'D-b']), onGov('far', ['D-far']), onGov('lone', ['D-lone'])
        ], overlaps))).toEqual([['a', 'b', 'far'], ['lone']]);
        // A design whose site is not known reaches nothing, but two agreements over it are one contest.
        expect(groupCids(groupByLand([onGov('x', ['D-unknown']), onGov('y', ['D-unknown']), onGov('z', ['D-other'])], overlaps)))
            .toEqual([['x', 'y'], ['z']]);
    });

    it('joins transitively: A overlaps B and B overlaps C is one contest, though A and C stand apart', () => {
        const overlaps = landOverlap(land({ 'D-a': box(0, 0, 20, 20), 'D-b': box(15, 0, 35, 20), 'D-c': box(30, 0, 50, 20) }));
        expect(groupCids(groupByLand([onGov('a', ['D-a']), onGov('b', ['D-b']), onGov('c', ['D-c'])], overlaps))).toEqual([['a', 'b', 'c']]);
        // Without the middle one the ends are two contests, in either arrival order.
        expect(groupCids(groupByLand([onGov('c', ['D-c']), onGov('a', ['D-a'])], overlaps))).toEqual([['a'], ['c']]);
        expect(groupCids(groupByLand([onGov('c', ['D-c']), onGov('b', ['D-b']), onGov('a', ['D-a'])], overlaps))).toEqual([['a', 'b', 'c']]);
    });

    it('takes "overlap" by the shared ground rule: edge contact is apart, and a strip narrower than a design\'s tolerance is apart', () => {
        const pair = sites => groupCids(groupByLand([onGov('a', ['D-a']), onGov('b', ['D-b'])], landOverlap(land(sites))));
        expect(pair({ 'D-a': box(0, 0, 20, 20), 'D-b': box(20, 0, 40, 20) })).toEqual([['a'], ['b']]);
        // A 5 cm strip is ground at the default noise, but not for a design allowed 10 cm.
        expect(pair({ 'D-a': box(0, 0, 20, 20), 'D-b': box(19.95, 0, 40, 20) })).toEqual([['a', 'b']]);
        expect(pair({ 'D-a': box(0, 0, 20, 20), 'D-b': { site: box(19.95, 0, 40, 20), toleranceM: 0.1 } })).toEqual([['a'], ['b']]);
    });

    it('compares only agreements sharing a qualified parcel: overlapping designs on different parcels stay apart', () => {
        const overlaps = landOverlap(land({ 'D-a': box(0, 0, 20, 20), 'D-b': box(10, 10, 30, 30) }));
        expect(groupCids(groupByLand([
            agreement({ cid: 'a', inputParcelIds: ['P1'], designCids: ['D-a'] }),
            agreement({ cid: 'b', inputParcelIds: ['P2'], designCids: ['D-b'] }),
            // Open ground only: its own contest.
            agreement({ cid: 'e', inputParcelIds: [], designCids: ['D-a'] })
        ], overlaps))).toEqual([['a'], ['b'], ['e']]);
        // Without a way to judge the ground nothing joins.
        expect(groupCids(groupByLand([onGov('a', ['D-a']), onGov('b', ['D-b'])]))).toEqual([['a'], ['b']]);
    });

    it('matches only qualified references: the same raw id from another source or an unknown one stays apart', () => {
        const rows = [
            agreement({ cid: 'hr', inputParcelIds: ['P1'] }),
            agreement({ cid: 'hr-named', inputParcelIds: ['P1'], parcelSourceId: 'hr-cadastre' }),
            agreement({ cid: 'sf', inputParcelIds: ['P1'], city: 'san_francisco' }),
            agreement({ cid: 'unknown', inputParcelIds: ['P1'], parcelSourceId: 'unknown-provider' }),
            agreement({ cid: 'unknown-too', inputParcelIds: ['P1'], parcelSourceId: 'unknown-provider' })
        ];
        expect(groupByLand(rows, everywhere).map(group => group.map(row => row.cid).sort()))
            .toEqual([['hr', 'hr-named'], ['sf'], ['unknown'], ['unknown-too']]);
    });
});

describe('designCidsToCompare', () => {
    it('lists the designs of agreements sharing a qualified parcel, and no others', () => {
        expect(designCidsToCompare([
            agreement({ cid: 'a', inputParcelIds: ['P1'], designCids: ['D-2', 'D-1'] }),
            agreement({ cid: 'b', inputParcelIds: ['P1', 'P2'], designCids: ['D-3'] }),
            agreement({ cid: 'c', inputParcelIds: ['P9'], designCids: ['D-9'] }),
            agreement({ cid: 'd', inputParcelIds: ['P1'], parcelSourceId: 'unknown-provider', designCids: ['D-x'] })
        ])).toEqual(['D-1', 'D-2', 'D-3']);
        expect(designCidsToCompare([])).toEqual([]);
    });
});

describe('contestId', () => {
    it('depends on the designs, not on which agreements happen to be in the contest', () => {
        expect(contestId(['D-2', 'D-1'])).toBe(contestId(['D-1', 'D-2']));
        expect(contestId(['D-1', 'D-1', 'D-2'])).toBe(contestId(['D-1', 'D-2']));
        expect(contestId(['D-1'])).not.toBe(contestId(['D-2']));
        expect(contestId(['D-1'])).toMatch(/^c-[0-9a-f]{12}$/);
        // Without designs the id is scoped to an agreement CID.
        expect(contestId([], 'cid-1')).not.toBe(contestId([], 'cid-2'));
        expect(contestId([], 'cid-1')).toBe(contestId([null, ''], 'cid-1'));
    });
});

describe('buildContests', () => {
    it('makes two contests of two minted agreements whose designs stand apart on one parcel, each with its own id', () => {
        const { contests, summary } = buildContests({
            city: 'zagreb', now: NOW,
            agreements: [
                minted('north', 'ACCT-N', { inputParcelIds: ['GOV'], designCids: ['D-north'] }),
                minted('south', 'ACCT-S', { inputParcelIds: ['GOV'], designCids: ['D-south'] })
            ],
            overlaps: landOverlap(land({ 'D-north': box(0, 0, 20, 20), 'D-south': box(0, 120, 20, 140) }))
        });
        expect(summary).toMatchObject({ contests: 2, agreements: 2 });
        expect(contests.map(cidsOf).sort()).toEqual([['north'], ['south']]);
        expect(contests.map(contest => contest.parcelIds)).toEqual([['GOV'], ['GOV']]);
        expect(contests[0].id).not.toBe(contests[1].id);
        expect(contests.every(contest => contest.agreements[0].contest === contest.id)).toBe(true);
    });

    it('keeps only contests with a minted agreement; an unminted rival stays beside it without a pool', () => {
        const out = buildContests({
            city: 'zagreb', now: NOW, overlaps: everywhere,
            agreements: [
                minted('minted', 'ACCT-A', { inputParcelIds: ['L1'], createdAt: '2026-10-03T00:00:00.000Z', designTitles: ['Six storeys'] }),
                agreement({ cid: 'rival', inputParcelIds: ['L1'], createdAt: '2026-10-04T00:00:00.000Z' }),
                agreement({ cid: 'nobody-minted', inputParcelIds: ['L4'] })
            ],
            markets: new Map([['ACCT-A', market('MKT-A', 250000n, 50000n)]])
        });
        expect(out).toMatchObject({ city: 'zagreb', generatedAt: '2026-10-09T00:00:00.000Z' });
        expect(out.contests.map(cidsOf)).toEqual([['minted', 'rival']]);
        expect(out.summary).toEqual({ contests: 1, agreements: 2, markets: 1, openMarkets: 1, sharesAtomic: '300000' });
        const [contest] = out.contests;
        expect(contest).toMatchObject({
            parcelIds: ['L1'], parcelRefs: [{ ...HR_CADASTRE, parcelId: 'L1' }], agreementCount: 2, mintedCount: 1, marketCount: 1,
            openMarketCount: 1, sharesAtomic: '300000', latestCreatedAt: '2026-10-04T00:00:00.000Z'
        });
        expect(contest.agreements[0]).toEqual({
            kind: 'agreement', cid: 'minted', account: 'ACCT-A', title: 'One', author: 'a', city: 'zagreb',
            status: 'active', chainStatus: 'active', deadline: LATER, createdAt: '2026-10-03T00:00:00.000Z',
            designTitles: ['Six storeys'], screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null,
            parcelIds: ['L1'], parcelRefs: [{ ...HR_CADASTRE, parcelId: 'L1' }],
            markets: [{ address: 'MKT-A', kind: 'agreement', creatorRole: 'sponsor', bettable: true, canSettle: false, model: 'lmsr', asset: 'devnet-usdc', creator: SPONSOR, b: '100000000', qYes: '250000', qNo: '50000', seed: '69314720', closesAt: Math.floor(Date.parse(LATER) / 1000), graceSeconds: 0, maxPosition: '0', paidOut: '0', resolved: false, outcome: null }],
            bettable: true, canOpenMarket: true, canSettle: false, sponsor: null, contest: contest.id
        });
        expect(contest.agreements[1]).toMatchObject({ cid: 'rival', account: null, chainStatus: null, markets: [], bettable: false, canOpenMarket: false, status: 'active' });
    });

    it('uses each execution market’s own cutoff and exposes creation independently of existing pools', () => {
        const entryOf = (input, markets = new Map()) => buildContests({ city: 'zagreb', now: NOW, agreements: [input], markets }).contests[0].agreements[0];
        const pool = new Map([['ACCT', market('MKT', 1n, 1n)]]);
        // Active and dated ahead: a pool takes bets, a missing one can be opened.
        expect(entryOf(minted('a', 'ACCT'), pool)).toMatchObject({ bettable: true, canOpenMarket: true, status: 'active' });
        expect(entryOf(minted('a', 'ACCT'))).toMatchObject({ bettable: false, canOpenMarket: true, markets: [] });
        // No deadline: still live.
        expect(entryOf(minted('a', 'ACCT', { deadline: null }), new Map([['ACCT', market('MKT', 1n, 1n, false, 0, 'active', null)]])))
            .toMatchObject({ bettable: true, deadline: null });
        // The deadline passed while the account is still Active: the agreement can no longer execute.
        expect(entryOf(minted('a', 'ACCT', { deadline: PAST }), new Map([['ACCT', market('MKT', 1n, 1n, false, 0, 'active', PAST)]])))
            .toMatchObject({ bettable: false, canOpenMarket: true, status: 'expired', chainStatus: 'active' });
        expect(entryOf(minted('a', 'ACCT', { deadline: PAST }))).toMatchObject({ canOpenMarket: true });
        // A status nobody observed is no evidence that a bet can still win.
        expect(entryOf(minted('a', 'ACCT', { chainStatus: null }), new Map([['ACCT', market('MKT', 1n, 1n, false, 0, null)]])))
            .toMatchObject({ bettable: false, canOpenMarket: false, status: 'active', chainStatus: null });
        // A terminal status is the word shown, whatever the deadline says.
        for (const chainStatus of ['executed', 'cancelled', 'expired']) {
            expect(entryOf(minted('a', 'ACCT', { chainStatus, deadline: LATER }), new Map([['ACCT', market('MKT', 1n, 1n, false, 0, chainStatus)]])))
                .toMatchObject({ status: chainStatus, chainStatus, bettable: false, canOpenMarket: true });
        }
        // A resolved pool takes no bets.
        expect(entryOf(minted('a', 'ACCT'), new Map([['ACCT', market('MKT', 1n, 1n, true, 1)]])))
            .toMatchObject({ bettable: false, markets: [{ resolved: true, outcome: 'yes' }] });
        expect(entryOf(minted('a', 'ACCT', { chainStatus: 'cancelled' }), new Map([['ACCT', market('MKT', 1n, 1n, true, 0, 'cancelled')]])))
            .toMatchObject({ markets: [{ resolved: true, outcome: 'no' }] });
    });

    it('never reports a chain status for an unminted agreement', () => {
        const { contests } = buildContests({
            city: 'zagreb', now: NOW, overlaps: everywhere,
            agreements: [minted('m', 'ACCT', { inputParcelIds: ['X'] }), agreement({ cid: 'u', inputParcelIds: ['X'], chainStatus: 'executed' })]
        });
        expect(contests[0].agreements.find(entry => entry.cid === 'u')).toMatchObject({ account: null, chainStatus: null, status: 'active' });
    });

    it('serializes pools as decimal strings so the JSON never loses a u64', () => {
        const big = (1n << 63n) + 7n;
        const out = buildContests({ city: 'zagreb', now: NOW, agreements: [minted('a', 'ACCT')], markets: new Map([['ACCT', market('MKT', big, 1n)]]) });
        expect(out.contests[0].agreements[0].markets[0].qYes).toBe(big.toString());
        expect(out.contests[0].sharesAtomic).toBe((big + 1n).toString());
        expect(out.summary.sharesAtomic).toBe((big + 1n).toString());
        expect(() => JSON.stringify(out)).not.toThrow();
    });
});

describe('row order inside a contest and of contests (the Bets sheet\'s order)', () => {
    const accounts = Array.from({ length: 9 }, (_, index) => `ACCT-${index}`);
    const input = () => ({
        city: 'zagreb', now: NOW, overlaps: everywhere,
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
            [accounts[0], market('M0', 0n, 5_000_000n, true, 0, 'cancelled')],
            [accounts[1], market('M1', 9_000_000n, 0n, true, 1, 'executed')],
            [accounts[2], market('M2', 1_000_000n, 1_000_000n, true, 0, 'expired')],
            [accounts[3], market('M3', 0n, 500_000n, true, 0, 'cancelled')],
            [accounts[4], market('M4', 10_000n, 0n, false, 0, 'active', null, 50_000_000n)],
            [accounts[5], market('M5', 1n, 0n, false, 0, 'active', LATER, 200_000_000n)],
            [accounts[6], market('M6', 0n, 0n, false, 0, 'active', SOON)],
            [accounts[7], { chainStatus: 'active', deadline: null, markets: [] }],
            [accounts[8], market('M8', 25_000n, 25_000n, false, 0, 'cancelled', null)]
        ])
    });

    it('ranks tradeable markets by funded liquidity even when a shallower market closes sooner', () => {
        const [contest] = buildContests(input()).contests;
        expect(cidsOf(contest)).toEqual([
            'open-late', 'open-soon', 'open-undated', 'settling', 'needs-market',
            'settled-bigger', 'settled-big', 'settled-mid', 'settled-small', 'not-minted'
        ]);
        expect(contest.agreements[0]).toMatchObject({ bettable: true, deadline: LATER });
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
            markets: new Map([['ACCT-X', market('MA', 90_000_000n, 1n, true, 1, 'executed')], ['ACCT-Y', market('MB', 1n, 0n)]])
        });
        expect(contests.map(contest => contest.agreements[0].cid)).toEqual(['open-tiny', 'settled-huge']);
    });
});
