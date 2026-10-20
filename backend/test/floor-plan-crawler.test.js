// Purpose: characterize crawler discovery and archive validation without network or PostgreSQL.
import { describe, expect, it, vi } from 'vitest';
import { crawl, discoverTargets, discoverTargetsWithStats } from '../floor-plans/crawler.js';
import { countPendingTargets, createTargetSelector, normalizeSiteHost, PROCESSABLE_ASSET_SQL, OWNED_ASSET_SQL, PLAN_ASSET_SQL } from '../floor-plans/crawl-queue.js';
import { DEFERRED_GENERATED_SEARCH_SQL, isGeneratedSearchTarget } from '../floor-plans/discovery-policy.js';
import { importAgencies, saveObservation } from '../floor-plans/archive.js';
import { seedKnownSites } from '../floor-plans/agency-sites.js';
import { runCli } from '../scripts/floor-plan-archive.mjs';
import { readFile } from 'node:fs/promises';
import { sourceFilePath } from '../floor-plans/blob-store.js';
import { useTestArchive } from './helpers/floor-plan-file-store.js';

useTestArchive();

describe('concurrent site crawl bookkeeping',()=>{
    function scopedDb(target) {
        return {query:vi.fn(async sql=>{
            if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
            if(sql.includes('WHERE t.url=$1 AND t.next_check_at<=now()'))return {rows:target?[target]:[]};
            if(sql.includes('AS allowed FROM floor_plan.target'))return {rows:[{allowed:true}]};
            if(sql.includes('AS total,count(website)'))return {rows:[{total:0,websites:0}]};
            if(sql.includes('SELECT count(*) AS n'))return {rows:[{n:0}]};
            return {rows:[],rowCount:1};
        })};
    }

    it('recovers only its own domain runs and preserves domain metadata through all checkpoints',async()=>{
        const target={url:'https://agency.test/one',kind:'page',current_sha256:null};
        const db=scopedDb(target);let selected=false;
        const compact=vi.fn(async()=>({deferred:0}));
        await crawl(db,{site:'WWW.AGENCY.TEST',maxPages:1,maxMinutes:1,log:()=>{},
            selectTarget:async()=>selected?null:(selected=true,target),storageCheck:async()=>{},
            fetcher:async url=>({status:200,body:Buffer.from('<html><body>Project</body></html>'),headers:{contentType:'text/html'},finalUrl:url}),
            saveObservationFn:async()=>({changed:true}),compactSourcesFn:compact});
        const calls=db.query.mock.calls;
        const recovery=calls.find(([sql])=>sql.includes("SET status='interrupted'"));
        expect(recovery[0]).toContain("counters->>'site'=$1");
        expect(recovery[1]).toEqual(['agency.test']);
        const start=calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.run'));
        const checkpoint=calls.find(([sql])=>sql.includes('UPDATE floor_plan.run SET counters='));
        const end=calls.find(([sql])=>sql.includes('SET status=$2,counters=$3'));
        for(const serialized of [start[1][1],checkpoint[1][1],end[1][2]])expect(JSON.parse(serialized).site).toBe('agency.test');
        expect(compact.mock.calls[0][1]).toMatchObject({apply:true,crawlLockHeld:true});
        const commit=calls.findIndex(([sql])=>sql==='COMMIT');
        expect(calls.slice(0,commit).some(([sql])=>sql.includes("pg_advisory_lock(hashtext('floor-plan-crawl-write'))"))).toBe(true);
        expect(calls.slice(commit+1).some(([sql])=>sql.includes("pg_advisory_unlock(hashtext('floor-plan-crawl-write'))"))).toBe(true);
    });

    it('does not refetch a shared CDN target that another domain already completed',async()=>{
        const target={url:'https://cdn.example/shared-plan.pdf',kind:'asset'};
        const db=scopedDb(null),fetcher=vi.fn();let selected=false;
        const result=await crawl(db,{site:'agency.test',maxPages:1,maxMinutes:1,log:()=>{},
            selectTarget:async()=>selected?null:(selected=true,target),fetcher,compactSourcesFn:async()=>({deferred:0})});
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.counters.requestsAttempted).toBe(0);
        const calls=db.query.mock.calls;
        expect(calls.some(([sql,params])=>sql.includes("pg_advisory_lock(hashtext('floor-plan-crawl-target')")&&params[0]===target.url)).toBe(true);
        expect(calls.some(([sql])=>sql.includes("pg_advisory_unlock(hashtext('floor-plan-crawl-target')"))).toBe(true);
    });
});

const response = (body, contentType = 'text/html') => ({ body: Buffer.from(body), headers: { contentType }, finalUrl: 'https://agency.test/home', status: 200 });
const explicitLocation = { schema: 'explicit-listing-location.v1', street: 'Ilica', houseNumber: '12', address: 'Ilica 12', quote: 'Ilica 12', basis: 'structured-property-address', sourceUrl: 'https://agency.test/listing' };

