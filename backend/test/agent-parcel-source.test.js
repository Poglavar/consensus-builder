// Unit tests for backend/agents/parcel-source.js — the parameters it binds and the row → candidate
// mapping. The mapping is where a missing value becomes a fabricated one: a rule with no max_etage
// must stay null, not become 0 floors, and a parcel with no buildings must report 0 built area
// while a parcel with no rule reports no rule at all.
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
        expect(candidateParcelsSql).toContain('ST_Area(ST_Transform(p.geom, 4326)::geography)');
        expect(candidateParcelsSql).toContain('ST_AsGeoJSON(ST_Transform(s.geom, 4326))');
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
        expect(parcel.buildingCount).toBe(2);           // bigint arrives as a string
        expect(parcel.builtFootprintM2).toBeCloseTo(102.7, 4);
        expect(parcel.builtGfaM2).toBeCloseTo(295.3, 4);
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

    it('reports an empty parcel as zero built area, not as unknown', async () => {
        const parcel = await mapOne({ building_count: '0', built_footprint_m2: 0, built_gfa_m2: 0 });
        expect(parcel.buildingCount).toBe(0);
        expect(parcel.builtFootprintM2).toBe(0);
        expect(parcel.builtGfaM2).toBe(0);
    });
});

// Opt-in: this one talks to the real geodata database.
const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

live('fetchCandidateParcels against the real database', () => {
    it('returns Zagreb parcels in the persona bbox with rules resolved', async () => {
        const { default: pg } = await import('pg');
        const pool = new pg.Pool({
            host: process.env.PGHOST || 'localhost',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE || 'geodata'
        });
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
                expect(parcel.builtGfaM2).toBeGreaterThanOrEqual(0);
            }
            // The 2025 GUP covers this bbox, so the rule join must produce something.
            expect(parcels.some(p => p.rule && Number.isFinite(p.rule.maxFloors))).toBe(true);
        } finally {
            await pool.end();
        }
    }, 60000);
});
