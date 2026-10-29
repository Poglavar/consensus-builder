// Bogotá POT 555 planning source: treatment polygons become metric constraints, the front yard is
// read under the parcel, and the shared evaluator derives a bounded volume from them.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { createBogotaPotProvider, bogotaPotSource } from '../planning/providers/bogota-pot.js';
import { parseAltura, parseAntejardin, interpretTreatment, antejardinConstraint, streetWallConstraint, dimensionalConstraints, solveRenovacion,
    incentiveCandidacy, incentive, parcelReading, BOGOTA_RULES, EQUIPAMIENTOS } from '../planning/providers/bogota-pot-rules.js';
import { parseAnnex, widenLotCode } from '../scripts/build-bogota-equipamientos.mjs';
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
// The activity-area polygon (layer 14) over the same ground: a Proximidad area, where Decreto 676/2025 storeys apply.
const activity = (objectId = 20034, changes = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [treatmentRing] },
    properties: { OBJECTID: objectId, CODIGO_AREA_ACTIVIDAD: 'AAPRSU', NOMBRE_AREA_ACTIVIDAD: 'Área de Actividad de Proximidad - AAP - Receptora de soportes urbanos', ...changes } });
// A 22 m square lot inside both polygons, with the street to its south.
const centre = [-74.05305, 4.64795];
const parcel = (id = 'CO-BOGOTA-008101001001', box = [centre[0] - 0.0001, centre[1] - 0.0001, centre[0] + 0.0001, centre[1] + 0.0001]) =>
    ({ ...turf.bboxPolygon(box), id, properties: { parcelId: id, parcelNumber: id.slice(10), sourceId: 'co-bogota-uaecd-lote' } });
const streets = () => ({ near: async () => ({ type: 'FeatureCollection', source: 'overpass', partial: false, truncated: false,
    features: [turf.lineString([[centre[0] - 0.001, centre[1] - 0.00025], [centre[0] + 0.001, centre[1] - 0.00025]], { osm_id: 'w1', name: 'Calle', highway: 'residential' })] }) });

