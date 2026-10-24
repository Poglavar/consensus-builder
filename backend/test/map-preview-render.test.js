import { describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from 'canvas';
import { renderMapPreview, previewRenderOptions } from '../thumbnails/map-preview.js';
import { computeStitchFrame, renderProposalThumbnailSet } from '../thumbnails/tile-stitch.js';

const box = (x, y, w = 0.0005, h = 0.0005) => ({ type: 'Polygon', coordinates: [[
    [x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]
]] });
const designs = [box(-0.12, 51.5), box(-0.116, 51.5)].map(site => ({ content: { site } }));

describe('map social image rendering', () => {
    it('frames all designs and keeps every MultiPolygon member and hole', () => {
        const hole = box(-0.1199, 51.5001, 0.0001, 0.0001).coordinates[0];
        const site = { type: 'MultiPolygon', coordinates: [[...designs[0].content.site.coordinates, hole], designs[1].content.site.coordinates] };
        const options = previewRenderOptions([{ content: { site } }]);
        expect(options.polygonParts).toEqual(site.coordinates);
        const frame = computeStitchFrame(options);
        expect(frame.lngMin).toBeLessThan(-0.12);
        expect(frame.lngMax).toBeGreaterThan(-0.1155);
    });

    it('produces a 1200 by 630 PNG with both distant designs visible', async () => {
        const tile = createCanvas(256, 256);
        const context = tile.getContext('2d');
        context.fillStyle = '#335577';
        context.fillRect(0, 0, 256, 256);
        const buffer = await renderMapPreview(designs, { render: options => renderProposalThumbnailSet({
            ...options, tileUrl: 'https://tiles.example/{z}/{x}/{y}.png',
            tileSource: { getTileBytes: async () => tile.toBuffer('image/png') }
        }) });
        const image = await loadImage(buffer);
        expect([image.width, image.height]).toEqual([1200, 630]);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, 1200, 602).data;
        const highlighted = [false, false];
        for (let y = 0; y < 602; y++) for (let x = 0; x < 1200; x++) {
            const i = (y * 1200 + x) * 4;
            if (pixels[i] > pixels[i + 2] + 30 && pixels[i] > pixels[i + 1]) highlighted[x < 600 ? 0 : 1] = true;
        }
        expect(highlighted).toEqual([true, true]);
    });

    it('rejects absent map geometry before contacting tile services', async () => {
        const render = vi.fn();
        await expect(renderMapPreview([{ content: {} }], { render })).rejects.toMatchObject({ status: 422 });
        expect(render).not.toHaveBeenCalled();
    });

    it.each([{ loaded: 0, total: 4 }, { loaded: 3, total: 4 }])('refuses incomplete basemaps rather than caching grey tiles: %j', async tiles => {
        await expect(renderMapPreview(designs, { render: async () => ({ tiles }) })).rejects.toMatchObject({ status: 503 });
    });
});