describe('floor-plan crawler boundaries', () => {
    it('stops before a request when archive capacity is exhausted without changing the target', async () => {
        const calls=[];
        const db={query:vi.fn(async(sql)=>{calls.push(sql);if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};if(sql.includes('AS allowed FROM floor_plan.target'))return{rows:[{allowed:true}]};if(sql.includes('SELECT count(*) AS n'))return{rows:[{n:'1'}]};if(sql.includes('AS total,count(website)'))return{rows:[{total:1,websites:1}]};return{rows:[]};})};
        const fetcher=vi.fn();
        const result=await crawl(db,{maxPages:2,maxMinutes:1,selectTarget:async()=>({url:'https://agency.test/a',kind:'page'}),fetcher,storageRoot:'/tmp/floor-plan-test',storageCheck:async()=>{throw Object.assign(new Error('full'),{code:'ARCHIVE_CAPACITY',reason:'free-space'});},compactSourcesFn:async()=>({deferred:0}),log:()=>{}});
        expect(result).toMatchObject({status:'partial',stopReason:'archive-capacity'});
        expect(result.counters.requestsAttempted).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
        expect(calls.some(sql=>sql.includes('UPDATE floor_plan.target SET state=')||sql.includes('UPDATE floor_plan.target SET state ='))).toBe(false);
    });

    it('keeps the selected target unchanged when the blob write hits the capacity guard', async () => {
        const calls=[];let selected=false;
        const db={query:vi.fn(async(sql)=>{calls.push(sql);if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};if(sql.includes('AS allowed FROM floor_plan.target'))return{rows:[{allowed:true}]};if(sql.includes('SELECT count(*) AS n'))return{rows:[{n:'1'}]};if(sql.includes('AS total,count(website)'))return{rows:[{total:1,websites:1}]};return{rows:[]};})};
        const result=await crawl(db,{maxPages:2,maxMinutes:1,selectTarget:async()=>selected?null:(selected=true,{url:'https://agency.test/plan.pdf',kind:'asset'}),fetcher:async url=>({status:200,body:Buffer.from('%PDF-1.7'),headers:{contentType:'application/pdf'},finalUrl:url}),saveObservationFn:async()=>{throw Object.assign(new Error('full'),{code:'ARCHIVE_CAPACITY',reason:'archive-limit'});},storageCheck:async()=>{},compactSourcesFn:async()=>({deferred:0}),log:()=>{}});
        expect(result).toMatchObject({status:'partial',stopReason:'archive-capacity',counters:{requestsAttempted:1,failed:0,blocked:0}});
        expect(calls.some(sql=>sql.startsWith('UPDATE floor_plan.target'))).toBe(false);
    });

    it('discovers same-site sitemap URLs and rejects cross-host entries', () => {
        const result = discoverTargets(
            { kind: 'sitemap', url: 'https://agency.test/sitemap.xml' },
            response('<urlset><url><loc>https://agency.test/a</loc></url><url><loc>https://other.test/x</loc></url></urlset>', 'application/xml'),
            { links: [], assets: [] },
        );
        expect(result).toEqual([{ url: 'https://agency.test/a', kind: 'page', priority: 10 }]);
    });

    it('treats sitemap images and PDFs as assets that still require a qualified owner', () => {
        const targets = discoverTargets({ kind: 'sitemap', url: 'https://agency.test/sitemap.xml' },
            response('<urlset><url><loc>https://agency.test/plan.pdf</loc></url><url><loc>https://agency.test/photo.jpg</loc></url></urlset>', 'application/xml'),
            { links: [], assets: [] });
        expect(targets.map(({ url, kind }) => [url, kind])).toEqual([
            ['https://agency.test/plan.pdf', 'asset'], ['https://agency.test/photo.jpg', 'asset']
        ]);
    });

    it('refuses to store binary content through an unrestricted generic-page target', async () => {
        const db = { query: vi.fn() };
        await expect(saveObservation(db, { kind: 'page', url: 'https://agency.test/download' },
            response('%PDF-1.7', 'application/pdf'), { listing: null, assets: [] }, null))
            .rejects.toThrow('address-qualified listing owner');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('defers Eurovilla generated search maps and their routes while preserving canonical sitemap pages', () => {
        const indexes = discoverTargetsWithStats(
            { kind: 'sitemap', url: 'https://www.eurovilla.hr/sitemap.xml.gz' },
            response('<sitemapindex><sitemap><loc>https://www.eurovilla.hr/sitemap-searches-en.xml.gz</loc></sitemap><sitemap><loc>https://www.eurovilla.hr/sitemap-properties.xml.gz</loc></sitemap></sitemapindex>', 'application/xml'),
            { links: [], assets: [] },
        );
        expect(indexes.targets).toEqual([{ url: 'https://www.eurovilla.hr/sitemap-properties.xml.gz', kind: 'sitemap', priority: 10 }]);
        expect(indexes.filteredGeneratedSearchTargets).toBe(1);

        const generated = discoverTargetsWithStats(
            { kind: 'sitemap', url: 'https://www.eurovilla.hr/sitemap-searches-en.xml.gz' },
            response('<urlset><url><loc>https://www.eurovilla.hr/en/search/apartment-zagreb/</loc></url><url><loc>https://www.eurovilla.hr/en/search/house-split/</loc></url></urlset>', 'application/xml'),
            { links: [], assets: [] },
        );
        expect(generated.targets).toEqual([]);
        expect(generated.filteredGeneratedSearchTargets).toBe(2);

        const canonical = discoverTargets(
            { kind: 'sitemap', url: 'https://www.eurovilla.hr/sitemap-properties.xml.gz' },
            response('<urlset><url><loc>https://www.eurovilla.hr/stan/zagreb/123/</loc></url><url><loc>https://www.eurovilla.hr/projekti/zagreb/</loc></url><url><loc>https://www.eurovilla.hr/kontakt/</loc></url></urlset>', 'application/xml'),
            { links: [], assets: [] },
        );
        expect(canonical.map(item => item.url)).toEqual(expect.arrayContaining([
            'https://www.eurovilla.hr/stan/zagreb/123/',
            'https://www.eurovilla.hr/projekti/zagreb/',
            'https://www.eurovilla.hr/kontakt/',
        ]));
        expect(isGeneratedSearchTarget({ url: 'https://eurovilla.hr/en/search/apartment/', kind: 'page', discovered_from: 'https://eurovilla.hr/sitemap-searches-en.xml.gz' })).toBe(true);
        expect(isGeneratedSearchTarget({ url: 'https://eurovilla.hr/kontakt/', kind: 'page', discovered_from: 'https://eurovilla.hr/sitemap-properties.xml.gz' })).toBe(false);
    });

    it('handles sitemap indexes and prioritizes floor-plan assets', () => {
        const sitemap = discoverTargets({ kind: 'sitemap', url: 'https://agency.test/sitemap.xml' }, response('<sitemapindex><sitemap><loc>https://agency.test/a.xml</loc></sitemap><sitemap><loc>https://cdn.test/b.xml</loc></sitemap></sitemapindex>', 'application/xml'), { links: [], assets: [] });
        expect(sitemap).toEqual([{ url: 'https://agency.test/a.xml', kind: 'sitemap', priority: 10 }]);
        const page = discoverTargets({ kind: 'page', url: 'https://agency.test/home' }, response(''), { links: [
            { url: 'https://agency.test/login', kind: 'listing' },
            { url: 'https://agency.test/project', kind: 'project' },
        ], listing: { explicitLocation }, assets: [
            { url: 'https://cdn.test/tlocrt-a.pdf', kind: 'floor-plan', listingOwned: true },
            { url: 'https://cdn.test/brochure.pdf', kind: 'document', listingOwned: true },
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
            listing: { explicitLocation }, assets: [{ url, kind: 'floor-plan', listingOwned: true }],
        })).toEqual([{ url, kind: 'asset', priority: 100 }]);
    });

    it('prioritizes only same-site child listings explicitly identified by a new-build project table', () => {
        const projectUrl='https://eurovilla.hr/projekt/zagreb-kuniscak-residence/945/';
        const child='https://eurovilla.hr/nekretnina/zagreb-kuniscak-stan-001/144012/';
        const metadataOnlyChild='https://eurovilla.hr/property/zagreb-kuniscak-stan-002/144013/';
        const ordinary='https://eurovilla.hr/nekretnina/zagreb-stan-older/133001/';
        const result=discoverTargetsWithStats({kind:'page',url:projectUrl},
            {...response('html'),finalUrl:projectUrl},
            {listing:{explicitLocation,newBuild:true},links:[
                {url:child,kind:'listing'},{url:ordinary,kind:'listing'},
                {url:'https://eurovilla.hr/projekti/zagreb/',kind:'project'},
                {url:'https://external.test/nekretnina/unit/1',kind:'listing'},
            ],projectListings:[{url:child},{url:metadataOnlyChild},{url:'https://external.test/nekretnina/unit/2'}],
            assets:[{url:'https://cdn.eurovilla.hr/stan-001-tlocrt.pdf',kind:'floor-plan',listingOwned:true}]});

        expect(result.targets).toEqual(expect.arrayContaining([
            {url:child,kind:'page',priority:100},
            {url:metadataOnlyChild,kind:'page',priority:100},
            {url:ordinary,kind:'page',priority:20},
            {url:'https://eurovilla.hr/projekti/zagreb/',kind:'page',priority:30},
            {url:'https://cdn.eurovilla.hr/stan-001-tlocrt.pdf',kind:'asset',priority:100},
        ]));
        expect(result.targets.some(item=>item.url.startsWith('https://external.test/'))).toBe(false);
    });

    it('does not prioritize project-table children when the parent is not a new build', () => {
        const url='https://eurovilla.hr/projekt/zagreb-renovation/12/';
        const child='https://eurovilla.hr/nekretnina/renovated-flat/11/';
        const result=discoverTargets({kind:'page',url},{...response('html'),finalUrl:url},{
            listing:{explicitLocation,newBuild:false},links:[{url:child,kind:'listing'}],projectListings:[{url:child}],assets:[],
        });
        expect(result).toEqual([{url:child,kind:'page',priority:20}]);
    });

    it('keeps same-site links after a legitimate cross-domain redirect', () => {
        const redirected = discoverTargets(
            { kind: 'page', url: 'https://old-agency.test/home' },
            { ...response(''), finalUrl: 'https://new-agency.test/home' },
            { links: [{ url: 'https://new-agency.test/listings/123', kind: 'listing' }], assets: [] },
        );
        expect(redirected).toEqual([{ url: 'https://new-agency.test/listings/123', kind: 'page', priority: 20 }]);
    });
});