// A fake service: layer 15 answers treatment queries, layer 22 front yards, layer 14 activity areas; every request is recorded.
function service({ treatments = [treatment()], antejardines = [antejardin()], activities = [activity()], fail = null } = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async href => {
        const url = new URL(href);
        calls.push(url);
        const layer = Number(url.pathname.split('/').at(-2));
        if (fail === layer) throw new Error('network');
        const pool = layer === 15 ? treatments : layer === 14 ? activities : antejardines;
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
        // 5 storeys × (3.80 m clear + 0.25 m slab) = 20.25 m; 4–6 storeys take a 5 m rear yard; TA takes
        // max(H/5, 4 m) at the sides from the second floor, H counted above that level.
        const five = interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: 'TA', ALTURA_MAXIMA: '5' });
        expect(five).toMatchObject({ status: 'allowed', storeys: 5, heightM: 20.25, heightLabel: '5 pisos', uplift: null });
        expect(five.constraints.map(c => [c.quantity, c.value, c.unit, c.evidence])).toEqual([
            ['storeys', 5, 'count', 'direct'], ['height', 20.25, 'm', 'direct'], ['rearSetback', 5, 'm', 'literal'], ['sideSetback', 4, 'm', 'literal']]);
        expect(five.constraints[3].fromHeightM).toBe(4.05);
        expect(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: 'TA', ALTURA_MAXIMA: '20' }).constraints[3]).toMatchObject({ quantity: 'sideSetback', value: 15.39, fromHeightM: 4.05 });
        const continuous = interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: ' ', ALTURA_MAXIMA: '12' });
        expect(continuous.constraints.map(c => [c.quantity, c.value])).toEqual([['storeys', 12], ['height', 48.6], ['rearSetback', 8], ['sideSetback', 0]]);
        expect(interpretTreatment({ TRATAMIENTO: 'MEJORAMIENTO INTEGRAL', ALTURA_MAXIMA: '3 B-urb' }).constraints.map(c => [c.quantity, c.value]))
            .toEqual([['storeys', 3], ['height', 12.15], ['rearSetback', 0], ['sideSetback', 0]]);
        // A range is its base; the upper number is a frontage-conditioned uplift kept as evidence.
        expect(interpretTreatment({ TRATAMIENTO: 'CONSERVACION', ALTURA_MAXIMA: '3-6' })).toMatchObject({ status: 'allowed', storeys: 3,
            uplift: { storeys: 6 }, heightLabel: '3 pisos (hasta 6 con frente suficiente)' });
        expect(interpretTreatment({ TRATAMIENTO: 'DESARROLLO', ALTURA_MAXIMA: 'Rg 2' })).toMatchObject({ status: 'unsupported_calculation', constraints: [], reason: expect.stringContaining('Rango 2') });
        // Renovación's height results from the index and the yards on the lot: the polygon alone cannot say it.
        expect(interpretTreatment({ TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: '7' })).toMatchObject({ status: 'unsupported_calculation', constraints: [], resultante: true, storeyCap: 7 });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSERVACION', ALTURA_MAXIMA: 'BIC NAL' })).toMatchObject({ status: 'instrument_handoff', reason: expect.stringContaining('Bien de Interés Cultural') });
        expect(interpretTreatment({ TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: null })).toMatchObject({ status: 'unsupported_calculation', resultante: true, storeyCap: null, heightLabel: 'altura resultante', reason: expect.stringContaining('índice') });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: ' ' })).toMatchObject({ status: 'instrument_handoff', reason: expect.stringContaining('Decreto 253/2026') });
        expect(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: '??' })).toMatchObject({ status: 'unrecorded' });
    });
    it('reads equipamiento storeys from the Decreto 253/2026 annex by the polygon identity, dotacional storey height and front yard', () => {
        expect(Object.keys(EQUIPAMIENTOS.polygons)).toHaveLength(596);
        // Annex row 2 (4 storeys, lot 005617052003) is the second blank Consolidación polygon by OBJECTID.
        const school = interpretTreatment({ OBJECTID: 35773, TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: ' ', ALTURA_MAXIMA: ' ', OBSERVACION: 'DOT' });
        expect(school).toMatchObject({ status: 'allowed', storeys: 4, heightM: 18.4, storeyHeightM: 4.6, equipamiento: { annexId: 2, lots: ['005617052003'], condition: null } });
        expect(school.constraints.map(c => [c.quantity, c.value])).toEqual([['storeys', 4], ['height', 18.4], ['rearSetback', 5], ['sideSetback', 0]]);
        expect(school.heightLabel).toBe('4 pisos (equipamiento, Decreto 253/2026)');
        // Row 7 is "N/A": public-service infrastructure without a storey count.
        expect(interpretTreatment({ OBJECTID: 35781, TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: ' ' })).toMatchObject({ status: 'instrument_handoff',
            equipamiento: { annexId: 7, decision: 'N/A' }, reason: expect.stringContaining('Infraestructura de Servicios Públicos') });
        // The annex minimum front yard applies to equipamiento lots even where the front-yard map says less.
        expect(antejardinConstraint({ OBJECTID: 1, DIMENSION: '2.00' }, {}, 'CONSOLIDACION', BOGOTA_RULES, { equipamiento: true }).constraint).toMatchObject({ quantity: 'frontSetback', value: 3.5 });
        expect(antejardinConstraint({ OBJECTID: 1, DIMENSION: '5.00' }, {}, 'CONSOLIDACION', BOGOTA_RULES, { equipamiento: true }).constraint).toMatchObject({ value: 5 });
        expect(antejardinConstraint({}, {}, 'CONSOLIDACION', BOGOTA_RULES, { equipamiento: true }).constraint).toMatchObject({ value: 3.5 });
        expect(antejardinConstraint({ DIMENSION: '2.00' }, {}, 'RENOVACION', BOGOTA_RULES, { equipamiento: true }).constraint).toBeNull();
    });
    it('parses the annex text into numbered rows with lot codes widened to the lot layer\'s form', () => {
        const rows = parseAnnex(['   ID polígono      DECISIÓN        CÓDIGO', '   ID 1 C/N/A        N/A             1081020188                AE: Lagos de Torca',
            '                                                       Actuación Estratégica Lagos de Torca', '    ID 2 C/4           4             0056175203',
            '   ID 3 C/5          5', '                                   0091350420', '                                   0091350419',
            '                       CLASIFICACIÓN DE LA INFORMACIÓN: PÚBLICA', '   -   N/A: No aplica. La determinación', '       o normativa aplicable.'].join('\n'));
        expect(rows).toEqual([
            { id: 1, legend: 'C/N/A', storeys: null, decision: 'N/A', codes: ['1081020188'], condition: 'AE: Lagos de Torca Actuación Estratégica Lagos de Torca' },
            { id: 2, legend: 'C/4', storeys: 4, decision: '4', codes: ['0056175203'], condition: '' },
            { id: 3, legend: 'C/5', storeys: 5, decision: '5', codes: ['0091350420', '0091350419'], condition: '' }]);
        expect(widenLotCode('0056175203')).toBe('005617052003');
        expect(widenLotCode('NO TIENE')).toBeNull();
    });
    it('steps the facade back above the street-wall height from the measured street width', () => {
        // D = street 12 m + front yard 3 m = 15 m; A = 2.5 × 15 = 37.5 m; a 48.6 m building steps back max(4, (48.6 − 37.5)/5) = 4 m.
        const wall = streetWallConstraint({ treatment: 'CONSOLIDACION', heightM: 48.6, antejardinM: 3, streetWidthM: 12 });
        expect(wall.constraint).toMatchObject({ quantity: 'frontSetback', value: 7, fromHeightM: 37.5, evidence: 'literal' });
        expect(wall.evidence).toMatchObject({ applies: true, distanceM: 15, facadeHeightM: 37.5, setbackM: 4 });
        // A taller building steps back (H − A)/5 once that exceeds 4 m.
        expect(streetWallConstraint({ treatment: 'RENOVACION', heightM: 80, streetWidthM: 10 }).constraint).toMatchObject({ value: 11, fromHeightM: 25 });
        expect(streetWallConstraint({ treatment: 'CONSOLIDACION', heightM: 20.25, antejardinM: 3.5, streetWidthM: 12 })).toMatchObject({ constraint: null, evidence: { applies: false, reason: 'building-below-facade-height' } });
        expect(streetWallConstraint({ treatment: 'CONSOLIDACION', heightM: 100, streetWidthM: 31 })).toMatchObject({ constraint: null, evidence: { reason: 'street-wider-than-rule' } });
        expect(streetWallConstraint({ treatment: 'CONSOLIDACION', heightM: 100, streetWidthM: null })).toMatchObject({ constraint: null, evidence: { reason: 'street-width-unknown' } });
        expect(streetWallConstraint({ treatment: 'CONSERVACION', heightM: 100, streetWidthM: 10 })).toMatchObject({ constraint: null, evidence: { reason: 'treatment-without-street-wall-rule' } });
        const twelve = dimensionalConstraints({ treatment: 'CONSOLIDACION', storeys: 12, antejardinM: 3.5, streetWidthM: 8 });
        expect(twelve.constraints.map(c => [c.quantity, c.value, c.fromHeightM])).toEqual([['storeys', 12, undefined], ['height', 48.6, undefined], ['rearSetback', 8, undefined],
            ['sideSetback', 0, undefined], ['frontSetback', 7.5, 28.75]]);
    });
    it('gives Renovación the storey count holding the most floor area within the construction index', () => {
        // Renovación: rear yard by height in metres, side yards from 11.40 m. A measure that models
        // a 20 × 20 m lot: each storey's footprint is the lot less the yards its top reaches.
        const lot = 20, measure = constraints => {
            const by = Object.fromEntries(constraints.map(c => [c.quantity, c]));
            const storeys = by.storeys.value, storeyM = by.height.value / storeys;
            let total = 0;
            for (let k = 1; k <= storeys; k++) {
                const side = by.sideSetback && k * storeyM > by.sideSetback.fromHeightM ? by.sideSetback.value : 0;
                total += Math.max(0, lot - 2 * side) * Math.max(0, lot - by.rearSetback.value);
            }
            return { floorAreaM2: total };
        };
        const solved = solveRenovacion({ lotM2: 400 }, measure);
        expect(solved).toMatchObject({ storeys: 8, heightM: 32.4, index: 5, limitM2: 2000 });
        expect(solved.floorAreaM2).toBeLessThanOrEqual(2000);
        expect(solved.constraints.map(c => [c.quantity, c.value, c.fromHeightM])).toEqual([['storeys', 8, undefined], ['height', 32.4, undefined], ['rearSetback', 8, undefined], ['sideSetback', 4.05, 12.15]]);
        expect(dimensionalConstraints({ treatment: 'RENOVACION', storeys: 21 }).constraints.find(c => c.quantity === 'rearSetback').value).toBe(20);
        // A map storey count in Renovación caps the search; a lot where no storey fits has no height.
        expect(solveRenovacion({ lotM2: 400, storeyCap: 3 }, measure)).toMatchObject({ storeys: 3 });
        expect(solveRenovacion({ lotM2: 400 }, () => ({ floorAreaM2: 0 }))).toBeNull();
    });
    it('offers the Decreto 676/2025 storeys as a conditional reading of a qualifying lot only', () => {
        const five = interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', TIPOLOGIA: ' ', ALTURA_MAXIMA: '5' });
        expect(incentiveCandidacy(five)).toEqual({ candidate: true, reason: null });
        expect(incentiveCandidacy(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: '3-5' })).candidate).toBe(false);
        expect(incentiveCandidacy(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: '12' })).candidate).toBe(false);
        expect(incentiveCandidacy(interpretTreatment({ TRATAMIENTO: 'RENOVACION', ALTURA_MAXIMA: ' ' })).candidate).toBe(false);
        expect(incentive(five, { lotM2: 500, activityCode: 'AAPRSU' })).toMatchObject({ applies: true, bonusStoreys: 2, storeys: 7 });
        expect(incentive(five, { lotM2: 900, activityCode: 'AAERAE' })).toMatchObject({ applies: true, bonusStoreys: 3, storeys: 8 });
        expect(incentive(interpretTreatment({ TRATAMIENTO: 'CONSOLIDACION', ALTURA_MAXIMA: '11' }), { lotM2: 900, activityCode: 'AAERAE' })).toMatchObject({ applies: true, bonusStoreys: 1, storeys: 12 });
        expect(incentive(five, { lotM2: 250, activityCode: 'AAPRSU' })).toMatchObject({ applies: false, reason: expect.stringContaining('300 m²') });
        expect(incentive(five, { lotM2: 500, activityCode: 'AAGSM' })).toMatchObject({ applies: false, reason: expect.stringContaining('AAGSM') });
        expect(incentive(five, { lotM2: 500, activityCode: null })).toMatchObject({ applies: false });
        const lot = parcelReading(five, { scenario: 'sustainable', lotM2: 500, activityCode: 'AAPRSU', antejardinM: 3 });
        expect(lot).toMatchObject({ status: 'allowed', storeys: 7, heightM: 28.35, condition: expect.stringContaining('ecourbanismo'), title: expect.stringContaining('5 + 2 sostenibles') });
        expect(lot.constraints.map(c => [c.quantity, c.value])).toEqual([['storeys', 7], ['height', 28.35], ['rearSetback', 6], ['sideSetback', 0]]);
        expect(parcelReading(five, { scenario: 'sustainable', lotM2: 200 })).toMatchObject({ status: 'unsupported_calculation', constraints: [] });
        expect(parcelReading(five, { scenario: 'general', lotM2: 500 })).toMatchObject({ status: 'allowed', storeys: 5, heightM: 20.25 });
    });
});

