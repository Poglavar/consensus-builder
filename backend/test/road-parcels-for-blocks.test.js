// Street parcels for block formation (frontend/js/road-detection.js markRoadParcelsFromOsm): the
// lines come from /blocks/roads, the OSM boundaries block detection uses, and only its roads and
// tracks mark parcels; water and bridges never do, and incomplete coverage marks nothing.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const Coverage = require('../../frontend/js/osm-road-coverage.js');
const UrbanBlocksModel = require('../../frontend/js/urban-blocks-model.js');

// The named top-level functions of the classic script, evaluated in this realm so turf works.
function loadFunctions(names, bindings) {
    const source = readFileSync(new URL('../../frontend/js/road-detection.js', import.meta.url), 'utf8');
    const code = parse(source, { sourceType: 'script', errorRecovery: true }).program.body
        .filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
        .map(node => source.slice(node.start, node.end)).join('\n');
    const keys = Object.keys(bindings);
    return new Function(...keys, `${code}\nreturn { ${names.join(', ')} };`)(...keys.map(key => bindings[key]));
}

const LAT0 = 43.5081, LNG0 = 16.4402;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const at = (x, y) => [LNG0 + x * M_LNG, LAT0 + y * M_LAT];
const rect = (id, west, south, east, north) => turf.polygon([[at(west, south), at(east, south), at(east, north), at(west, north), at(west, south)]], { parcelId: id });
const line = (y, properties) => turf.lineString([at(-50, y), at(50, y)], properties);

function setup(source, parcels) {
    const marked = [], statuses = [];
    const fns = loadFunctions(['markParcelsCoveredByRoadLines', 'markRoadParcelsFromOsm'], {
        turf,
        window: {
            __osmRoadCoverage: Coverage,
            UrbanBlocksModel,
            ParcelBlockDetection: { fetchBoundaries: async () => source }
        },
        map: { getBounds: () => ({ getWest: () => at(-60, 0)[0], getEast: () => at(60, 0)[0], getSouth: () => at(0, -60)[1], getNorth: () => at(0, 60)[1] }) },
        document: { getElementById: () => null },
        console: { error() {}, log() {} },
        resolveParcelId: feature => feature.properties.parcelId,
        markRoadFeature: feature => { marked.push(feature.properties.parcelId); return true; },
        roadDetectionReportClip: () => {},
        roadDetectionFeaturesInView: () => parcels,
        updateStatus: message => statuses.push(message)
    });
    return { fns, marked, statuses };
}

describe('street parcels for block formation', () => {
    const street = rect('street', -30, -3, 30, 3);
    const canal = rect('canal', -30, 20, 30, 26);
    const plot = rect('plot', -10, 6, 10, 18);

    it('marks the street under an OSM road, not the canal under a waterway or a parcel under a bridge', async () => {
        const viaduct = rect('viaduct', -30, 40, 30, 46);
        const { fns, marked } = setup({ complete: true, features: [
            line(0, { highway: 'residential' }),
            line(23, { waterway: 'canal' }),
            line(43, { highway: 'primary', bridge: 'yes', layer: '1' })
        ] }, [street, canal, plot, viaduct]);
        expect(await fns.markRoadParcelsFromOsm()).toBe(1);
        expect(marked).toEqual(['street']);
    });

    it('marks a railway parcel', async () => {
        const { fns, marked } = setup({ complete: true, features: [line(0, { railway: 'rail' })] }, [street]);
        expect(await fns.markRoadParcelsFromOsm()).toBe(1);
        expect(marked).toEqual(['street']);
    });

    it('marks nothing from incomplete coverage, and says so', async () => {
        for (const source of [{ complete: false, features: [line(0, { highway: 'residential' })] },
            { complete: true, partial: true, features: [line(0, { highway: 'residential' })] }]) {
            const { fns, marked, statuses } = setup(source, [street]);
            expect(await fns.markRoadParcelsFromOsm()).toBeNull();
            expect(marked).toEqual([]);
            expect(statuses).toEqual(['Could not load roads and tracks. Please retry.']);
        }
    });

    it('checks only the parcels it is given', async () => {
        const { fns, marked } = setup({ complete: true, features: [line(0, { highway: 'residential' })] }, [street]);
        expect(await fns.markRoadParcelsFromOsm({ parcels: [plot] })).toBe(0);
        expect(marked).toEqual([]);
    });
});
