// Bogotá POT 555 planning source: treatment polygons become metric constraints, the front yard is
// read under the parcel, and the shared evaluator derives a bounded volume from them.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { createBogotaPotProvider, bogotaPotSource } from '../planning/providers/bogota-pot.js';
import { parseAltura, parseAntejardin, interpretTreatment, BOGOTA_RULES } from '../planning/providers/bogota-pot-rules.js';
import { getPlanningSources, planningRepresentations } from '../planning/sources.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
import { loadParcelStudy, studyParcelSource } from '../planning/parcel-study.js';
const core = createRequire(import.meta.url)('../../frontend/js/planning/parcel-assessment.js');

// Two real features (Chapinero, consolidación TA 5 storeys and its 3.50 m front yard), coordinates rounded.
const treatmentRing = [[-74.052863,4.647526],[-74.052901,4.647478],[-74.052977,4.647519],[-74.053115,4.647585],[-74.053243,4.647646],[-74.053239,4.647677],[-74.053335,4.647731],[-74.05356,4.647858],[-74.05356,4.64786],[-74.053359,4.648589],[-74.053304,4.648737],[-74.053265,4.648839],[-74.053261,4.648851],[-74.05326,4.648852],[-74.053185,4.648833],[-74.053275,4.648536],[-74.053263,4.648477],[-74.053249,4.648445],[-74.053215,4.648395],[-74.053173,4.648358],[-74.052991,4.648229],[-74.05256,4.647925],[-74.052589,4.647865],[-74.052565,4.647784],[-74.052632,4.647742],[-74.05273,4.647665],[-74.052789,4.647609],[-74.052863,4.647526]];
const antejardinRing = [[-74.052977,4.647519],[-74.053115,4.647585],[-74.053243,4.647646],[-74.053239,4.647677],[-74.053335,4.647731],[-74.05356,4.647858],[-74.05356,4.64786],[-74.053359,4.648589],[-74.053368,4.648408],[-74.052589,4.647865],[-74.05259,4.647864],[-74.052719,4.64777],[-74.052784,4.647722],[-74.052843,4.647671],[-74.052896,4.647614],[-74.052954,4.647551],[-74.052976,4.647521],[-74.052977,4.647519]];
const treatment = (objectId = 38341, changes = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [treatmentRing] },
    properties: { OBJECTID: objectId, CODIGO_ID: null, CODIGO_TRATAMIENTO: 'C', TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: 'TA', ALTURA_MAXIMA: '5',
        ACTO_ADMINISTRATIVO: 'Decreto 555 de 29 de diciembre de 2021', OBSERVACION: ' ', FECHA_CAPTURA: 1640736000000, RESPONSABLE: '553', ...changes } });
const antejardin = (objectId = 2094, changes = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [antejardinRing] },
    properties: { OBJECTID: objectId, DIMENSION: '3.50', NOTA: ' ', OBSERVACION: ' ', ACTO_ADMINISTRATIVO: 'Decreto 555 de 29 de diciembre de 2021', FECHA_CAPTURA: 1640736000000, ...changes } });
// A 22 m square lot inside both polygons, with the street to its south.
const centre = [-74.05305, 4.64795];
const parcel = (id = 'CO-BOGOTA-008101001001', box = [centre[0] - 0.0001, centre[1] - 0.0001, centre[0] + 0.0001, centre[1] + 0.0001]) =>
    ({ ...turf.bboxPolygon(box), id, properties: { parcelId: id, parcelNumber: id.slice(10), sourceId: 'co-bogota-uaecd-lote' } });
const streets = () => ({ near: async () => ({ type: 'FeatureCollection', source: 'overpass', partial: false, truncated: false,
    features: [turf.lineString([[centre[0] - 0.001, centre[1] - 0.00025], [centre[0] + 0.001, centre[1] - 0.00025]], { osm_id: 'w1', name: 'Calle', highway: 'residential' })] }) });

// A fake service: layer 15 answers treatment queries, layer 22 front yards; every request is recorded.
function service({ treatments = [treatment()], antejardines = [antejardin()], fail = null } = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async href => {
        const url = new URL(href);
        calls.push(url);
        const layer = Number(url.pathname.split('/').at(-2));
        if (fail === layer) throw new Error('network');
        const pool = layer === 15 ? treatments : antejardines;
        const ids = url.searchParams.get('objectIds');
        const after = /OBJECTID > (\d+)/.exec(url.searchParams.get('where') || '');
        let features = ids ? pool.filter(f => ids.split(',').includes(String(f.properties.OBJECTID))) : pool.filter(f => !after || f.properties.OBJECTID > Number(after[1]));
        const count = Number(url.searchParams.get('resultRecordCount') || features.length);
        const more = features.length > count;
        features = features.slice(0, count);
        return { ok: true, json: async () => ({ type: 'FeatureCollection', features, ...(more ? { properties: { exceededTransferLimit: true } } : {}) }) };
    });
    return { fetchImpl, calls, provider: createBogotaPotProvider(bogotaPotSource, { fetchImpl }) };
}
const bbox = [-74.05386, 4.647365, -74.05226, 4.648965];
const envelopeOptions = (provider, features = [parcel()]) => ({ sources: [provider], streetProvider: streets(),
    parcelProvider: () => ({ queryBounds: async () => ({ features, complete: true }), queryIds: async () => ({ features, complete: true }) }) });

