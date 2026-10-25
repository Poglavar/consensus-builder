// Unit tests for backend/agents/parcel-source.js — the parameters it binds and the row → candidate
// mapping. The mapping is where a missing value becomes a fabricated one: a rule with no max_etage
// must stay null, not become 0 floors. An empty building query is an observation, not proof of
// vacancy; missing heights cannot establish even an observed floor-area total.
//
// The live test at the bottom is opt-in (RUN_DB_TESTS=1) so the suite never needs a database:
//   RUN_DB_TESTS=1 npx vitest run test/agent-parcel-source.test.js
import { describe, it, expect } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import { fetchCandidateParcels, candidateParcelsSql } from '../agents/parcel-source.js';

// One row as Postgres hands it back: float8 columns arrive as numbers, count(*) as a bigint string.
function row(overrides = {}) {
    return {
        cestica_id: 21305332,
        maticni_broj_ko: 335614,
        broj_cestice: '2178',
        ko_name: 'RUDEŠ',
        area_m2: 422.0912,
        centroid_lng: 15.934361,
        centroid_lat: 45.797141,
        geometry: { type: 'Polygon', coordinates: [[[15.9343, 45.7971], [15.9344, 45.7971], [15.9344, 45.7972], [15.9343, 45.7971]]] },
        building_count: '2',
        built_footprint_m2: 102.7,
        built_gfa_m2: 295.3,
        missing_height_count: '0',
        rule_geom_hash: 'abc123',
        rule_id: '1.4-stambene-i-mješovite-namjene',
        rule_short_name: '1.4',
        rule_variables: {
            max_etage: 3,
            max_izgradenost: 30,
            max_gbp: null,
            min_distance_from_buildable_parcels: 3,
            min_plot_size: null
        },
        ...overrides
    };
}

describe('candidateParcelsSql', () => {
    it('is one statement binding eight parameters', () => {
        for (let i = 1; i <= 8; i++) expect(candidateParcelsSql).toContain(`$${i}`);
        expect(candidateParcelsSql).not.toContain('$9');
        expect(candidateParcelsSql.split(';').filter(part => part.trim()).length).toBe(1);
    });

    it('reads only current parcels and applies the app\'s 90% containment rule to buildings', () => {
        expect(candidateParcelsSql).toContain('p.current = true');
        expect(candidateParcelsSql).toContain('>= 0.9');
    });

    it('measures area and footprints geodesically, and returns WGS84 geometry', () => {
        expect(candidateParcelsSql).toContain('ST_Area(ST_Transform(ST_CollectionExtract(ST_MakeValid(p.geom), 3), 4326)::geography)');
        expect(candidateParcelsSql).toContain('ST_AsGeoJSON(ST_Transform(s.geom, 4326))');
    });

    it('repairs malformed source geometries before topology operations', () => {
        expect(candidateParcelsSql).toContain('ST_MakeValid(p.geom)');
        expect(candidateParcelsSql).toContain('ST_MakeValid(bf.geom)');
        expect(candidateParcelsSql).toContain('ST_MakeValid(ur.geom)');
    });

    it('joins urban rules on title as well as short_name — every 2025 GUP row has a null short_name', () => {
        expect(candidateParcelsSql).toContain('COALESCE(ur.short_name, ur.title)');
        expect(candidateParcelsSql).toContain('urv.gup_id::text = ur.gup');
        expect(candidateParcelsSql).toContain('ST_PointOnSurface(s.geom)');
    });

    it('caps the row count before the building and rule joins, so the caps bound the work', () => {
        const limitAt = candidateParcelsSql.indexOf('LIMIT $8::int');
        const lateralAt = candidateParcelsSql.indexOf('LEFT JOIN LATERAL');
        expect(limitAt).toBeGreaterThan(-1);
        expect(limitAt).toBeLessThan(lateralAt);
    });
});

