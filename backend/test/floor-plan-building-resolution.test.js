// Purpose: exercise address gates, binding validation, fair resolution checkpoints, and stale identity reset.
import { describe, expect, it, vi } from 'vitest';
import { saveObservation } from '../floor-plans/archive.js';
import { addressKey, augmentReviewedUnitAssets, chooseAddressedBuilding, importBuildingBindings, prepareBinding, resolveBuildingLinks, seedReviewedBindings } from '../floor-plans/building-resolution.js';
import { matchBuildingCandidates } from '../floor-plans/building-links.js';

const binding = overrides => ({
    city: 'zagreb', source: 'zagreb-3d', ownerId: '', buildingId: '42', name: 'Example Building',
    match: { kind: 'address', value: 'Ilica 1, 10000 Zagreb' },
    evidence: { basis: 'Reviewed survey source', sourceUrl: 'https://source.test/building/42' },
    ...overrides,
});

describe('address building resolution', () => {
    it('requires a real street and house number, excluding postcode-only forms', () => {
        expect(addressKey('10000 Zagreb')).toBeNull();
        expect(addressKey('Zagreb10000')).toBeNull();
        expect(addressKey('10000')).toBeNull();
        expect(addressKey('Ilica1,10000 Zagreb')).toBe('ilica 1');
        expect(addressKey('Ilica 1, 10000 Zagreb')).toBe('ilica 1');
        expect(addressKey('Ulica grada Vukovara 52A-54, 10000 Zagreb')).toBe('grada vukovara 52a-54');
        expect(addressKey('Ilica 1/2')).toBe('ilica 1/2');
    });

    it('only joins an exact street and house number with corroborating coordinates', () => {
        const row = { address: 'Ilica 1A, 10000 Zagreb', building_id: '42', lat: 45.81, lng: 15.98 };
        expect(chooseAddressedBuilding({ facts: { address: 'Ilica 1, 10000 Zagreb', coordinates: { lat: 45.81, lng: 15.98 } } }, [row])).toBeNull();
        expect(chooseAddressedBuilding({ facts: { address: '10000 Zagreb', coordinates: { lat: 45.81, lng: 15.98 } } }, [{ ...row, address: '10000 Zagreb' }])).toBeNull();
        expect(chooseAddressedBuilding({ url: 'https://agency.test/listing', facts: { address: 'Ilica 1A, 10000 Zagreb', coordinates: { lat: 45.81, lng: 15.98 } } }, [row])?.building_id).toBe('42');
    });
});

