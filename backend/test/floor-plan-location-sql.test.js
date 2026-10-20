// Exercise location gates against PostgreSQL temporary fixtures; opt in to the local geodata connection.
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import dotenv from 'dotenv';
import { createClient } from '../db/connection.cjs';
import {fileURLToPath} from 'node:url';
import {locatedListingSql,PROCESSABLE_ASSET_SQL,PROCESSABLE_PLAN_TASK_SQL} from '../floor-plans/building-location.js';
import {BUILDING_PROCESSOR} from '../floor-plans/building-reading.js';
import {PROCESSOR} from '../floor-plans/plan-reading.js';
import {enqueuePlanTasks,currentTaskContext} from '../floor-plans/interpret-plans.js';
import {processAssets} from '../floor-plans/process-assets.js';

const fixtureBlobBytes=vi.hoisted(()=>new Map());
vi.mock('../floor-plans/blob-store.js',async importOriginal=>{
    const actual=await importOriginal();
    return {...actual,readBlobRow:vi.fn(async row=>row?.bytes_available
        ?fixtureBlobBytes.get(row.sha256||row.current_sha256)||null:null)};
});

const listingUrl='https://agency.test/listing/1',assetUrl='https://agency.test/plan.pdf';
const listingHash='a'.repeat(64),assetHash='b'.repeat(64);
const eligibleFacts={explicitLocation:{schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'}};
const candidate={id:'C1',city:'test-city',source:'survey',ownerId:'',buildingId:'42',bindingId:null};
const candidateResult=()=>({sourceCurrent:true,candidate,reading:{status:'candidate',candidateId:'C1',
    source:{url:listingUrl,sha256:listingHash},address:{value:'Example Street 12',quote:'Example Street 12'},
    quality:{confidence:'high'}}});

describe.runIf(process.env.FLOOR_PLAN_LOCATION_DB_TEST==='1')('floor-plan location SQL on isolated temporary tables',()=>{
    let client,db;
    beforeAll(async()=>{
        dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
        client=createClient({
            connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'floor-plan-location-tests'});
        await client.connect();
        expect((await client.query('SELECT current_database() AS name')).rows[0].name).toBe('geodata');
        await client.query('BEGIN');
        await client.query(`CREATE TEMP TABLE listing (url text PRIMARY KEY,facts jsonb,asset_urls jsonb,
            match_status text,building_city text,building_source text,building_id text,building_evidence jsonb,
            location_status text) ON COMMIT DROP;
            CREATE TEMP TABLE target (url text PRIMARY KEY,kind text,current_sha256 text,source_identity text,exclusion_reason text,
                image_classified_sha256 text,image_kind text) ON COMMIT DROP;
            CREATE TEMP TABLE exclusion (identity text,url text) ON COMMIT DROP;
            CREATE TEMP TABLE building_task (listing_url text,source_sha256 text,processor text,status text,
                result jsonb,candidate_map jsonb) ON COMMIT DROP;
            CREATE TEMP TABLE extraction (sha256 text PRIMARY KEY,model jsonb,status text,
                created_at timestamptz DEFAULT now(),updated_at timestamptz,vision_checked_at timestamptz,error text) ON COMMIT DROP;
            CREATE TEMP TABLE blob (sha256 text PRIMARY KEY,media_type text,byte_count integer NOT NULL,
                storage_path text,bytes_available boolean NOT NULL DEFAULT true,stored_at timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP;
            CREATE TEMP TABLE plan_task (id text PRIMARY KEY,source_sha256 text,source_url text,page int,
                listing_url text,context jsonb,processor text,status text DEFAULT 'queued',created_at timestamptz DEFAULT now()) ON COMMIT DROP;
            CREATE TEMP TABLE model_revision (source_sha256 text,model_sha256 text,model jsonb) ON COMMIT DROP;`);
        // Domain SQL uses only temporary tables and per-process test locks; live workers are unaffected.
        db={query:(sql,args)=>{
            const transaction={BEGIN:'SAVEPOINT domain_operation',COMMIT:'RELEASE SAVEPOINT domain_operation',ROLLBACK:'ROLLBACK TO SAVEPOINT domain_operation'};
            return client.query(transaction[sql]||sql.replaceAll('floor_plan.','pg_temp.')
                .replaceAll("hashtext('floor-plan-extraction')",`hashtext('floor-plan-extraction-location-test-${process.pid}')`),args);
        }};
    });
    afterAll(async()=>{
        if(client) {try {await client.query('ROLLBACK');} finally {await client.end();}}
    });
    beforeEach(async()=>{
        fixtureBlobBytes.clear();
        fixtureBlobBytes.set(assetHash,Buffer.from('test document'));
        await client.query('TRUNCATE pg_temp.listing,pg_temp.target,pg_temp.exclusion,pg_temp.building_task,pg_temp.extraction,pg_temp.blob,pg_temp.plan_task,pg_temp.model_revision');
        await db.query(`INSERT INTO floor_plan.listing VALUES($1,$2,$3,'unresolved',NULL,NULL,NULL,NULL,NULL)`,
            [listingUrl,JSON.stringify(eligibleFacts),JSON.stringify([{url:assetUrl,listingOwned:true,kind:'document'}])]);
        await db.query(`INSERT INTO floor_plan.target(url,kind,current_sha256,source_identity) VALUES($1,'page',$2,'listing:42'),($3,'asset',$4,NULL)`,
            [listingUrl,listingHash,assetUrl,assetHash]);
        await db.query(`INSERT INTO floor_plan.building_task VALUES($1,$2,$3,'candidate',$4,$5)`,
            [listingUrl,listingHash,BUILDING_PROCESSOR,JSON.stringify(candidateResult()),JSON.stringify([candidate])]);
        await db.query(`INSERT INTO floor_plan.extraction(sha256,model,status) VALUES($1,$2,'needs_review')`,
            [assetHash,JSON.stringify({schema:'consensus-builder.floor-plan-draft.v1',totalPages:1})]);
        await db.query(`INSERT INTO floor_plan.blob(sha256,media_type,byte_count,storage_path,bytes_available)
            VALUES($1,'application/pdf',13,'fixture/test-document.pdf',true)`,[assetHash]);
    });
    const eligible=async()=>Boolean((await db.query(`SELECT ${locatedListingSql()} AS eligible FROM floor_plan.listing l WHERE l.url=$1`,[listingUrl])).rows[0]?.eligible);

    it('accepts a current cited building candidate without promoting the listing to verified',async()=>{
        expect(await eligible()).toBe(true);
        expect((await db.query('SELECT match_status FROM floor_plan.listing')).rows[0].match_status).toBe('unresolved');
    });
    it('rejects a known building when source HTML has no explicit address',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query(`UPDATE floor_plan.listing SET facts='{}',match_status='verified',
            building_city='test-city',building_source='survey',building_id='42'`);
        expect(await eligible()).toBe(false);
    });
    it('rejects an excluded tombstone even when the listing has a known building',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query(`UPDATE floor_plan.listing SET match_status='verified',building_city='test-city',
            building_source='survey',building_id='42',building_evidence='{"locationPolicy":"explicit-address-v1"}'`);
        await db.query(`INSERT INTO floor_plan.exclusion(identity,url) VALUES('listing:42','https://agency.test/other-locale')`);
        expect(await eligible()).toBe(false);
    });
    it.each([['located',true],['probable',true],['ambiguous',false],['unresolved',false]])
    ('a street-only new build located heuristically as %s is located: %s',async(status,expected)=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query(`UPDATE floor_plan.listing SET facts='{"hasLocationSignal":true}',location_status=$1`,[status]);
        expect(await eligible()).toBe(expected);
    });
    it('a heuristic site location without any listing signal is not eligible',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query(`UPDATE floor_plan.listing SET facts='{}',location_status='located'`);
        expect(await eligible()).toBe(false);
    });
    it.each(['medium','high'])('accepts %s-confidence location evidence',async confidence=>{
        const result=candidateResult();result.reading.quality.confidence=confidence;
        await db.query('UPDATE floor_plan.building_task SET result=$1',[JSON.stringify(result)]);
        expect(await eligible()).toBe(true);
    });
    it.each([
        ['stale HTML',"UPDATE floor_plan.target SET current_sha256=repeat('c',64) WHERE kind='page'"],
        ['old reader',"UPDATE floor_plan.building_task SET processor='historical-reader'"],
        ['unresolved reading',"UPDATE floor_plan.building_task SET status='unresolved'"],
        ['missing mapping',"UPDATE floor_plan.building_task SET candidate_map='[]'"],
        ['non-listing',"UPDATE floor_plan.listing SET facts='{\"sourceEvidenceStatus\":\"not-a-listing\"}'"],
        ['spatial candidate only',"DELETE FROM floor_plan.building_task; UPDATE floor_plan.listing SET match_status='candidate'"],
    ])('rejects %s',async(_label,sql)=>{
        await db.query(sql);expect(await eligible()).toBe(false);
    });
    it.each([
        ['stale at collection',result=>{result.sourceCurrent=false;}],
        ['missing collection check',result=>{delete result.sourceCurrent;}],
        ['low confidence',result=>{result.reading.quality.confidence='low';}],
        ['mismatched selection',result=>{result.reading.candidateId='C2';}],
        ['wrong source hash',result=>{result.reading.source.sha256='c'.repeat(64);}],
        ['wrong listing',result=>{result.reading.source.url='https://agency.test/other';}],
        ['not a candidate',result=>{result.reading.status='unresolved';}],
        ['missing building ID',result=>{result.candidate={...candidate,buildingId:null};}],
        ['empty city',result=>{result.candidate={...candidate,city:' '};}],
        ['empty source',result=>{result.candidate={...candidate,source:''};}],
    ])('rejects a candidate with %s',async(_label,change)=>{
        const result=structuredClone(candidateResult());change(result);
        await db.query('UPDATE floor_plan.building_task SET result=$1',[JSON.stringify(result)]);
        expect(await eligible()).toBe(false);
    });
    it('accepts a verified canonical building independently, requiring every identity field',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query("UPDATE floor_plan.listing SET match_status='verified',building_city='test-city',building_source='survey',building_id='42',building_evidence='{\"locationPolicy\":\"explicit-address-v1\"}'");
        expect(await eligible()).toBe(true);
        for(const field of ['building_city','building_source','building_id']) {
            await client.query('SAVEPOINT field_check');
            await db.query(`UPDATE floor_plan.listing SET ${field}=NULL`);
            expect(await eligible()).toBe(false);
            await client.query('ROLLBACK TO field_check');
        }
    });
    it('rejects a legacy verified building link without the explicit-address policy marker',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query("UPDATE floor_plan.listing SET match_status='verified',building_city='test-city',building_source='survey',building_id='42',building_evidence='{}'");
        expect(await eligible()).toBe(false);
        await db.query("UPDATE floor_plan.listing SET building_evidence='{\"locationPolicy\":\"explicit-address-v1\"}'");
        expect(await eligible()).toBe(true);
    });
    it('processes a source-backed unknown-location plan while retaining the publication location gate',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query("UPDATE floor_plan.listing SET facts='{\"hasPlanAsset\":true}'");
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(true);
        expect(await enqueuePlanTasks(db,{sourceHash:assetHash})).toMatchObject({enqueued:1});
        const task=(await db.query('SELECT * FROM floor_plan.plan_task')).rows[0];
        expect(await currentTaskContext(db,task)).toBe(true);
        expect(await currentTaskContext(db,task,{requireLocation:true})).toBe(false);
        expect((await db.query(`SELECT id FROM floor_plan.plan_task WHERE ${PROCESSABLE_PLAN_TASK_SQL}`)).rows).toHaveLength(1);
        await db.query("UPDATE floor_plan.target SET current_sha256=$1 WHERE kind='asset'",['c'.repeat(64)]);
        expect(await currentTaskContext(db,task)).toBe(false);
        expect((await db.query(`SELECT id FROM floor_plan.plan_task WHERE ${PROCESSABLE_PLAN_TASK_SQL}`)).rows).toEqual([]);
    });
    it('extracts an owned unknown-location document but blocks its unrelated photo gallery',async()=>{
        await db.query('DELETE FROM floor_plan.building_task');
        await db.query("UPDATE floor_plan.listing SET facts='{\"hasPlanAsset\":true}'");
        await db.query("UPDATE floor_plan.extraction SET status='pending'");
        const extractor=vi.fn(async()=>({stdout:JSON.stringify({schema:'consensus-builder.floor-plan-draft.v1',status:'needs_review',pages:[],totalPages:1})}));
        expect(await processAssets(db,{extractor,log:()=>{}})).toMatchObject({status:'complete',processed:1,needsReview:1,deferredUnmatched:0});
        expect(extractor).toHaveBeenCalledOnce();
        await db.query("UPDATE floor_plan.listing SET asset_urls=$1",[JSON.stringify([{url:assetUrl,listingOwned:true,kind:'photo'}])]);
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(false);
        await db.query("UPDATE floor_plan.listing SET match_status='verified',building_id='42'");
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(false);
        await db.query("UPDATE floor_plan.target SET image_classified_sha256=current_sha256,image_kind='uncertain' WHERE kind='asset'");
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(true);
        await db.query("UPDATE floor_plan.target SET image_kind='photo' WHERE kind='asset'");
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(false);
        await db.query("UPDATE floor_plan.target SET image_kind='uncertain' WHERE kind='asset'");
        await db.query("UPDATE floor_plan.target SET image_classified_sha256=$1 WHERE kind='asset'",['c'.repeat(64)]);
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(false);
        await db.query("UPDATE floor_plan.listing SET asset_urls=$1",[JSON.stringify([{url:assetUrl,listingOwned:true,kind:'document'}])]);
        await db.query("INSERT INTO floor_plan.exclusion VALUES('listing:42',$1)",[listingUrl]);
        expect((await db.query(`SELECT ${PROCESSABLE_ASSET_SQL} AS eligible FROM floor_plan.extraction e`)).rows[0].eligible).toBe(false);
    });
});