describe('fetchCandidateParcels parameters', () => {
    it('binds bbox, grad_opcina, the area band and the limit in order', async () => {
        const pool = createMockPool();
        await fetchCandidateParcels(pool, { city: 'zagreb', bbox: [15.93, 45.78, 16.02, 45.83] });
        const [call] = pool.getCalls();
        expect(call.sql).toBe(candidateParcelsSql);
        expect(call.params).toEqual([15.93, 45.78, 16.02, 45.83, 'ZAGREB', 400, 2000, 40]);
    });

    it('passes the caller\'s band and limit through', async () => {
        const pool = createMockPool();
        await fetchCandidateParcels(pool, { city: 'zagreb', bbox: [1, 2, 3, 4], minAreaM2: 800, maxAreaM2: 5000, limit: 7 });
        expect(pool.getCalls()[0].params).toEqual([1, 2, 3, 4, 'ZAGREB', 800, 5000, 7]);
    });

    it('searches every KO in the bbox for a city whose grad_opcina we do not know', async () => {
        const pool = createMockPool();
        await fetchCandidateParcels(pool, { city: 'belgrade', bbox: [1, 2, 3, 4] });
        expect(pool.getCalls()[0].params[4]).toBeNull();
    });

    it('refuses a malformed bbox rather than querying the world', async () => {
        const pool = createMockPool();
        await expect(fetchCandidateParcels(pool, { city: 'zagreb', bbox: [1, 2, 3] })).rejects.toThrow(/bbox/);
        await expect(fetchCandidateParcels(pool, { city: 'zagreb', bbox: [1, 2, 3, NaN] })).rejects.toThrow(/bbox/);
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe('fetchCandidateParcels row mapping', () => {
    async function mapOne(overrides) {
        const pool = createMockPool();
        pool.setResult({ rows: [row(overrides)], rowCount: 1 });
        const [parcel] = await fetchCandidateParcels(pool, { city: 'zagreb', bbox: [1, 2, 3, 4] });
        return parcel;
    }

    it('composes the parcel id the app speaks', async () => {
        expect((await mapOne()).parcelId).toBe('HR-335614-2178');
    });

    it('carries the measurements through as numbers', async () => {
        const parcel = await mapOne();
        expect(parcel.cesticaId).toBe(21305332);
        expect(parcel.koCode).toBe(335614);
        expect(parcel.koName).toBe('RUDEŠ');
        expect(parcel.areaM2).toBeCloseTo(422.0912, 4);
        expect(parcel.centroid).toEqual({ lng: 15.934361, lat: 45.797141 });
        expect(parcel.geometry.type).toBe('Polygon');
        expect(parcel).toMatchObject({ buildingCount: null, builtFootprintM2: null, builtGfaM2: null,
            builtKnown: false, buildingSourceId: 'gdi-3d', buildingCoverage: 'unknown' });
        expect(parcel.buildingObservations).toEqual({ sourceId: 'gdi-3d', buildingCount: 2,
            sourceEvidence: { publisher: 'City of Zagreb', sourceId: 'gdi-3d', datasetEdition: 'ZG3D 2022',
                datasetUrl: 'https://data.zagreb.hr/dataset/zg3d-2022-3d-model-gz',
                publishedCoverageEvidenceUrl: 'https://www.unin.hr/wp-content/uploads/tj_18_2024_SI.pdf',
                statedGeographicScope: 'City of Zagreb', captureYears: [2008, 2019, 2020, 2022],
                captureTemporalBasis: 'mixed capture years; no per-feature capture date', overallInventoryCoverage: 'partial' },
            footprintM2: 102.7, gfaM2: 295.3, missingHeightCount: 0, floorHeightM: 3.5 });
        expect(parcel).toMatchObject({ buildingSourceId: 'gdi-3d', buildingCoverage: 'unknown', builtGfaM2: null });
    });

    it('maps the rule variables to the planner\'s vocabulary and keeps the raw set', async () => {
        const { rule } = await mapOne();
        expect(rule.ruleId).toBe('1.4-stambene-i-mješovite-namjene');
        expect(rule.shortName).toBe('1.4');
        expect(rule.maxFloors).toBe(3);
        expect(rule.maxCoveragePct).toBe(30);
        expect(rule.minSetbackM).toBe(3);
        expect(rule.variables.max_etage).toBe(3);
    });

    it('leaves an absent or null variable NULL — never 0', async () => {
        const { rule } = await mapOne();
        expect(rule.maxGfaM2).toBeNull();      // present in the json, but null
        expect(rule.minPlotM2).toBeNull();
        const noVars = await mapOne({ rule_variables: null });
        expect(noVars.rule.maxFloors).toBeNull();
        expect(noVars.rule.minSetbackM).toBeNull();
        expect(noVars.rule.variables).toBeNull();
    });

    it('reports no rule at all when no rule polygon covers the parcel', async () => {
        const parcel = await mapOne({ rule_geom_hash: null, rule_id: null, rule_short_name: null, rule_variables: null });
        expect(parcel.rule).toBeNull();
    });

    it('keeps an empty query unknown without complete inventory coverage', async () => {
        const parcel = await mapOne({ building_count: '0', built_footprint_m2: null, built_gfa_m2: null });
        expect(parcel).toMatchObject({ buildingCount: null, builtFootprintM2: null, builtGfaM2: null, builtKnown: false });
        expect(parcel.buildingObservations).toMatchObject({ buildingCount: 0, footprintM2: null, gfaM2: null,
            sourceEvidence: { overallInventoryCoverage: 'partial' } });
    });

    it('preserves a missing-height observation without manufacturing floor area', async () => {
        const parcel = await mapOne({ missing_height_count: '1', built_gfa_m2: null });
        expect(parcel.buildingObservations).toMatchObject({ buildingCount: 2, footprintM2: 102.7,
            gfaM2: null, missingHeightCount: 1 });
        expect(parcel.builtGfaM2).toBeNull();
    });
});

// Opt-in: this one talks to the real geodata database.
const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

live('fetchCandidateParcels against the real database', () => {
    async function localPool() {
        const { createPool, isLocalDatabase } = await import('../db/connection.cjs');
        if (!isLocalDatabase()) throw new Error('Agent source integration tests require a local database');
        return createPool({ max: 1, statement_timeout: 45000, options: '-c default_transaction_read_only=on' });
    }

    it('returns Zagreb parcels in the persona bbox with rules resolved', async () => {
        const pool = await localPool();
        try {
            const parcels = await fetchCandidateParcels(pool, {
                city: 'zagreb',
                bbox: [15.93, 45.78, 16.02, 45.83],
                limit: 20
            });
            expect(parcels.length).toBeGreaterThan(0);
            for (const parcel of parcels) {
                expect(parcel.parcelId).toMatch(/^HR-\d+-.+$/);
                expect(parcel.areaM2).toBeGreaterThanOrEqual(400);
                expect(parcel.areaM2).toBeLessThanOrEqual(2000);
                expect(['Polygon', 'MultiPolygon']).toContain(parcel.geometry.type);
                expect(Number.isFinite(parcel.centroid.lng)).toBe(true);
                expect(parcel).toMatchObject({ builtGfaM2: null, builtKnown: false, buildingCoverage: 'unknown' });
                expect(parcel.buildingObservations.buildingCount).toBeGreaterThanOrEqual(0);
            }
            // The 2025 GUP covers this bbox, so the rule join must produce something.
            expect(parcels.some(p => p.rule && Number.isFinite(p.rule.maxFloors))).toBe(true);
        } finally {
            await pool.end();
        }
    }, 60000);

    it('runs the production building aggregate against empty, complete and incomplete height observations', async () => {
        const pool = await localPool();
        // Substitute only source relations with CTE fixtures. All production containment, height,
        // aggregation and null logic still executes in PostGIS, with no database mutations.
        const fixtures = `WITH fixture_centre AS (
            SELECT ST_Transform(ST_SetSRID(ST_MakePoint(15.95, 45.8), 4326), 3765) AS geom
        ), fixture_parcel AS (
            SELECT 1 AS cestica_id, 335614 AS maticni_broj_ko, 'fixture' AS broj_cestice,
                true AS current, ST_Buffer(geom, 20) AS geom FROM fixture_centre
        ), fixture_municipality AS (
            SELECT 335614 AS maticni_broj, 'fixture' AS naziv, 'Fixture city' AS grad_opcina
        ), fixture_footprints AS (
            SELECT n AS object_id, ST_Translate(ST_Buffer(geom, 3), (n - 1.5) * 14, 0) AS geom
            FROM fixture_centre CROSS JOIN generate_series(1, $10::int) n
        ), fixture_buildings AS (
            SELECT 1 AS object_id, 7::float8 AS height_m
            UNION ALL SELECT 2, $9::float8
        ), area AS (`;
        const sql = candidateParcelsSql
            .replace('WITH area AS (', fixtures)
            .replaceAll('public.parcel', 'fixture_parcel')
            .replaceAll('public.cadastral_municipality', 'fixture_municipality')
            .replaceAll('public.gdi_building_footprint', 'fixture_footprints')
            .replaceAll('public.gdi_building', 'fixture_buildings');
        const params = [15.93, 45.78, 16.02, 45.83, null, 400, 2000, 1];
        try {
            const { rows: [empty] } = await pool.query(sql, [...params, null, 0]);
            expect(Number(empty.building_count)).toBe(0);
            expect(empty.built_footprint_m2).toBeNull();
            expect(empty.built_gfa_m2).toBeNull();
            for (const height of [null, 0, -1, 'NaN', 'Infinity', '-Infinity']) {
                const { rows: [incomplete] } = await pool.query(sql, [...params, height, 2]);
                expect(Number(incomplete.building_count)).toBe(2);
                expect(incomplete.built_footprint_m2).toBeGreaterThan(0);
                expect(Number(incomplete.missing_height_count)).toBe(1);
                expect(incomplete.built_gfa_m2).toBeNull();
            }
            const { rows: [measured] } = await pool.query(sql, [...params, 7, 2]);
            expect(Number(measured.missing_height_count)).toBe(0);
            expect(measured.built_gfa_m2).toBeCloseTo(measured.built_footprint_m2 * 2, 5);
        } finally {
            await pool.end();
        }
    }, 60000);
});
