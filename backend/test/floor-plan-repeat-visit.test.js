// Repeated source visits reuse stored evidence and decisions while changed bytes remain observable.
import { describe, expect, it, vi } from 'vitest';
import { crawl } from '../floor-plans/crawler.js';
import { saveObservation, sha256 } from '../floor-plans/archive.js';
import { revisitKnownTargets, createTargetSelector } from '../floor-plans/crawl-queue.js';
import { useTestArchive } from './helpers/floor-plan-file-store.js';
useTestArchive();

function database(previousAssets = []) {
    return { query: vi.fn(async sql => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: true }] };
        if (sql.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
        if (sql.includes('AS total,count(website)')) return { rows: [{ total: 0, websites: 0 }] };
        if (sql.startsWith('SELECT asset_urls')) return { rows: [{ asset_urls: previousAssets }] };
        return { rows: [], rowCount: 1 };
    }) };
}

async function visit(target, response) {
    const db = database(), fetcher = vi.fn(async () => response);
    let selected = false;
    const result = await crawl(db, { maxPages: 1, log: () => {}, fetcher,
        selectTarget: async () => selected ? null : (selected = true, target) });
    return { db, fetcher, result };
}

describe('repeat visits', () => {
    it.each(['page', 'asset'])('sends validators and does no source or extraction writes for an unchanged %s', async kind => {
        const target = { kind, url: 'https://source.test/item', current_sha256: 'a'.repeat(64), etag: '"v1"', last_modified: 'Tue, 13 Oct 2026 10:00:00 GMT' };
        const { db, fetcher, result } = await visit(target, { status: 304, notModified: true, body: null, headers: {} });
        expect(fetcher).toHaveBeenCalledWith(target.url, { etag: target.etag, lastModified: target.last_modified });
        expect(result.counters).toMatchObject({ unchanged: 1, notModified: 1, changed: 0, decodedResponseBodyBytes: 0 });
        expect(db.query.mock.calls.some(([sql]) => /INSERT INTO floor_plan\.(blob|observation|listing|extraction)/.test(sql))).toBe(false);
        const update = db.query.mock.calls.find(([sql]) => sql.includes("http_status=$2"));
        expect(update[1][1]).toBe(304);
        expect(update[0]).toContain("WHEN kind='asset' THEN interval '30 days'");
    });

    it('skips parsing, discovery and extraction when a server sends identical bytes with HTTP 200', async () => {
        const body = Buffer.from('<html><a href="/new-link">unchanged</a></html>');
        const { db, result } = await visit({ kind: 'page', url: 'https://source.test/item', current_sha256: sha256(body) },
            { status: 200, body, headers: { contentType: 'text/html', etag: '"same"' } });
        expect(result.counters).toMatchObject({ unchanged: 1, identicalBodies: 1, changed: 0, discovered: 0 });
        expect(db.query.mock.calls.some(([sql]) => /INSERT INTO floor_plan\.(target|blob|observation|listing|extraction)/.test(sql))).toBe(false);
    });

    it('archives a changed drawing at the same URL under its new hash', async () => {
        const body = Buffer.from('replacement drawing');
        const { db, result } = await visit({ kind: 'asset', url: 'https://source.test/item.png', current_sha256: 'a'.repeat(64), etag: '"old"' },
            { status: 200, body, headers: { contentType: 'image/png', etag: '"new"' } });
        expect(result.counters).toMatchObject({ changed: 1, unchanged: 0 });
        const observation = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO floor_plan.observation'));
        expect(observation[1][1]).toBe(sha256(body));
        expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO floor_plan.extraction'))).toBe(true);
    });

    it('restores discarded source bytes with an unconditional request instead of accepting a bodyless cache hit',async()=>{
        const body=Buffer.from('restored drawing');
        const {db,fetcher}=await visit({kind:'asset',url:'https://source.test/item.png',current_sha256:sha256(body),
            cached_bytes_available:false,etag:'"old"',last_modified:'old'},
            {status:200,body,headers:{contentType:'image/png',etag:'"old"'}});
        expect(fetcher).toHaveBeenCalledWith('https://source.test/item.png',{etag:null,lastModified:null});
        expect(db.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO floor_plan.blob'))).toBe(true);
    });

    it('distinguishes an existing plan label from a newly added label after a page edit', async () => {
        const asset = { url: 'https://source.test/plan.png', kind: 'floor-plan', listingOwned: true };
        const html = '<script type="application/ld+json">{"@type":"Apartment","address":{"streetAddress":"Ilica 12"}}</script>';
        const evidence = { listing: { explicitLocation: { schema: 'explicit-listing-location.v1', street: 'Ilica', houseNumber: '12' } }, assets: [asset] };
        const target = { kind: 'page', url: 'https://source.test/item', current_sha256: 'a'.repeat(64) };
        const response = { status: 200, body: Buffer.from(html), headers: { contentType: 'text/html' } };
        expect((await saveObservation(database([asset]), target, response, evidence, null)).newlyLabelledPlans).toEqual([]);
        expect((await saveObservation(database([{ ...asset, kind: 'image' }]), target, response, evidence, null)).newlyLabelledPlans).toEqual([asset.url]);
    });

    it('does not requeue the existing gallery when only the listing page changes',async()=>{
        const asset={url:'https://source.test/tlocrt.png',kind:'floor-plan',listingOwned:true};
        const db=database([asset]);
        db.query.mockImplementation(async(sql)=>{
            if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
            if(sql.includes('AS allowed FROM floor_plan.target'))return {rows:[{allowed:true}]};
            if(sql.includes('SELECT count(*) AS n'))return {rows:[{n:0}]};
            if(sql.includes('AS total,count(website)'))return {rows:[{total:0,websites:0}]};
            if(sql.startsWith('SELECT asset_urls'))return {rows:[{asset_urls:[asset]}]};
            if(sql.startsWith('INSERT INTO floor_plan.target'))return {rows:[],rowCount:0};
            return {rows:[],rowCount:1};
        });
        let selected=false;
        const body=Buffer.from('<script type="application/ld+json">{"@type":"Apartment","address":{"streetAddress":"Ilica 12"}}</script><div class="gallery"><img src="/tlocrt.png" alt="Tlocrt"></div><p>Updated description.</p>');
        const result=await crawl(db,{maxPages:1,log:()=>{},selectTarget:async()=>selected?null:(selected=true,
            {kind:'page',url:'https://source.test/item',current_sha256:'a'.repeat(64)}),
            fetcher:async()=>({status:200,body,headers:{contentType:'text/html'}})});
        expect(result.counters.changed).toBe(1);
        expect(db.query.mock.calls.some(([sql])=>sql.includes('UPDATE floor_plan.target t SET next_check_at=LEAST'))).toBe(false);
    });

    it('revisits only known allowed discovery pages of the requested host and prioritizes them', async () => {
        const db = database();
        expect(await revisitKnownTargets(db, { site: 'www.SOURCE.test' })).toEqual({ targets: 1 });
        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual(['source.test']);
        expect(sql).toContain("t.kind IN ('home','sitemap','page')");
        expect(sql).toContain('t.current_sha256 IS NOT NULL');
        expect(sql).toContain('floor_plan.exclusion');
        await createTargetSelector({ site: 'source.test', knownFirst: true })(db);
        expect(db.query.mock.calls.some(([query]) => query.includes('ORDER BY t.priority DESC, (t.last_fetched_at IS NULL) ASC'))).toBe(true);
    });
});
