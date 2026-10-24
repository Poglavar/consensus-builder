// Real crossing ribbons exposed an order-dependent union despite using the same Turf build.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { appTurf } from '../agents/mcp-geometry.js';

const require = createRequire(import.meta.url);
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const agreement = require('../../frontend/js/agreement-record.js');
const { parcel, takes } = JSON.parse(readFileSync(new URL('./fixtures/digbeth-crossroads.json', import.meta.url)));
const previousTurf = globalThis.turf;
const previousArrangement = globalThis.__parcelArrangement, previousOrder = globalThis.__planOrder;
afterEach(() => {
    globalThis.turf = previousTurf;
    globalThis.__parcelArrangement = previousArrangement;
    globalThis.__planOrder = previousOrder;
});

it('forms identical crossroads through MCP, reordered browser replay, and precomputed hits', async () => {
    globalThis.turf = appTurf;
    const baseline = arrangement.arrangementOf(parcel, 'test-site', takes).pieces;
    expect(await agreement.outputHash(baseline.find(piece => piece.kind === 'road').geometry))
        .toBe('piece1-sha256:4cf8f9c19e121fc3deb52e650a75c78e10bec56246c48894f1597c2f528319f1');
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        const roads = order.map(index => takes[index]);
        expect(arrangement.arrangementOf(parcel, 'test-site', roads).pieces).toEqual(baseline);
        const hits = arrangement.takeHitsOn(parcel, roads);
        expect(arrangement.arrangementOf(parcel, 'test-site', [], hits).pieces).toEqual(baseline);
        expect(hits.map(hit => hit.take.id)).toEqual(roads.map(road => road.id));
        // Local draft/published ids must not decide any geometric output or piece identity.
        const renamed = roads.map((road, index) => ({ ...road, id: `local-${index}` }));
        const geometryOnly = pieces => pieces.map(({ takers, ...piece }) => piece);
        expect(geometryOnly(arrangement.arrangementOf(parcel, 'test-site', renamed).pieces)).toEqual(geometryOnly(baseline));
    }
});

it('carves earlier formations identically when the same later roads arrive in another order', () => {
    globalThis.turf = appTurf;
    globalThis.__parcelArrangement = arrangement;
    globalThis.__planOrder = require('../../frontend/js/proposals/plan-order.js');
    const apply = require('../../frontend/js/proposals/apply/road.js');
    const records = takes.map(take => ({ proposalId: take.id, applied: true, createdAt: '2026-10-24T00:00:00Z',
        roadProposal: { definition: { polygon: take.geometry } } }));
    const prior = { proposalId: 'layout', createdAt: '2026-10-23T00:00:00Z' };
    const carve = rows => apply._groundAfterLaterCorridors(prior, [parcel.geometry], {
        _parcelMutation: { proposals: { getAllProposals: () => rows } }
    });
    const baseline = carve(records);
    expect(baseline.corridorIds).toHaveLength(3);
    for (const order of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        expect(carve(order.map(index => records[index]))).toEqual(baseline);
    }
});