describe('floor-plan queue fairness', () => {
    const makeDb = ({ includeUnmatchedAssets = false, includeSecondNestedMap = false, includeEurovillaTargets = false } = {}) => {
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
        if (includeSecondNestedMap) targets.push({ url: 'https://a.test/z-nested.xml', kind: 'sitemap', discovered_from: 'https://a.test/sitemap.xml', priority: 40, last_fetched_at: null, next_check_at: 0 });
        if (includeEurovillaTargets) targets.push(
            { url: 'https://www.eurovilla.hr/sitemap-searches-en.xml.gz', kind: 'sitemap', discovered_from: 'https://www.eurovilla.hr/', priority: 10, last_fetched_at: null, next_check_at: 0 },
            { url: 'https://www.eurovilla.hr/en/search/apartment/', kind: 'page', discovered_from: 'https://www.eurovilla.hr/sitemap-searches-en.xml.gz', priority: 10, last_fetched_at: null, next_check_at: 0 },
            { url: 'https://www.eurovilla.hr/stan/123/', kind: 'page', discovered_from: 'https://www.eurovilla.hr/sitemap-properties.xml.gz', priority: 20, last_fetched_at: null, next_check_at: 0 },
        );
        if (includeUnmatchedAssets) targets.push(
            { url: 'https://b.test/unmatched.pdf', kind: 'asset', priority: 100, matchStatus: 'candidate', buildingId: null, owned: true, locationStatus: 'located', last_fetched_at: null, next_check_at: 0 },
            { url: 'https://b.test/unlocated.pdf', kind: 'asset', priority: 99, matchStatus: 'candidate', buildingId: null, owned: true, locationStatus: 'unresolved', last_fetched_at: null, next_check_at: 0 },
            { url: 'https://b.test/not-owned.pdf', kind: 'asset', priority: 100, matchStatus: 'verified', buildingId: 'b-1', owned: false, last_fetched_at: null, next_check_at: 0 },
        );
        return { query: vi.fn(async (sql, [, excluded]) => {
        const kindClause = [...sql.matchAll(/AND (t\.kind(?: IN \([^)]*\)|='[^']+'))/g)].at(-1);
        const kinds = kindClause?.[1].match(/'([^']+)'/g)?.map(k => k.slice(1, -1)) || [];
        const nestedSitemaps = sql.includes("regexp_replace(t.discovered_from,'^https?://[^/]+','') NOT IN ('','/')");
        const rootSitemaps = sql.includes("regexp_replace(t.discovered_from,'^https?://[^/]+','') IN ('','/')") && !sql.includes("regexp_replace(t.discovered_from,'^https?://[^/]+','') NOT IN ('','/')");
        const matched = sql.includes("WHERE l.match_status='verified' AND l.building_id IS NOT NULL");
        const located = sql.includes("l.location_status IN ('located','probable')");
        const ownedOnly = sql.includes("l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'");
        const generatedSearchPolicy = sql.includes('sitemap-searches-[a-z]{2}');
        const rows = targets.filter(t => t.next_check_at === 0 && kinds.includes(t.kind) && !(generatedSearchPolicy && isGeneratedSearchTarget(t)) && !(nestedSitemaps && !t.discovered_from?.endsWith('/sitemap.xml')) && !(rootSitemaps && t.discovered_from?.endsWith('/sitemap.xml')) && !excluded.includes(new URL(t.url).host.replace(/^www\./, '')) && (!located || (t.kind !== 'asset' || t.locationStatus === 'located' || t.locationStatus === 'probable' || (t.matchStatus === 'verified' && t.buildingId))) && (!matched || (t.kind !== 'asset' || (t.matchStatus === 'verified' && t.buildingId && t.owned))) && (!ownedOnly || t.kind !== 'asset' || t.owned));
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

    it('gives each host a nested sitemap turn, then sweeps a page before its next map', async () => {
        const db = makeDb({ includeSecondNestedMap: true });
        const next = createTargetSelector({ discoveryOnly: true });
        expect((await next(db)).kind).toBe('home');
        expect((await next(db)).kind).toBe('home');
        expect((await next(db)).url).toBe('https://a.test/sitemap.xml');
        expect((await next(db)).url).toBe('https://b.test/sitemap.xml');
        const sequence = [];
        for (let index = 0; index < 5; index++) sequence.push((await next(db))?.url || null);
        expect(sequence).toEqual([
            'https://a.test/nested.xml',
            'https://a.test/project',
            'https://b.test/project',
            'https://a.test/z-nested.xml',
            'https://a.test/project-2',
        ]);
    });

    it('leaves old Eurovilla generated search targets deferred but selects canonical listing pages', async () => {
        const db = makeDb({ includeEurovillaTargets: true });
        const next = createTargetSelector({ discoveryOnly: true });
        const urls = [];
        for (let index = 0; index < 30; index++) {
            const target = await next(db);
            if (!target) break;
            urls.push(target.url);
        }
        expect(urls).not.toContain('https://www.eurovilla.hr/sitemap-searches-en.xml.gz');
        expect(urls).not.toContain('https://www.eurovilla.hr/en/search/apartment/');
        expect(urls).toContain('https://www.eurovilla.hr/stan/123/');
        expect(DEFERRED_GENERATED_SEARCH_SQL).toContain('sitemap-searches-[a-z]{2}');
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

        const ownedDb = makeDb({ includeUnmatchedAssets: true });
        const ownedAssets = createTargetSelector({ assetOnly: true, ownedAssetsOnly: true });
        expect((await ownedAssets(ownedDb)).url).toBe('https://b.test/plan.pdf');
        expect((await ownedAssets(ownedDb)).url).toBe('https://b.test/plan-2.pdf');
        expect((await ownedAssets(ownedDb)).url).toBe('https://b.test/unmatched.pdf');
        expect(await ownedAssets(ownedDb)).toBeNull();
    });
});

describe('site-scoped queue', () => {
    const host = url => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const targets = [
        { url: 'https://opereta.hr/stan/1', kind: 'page', agency_id: null },
        { url: 'https://www.OPERETA.hr/stan/2', kind: 'page', agency_id: 9 },
        { url: 'https://other.hr/stan/3', kind: 'page', agency_id: 9 },
        { url: 'https://cdn.example/owned.pdf', kind: 'asset', agency_id: null },
        { url: 'https://opereta.hr/owned.pdf', kind: 'asset', agency_id: 9 },
        { url: 'https://opereta.hr/legal.pdf', kind: 'asset', agency_id: 9 },
        { url: 'https://cdn.example/foreign.pdf', kind: 'asset', agency_id: 9 },
        { url: 'https://cdn.example/plan.pdf', kind: 'asset', agency_id: null },
        { url: 'https://cdn.example/brochure.pdf', kind: 'asset', agency_id: null },
        { url: 'https://cdn.example/shared-photo.jpg', kind: 'asset', agency_id: 9 },
    ];
    const listings = [
        { url: 'https://www.opereta.hr/stan/1', location_status: 'located', owned: [
            { url: 'https://cdn.example/owned.pdf', kind: 'image' },
            { url: 'https://opereta.hr/owned.pdf', kind: 'image' },
            { url: 'https://cdn.example/plan.pdf', kind: 'floor-plan' },
            { url: 'https://cdn.example/brochure.pdf', kind: 'document' },
            { url: 'https://cdn.example/shared-photo.jpg', kind: 'image' },
        ] },
        { url: 'https://other.hr/stan/3', location_status: 'located', owned: [
            { url: 'https://cdn.example/foreign.pdf', kind: 'floor-plan' },
            { url: 'https://cdn.example/shared-photo.jpg', kind: 'floor-plan' },
        ] },
    ];
    function scopedDb() {
        const due = new Set(targets.map(target => target.url));
        return { query: vi.fn(async (sql, params) => {
            if (!sql.includes('FROM floor_plan.target t')) return { rows: [] };
            const selection = sql.includes('LIMIT 1');
            const scoped = sql.includes('site_listing.url');
            const site = scoped ? params[selection ? 2 : 1] : null;
            if (scoped) expect(site).toBe('opereta.hr');
            if (selection || scoped) expect(sql).toContain("regexp_replace(lower(split_part(t.url,'/',3)),'^www\\.','')");
            if (scoped) expect(sql).toContain("regexp_replace(lower(split_part(site_listing.url,'/',3)),'^www\\.','')");
            const planOnly = sql.includes("asset->>'kind' IN ('floor-plan','document')") || sql.includes(`AND ${PLAN_ASSET_SQL}`);
            const locatedOnly = sql.includes("l.location_status IN ('located','probable')");
            const selected = targets.filter(target => due.has(target.url) && (
                target.kind === 'asset'
                    ? listings.some(listing => (!site || host(listing.url) === site) && listing.owned.some(asset =>
                        asset.url === target.url && (!planOnly || ['floor-plan', 'document'].includes(asset.kind))
                        && (!locatedOnly || ['located','probable'].includes(listing.location_status))))
                    : !site || host(target.url) === site));
            const kind = [...sql.matchAll(/AND t\.kind='(asset|page|home|sitemap)'/g)].at(-1)?.[1];
            const eligible = selected.filter(target => !kind || target.kind === kind);
            if (!selection) return { rows: [{ n: eligible.length }] };
            const row = eligible.find(target => !params[1].includes(host(target.url)));
            if (row) due.delete(row.url);
            return { rows: row ? [row] : [] };
        }) };
    }

    it('selects exact-site pages and only listing-owned assets, including an external CDN', async () => {
        expect(normalizeSiteHost('WWW.OPERETA.HR')).toBe('opereta.hr');
        expect(() => normalizeSiteHost('opereta.hr.evil.test/path')).toThrow(/hostname/);
        const pages = createTargetSelector({ site: 'WWW.OPERETA.HR', discoveryOnly: true });
        const pageDb = scopedDb(), selectedPages = [];
        for (let target; (target = await pages(pageDb));) selectedPages.push(target.url);
        expect(selectedPages).toEqual(['https://opereta.hr/stan/1', 'https://www.OPERETA.hr/stan/2']);
        const assets = createTargetSelector({ site: 'opereta.hr', assetOnly: true });
        const assetDb = scopedDb(), selectedAssets = [];
        for (let target; (target = await assets(assetDb));) selectedAssets.push(target.url);
        expect(selectedAssets).toEqual(['https://cdn.example/owned.pdf', 'https://opereta.hr/owned.pdf',
            'https://cdn.example/plan.pdf', 'https://cdn.example/brochure.pdf', 'https://cdn.example/shared-photo.jpg']);
        expect(assetDb.query.mock.calls.some(([sql]) => sql.includes('CROSS JOIN LATERAL jsonb_array_elements(site_listing.asset_urls)'))).toBe(true);
    });

    it('uses the same site ownership scope for pending and deferred counts', async () => {
        const db = scopedDb();
        expect((await countPendingTargets(db, { site: 'www.opereta.hr', assetOnly: true })).pending).toBe(5);
        const countSql = db.query.mock.calls.map(([sql]) => sql);
        expect(countSql).toHaveLength(3); // pending, unlocated-asset, and generated-search counts
        expect(countSql.every(sql => sql.includes('CROSS JOIN LATERAL jsonb_array_elements(site_listing.asset_urls)'))).toBe(true);
        expect(countSql.every(sql => !sql.includes('opereta.hr'))).toBe(true); // parameterized hostname

        const ownedDb = scopedDb();
        const owned = await countPendingTargets(ownedDb, { site: 'opereta.hr', assetOnly: true, ownedAssetsOnly: true });
        expect(owned.deferredUnownedAssets).toBe(0);
        expect(ownedDb.query).toHaveBeenCalledTimes(3); // pending, unlocated-asset, and generated-search counts
        expect(ownedDb.query.mock.calls[0][0]).toContain('FROM floor_plan.listing l');

        const ownedSelector = createTargetSelector({ site: 'opereta.hr', assetOnly: true, ownedAssetsOnly: true });
        const ownedSelectorDb = scopedDb();
        await ownedSelector(ownedSelectorDb);
        expect(ownedSelectorDb.query.mock.calls[0][0]).toContain('l.location_status IN (\'located\',\'probable\')');
    });

    it('drains remaining site-owned assets after the final page in mixed mode', async () => {
        const next = createTargetSelector({ site: 'opereta.hr' }), db = scopedDb(), selected = [];
        for (let target; (target = await next(db));) selected.push(target.url);
        expect(selected).toEqual([
            'https://opereta.hr/stan/1',
            'https://cdn.example/owned.pdf',
            'https://www.OPERETA.hr/stan/2',
            'https://opereta.hr/owned.pdf',
            'https://cdn.example/plan.pdf',
            'https://cdn.example/brochure.pdf',
            'https://cdn.example/shared-photo.jpg',
        ]);
    });

    it('limits plan assets by kind on the same owning listing and aligns pending counts', async () => {
        const db = scopedDb(), next = createTargetSelector({ site: 'opereta.hr', assetOnly: true, planAssetsOnly: true });
        const selected = [];
        for (let target; (target = await next(db));) selected.push(target.url);
        expect(selected).toEqual(['https://cdn.example/plan.pdf', 'https://cdn.example/brochure.pdf']);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('CROSS JOIN LATERAL jsonb_array_elements(site_listing.asset_urls)');
        expect(sql).toContain("asset->'listingOwned'='true'::jsonb");
        expect(sql).toContain("asset->>'kind' IN ('floor-plan','document')");
        expect(sql).toContain("l.location_status IN ('located','probable')");
        expect((await countPendingTargets(scopedDb(), { site: 'opereta.hr', assetOnly: true, planAssetsOnly: true })).pending).toBe(2);
        const unscoped = scopedDb();
        expect((await countPendingTargets(unscoped, { assetOnly: true, planAssetsOnly: true })).pending).toBe(4);
        expect(unscoped.query.mock.calls[0][0]).toContain('FROM floor_plan.listing l');
    });
});

it('rejects invalid site crawl flags before opening a database connection', async () => {
    const clientFactory = vi.fn(() => { throw new Error('database client must not be created'); });
    const options = { clientFactory, output: vi.fn() };
    await expect(runCli(['crawl', '--site'], options)).rejects.toThrow('--site requires a hostname');
    await expect(runCli(['crawl', '--site', '--assets-only'], options)).rejects.toThrow('--site requires a hostname');
    await expect(runCli(['crawl', '--site', 'opereta.hr.evil.test/path'], options)).rejects.toThrow(/hostname/);
    await expect(runCli(['crawl', '--site', 'opereta.hr', '--discovery-only', '--assets-only'], options)).rejects.toThrow(/not both/);
    expect(clientFactory).not.toHaveBeenCalled();
});

it('rejects an unsupported classifier site flag before any database or paid work', async () => {
    const clientFactory = vi.fn();
    await expect(runCli(['classify-images', '--site', 'opereta.hr'], { clientFactory, output: vi.fn() }))
        .rejects.toThrow(/explicit taskIds allowlist/);
    expect(clientFactory).not.toHaveBeenCalled();
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
        if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: true }] };
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
            return { body: Buffer.from('<html><script type="application/ld+json">{"@type":"Apartment","address":{"streetAddress":"Ilica 12"}}</script><main><div class="gallery"><img src="/tlocrt-unit.png" alt="Floor plan"></div></main></html>'), status: 200, headers: { contentType: 'text/html' }, finalUrl: url };
        },
        log: () => {},
    });
    expect(fetched).toEqual(['https://agency.test/listing']);
    expect(calls.some(([sql, params]) => sql.startsWith('INSERT INTO floor_plan.target(url,agency_id,kind') && params[0] === 'https://agency.test/tlocrt-unit.png' && params[2] === 'asset')).toBe(true);
    expect(result.pending).toBe(0);
});

