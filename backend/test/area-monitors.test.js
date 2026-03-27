import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAreaMonitorTestApp } from './helpers/create-area-monitor-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createAreaMonitorTestApp(pool);
});

describe('GET /area-monitors/:id', () => {
    it('builds ownership summaries from parcel_detail matched by logical parcel keys', async () => {
        pool.setResults([
            {
                rows: [{
                    id: 1,
                    name: 'Zapadni Jarunski Most',
                    polygon: {
                        type: 'Polygon',
                        coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]]
                    },
                    parcel_ids: ['HR-339318-7396', 'HR-339318-7398'],
                    parcel_count: 2,
                    eojn_url: null,
                    skyscrapercity_url: null,
                    created_at: '2026-03-27T00:10:40.993Z',
                    updated_at: '2026-03-27T00:10:40.993Z'
                }],
                rowCount: 1
            },
            {
                rows: [{
                    maticni_broj_ko: 339318,
                    broj_cestice: '7396',
                    details: {
                        possessionSheets: [{
                            possessors: [{
                                name: 'GRAD ZAGREB',
                                ownership: '1/1'
                            }]
                        }]
                    }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.summary).toEqual({
            total: 2,
            governmentOwned: 1,
            remaining: 1
        });
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-7396', ownershipType: 'government' },
            { parcelId: 'HR-339318-7398', ownershipType: null }
        ]);

        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1].sql).toContain('parcel_detail_with_keys');
        expect(calls[1].sql).not.toContain('p.current = true');
    });
});