describe('Bogotá POT rules', () => {
    it('reads storeys, ranges, development ranges, instrument codes and blanks from ALTURA_MAXIMA', () => {
        expect(parseAltura('5')).toMatchObject({ kind: 'storeys', min: 5, max: 5 });
        expect(parseAltura('3-6')).toMatchObject({ kind: 'storeys', min: 3, max: 6 });
        expect(parseAltura('3 B-urb')).toMatchObject({ kind: 'storeys', min: 3, max: 3, qualifier: 'B-urb' });
        expect(parseAltura('Rg 4D')).toMatchObject({ kind: 'development-range', range: '4D' });
        expect(parseAltura('PEMP')).toMatchObject({ kind: 'instrument' });
        expect(parseAltura(' ')).toMatchObject({ kind: 'blank' });
        expect(parseAltura(null)).toMatchObject({ kind: 'blank' });
        expect(parseAltura('6-3')).toMatchObject({ kind: 'unparsed' });
        expect(parseAntejardin('3.50')).toBe(3.5); expect(parseAntejardin('0.00')).toBe(0);
        expect(parseAntejardin(' ')).toBeNull(); expect(parseAntejardin('abc')).toBeNull();
    });
    it('turns an assigned storey count into metric constraints and keeps other statuses non-configurable', () => {
        // 5 storeys × (3.80 m clear + 0.25 m slab) = 20.25 m; 4–6 storeys take a 5 m rear yard; TA takes max(H/5, 4 m) at the sides.
        const five = interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: 'TA', ALTURA_MAXIMA: '5' });
        expect(five).toMatchObject({ status: 'allowed', storeys: 5, heightM: 20.25, heightLabel: '5 pisos', uplift: null });
        expect(five.constraints.map(c => [c.quantity, c.value, c.unit, c.evidence])).toEqual([
            ['storeys', 5, 'count', 'direct'], ['height', 20.25, 'm', 'direct'], ['rearSetback', 5, 'm', 'literal'], ['sideSetback', 4.05, 'm', 'literal']]);
        const continuous = interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: ' ', ALTURA_MAXIMA: '12' });
        expect(continuous.constraints.map(c => [c.quantity, c.value])).toEqual([['storeys', 12], ['height', 48.6], ['rearSetback', 8], ['sideSetback', 0]]);
        expect(interpretTreatment({ TRATAMIENTO: 'MEJORAMIENTO INTEGRAL', ALTURA_MAXIMA: '3 B-urb' }).constraints.map(c => [c.quantity, c.value]))
            .toEqual([['storeys', 3], ['height', 12.15], ['rearSetback', 0], ['sideSetback', 0]]);
        // A range is its base; the upper number is a frontage-conditioned uplift kept as evidence.
        expect(interpretTreatment({ TRATAMIENTO: 'CONSERVACION', ALTURA_MAXIMA: '3-6' })).toMatchObject({ status: 'allowed', storeys: 3,
            uplift: { storeys: 6 }, heightLabel: '3 pisos (hasta 6 con frente suficiente)' });
        expect(interpretTreatment({ TRATAMIENTO: 'DESARROLLO', ALTURA_MAXIMA: 'Rg 2' })).toMatchObject({ status: 'unsupported_calculation', constraints: [], reason: expect.stringContaining('Rango 2') });
        expect(interpretTreatment({ TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: '7' })).toMatchObject({ status: 'unsupported_calculation', constraints: [] });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSERVACION', ALTURA_MAXIMA: 'BIC NAL' })).toMatchObject({ status: 'instrument_handoff', reason: expect.stringContaining('Bien de Interés Cultural') });
        expect(interpretTreatment({ TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: null })).toMatchObject({ status: 'instrument_handoff', heightLabel: 'altura no asignada', reason: expect.stringContaining('resultante') });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: ' ' })).toMatchObject({ status: 'instrument_handoff', reason: expect.stringContaining('Decreto 253/2026') });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: '??' })).toMatchObject({ status: 'unrecorded' });
    });
});

