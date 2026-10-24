// A map share identifies a set of published designs, not another domain record. Its social image
// is a derived asset keyed by that set and a renderer revision. Disk manifests survive restarts;
// unsuccessful renders write nothing and are retried by the next prepare/image request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from 'canvas';
import { isCid } from '../cid.js';
import { loadDesigns, MAX_DESIGN_BATCH } from '../routes/designs.js';
import { proposalGeometryView } from '../proposals/footprint.js';
import { resolveDesignParts } from './proposal-thumbnail.js';
import { renderProposalThumbnailSet, lngLatToPixel, drawPolygons } from './tile-stitch.js';
import { createLimiter } from './tile-source.js';
import { METADATA_DIR, imageFileExists, saveImageBuffer } from '../utils/image-store.js';

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;
const REVISION = 'map-preview-20261024';

function failure(status, message) {
    return Object.assign(new Error(message), { status });
}

export function previewCids(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_DESIGN_BATCH || !value.every(isCid)) {
        throw failure(400, `A list of 1 to ${MAX_DESIGN_BATCH} design CIDs is required.`);
    }
    return [...new Set(value)].sort();
}

export function previewKey(cids) {
    return `${REVISION}-${createHash('sha256').update(previewCids(cids).join(',')).digest('hex')}`;
}

export function previewRenderOptions(designs) {
    const parts = designs.flatMap(design => resolveDesignParts(proposalGeometryView({ proposal_data: design.content })));
    if (!parts.length) throw failure(422, 'These designs have no map geometry to preview.');
    return { polygon: parts[0], polygonParts: parts, polygonOrder: 'lnglat', padding: 0.12, zoom: 19 };
}

// Crop to the padded subject bounds rather than the tile grid. Contain the whole plan inside the
// social aspect ratio, so tall sites and distant members are never cut off by a cover crop.
export async function renderMapPreview(designs, { render = renderProposalThumbnailSet } = {}) {
    const set = await render(previewRenderOptions(designs));
    if (set.tiles.loaded !== set.tiles.total || !set.tiles.loaded) {
        throw failure(503, 'The preview basemap is incomplete. Please retry.');
    }
    const source = await loadImage(set.before.buffer);
    const f = set.frame;
    const topLeft = lngLatToPixel(f.lngMin, f.latMax, f.xMin, f.yMin, f.zoom);
    const bottomRight = lngLatToPixel(f.lngMax, f.latMin, f.xMin, f.yMin, f.zoom);
    const sw = Math.max(1, bottomRight.px - topLeft.px);
    const sh = Math.max(1, bottomRight.py - topLeft.py);
    const canvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f1f3f5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / sw, (canvas.height - 28) / sh);
    const width = sw * scale;
    const height = sh * scale;
    ctx.drawImage(source, topLeft.px, topLeft.py, sw, sh,
        (canvas.width - width) / 2, (canvas.height - 28 - height) / 2, width, height);
    // Keep the subject's borders sharp at social-card resolution, even when its basemap is enlarged.
    ctx.save();
    ctx.translate((canvas.width - width) / 2 - topLeft.px * scale,
        (canvas.height - 28 - height) / 2 - topLeft.py * scale);
    ctx.scale(scale, scale);
    drawPolygons(ctx, f, f.polygons.map(polygon => ({ ...polygon,
        style: { ...polygon.style, weight: polygon.style.weight / scale } })));
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, canvas.height - 28, canvas.width, 28);
    ctx.fillStyle = '#333333';
    ctx.font = '14px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Urban Game Theory', 12, canvas.height - 14);
    ctx.textAlign = 'right';
    ctx.fillText('© MapTiler © OpenStreetMap contributors', canvas.width - 12, canvas.height - 14);
    return canvas.toBuffer('image/png');
}

export function createMapPreviewService({ pool, cacheDir = METADATA_DIR, load = loadDesigns,
    render = renderMapPreview, save = saveImageBuffer, exists = imageFileExists, maxQueued = 20, renderAttempts = 2 } = {}) {
    const active = new Map();
    const limiter = createLimiter(2);

    async function renderWithRetry(designs) {
        for (let attempt = 1; ; attempt++) {
            try { return await render(designs); }
            catch (error) {
                if (attempt >= renderAttempts || (error.status && error.status < 500)) throw error;
            }
        }
    }

    async function readCache(file) {
        try {
            const record = JSON.parse(await fs.readFile(file, 'utf8'));
            if (typeof record.fileName === 'string' && exists(record.fileName)) return record;
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return null;
    }

    async function prepare(value) {
        const cids = previewCids(value);
        const key = previewKey(cids);
        const manifest = path.join(cacheDir, `${key}.json`);
        const cached = await readCache(manifest);
        if (cached) return cached;
        if (active.has(key)) return active.get(key);
        if (active.size >= maxQueued) throw failure(503, 'Preview rendering is busy. Please retry.');
        const pending = limiter.run(async () => {
            const found = await load(pool, cids);
            if (cids.some(cid => !found.has(cid))) throw failure(404, 'A shared design was not found.');
            const buffer = await renderWithRetry(cids.map(cid => found.get(cid)));
            const { fileName, imagePath } = save(buffer, key);
            const record = { fileName, imagePath, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT };
            await fs.mkdir(cacheDir, { recursive: true });
            const temporary = `${manifest}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
                await fs.rename(temporary, manifest);
            } finally {
                await fs.unlink(temporary).catch(() => {});
            }
            return record;
        });
        active.set(key, pending);
        try { return await pending; } finally { active.delete(key); }
    }
    return { prepare };
}
