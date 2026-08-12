import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupLaneTopologyRoute } from '../routes/lane-topology.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { listAllSolutions } from '../scripts/lib/stored-solutions.js';

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

// Evidence now comes from the shared roads API, not this service's own SQL, so the stub moved
// with it. Injected rather than global-patched, so a test can never silently reach a live service.
let roadsApiCalls;
function fakeRoadsApi() {
    roadsApiCalls = [];
    return async (url) => {
        roadsApiCalls.push(url);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                type: 'FeatureCollection',
                snapshot: {
                    id: 1, city: 'zagreb', sourceSha256: 'a'.repeat(64),
                    sourceTimestamp: '2026-07-22T20:42:11.000Z'
                },
                features: [{
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [[15.96, 45.8], [15.961, 45.8]] },
                    properties: {
                        osm_id: 1, highway_type: 'secondary',
                        tags: { highway: 'secondary', lanes: '2' },
                        osm_node_ids: [11, 12], osm_snapshot_id: 1, source: 'osm_topology_way'
                    }
                }],
                restrictions: [],
                truncated: false
            })
        };
    };
}

let pool;
let app;

beforeEach(() => {
    pool = fakePool();
    app = createRouteApp(setupLaneTopologyRoute, pool, {
        cliEnabled: true,
        roadsFetchImpl: fakeRoadsApi(),
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
        // The snapshot's identity, not merely its date — a solution can cite which evidence it saw.
        expect(response.body.snapshot.id).toBe(1);
        expect(response.body.features[0].properties.osm_node_ids).toEqual([11, 12]);
        // Evidence comes from the shared API; this service must not query osm_road itself any more.
        expect(pool.calls.some(call => call.sql.includes('FROM osm_road'))).toBe(false);
        expect(roadsApiCalls).toHaveLength(1);
        expect(roadsApiCalls[0]).toContain('/roads/topology?bbox=15.95,45.79,15.97,45.81');
        expect(roadsApiCalls[0]).toContain('city=zagreb');
    });

    it('advertises both installed structured-output CLI providers', async () => {
        const response = await request(app).get('/lane-topology/providers').expect(200);
        expect(response.body.providers.codex.available).toBe(true);
        expect(response.body.providers.claude.available).toBe(true);
    });

    it('advertises the Zagreb CDOF source and describes a bounded Savska crop', async () => {
        const sources = await request(app).get('/lane-topology/imagery/sources').expect(200);
        expect(sources.body.sources).toContainEqual(expect.objectContaining({
            key: 'zagreb_cdof_2022',
            nativeGsdM: 0.15,
            capturedAt: '2022'
        }));

        const crop = await request(app)
            .get('/lane-topology/imagery/crop-spec')
            .query({ bbox: '15.9610346,45.7979133,15.9622577,45.7986894' })
            .expect(200);
        expect(crop.body.crop).toEqual(expect.objectContaining({
            northUp: true,
            effectiveGsdM: 0.15
        }));
        expect(crop.body.crop.url).toBeUndefined();
    });

    it('proxies image evidence with explicit source and resolution headers', async () => {
        const imageApp = createRouteApp(setupLaneTopologyRoute, fakePool(), {
            cliEnabled: false,
            fetchImageryCrop: async (source, bbox) => ({
                buffer: Buffer.from([1, 2, 3]),
                contentType: 'image/jpeg',
                metadata: {
                    source: { key: source.key },
                    bbox,
                    width: 900,
                    height: 600,
                    effectiveGsdM: 0.15
                }
            })
        });
        const response = await request(imageApp)
            .get('/lane-topology/imagery/crop')
            .query({ bbox: '15.9610346,45.7979133,15.9622577,45.7986894' })
            .expect(200);
        expect(response.headers['content-type']).toContain('image/jpeg');
        expect(response.headers['x-imagery-source']).toBe('zagreb_cdof_2022');
        expect(response.headers['x-imagery-gsd-m']).toBe('0.15');
        expect(response.body).toEqual(Buffer.from([1, 2, 3]));
    });

    it('rejects unknown imagery sources before starting recognition', async () => {
        await request(app)
            .post('/lane-topology/process')
            .send({
                provider: 'codex',
                city: 'zagreb',
                bbox: [15.961, 45.797, 15.963, 45.799],
                imagerySource: 'google-satellite'
            })
            .expect(400);
        expect(pool.calls).toHaveLength(0);
    });

    it('rejects imagery recognition when a zoomed-out crop cannot resolve lane markings', async () => {
        const response = await request(app)
            .post('/lane-topology/process')
            .send({
                provider: 'codex',
                city: 'zagreb',
                bbox: [15.94, 45.79, 16.019, 45.83],
                imagerySource: 'zagreb_cdof_2022'
            })
            .expect(400);
        expect(response.body.error).toContain('Zoom in');
        expect(response.body.error).toContain('maximum 0.35 m/px');
        expect(pool.calls).toHaveLength(0);
    });

    it('stores a versioned local-CV width analysis without changing a topology solution', async () => {
        const calls = [];
        const widthPool = {
            calls,
            async query(sql, params) {
                calls.push({ sql, params });
                if (sql.includes('FROM osm_road')) {
                    return {
                        rows: [{
                            geometry: {
                                type: 'LineString',
                                coordinates: [[15.9615, 45.7982], [15.9615, 45.799]]
                            },
                            properties: {
                                osm_id: 'savska',
                                highway_type: 'secondary',
                                tags: { highway: 'secondary', lanes: '3' }
                            },
                            date_added: new Date('2026-07-22T20:42:11Z')
                        }]
                    };
                }
                if (sql.includes('INSERT INTO public.lane_width_analysis')) {
                    return {
                        rows: [{
                            id: 12,
                            parent_id: null,
                            city: 'zagreb',
                            area_key: 'area',
                            status: 'candidate',
                            method: 'road-aligned longitudinal paint recurrence',
                            algorithm_version: 'cdof-road-strip-v1',
                            imagery_source: 'zagreb_cdof_2022',
                            imagery_captured_at: '2022',
                            osm_snapshot_at: new Date('2026-07-22T20:42:11Z'),
                            osm_snapshot_id: params[8],
                            // Positional: osm_snapshot_id was inserted at 8, shifting these along.
                            selected_bbox: params[13],
                            coverage: null,
                            result: JSON.parse(params[14]),
                            stats: JSON.parse(params[15]),
                            created_at: new Date('2026-07-30T12:00:00Z'),
                            updated_at: new Date('2026-07-30T12:00:00Z')
                        }]
                    };
                }
                return { rows: [] };
            }
        };
        const widthApp = createRouteApp(setupLaneTopologyRoute, widthPool, {
            cliEnabled: false,
            roadsFetchImpl: fakeRoadsApi(),
            fetchImageryCrop: async (source, bbox) => ({
                buffer: Buffer.from([0xff, 0xd8, 0xff]),
                contentType: 'image/jpeg',
                metadata: {
                    source: { key: source.key, capturedAt: source.capturedAt },
                    bbox,
                    width: 600,
                    height: 700,
                    effectiveGsdM: 0.15
                }
            }),
            analyzeLaneWidths: async (_buffer, imagery, evidence) => ({
                schemaVersion: 1,
                algorithm: {
                    version: 'cdof-road-strip-v1',
                    method: 'road-aligned longitudinal paint recurrence'
                },
                source: { imagery, osmSnapshotAt: evidence.snapshotAt },
                measurements: {
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: [[15.9615, 45.7985], [15.96154, 45.7985]]
                        },
                        properties: {
                            kind: 'lane_width_candidate',
                            measuredWidthM: 3.1,
                            confidence: 0.82
                        }
                    }]
                },
                boundaries: { type: 'FeatureCollection', features: [] },
                stats: {
                    widthCandidates: 1,
                    medianWidthM: 3.1,
                    externalAiCostUsd: 0
                }
            })
        });

        const response = await request(widthApp)
            .post('/lane-topology/widths/analyze')
            .send({
                city: 'zagreb',
                bbox: [15.9612, 45.7981, 15.962, 45.7991],
                imagerySource: 'zagreb_cdof_2022'
            })
            .expect(201);

        expect(response.body.analysis).toEqual(expect.objectContaining({
            id: 12,
            status: 'candidate',
            algorithmVersion: 'cdof-road-strip-v1',
            imagerySource: 'zagreb_cdof_2022',
            stats: expect.objectContaining({
                widthCandidates: 1,
                externalAiCostUsd: 0
            })
        }));
        expect(response.body.analysis.result.measurements.features[0].properties.measuredWidthM).toBe(3.1);
        expect(calls.some(call => call.sql.includes('INSERT INTO public.lane_topology_solution'))).toBe(false);
    });

    it('rejects width analysis when the orthophoto crop is too coarse for paint', async () => {
        const response = await request(app)
            .post('/lane-topology/widths/analyze')
            .send({
                city: 'zagreb',
                bbox: [15.94, 45.79, 15.98, 45.82],
                imagerySource: 'zagreb_cdof_2022'
            })
            .expect(400);
        expect(response.body.error).toContain('Zoom in');
        expect(response.body.error).toContain('maximum 0.20 m/px');
        expect(pool.calls).toHaveLength(0);
    });

    // The page cap used to be silent: asking for 500 returned the newest 100 and said nothing, so
    // the coverage map and the worklist both counted 6 already-adjudicated solutions as open work.
    describe('solution list paging', () => {
        function poolWithSolutions(count) {
            return {
                calls: [],
                async query(sql, params) {
                    this.calls.push({ sql, params });
                    if (!sql.includes('FROM public.lane_topology_solution s')) return { rows: [] };
                    const [, limit, offset] = params;
                    const page = [];
                    for (let index = offset; index < Math.min(offset + limit, count); index += 1) {
                        page.push({
                            id: index + 1, city: 'zagreb', area_key: `k${index}`, status: 'candidate',
                            source_kind: 'claude', selected_bbox: [15.9, 45.8, 15.91, 45.81],
                            total_count: String(count), problem_counts: {}, stats: {}
                        });
                    }
                    return { rows: page };
                }
            };
        }

        it('reports the true total so a truncated page is recognisable', async () => {
            const listApp = createRouteApp(setupLaneTopologyRoute, poolWithSolutions(124), {});
            const response = await request(listApp)
                .get('/lane-topology/solutions?city=zagreb&limit=100')
                .expect(200);
            expect(response.body.solutions).toHaveLength(100);
            expect(response.body.total).toBe(124);
            expect(response.body.hasMore).toBe(true);
        });

        it('serves the tail through offset, and closes the list at the end', async () => {
            const listApp = createRouteApp(setupLaneTopologyRoute, poolWithSolutions(124), {});
            const response = await request(listApp)
                .get('/lane-topology/solutions?city=zagreb&limit=100&offset=100')
                .expect(200);
            expect(response.body.solutions).toHaveLength(24);
            expect(response.body.offset).toBe(100);
            expect(response.body.hasMore).toBe(false);
            // The 24 the old cap hid — ids 101..124, invisible to every report.
            expect(response.body.solutions[0].id).toBe(101);
            expect(response.body.solutions.at(-1).id).toBe(124);
        });

        it('pages until the list is complete rather than trusting one response', async () => {
            const listApp = createRouteApp(setupLaneTopologyRoute, poolWithSolutions(124), {});
            const server = listApp.listen(0);
            try {
                const base = `http://127.0.0.1:${server.address().port}`;
                const all = await listAllSolutions({ api: base, city: 'zagreb' });
                expect(all).toHaveLength(124);
                expect(new Set(all.map(solution => solution.id)).size).toBe(124);
            } finally {
                server.close();
            }
        });
    });
});
