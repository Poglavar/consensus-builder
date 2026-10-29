// Explain valid formation cuts without changing authored designs or rejecting compositions.
import { createRequire } from 'node:module';
import { appTurf as turf } from './mcp-geometry.js';
const require = createRequire(import.meta.url);
const planOrder = require('../../frontend/js/proposals/plan-order.js');
// A road cuts a surface when it reaches into it: the shared clip and ground rule the map's apply uses.
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const grid = require('../../frontend/js/geometry-tolerances.js');

const feature = geometry => turf.feature(geometry);
const asFormation = design => ({ ...design.content, proposalId: design.cid, createdAt: design.content.authoredAt });

function surfacesOf(design) {
    const content = design.content;
    const surfaces = (content.geometry?.buildings || []).map((building, index) => ({
        ref: `building:${design.cid}:${index}`, surfaceKind: 'building', geometry: building.geometry
    }));
    const groundSurface = content.geometry?.groundSurface?.polygon;
    if (groundSurface) surfaces.push({ ref: `design:${design.cid}`, surfaceKind: 'ground-surface', geometry: groundSurface });
    const structure = content.structureProposal?.geometry;
    if (structure) surfaces.push({ ref: `design:${design.cid}`, surfaceKind: 'structure', geometry: structure });
    return surfaces.filter(surface => surface.geometry && /Polygon/.test(surface.geometry.type || ''));
}

export function describeRoadCuts(designs) {
    const formations = new Map(designs.map(design => [design.cid, asFormation(design)]));
    const roads = designs.filter(design => design.content.roadProposal?.definition?.polygon)
        .sort((a, b) => planOrder.compareFormationOrder(formations.get(a.cid), formations.get(b.cid)));
    const effects = [];
    for (const design of designs) {
        const surfaces = surfacesOf(design);
        if (!surfaces.length) continue;
        for (const surface of surfaces) {
            const authored = feature(surface.geometry);
            const authoredAreaM2 = turf.area(authored);
            let effective = authored;
            const hits = [];
            for (const road of roads) {
                const groundSurface = surface.surfaceKind === 'ground-surface';
                if (!groundSurface && planOrder.compareFormationOrder(formations.get(design.cid), formations.get(road.cid)) >= 0) continue;
                const roadFeature = feature(road.content.roadProposal.definition.polygon);
                const overlap = arrangement.clipWith(turf, 'intersect', authored, roadFeature, { site: 'mcp-ground-effects.roadCut', takeId: road.cid });
                if (!grid.isGround(turf, overlap)) continue;
                const overlapM2 = turf.area(overlap);
                effective = effective ? turf.difference(effective, roadFeature) : null;
                hits.push({ road, overlapM2 });
            }
            const remainingAreaM2AfterAllRoadCuts = effective ? Math.round(turf.area(effective) * 100) / 100 : 0;
            for (const { road, overlapM2 } of hits) effects.push({
                designRef: surface.ref,
                designCid: design.cid,
                designTitle: design.content.title,
                surfaceKind: surface.surfaceKind,
                roadRef: `design:${road.cid}`,
                roadCid: road.cid,
                roadTitle: road.content.title,
                overlapM2: Math.round(overlapM2 * 100) / 100,
                authoredAreaM2: Math.round(authoredAreaM2 * 100) / 100,
                remainingAreaM2AfterAllRoadCuts,
                behavior: 'effective-ground-carved; authored-geometry-unchanged'
            });
        }
    }
    return effects;
}

export function roadCutWarning(effects) {
    return effects.length
        ? 'Road corridors clip effective ground surfaces and agreement outputs in map views; authored design geometry remains unchanged.'
        : null;
}
