// The shared city model reader (frontend/js/city-model-reader.js) as the building editors use it: a
// CityGML or CityJSON file becomes WGS84 footprints with heights, GeoJSON passes through, and a file in
// an unknown or unstated coordinate system says so instead of importing nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import proj4 from 'proj4';
import { parseCityGml } from '../buildings/citygml.js';

const require = createRequire(import.meta.url);
const Reader = require('../../frontend/js/city-model-reader.js');

const viennaGml = readFileSync(new URL('./fixtures/wien-lod2-096076.gml', import.meta.url), 'utf8');
const bagPage = JSON.parse(readFileSync(new URL('./fixtures/nl-3dbag-page.json', import.meta.url), 'utf8'));
const options = { proj4, turf, parseGml: parseCityGml };

// One CityJSON document from the 3DBAG page: the features' objects and vertices, with one shared vertex list.
function cityJsonDocument(page, referenceSystem = page.metadata.metadata.referenceSystem) {
    const vertices = [], CityObjects = {};
    for (const feature of page.features) {
        const offset = vertices.length;
        vertices.push(...feature.vertices);
        const shift = value => Array.isArray(value) ? value.map(shift) : value + offset;
        for (const [id, object] of Object.entries(feature.CityObjects)) {
            CityObjects[id] = { ...object, geometry: (object.geometry || []).map(g => ({ ...g, boundaries: shift(g.boundaries) })) };
        }
    }
    return { type: 'CityJSON', version: '2.0', transform: page.metadata.transform, metadata: { referenceSystem }, CityObjects, vertices };
}

describe('geoJsonFromFileText', () => {
    it('reads a CityGML file as one footprint per building, in Vienna, with its measured height', () => {
        const collection = Reader.geoJsonFromFileText(viennaGml, options);
        expect(collection.features).toHaveLength(2);
        expect(collection.features.map(f => f.properties.height)).toEqual([3.78, 4.6]);
        for (const feature of collection.features) {
            expect(feature.geometry.type).toBe('Polygon');
            const [lng, lat] = turf.centroid(feature).geometry.coordinates;
            expect(lng).toBeGreaterThan(16.30); expect(lng).toBeLessThan(16.32);
            expect(lat).toBeGreaterThan(48.18); expect(lat).toBeLessThan(48.19);
            expect(turf.area(feature)).toBeGreaterThan(20);
        }
    });

    it('reads a CityJSON file in RD New + NAP as footprints in Amsterdam, each the size of its ground surface', () => {
        const doc = cityJsonDocument(bagPage);
        const collection = Reader.geoJsonFromFileText(JSON.stringify(doc), options);
        expect(collection.features).toHaveLength(2);
        const [lng, lat] = turf.centroid(collection.features[0]).geometry.coordinates;
        expect(lng).toBeGreaterThan(4.88); expect(lng).toBeLessThan(4.90);
        expect(lat).toBeGreaterThan(52.36); expect(lat).toBeLessThan(52.38);
        // One ground, not the LoD 0 footprint on top of the part's ground surface.
        const groundM2 = bagPage.features[0].CityObjects[bagPage.features[0].id].attributes.b3_opp_grond;
        expect(turf.area(collection.features[0])).toBeGreaterThan(groundM2 * 0.95);
        expect(turf.area(collection.features[0])).toBeLessThan(groundM2 * 1.05);
        expect(collection.features[0].properties.height).toBeGreaterThan(3);
    });

    it('passes GeoJSON through and refuses other text', () => {
        const geojson = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [15.98, 45.8] } };
        expect(Reader.geoJsonFromFileText(JSON.stringify(geojson), options)).toEqual(geojson);
        expect(() => Reader.geoJsonFromFileText('not a file', options)).toThrow();
    });

    it('names a coordinate system it cannot read, and says when a file states none', () => {
        const unknown = JSON.stringify(cityJsonDocument(bagPage, 'https://www.opengis.net/def/crs/EPSG/0/5514'));
        let error;
        try { Reader.geoJsonFromFileText(unknown, options); } catch (caught) { error = caught; }
        expect(error.code).toBe('unsupported-crs');
        expect(Reader.crsErrorMessage(error, null)).toBe("The file's coordinate system (EPSG:5514) is not one we can read yet.");
        const unstated = viennaGml.replace(/ srsName="[^"]*"/g, '');
        try { Reader.geoJsonFromFileText(unstated, options); } catch (caught) { error = caught; }
        expect(Reader.crsErrorMessage(error, null)).toBe('The file does not say which coordinate system it uses.');
        expect(Reader.crsErrorMessage(new Error('other'), null)).toBeNull();
    });
});

describe('crsOf', () => {
    it('reads compound, URN and URL names, and derives UTM from its code', () => {
        expect(Reader.crsOf('https://www.opengis.net/def/crs/EPSG/0/7415').code).toBe(28992);
        expect(Reader.crsOf('urn:ogc:def:crs,crs:EPSG::31256,crs:EPSG::5778').code).toBe(31256);
        expect(Reader.crsOf('EPSG:25833').definition).toContain('+zone=33');
        expect(Reader.crsOf('urn:ogc:def:crs:EPSG::32618').definition).toContain('+zone=18');
        expect(Reader.crsOf('EPSG:2263').zToMetres).toBeCloseTo(0.3048, 4);
    });
});
