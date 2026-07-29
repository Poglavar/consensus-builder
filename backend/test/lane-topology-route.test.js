import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupLaneTopologyRoute } from '../routes/lane-topology.js';
import { createRouteApp } from './helpers/create-route-app.js';

function fakePool() {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('FROM osm_road')) {
                return {
                    rows: [{
                        geometry: { type: 'LineString', coordinates: [[15.96, 45.8], [15.961, 45.8]] },
                        properties: {
                            osm_id: '1',
                            highway_type: 'secondary',
                            tags: { highway: 'secondary', lanes: '2' }
                        },
                        date_added: new Date('2026-07-22T20:42:11Z')
                    }]
                };
            }
            return { rows: [] };
        }
    };
}

let pool;
let app;

beforeEach(() => {
    pool = fakePool();
    app = createRouteApp(setupLaneTopologyRoute, pool, {
        cliEnabled: true,
        spawnSyncImpl: () => ({ status: 0, stdout: 'test-cli 1.0', stderr: '' })
    });
});

describe('lane-topology manager API', () => {
    it('rejects invalid or dangerously large WGS84 selections', async () => {
        await request(app).get('/lane-topology/osm?bbox=nonsense').expect(400);
        await request(app).get('/lane-topology/osm?bbox=15,45,16,46').expect(400);
        expect(pool.calls).toHaveLength(0);
    });

    it('returns bounded raw OSM evidence with snapshot provenance', async () => {
        const response = await request(app)
            .get('/lane-topology/osm?bbox=15.95,45.79,15.97,45.81&city=zagreb')
            .expect(200);
        expect(response.body.features).toHaveLength(1);
        expect(response.body.snapshotAt).toBe('2026-07-22T20:42:11.000Z');
        expect(pool.calls[0].sql).toContain("to_jsonb(r)->'osm_node_ids'");
        expect(pool.calls[0].sql).toContain('public.osm_topology_way');
        expect(pool.calls[0].params).toEqual([
            'zagreb',
            [
                'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
                'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
                'unclassified', 'residential', 'living_street', 'service', 'road'
            ],
            ['tram', 'light_rail'],
            15.95, 45.79, 15.97, 45.81
        ]);
    });

    it('advertises both installed structured-output CLI providers', async () => {
        const response = await request(app).get('/lane-topology/providers').expect(200);
        expect(response.body.providers.codex.available).toBe(true);
        expect(response.body.providers.claude.available).toBe(true);
    });
});
