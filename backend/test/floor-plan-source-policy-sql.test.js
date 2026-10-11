// Source exclusion and retention behavior against isolated PostgreSQL temporary tables.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import dotenv from 'dotenv';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { enqueue, saveObservation } from '../floor-plans/archive.js';
import { discoverTargets } from '../floor-plans/crawler.js';
import { listingIdentity } from '../floor-plans/explicit-location.js';
import { extractPageEvidence } from '../floor-plans/page-evidence.js';
import { EXCLUSION_REASON, ORPHAN_ASSET_REASON, excludeSource, qualifyPageEvidence } from '../floor-plans/source-policy.js';
import { enforceSourcePolicy, purgeExcludedContent } from '../floor-plans/source-retention.js';

const fixtureBlobBytes = vi.hoisted(() => new Map());
vi.mock('../floor-plans/blob-store.js', async importOriginal => {
    const actual = await importOriginal();
    return {
        ...actual,
        readBlobRow: vi.fn(async row => row?.bytes_available
            ? fixtureBlobBytes.get(row.sha256 || row.current_sha256) || null : null),
        pruneDiscardedFiles: vi.fn(async () => ({ filesDeleted: 0, bytesDeleted: 0 }))
    };
});

const hash = char => char.repeat(64);
const validLocation = { schema: 'explicit-listing-location.v1', street: 'Example Street', houseNumber: '12' };
const listedAsset = url => ({ url, listingOwned: true });
const campusUrl = 'https://3lhd.com/en/project/campus-infobip/';
const campusHtml = `<html><head><title>Old title</title></head><body><main><section class="section-project-title">
    <h1>Campus Infobip</h1><div><div>Address</div><div>Utinjska street 29A, Klara</div></div>
    <div><div>City</div><div>Zagreb</div></div></section></main></body></html>`;