describe('Bogotá POT provider', () => {
    it('is registered with the Bogotá lot source pinned for parcel studies', () => {
        const source = getPlanningSources().find(provider => provider.descriptor.id === 'bogota-pot-555');
        expect(source.descriptor).toMatchObject({ city: 'bogota', parcelSourceId: 'co-bogota-uaecd-lote', scenarios: ['general'], capabilities: { areas: true, volumes: false } });
        expect(studyParcelSource(source, 'bogota')).toMatchObject({ id: 'co-bogota-uaecd-lote' });
    });
    it('lists treatment areas clipped to the viewport with metric constraints and pages by object id', async () => {
        const { provider, calls } = service({ treatments: [treatment(1), treatment(2, { ALTURA_MAXIMA: ' ', TRATAMIENTO: 'RENOVACION' })] });
        const first = await planningRepresentations({}, { city: 'bogota', source: 'bogota-pot-555', bbox, limit: 1 }, [provider]);
        expect(first.items).toHaveLength(1);
        expect(first.items[0]).toMatchObject({ role: 'permitted', title: 'Consolidación · 5 pisos', volumes: [],
            source: { id: 'bogota-pot-555', recordId: '1', scenario: 'general', city: 'bogota' },
            assessment: { meaning: 'zoning-area', status: 'allowed', constraints: 'not-evaluated' } });
        expect(first.items[0].areas).toHaveLength(1);
        expect(first.items[0].constraints).toContainEqual(expect.objectContaining({ quantity: 'height', value: 20.25, unit: 'm', evidence: 'direct', scenario: 'general' }));
        expect(first.items[0].sourceEvidence.rules).toMatchObject({ clearHeightM: BOGOTA_RULES.clearHeightM, slabM: BOGOTA_RULES.slabM, storeyHeightM: 4.05 });
        expect(first.items[0].proposal.constraints).toEqual(first.items[0].constraints);
        expect(first.truncated).toBe(true);
        const second = await planningRepresentations({}, { city: 'bogota', source: 'bogota-pot-555', bbox, limit: 1, cursor: first.nextCursor }, [provider]);
        expect(second.items[0]).toMatchObject({ title: 'Renovación urbana · altura no asignada', assessment: { status: 'instrument_handoff' } });
        expect(second.truncated).toBe(false);
        expect(calls.filter(url => url.pathname.endsWith('/15/query')).map(url => url.searchParams.get('where'))).toEqual(['1=1', 'OBJECTID > 1']);
        expect(calls.every(url => url.searchParams.get('outSR') === '4326' && url.searchParams.get('f') === 'geojson')).toBe(true);
        await expect(provider.query({}, { bbox, limit: 1, after: 'x' })).rejects.toMatchObject({ status: 400 });
    });
    it('serves a record from the listing it already read, and by object id otherwise', async () => {
        const { provider, calls } = service();
        await provider.query({}, { bbox, limit: 10, city: 'bogota' });
        const cached = await provider.record({}, { recordId: '38341', city: 'bogota' });
        expect(cached[0].site).toEqual(treatment().geometry);
        expect(calls.filter(url => url.pathname.endsWith('/15/query'))).toHaveLength(1);
        const fresh = createBogotaPotProvider(bogotaPotSource, { fetchImpl: service().fetchImpl });
        expect((await fresh.record({}, { recordId: '38341' }))[0].source.recordId).toBe('38341');
        expect(await fresh.record({}, { recordId: '999' })).toEqual([]);
        expect(await fresh.record({}, { recordId: 'drop table' })).toEqual([]);
    });
    it('attaches the front yard found under the parcel to its treatment record, and none when no polygon lies there', async () => {
        const { provider } = service({ antejardines: [antejardin(), antejardin(7, { DIMENSION: '0.00' }), { type: 'Feature', geometry: null, properties: { OBJECTID: 8 } }] });
        const records = await provider.record({}, { recordId: '38341', city: 'bogota' });
        const [refined] = await provider.parcelRecords(parcel(), records);
        expect(refined.constraints).toContainEqual(expect.objectContaining({ quantity: 'frontSetback', value: 3.5, unit: 'm', evidence: 'direct', sourceRecordId: '2094', scenario: 'general' }));
        expect(refined.sourceEvidence.antejardin).toMatchObject({ objectId: 2094, dimensionM: 3.5, notes: [] });
        expect(refined.sourceEvidence.antejardin.overlapShare).toBeGreaterThan(0.99);
        expect(refined.proposal.constraints).toEqual(refined.constraints);
        expect(refined.source.version).toBe(records[0].source.version);
        const [bare] = await provider.parcelRecords(parcel('CO-BOGOTA-000000000001', [-74.0525, 4.6474, -74.0524, 4.6475]), records);
        expect(bare.constraints.some(c => c.quantity === 'frontSetback')).toBe(false);
        expect(bare.sourceEvidence.antejardin).toMatchObject({ objectId: null });
        // Only Consolidación lots are bound by the front-yard map; elsewhere the value is evidence.
        const other = service({ treatments: [treatment(9, { TRATAMIENTO: 'MEJORAMIENTO INTEGRAL', TIPOLOGIA: ' ', ALTURA_MAXIMA: '3' })] }).provider;
        const [unbound] = await other.parcelRecords(parcel(), await other.record({}, { recordId: '9', city: 'bogota' }));
        expect(unbound.constraints.some(c => c.quantity === 'frontSetback')).toBe(false);
        expect(unbound.sourceEvidence.antejardin).toMatchObject({ objectId: 2094, dimensionM: 3.5, applies: false });
    });
});

