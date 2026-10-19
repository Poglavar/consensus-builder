import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchNycOwners, parseBbl, isPlaceholderOwner, __clearCache } from '../routes/nyc-condo-owners.js';

// Builds a Socrata-style PVAD response (one row per lot/year) for a fake block.
function pvadResponse(rows) {
    return { ok: true, json: async () => rows, text: async () => '' };
}

beforeEach(() => __clearCache());
afterEach(() => vi.restoreAllMocks());

describe('parseBbl', () => {
    it('parses a 10-digit sbl into borough/block/lot', () => {
        expect(parseBbl('1005527502')).toEqual({ boro: 1, block: 552, lot: 7502 });
    });

    it('strips the 6-digit SWIS prefix from a 16-digit swis_sbl_id', () => {
        expect(parseBbl('6201001005527502')).toEqual({ boro: 1, block: 552, lot: 7502 });
    });

    it('rejects malformed or out-of-range values', () => {
        expect(parseBbl('')).toBeNull();
        expect(parseBbl('123')).toBeNull();
        expect(parseBbl('9005527502')).toBeNull(); // borough 9 does not exist
    });
});

describe('isPlaceholderOwner', () => {
    it('matches the NY State placeholder case/space-insensitively', () => {
        expect(isPlaceholderOwner('UNAVAILABLE OWNER')).toBe(true);
        expect(isPlaceholderOwner('  unavailable   owner ')).toBe(true);
        expect(isPlaceholderOwner('JOEL SHARIR')).toBe(false);
    });
});

describe('fetchNycOwners', () => {
    const block552 = [
        // Condo billing lots (>= 7500): placeholder or single bubbled-up name
        { lot: '7502', year: '2027', owner: 'UNAVAILABLE OWNER', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
        { lot: '7503', year: '2027', owner: 'UNAVAILABLE OWNER', housenum_lo: '135', street_name: 'WEST 4 STREET' },
        // Unit lots for 106 WAVERLY PLACE (the building behind billing lot 7502)
        { lot: '1101', year: '2027', owner: 'JOEL SHARIR', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
        { lot: '1102', year: '2026', owner: 'JANE DOE', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
        { lot: '1102', year: '2027', owner: 'JOHN ROE', housenum_lo: '106', street_name: 'WAVERLY PLACE' }, // newer year wins
        { lot: '1103', year: '2027', owner: 'UNAVAILABLE OWNER', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
        // Unit lots for a different building on the same block — must not leak in
        { lot: '1201', year: '2027', owner: 'OTHER PERSON', housenum_lo: '135', street_name: 'WEST 4 STREET' },
    ];

    it('returns individual condo unit owners for a billing lot, by building address', async () => {
        const fetchImpl = vi.fn(async () => pvadResponse(block552));
        const result = await fetchNycOwners('1005527502', { env: {}, fetchImpl }); // lot 7502 -> 106 Waverly

        expect(result.matched).toBe('unit');
        // Latest year per lot, placeholder dropped, other building excluded
        expect(result.owners.sort()).toEqual(['JOEL SHARIR', 'JOHN ROE']);
    });

    it('caches the block so a second unit in the same building does not re-fetch', async () => {
        const fetchImpl = vi.fn(async () => pvadResponse(block552));
        await fetchNycOwners('1005527502', { env: {}, fetchImpl });
        await fetchNycOwners('1005527502', { env: {}, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('falls back to a real owner on the exact lot when no units resolve', async () => {
        const rows = [
            { lot: '53', year: '2023', owner: 'UNAVAILABLE OWNER', housenum_lo: '14', street_name: 'WEST 4 STREET' },
            { lot: '53', year: '2025', owner: 'REAL OWNER LLC', housenum_lo: '14', street_name: 'WEST 4 STREET' },
        ];
        const fetchImpl = vi.fn(async () => pvadResponse(rows));
        const result = await fetchNycOwners('1005520053', { env: {}, fetchImpl }); // lot 53, not a condo

        expect(result.matched).toBe('exact');
        expect(result.owners).toEqual(['REAL OWNER LLC']);
    });

    it('returns nothing when DOF also has no real owner', async () => {
        const rows = [{ lot: '53', year: '2025', owner: 'UNAVAILABLE OWNER', housenum_lo: '14', street_name: 'WEST 4 STREET' }];
        const fetchImpl = vi.fn(async () => pvadResponse(rows));
        const result = await fetchNycOwners('1005520053', { env: {}, fetchImpl });
        expect(result).toEqual({ owners: [], matched: 'none', year: null, fetchedAt: expect.any(Number) });
    });

    it('throws on a non-ok Socrata response', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'busy' }));
        await expect(fetchNycOwners('1005527502', { env: {}, fetchImpl })).rejects.toThrow('NYC DOF HTTP 503');
    });
});
