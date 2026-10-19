import { describe, expect, it } from 'vitest';
import { createParcelAttributeFilter } from '../parcels/source-contract.js';

describe('typed parcel attribute scope', () => {
    it('enforces publisher-coded ground scope on qualified ArcGIS columns', () => {
        const field = 'PGIS.PGIS.ParcelsPublic.PARCELSUBTYPE';
        const descriptor = { adapter: 'arcgis', outFields: [field], attributeFilters: { [field]: 0 } };
        const filter = createParcelAttributeFilter(descriptor);
        expect(filter.where).toBe(`${field} = 0`);
        expect(filter.matches({ [field]: 0 })).toBe(true);
        for (const value of [1, 2, null, undefined, '0']) expect(filter.matches({ [field]: value })).toBe(false);
        // Other query languages retain their existing unqualified field contract.
        expect(() => createParcelAttributeFilter({ ...descriptor, adapter: 'wfs' })).toThrow();
        for (const invalid of ['schema..field', 'schema.field OR 1=1', 'schema.field;DROP', '*']) {
            expect(() => createParcelAttributeFilter({ adapter: 'arcgis', outFields: [invalid],
                attributeFilters: { [invalid]: 0 } })).toThrow();
        }
    });
    it('queries numeric lifecycle codes as integers and checks the same types in the response', () => {
        const filter = createParcelAttributeFilter({ outFields: ['status', 'elev_flag'], attributeFilters: { status: [1, 3], elev_flag: 0 } });
        expect(filter.where).toBe('status IN (1,3) AND elev_flag = 0');
        expect(filter.matches({ status: 1, elev_flag: 0 })).toBe(true);
        expect(filter.matches({ status: 3, elev_flag: 0 })).toBe(true);
        for (const props of [{ status: 2, elev_flag: 0 }, { status: '1', elev_flag: 0 }, { status: 1, elev_flag: null }, { status: 1 }]) {
            expect(filter.matches(props)).toBe(false);
        }
    });

    it('retains string codes and rejects unsafe or missing numeric scope values', () => {
        const strings = createParcelAttributeFilter({ outFields: ['code'], attributeFilters: { code: '001' } });
        expect(strings.where).toBe("code = '001'");
        expect(strings.matches({ code: '001' })).toBe(true);
        expect(strings.matches({ code: 1 })).toBe(false);
        for (const value of [null, undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => createParcelAttributeFilter({ outFields: ['status'], attributeFilters: { status: value } })).toThrow('Invalid parcel attribute filter.');
        }
    });
});
