// Purpose: characterize crawler discovery and archive validation without network or PostgreSQL.
import { describe, expect, it, vi } from 'vitest';
import { crawl, discoverTargets } from '../floor-plans/crawler.js';
import { countPendingTargets, createTargetSelector } from '../floor-plans/crawl-queue.js';
import { importAgencies, saveObservation } from '../floor-plans/archive.js';
import { seedKnownSites } from '../floor-plans/agency-sites.js';

const response = (body, contentType = 'text/html') => ({ body: Buffer.from(body), headers: { contentType }, finalUrl: 'https://agency.test/home', status: 200 });

describe('floor-plan crawler boundaries', () => {
    it('discovers same-site sitemap URLs and rejects cross-host entries', () => {
        const result = discoverTargets(
            { kind: 'sitemap', url: 'https://agency.test/sitemap.xml' },
            response('<urlset><url><loc>https://agency.test/a</loc></url><url><loc>https://other.test/x</loc></url></urlset>', 'application/xml'),
            { links: [], assets: [] },
        );
        expect(result).toEqual([{ url: 'https://agency.test/a', kind: 'page', priority: 10 }]);
    });

    it('handles sitemap indexes and prioritizes floor-plan assets', () => {
        const sitemap = discoverTargets({ kind: 'sitemap', url: 'https://agency.test/sitemap.xml' }, response('<sitemapindex><sitemap><loc>https://agency.test/a.xml</loc></sitemap><sitemap><loc>https://cdn.test/b.xml</loc></sitemap></sitemapindex>', 'application/xml'), { links: [], assets: [] });
        expect(sitemap).toEqual([{ url: 'https://agency.test/a.xml', kind: 'sitemap', priority: 10 }]);
        const page = discoverTargets({ kind: 'page', url: 'https://agency.test/home' }, response(''), { links: [
            { url: 'https://agency.test/login', kind: 'listing' },
            { url: 'https://agency.test/project', kind: 'project' },
        ], assets: [
            { url: 'https://cdn.test/tlocrt-a.pdf', kind: 'floor-plan' },
            { url: 'https://cdn.test/brochure.pdf', kind: 'document' },
        ] });
        expect(page).toEqual(expect.arrayContaining([
            { url: 'https://agency.test/project', kind: 'page', priority: 30 },
            { url: 'https://cdn.test/tlocrt-a.pdf', kind: 'asset', priority: 100 },
            { url: 'https://cdn.test/brochure.pdf', kind: 'asset', priority: 100 },
        ]));
        expect(page.find(item => item.url.endsWith('/login'))).toBeUndefined();
    });

    it('does not rediscover assets from an asset target', () => {
        expect(discoverTargets({ kind: 'asset', url: 'https://cdn.test/a.pdf' }, response(''), { links: [{ url: 'https://agency.test/x', kind: 'listing' }], assets: [{ url: 'https://cdn.test/b.pdf', kind: 'floor-plan' }] })).toEqual([]);
    });

    it('classifies PDF links through asset evidence without also queueing them as pages', () => {
        const url = 'https://agency.test/tlocrt-unit.pdf';
        expect(discoverTargets({ kind: 'page', url: 'https://agency.test/listing' }, response(''), {
            links: [{ url, kind: 'other' }],
            assets: [{ url, kind: 'floor-plan' }],
        })).toEqual([{ url, kind: 'asset', priority: 100 }]);
    });
});

