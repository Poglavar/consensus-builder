import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { booleanPointInPolygon, point, polygon } from '@turf/turf';
import { buildReviewedPlan } from '../floor-plans/reviewed-plan.js';
import { geometryIssues, closeRing } from '../floor-plans/geometry-quality.js';

const spec = JSON.parse(readFileSync(new URL('../floor-plans/reviewed/bolnicka-s3.json', import.meta.url), 'utf8'));
const uv = p => [(p[0] - spec.source.framePx[0]) / spec.source.framePx[2], (p[1] - spec.source.framePx[1]) / spec.source.framePx[3]];
const inside = (p, polygons) => polygons.some(rings => booleanPointInPolygon(point(uv(p)), polygon(rings.map(closeRing))));

describe('S3 source correction guided by annotations', () => {
    it('keeps shared circulation outside the apartment and restores the bedroom and bathroom dividers', () => {
        const model = buildReviewedPlan(spec), a = model.architecture;
        expect(inside([200, 200], a.slabs)).toBe(false); // The annotated lift/stair core.
        expect(inside([600, 400], a.slabs)).toBe(true);
        expect(inside([591, 700], a.walls)).toBe(true); // Annotated bedroom divider.
        expect(inside([502, 440], a.walls)).toBe(true); // Bathroom partition on the source drawing.
        expect(inside([450, 537], a.walls)).toBe(true); // Bedroom/living partition away from its doors.
        expect(inside([550, 537.5], a.walls)).toBe(false);
        expect(inside([630, 537.5], a.walls)).toBe(false);
        expect(geometryIssues(a, { rooms: model.rooms })).toEqual([]);
    });
    it('traces the paved terrace and its glazed access without turning the garden into apartment floor', () => {
        const a = buildReviewedPlan(spec).architecture;
        const terrace = spec.annotations.shapes.find(s => s.note === 'balcony or terrace').points[0].map((v, i) => v * spec.source.imagePx[i]);
        expect(inside(terrace, a.slabs)).toBe(true);
        expect(inside([1600, 600], a.slabs)).toBe(false);
        expect(a.openings.filter(o => o.kind === 'glazedDoor')).toHaveLength(1);
        expect(a.openings.filter(o => o.kind === 'door')).toHaveLength(4);
        expect(a.openings.filter(o => o.kind === 'window')).toHaveLength(3);
        expect(a.openings.some(o => Math.abs(o.a[1]) < .001 && Math.abs(o.b[1]) < .001)).toBe(false); // No window through the continuous north wall.
        expect(a.railings).toEqual([]);
    });
    it('keeps the source frame and annotation provenance while preserving the authored input', () => {
        const before = JSON.stringify(spec), model = buildReviewedPlan(spec);
        expect(model.source).toMatchObject({ sha256: spec.annotations.sourceSha256,
            annotatedDraftId: spec.annotations.draftId, annotationRevision: 18, imagePx: [1800, 1150] });
        expect(model.source.correctionHash).toBe(buildReviewedPlan(structuredClone(spec)).source.correctionHash);
        expect(JSON.stringify(spec)).toBe(before);
        const privateWidth = (844 - 353) * model.source.metersPerPixel;
        expect(privateWidth).toBeGreaterThan(6.4);
        expect(privateWidth).toBeLessThan(6.6);
    });
    it('rejects an unrelated annotation source or walls that block a traced doorway', () => {
        const wrong = structuredClone(spec); wrong.annotations.sourceSha256 = 'a'.repeat(64);
        expect(() => buildReviewedPlan(wrong)).toThrow(/different source/);
        const blocked = structuredClone(spec); blocked.walls.push({ rectPx: [513, 532, 585, 543] });
        expect(() => buildReviewedPlan(blocked)).toThrow(/opening overlaps a solid wall/);
        const missing = structuredClone(spec); missing.source.framePx[0] = null;
        expect(() => buildReviewedPlan(missing)).toThrow(/source frame/);
    });
});
