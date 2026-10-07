// Purpose: characterize crawler discovery and archive validation without network or PostgreSQL.
import { describe, expect, it, vi } from 'vitest';
import { discoverTargets } from '../floor-plans/crawler.js';
import { importAgencies, saveObservation } from '../floor-plans/archive.js';

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
