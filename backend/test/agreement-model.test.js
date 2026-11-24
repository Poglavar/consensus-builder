import { createCanvas, loadImage } from 'canvas';
import { describe, expect, it } from 'vitest';
import { renderAgreementViews } from '../thumbnails/agreement-model.js';
import { box } from './helpers/content-fixtures.js';

const bounds = [77.02, 43.61, 77.0216, 43.6116];
const site = box(...bounds);
const footprint = box(77.0205, 43.6105, 77.0211, 43.6111);
const block = (height, floors, geometry = footprint) => ({ geometry, height, floors });
const scene = { bounds, sites: [site], surfaces: [], before: [], retained: [], proposed: [], baselineComplete: true };

async function pixels(png) {
    const image = await loadImage(png);
    const ctx = createCanvas(image.width, image.height).getContext('2d');
    ctx.drawImage(image, 0, 0);
    return ctx;
}

describe('agreement model images', () => {
    it('shows different authored heights on the same footprint and keeps the camera registered', async () => {
        const low = renderAgreementViews({ ...scene, proposed: [block(3, 1)] });
        const high = renderAgreementViews({ ...scene, proposed: [block(6, 2)] });
        expect(high.before.equals(low.before)).toBe(true);
        expect(high.after.equals(low.after)).toBe(false);
        expect(high.after.equals(high.before)).toBe(false);
        const [before, after, pair] = await Promise.all([high.before, high.after, high.pair].map(pixels));
        expect([pair.canvas.width, pair.canvas.height]).toEqual([1280, 384]);
        for (const [left, half] of [[0, before], [640, after]]) {
            expect(Buffer.from(pair.getImageData(left, 0, 640, 384).data)
                .equals(Buffer.from(half.getImageData(0, 0, 640, 384).data))).toBe(true);
        }
    });

    it('preserves a courtyard opening in the roof and its interior walls', () => {
        const court = box(77.02065, 43.61065, 77.02095, 43.61095);
        const hollow = { type: 'Polygon', coordinates: [...footprint.coordinates, ...court.coordinates] };
        const solid = renderAgreementViews({ ...scene, proposed: [block(6, 2)] });
        const withCourt = renderAgreementViews({ ...scene, proposed: [block(6, 2, hollow)] });
        expect(solid.before.equals(withCourt.before)).toBe(true);
        expect(solid.after.equals(withCourt.after)).toBe(false);
    });

    it('draws retained stock on both sides and only returns After for an unreadable baseline', () => {
        const existing = block(9, 3);
        const kept = renderAgreementViews({ ...scene, before: [existing], retained: [existing] });
        const cleared = renderAgreementViews({ ...scene, before: [existing] });
        expect(kept.after.equals(kept.before)).toBe(true);
        expect(cleared.before.equals(kept.before)).toBe(true);
        expect(cleared.after.equals(kept.after)).toBe(false);
        const solo = renderAgreementViews({ ...scene, baselineComplete: false, proposed: [block(6, 2)] });
        expect(solo.before).toBeNull();
        expect(solo.pair).toBeNull();
        expect(solo.after.length).toBeGreaterThan(0);
    });
});
