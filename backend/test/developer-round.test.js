// developer-round.js and the modules it composes: a developer persona plans a crowdfunding round on a
// configured plan from the apartments the shared planner lays out (apartment-units.js), never offers a
// unit twice, stops at its open-round limit, makes every third round a plain contribution round, and
// builds agreement/v1 content the crowdfunding rules accept, with a PDF drawing per unit
// (apartment-drawing.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { chooseUnits, developerConfig, planRound, roundAgreement, roundAmounts, roundSignedActions } from '../agents/developer-round.js';
import { designApartments } from '../agents/apartment-units.js';
import { apartmentDrawingPdf } from '../agents/apartment-drawing.js';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');

const M = Math.PI * 6378137 / 180, LAT = 43.8, LNG = 77.09, MX = M * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M];
const block = (cx, w, h) => turf.polygon([[[cx - w / 2, -h / 2], [cx + w / 2, -h / 2], [cx + w / 2, h / 2], [cx - w / 2, h / 2], [cx - w / 2, -h / 2]].map(lngLat)],
    { use: 'residential', height: 15, floors: 5, type: 'proposedBuildingSingle' });
const design = (title, feature) => ({ schema: 'design/v1', goal: 'single', city: 'alatau', title, geometry: { buildings: [feature] }, buildingProposal: {} });
const designs = [design('Block A', block(0, 24, 12)), design('Block B', block(60, 30, 12))].map(content => ({ cid: Cid.cidOfObject(content), content }));
const plan = { schema: 'plan/v1', title: 'Test district', designCids: designs.map(row => row.cid), view: { at: '43.8,77.09,16', city: 'alatau', mode: '2d', camera: null, rotate: false, language: 'en', settings: {} } };
const planRow = { cid: Cid.cidOfObject(plan), content: plan };
const LENS = 'm8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR';
const DEVELOPER = 'HZde4bPhD1NFSDXxgLE2UfMjBCAfXLBm5HpB9Dks4auu';
const persona = { name: 'developer-t', developer: { city: 'alatau', plans: [planRow.cid], apartmentsPerRound: 4, plainRoundEvery: 3, plainTargetUsdc: '2',
    priceUsdcPerM2: '0.08', depositShare: 0.3, targetShare: 0.45, maxOpenRounds: 3, deadlineDays: 3, lens: 'lifecycle-01' } };
const readers = { loadPlan: async () => planRow, loadDesigns: async () => designs, lensKeys: { 'lifecycle-01': LENS } };
// An earlier run of this persona that built `agreement` (only what earlierRounds reads).
const pastRun = (agreement, { deadline = '2099-01-01T00:00:00.000Z', settled = false } = {}) => ({ persona: persona.name, run_id: `r-${Math.random()}`,
    summary: { agreements: { k: { cid: 'bafk', deadline, content: agreement.content } }, mints: { k: { account: 'acct' } },
        settlements: settled ? { acct: { cid: 'bafk', settled: true } } : {} } });

describe('the apartments of a design building', () => {
    it('lays the building out and gives each apartment an X-ray address on the published design', () => {
        const laid = designApartments({ designCid: designs[0].cid, content: designs[0].content });
        expect(laid.xrayBuilding).toBe(`design::${designs[0].cid}::0`);
        expect(laid.apartments.length).toBeGreaterThan(4);
        for (const apartment of laid.apartments) {
            expect(apartment.unit).toMatch(/^\d+::[^:]+::[a-f0-9]{24}$/);
            expect(apartment.areaM2).toBeGreaterThan(0);
        }
    });
});

