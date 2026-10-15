// Keep archive evidence and writes separate from read-only spatial reference lookups.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    readSourceEvidence: vi.fn(),
    siteCandidates: vi.fn(),
    zagrebStreetIndex: vi.fn(),
}));

vi.mock('../floor-plans/compact-sources.js', () => ({ readSourceEvidence: mocks.readSourceEvidence }));
vi.mock('../floor-plans/site-candidates.js', () => ({
    siteCandidates: mocks.siteCandidates,
    zagrebStreetIndex: mocks.zagrebStreetIndex,
}));

import { locateListing, locateSites } from '../floor-plans/locate-sites.js';

describe('site-location reference database routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSourceEvidence.mockResolvedValue({ building: { text: 'Address: Ilica 12' } });
        mocks.siteCandidates.mockResolvedValue([]);
        mocks.zagrebStreetIndex.mockResolvedValue([{ name: 'Ilica', tokens: ['ilic'] }]);
    });

    it('keeps source evidence local and routes candidate reads to referencesDb', async () => {
        const localDb = { query: vi.fn() };
        const referencesDb = { query: vi.fn() };
        const listing = { url: 'https://agency.test/listing/1', facts: {}, current_sha256: 'hash' };
        await locateListing(localDb, listing, { referencesDb, streetIndex: [{ name: 'Ilica', tokens: ['ilic'] }] });

        expect(mocks.readSourceEvidence).toHaveBeenCalledWith(localDb, expect.objectContaining({ url: listing.url, sha256: 'hash' }));
        expect(mocks.siteCandidates).toHaveBeenCalledWith(referencesDb, expect.objectContaining({ streets: expect.any(Array) }));
        expect(localDb.query).not.toHaveBeenCalled();
        expect(referencesDb.query).not.toHaveBeenCalled();
    });

    it('loads streets and candidates from referencesDb while checkpointing the allowlisted listings locally', async () => {
        const listing = { url: 'https://agency.test/listing/1', facts: {}, current_sha256: 'hash', last_observed_at: null };
        const localQueries = [];
        const localDb = { async query(sql) {
            localQueries.push(sql);
            if (/SELECT l\.url, l\.facts/.test(sql)) return { rows: [listing] };
            return { rows: [], rowCount: 1 };
        } };
        const referencesDb = { query: vi.fn() };
        const result = await locateSites(localDb, { urls: [listing.url], referencesDb, log: () => {} });

        expect(result).toMatchObject({ selected: 1, processed: 1, unresolved: 1 });
        expect(mocks.zagrebStreetIndex).toHaveBeenCalledWith(referencesDb);
        expect(mocks.siteCandidates).toHaveBeenCalledWith(referencesDb, expect.any(Object));
        expect(localQueries[0]).toContain('l.url = ANY($1::text[])');
        expect(localQueries.some(sql => /^\s*UPDATE floor_plan\.listing/.test(sql))).toBe(true);
        expect(referencesDb.query).not.toHaveBeenCalled();
    });

    it('defaults referencesDb to the original database for existing callers', async () => {
        const db = { query: vi.fn() };
        await locateListing(db, { url: 'https://agency.test/1', facts: {}, current_sha256: 'hash' }, { streetIndex: [] });
        expect(mocks.siteCandidates).toHaveBeenCalledWith(db, expect.any(Object));
    });
});