describe('Bogotá POT provider', () => {
    it('is registered with the Bogotá lot source pinned for parcel studies', () => {
        const source = getPlanningSources().find(provider => provider.descriptor.id === 'bogota-pot-555');
        expect(source.descriptor).toMatchObject({ city: 'bogota', parcelSourceId: 'co-bogota-uaecd-lote', scenarios: ['general', 'sustainable'], scenario: 'general', capabilities: { areas: true, volumes: false } });
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
        expect(second.items[0]).toMatchObject({ title: 'Renovación urbana · altura resultante', assessment: { status: 'unsupported_calculation' }, constraints: [] });
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

const lotSize = () => {
    const box = turf.bbox(parcel());
    return { widthM: turf.distance([box[0], box[1]], [box[2], box[1]], { units: 'meters' }), depthM: turf.distance([box[0], box[1]], [box[0], box[3]], { units: 'meters' }) };
};
const tierArea = volume => turf.area(turf.feature(volume.geometry));

describe('Bogotá parcel envelopes', () => {
    it('derives a tiered volume from storeys, the front yard under the lot and the decree yards, with the incentive storeys as a conditional configuration', async () => {
        const { provider } = service();
        const result = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider));
        expect(result.unavailable).toEqual([]);
        const [item] = result.items;
        expect(item).toMatchObject({ role: 'permitted', parcelEnvelope: true, source: { id: 'bogota-pot-555', parcel: parcel().id },
            sourceEvidence: { frontage: { basis: 'street' }, streetWidth: { widthM: null, reason: 'no-lot-across' }, excludedConfigurations: {} } });
        const [general, sustainable] = item.configurations;
        expect(general).toMatchObject({ id: 'general', treatment: 'allowed', unavailableReason: null });
        expect(general).not.toHaveProperty('condition');
        expect(general.constraints.map(c => [c.quantity, c.value, c.unit])).toEqual([
            ['storeys', 5, 'count'], ['height', 20.25, 'm'], ['rearSetback', 5, 'm'], ['sideSetback', 4, 'm'], ['frontSetback', 3.5, 'm']]);
        // The street lies south: the ground floor loses the 3.5 m front yard at the south edge and the
        // 5 m rear yard at the north edge; from the second floor the 4 m detached-typology side yards
        // take the east and west edges too, so the configuration is two stacked prisms.
        const { widthM, depthM } = lotSize();
        expect(general.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 4.05], [4.05, 20.25]]);
        expect(tierArea(general.volumes[0])).toBeCloseTo(widthM * (depthM - 3.5 - 5), -1);
        expect(tierArea(general.volumes[1])).toBeCloseTo((widthM - 8) * (depthM - 3.5 - 5), -1);
        expect(general.metrics).toMatchObject({ heightM: 20.25 });
        expect(general.metrics.floorAreaM2).toBeCloseTo(widthM * (depthM - 8.5) + 4 * (widthM - 8) * (depthM - 8.5), -1);
        // The 494 m² lot in a Proximidad area earns two Decreto 676/2025 storeys, rear yard for 7 storeys and side yards for 28.35 m.
        expect(sustainable).toMatchObject({ id: 'sustainable', treatment: 'allowed', unavailableReason: null, condition: expect.stringContaining('ecourbanismo') });
        expect(sustainable.constraints.map(c => [c.quantity, c.value])).toEqual([['storeys', 7], ['height', 28.35], ['rearSetback', 6], ['sideSetback', 4.86], ['frontSetback', 3.5]]);
        expect(sustainable.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 4.05], [4.05, 28.35]]);
        // The outer bound stacks what either configuration permits at each level: the general
        // ground floor, the wider side yards of the taller option above the general roof.
        expect(item.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 4.05], [4.05, 20.25], [20.25, 28.35]]);
        // The top tier only the incentive reaches carries its condition; the bound's height is the general one.
        expect(item.volumes.map(volume => volume.condition ?? null)).toEqual([null, null, expect.stringContaining('ecourbanismo')]);
        expect(item.metrics).toMatchObject({ heightM: 20.25, conditional: { heightM: 28.35, condition: expect.stringContaining('ecourbanismo') } });
        expect(tierArea(item.volumes[1])).toBeCloseTo((widthM - 8) * (depthM - 8.5), -1);
        expect(tierArea(item.volumes[2])).toBeCloseTo((widthM - 2 * 4.86) * (depthM - 3.5 - 6), -1);
        expect(item.title).toBe('Consolidación · 5 pisos · 008101001001');
    });
    it('solves the resulting height of a Renovación lot from the construction index and its yards', async () => {
        const { provider } = service({ treatments: [treatment(5, { TRATAMIENTO: 'RENOVACION', TIPOLOGIA: ' ', ALTURA_MAXIMA: ' ' })] });
        const result = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider));
        expect(result.unavailable).toEqual([]);
        const [item] = result.items;
        const [general] = item.configurations;
        expect(item.configurations).toHaveLength(1);
        expect(item.sourceEvidence.excludedConfigurations).toEqual({ sustainable: 'unsupported_calculation' });
        // A 22 m lot: eight storeys hold the most floor area; the rear yard is 8 m at 32.4 m and the
        // side yards 4.05 m from 12.15 m (three storeys) up. No front yard and, without a lot across the street, no street wall.
        expect(general.constraints.map(c => [c.quantity, c.value, c.fromHeightM])).toEqual([['storeys', 8, undefined], ['height', 32.4, undefined], ['rearSetback', 8, undefined], ['sideSetback', 4.05, 12.15]]);
        expect(general.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 12.15], [12.15, 32.4]]);
        const { widthM, depthM } = lotSize();
        expect(tierArea(general.volumes[0])).toBeCloseTo(widthM * (depthM - 8), -1);
        expect(tierArea(general.volumes[1])).toBeCloseTo((widthM - 8.1) * (depthM - 8), -1);
        expect(general.metrics.floorAreaM2).toBeLessThanOrEqual(5 * widthM * depthM);
        expect(item.title).toBe('Renovación urbana · 8 pisos (altura resultante, índice 5,0) · 008101001001');
        expect(item.sourceEvidence.excludedConfigurations.sustainable).toBe('unsupported_calculation');
    });
    it('steps a tall facade back above the street-wall height when a lot lies across the street', async () => {
        // The street runs 28 m south of the lot centre; a lot across it starts 9 m beyond the lot line.
        const across = parcel('CO-BOGOTA-008101002001', [centre[0] - 0.0001, centre[1] - 0.00045, centre[0] + 0.0001, centre[1] - 0.00018]);
        const { provider } = service({ treatments: [treatment(5, { TIPOLOGIA: ' ', ALTURA_MAXIMA: '12' })] });
        const result = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox }, envelopeOptions(provider, [parcel(), across]));
        const item = result.items.find(entry => entry.source.parcel === parcel().id);
        expect(item.sourceEvidence.streetWidth.widthM).toBeCloseTo(8.9, 0);
        const [general] = item.configurations;
        const wall = general.constraints.find(c => c.quantity === 'frontSetback' && c.fromHeightM);
        // D = 8.9 m + 3.5 m front yard; the facade rises to 2.5·D, then steps back max(4, (48.6 − A)/5) = 4 m more.
        const distanceM = item.sourceEvidence.streetWidth.widthM + 3.5;
        expect(wall).toMatchObject({ value: 7.5, fromHeightM: Math.round(2.5 * distanceM * 1000) / 1000 });
        expect(general.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, wall.fromHeightM], [wall.fromHeightM, 48.6]]);
        const { widthM, depthM } = lotSize();
        expect(tierArea(general.volumes[0])).toBeCloseTo(widthM * (depthM - 3.5 - 8), -1);
        expect(tierArea(general.volumes[1])).toBeCloseTo(widthM * (depthM - 7.5 - 8), -1);
        // Twelve storeys already reach the incentive's cap, so the polygon offers no sustainability reading.
        expect(item.sourceEvidence.excludedConfigurations).toEqual({ sustainable: 'unsupported_calculation' });
    });
    it('leaves a lot in an unassigned sector unavailable for a recorded, non-configurable status', async () => {
        const { provider } = service({ treatments: [treatment(5, { TRATAMIENTO: 'DESARROLLO', ALTURA_MAXIMA: 'Rg 2' })] });
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
        // A plain derivation applies the second-floor side yard from the ground: the study's single prism stays conservative.
        expect(bound.limits).toEqual({ frontSetback: 3.5, sideSetback: 4, rearSetback: 5 });
        expect(bound.heightM).toBe(20.25);
    });
});

