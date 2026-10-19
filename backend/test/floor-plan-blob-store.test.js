// Verify filesystem bytes, metadata-only writes, corruption detection and safe discarded-file pruning.
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtemp,readFile,writeFile,stat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash,sourceStoragePath,sourceFilePath,writeSourceFile,writeBlob,readBlob,readBlobRow,pruneDiscardedFiles } from '../floor-plans/blob-store.js';

let root;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'floor-plan-blob-test-'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const body=Buffer.from('Public source bytes');
const hash=contentHash(body);
const metadata=media=>({sha256:hash,media_type:media,byte_count:body.length,
 storage_path:sourceStoragePath(hash,media),bytes_available:true});

describe('file-backed archive',()=>{
 it.each([['text/html','html','.html'],['application/pdf','pdf','.pdf'],['image/jpeg','images','.jpg'],
  ['image/png','images','.png'],['application/json','other','.json']])
 ('stores %s in its ignored source folder and verifies a file read',async(media,folder,extension)=>{
  const path=await writeSourceFile(body,hash,media,{root});
  expect(path).toBe(`${folder}/${hash.slice(0,2)}/${hash}${extension}`);
  expect(await readBlobRow(metadata(media),{root})).toEqual(body);
  expect((await stat(sourceFilePath(path,hash,{root}))).mode&0o777).toBe(0o600);
 });
 it('deduplicates an existing source without rewriting its file',async()=>{
  const path=await writeSourceFile(body,hash,'text/html',{root});
  const before=await stat(sourceFilePath(path,hash,{root}));
  expect(await writeSourceFile(body,hash,'text/html',{root})).toBe(path);
  expect((await stat(sourceFilePath(path,hash,{root}))).mtimeMs).toBe(before.mtimeMs);
 });
 it('passes only hashes, media type, size and a relative path into PostgreSQL',async()=>{
  let row;
  const db={query:vi.fn(async(sql,params)=>{
   if(sql.includes('INSERT INTO floor_plan.blob')) row={...metadata(params[1]),storage_path:params[3]};
   if(sql.includes('FROM floor_plan.blob WHERE sha256=$1')) return {rows:[row]};
   return {rows:[],rowCount:1};
  })};
  expect(await writeBlob(db,body,'application/pdf',{root})).toBe(hash);
  const [sql,args]=db.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.blob'));
  expect(args).toEqual([hash,'application/pdf',body.length,sourceStoragePath(hash,'application/pdf')]);
  expect(sql).toContain('bytes_available=true');
  expect(sql).not.toMatch(/\bdata\b/);
  expect(await readBlob(db,hash,{root})).toEqual(body);
 });
 it('distinguishes discarded content from a missing retained file',async()=>{
  expect(await readBlobRow({...metadata('image/png'),bytes_available:false},{root})).toBeNull();
  await expect(readBlobRow(metadata('image/png'),{root})).rejects.toMatchObject({code:'ARCHIVE_SOURCE_MISSING'});
 });
 it('keeps one file for a content hash when a later response changes the MIME type',async()=>{
  const existingPath=await writeSourceFile(body,hash,'text/plain',{root});
  const db={query:vi.fn(async(sql)=>({rows:sql.includes('FOR UPDATE')?[{storage_path:existingPath}]:[],rowCount:1}))};
  await writeBlob(db,body,'text/html',{root});
  const [,params]=db.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.blob'));
  expect(params[3]).toBe(existingPath);
  expect(await readFile(sourceFilePath(existingPath,hash,{root}))).toEqual(body);
  await expect(readFile(sourceFilePath(sourceStoragePath(hash,'text/html'),hash,{root}))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('rejects corrupt bytes, a wrong declared size and paths outside the source root',async()=>{
  const row=metadata('application/pdf');
  await writeSourceFile(body,hash,row.media_type,{root});
  await expect(readBlobRow({...row,byte_count:1},{root})).rejects.toMatchObject({code:'ARCHIVE_SOURCE_CORRUPT'});
  await writeFile(sourceFilePath(row.storage_path,hash,{root}),Buffer.alloc(body.length));
  await expect(readBlobRow(row,{root})).rejects.toMatchObject({code:'ARCHIVE_SOURCE_CORRUPT'});
  await expect(readBlobRow({...row,storage_path:'../../private-file'},{root})).rejects.toThrow(/Invalid archive storage path/);
  await expect(writeSourceFile(body,'a'.repeat(64),row.media_type,{root})).rejects.toMatchObject({code:'ARCHIVE_SOURCE_CORRUPT'});
 });
 it('unlinks only committed discarded files, leaving restored hashes intact',async()=>{
  const discarded={...metadata('image/jpeg'),bytes_available:false};
  const retained={...metadata('application/pdf')};
  await writeSourceFile(body,hash,discarded.media_type,{root});
  await writeSourceFile(body,hash,retained.media_type,{root});
  let current=discarded;
  const db={query:vi.fn(async(sql)=>{
   if(sql.startsWith('SELECT sha256 FROM')) return {rows:[{sha256:hash}]};
   if(sql.includes('FOR UPDATE')) return {rows:[current]};
   return {rows:[],rowCount:1};
  })};
  expect(await pruneDiscardedFiles(db,{root})).toEqual({filesDeleted:1,bytesDeleted:body.length});
  await expect(readFile(sourceFilePath(discarded.storage_path,hash,{root}))).rejects.toMatchObject({code:'ENOENT'});
  current=retained;
  expect(await pruneDiscardedFiles(db,{root})).toEqual({filesDeleted:0,bytesDeleted:0});
  expect(await readBlobRow(retained,{root})).toEqual(body);
 });
});
