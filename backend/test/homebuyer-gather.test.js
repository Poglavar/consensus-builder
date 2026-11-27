// gatherHomes (homebuyer-chain.js) reads the open apartment rounds a homebuyer can reserve in. A round
// whose record the app's own check now refuses (built before a contract change, such as the storey::flat
// address) is skipped and logged, so the other rounds are still served and the run does not fail.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { planRound, roundAgreement } from '../agents/developer-round.js';

vi.mock('../agents/discovery.js', () => ({
    discoverAgreements: vi.fn(async () => []),
    readAgreementStatuses: vi.fn(async rows => rows)
}));
vi.mock('../agents/apartment-actions.js', () => ({
    qualifyApartmentBuyer: vi.fn(), reserveApartment: vi.fn(),
    readRoundInventory: vi.fn(async (_connection, { content }) => content.funding.apartments.units.map(unit => ({ unitId: unit.unitId, status: 'available', buyer: null })))
}));
const discovery = await import('../agents/discovery.js');
const { gatherHomes } = await import('../agents/homebuyer-chain.js');

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');

const M = Math.PI * 6378137 / 180, LAT = 43.8, LNG = 77.09, MX = M * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M];
const block = (cx, w, h) => turf.polygon([[[cx - w / 2, -h / 2], [cx + w / 2, -h / 2], [cx + w / 2, h / 2], [cx - w / 2, h / 2], [cx - w / 2, -h / 2]].map(lngLat)],
    { use: 'residential', height: 15, floors: 5, type: 'proposedBuildingSingle' });
const designContent = { schema: 'design/v1', goal: 'single', city: 'alatau', title: 'Block A', geometry: { buildings: [block(0, 24, 12)] }, buildingProposal: {} };
const designs = [{ cid: Cid.cidOfObject(designContent), content: designContent }];
const plan = { schema: 'plan/v1', title: 'Test district', designCids: designs.map(row => row.cid), view: { at: '43.8,77.09,16', city: 'alatau', mode: '2d', camera: null, rotate: false, language: 'en', settings: {} } };
const planRow = { cid: Cid.cidOfObject(plan), content: plan };
const LENS = 'm8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR';
const DEVELOPER = 'HZde4bPhD1NFSDXxgLE2UfMjBCAfXLBm5HpB9Dks4auu';
const developer = { name: 'developer-t', developer: { city: 'alatau', plans: [planRow.cid], apartmentsPerRound: 2, plainRoundEvery: 0,
    priceUsdcPerM2: '0.08', depositShare: 0.3, targetShare: 0.45, maxOpenRounds: 3, deadlineDays: 3, lens: 'lifecycle-01' } };

async function builtRound() {
    const { candidate } = await planRound({ persona: developer, runs: [], runKey: 'g', loadPlan: async () => planRow, loadDesigns: async () => designs, lensKeys: { 'lifecycle-01': LENS } });
    return roundAgreement({ candidate, plan: planRow, designs, developer: DEVELOPER, author: developer.name, createdAt: '2026-11-26T10:00:00.000Z' });
}

describe('gathering the open rounds', () => {
    it('skips a round its record check refuses and still serves the others', async () => {
        const current = await builtRound();
        const units = current.content.funding.apartments.units.map(unit => ({ ...unit, unit: 'storey 4 flat 2' }));
        const retired = { cid: 'bafretired', content: { ...current.content, funding: { ...current.content.funding, apartments: { ...current.content.funding.apartments, units } } } };
        const rows = [retired, current].map(({ cid, content }) => ({ cid, content, planTitle: 'Test district' }));
        discovery.discoverAgreements.mockResolvedValueOnce(rows.map(({ cid }) => ({ cid, name: cid, city: 'alatau', account: '11111111111111111111111111111111', rule: { electorate: 'investors' }, chainStatus: 'active' })));
        const index = { getAgreement: vi.fn(async cid => rows.find(row => row.cid === cid)) };
        const log = vi.fn();
        const { rounds } = await gatherHomes({ index, persona: { name: 'homebuyer-t', policy: { cities: ['alatau'] } }, connection: {}, wallet: null, offerTools: null, log });
        expect(rounds.map(round => round.cid)).toEqual([current.cid]);
        expect(rounds[0].units).toHaveLength(2);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/round bafretired skipped: Each apartment needs a unique unit ID/));
    });
});
