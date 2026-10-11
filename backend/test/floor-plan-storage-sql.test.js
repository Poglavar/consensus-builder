// Exercise file export, metadata writes, deletion and idempotent migration on isolated PostgreSQL temporary tables.
import { describe,it,expect } from 'vitest';
import dotenv from 'dotenv';
import pg from 'pg';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateArchiveStorage } from '../floor-plans/storage-migration.js';
import { contentHash,writeBlob,readBlob,sourceFilePath,pruneDiscardedFiles } from '../floor-plans/blob-store.js';

describe.runIf(process.env.FLOOR_PLAN_LOCATION_DB_TEST==='1')('filesystem source storage on temporary PostgreSQL tables',()=>{
 it('preserves bytes through verified export, then drops them only with explicit opt-in',async()=>{
  dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
  const connectionUrl=process.env.DATABASE_URL?new URL(process.env.DATABASE_URL):null;
  if(connectionUrl){connectionUrl.hostname='127.0.0.1';connectionUrl.port='5432';}
  const client=new pg.Client({connectionString:connectionUrl?.href,host:'127.0.0.1',port:5432,
   connectionTimeoutMillis:5000,statement_timeout:10000,application_name:'floor-plan-file-storage-tests'});
  const root=await mkdtemp(join(tmpdir(),'floor-plan-storage-sql-'));
  await client.connect();
  try {
   const identity=(await client.query('SELECT current_database() AS name,inet_server_port() AS port')).rows[0];
   expect(identity).toEqual({name:'geodata',port:5432});
   const liveLegacyColumns=(await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='floor_plan' AND table_name='blob' AND column_name='data'`)).rows[0].n;
   await client.query('BEGIN');
   await client.query(`CREATE TEMP TABLE blob(sha256 text PRIMARY KEY,media_type text,byte_count integer,
    data bytea NOT NULL,discarded_at timestamptz,discard_reason text,created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()) ON COMMIT DROP`);
   const db={query:(sql,args)=>{
    if(sql.includes('information_schema.columns')) return client.query(`SELECT a.attname AS column_name,CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
     FROM pg_attribute a WHERE a.attrelid='pg_temp.blob'::regclass AND a.attnum>0 AND NOT a.attisdropped`);
    // Unique test locks never contend with a real crawler; all table mutations stay in pg_temp.
    return client.query(sql.replaceAll('floor_plan.blob','pg_temp.blob')
     .replaceAll("hashtext('floor-plan-files')",`hashtext('floor-plan-files-test-${process.pid}')`),
    sql.includes('pg_try_advisory_lock(hashtext($1))')||sql.includes('pg_advisory_unlock(hashtext($1))')
     ?[`${args[0]}-test-${process.pid}`]:args);
   }};
   const originals=[Buffer.from('<html>Public source</html>'),Buffer.from('%PDF-1.4\nSource fixture')];
   for(const [index,bytes] of originals.entries()) await db.query(`INSERT INTO floor_plan.blob
    (sha256,media_type,byte_count,data) VALUES($1,$2,$3,$4)`,[contentHash(bytes),index?'application/pdf':'text/html',bytes.length,bytes]);
   const first=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
   expect(first).toMatchObject({exportedBlobs:2,verifiedBlobs:2,legacyColumnPresent:true,legacyColumnRemoved:false,status:'complete'});
   const kept=(await db.query('SELECT data FROM floor_plan.blob ORDER BY sha256')).rows.map(row=>row.data);
   expect(kept).toHaveLength(2);expect(kept.every(Boolean)).toBe(true);
   expect((await client.query(`SELECT attnotnull FROM pg_attribute
    WHERE attrelid='pg_temp.blob'::regclass AND attname='data'`)).rows[0].attnotnull).toBe(false);
   for(const bytes of originals) expect(await readBlob(db,contentHash(bytes),{root})).toEqual(bytes);
   const repeat=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
   expect(repeat).toMatchObject({exportedBlobs:0,verifiedBlobs:2,legacyColumnPresent:true,legacyColumnRemoved:false,status:'complete'});
   const drop=await migrateArchiveStorage(db,{apply:true,dropDatabaseBytes:true,root,log:()=>{}});
   expect(drop).toMatchObject({legacyColumnRemoved:true,status:'complete'});
   expect((await db.query('SELECT count(*)::int AS n FROM floor_plan.blob')).rows[0].n).toBe(2);
   const repeatDrop=await migrateArchiveStorage(db,{apply:true,dropDatabaseBytes:true,root,log:()=>{}});
   expect(repeatDrop).toMatchObject({legacyColumnPresent:false,legacyColumnRemoved:false,status:'complete'});
   const newBytes=Buffer.from('Future image fixture'),hash=await writeBlob(db,newBytes,'image/png',{root});
   expect(await readBlob(db,hash,{root})).toEqual(newBytes);
   const metadata=(await db.query('SELECT * FROM floor_plan.blob WHERE sha256=$1',[hash])).rows[0];
   expect(metadata).not.toHaveProperty('data');
   expect(metadata).toMatchObject({bytes_available:true,byte_count:newBytes.length});
   await db.query('UPDATE floor_plan.blob SET bytes_available=false,discarded_at=now() WHERE sha256=$1',[hash]);
   expect(await pruneDiscardedFiles(db,{hashes:[hash],root})).toEqual({filesDeleted:1,bytesDeleted:newBytes.length});
   await expect(readFile(sourceFilePath(metadata.storage_path,hash,{root}))).rejects.toMatchObject({code:'ENOENT'});
   expect(await readBlob(db,hash,{root})).toBeNull();
   expect((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='floor_plan' AND table_name='blob' AND column_name='data'`)).rows[0].n).toBe(liveLegacyColumns);
  } finally {
   await client.query('ROLLBACK');await client.end();await rm(root,{recursive:true,force:true});
  }
 },20000);
});
