import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { encodeImagerySource } from '../imagery/custom-source.js';
const require = createRequire(import.meta.url);
const imagery = require('../../frontend/js/imagery-source.js');
const settings = require('../../frontend/js/parcel-source-settings.js');
const config = { kind: 'imagery', adapter: 'wms', endpoint: 'https://public.example/wms', cityIds: ['sample'],
    name: 'Orthophoto č', layers: ['OI.OrthoimageCoverage'], version: '1.3.0', crs: 'CRS:84', format: 'image/png' };
function browser() {
    const data = new Map();
    return { getBackendBase: () => 'https://api.example', location: { search: '' },
        localStorage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) } };
}
describe('imagery area source contract', () => {
    it('persists independently, respects city/backend and explicit URL', () => {
        const id = encodeImagerySource(config), global = browser();
        settings.saveChoice('sample', { id }, global, 'imagery');
        expect(settings.choiceForCity('sample', global, 'imagery')).toMatchObject({ id, name: 'Orthophoto č' });
        expect(settings.choiceForCity('other', global, 'imagery')).toBeNull();
        expect(settings.choiceForCity('sample', global, 'parcel')).toBeNull();
        expect(settings.choiceForCity('sample', global, 'building')).toBeNull();
        global.getBackendBase = () => 'https://other.example';
        expect(settings.choiceForCity('sample', global, 'imagery')).toBeNull();
        global.location.search = '?imagerySource=' + id;
        expect(settings.choiceForCity('sample', global, 'imagery')).toMatchObject({ id });
        global.location.search = '?imagerySource=default';
        expect(settings.choiceForCity('sample', global, 'imagery')).toBeNull();
    });
    it('rejects cross-kind, credentialed and malformed descriptors', () => {
        const encode = value => 'imagery.' + Buffer.from(JSON.stringify(value)).toString('base64url');
        const valid = { ...config, idPrefix: 'CUSTOM-I-1234567890abcdef1234-' };
        for (const change of [{ kind: 'parcel' }, { adapter: 'arcgis' }, { endpoint: 'http://public.example' },
            { endpoint: 'https://public.example?key=secret' }, { endpoint: 'https://user:pass@public.example' },
            { crs: 'EPSG:3765' }, { bounds: 'broken' }, { bounds: [0,0,NaN,1] }, { minZoom: 'oops' },
            { bounds: [0, 1, 0, 2] }, { layers: ['<script>'] }, { format: 'image/svg+xml' }, { name: '<script>' }, { cityIds: ['sample', 'other'] }]) {
            expect(imagery.decode(encode({ ...valid, ...change }), 'sample')).toBeNull();
        }
    });
    it('suggests DGU within its advertised bounds', () => {
        expect(imagery.suggestions({ countryCode: 'HR' }, { lat: 45.81, lng: 15.98 }).map(s => s.key)).toEqual(['dgu2022', 'dgu2024']);
        expect(imagery.suggestions({ countryCode: 'HR' }, { lat: 40.7, lng: -74 })).toEqual([]);
        expect(imagery.suggestions({ countryCode: 'HR' }, { lat: 43.5, lng: 16.4 })).toEqual([]);
        expect(imagery.suggestions({ countryCode: 'HR' }, { lat: NaN, lng: 15 })).toEqual([]);
        expect(imagery.suggestions({ countryCode: 'SI' }, { lat: 45.81, lng: 15.98 })).toEqual([]);
    });
    it('uses the protected tile gateway for both formats and escapes attribution', () => {
        for (const adapter of ['xyz', 'wms']) expect(imagery.tileUrl('https://api.example/', { id: 'imagery.A_b-', adapter }, { z: 17, x: 70000, y: 45000 }))
            .toBe('https://api.example/imagery-sources/imagery.A_b-/tiles/17/70000/45000');
        expect(imagery.escapeAttribution('<img src="x"> & data')).toBe('&lt;img src=&quot;x&quot;&gt; &amp; data');
    });
});