it('fetches an addressless listing once, records its exclusion, and skips it before a later fetch', async () => {
    let excluded = false;
    const calls = [];
    const db = { query: vi.fn(async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: !excluded }] };
        if (sql.includes('AS excluded')) return { rows: [{ excluded }] };
        if (sql.includes('INSERT INTO floor_plan.exclusion')) excluded = true;
        if (sql.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
        if (sql.includes('AS total,count(website)')) return { rows: [{ total: 0, websites: 0 }] };
        if (sql.includes('SELECT count(*)::int AS blobs')) return { rows: [{ blobs: 0, bytes: '0' }] };
        return { rowCount: 1, rows: [] };
    }) };
    const listingUrl = 'https://agency.test/stan/bez-adrese';
    const fetcher = vi.fn(async url => ({ body: Buffer.from('<script type="application/ld+json">{"@type":"Apartment","name":"Stan bez adrese"}</script><main><h1>Stan bez adrese</h1><div class="gallery"><img src="/photo.jpg" alt="Fotografija"></div></main>'), status: 200, headers: { contentType: 'text/html' }, finalUrl: url }));
    let selected = 0;
    const result = await crawl(db, { maxPages: 2, maxMinutes: 1, log: () => {},
        selectTarget: async () => selected++ < 2 ? { url: listingUrl, kind: 'page', agency_id: 1 } : null,
        fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.counters).toMatchObject({ requestsAttempted: 1, excluded: 2 });
    expect(calls.some(([sql]) => sql.includes('INSERT INTO floor_plan.exclusion'))).toBe(true);
    expect(calls.some(([sql, params]) => sql.includes('INSERT INTO floor_plan.target(url,agency_id,kind') && params[0] === 'https://agency.test/photo.jpg')).toBe(false);
    expect(calls.some(([sql]) => sql.includes('INSERT INTO floor_plan.blob'))).toBe(false);
});