describe('Bogotá parcel envelopes', () => {
    it('derives a bounded volume from storeys, the front yard under the lot and the decree yards', async () => {
        const { provider } = service();
        const result = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider));
        expect(result.unavailable).toEqual([]);
        const [item] = result.items;
        expect(item).toMatchObject({ role: 'permitted', parcelEnvelope: true, source: { id: 'bogota-pot-555', parcel: parcel().id },
            volumes: [{ baseM: 0, topM: 20.25 }], sourceEvidence: { frontage: { basis: 'street' }, excludedConfigurations: {} } });
        const [configuration] = item.configurations;
        expect(configuration).toMatchObject({ id: 'general', treatment: 'allowed', unavailableReason: null });
        expect(configuration.constraints.map(c => [c.quantity, c.value, c.unit])).toEqual([
            ['storeys', 5, 'count'], ['height', 20.25, 'm'], ['rearSetback', 5, 'm'], ['sideSetback', 4.05, 'm'], ['frontSetback', 3.5, 'm']]);
        // The street lies south: the bound loses the 3.5 m front yard at the south edge, the 5 m rear
        // yard at the north edge and the 4.05 m detached-typology side yards at the east and west edges.
        const box = turf.bbox(parcel());
        const widthM = turf.distance([box[0], box[1]], [box[2], box[1]], { units: 'meters' }), depthM = turf.distance([box[0], box[1]], [box[0], box[3]], { units: 'meters' });
        expect(item.metrics.footprintM2).toBeCloseTo((widthM - 2 * 4.05) * (depthM - 3.5 - 5), 0);
    });
    it('leaves a parcel without an assigned height unavailable for a recorded, non-configurable status', async () => {
        const { provider } = service({ treatments: [treatment(5, { TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: ' ' })] });
        const result = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider));
        expect(result.items).toEqual([]);
        expect(result.unavailable).toEqual([{ parcelId: parcel().id, reason: 'status-not-configurable' }]);
    });
    it('fails the whole read when the front-yard map cannot be read, instead of blaming parcel geometry', async () => {
        const { provider } = service({ fail: 22 });
        await expect(loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider))).rejects.toMatchObject({ status: 503 });
    });
    it('assembles a single-parcel study carrying the same front-yard constraint', async () => {
        const { provider } = service();
        const context = await loadParcelStudy({ city: 'bogota', source: 'bogota-pot-555', scenario: 'general', parcel: parcel().id }, envelopeOptions(provider));
        expect(context.source.constraints.map(c => c.quantity)).toEqual(['storeys', 'height', 'rearSetback', 'sideSetback', 'frontSetback']);
        const bound = core.derive(context, 0, turf);
        expect(bound.limits).toEqual({ frontSetback: 3.5, sideSetback: 4.05, rearSetback: 5 });
        expect(bound.heightM).toBe(20.25);
    });
});

describe('parcel assessment units', () => {
    const study = constraints => ({ parcel: parcel(), source: { constraints, assessment: {}, source: { scenario: 'general' } }, coveredGeometry: null });
    it('reads setbacks and heights in metres or feet into metric limits', () => {
        const metres = core.derive(study([{ quantity: 'frontSetback', value: 2, unit: 'm', evidence: 'direct' }, { quantity: 'height', value: 9, unit: 'm', evidence: 'direct' }]), 0, turf);
        expect(metres.limits).toEqual({ frontSetback: 2, sideSetback: null, rearSetback: null }); expect(metres.heightM).toBe(9);
        const feet = core.derive(study([{ quantity: 'frontSetback', value: 10, unit: 'ft', evidence: 'direct' }, { quantity: 'height', value: 35, unit: 'ft', evidence: 'literal' }]), 0, turf);
        expect(feet.limits.frontSetback).toBeCloseTo(3.048, 9); expect(feet.heightM).toBeCloseTo(10.668, 9);
        const unknown = core.derive(study([{ quantity: 'height', value: 9, unit: 'storeys', evidence: 'direct' }, { quantity: 'rearSetback', value: 3, unit: 'm', evidence: 'estimated' }]), 0, turf);
        expect(unknown.heightM).toBeNull(); expect(unknown.limits.rearSetback).toBeNull();
    });
});
