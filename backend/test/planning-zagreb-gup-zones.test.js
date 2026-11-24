import { describe, expect, it } from 'vitest';
import { readZagrebRecord, readZagrebParcel } from '../planning/providers/zagreb-gup.js';

describe('Zagreb GUP Map 1 exact records', () => {
    it('resolves an overview hash to the unsimplified full polygon', async () => {
        const [record] = await readZagrebRecord({}, { recordId: '000430f3ec13c828d392ad837a17e96be4d4c53f63854e5ccf55a9f2b2f42a49', edition: '2025' });
        expect(record).toMatchObject({ id: 'zagreb-gup-2025:000430f3ec13c828d392ad837a17e96be4d4c53f63854e5ccf55a9f2b2f42a49', assessment: { meaning: 'zoning-area' } });
        expect(record.site).toEqual(record.areas[0].geometry);
        expect(record.use.label).toEqual(record.sourceEvidence.use);
        expect(record.site.coordinates[0].length).toBeGreaterThan(5);
    });
    it('keeps cadastral parcel records on the existing path', async () => {
        const rows = await readZagrebParcel({ query: async () => ({ rows: [] }) }, { parcel: 'not-a-map1-hash', edition: '2025' });
        expect(rows).toEqual([]);
    });
});