it('reports search sitemap URLs filtered during a crawl and still enqueues canonical maps', async () => {
    const enqueued = [];
    const db = { query: vi.fn(async (sql, params = []) => {
        if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: true }] };
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
        if (sql.includes('AS total,count(website)')) return { rows: [{ total: 0, websites: 0 }] };
        if (sql.startsWith('INSERT INTO floor_plan.target(url,agency_id,kind')) {
            enqueued.push(params[0]);
            return {rowCount:1,rows:[{inserted:true}]};
        }
        return { rowCount: 1, rows: [] };
    }) };
    let selected = false;
    const result = await crawl(db, {
        discoveryOnly: true,
        maxPages: 1,
        selectTarget: async () => selected ? null : (selected = true, { url: 'https://www.eurovilla.hr/sitemap.xml.gz', kind: 'sitemap' }),
        fetcher: async url => ({
            ...response('<sitemapindex><sitemap><loc>https://www.eurovilla.hr/sitemap-searches-en.xml.gz</loc></sitemap><sitemap><loc>https://www.eurovilla.hr/sitemap-properties.xml.gz</loc></sitemap></sitemapindex>', 'application/xml'),
            finalUrl: url,
        }),
        log: () => {},
    });
    expect(result.counters.filteredGeneratedSearchTargets).toBe(1);
    expect(result.counters.discovered).toBe(1);
    expect(enqueued).toEqual(['https://www.eurovilla.hr/sitemap-properties.xml.gz']);
    expect(result.deferredGeneratedSearchTargets).toBe(0);
});