describe('parcel assessment units and shapes', () => {
    const study = (constraints, lot = parcel()) => ({ parcel: lot, source: { constraints, assessment: {}, source: { scenario: 'general' } }, coveredGeometry: null });
    // An L-shaped lot: a 30 m square missing its 12 m north-east corner; the street is to the south.
    const metre = 1 / 111320, metreX = metre / Math.cos(centre[1] * Math.PI / 180);
    const at = (x, y) => [centre[0] + x * metreX, centre[1] + y * metre];
    const lShape = () => ({ type: 'Feature', id: 'L', properties: {}, geometry: { type: 'Polygon',
        coordinates: [[at(0, 0), at(30, 0), at(30, 18), at(18, 18), at(18, 30), at(0, 30), at(0, 0)]] } });
    const yards = (front, side, rear) => [{ quantity: 'frontSetback', value: front, unit: 'm', evidence: 'direct' },
        { quantity: 'sideSetback', value: side, unit: 'm', evidence: 'direct' }, { quantity: 'rearSetback', value: rear, unit: 'm', evidence: 'direct' },
        { quantity: 'height', value: 20, unit: 'm', evidence: 'direct' }];
    it('keeps the ground of a concave lot beyond each yard, measured from its own boundary segments', () => {
        const bound = core.derive(study(yards(3, 0, 5), lShape()), 0, turf);
        // 756 m² minus the 30×3 front strip, the two north-facing 5 m rear strips (12 m and 18 m long)
        // and the 5×5 pocket the inner rear strip's extension clears at the inward corner.
        expect(bound.areaM2).toBeCloseTo(756 - 90 - 150 - 25, 0);
        expect(bound.edges.map(edge => edge.role[0]).join('')).toBe('fsrsrs');
        expect(bound.points).toEqual([]);
        expect(turf.area(turf.difference(turf.feature(bound.geometry), lShape()) || turf.polygon([[at(0,0),at(1,0),at(0,1),at(0,0)]]))).toBeLessThan(1);
        // Without street evidence every edge keeps the smallest yard any role assigns: none here.
        expect(core.unorientedEnvelope(study(yards(3, 0, 5), lShape()), turf)).toMatchObject({ interpretations: 6, areaM2: expect.closeTo(756, 0) });
        // A 3 m yard on every edge: the 120 m perimeter strip, less the five convex corners it
        // double-counts, plus the 3×3 pocket inside the inward corner.
        expect(core.unorientedEnvelope(study(yards(3, 3, 5), lShape()), turf).areaM2).toBeCloseTo(756 - (3 * 120 - 5 * 9 + 9), 0);
        const design = core.designFromForm(study(yards(3, 0, 5), lShape()), { frontEdge: 0, scale: 0.5, eastM: 0, northM: 0, heightM: 9 }, turf);
        const result = core.assess(study(yards(3, 0, 5), lShape()), design, 0, turf);
        expect(result.checks.find(c => c.key === 'parcelContainment').status).toBe('pass');
        expect(result.checks.find(c => c.key === 'rearSetback')).toMatchObject({ status: 'pass', limit: 5 });
        expect(result.checks.find(c => c.key === 'rearSetback').measured).toBeGreaterThan(4.99);
    });
    it('still bounds a convex lot by exact half-planes', () => {
        const bound = core.derive(study(yards(3, 0, 5)), 0, turf);
        expect(bound.points).toHaveLength(4);
        const box = turf.bbox(parcel()), widthM = turf.distance([box[0], box[1]], [box[2], box[1]], { units: 'meters' }), depthM = turf.distance([box[0], box[1]], [box[0], box[3]], { units: 'meters' });
        expect(Math.abs(bound.areaM2 - widthM * (depthM - 8))).toBeLessThan(1);
    });
    it('reads setbacks and heights in metres or feet into metric limits', () => {
        const metres = core.derive(study([{ quantity: 'frontSetback', value: 2, unit: 'm', evidence: 'direct' }, { quantity: 'height', value: 9, unit: 'm', evidence: 'direct' }]), 0, turf);
        expect(metres.limits).toEqual({ frontSetback: 2, sideSetback: null, rearSetback: null }); expect(metres.heightM).toBe(9);
        const feet = core.derive(study([{ quantity: 'frontSetback', value: 10, unit: 'ft', evidence: 'direct' }, { quantity: 'height', value: 35, unit: 'ft', evidence: 'literal' }]), 0, turf);
        expect(feet.limits.frontSetback).toBeCloseTo(3.048, 9); expect(feet.heightM).toBeCloseTo(10.668, 9);
        const unknown = core.derive(study([{ quantity: 'height', value: 9, unit: 'storeys', evidence: 'direct' }, { quantity: 'rearSetback', value: 3, unit: 'm', evidence: 'estimated' }]), 0, turf);
        expect(unknown.heightM).toBeNull(); expect(unknown.limits.rearSetback).toBeNull();
    });
});
