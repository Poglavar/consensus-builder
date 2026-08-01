// Turns a solved lane-topology graph into explicit lane-marking continuation links. The corridor
// marking builder otherwise has to GUESS which divider continues into which, by endpoint distance
// and heading; a solved graph already states it in graph.connections, so here the guess is replaced
// by the answer. Pure data in, pure data out — no DOM, no projection, no Leaflet.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyMarkingLinks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Marking continuity is a mid-road property. At a real junction the paint stops at the portal
    // (see paintableSections), so linking dividers across a degree-3+ node would drag them into the
    // intersection — exactly the artefact the setbacks exist to remove.
    const PASS_THROUGH_DEGREE = 2;

    // Only a lane that CONTINUES carries its dividers into the next section. A merge or a split is a
    // lane count change, and its markings have to taper into a neighbour instead of matching one to
    // one — which is what the unmatched-path branch handling downstream is for.
    const CONTINUING_CONNECTION_TYPE = 'continue';

    // Number(null) is 0, and 0 is a perfectly plausible offset — the centreline. Coercing has to be
    // explicit about what an absent offset is, or a lane with no cross-section position quietly
    // becomes the one lane every interpolated divider is anchored to.
    function finite(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    function sideOf(section, nodeId) {
        if (!section || !nodeId) return null;
        if (section.startNode === nodeId) return 'start';
        if (section.endNode === nodeId) return 'end';
        return null;
    }

    function indexById(items) {
        const index = new Map();
        (items || []).forEach(item => {
            if (item && item.id != null) index.set(item.id, item);
        });
        return index;
    }

    // Section geometry is undirected, and so are the marking paths built from it, so a link is keyed
    // by the section pair rather than by traffic direction. `a` is always the lexicographically
    // smaller section id, which keeps the output stable no matter what order connections arrive in.
    function orient(fromLane, toLane) {
        return String(fromLane.sectionId) <= String(toLane.sectionId)
            ? { a: fromLane, b: toLane }
            : { a: toLane, b: fromLane };
    }

    function buildMarkingLinks(graph) {
        const lanes = indexById(graph?.lanes);
        const sections = indexById(graph?.sections);
        const nodes = indexById(graph?.nodes);
        const byKey = new Map();

        (graph?.connections || []).forEach(connection => {
            if (connection?.type !== CONTINUING_CONNECTION_TYPE) return;
            if (Number(nodes.get(connection.nodeId)?.degree) !== PASS_THROUGH_DEGREE) return;

            const fromLane = lanes.get(connection.fromLaneId);
            const toLane = lanes.get(connection.toLaneId);
            if (!fromLane || !toLane) return;
            if (fromLane.sectionId == null || fromLane.sectionId === toLane.sectionId) return;

            const { a, b } = orient(fromLane, toLane);
            const aSection = sections.get(a.sectionId);
            const bSection = sections.get(b.sectionId);
            const aSide = sideOf(aSection, connection.nodeId);
            const bSide = sideOf(bSection, connection.nodeId);
            if (!aSide || !bSide) return;

            // A lane with no offset has no place in the cross-section. Number(undefined) is NaN but
            // Number(null) is 0, which would silently park the lane on the centreline and drag every
            // interpolated divider toward it — an absent offset has to stay absent.
            const aOffset = finite(a.offset);
            const bOffset = finite(b.offset);
            if (aOffset === null || bOffset === null) return;

            const key = `${connection.nodeId}|${a.sectionId}|${b.sectionId}`;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    key,
                    nodeId: connection.nodeId,
                    a: { sectionId: a.sectionId, side: aSide },
                    b: { sectionId: b.sectionId, side: bSide },
                    matches: [],
                    seenA: new Set(),
                    seenB: new Set()
                });
            }
            const link = byKey.get(key);
            // One divider cannot continue into two, so a lane already spoken for keeps its first
            // match. Deterministic order below makes "first" reproducible rather than arrival-order.
            if (link.seenA.has(a.id) || link.seenB.has(b.id)) return;
            link.seenA.add(a.id);
            link.seenB.add(b.id);
            link.matches.push({
                aLaneId: a.id,
                bLaneId: b.id,
                aOffset,
                bOffset,
                connectionId: connection.id
            });
        });

        return [...byKey.values()]
            .filter(link => link.matches.length)
            .map(link => ({
                key: link.key,
                nodeId: link.nodeId,
                a: link.a,
                b: link.b,
                matches: link.matches.sort((left, right) => left.aOffset - right.aOffset)
            }))
            .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    }

    // The cross-section correspondence in one direction, as the offset pairs the marking builder
    // interpolates between: source-frame offset -> neighbour-frame offset.
    function offsetPairs(link, direction) {
        const reverse = direction === 'b->a';
        return (link?.matches || []).map(match => ({
            from: reverse ? match.bOffset : match.aOffset,
            to: reverse ? match.aOffset : match.bOffset
        }));
    }

    return {
        PASS_THROUGH_DEGREE,
        CONTINUING_CONNECTION_TYPE,
        buildMarkingLinks,
        offsetPairs
    };
});