it('persists request, response, host, and decoded-body metrics after each attempt', async () => {
    const countersWritten = [];
    const db = { query: vi.fn(async (sql, params = []) => {
        if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: true }] };
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
        if (sql.includes('AS total,count(website)')) return { rows: [{ total: 0, websites: 0 }] };
        if (sql.includes('UPDATE floor_plan.run SET counters=')) countersWritten.push(JSON.parse(params[1]));
        return { rowCount: 1, rows: [] };
    }) };
    const targets = [
        { url: 'https://www.agency.test/page', kind: 'page' },
        { url: 'https://agency.test/plan.pdf', kind: 'asset', current_sha256: 'a'.repeat(64) },
        { url: 'https://robots.test/private', kind: 'page' },
        { url: 'https://other.test/blocked', kind: 'page' },
        { url: 'https://failed.test/page', kind: 'page' },
    ];
    const fetcher = vi.fn(async url => {
        if (url.includes('failed.test')) throw new Error('connection reset');
        if (url.includes('/plan.pdf')) return { status: 304, notModified: true, body: Buffer.alloc(0), headers: {} };
        if (url.includes('robots.test')) return { url, finalUrl: url, status: null, headers: {}, body: null, blockedReason: 'robots-disallow', notModified: false };
        if (url.includes('/blocked')) return { status: 403, blockedReason: 'Access denied', body: Buffer.from('blocked!'), headers: {} };
        if (url.includes('/page')) return { status: 200, body: Buffer.from('page body'), headers: { contentType: 'application/octet-stream' }, finalUrl: 'https://redirected.test/page' };
        throw new Error('unexpected URL');
    });
    const result = await crawl(db, {
        maxPages: targets.length,
        selectTarget: async () => targets.shift() || null,
        fetcher,
        log: () => {},
    });

    expect(result.counters).toMatchObject({
        requestsAttempted: 5,
        fetched: 5,
        fetchResults: 4,
        successfulResponses: 2,
        decodedResponseBodyBytes: 17,
        pageDecodedBodyBytes: 17,
        assetDecodedBodyBytes: 0,
        uniqueHostsAttempted: 4,
        uniqueHostsSucceeded: 1,
        blocked: 2,
        failed: 1,
    });
    expect(result.telemetry).toEqual({
        requestedHostKeys: ['agency.test', 'robots.test', 'other.test', 'failed.test'],
        successfulHostKeys: ['agency.test'],
    });
    expect(countersWritten).toHaveLength(5);
    expect(countersWritten.at(-1)).toMatchObject({ requestsAttempted: 5, fetched: 5, fetchResults: 4, decodedResponseBodyBytes: 17 });
    // Host telemetry follows the requested URL, even when the response reports a redirected finalUrl.
    expect(fetcher).toHaveBeenCalledTimes(5);
});

