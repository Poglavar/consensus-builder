import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { AnnotationError, createAnnotationStore } from '../floor-plans/review-annotations.js';

const reviewRoot = fileURLToPath(new URL('../../frontend/novogradnje/review/', import.meta.url));
const frontendRoot = fileURLToPath(new URL('../../frontend/', import.meta.url));
const MAX_BODY = 128 * 1024;
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function jsonBody(req) {
    let size = 0, chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new AnnotationError(413, 'Annotation document is too large.');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AnnotationError(400, 'Invalid JSON.'); }
}

export async function createReviewServer({ dataDirectory, annotationsDirectory = join(dataDirectory, 'annotations') }) {
    const drafts = JSON.parse(await readFile(join(dataDirectory, 'drafts.json'), 'utf8'));
    const store = createAnnotationStore({ directory: annotationsDirectory, drafts });
    const files = new Map();
    for (const file of ['index.html', 'style.css', 'preview.js', 'annotation-editor.js', 'annotations.js']) files.set('/' + file, join(reviewRoot, file));
    for (const file of ['building-floor-plans.js', 'three-floor-plans.js', 'floor-plan-review-renderer.js']) files.set('/' + file, join(frontendRoot, 'js', file));
    files.set('/viewer.js', join(frontendRoot, 'novogradnje/viewer.js'));
    files.set('/drafts.json', join(dataDirectory, 'drafts.json'));
    files.set('/', files.get('/index.html'));
    for (const draft of drafts) {
        if (!/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(draft.image)) throw new Error('Invalid review image filename');
        files.set('/' + draft.image, join(dataDirectory, draft.image));
    }
    return http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const sendJson = (status, value) => { res.writeHead(status, { 'Content-Type': mime.json }); res.end(JSON.stringify(value) + '\n'); };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname.startsWith('/api/annotations/')) {
                const unit = decodeURIComponent(url.pathname.slice('/api/annotations/'.length));
                if (!store.has(unit)) throw new AnnotationError(404, 'Unknown apartment.');
                if (req.method === 'GET') return sendJson(200, await store.read(unit));
                if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); throw new AnnotationError(405, 'Method not allowed.'); }
                // JSON requests from this same-origin viewer only; never enable permissive CORS.
                if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AnnotationError(415, 'Use application/json.');
                if (req.headers['sec-fetch-site'] === 'cross-site') throw new AnnotationError(403, 'Cross-site writes are not allowed.');
                return sendJson(200, await store.write(unit, await jsonBody(req)));
            }
            if (!['GET', 'HEAD'].includes(req.method)) throw new AnnotationError(405, 'Method not allowed.');
            const path = files.get(url.pathname);
            if (!path) throw new AnnotationError(404, 'Not found.');
            const bytes = await readFile(path), type = mime[path.split('.').at(-1)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
            res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) {
            if (!error.status && error.code !== 'ENOENT') console.error('Review request failed:', error.message);
            sendJson(error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : 'Unable to read or save this review.' });
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const usage = 'Usage: node backend/scripts/novogradnje-draft-review-server.mjs --port PORT --data-dir DIRECTORY [--annotations-dir DIRECTORY]';
    if (process.argv.length <= 2 || process.argv.includes('--help')) console.log(usage);
    else {
        const args = process.argv.slice(2), options = {};
        for (let i = 0; i < args.length; i += 2) {
            if (!['--port', '--data-dir', '--annotations-dir'].includes(args[i]) || !args[i + 1]) throw new Error(usage);
            options[args[i]] = args[i + 1];
        }
        const port = Number(options['--port']);
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || !options['--data-dir']) throw new Error(usage);
        const server = await createReviewServer({ dataDirectory: resolve(options['--data-dir']),
            ...(options['--annotations-dir'] ? { annotationsDirectory: resolve(options['--annotations-dir']) } : {}) });
        server.listen(port, '127.0.0.1', () => console.log(`Draft annotation review listening on loopback port ${port}`));
        const close = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); };
        process.on('SIGTERM', close); process.on('SIGINT', close);
    }
}