describe('building binding validation', () => {
    it('normalizes a valid exact address binding and rejects malformed identity or evidence fields', () => {
        expect(prepareBinding(binding()).matchValue).toBe('ilica 1');
        expect(() => prepareBinding(binding({ city: 'Zagreb, Croatia' }))).toThrow(/canonical identifiers/);
        expect(() => prepareBinding(binding({ source: 'zagre b' }))).toThrow(/canonical identifiers/);
        expect(() => prepareBinding(binding({ name: ' ' }))).toThrow(/building name/);
        expect(() => prepareBinding(binding({ evidence: { basis: 'Reviewed' } }))).toThrow(/source evidence/);
        expect(() => prepareBinding(binding({ match: { kind: 'address', value: '10000 Zagreb' } }))).toThrow(/exact match/);
    });

    it('validates a complete import before writing any bindings', async () => {
        const db = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
        await expect(importBuildingBindings(db, { schema: 'consensus-builder.building-bindings.v1', bindings: [binding(), binding({ source: 'bad source' })] })).rejects.toThrow(/canonical identifiers/);
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('building resolution queue checkpoints', () => {
    it('orders unchecked listings first and checkpoints unresolved outcomes to prevent starvation', async () => {
        const calls = [];
        const db = { query: vi.fn(async (sql, params = []) => {
            calls.push([sql, params]);
            if (sql === 'SELECT * FROM floor_plan.building_binding') return { rows: [] };
            if (sql.includes('to_regclass')) return { rows: [{ addresses: null, matches: null, buildings: null }] };
            if (sql.includes("evidence ? 'projectListings'")) return { rows: [] };
            if (sql.startsWith('SELECT url,facts,match_status')) return { rows: [
                { url: 'https://agency.test/a', facts: {}, match_status: 'unresolved' },
                { url: 'https://agency.test/b', facts: {}, match_status: 'candidate' },
            ] };
            return { rowCount: 1, rows: [] };
        }) };
        const result = await resolveBuildingLinks(db, { limit: 2, log: () => {} });
        const select = calls.find(([sql]) => sql.startsWith('SELECT url,facts,match_status'))[0];
        expect(select).toContain('ORDER BY match_checked_at NULLS FIRST,match_checked_at,updated_at,url');
        expect(select).toContain("match_checked_at<=now()-interval '1 day'");
        const checkpointUpdates = calls.filter(([sql]) => sql.includes('SET match_checked_at=now()'));
        expect(checkpointUpdates).toHaveLength(2);
        expect(result).toMatchObject({ processed: 2, verified: 0, unresolved: 2 });
    });

    it('returns deferred counts without processing a batch after its deadline', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(200);
        const rows = [1, 2, 3].map(id => ({ url: `https://agency.test/${id}`, facts: {}, match_status: 'unresolved' }));
        const resolverDb = { query: vi.fn(async sql => {
            if (sql === 'SELECT * FROM floor_plan.building_binding') return { rows: [] };
            if (sql.includes('to_regclass')) return { rows: [{ addresses: null, matches: null, buildings: null }] };
            if (sql.includes("evidence ? 'projectListings'")) return { rows: [] };
            if (sql.startsWith('SELECT url,facts,match_status')) return { rows };
            return { rowCount: 1, rows: [] };
        }) };
        const exact = await resolveBuildingLinks(resolverDb, { limit: 3, deadline: 100, log: () => {} });
        expect(exact).toMatchObject({ processed: 0, deferred: 3 });
        expect(resolverDb.query.mock.calls.some(([sql]) => sql.includes('SET match_checked_at=now()'))).toBe(false);

        const candidateDb = { query: vi.fn(async sql => sql.startsWith('SELECT url,facts FROM floor_plan.listing')
            ? { rows: rows.map(row => ({ url: row.url, facts: { coordinates: { lat: 45.8, lng: 15.9 } } })) }
            : { rows: [] }) };
        const spatial = await matchBuildingCandidates(candidateDb, { limit: 3, deadline: 100 });
        expect(spatial).toEqual({ candidates: 0, unresolved: 0, deferred: 3 });
        now.mockRestore();
    });
});

it('augments only exact reviewed listings with an archived matching asset hash, without replacing other links', async () => {
    const valid = {
        url: 'https://eurovilla.hr/nekretnina/unit/842475/', source_id: '842475',
        facts: { sourceId: '842475' }, asset_urls: [{ url: 'https://eurovilla.hr/api/blueprint/?link=842475%2FA52.jpg', listingOwned: true }],
    };
    const mismatched = {
        url: 'https://eurovilla.hr/nekretnina/unit/383380/', source_id: '383380',
        facts: { sourceId: '383380' }, asset_urls: [],
    };
    const targets = new Map([
        ['https://s3.test/842475/A52.jpg', 'a'.repeat(64)],
        ['https://s3.test/383380/A62.jpg', 'b'.repeat(64)],
    ]);
    const db = { query: vi.fn(async (sql, params = []) => {
        if (!sql.includes('UPDATE floor_plan.listing l')) return { rowCount: 1, rows: [] };
        const [listingUrl, sourceId, encodedAsset, assetUrl, sha] = params;
        const listing = [valid, mismatched].find(row => row.url === listingUrl && row.source_id === sourceId && row.facts.sourceId === sourceId);
        if (!listing || targets.get(assetUrl) !== sha || listing.asset_urls.some(asset => asset.url === assetUrl)) return { rowCount: 0, rows: [] };
        listing.asset_urls.push(...JSON.parse(encodedAsset));
        return { rowCount: 1, rows: [{ url: listingUrl }] };
    }) };
    const units = [
        { listingUrl: valid.url, url: 'https://s3.test/842475/A52.jpg', sha256: 'a'.repeat(64) },
        { listingUrl: valid.url, url: 'https://s3.test/842475/A52.jpg', sha256: 'a'.repeat(64) }, // duplicate is a no-op
        { listingUrl: mismatched.url, url: 'https://s3.test/383380/A62.jpg', sha256: 'c'.repeat(64) }, // archived bytes differ
        { listingUrl: 'https://eurovilla.hr/nekretnina/unit/999999/', url: 'https://s3.test/missing.jpg', sha256: 'd'.repeat(64) },
    ];
    expect(await augmentReviewedUnitAssets(db, units)).toEqual({ reviewedAssetsAttached: 1, reviewedAssetsSkipped: 3 });
    expect(valid.asset_urls).toHaveLength(2);
    expect(valid.asset_urls[1]).toMatchObject({
        url: 'https://s3.test/842475/A52.jpg', kind: 'floor-plan', listingOwned: true,
        associationBasis: 'reviewed-source-manifest', evidenceUrl: 'https://s3.test/842475/A52.jpg', sha256: 'a'.repeat(64),
    });
    expect(mismatched.asset_urls).toEqual([]);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("l.facts->>'sourceId'=$2");
    expect(sql).toContain('t.current_sha256=$5');
    expect(sql).toContain("q.asset->>'url'=$4");
    expect(sql).toContain('q.asset || ($3::jsonb->0)');
    expect(sql).toContain('NOT (COALESCE(l.asset_urls');
});

it('seeds explicit manifest ownership links after importing the reviewed bindings', async () => {
    const calls = [];
    const db = { query: vi.fn(async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.startsWith('UPDATE floor_plan.listing l')) return { rowCount: 1, rows: [{ url: params[0] }] };
        return { rowCount: 1, rows: [] };
    }) };
    const result = await seedReviewedBindings(db);
    expect(result.bindings).toBe(6);
    expect(result.reviewedAssetsAttached).toBe(5);
    const firstAugmentation = calls.findIndex(([sql]) => sql.startsWith('UPDATE floor_plan.listing l'));
    expect(firstAugmentation).toBeGreaterThan(0);
    expect(calls.slice(0, firstAugmentation).every(([sql]) => sql.includes('INSERT INTO floor_plan.building_binding'))).toBe(true);
    expect(calls.slice(firstAugmentation).every(([sql]) => sql.includes('t.current_sha256=$5'))).toBe(true);
});

it('clears stale building identity when newly observed listing facts change', async () => {
    const calls = [];
    const db = { query: vi.fn(async (sql, params = []) => { calls.push([sql, params]); return { rowCount: 1, rows: [] }; }) };
    await saveObservation(db, { url: 'https://agency.test/listing', kind: 'page', agency_id: 4 },
        { body: Buffer.from('html'), status: 200, headers: { contentType: 'text/html' } },
        { listing: { address: 'Ilica 2' }, assets: [] }, 'run-1');
    const upsert = calls.find(([sql]) => sql.includes('INSERT INTO floor_plan.listing AS l'))[0];
    expect(upsert).toContain("match_status=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN 'unresolved'");
    expect(upsert).toContain('building_city=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL');
    expect(upsert).toContain("building_owner_id=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN ''");
    expect(upsert).toContain('match_checked_at=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL');
});
