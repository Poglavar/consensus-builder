// Author a plan's roads together using the map editor's junction transaction, before binding land
// or hashing agreement outputs. Published inputs stay immutable; connected roads are new designs.
import { corridorRuntime as runtime } from './mcp-geometry.js';
import { cidOfObject, designObject } from './agreement-objects.js';

export function authorPlanRoads(designs, authoredAt) {
    const roads = designs.filter(row => row.content.roadProposal);
    if (!roads.length) return { designs, changes: [] };
    const planned = runtime.authoring.planCorridorComposition(roads.map((row, index) => ({
        proposalId: `plan-road-${index}`, applied: true, roadProposal: row.content.roadProposal
    })), { geometry: runtime.geometry });
    const replacements = new Map(), changes = [];
    roads.forEach((row, index) => {
        const definition = planned[index].roadProposal.definition;
        // Avoid rematerializing unchanged roads or inventing a revision on a repeated draft.
        const previous = runtime.osm.toView(row.content.roadProposal.definition);
        const canonical = value => cidOfObject(runtime.osm.toRecord(value));
        if (canonical(definition) === canonical(previous)) return;
        const material = runtime.footprint.materialize(definition);
        definition.polygon = material.polygon;
        definition.constructionFrame = material.constructionFrame;
        const revised = designObject({ ...row.content, createdAt: authoredAt, origin: { cid: row.cid },
            site: material.polygon, roadProposal: { ...row.content.roadProposal, definition: runtime.osm.toRecord(definition) } });
        replacements.set(row.cid, revised);
        changes.push({ type: 'road-junctions', beforeCid: row.cid, afterCid: revised.cid, title: revised.content.title });
    });
    return { designs: designs.map(row => replacements.get(row.cid) || row), changes };
}
