// Raw public sources live in gitignored, content-addressed files; PostgreSQL stores their metadata.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../data/floor-plan-downloads/', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Map([
 ['text/html',['html','html']], ['application/xhtml+xml',['html','html']],
 ['application/pdf',['pdf','pdf']], ['image/jpeg',['images','jpg']],
 ['image/png',['images','png']], ['image/webp',['images','webp']],
 ['image/avif',['images','avif']], ['image/gif',['images','gif']],
 ['image/svg+xml',['images','svg']], ['application/json',['other','json']],
 ['application/xml',['other','xml']], ['text/xml',['other','xml']],
 ['text/plain',['other','txt']],
]);

export const archiveRoot = () => resolve(process.env.FLOOR_PLAN_ARCHIVE_DIR || DEFAULT_ROOT);
export const contentHash = bytes => createHash('sha256').update(bytes).digest('hex');

function checkHash(hash) {
 if(!HASH.test(hash || '')) throw new Error('An archive source needs a lowercase SHA-256 hash.');
 return hash;
}

export function sourceStoragePath(hash, mediaType) {
 checkHash(hash);
 const [folder,extension] = TYPES.get(String(mediaType || '').split(';')[0].trim().toLowerCase()) || ['other','bin'];
 return `${folder}/${hash.slice(0,2)}/${hash}.${extension}`;
}

export function sourceFilePath(storagePath, hash, {root=archiveRoot()}={}) {
 checkHash(hash);
 const pattern = new RegExp(`^(?:html|pdf|images|other)/${hash.slice(0,2)}/${hash}\\.[a-z0-9]+$`);
 if(typeof storagePath!=='string' || !pattern.test(storagePath)) throw new Error('Invalid archive storage path.');
 const base=resolve(root), path=resolve(base,storagePath);
 if(!path.startsWith(base+sep)) throw new Error('Archive storage path escapes its directory.');
 return path;
}

function verifyBytes(bytes, hash, byteCount) {
 if(bytes.length!==Number(byteCount) || contentHash(bytes)!==hash)
  throw Object.assign(new Error(`Archived source file failed its size/hash check: ${hash}`),{code:'ARCHIVE_SOURCE_CORRUPT'});
 return bytes;
}

export async function readBlobRow(row, options={}) {
 if(!row || !row.bytes_available) return null;
 const hash=checkHash(row.sha256 || row.current_sha256);
 try {
  const bytes=await readFile(sourceFilePath(row.storage_path,hash,options));
  return verifyBytes(bytes,hash,row.byte_count);
 } catch(error) {
  if(error.code==='ENOENT') throw Object.assign(new Error(`Archived source file is missing: ${hash}`),{code:'ARCHIVE_SOURCE_MISSING'});
  throw error;
 }
}

export async function readBlob(db, hash, options={}) {
 checkHash(hash);
 const row=(await db.query(`SELECT sha256,media_type,byte_count,storage_path,bytes_available
  FROM floor_plan.blob WHERE sha256=$1`,[hash])).rows[0];
 return readBlobRow(row,options);
}

// Migration also uses this write-and-readback primitive before removing any database copy.
export async function writeSourceFile(bytes, hash, mediaType, options={}) {
 checkHash(hash);
 const body=Buffer.from(bytes);
 verifyBytes(body,hash,body.length);
 const storagePath=sourceStoragePath(hash,mediaType), path=sourceFilePath(storagePath,hash,options);
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 try {
  verifyBytes(await readFile(path),hash,body.length);
  return storagePath;
 } catch(error) {if(error.code!=='ENOENT') throw error;}
 const temporary=`${path}.${randomUUID()}.tmp`;
 let handle;
 try {
  handle=await open(temporary,'wx',0o600);
  await handle.writeFile(body);
  await handle.sync();
  await handle.close();handle=null;
  await rename(temporary,path);
  // Persist the directory entry as well as the content before recording its location in PostgreSQL.
  const directory=await open(dirname(path),'r');
  try {await directory.sync();} finally {await directory.close();}
  verifyBytes(await readFile(path),hash,body.length);
  return storagePath;
 } finally {
  if(handle) await handle.close();
  await rm(temporary,{force:true});
 }
}

// Mutating callers use one PostgreSQL client, as the crawler's advisory-lock contract already requires.
async function withSourceLock(db,hash,work) {
 await db.query(`SELECT pg_advisory_lock(hashtext('floor-plan-files'),hashtext($1))`,[hash]);
 try {return await work();}
 finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-files'),hashtext($1))`,[hash]);}
}

export async function writeBlob(db,bytes,mediaType='application/octet-stream',options={}) {
 const body=Buffer.from(bytes),hash=contentHash(body);
 return withSourceLock(db,hash,async()=>{
  const storagePath=await writeSourceFile(body,hash,mediaType,options);
  await db.query(`INSERT INTO floor_plan.blob(sha256,media_type,byte_count,storage_path,bytes_available,stored_at)
   VALUES($1,$2,$3,$4,true,now()) ON CONFLICT(sha256) DO UPDATE SET
    media_type=excluded.media_type,byte_count=excluded.byte_count,storage_path=excluded.storage_path,
    bytes_available=true,stored_at=now(),discarded_at=NULL,discard_reason=NULL,updated_at=now()`,
  [hash,mediaType || 'application/octet-stream',body.length,storagePath]);
  return hash;
 });
}

// Run after COMMIT. A rollback leaves the retained file intact; a failed unlink remains retryable.
export async function pruneDiscardedFiles(db,{hashes=null,...options}={}) {
 const rows=(await db.query(`SELECT sha256 FROM floor_plan.blob WHERE NOT bytes_available
  AND storage_path IS NOT NULL AND ($1::text[] IS NULL OR sha256=ANY($1)) ORDER BY sha256`,[hashes])).rows;
 const result={filesDeleted:0,bytesDeleted:0};
 for(const {sha256:hash} of rows) await withSourceLock(db,hash,async()=>{
  // Wait for a pending metadata writer's transaction, then recheck under the same lock used by writers.
  const row=(await db.query(`SELECT sha256,storage_path,byte_count,bytes_available FROM floor_plan.blob
   WHERE sha256=$1 FOR UPDATE`,[hash])).rows[0];
  if(!row || row.bytes_available || !row.storage_path) return;
  await rm(sourceFilePath(row.storage_path,hash,options),{force:true});
  await db.query(`UPDATE floor_plan.blob SET storage_path=NULL,updated_at=now()
   WHERE sha256=$1 AND NOT bytes_available`,[hash]);
  result.filesDeleted++;result.bytesDeleted+=Number(row.byte_count);
 });
 return result;
}
