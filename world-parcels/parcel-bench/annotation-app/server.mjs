#!/usr/bin/env node
import http from 'node:http';
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVIEW_SCHEMA, validateBatch, validateReview } from './public/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const STATIC_FILES = new Set(['index.html', 'styles.css', 'app.mjs', 'storage.mjs', 'model.mjs', 'viewer.mjs', 'strings.mjs', 'sw.js', 'manifest.webmanifest', 'icon.svg']);
const MAX_BODY = 128 * 1024;
const STORE_SCHEMA = 'plot-review-store-v1';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function batchPayloadHash(batch) {
    const { batch_hash: _ignored, ...payload } = batch;
    return sha256(Buffer.from(JSON.stringify(payload)));
}
function normalizedBasePath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#') || value.includes('\\')) throw new Error('Invalid basePath');
    const path = value.endsWith('/') ? value : `${value}/`;
    if (path !== '/' && !/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(path)) throw new Error('Invalid basePath');
    return path;
}
function parseOrigin(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('publicOrigin must be an origin URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('publicOrigin must be an origin URL');
    return url.origin;
}
function cookieValue(header, name) {
    for (const piece of (header || '').split(';')) {
        const index = piece.indexOf('=');
        if (index > 0 && piece.slice(0, index).trim() === name) return piece.slice(index + 1).trim();
    }
    return '';
}
function safeEqualText(a, b) {
    const aa = Buffer.from(a), bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}
async function durableReplace(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await rename(temporary, path);
        const dir = await open(dirname(path), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
    } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

async function loadAndValidateBundle(bundleDir) {
    const batch = await readJson(join(bundleDir, 'batch.json'));
    validateBatch(batch);
    if (batchPayloadHash(batch) !== batch.batch_hash) throw new Error('Batch hash does not match its contents');
    for (const sample of batch.samples) {
        const path = resolve(bundleDir, sample.image);
        if (!path.startsWith(`${resolve(bundleDir)}${sep}`)) throw new Error('Image path escapes bundle directory');
        if (sha256(await readFile(path)) !== sample.image_sha256) throw new Error(`Image hash mismatch for ${sample.id}`);
    }
    return batch;
}

function validateStore(store, batch) {
    if (!store || store.schema !== STORE_SCHEMA || store.batch_hash !== batch.batch_hash || !store.reviews || Array.isArray(store.reviews) || !Array.isArray(store.history)) throw new Error('Review store schema or batch hash mismatch');
    const mutations = new Map();
    for (const record of [...Object.values(store.reviews), ...store.history]) {
        if (!record || !Number.isInteger(record.revision) || record.revision < 1 || !isUuid(record.mutation_id) || typeof record.updated_at !== 'string') throw new Error('Invalid review store record');
        const clean = validateReview(record.value, batch);
        if (record.id !== clean.id || JSON.stringify(clean) !== JSON.stringify(record.value)) throw new Error('Invalid review store value');
        const fingerprint = JSON.stringify({ id: record.id, value: record.value });
        const prior = mutations.get(record.mutation_id);
        if (prior && prior !== fingerprint) throw new Error('Reused mutation id in review store');
        mutations.set(record.mutation_id, fingerprint);
    }
}

export async function createReviewServer({ bundleDir, dataDir, token, basePath = '/', publicOrigin }) {
    if (typeof bundleDir !== 'string' || typeof dataDir !== 'string' || typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) throw new Error('bundleDir, dataDir and a token of at least 32 bytes are required');
    const bundle = resolve(bundleDir), data = resolve(dataDir);
    if (!bundleDir.startsWith('/') || !dataDir.startsWith('/')) throw new Error('bundleDir and dataDir must be absolute paths');
    if (bundle === data || bundle.startsWith(`${data}${sep}`) || data.startsWith(`${bundle}${sep}`)) throw new Error('bundleDir and dataDir must be separate');
    const prefix = normalizedBasePath(basePath), origin = parseOrigin(publicOrigin);
    const batch = await loadAndValidateBundle(bundle);
    await mkdir(data, { recursive: true, mode: 0o700 });
    const storePath = join(data, 'reviews.json'), lockPath = join(data, 'reviews.lock');
    let lockFd;
    try { lockFd = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another annotation server owns this data directory');
        throw error;
    }
    let store;
    try {
        writeSync(lockFd, `${process.pid}\n`, null, 'utf8');
        fsyncSync(lockFd);
        try { store = await readJson(storePath); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            store = { schema: STORE_SCHEMA, batch_hash: batch.batch_hash, reviews: {}, history: [] };
            await durableReplace(storePath, store);
        }
        validateStore(store, batch);
    } catch (error) {
        closeSync(lockFd);
        try { unlinkSync(lockPath); } catch {}
        throw error;
    }

    const cookieName = 'plot_review_session';
    const cookiePath = prefix;
    const secureCookie = origin.startsWith('https:') ? '; Secure' : '';
    const sign = nonce => createHmac('sha256', token).update(nonce).digest('base64url');
    const authenticated = req => {
        const raw = cookieValue(req.headers.cookie, cookieName);
        const split = raw.indexOf('.');
        if (split < 1) return false;
        const nonce = raw.slice(0, split), signature = raw.slice(split + 1);
        return /^[A-Za-z0-9_-]{32,}$/.test(nonce) && safeEqualText(signature, sign(nonce));
    };
    let authFailures = 0, authWindow = Date.now();
    let mutationQueue = Promise.resolve();
    const imageHashes = new Map(batch.samples.map(sample => [sample.id, sample.image_sha256]));
    const apiPath = name => `${prefix}api/${name}`;
    const currentReviews = () => Object.values(store.reviews).sort((a, b) => a.id.localeCompare(b.id));
    const sendJson = (res, status, value, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
        res.end(`${JSON.stringify(value)}\n`);
    };
    const readBody = async req => {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Use application/json'), { status: 415 });
        let size = 0; const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large'), { status: 413 });
            chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
    };
    const requireOrigin = req => {
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('Cross-origin request rejected'), { status: 403 });
    };
    const requireAuth = req => { if (!authenticated(req)) throw Object.assign(new Error('Authentication required'), { status: 401 }); };
    const server = http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            const url = new URL(req.url, origin);
            const path = url.pathname;
            if (url.searchParams.has('token') || url.searchParams.has('auth')) throw Object.assign(new Error('Authentication is not accepted in query parameters'), { status: 400 });
            if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) throw Object.assign(new Error('Method not allowed'), { status: 405 });
            if (path === apiPath('session')) {
                if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, { authenticated: authenticated(req) });
                if (req.method !== 'POST') throw Object.assign(new Error('Method not allowed'), { status: 405 });
                requireOrigin(req);
                if (Date.now() - authWindow > 15 * 60_000) { authWindow = Date.now(); authFailures = 0; }
                if (authFailures >= 10) throw Object.assign(new Error('Too many authentication attempts'), { status: 429 });
                const body = await readBody(req);
                if (typeof body?.token !== 'string' || !safeEqualText(body.token, token)) {
                    authFailures++;
                    throw Object.assign(new Error('Invalid token'), { status: 401 });
                }
                authFailures = 0;
                const nonce = randomBytes(32).toString('base64url');
                return sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': `${cookieName}=${nonce}.${sign(nonce)}; Path=${cookiePath}; Max-Age=2592000; HttpOnly; SameSite=Strict${secureCookie}` });
            }
            if (path === apiPath('health') && ['GET', 'HEAD'].includes(req.method)) return sendJson(res, 200, { status: 'ok' });
            if (path.startsWith(apiPath(''))) {
                requireAuth(req);
                if (path === apiPath('batch') && ['GET', 'HEAD'].includes(req.method)) return sendJson(res, 200, batch);
                if (path === apiPath('reviews') && ['GET', 'HEAD'].includes(req.method)) return sendJson(res, 200, { schema: REVIEW_SCHEMA, batch_hash: batch.batch_hash, batch, reviews: currentReviews(), history: store.history });
                const reviewPrefix = apiPath('reviews/');
                const reviewId = path.startsWith(reviewPrefix) ? path.slice(reviewPrefix.length) : '';
                if (/^[A-Za-z0-9_-]{1,120}$/.test(reviewId) && req.method === 'PUT') {
                    requireOrigin(req);
                    const id = reviewId, body = await readBody(req);
                    if (body.batch_hash !== batch.batch_hash) throw Object.assign(new Error('Batch hash mismatch'), { status: 409 });
                    if (!Number.isInteger(body.base_revision) || body.base_revision < 0 || !isUuid(body.mutation_id)) throw Object.assign(new Error('Invalid revision or mutation id'), { status: 400 });
                    let value;
                    try { value = validateReview(body.value, batch); }
                    catch (error) { throw Object.assign(new Error(error.message), { status: 400 }); }
                    if (id !== value.id) throw Object.assign(new Error('Path id does not match review id'), { status: 400 });
                    const fingerprint = JSON.stringify({ id, value });
                    const run = mutationQueue.catch(() => {}).then(async () => {
                        const duplicate = store.history.find(record => record.mutation_id === body.mutation_id);
                        if (duplicate) {
                            if (JSON.stringify({ id: duplicate.id, value: duplicate.value }) !== fingerprint) throw Object.assign(new Error('Mutation id was already used for another value'), { status: 409 });
                            return duplicate;
                        }
                        const current = Object.hasOwn(store.reviews, id) ? store.reviews[id] : undefined;
                        const revision = current?.revision || 0;
                        if (body.base_revision !== revision) throw Object.assign(new Error('Revision conflict'), { status: 409, current: current || null });
                        const record = { id, revision: revision + 1, value, mutation_id: body.mutation_id, updated_at: new Date().toISOString() };
                        const next = { ...store, reviews: { ...store.reviews, [id]: record }, history: [...store.history, record] };
                        await durableReplace(storePath, next);
                        store = next;
                        return record;
                    });
                    mutationQueue = run;
                    try { return sendJson(res, 200, await run); }
                    catch (error) {
                        if (error.current !== undefined) return sendJson(res, 409, { error: error.message, current: error.current });
                        throw error;
                    }
                }
                throw Object.assign(new Error('Not found'), { status: 404 });
            }
            if (path.startsWith(`${prefix}images/`)) {
                requireAuth(req);
                if (!['GET', 'HEAD'].includes(req.method)) throw Object.assign(new Error('Method not allowed'), { status: 405 });
                const imageName = path.slice(`${prefix}images/`.length);
                const imageMatch = imageName.match(/^([A-Za-z0-9_-]{1,120})\.jpg$/);
                const id = imageMatch?.[1];
                if (!id || !imageHashes.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
                const bytes = await readFile(join(bundle, 'images', `${id}.jpg`));
                if (sha256(bytes) !== imageHashes.get(id)) throw Object.assign(new Error('Image integrity check failed'), { status: 500 });
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
                return res.end(req.method === 'HEAD' ? undefined : bytes);
            }
            if (path.startsWith(prefix) && ['GET', 'HEAD'].includes(req.method)) {
                const name = path === prefix ? 'index.html' : path.slice(prefix.length);
                if (STATIC_FILES.has(name) && !name.includes('/')) {
                    const bytes = await readFile(join(PUBLIC_DIR, name));
                    res.writeHead(200, { 'Content-Type': MIME[name.endsWith('.webmanifest') ? '.webmanifest' : name.slice(name.lastIndexOf('.'))] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': bytes.length });
                    return res.end(req.method === 'HEAD' ? undefined : bytes);
                }
            }
            throw Object.assign(new Error('Not found'), { status: 404 });
        } catch (error) {
            if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Request failed', ...(error.current !== undefined ? { current: error.current } : {}) });
            else res.destroy();
        }
    });
    let released = false;
    server.once('close', () => {
        if (released) return;
        released = true;
        closeSync(lockFd);
        try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { ANNOTATION_BUNDLE: bundleDir, ANNOTATION_DATA: dataDir, ANNOTATION_TOKEN: token,
        ANNOTATION_BASE_PATH: basePath = '/', ANNOTATION_ORIGIN: publicOrigin, ANNOTATION_PORT = '8787' } = process.env;
    const port = Number(ANNOTATION_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ANNOTATION_PORT must be between 1024 and 65535');
    const server = await createReviewServer({ bundleDir, dataDir, token, basePath, publicOrigin });
    server.listen(port, '127.0.0.1', () => console.log(`Annotation review listening on loopback port ${port}`));
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close); process.on('SIGINT', close);
}
