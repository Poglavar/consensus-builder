// A road that plainly crosses a parcel must leave TWO parcels, not one that spans the road.
//
// Cadastral parcel HR-330264-575 is crossed by two corridors meeting at the junction south of it.
// turf 6.5's clipper returned the remainder as a single 1,165 m² Polygon whose ring runs out along a
// corridor edge and back — the turn segment measures 0.019 mm, against the 0.1 mm grid its own inputs
// were snapped to. GEOS, given the identical rows, returns the two parts it actually is.
//
// The consequence was not subtle: the piece id is a hash of the outline, so both lobes shared ONE id,
// the panel showed one parcel, and clicking either side of the road selected the same thing.
//
// Fixture is the real cadastre and the real stored corridors, so this cannot pass by agreeing with a
// shape someone drew to match the code.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL('./fixtures/parcel-575-artifact-neck.json', import.meta.url)), 'utf8'));

let arrangement;
beforeAll(() => {
    // The module reads turf off the global, exactly as the page does.
    globalThis.turf = require('@turf/turf');
    arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
});

const parcelFeature = () => ({ type: 'Feature', properties: {}, geometry: fixture.parcel });
const takes = () => fixture.takes.map(t => ({ id: t.id, geometry: t.polygon }));
const arrange = () => arrangement.arrangementOf(parcelFeature(), fixture.parcelId, takes());

describe('a corridor that crosses a parcel splits it in two', () => {
    it('returns two remainders, not one spanning the road', () => {
        const remainders = arrange().pieces.filter(p => p.kind === 'remainder');
        expect(remainders, 'the remainder came back as one piece spanning the road').toHaveLength(2);
    });

    it('puts them where GEOS does, to within a tenth of a percent', () => {
        const areas = arrange().pieces
            .filter(p => p.kind === 'remainder')
            .map(p => p.areaM2)
            .sort((a, b) => b - a);
        fixture.geosRemainderAreasM2.forEach((expected, i) => {
            expect(Math.abs(areas[i] - expected) / expected).toBeLessThan(0.001);
        });
    });

    // The lobes are the point: two ids, so a building on one is not a building on the other.
    it('gives each lobe its own id', () => {
        const ids = arrange().pieces.filter(p => p.kind === 'remainder').map(p => p.id);
        expect(new Set(ids).size).toBe(2);
        ids.forEach(id => expect(arrangement.isPieceId(id)).toBe(true));
    });

    // No ground may be invented or lost by the normalisation: pieces still tile the parcel.
    it('conserves the parcel', () => {
        const { pieces } = arrange();
        const total = pieces.reduce((sum, p) => sum + p.areaM2, 0);
        const parcelArea = globalThis.turf.area(parcelFeature());
        expect(Math.abs(total - parcelArea) / parcelArea).toBeLessThan(0.001);
    });

    // The Šibenik plan carried the same corridor twice (two applied proposals both titled
    // "Road 1008-1454"). A duplicate take must not change what the parcel IS. Ids are content
    // addresses and may legitimately move by a hair, so the invariant asserted here is the shape of
    // the fabric — how many pieces, and how big — not the hashes.
    it('is unmoved by a take being listed twice', () => {
        const doubled = takes();
        doubled.push({ id: `${doubled[0].id}-copy`, geometry: doubled[0].geometry });
        const shape = (result) => result.pieces
            .map(p => `${p.kind}:${Math.round(p.areaM2 * 10) / 10}`)
            .sort();
        expect(shape(arrangement.arrangementOf(parcelFeature(), fixture.parcelId, doubled)))
            .toEqual(shape(arrange()));
    });
});

// The detector must not fire on ordinary parcels — a false positive costs an erosion probe, but a
// detector that fires on everything is a performance bug, and one that fires on nothing is no
// detector at all. Both directions are checked against the shipped source.
describe('the neck detector', () => {
    it('leaves an untaken parcel exactly as it was', () => {
        const untouched = arrangement.arrangementOf(parcelFeature(), fixture.parcelId, []);
        expect(untouched.pieces).toHaveLength(1);
        expect(untouched.pieces[0].geometry).toEqual(fixture.parcel);
    });

    it('is what does the splitting — the source still opens the neck before counting pieces', () => {
        const source = readFileSync(
            fileURLToPath(new URL('../../frontend/js/proposals/parcel-arrangement.js', import.meta.url)), 'utf8');
        expect(source, 'explode() no longer normalises before counting pieces').toMatch(/hasArtifactNeck\(/);
        expect(source, 'the erosion probe is gone').toMatch(/splitAtArtifactNeck\(/);
    });
});
