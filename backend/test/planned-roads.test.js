import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupPlannedRoadRoute } from '../routes/planned-roads.js';
import { createRouteApp } from './helpers/create-route-app.js';

function createPlannedRoadPool(resultRows = []) {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('road_parcel_classification') || sql.includes('dgu_road_usage')) {
                return { rows: [{ geom: null }], rowCount: 1 };
            }
            return { rows: resultRows, rowCount: resultRows.length };
        },
        release() { }
    };

    return {
        calls,
        async connect() {
            return client;
        }
    };
}

let pool;
let app;

beforeEach(() => {
    pool = createPlannedRoadPool([
        {
            props: { road_name: 'Planned Avenue' },
            geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
        }
    ]);
    app = createRouteApp(setupPlannedRoadRoute, pool);
});

describe('GET /planned-road', () => {
    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/planned-road?bbox=1,2,3');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('returns 500 when planned-road lookup fails', async () => {
        pool = {
            async connect() {
                return {
                    async query() {
                        throw new Error('planned road query failed');
                    },
                    release() { }
                };
            }
        };
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('supports requests without bbox filters', async () => {
        const res = await request(app).get('/planned-road');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(pool.calls.at(-1).params[4]).toBe(false);
    });

    it('clips planned road geometry to the viewport and avoids serializing the source geom into props', async () => {
        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        const sql = pool.calls.at(-1).sql;
        expect(sql).toContain('ST_Intersection(ST_MakeValid(pr.geom), (SELECT geom FROM envelope))');
        expect(sql).toContain('jsonb_build_object(');
        expect(sql).not.toContain("(to_jsonb(pr) - 'geom')");
    });

    it('falls back from missing classification view to dgu_road_usage', async () => {
        const roadUnion = Buffer.from('road-union');
        const calls = [];
        pool = {
            async connect() {
                return {
                    async query(sql, params) {
                        calls.push({ sql, params });
                        if (sql.includes('road_parcel_classification')) {
                            const error = new Error('view missing');
                            error.code = '42P01';
                            throw error;
                        }
                        if (sql.includes('dgu_road_usage')) {
                            return { rows: [{ geom: roadUnion }], rowCount: 1 };
                        }
                        return {
                            rows: [
                                {
                                    props: { road_name: 'Fallback Road' },
                                    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
                                }
                            ],
                            rowCount: 1
                        };
                    },
                    release() { }
                };
            }
        };
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(calls[0].sql).toContain('road_parcel_classification');
        expect(calls[1].sql).toContain('dgu_road_usage');
        expect(calls.at(-1).params[5]).toBe(roadUnion);
    });

    it('releases the client when road union query fails with non-fallback error', async () => {
        let released = false;
        pool = {
            async connect() {
                return {
                    async query(sql) {
                        if (sql.includes('road_parcel_classification')) {
                            const error = new Error('permission denied');
                            error.code = '42501';
                            throw error;
                        }
                        return { rows: [], rowCount: 0 };
                    },
                    release() {
                        released = true;
                    }
                };
            }
        };
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        expect(released).toBe(true);
    });

    it('filters out rows without geometry', async () => {
        pool = createPlannedRoadPool([
            { props: { road_name: 'Broken row' }, geometry: null },
            { props: { road_name: 'Good row' }, geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] } }
        ]);
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(res.body.features[0].properties.road_name).toBe('Good row');
    });

    it('returns planned road features with default styling props', async () => {
        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features[0].properties.road_name).toBe('Planned Avenue');
        expect(res.body.features[0].properties.planStatus).toBe('planned');
        expect(res.body.features[0].properties.source).toBe('government_plan');
    });

    it('preserves explicit style values and normalizes non-object props', async () => {
        pool = createPlannedRoadPool([
            {
                props: {
                    road_name: 'Styled Road',
                    planStatus: 'approved',
                    source: 'custom_plan',
                    displayColor: '#123456',
                    strokeColor: '#654321',
                    strokeWeight: 7,
                    fillOpacity: 0,
                    display: 'overlay'
                },
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
            },
            {
                props: 'bad-props',
                geometry: { type: 'Polygon', coordinates: [[[15.92, 45.79], [15.93, 45.79], [15.93, 45.78], [15.92, 45.79]]] }
            }
        ]);
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(2);
        expect(res.body.features[0].properties).toEqual({
            road_name: 'Styled Road',
            planStatus: 'approved',
            source: 'custom_plan',
            displayColor: '#123456',
            strokeColor: '#654321',
            strokeWeight: 7,
            fillOpacity: 0,
            display: 'overlay'
        });
        expect(res.body.features[1].properties).toEqual({
            planStatus: 'planned',
            source: 'government_plan',
            displayColor: '#ffd54f',
            strokeColor: '#c98a00',
            strokeWeight: 2,
            fillOpacity: 0.35,
            display: 'planned_road'
        });
    });
});
