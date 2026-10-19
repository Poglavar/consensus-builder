import { describe, expect, it } from 'vitest';
import { buildingThumbnailSvg } from '../floor-plan-archive/building-thumbnail.js';

const footprint = (width, depth = 10) => ({
    type: 'Polygon',
    coordinates: [[[15, 45], [15 + width / 80000, 45], [15 + width / 80000, 45 + depth / 110574], [15, 45 + depth / 110574], [15, 45]]]
});
const model = (width = 16, count = 3) => ({
    envelope: {
        footprint: footprint(width),
        storeys: Array.from({ length: count }, (_, level) => ({ level, elevationM: level * 3, heightM: 3 }))
    }
});

describe('buildingThumbnailSvg', () => {
    it('renders different actual footprint geometry as different thumbnails', () => {
        expect(buildingThumbnailSvg(model(16))).not.toBe(buildingThumbnailSvg(model(24)));
    });

    it('shows storey seams and changes the thumbnail projection when storeys change', () => {
        const two = buildingThumbnailSvg(model(16, 2));
        const four = buildingThumbnailSvg(model(16, 4));
        expect(two).not.toBe(four);
        expect((four.match(/stroke="#8e5c43"/g) || []).length).toBeGreaterThan((two.match(/stroke="#8e5c43"/g) || []).length);
        expect(four).toContain('Broj etaža: 4');
    });

    it('returns null for missing or invalid building envelopes', () => {
        expect(buildingThumbnailSvg(null)).toBeNull();
        expect(buildingThumbnailSvg({})).toBeNull();
        expect(buildingThumbnailSvg({ envelope: { footprint: footprint(10), storeys: [] } })).toBeNull();
        expect(buildingThumbnailSvg({ envelope: { footprint: footprint(10), storeys: [{ elevationM: Infinity, heightM: 3 }] } })).toBeNull();
        expect(buildingThumbnailSvg({ envelope: { footprint: { type: 'Polygon', coordinates: [[[15, 45], [NaN, 45], [15, 45]]] }, storeys: model().envelope.storeys } })).toBeNull();
    });

    it('keeps numeric SVG output finite and does not copy untrusted model text into markup', () => {
        const hostile = model();
        hostile.envelope.storeys[0].label = '</text><script onload="bad()">';
        const svg = buildingThumbnailSvg(hostile);
        expect(svg).toMatch(/^<svg[^>]+width="320"[^>]+height="180"/);
        expect(svg).not.toMatch(/NaN|Infinity|<script|onload=/);
        expect(svg).toContain('<title id="building-thumbnail-title">3D obris zgrade</title>');
        expect([...svg.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)].every(match => Number.isFinite(Number(match[0])))).toBe(true);
    });
});