it('counts only work eligible in the current phase and reports deferred unmatched assets separately', async () => {
    expect(PROCESSABLE_ASSET_SQL).toContain("l.location_status IN ('located','probable')");
    expect(PROCESSABLE_ASSET_SQL).toContain("l.match_status='verified'");
    expect(PROCESSABLE_ASSET_SQL).toContain('l.building_id IS NOT NULL');
    expect(PROCESSABLE_ASSET_SQL).toContain("'listingOwned',true");
    expect(OWNED_ASSET_SQL).toContain("l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'");
    expect(OWNED_ASSET_SQL).toContain("'listingOwned',true");
    const calls = [];
    const values = ['3', '5', '8', '4', '3431'];
    const db = { query: vi.fn(async (sql) => {
        calls.push(sql);
        return { rows: [{ n: values[calls.length - 1] }] };
    }) };
    expect(await countPendingTargets(db, { discoveryOnly: true })).toEqual({ pending: 3, deferredUnlocatedAssets: 5, deferredUnmatchedAssets: 8, deferredUnownedAssets: 4, deferredGeneratedSearchTargets: 3431 });
    expect(calls[0]).toContain("t.kind IN ('home','sitemap','page')");
    expect(calls[0]).toContain("AND t.kind IN ('home','sitemap','page')");
    expect(calls[0]).toContain("AND NOT COALESCE((t.kind='asset' AND t.image_kind IN ('photo','render')");
    expect(calls[0]).toContain('sitemap-searches-[a-z]{2}');
    expect(calls[0]).toContain("l.location_status IN ('located','probable')");
    expect(calls[2]).toContain("l.match_status='verified'");
    expect(calls[2]).toContain('l.building_id IS NOT NULL');
    expect(calls[2]).toContain("'listingOwned',true");
    expect(calls[4]).toContain("sitemap-searches-[a-z]{2}");
    calls.length = 0;
    await countPendingTargets(db, { assetOnly: true, matchedAssetsOnly: true });
    expect(calls[0]).toContain("t.kind='asset'");
    expect(calls[0]).toContain("l.match_status='verified'");
    calls.length = 0;
    await countPendingTargets(db, { assetOnly: true, ownedAssetsOnly: true });
    expect(calls[0]).toContain("t.kind='asset'");
    expect(calls[0]).toContain("l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'");
    expect(calls[0]).toContain("'listingOwned',true");
    expect(calls[0]).toContain("l.location_status IN ('located','probable')");
    calls.length = 0;
    await countPendingTargets(db, { matchedAssetsOnly: true, ownedAssetsOnly: true });
    expect(calls[0]).toContain("l.match_status='verified'");
    expect(calls[0]).toContain("l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'");
});

