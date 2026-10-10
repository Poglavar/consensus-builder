// Parity of the two implementations of the binding rule on real cadastral data: the PostGIS SQL
// (backend/proposals/binding.js, authoritative) and the pure turf rule the browser previews with
// (frontend/js/proposals/site-binding.js). The same sites go to both; the bound parcels, coverage
// and intrusion widths must agree. Opt-in, it talks to the real geodata database (local docker):
//
//   cd backend && set -a && . ./.env && set +a && RUN_DB_TESTS=1 PGHOST=localhost npx vitest run test/proposal-binding-db.test.js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { computeBinding } from '../proposals/binding.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { bindingFromParcels } = require('../../frontend/js/proposals/site-binding.js');

const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// A surveyed Zagreb parcel with neighbours on several sides.
const KO = 335649;
const NUMBER = '1021/3';

live('binding SQL and the pure rule agree on real parcels', () => {
    let pool;

    beforeAll(async () => {
        const { default: pg } = await import('pg');
        pool = new pg.Pool({
            host: process.env.PGHOST || 'localhost',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE || 'geodata'
        });
    });
    afterAll(async () => { await pool?.end(); });

    // The parcel grown (or shrunk) by `bufferM` in EPSG:3765, as a WGS84 site.
    async function siteAround(bufferM) {
        const { rows } = await pool.query(`
            SELECT ST_AsGeoJSON(ST_Transform(ST_Buffer(geom, $3::float8, 'join=mitre'), 4326), 10) AS g
            FROM parcel WHERE current AND maticni_broj_ko = $1 AND broj_cestice = $2`, [KO, NUMBER, bufferM]);
        expect(rows).toHaveLength(1);
        return JSON.parse(rows[0].g);
    }

    // Every current parcel near the site, as the browser would have them loaded.
    async function parcelsNear(site) {
        const { rows } = await pool.query(`
            SELECT 'HR-' || maticni_broj_ko || '-' || broj_cestice AS id, ST_AsGeoJSON(ST_Transform(geom, 4326), 10) AS g
            FROM parcel
            WHERE current AND geom && ST_Expand(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765), 20)`,
        [JSON.stringify(site)]);
        return rows.map(row => ({ id: row.id, geometry: JSON.parse(row.g) }));
    }

    async function both(site, toleranceM) {
        const server = (await computeBinding(pool, { site, toleranceM })).binding;
        const client = bindingFromParcels(site, await parcelsNear(site), { toleranceM, turf });
        return { server, client };
    }

    function expectParity({ server, client }) {
        expect(client.parcels.map(p => p.parcelId)).toEqual(server.parcels.map(p => p.parcelId));
        expect(client.coverage).toBe(server.coverage);
        const byId = new Map(client.parcels.map(p => [p.parcelId, p]));
        for (const hit of server.parcels) {
            const mine = byId.get(hit.parcelId);
            // Both bisect to ±0.5 mm in radius; projections differ by ~1e-4 relative.
            expect(Math.abs(mine.intrusionM - hit.intrusionM), hit.parcelId).toBeLessThanOrEqual(Math.max(0.003, hit.intrusionM * 0.01));
            expect(Math.abs(mine.overlapM2 - hit.overlapM2) / Math.max(hit.overlapM2, 1), hit.parcelId).toBeLessThan(0.01);
        }
    }

    it('the parcel itself binds only itself (shared edges do not bind)', async () => {
        const pair = await both(await siteAround(0), 0);
        expectParity(pair);
        expect(pair.server.parcels.map(p => p.parcelId)).toContain(`HR-${KO}-${NUMBER}`);
    }, 60000);

    it('a 0.3 m overreach binds the neighbours at 0.3 m intrusion, and not at a 0.5 m tolerance', async () => {
        const site = await siteAround(0.3);
        const atZero = await both(site, 0);
        expectParity(atZero);
        const neighbours = atZero.server.parcels.filter(p => p.parcelId !== `HR-${KO}-${NUMBER}`);
        expect(neighbours.length).toBeGreaterThan(0);
        for (const n of neighbours) expect(n.intrusionM).toBeGreaterThan(0.25);

        const atHalf = await both(site, 0.5);
        expectParity(atHalf);
        expect(atHalf.server.parcels.length).toBeLessThan(atZero.server.parcels.length);
    }, 60000);

    it('at the tolerance where a neighbour flips from bound to touched, it is unresolved, never silently decided', async () => {
        const own = `HR-${KO}-${NUMBER}`;
        const site = await siteAround(0.3);
        const ids = list => (list || []).map(p => p.parcelId);
        const neighbour = (await computeBinding(pool, { site, toleranceM: 0 })).binding.parcels
            .find(p => p.parcelId !== own && p.intrusionM > 0.25)?.parcelId;
        expect(neighbour).toBeTruthy();
        const classify = async toleranceM => {
            const binding = (await computeBinding(pool, { site, toleranceM })).binding;
            if (ids(binding.parcels).includes(neighbour)) return 'bound';
            if (ids(binding.unresolved).includes(neighbour)) return 'unresolved';
            if (ids(binding.touched).includes(neighbour)) return 'touched';
            return 'absent';
        };
        // Bisect the tolerance: bound below the flip, touched above it, unresolved in the band.
        let lo = 0, hi = 1, found = null;
        for (let n = 0; n < 30 && !found; n += 1) {
            const mid = (lo + hi) / 2;
            const state = await classify(mid);
            if (state === 'unresolved') found = mid;
            else if (state === 'bound') lo = mid;
            else if (state === 'touched') hi = mid;
            else throw new Error(`${neighbour} vanished at tolerance ${mid}`);
        }
        expect(found, 'an unresolved band exists at the flip').not.toBeNull();
        // a millimetre either side is far outside the band, and decides
        expect(await classify(found - 0.001)).toBe('bound');
        expect(await classify(found + 0.001)).toBe('touched');
    }, 240000);

    it('a 5 cm inset binds only the parcel', async () => {
        const pair = await both(await siteAround(-0.05), 0);
        expectParity(pair);
        expect(pair.server.parcels.map(p => p.parcelId)).toEqual([`HR-${KO}-${NUMBER}`]);
        expect(pair.server.coverage).toBe('complete');
    }, 60000);

    it('reports a site outside the held cadastre as unknown', async () => {
        const paris = { type: 'Polygon', coordinates: [[[2.35, 48.85], [2.351, 48.85], [2.351, 48.851], [2.35, 48.851], [2.35, 48.85]]] };
        const { binding } = await computeBinding(pool, { site: paris });
        expect(binding.coverage).toBe('unknown');
        expect(binding.parcels).toEqual([]);
    }, 60000);
});
