// Join MCP road designs exactly as the map editor joins a drawn or edited road: the shared corridor
// authoring planner (planCorridorAuthoring for a new road, planCorridorEdit for an edit) runs against
// the road and track designs the caller names, which stand in for the editor's applied corridors.
// Published inputs stay immutable: a named neighbour whose junctions change becomes a new design
// revision naming it by origin.cid, and a road whose canonical form is unchanged is not revised.
import { corridorRuntime as runtime } from './mcp-geometry.js';
import { cidOfObject, designObject } from './agreement-objects.js';

const options = { geometry: runtime.geometry };
const view = content => runtime.osm.toView(content.roadProposal.definition);
const canonical = definition => cidOfObject(runtime.osm.toRecord(definition));
const proposal = (id, content) => ({ proposalId: id, applied: true, roadProposal: { ...content.roadProposal, definition: view(content) } });

// The design carrying a planned definition with its rebuilt land, or null when the road is unchanged.
function revised(content, definition, fields) {
    if (canonical(definition) === canonical(view(content))) return null;
    const material = runtime.footprint.materialize(definition);
    definition.polygon = material.polygon;
    definition.constructionFrame = material.constructionFrame;
    return designObject({ ...content, ...fields, site: material.polygon,
        roadProposal: { ...content.roadProposal, definition: runtime.osm.toRecord(definition) } }).content;
}

function neighbours(corridors, excluded = []) {
    const seen = new Set(excluded);
    return corridors.filter(row => !seen.has(row.cid) && seen.add(row.cid));
}

function revisionsOf(named, current) {
    const revisions = named.filter(row => current.get(row.cid) !== row.content)
        .map(row => ({ before: row, design: current.get(row.cid), cid: cidOfObject(current.get(row.cid)), parcelSourceId: row.parcelSourceId }));
    return { revisions, changes: revisions.map(row => ({ type: 'road-junctions', beforeCid: row.before.cid, afterCid: row.cid, title: row.design.title })) };
}

// A named neighbour's revision is authored now, by this change; it keeps its source as origin.
function reviseNeighbour(current, change, authoredAt) {
    const content = current.get(change.proposalId);
    current.set(change.proposalId, revised(content, change.definition, { createdAt: authoredAt, origin: { cid: change.proposalId } }) || content);
}

// New roads (one draft, or every road of one import) are finished one at a time, each against the
// named corridors and the roads finished before it, as the editor applies imported roads in turn.
// corridors: [{ cid, content, parcelSourceId }] resolved road/track designs.
export function joinNewRoads(designs, corridors, authoredAt) {
    const named = neighbours(corridors);
    const current = new Map(named.map(row => [row.cid, row.content]));
    const roads = [...designs];
    roads.forEach((_, index) => {
        const existing = [...named.map(row => proposal(row.cid, current.get(row.cid))), ...roads.slice(0, index).map((content, k) => proposal(`new-${k}`, content))];
        const planned = runtime.authoring.planCorridorAuthoring(proposal(`new-${index}`, roads[index]), existing, options);
        roads[index] = revised(roads[index], planned.proposal.roadProposal.definition, { createdAt: roads[index].authoredAt }) || roads[index];
        for (const change of planned.existingChanges) {
            if (!change.proposalId.startsWith('new-')) { reviseNeighbour(current, change, authoredAt); continue; }
            const k = Number(change.proposalId.slice(4));
            roads[k] = revised(roads[k], change.definition, { createdAt: roads[k].authoredAt }) || roads[k];
        }
    });
    return { designs: roads, ...revisionsOf(named, current) };
}

// An edited road refreshes the junctions at its old and new nodes against exactly the named corridors.
export function joinEditedRoad(before, edited, corridors, authoredAt) {
    const named = neighbours(corridors, [cidOfObject(before), cidOfObject(edited)]);
    const current = new Map(named.map(row => [row.cid, row.content]));
    const planned = runtime.authoring.planCorridorEdit(proposal('edited', before), proposal('edited', edited),
        named.map(row => proposal(row.cid, row.content)), options);
    const design = revised(edited, planned.proposal.roadProposal.definition, { createdAt: edited.authoredAt }) || edited;
    planned.existingChanges.forEach(change => reviseNeighbour(current, change, authoredAt));
    return { design, ...revisionsOf(named, current) };
}
