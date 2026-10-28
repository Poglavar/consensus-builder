// Complete inventory evidence distinguishes a known empty parcel from an unmeasured one.
import { describe, expect, it } from 'vitest';
import { buildingBaseline } from '../agents/building-baseline.js';

const complete = {
    buildingSourceId: 'survey-fixture', buildingCoverage: 'complete',
    buildingCount: 0, builtFootprintM2: 0, builtGfaM2: 0
};

describe('existing-building baseline', () => {
    it('preserves a documented empty inventory as known zero', () => {
        expect(buildingBaseline(complete)).toEqual({ ...complete, builtKnown: true });
    });

    it.each([undefined, null, {}, false, { ...complete, buildingCoverage: 'unknown' },
        { ...complete, buildingCoverage: 'partial' }, { ...complete, buildingSourceId: null }])(
        'does not invent a complete inventory from %j', input => {
            expect(buildingBaseline(input)).toMatchObject({
                buildingCount: null, builtFootprintM2: null, builtGfaM2: null, builtKnown: false
            });
        }
    );

    it.each([null, undefined, false, true, '', '0', -1, NaN, Infinity])(
        'keeps invalid floor area %j unknown even for a complete inventory', builtGfaM2 => {
            expect(buildingBaseline({ ...complete, builtGfaM2 })).toMatchObject({ builtGfaM2: null, builtKnown: false });
        }
    );

    it('retains measured footprint and count when floor area is unavailable', () => {
        expect(buildingBaseline({ ...complete, buildingCount: 2, builtFootprintM2: 100, builtGfaM2: null }))
            .toEqual({ ...complete, buildingCount: 2, builtFootprintM2: 100, builtGfaM2: null, builtKnown: false });
    });

    it('does not overrule an explicit unknown flag with a numeric placeholder', () => {
        expect(buildingBaseline({ ...complete, builtKnown: false })).toMatchObject({ builtGfaM2: null, builtKnown: false });
    });

    it('validates each inventory quantity without erasing other supported quantities', () => {
        expect(buildingBaseline({ ...complete, buildingCount: 1.5, builtFootprintM2: -3, builtGfaM2: 120 }))
            .toMatchObject({ buildingCount: null, builtFootprintM2: null, builtGfaM2: 120, builtKnown: true });
    });
});
