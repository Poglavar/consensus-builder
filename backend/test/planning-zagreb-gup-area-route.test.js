import { describe, expect, it } from 'vitest';
import { setupPlanningRoutes } from '../routes/planning.js';
import { getPlanningSources } from '../planning/sources.js';

const point = [15.9544, 45.8024];
const source = 'zagreb-gup-2025';
function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } , set() {}, removeHeader() {} }; }

describe('Zagreb planning-area discovery route', () => {
    it('finds a bounded Map 1 zone and reopens its exact record, while parcel lookup stays empty', async () => {
        const handlers = {};
        let dbReads = 0;
        const pool = { query: async () => { dbReads++; throw new Error('zone lookup must not query DB'); } };
        setupPlanningRoutes({ post() {}, get: (path, fn) => { handlers[path] = fn; } }, pool, { sources: getPlanningSources() });
        const found = response();
        await handlers['/planning/areas']({ query: { city: 'zagreb', source, lon: String(point[0]), lat: String(point[1]) } }, found);
        expect(found.statusCode).toBe(200);
        expect(found.body.items).toHaveLength(1);
        const { recordId } = found.body.items[0].planningArea;
        expect(recordId).toMatch(/^[a-f0-9]{64}$/);
        const record = response();
        await handlers['/planning/record']({ query: { city: 'zagreb', source, recordId } }, record);
        expect(record.statusCode).toBe(200);
        expect(record.body.items[0].site).toEqual(record.body.items[0].areas[0].geometry);
        const parcel = response();
        await handlers['/planning/parcel']({ query: { city: 'zagreb', source, parcel: recordId } }, parcel);
        expect(parcel.statusCode).toBe(200);
        expect(parcel.body.items).toEqual([]);
        expect(dbReads).toBe(0);
    });
});