describe('floor-plan archive behavior', () => {
    it('stores content-addressed files and observation metadata without sending bytes to PostgreSQL', async () => {
        const calls = [];
        const db = { query: vi.fn(async (sql, params) => { calls.push([sql, params]); return { rowCount: 1, rows: sql.includes('AS allowed FROM floor_plan.target') ? [{ allowed: true }] : [] }; }) };
        const target = { url: 'https://agency.test/a', kind: 'asset', current_sha256: null, agency_id: 4, discovered_from: 'https://agency.test/home' };
        const result = await saveObservation(db, target, { body: Buffer.from('plan'), status: 200, headers: { contentType: 'application/pdf', etag: 'e', lastModified: 'l' } }, { listing: null, assets: [] }, 'run-1');
        expect(result.changed).toBe(true);
        const [sql,params]=calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.blob'));
        expect(await readFile(sourceFilePath(params[3],result.hash))).toEqual(Buffer.from('plan'));
        expect(sql).not.toMatch(/\bdata\b/);
        expect(params.some(Buffer.isBuffer)).toBe(false);
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
    const evidence = {listing:{sourceId:'1',explicitLocation},assets:[own,other,photo],links:[]};
    const targets = discoverTargets({kind:'page',url:'https://agency.test/home'},response('html'),evidence);
    expect(targets.map(t => t.url)).toEqual([own.url]);
    const db = {query:vi.fn(async () => ({rows:[],rowCount:1}))};
    await saveObservation(db,{url:'https://agency.test/home',kind:'page',agency_id:1},response('<script type="application/ld+json">{"@type":"Apartment","address":{"streetAddress":"Ilica 12"}}</script>'),evidence,'run-1');
    const call = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO floor_plan.listing'));
    expect(JSON.parse(call[1][4])).toEqual([own]);
});

it('discovers listing-owned photos outside a gallery but excludes unowned photos',()=>{
    const owned={url:'https://cdn.example/listing-photo.jpg',kind:'image',listingOwned:true};
    const unowned={url:'https://cdn.example/agent-photo.jpg',kind:'image',listingOwned:false};
    const targets=discoverTargets({kind:'page',url:'https://agency.test/stan/1'},response('html'),
        {listing:{sourceId:'1',explicitLocation},assets:[owned,unowned],links:[]});
    expect(targets).toEqual([{url:owned.url,kind:'asset',priority:15}]);
});

it('requeues a newly explicit floor-plan label despite an old negative image cache',async()=>{
    const calls=[];const db={query:vi.fn(async(sql,params=[])=>{
        calls.push([sql,params]);
        if(sql.includes('AS allowed FROM floor_plan.target'))return {rows:[{allowed:true}]};
        if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
        if(sql.includes('SELECT count(*) AS n'))return {rows:[{n:0}]};
        if(sql.includes('AS total,count(website)'))return {rows:[{total:0,websites:0}]};
        if(sql.includes('INSERT INTO floor_plan.target'))return {rows:[],rowCount:0};
        return {rows:[],rowCount:1};
    })};
    let selected=false;
    await crawl(db,{maxPages:1,maxMinutes:1,log:()=>{},selectTarget:async()=>selected?null:
        (selected=true,{url:'https://agency.test/stan/1',kind:'page',agency_id:1,current_sha256:null}),
        fetcher:async url=>({status:200,headers:{contentType:'text/html'},finalUrl:url,
            body:Buffer.from('<script type="application/ld+json">{"@type":"Apartment","identifier":"1","address":{"streetAddress":"Ilica 12"}}</script><div class="gallery"><img src="/tlocrt.jpg" alt="Tlocrt"></div>')})});
    const requeue=calls.find(([sql])=>sql.includes('image_kind=NULL,image_classified_sha256=NULL'));
    expect(requeue).toBeDefined();
    expect(requeue[1]).toEqual(['https://agency.test/tlocrt.jpg',1]);
    expect(requeue[0]).toContain('image_classified_sha256=NULL');
});

it('queues image classification for exactly the repeated --listing-url listings', async () => {
    const calls = [];
    const client = { connect: vi.fn(), end: vi.fn(), query: vi.fn(async (sql, params = []) => { calls.push(params); return { rows: [], rowCount: 0 }; }) };
    const listings = ['https://studio.test/hr/projekt/a/', 'https://studio.test/hr/projekt/b/'];
    await runCli(['enqueue-images', '--listing-url', listings[0], '--listing-url', listings[1]], { clientFactory: () => client, output: vi.fn() });
    const filters = calls.flat().filter(Array.isArray);
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) expect(filter).toEqual(listings);
    calls.length = 0;
    await runCli(['enqueue-images'], { clientFactory: () => client, output: vi.fn() });
    expect(calls.flat().filter(Array.isArray)).toEqual([]);
});