describe('floor-plan queue fairness', () => {
    const makeDb = ({ includeUnmatchedAssets = false } = {}) => {
        const targets = [
        { url: 'https://a.test/', kind: 'home', priority: 60, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/', kind: 'home', priority: 60, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://a.test/sitemap.xml', kind: 'sitemap', discovered_from: 'https://a.test/', priority: 40, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/sitemap.xml', kind: 'sitemap', discovered_from: 'https://b.test/', priority: 40, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://a.test/nested.xml', kind: 'sitemap', discovered_from: 'https://a.test/sitemap.xml', priority: 40, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://a.test/project', kind: 'page', priority: 30, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://a.test/project-2', kind: 'page', priority: 30, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/project', kind: 'page', priority: 30, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/project-2', kind: 'page', priority: 30, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/plan.pdf', kind: 'asset', priority: 101, matchStatus: 'verified', buildingId: 'b-1', owned: true, last_fetched_at: null, next_check_at: 0 },
        { url: 'https://b.test/plan-2.pdf', kind: 'asset', priority: 100, matchStatus: 'verified', buildingId: 'b-1', owned: true, last_fetched_at: null, next_check_at: 0 },
        ];
        if (includeUnmatchedAssets) targets.push(
            { url: 'https://b.test/unmatched.pdf', kind: 'asset', priority: 100, matchStatus: 'candidate', buildingId: null, owned: true, last_fetched_at: null, next_check_at: 0 },
            { url: 'https://b.test/not-owned.pdf', kind: 'asset', priority: 100, matchStatus: 'verified', buildingId: 'b-1', owned: false, last_fetched_at: null, next_check_at: 0 },
        );
        return { query: vi.fn(async (sql, [, excluded]) => {
        const kindClause = sql.match(/AND (t\.kind(?: IN \([^)]*\)|='[^']+'))/);
        const kinds = kindClause?.[1].match(/'([^']+)'/g)?.map(k => k.slice(1, -1)) || [];
        const nestedSitemaps = sql.includes("t.discovered_from IS NOT NULL AND regexp_replace");
        const rootSitemaps = sql.includes("t.discovered_from IS NULL OR regexp_replace");
        const matched = sql.includes("l.match_status='verified'");
        const rows = targets.filter(t => t.next_check_at === 0 && kinds.includes(t.kind) && !(nestedSitemaps && !t.discovered_from?.endsWith('/sitemap.xml')) && !(rootSitemaps && t.discovered_from?.endsWith('/sitemap.xml')) && !excluded.includes(new URL(t.url).host.replace(/^www\./, '')) && (!matched || (t.kind !== 'asset' || (t.matchStatus === 'verified' && t.buildingId && t.owned))));
        rows.sort((a, b) => (a.last_fetched_at === null ? -1 : 1) - (b.last_fetched_at === null ? -1 : 1) || b.priority - a.priority || a.url.localeCompare(b.url));
        if (rows[0]) rows[0].next_check_at = Infinity; // A fetch moves the selected target out of the due queue.
        return { rows: rows.slice(0, 1) };
        }) };
    };

    it('covers known site roots across hosts before pages and assets, regardless of asset priority', async () => {
        const db = makeDb();
        const next = createTargetSelector();
        expect((await next(db)).url).toBe('https://a.test/');
        expect((await next(db)).url).toBe('https://b.test/');
        expect((await next(db)).url).toBe('https://a.test/sitemap.xml');
        expect((await next(db)).url).toBe('https://b.test/sitemap.xml');
        expect((await next(db)).url).toBe('https://a.test/nested.xml');
        expect((await next(db)).url).toBe('https://a.test/project');
        expect((await next(db)).url).toBe('https://b.test/plan.pdf');
        expect((await next(db)).url).toBe('https://b.test/project');
        expect((await next(db)).url).toBe('https://b.test/plan-2.pdf');
        expect((await next(db)).url).toBe('https://a.test/project-2');
        expect((await next(db)).url).toBe('https://b.test/project-2');
        expect(await next(db)).toBeNull();
    });

    it('supports discovery-only and matched-asset-only queue modes', async () => {
        const db = makeDb({ includeUnmatchedAssets: true });
        const discovery = createTargetSelector({ discoveryOnly: true });
        expect((await discovery(db)).kind).toBe('home');
        expect((await discovery(db)).kind).toBe('home');
        expect((await discovery(db)).kind).toBe('sitemap');
        expect((await discovery(db)).kind).toBe('sitemap');
        expect((await discovery(db)).kind).toBe('sitemap');
        expect((await discovery(db)).kind).toBe('page');
        expect((await discovery(db)).kind).toBe('page');
        expect((await discovery(db)).kind).toBe('page');
        expect((await discovery(db)).kind).toBe('page');
        expect(await discovery(db)).toBeNull();
        const matchedAssets = createTargetSelector({ assetOnly: true, matchedAssetsOnly: true });
        expect((await matchedAssets(db)).url).toBe('https://b.test/plan.pdf');
        expect((await matchedAssets(db)).url).toBe('https://b.test/plan-2.pdf');
        expect(await matchedAssets(db)).toBeNull();
    });
});

it('requeues normalized known agency sites and excludes social profile hosts', async () => {
    const calls = [];
    const db = { query: vi.fn(async (sql, params) => {
        calls.push([sql, params]);
        if (sql.startsWith('SELECT url,agency_id')) return { rows: [
            { url: 'https://agency.test/', agency_id: 4 },
            { url: 'https://agency.test', agency_id: null },
            { url: 'https://facebook.com/company', agency_id: null },
        ] };
        return { rowCount: 1, rows: [] };
    }) };
    expect(await seedKnownSites(db)).toEqual({ sites: 1 });
    const writes = calls.filter(([sql]) => sql.includes('INSERT INTO floor_plan.target'));
    expect(writes).toHaveLength(2);
    expect(writes.map(([, params]) => params[0])).toEqual([
        'https://agency.test/', 'https://agency.test/sitemap.xml',
    ]);
    expect(writes[0][0]).toContain('next_check_at=LEAST');
});

it('discovery-only enqueues plan assets but does not fetch them', async () => {
    const calls = [];
    const db = { query: vi.fn(async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
        if (sql.includes('AS total,count(website)')) return { rows: [{ total: 1, websites: 1 }] };
        if (sql.includes('INSERT INTO floor_plan.target(url,agency_id,kind')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
    }) };
    const fetched = [];
    let selected = false;
    const result = await crawl(db, {
        discoveryOnly: true,
        maxPages: 4,
        selectTarget: async () => {
            if (selected) return null;
            selected = true;
            return { url: 'https://agency.test/listing', kind: 'page', agency_id: 1, current_sha256: null };
        },
        fetcher: async url => {
            fetched.push(url);
            return { body: Buffer.from('<html><body><img src="/tlocrt-unit.png" alt="Floor plan"></body></html>'), status: 200, headers: { contentType: 'text/html' }, finalUrl: url };
        },
        log: () => {},
    });
    expect(fetched).toEqual(['https://agency.test/listing']);
    expect(calls.some(([sql, params]) => sql.startsWith('INSERT INTO floor_plan.target(url,agency_id,kind') && params[0] === 'https://agency.test/tlocrt-unit.png' && params[2] === 'asset')).toBe(true);
    expect(result.pending).toBe(0);
});

it('counts only work eligible in the current phase and reports deferred unmatched assets separately', async () => {
    const calls = [];
    const db = { query: vi.fn(async (sql) => {
        calls.push(sql);
        return { rows: [{ n: calls.length === 1 ? '3' : '8' }] };
    }) };
    expect(await countPendingTargets(db, { discoveryOnly: true })).toEqual({ pending: 3, deferredUnmatchedAssets: 8 });
    expect(calls[0]).toContain("t.kind IN ('home','sitemap','page')");
    expect(calls[0]).not.toContain("t.kind='asset'");
    expect(calls[1]).toContain("l.match_status='verified'");
    expect(calls[1]).toContain('l.building_id IS NOT NULL');
    expect(calls[1]).toContain("'listingOwned',true");
    calls.length = 0;
    await countPendingTargets(db, { assetOnly: true, matchedAssetsOnly: true });
    expect(calls[0]).toContain("t.kind='asset'");
    expect(calls[0]).toContain("l.match_status='verified'");
});

describe('floor-plan archive behavior', () => {
    it('stores content-addressed bytes and observation metadata', async () => {
        const calls = [];
        const db = { query: vi.fn(async (sql, params) => { calls.push([sql, params]); return { rowCount: 1, rows: [] }; }) };
        const target = { url: 'https://agency.test/a', kind: 'asset', current_sha256: null, agency_id: 4, discovered_from: 'https://agency.test/home' };
        const result = await saveObservation(db, target, { body: Buffer.from('plan'), status: 200, headers: { contentType: 'application/pdf', etag: 'e', lastModified: 'l' } }, { listing: null, assets: [] }, 'run-1');
        expect(result.changed).toBe(true);
        expect(calls.some(([sql, params]) => sql.includes('floor_plan.blob') && params[3].equals(Buffer.from('plan')))).toBe(true);
        expect(calls.some(([sql]) => sql.includes('floor_plan.extraction'))).toBe(true);
    });

    it('rejects malformed agency snapshots and unverified website matches', async () => {
        const db = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
        await expect(importAgencies(db, { source: 'https://registry.test/snapshot', records: [{ registry_id: '1', legal_name: 'A', registered_address: 'B' }] }, [{ status: 'verified', registry_id: '1', website: 'javascript:alert(1)', evidenceUrl: 'https://registry.test/e' }])).rejects.toThrow(/Verified website/);
        await expect(importAgencies(db, { source: 'https://registry.test/snapshot', records: [{ registry_id: '1' }] })).rejects.toThrow(/Invalid registry/);
    });
});


it('archives only explicitly owned assets on a listing while discovering related plans', async () => {
    const own = {url:'https://agency.test/tlocrt-main.pdf',kind:'floor-plan',listingOwned:true};
    const other = {url:'https://agency.test/tlocrt-other.pdf',kind:'floor-plan',listingOwned:false};
    const photo = {url:'https://agency.test/other.jpg',kind:'image',listingOwned:false,listingGallery:true};
    const evidence = {listing:{sourceId:'1'},assets:[own,other,photo],links:[]};
    const targets = discoverTargets({kind:'page',url:'https://agency.test/home'},response('html'),evidence);
    expect(targets.map(t => t.url)).toEqual([own.url,other.url]);
    const db = {query:vi.fn(async () => ({rows:[],rowCount:1}))};
    await saveObservation(db,{url:'https://agency.test/home',kind:'page',agency_id:1},response('html'),evidence,'run-1');
    const call = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO floor_plan.listing'));
    expect(JSON.parse(call[1][4])).toEqual([own]);
});
