import { createRequire } from 'node:module';
import { geometryIssues } from './geometry-quality.js';
import { fingerprint } from '../buildings/floor-models.js';

const require = createRequire(import.meta.url);
const { validateArchitecture } = require('../../frontend/js/building-floor-plans.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Source-pixel traces keep a manual correction inspectable against the retained drawing.
export function buildReviewedPlan(spec) {
    if (spec?.schema !== 'novogradnje.reviewed-plan.v1' || !/^[a-f0-9]{64}$/.test(spec.source?.sha256 || ''))
        throw new Error('A reviewed plan needs its source identity.');
    const { framePx: frame, imagePx: image, metersPerPixel } = spec.source;
    if (!Array.isArray(frame) || frame.length !== 4 || !frame.every(finite)
        || !Array.isArray(image) || image.length !== 2 || !image.every(n => finite(n) && n > 0)
        || frame.some(n => n < 0) || frame[2] <= 0 || frame[3] <= 0
        || frame[0] + frame[2] > image[0] || frame[1] + frame[3] > image[1]
        || !finite(metersPerPixel) || metersPerPixel <= 0) throw new Error('Invalid measured source frame or scale.');
    const point = p => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(finite)) throw new Error('Invalid traced source point.');
        const uv = [(p[0] - frame[0]) / frame[2], (p[1] - frame[1]) / frame[3]];
        if (uv.some(n => n < 0 || n > 1)) throw new Error('Traced geometry is outside the source frame.');
        return uv;
    };
    const rectangle = ({ rectPx: r }) => {
        if (!Array.isArray(r) || r.length !== 4 || !r.every(finite) || r[2] <= r[0] || r[3] <= r[1])
            throw new Error('Invalid traced wall rectangle.');
        return [[[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(point)];
    };
    const architecture = {
        schema: 'consensus-builder.floor-architecture.v1',
        dimensionsM: [frame[2] * metersPerPixel, frame[3] * metersPerPixel],
        wallHeightM: spec.wallHeightM, slabThicknessM: spec.slabThicknessM,
        walls: spec.walls.map(rectangle), slabs: spec.slabs.map(slab => slab.ringsPx.map(ring => ring.map(point))),
        openings: spec.openings.map(o => ({ kind: o.kind, a: point(o.a), b: point(o.b),
            depthM: o.depthPx * metersPerPixel, sillM: o.sillM, heightM: o.heightM,
            ...(o.kind === 'door' ? { hinge: point(o.hinge), openTip: point(o.openTip) } : {}) })),
        stairs: [], landings: [], railings: [],
    };
    const errors = validateArchitecture(architecture);
    if (errors.length) throw new Error(errors.join('; '));
    const problems = geometryIssues(architecture, { rooms: spec.rooms });
    if (problems.length) throw new Error('Invalid reviewed geometry: ' + problems.join('; '));
    if (spec.annotations?.sourceSha256 !== spec.source.sha256 || spec.annotations?.unitId !== spec.unitId
        || !Number.isInteger(spec.annotations?.revision)) throw new Error('Correction annotations belong to a different source.');
    return {
        schema: 'consensus-builder.processed-floor-plan.v1', unitId: spec.unitId, label: spec.unitId, scope: 'unit',
        floor: spec.floor, elevationM: null, elevationBasis: null,
        rooms: spec.rooms.map(room => ({ ...room })), architecture, building: null,
        source: { ...spec.source, page: 1, listingUrl: spec.listingUrl, scaleEstimated: true,
            annotationRevision: spec.annotations.revision, annotatedDraftId: spec.annotations.draftId,
            correctionHash: fingerprint(spec) },
        verticalDimensionsBasis: 'Estimated wall and slab heights; printed opening heights traced from the source.',
        quality: { processor: 'annotation-guided-source-trace-v1', method: 'Source drawing traced using user annotations.',
            geometryValid: true, boundaryValid: true, issues: [...spec.issues] },
    };
}