describe.runIf(process.env.FLOOR_PLAN_LOCATION_DB_TEST === '1')('floor-plan source policy on isolated temporary tables', () => {
    let client, db;

    const storeFixtureBlob = async ({ hashValue, bytes, mediaType = 'text/html' }) => {
        const body = Buffer.from(bytes);
        fixtureBlobBytes.set(hashValue, body);
        await db.query(`INSERT INTO floor_plan.blob(sha256,media_type,byte_count,storage_path,bytes_available,stored_at)
            VALUES($1,$2,$3,$4,true,now())`, [hashValue, mediaType, body.length, `fixture/${hashValue}`]);
    };

    const storeArchivedPage = async ({ url, hashValue, html, sourceKind = 'agency', sourceId = null,
        facts = {}, legacyVerified = false, includeListing = true, kind = 'page', mediaType = 'text/html' }) => {
        await storeFixtureBlob({ hashValue, bytes: html, mediaType });
        await db.query(`INSERT INTO floor_plan.target(url,kind,source_kind,current_sha256,last_fetched_at)
            VALUES($1,$2,$3,$4,now())`, [url, kind, sourceKind, hashValue]);
        if (includeListing) await db.query(`INSERT INTO floor_plan.listing(url,source_id,facts,asset_urls,building_id,building_source,
            building_city,building_owner_id,building_evidence,match_status,match_checked_at)
            VALUES($1,$2,$3,'[]',$4,$5,$6,$7,$8,$9,CASE WHEN $9='verified' THEN now()-interval '1 hour' END)`,
        [url, sourceId, JSON.stringify(facts), legacyVerified ? 'legacy-building' : null,
            legacyVerified ? 'legacy-source' : null, legacyVerified ? 'Zagreb' : null,
            legacyVerified ? 'owner' : '', legacyVerified ? JSON.stringify({ previous: 'address-only match' }) : null,
            legacyVerified ? 'verified' : 'unresolved']);
        await db.query(`INSERT INTO floor_plan.observation(url,sha256,evidence) VALUES($1,$2,'{"stored":true}')`,
            [url, hashValue]);
    };

    beforeAll(async () => {
        dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
        const connectionUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
        if (connectionUrl) { connectionUrl.hostname = '127.0.0.1'; connectionUrl.port = '5432'; }
        client = new pg.Client({
            connectionString: connectionUrl?.href, host: '127.0.0.1', port: 5432,
            connectionTimeoutMillis: 5000, statement_timeout: 5000,
            application_name: 'floor-plan-source-policy-tests'
        });
        await client.connect();
        expect((await client.query('SELECT current_database() AS name')).rows[0].name).toBe('geodata');
        await client.query('BEGIN');
        await client.query(`
            CREATE TEMP TABLE target (
                url text PRIMARY KEY, agency_id bigint, kind text, priority integer DEFAULT 0,
                discovered_from text, source_identity text, source_kind text DEFAULT 'agency', exclusion_reason text, state text DEFAULT 'pending',
                http_status integer, failure text, etag text, last_modified text, current_sha256 text,
                last_fetched_at timestamptz, next_check_at timestamptz DEFAULT now(), image_kind text,
                image_classified_sha256 text, updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE listing (
                url text PRIMARY KEY, agency_id bigint, source_id text, facts jsonb NOT NULL,
                asset_urls jsonb NOT NULL DEFAULT '[]', building_id text, building_source text,
                building_city text, building_owner_id text DEFAULT '', building_evidence jsonb,
                match_status text DEFAULT 'unresolved', match_checked_at timestamptz,
                last_observed_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE exclusion (
                identity text PRIMARY KEY, url text NOT NULL, source_sha256 text, reason text NOT NULL,
                created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE blob (
                sha256 text PRIMARY KEY, media_type text NOT NULL, byte_count integer NOT NULL,
                storage_path text, bytes_available boolean NOT NULL DEFAULT true, stored_at timestamptz NOT NULL DEFAULT now(),
                discarded_at timestamptz, discard_reason text, created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE observation (
                url text NOT NULL, sha256 text NOT NULL, evidence jsonb NOT NULL, run_id uuid,
                observed_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(), PRIMARY KEY(url, sha256)
            ) ON COMMIT DROP;
            CREATE TEMP TABLE extraction (
                sha256 text PRIMARY KEY, status text DEFAULT 'pending', model jsonb,
                evidence jsonb DEFAULT '{}', error text, created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE model_revision (source_sha256 text, model_sha256 text, model jsonb) ON COMMIT DROP;
            CREATE TEMP TABLE processed_plan (source_sha256 text) ON COMMIT DROP;
            CREATE TEMP TABLE image_task (
                source_sha256 text, result jsonb, status text, error text, cost_usd numeric,
                updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE building_task (
                source_sha256 text, context jsonb, candidate_map jsonb, result jsonb,
                status text, error text, updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE plan_task (
                source_sha256 text, context jsonb, result jsonb, status text, error text,
                updated_at timestamptz DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE building_floor_model (floor_plans jsonb) ON COMMIT DROP;
        `);
        // Domain SQL remains unchanged; only qualified schemas route into this isolated fixture.
        db = { query: (sql, args) => {
            const transaction = {
                BEGIN: 'SAVEPOINT domain_operation',
                COMMIT: 'RELEASE SAVEPOINT domain_operation',
                ROLLBACK: 'ROLLBACK TO SAVEPOINT domain_operation'
            };
            return client.query(transaction[sql] || sql
                .replaceAll('floor_plan.', 'pg_temp.')
                .replaceAll('consensus.building_floor_model', 'pg_temp.building_floor_model')
                .replaceAll("hashtext('floor-plan-crawl')", "hashtext('floor-plan-source-policy-sql-test:'||pg_backend_pid()::text)"), args);
        } };
    });

    afterAll(async () => {
        if (client) { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
    });

    beforeEach(async () => {
        fixtureBlobBytes.clear();
        await client.query(`TRUNCATE pg_temp.target, pg_temp.listing, pg_temp.exclusion, pg_temp.blob,
            pg_temp.observation, pg_temp.extraction, pg_temp.model_revision, pg_temp.processed_plan,
            pg_temp.image_task, pg_temp.building_task, pg_temp.plan_task, pg_temp.building_floor_model`);
    });

    it('stores only a content-free tombstone for a property page without an explicit address', async () => {
        const url = 'https://opereta.hr/nekretnina/stan/4812-oglas';
        await db.query(`INSERT INTO floor_plan.target(url,kind,current_sha256) VALUES($1,'page',NULL)`, [url]);
        const body = Buffer.from('<html><main><h1>Listing headline</h1><p>Nice property</p></main></html>');
        const saved = await saveObservation(db, { url, kind: 'page', current_sha256: null }, {
            body, status: 200, finalUrl: url,
            headers: { contentType: 'text/html; charset=utf-8', etag: 'v1', lastModified: null }
        }, { listing: { sourceId: 'I4812', title: 'Listing headline' }, assets: [], links: [] }, '00000000-0000-0000-0000-000000000001');

        expect(saved.excluded).toBe(true);
        expect(saved.evidence.listing.explicitLocation).toBeNull();
        expect((await db.query('SELECT identity,reason,source_sha256 FROM floor_plan.exclusion')).rows)
            .toEqual([{ identity: 'opereta:4812', reason: EXCLUSION_REASON, source_sha256: saved.hash }]);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.blob')).rows[0].n).toBe(0);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.observation')).rows[0].n).toBe(0);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.listing')).rows[0].n).toBe(0);
        expect((await db.query('SELECT current_sha256,exclusion_reason,next_check_at::text FROM floor_plan.target')).rows[0])
            .toMatchObject({ current_sha256: null, exclusion_reason: EXCLUSION_REASON, next_check_at: 'infinity' });
    });

    it.each([
        ['HR', 'https://opereta.hr/nekretnina/stan/5201-oglas'],
        ['DE', 'https://opereta.hr/de/immobilie/wohnung/5201-listing'],
        ['EN', 'https://opereta.hr/en/real-estate/apartment/5201-listing']
    ])('permanently excludes Opereta %s locale aliases by canonical property identity', async (_locale, alias) => {
        const original = 'https://opereta.hr/nekretnina/stan/5201-stan-u-zagrebu';
        expect(listingIdentity(original)).toBe('opereta:5201');
        expect(listingIdentity(alias)).toBe('opereta:5201');
        await excludeSource(db, { url: original, sourceId: 'I5201' });
        expect(await enqueue(db, alias)).toBe(false);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.target')).rows[0].n).toBe(0);
    });

    it('dry-runs without mutating rows and reports only explicitly address-qualified pages as accepted', async () => {
        const eligibleHash = hash('e'), unparsedHash = hash('f'), noAddressHash = hash('g');
        const unparsedUrl = 'https://www.opereta.hr/de/immobilie/wohnung/73001-missing-markup';
        const noAddressUrl = 'https://studio.test/project/no-address';
        const unparsedHtml = '<html><body><p>Page body without property markup</p></body></html>';
        const noAddressHtml = '<html><body><main><h1>Unlocated project</h1></main></body></html>';
        expect(extractPageEvidence(unparsedHtml, unparsedUrl).listing).toMatchObject({ sourceId: null, address: null });
        expect(qualifyPageEvidence(unparsedHtml, unparsedUrl, extractPageEvidence(unparsedHtml, unparsedUrl)).listing)
            .toMatchObject({ sourceId: null, address: null, explicitLocation: null });

        await storeArchivedPage({ url: campusUrl, hashValue: eligibleHash, html: campusHtml,
            sourceKind: 'architecture', facts: { old: 'campus' } });
        await storeArchivedPage({ url: noAddressUrl, hashValue: noAddressHash, html: noAddressHtml,
            sourceKind: 'architecture', facts: { old: 'unlocated' } });
        await storeArchivedPage({ url: unparsedUrl, hashValue: unparsedHash, html: unparsedHtml,
            sourceKind: 'agency', facts: { old: 'unparsed Opereta' } });

        const snapshot = async () => ({
            targets: (await db.query('SELECT url,source_identity,exclusion_reason,current_sha256 FROM floor_plan.target ORDER BY url')).rows,
            listings: (await db.query('SELECT url,facts,asset_urls,match_status FROM floor_plan.listing ORDER BY url')).rows,
            blobs: (await db.query('SELECT sha256,NOT bytes_available AS discarded,discard_reason FROM floor_plan.blob ORDER BY sha256')).rows,
            observations: (await db.query('SELECT url,sha256,evidence FROM floor_plan.observation ORDER BY url')).rows,
            exclusions: (await db.query('SELECT identity,url,reason FROM floor_plan.exclusion ORDER BY identity')).rows
        });
        const before = await snapshot();
        const result = await enforceSourcePolicy(db, { apply: false, log: () => {} });
        const after = await snapshot();

        expect(result).toMatchObject({ apply: false, checked: 3, eligible: 1, excluded: 2, alreadyExcluded: 0 });
        expect(result.accepted).toHaveLength(1);
        expect(result.accepted[0]).toMatchObject({ url: campusUrl,
            location: { schema: 'explicit-listing-location.v1', street: 'Utinjska', houseNumber: '29A' } });
        expect(result.cleanup).toBeUndefined();
        expect(after).toEqual(before);
    });

    it('audits archived pages without listing rows, excludes failed Opereta objects, and leaves genuine home pages untouched', async () => {
        const acceptedHash = hash('l'), unparsedHash = hash('m'), homeHash = hash('n'), binaryHash = hash('o');
        const acceptedUrl = 'https://3lhd.com/en/project/campus-no-listing-row/';
        const unparsedUrl = 'https://opereta.hr/de/immobilie/wohnung/73002-missing-markup';
        const homeUrl = 'https://agency.test/';
        const binaryUrl = 'https://agency.test/media/photo.jpg';
        const unparsedHtml = '<html><body><p>Page body without property markup</p></body></html>';
        const homeHtml = '<html><head><title>Agency home</title></head><body><main><h1>Agency</h1></main></body></html>';
        expect(extractPageEvidence(unparsedHtml, unparsedUrl).listing).toMatchObject({ sourceId: null, address: null });
        expect(qualifyPageEvidence(unparsedHtml, unparsedUrl, extractPageEvidence(unparsedHtml, unparsedUrl)).listing)
            .toMatchObject({ sourceId: null, address: null, explicitLocation: null });

        await storeArchivedPage({ url: acceptedUrl, hashValue: acceptedHash, html: campusHtml,
            sourceKind: 'architecture', includeListing: false });
        await storeArchivedPage({ url: unparsedUrl, hashValue: unparsedHash, html: unparsedHtml,
            includeListing: false });
        await storeArchivedPage({ url: homeUrl, hashValue: homeHash, html: homeHtml,
            kind: 'home', includeListing: false });
        await storeArchivedPage({ url: binaryUrl, hashValue: binaryHash, html: 'unowned binary image bytes',
            includeListing: false, mediaType: 'image/jpeg' });

        const snapshot = async () => ({
            targets: (await db.query('SELECT url,kind,source_identity,exclusion_reason,current_sha256 FROM floor_plan.target ORDER BY url')).rows,
            listings: (await db.query('SELECT url,facts,asset_urls,match_status FROM floor_plan.listing ORDER BY url')).rows,
            blobs: (await db.query('SELECT sha256,NOT bytes_available AS discarded,discard_reason FROM floor_plan.blob ORDER BY sha256')).rows,
            observations: (await db.query('SELECT url,sha256,evidence FROM floor_plan.observation ORDER BY url')).rows,
            exclusions: (await db.query('SELECT identity,url,reason FROM floor_plan.exclusion ORDER BY identity')).rows
        });
        const before = await snapshot();
        const dryRun = await enforceSourcePolicy(db, { apply: false, log: () => {} });
        expect(dryRun).toMatchObject({ apply: false, checked: 4, eligible: 1, excluded: 1, alreadyExcluded: 0, nonObjects: 2,
            reclassifiedAssets: 0 });
        expect(dryRun.accepted).toHaveLength(1);
        expect(dryRun.accepted[0]).toMatchObject({ url: acceptedUrl,
            location: { schema: 'explicit-listing-location.v1', street: 'Utinjska', houseNumber: '29A' } });
        expect(dryRun.cleanup).toBeUndefined();
        expect(await snapshot()).toEqual(before);

        const applied = await enforceSourcePolicy(db, { apply: true, log: () => {} });
        expect(applied).toMatchObject({ apply: true, checked: 3, eligible: 1, excluded: 1, alreadyExcluded: 0, nonObjects: 1,
            reclassifiedAssets: 1,
            cleanup: { assetsExcluded: 1, listingsPurged: 0, observationsPurged: 2, blobsDiscarded: 2, protectedBlobs: 0 } });
        expect((await db.query('SELECT source_id,facts,asset_urls,last_observed_at FROM floor_plan.listing WHERE url=$1',
            [acceptedUrl])).rows[0]).toMatchObject({ source_id: acceptedUrl,
            facts: { explicitLocation: { street: 'Utinjska', houseNumber: '29A' }, locality: 'Zagreb' }, asset_urls: [] });
        expect((await db.query('SELECT url,kind,source_identity,exclusion_reason,current_sha256 FROM floor_plan.target ORDER BY url')).rows)
            .toEqual([
                { url: acceptedUrl, kind: 'page', source_identity: acceptedUrl.slice(0, -1), exclusion_reason: null, current_sha256: acceptedHash },
                { url: homeUrl, kind: 'home', source_identity: homeUrl, exclusion_reason: null, current_sha256: homeHash },
                { url: binaryUrl, kind: 'asset', source_identity: binaryUrl, exclusion_reason: ORPHAN_ASSET_REASON, current_sha256: null },
                { url: unparsedUrl, kind: 'page', source_identity: 'opereta:73002', exclusion_reason: EXCLUSION_REASON, current_sha256: null }
            ]);
        expect((await db.query('SELECT NOT bytes_available AS discarded FROM floor_plan.blob WHERE sha256=$1', [homeHash])).rows[0].discarded)
            .toBe(false);
        expect((await db.query('SELECT NOT bytes_available AS discarded FROM floor_plan.blob WHERE sha256=$1', [unparsedHash])).rows[0].discarded)
            .toBe(true);
        expect((await db.query('SELECT NOT bytes_available AS discarded FROM floor_plan.blob WHERE sha256=$1', [binaryHash])).rows[0].discarded)
            .toBe(true);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.observation WHERE url=$1', [homeUrl])).rows[0].n)
            .toBe(1);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.observation WHERE url=$1', [binaryUrl])).rows[0].n)
            .toBe(0);
        expect((await db.query('SELECT identity,url,reason FROM floor_plan.exclusion')).rows)
            .toEqual([{ identity: 'opereta:73002', url: unparsedUrl, reason: EXCLUSION_REASON }]);
    });

    it('applies exclusions, preserves eligible bytes, resets legacy verified matches, populates alias identity, and is idempotent', async () => {
        const eligibleHash = hash('h'), addresslessHash = hash('i'), operetaHash = hash('j'), aliasHash = hash('k');
        const addresslessUrl = 'https://studio.test/project/without-address';
        const operetaUrl = 'https://www.opereta.hr/de/immobilie/wohnung/74002-unparsed-page';
        const operetaAlias = 'https://opereta.hr/nekretnina/stan/74002-hr-alias';
        const addresslessHtml = '<html><body><main><h1>Unlocated project</h1></main></body></html>';
        const operetaHtml = '<html><body><p>Page body without property markup</p></body></html>';
        expect(extractPageEvidence(operetaHtml, operetaUrl).listing).toMatchObject({ sourceId: null, address: null });

        await storeArchivedPage({ url: campusUrl, hashValue: eligibleHash, html: campusHtml,
            sourceKind: 'architecture', facts: { old: 'campus' }, legacyVerified: true });
        await storeArchivedPage({ url: addresslessUrl, hashValue: addresslessHash, html: addresslessHtml,
            sourceKind: 'architecture', sourceId: 'legacy-addressless-id', facts: { private: 'old details' } });
        await storeArchivedPage({ url: operetaUrl, hashValue: operetaHash, html: operetaHtml,
            sourceKind: 'agency', sourceId: 'I74002', facts: { private: 'old Opereta details' } });

        await storeFixtureBlob({ hashValue: aliasHash, bytes: 'previous locale alias content' });
        await db.query(`INSERT INTO floor_plan.target(url,kind,source_kind,current_sha256,etag,last_modified,failure)
            VALUES($1,'page','agency',$2,'hr-tag','date','old failure')`, [operetaAlias, aliasHash]);
        await db.query(`INSERT INTO floor_plan.image_task(source_sha256,result,status,cost_usd)
            VALUES($1,'{"classification":"photo"}','complete',0.123)`, [addresslessHash]);

        const result = await enforceSourcePolicy(db, { apply: true, log: () => {} });
        expect(result).toMatchObject({ apply: true, checked: 4, eligible: 1, excluded: 3, alreadyExcluded: 0,
            cleanup: { assetsExcluded: 0, listingsPurged: 2, observationsPurged: 2, blobsDiscarded: 3, protectedBlobs: 0 } });

        const eligible = (await db.query(`SELECT facts,match_status,building_id,building_source,building_city,
            building_owner_id,building_evidence,match_checked_at FROM floor_plan.listing WHERE url=$1`, [campusUrl])).rows[0];
        expect(eligible.facts).toMatchObject({ explicitLocation: { schema: 'explicit-listing-location.v1', street: 'Utinjska', houseNumber: '29A' }, locality: 'Zagreb' });
        expect(eligible).toMatchObject({ match_status: 'unresolved', building_id: null, building_source: null,
            building_city: null, building_owner_id: '', building_evidence: null, match_checked_at: null });

        expect((await db.query(`SELECT url,source_identity,exclusion_reason,current_sha256,etag,last_modified,failure
            FROM floor_plan.target ORDER BY url`)).rows).toEqual([
            { url: campusUrl, source_identity: 'https://3lhd.com/en/project/campus-infobip', exclusion_reason: null,
                current_sha256: eligibleHash, etag: null, last_modified: null, failure: null },
            { url: operetaAlias, source_identity: 'opereta:74002', exclusion_reason: EXCLUSION_REASON,
                current_sha256: null, etag: null, last_modified: null, failure: null },
            { url: addresslessUrl, source_identity: 'https://studio.test/project/without-address', exclusion_reason: EXCLUSION_REASON,
                current_sha256: null, etag: null, last_modified: null, failure: null },
            { url: operetaUrl, source_identity: 'opereta:74002', exclusion_reason: EXCLUSION_REASON,
                current_sha256: null, etag: null, last_modified: null, failure: null }
        ]);
        expect((await db.query('SELECT identity,url,reason FROM floor_plan.exclusion ORDER BY identity')).rows)
            .toEqual([
                { identity: 'https://studio.test/project/without-address', url: addresslessUrl, reason: EXCLUSION_REASON },
                { identity: 'opereta:74002', url: operetaAlias, reason: EXCLUSION_REASON }
            ]);
        expect((await db.query('SELECT sha256,NOT bytes_available AS discarded FROM floor_plan.blob ORDER BY sha256')).rows)
            .toEqual([
                { sha256: eligibleHash, discarded: false }, { sha256: addresslessHash, discarded: true },
                { sha256: operetaHash, discarded: true }, { sha256: aliasHash, discarded: true }
            ]);
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.observation')).rows[0].n).toBe(1);
        expect((await db.query('SELECT facts,asset_urls,building_id,building_evidence,match_status FROM floor_plan.listing WHERE url=$1', [addresslessUrl])).rows[0])
            .toMatchObject({ facts: { sourceEvidenceStatus: 'excluded', exclusionReason: EXCLUSION_REASON }, asset_urls: [],
                building_id: null, building_evidence: null, match_status: 'unresolved' });
        expect((await db.query('SELECT facts FROM floor_plan.listing WHERE url=$1', [operetaUrl])).rows[0].facts)
            .toMatchObject({ sourceEvidenceStatus: 'excluded', exclusionReason: EXCLUSION_REASON });
        expect((await db.query('SELECT cost_usd FROM floor_plan.image_task WHERE source_sha256=$1', [addresslessHash])).rows[0].cost_usd)
            .toBe('0.123');
        expect((await db.query('SELECT bytes_available FROM floor_plan.blob WHERE sha256=$1', [eligibleHash])).rows[0].bytes_available).toBe(true);

        const snapshot = async () => ({
            targets: (await db.query('SELECT * FROM floor_plan.target ORDER BY url')).rows,
            listings: (await db.query('SELECT * FROM floor_plan.listing ORDER BY url')).rows,
            exclusions: (await db.query('SELECT * FROM floor_plan.exclusion ORDER BY identity')).rows,
            blobs: (await db.query('SELECT sha256,byte_count,NOT bytes_available AS discarded,discarded_at,discard_reason FROM floor_plan.blob ORDER BY sha256')).rows,
            observations: (await db.query('SELECT * FROM floor_plan.observation ORDER BY url')).rows,
            imageTasks: (await db.query('SELECT * FROM floor_plan.image_task ORDER BY source_sha256')).rows
        });
        const beforeRerun = await snapshot();
        const rerun = await enforceSourcePolicy(db, { apply: true, log: () => {} });
        const afterRerun = await snapshot();
        expect(rerun).toMatchObject({ apply: true, checked: 3, eligible: 1, excluded: 0, alreadyExcluded: 2,
            cleanup: { assetsExcluded: 0, listingsPurged: 0, observationsPurged: 0, blobsDiscarded: 0, bytesDiscarded: 0 } });
        expect(afterRerun).toEqual(beforeRerun);
    });

    it('discovers and queues owned assets only for an address-eligible property', async () => {
        const pageUrl = 'https://agency.test/listing/eligible';
        const assetUrl = 'https://agency.test/images/listing.jpg';
        const target = { url: pageUrl, kind: 'page' };
        const response = { finalUrl: pageUrl, headers: { contentType: 'text/html' }, body: Buffer.from('<html/>') };
        const evidenceWithoutAddress = {
            listing: { sourceId: '1' }, links: [], assets: [ { ...listedAsset(assetUrl), kind: 'image' } ]
        };
        expect(discoverTargets(target, response, evidenceWithoutAddress)).toEqual([]);
        expect(await enqueue(db, assetUrl, { kind: 'asset', from: pageUrl })).toBe(false);

        const evidenceWithAddress = {
            listing: { sourceId: '1', explicitLocation: validLocation }, links: [],
            assets: [ { ...listedAsset(assetUrl), kind: 'image' } ]
        };
        const discovered = discoverTargets(target, response, evidenceWithAddress);
        expect(discovered).toEqual([{ url: assetUrl, kind: 'asset', priority: 15 }]);
        await db.query(`INSERT INTO floor_plan.target(url,kind) VALUES($1,'page')`, [pageUrl]);
        await db.query(`INSERT INTO floor_plan.listing(url,source_id,facts,asset_urls)
            VALUES($1,'1',$2,$3)`, [pageUrl, JSON.stringify({ explicitLocation: validLocation }), JSON.stringify([listedAsset(assetUrl)])]);
        expect(await enqueue(db, assetUrl, { kind: 'asset', from: pageUrl })).toBe(true);
        expect((await db.query('SELECT url,kind FROM floor_plan.target ORDER BY url')).rows)
            .toEqual([{ url: assetUrl, kind: 'asset' }, { url: pageUrl, kind: 'page' }]);
    });

    it('purges excluded text and bytes, preserves cost/hash metadata, and protects shared or reviewed models', async () => {
        const excludedUrl = 'https://studio.test/project/without-address';
        const assetUrl = 'https://studio.test/project/photo.jpg';
        const sharedUrl = 'https://studio.test/project/shared';
        const eligibleUrl = 'https://studio.test/listing/eligible';
        const reviewedUrl = 'https://studio.test/project/reviewed';
        const htmlHash = hash('a'), imageHash = hash('b'), sharedHash = hash('c'), reviewedHash = hash('d');
        const discardedBytes = Buffer.from('private source bytes that must be dropped');

        await Promise.all([
            storeFixtureBlob({ hashValue: htmlHash, bytes: discardedBytes }),
            storeFixtureBlob({ hashValue: imageHash, bytes: discardedBytes, mediaType: 'image/jpeg' }),
            storeFixtureBlob({ hashValue: sharedHash, bytes: discardedBytes }),
            storeFixtureBlob({ hashValue: reviewedHash, bytes: discardedBytes, mediaType: 'image/jpeg' })
        ]);
        await db.query(`INSERT INTO floor_plan.target(url,kind,current_sha256,exclusion_reason,source_identity,etag,last_modified,failure) VALUES
            ($1,'page',$5,$6,$7,'tag','date','old failure'),($2,'asset',$8,NULL,$9,NULL,NULL,NULL),
            ($3,'page',$10,$6,$11,NULL,NULL,NULL),($4,'page',$12,$6,$13,NULL,NULL,NULL),
            ($14,'page',$10,NULL,$15,NULL,NULL,NULL)`,
        [excludedUrl, assetUrl, sharedUrl, reviewedUrl, htmlHash, EXCLUSION_REASON, listingIdentity(excludedUrl), imageHash,
            listingIdentity(assetUrl), sharedHash, listingIdentity(sharedUrl), reviewedHash, listingIdentity(reviewedUrl), eligibleUrl, listingIdentity(eligibleUrl)]);
        await db.query(`INSERT INTO floor_plan.exclusion(identity,url,source_sha256,reason) VALUES
            ($1,$2,$3,$5),($4,$6,$7,$5),($8,$9,$10,$5)`,
        [listingIdentity(excludedUrl), excludedUrl, htmlHash, listingIdentity(sharedUrl), EXCLUSION_REASON, reviewedUrl,
            reviewedHash, listingIdentity(reviewedUrl), reviewedUrl, reviewedHash]);
        await db.query(`INSERT INTO floor_plan.listing(url,facts,asset_urls,building_id,building_source,building_city,building_owner_id,building_evidence,match_status)
            VALUES($1,$2,$3,'b1','survey','zagreb','owner','{"private":"building evidence"}','verified'),
                  ($4,$5,'[]','b2','survey','zagreb','owner','{}','candidate')`,
        [excludedUrl, JSON.stringify({ title: 'private headline', description: 'private ad copy', explicitLocation: null }),
            JSON.stringify([listedAsset(assetUrl)]), eligibleUrl,
            JSON.stringify({ explicitLocation: validLocation })]);
        await db.query(`UPDATE floor_plan.listing SET facts=$2,asset_urls=$3 WHERE url=$1`,
            [sharedUrl, JSON.stringify({ explicitLocation: validLocation }), JSON.stringify([listedAsset(assetUrl)])]);
        await db.query(`INSERT INTO floor_plan.observation(url,sha256,evidence) VALUES
            ($1,$4,'{"text":"private html text"}'),($2,$5,'{"text":"private image text"}'),
            ($3,$6,'{"text":"shared text"}'),($7,$8,'{"text":"reviewed evidence"}'),
            ($9,$6,'{"text":"eligible shared observation"}')`,
        [excludedUrl, assetUrl, sharedUrl, htmlHash, imageHash, sharedHash, reviewedUrl, reviewedHash, eligibleUrl]);
        await db.query(`INSERT INTO floor_plan.extraction(sha256,status,model,evidence) VALUES
            ($1,'needs_review','{"schema":"consensus-builder.floor-plan-draft.v1","text":"private OCR"}','{"text":"private extraction text"}'),
            ($2,'needs_review','{"schema":"consensus-builder.floor-plan-draft.v1","text":"private OCR"}','{"text":"private image OCR"}'),
            ($3,'needs_review','{"schema":"consensus-builder.floor-plan-draft.v1"}','{}'),
            ($4,'reviewed','{"schema":"manual-building.v1","architecture":{"walls":[]}}','{"review":"approved"}')`,
        [htmlHash, imageHash, sharedHash, reviewedHash]);
        await db.query(`INSERT INTO floor_plan.image_task(source_sha256,result,status,cost_usd) VALUES
            ($1,'{"classification":"photo","text":"private result"}','complete',0.08),
            ($2,'{"classification":"photo"}','complete',0.04)`, [imageHash, sharedHash]);

        const first = await purgeExcludedContent(db);
        expect(first).toMatchObject({ assetsExcluded: 1, blobsDiscarded: 2, protectedBlobs: 2 });
        expect((await db.query(`SELECT sha256,NOT bytes_available AS bytes_discarded,discard_reason,byte_count
            FROM floor_plan.blob ORDER BY sha256`)).rows).toEqual([
            { sha256: htmlHash, bytes_discarded: true, discard_reason: EXCLUSION_REASON, byte_count: discardedBytes.length },
            { sha256: imageHash, bytes_discarded: true, discard_reason: EXCLUSION_REASON, byte_count: discardedBytes.length },
            { sha256: sharedHash, bytes_discarded: false, discard_reason: null, byte_count: discardedBytes.length },
            { sha256: reviewedHash, bytes_discarded: false, discard_reason: null, byte_count: discardedBytes.length }
        ]);
        expect((await db.query('SELECT facts,asset_urls,building_id,building_source,building_city,building_owner_id,building_evidence,match_status FROM floor_plan.listing WHERE url=$1', [excludedUrl])).rows[0])
            .toMatchObject({ facts: { sourceEvidenceStatus: 'excluded', exclusionReason: EXCLUSION_REASON }, asset_urls: [],
                building_id: null, building_source: null, building_city: null, building_owner_id: '', building_evidence: null, match_status: 'unresolved' });
        expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.observation WHERE url=ANY($1::text[])', [[excludedUrl, assetUrl]])).rows[0].n).toBe(0);
        expect((await db.query('SELECT model,evidence,status FROM floor_plan.extraction WHERE sha256=$1', [imageHash])).rows[0])
            .toMatchObject({ model: null, evidence: { excluded: true, reason: EXCLUSION_REASON }, status: 'not_plan' });
        expect((await db.query('SELECT source_sha256,cost_usd,result,status FROM floor_plan.image_task WHERE source_sha256=$1', [imageHash])).rows[0])
            .toMatchObject({ source_sha256: imageHash, cost_usd: '0.08', result: { excluded: true, reason: EXCLUSION_REASON }, status: 'complete' });
        expect((await db.query('SELECT current_sha256,etag,last_modified,failure,exclusion_reason FROM floor_plan.target WHERE url=$1', [excludedUrl])).rows[0])
            .toMatchObject({ current_sha256: null, etag: null, last_modified: null, failure: null, exclusion_reason: EXCLUSION_REASON });
        expect((await db.query('SELECT bytes_available FROM floor_plan.blob WHERE sha256=$1', [sharedHash])).rows[0].bytes_available).toBe(true);
        expect((await db.query('SELECT bytes_available FROM floor_plan.blob WHERE sha256=$1', [reviewedHash])).rows[0].bytes_available).toBe(true);

        expect(await enqueue(db, excludedUrl)).toBe(false);
        const second = await purgeExcludedContent(db);
        expect(second).toMatchObject({ assetsExcluded: 0, listingsPurged: 0, observationsPurged: 0, blobsDiscarded: 0, bytesDiscarded: 0 });
    });
});