describe('planning a round', () => {
    it('offers distinct units of one building, priced from their floor area, with a target below the deposits', async () => {
        const { candidate } = await planRound({ persona, runs: [], runKey: '2026-11-26-t1', ...readers });
        expect(candidate).toMatchObject({ candidateId: 'round-1', plain: false, planCid: planRow.cid, lens: [LENS], city: 'alatau' });
        expect(candidate.units).toHaveLength(4);
        expect(new Set(candidate.units.map(unit => unit.unitId)).size).toBe(4);
        const deposits = candidate.units.reduce((sum, unit) => sum + BigInt(unit.depositUsdcAtomic), 0n);
        expect(BigInt(candidate.targetUsdcAtomic)).toBeLessThan(deposits);
        expect(BigInt(candidate.targetUsdcAtomic)).toBeGreaterThan(0n);
        for (const unit of candidate.units) expect(BigInt(unit.depositUsdcAtomic)).toBeLessThan(BigInt(unit.priceUsdcAtomic));
        expect(roundSignedActions(candidate, { marketSeed: true })).toBe(4);
    });

    it('never offers a unit an earlier round offered, stops at the open-round limit, and makes every third round plain', async () => {
        const first = (await planRound({ persona, runs: [], runKey: 'a', ...readers })).candidate;
        const built = roundAgreement({ candidate: first, plan: planRow, designs, developer: DEVELOPER, author: persona.name, createdAt: '2026-11-26T10:00:00.000Z' });
        const second = (await planRound({ persona, runs: [pastRun(built)], runKey: 'a', ...readers })).candidate;
        const taken = new Set(first.units.map(unit => `${first.projectId}/${unit.unitId}`));
        expect(second.units.some(unit => taken.has(`${second.projectId}/${unit.unitId}`))).toBe(false);
        const third = await planRound({ persona, runs: [pastRun(built), pastRun(built)], runKey: 'a', ...readers });
        expect(third.candidate).toMatchObject({ plain: true, units: [], lens: [], targetUsdcAtomic: '2000000' });
        const full = await planRound({ persona, runs: [pastRun(built), pastRun(built), pastRun(built)], runKey: 'a', ...readers });
        expect(full).toMatchObject({ candidate: null, reason: expect.stringMatching(/3 round\(s\) still open/) });
        // A settled or past round no longer counts as open.
        expect((await planRound({ persona, runs: [pastRun(built, { settled: true }), pastRun(built), pastRun(built, { deadline: '2020-01-01T00:00:00.000Z' })], runKey: 'a', ...readers })).candidate).not.toBeNull();
    });
});

describe('the round\'s agreement', () => {
    it('is a binding investors\' agreement on the plan with its contract and a PDF drawing per apartment', async () => {
        const { candidate } = await planRound({ persona, runs: [], runKey: 'b', ...readers });
        const { cid, content, deadline } = roundAgreement({ candidate, plan: planRow, designs, developer: DEVELOPER, author: persona.name, createdAt: '2026-11-26T10:00:00.000Z' });
        expect(Cid.cidOfObject(content)).toBe(cid);
        expect(agreementRecord.crowdfundingError(content, { requireSponsor: true })).toBeNull();
        expect(content).toMatchObject({ planCid: planRow.cid, sponsor: DEVELOPER, rule: { electorate: 'investors', binding: true, lens: [LENS] }, deadline });
        expect(deadline).toBe('2026-11-29T10:00:00.000Z');
        expect(content.funding.apartments.units).toHaveLength(4);
        for (const unit of content.funding.apartments.units) expect(Buffer.from(unit.drawing.data, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
        expect(Buffer.from(content.funding.contract.data, 'base64').toString()).toMatch(/Funding target: \d+\.\d\d devnet USDC/);
    });
});

describe('the unit drawing', () => {
    it('is a PDF whose cross-reference table points at every object', () => {
        const apartment = designApartments({ designCid: designs[0].cid, content: designs[0].content }).apartments[0];
        const pdf = apartmentDrawingPdf({ apartment, label: 'Storey 1, flat 1 (60 m²)', project: 'Test' }).toString('latin1');
        const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
        expect(offsets).toHaveLength(6);
        offsets.forEach((offset, i) => expect(pdf.slice(offset, offset + `${i + 1} 0 obj\n`.length)).toBe(`${i + 1} 0 obj\n`));
        expect(pdf.slice(Number(pdf.match(/startxref\n(\d+)/)[1]), Number(pdf.match(/startxref\n(\d+)/)[1]) + 4)).toBe('xref');
    });
});

describe('the persona config', () => {
    it('refuses a developer without plans or with too many apartments per round', () => {
        expect(() => developerConfig({ name: 'x', developer: { plans: [] } })).toThrow(/plans/);
        expect(() => developerConfig({ name: 'x', developer: { plans: ['p'], apartmentsPerRound: 9 } })).toThrow(/1-8/);
        expect(chooseUnits([], { count: 3, seed: 's', projectId: 'p' })).toEqual([]);
        expect(roundAmounts([{ areaM2: 100 }], developerConfig({ name: 'x', developer: { plans: ['p'] } })).units[0]).toMatchObject({ priceUsdcAtomic: '5000000', depositUsdcAtomic: '1500000' });
    });
});
