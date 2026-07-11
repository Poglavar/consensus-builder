// Unit tests for descendant parcel allocator keys shared by corridor and remainder generation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syntheticParcelAllocatorKey } = require('../../frontend/js/synthetic-parcel-identity.js');

describe('synthetic descendant parcel identity', () => {
    it('uses the cadastral root ID even when root-number metadata differs', () => {
        expect(syntheticParcelAllocatorKey('US-NY-123', 'Block 10 Lot 4'))
            .toBe(syntheticParcelAllocatorKey('US-NY-123', '10/4'));
    });

    it('keeps different cadastral roots in separate allocator sequences', () => {
        expect(syntheticParcelAllocatorKey('US-NY-123', '10/4'))
            .not.toBe(syntheticParcelAllocatorKey('US-NY-124', '10/4'));
    });

    it('falls back to the root number when no usable root ID exists', () => {
        expect(syntheticParcelAllocatorKey('', '10/4')).toBe('number:10/4');
        expect(syntheticParcelAllocatorKey('parcel', '10/4')).toBe('number:10/4');
    });
});
