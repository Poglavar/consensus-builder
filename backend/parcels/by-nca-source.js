// Explicit additional lookup scopes for the shared NCA source. These are sampled
// tiles, not administrative boundaries or claims of complete cadastral coverage.
import { bbox, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { validateBounds, validateGeometry } from './source-contract.js';
import { createNativeInteriorTileSource } from './vector-tile-native-source.js';

export const NCA_MAHILIO_SCOPE = Object.freeze({
    cityCode: '1590', name: 'Mahilioŭ',
    point: Object.freeze([30.3423548100176, 53.8969538474431]),
    bounds: Object.freeze([30.322265625, 53.891391285752874, 30.34423828125, 53.90433815627469]),
    // Observed cad_num prefix is a request-routing hint only. The tile decoder
    // independently verifies every full native ID; this is not an absence index.
    nativeIdPrefix: '740100', tile: '14/9572/5268'
});

export const NCA_HRODNA_SCOPE = Object.freeze({
    cityCode: '96', name: 'Hrodna',
    point: Object.freeze([23.8287909682828, 53.6796751398206]),
    bounds: Object.freeze([23.818359375, 53.673934358353925, 23.8348388671875, 53.68369534495073]),
    // Keep this scope at its verified zoom; changing the shared descriptor's zoom
    // would change the already-qualified Minsk and Mahilioŭ polygon coordinates.
    zoom: 16, nativeIdPrefix: '440100', tile: '16/37105/21141',
    // A small surrounding window keeps normal viewport/grid requests inside the
    // verified scope. All nine tiles were checked live; this is still a subset.
    tiles: Object.freeze([37104, 37105, 37106].flatMap(x => [21140, 21141, 21142].map(y => `16/${x}/${y}`)))
});

export const NCA_BREST_SCOPE = Object.freeze({
    cityCode: '264', name: 'Brest',
    point: Object.freeze([23.7148717432269, 52.1048113105078]),
    bounds: Object.freeze([23.70849609375, 52.09300763963823, 23.73046875, 52.106505190756316]),
    // Brest Belarus; this prefix routes reads, never establishes parcel absence.
    nativeIdPrefix: '140100', tile: '14/9271/5404'
});

export const NCA_VITSEBSK_SCOPE = Object.freeze({
    cityCode: '1392', name: 'Vitsebsk',
    point: Object.freeze([30.208463632636, 55.1870694543092]),
    bounds: Object.freeze([30.1904296875, 55.17886766328199, 30.21240234375, 55.191412435270635]),
    // Native prefix routes exact reads; it does not prove a municipal boundary.
    nativeIdPrefix: '240100', tile: '14/9566/5167'
});

export function isNcaSource(d) {
    return d.id === 'by-nca-public-cadastral-map'
        && d.endpoint === 'https://map.nca.by/tiles/294b19b9-3259-44e5-b8e8-000000000001/{z}/{x}/{y}.pbf';
}

export function createNcaParcelSource(d, options) {
    const original = createNativeInteriorTileSource(d, options);
    const scopes = [NCA_MAHILIO_SCOPE, NCA_HRODNA_SCOPE, NCA_BREST_SCOPE, NCA_VITSEBSK_SCOPE];
    const readers = new Map();
    const scoped = scope => {
        if (!scope) return original;
        if (!readers.has(scope)) readers.set(scope, createNativeInteriorTileSource({ ...d,
            idLookupBounds: scope.bounds, zoom: scope.zoom ?? d.zoom }, options));
        return readers.get(scope);
    };
    const scopeForBounds = bounds => scopes.find(({ bounds: b }) => bounds[0] < b[2] && bounds[2] > b[0]
        && bounds[1] < b[3] && bounds[3] > b[1]);
    async function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 ?? 4);
        return scoped(scopeForBounds(bounds)).queryBounds(bounds);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string')) {
            throw new HttpError(400, 'Provide 1–80 native parcel IDs belonging to this source.');
        }
        const groups = new Map();
        for (const id of new Set(ids)) {
            const scope = scopes.find(s => id.startsWith(d.idPrefix + s.nativeIdPrefix));
            if (!groups.has(scope)) groups.set(scope, []);
            groups.get(scope).push(id);
        }
        const features = [];
        for (const [scope, group] of groups) {
            const result = await scoped(scope).queryIds(group);
            features.push(...result.features);
        }
        return { type: 'FeatureCollection', features, sourceId: d.id, returnsWGS84: true,
            complete: true, absentIds: [], coverage: 'whole-interior-polygons-only' };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 parcel polygon.');
        return scoped(scopeForBounds(bbox(feature(geometry)))).queryGeometry(geometry);
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
