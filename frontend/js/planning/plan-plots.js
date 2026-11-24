(function (root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanPlots = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const corridor = piece => {
        const props = piece?.properties;
        return Boolean(props?.isCorridor || props?.isRoad || props?.isTrack);
    };
    function bbox(piece) {
        if (piece?.geometry?.type !== 'Polygon') return null;
        const ring = piece.geometry.coordinates[0];
        if (!ring?.length) return null;
        return ring.reduce(([w, s, e, n], [x, y]) =>
            [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [Infinity, Infinity, -Infinity, -Infinity]);
    }
    function expand([w, s, e, n], metres = 45) {
        const dy = metres / 111320, dx = dy / Math.max(0.000001, Math.cos((s + n) / 2 * Math.PI / 180));
        return [w - dx, s - dy, e + dx, n + dy];
    }
    const intersects = (a, b) => a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    function isPlanPiece(piece) {
        const p = piece?.properties;
        return Boolean(p && (p.producedByProposalId || p.formedByProposalIds?.length || p.cutByProposalIds?.length || p.readjustmentPiece || p.isCorridor));
    }
    function forBox(fabric, box) {
        if (!fabric || !Array.isArray(box)) return [];
        const reach = expand(box), selected = new Map(), parents = new Set(), multipart = new Set();
        const include = piece => selected.set(piece.properties.parcelId, piece);
        for (const piece of fabric.peekBounds(reach, { includeCorridors: true })) {
            if (!isPlanPiece(piece)) {
                if (piece.properties.cadastralPart) for (const id of piece.properties.cadastreParcelIds) multipart.add(id);
                continue;
            }
            include(piece);
            for (const id of piece.properties.cadastreParcelIds || []) parents.add(id);
        }
        for (const id of multipart) if (!parents.has(id) && fabric.entriesForCadastre([id], { includeCorridors: true }).some(isPlanPiece)) parents.add(id);
        if (parents.size) for (const sibling of fabric.entriesForCadastre([...parents], { includeCorridors: true })) {
            if (intersects(bbox(sibling), reach)) include(sibling);
        }
        return [...selected.values()];
    }
    const ownerKind = name => (root.__reparcellizationUiState || (typeof require === 'function' && require('../reparcellization-ui-state.js')))?.genericOwnerKind?.(name);
    function isPublic(piece) {
        const p = piece.properties;
        if (corridor(piece) || (root.PresentState?.PUBLIC_STRUCTURES || (typeof require === 'function' && require('../proposals/present-state.js').PUBLIC_STRUCTURES))?.has?.(p.structureType)) return true;
        const owners = p.ownershipDetails?.owners;
        return Boolean(owners?.length && owners.every(owner => owner.ownerKey === 'public-land' || ownerKind(owner.ownerLabel || owner.name) === 'public'));
    }
    function cessionM2(fabric, piece, options = {}) {
        const p = piece.properties;
        const cut = p.cutByProposalIds?.length && !p.readjustmentPiece;
        const key = cut ? 'cut:' + JSON.stringify(p.cadastreParcelIds) : p.producedByProposalId;
        if (options.cessions?.has(key)) return options.cessions.get(key);
        const geometry = options.geometry || root.turf;
        const design = !cut && key && (options.getDesign || (id => root.proposalStorage?.getProposal(id)))(key);
        const site = design?.parcelLayout && design.site && geometry?.feature(design.site);
        // A subsequent street or square may have its own producer. Its part inside this
        // layout still contributes public ground, including when there is no cadastre.
        const ground = site ? fabric.peekBounds(geometry.bbox(site), { includeCorridors: true })
            : cut ? fabric.entriesForCadastre(p.cadastreParcelIds, { includeCorridors: true }) : key ? fabric.producedBy(key) : [piece];
        const area = options.area || geometry?.area;
        const amount = ground.reduce((sum, item) => {
            if (!isPublic(item) || !area) return sum;
            const covered = site ? geometry.intersect(site, item) : item;
            return sum + (covered ? area(covered) : 0);
        }, 0);
        if (key) options.cessions?.set(key, amount);
        return amount;
    }
    function toPlot(fabric, piece, options = {}) {
        const p = piece.properties, producer = p.producedByProposalId || (p.cutByProposalIds?.length === 1 ? p.cutByProposalIds[0] : null);
        const getDesign = options.getDesign || (id => root.proposalStorage?.getProposal(id));
        let ref;
        for (const id of new Set([producer, ...(p.formedByProposalIds || []), ...(p.cutByProposalIds || [])].filter(Boolean))) {
            ref = getDesign(id)?.sourceReferences?.find(item => item.providerId && item.recordId);
            if (ref) break;
        }
        return {
            id: p.parcelId, geometry: piece.geometry,
            kind: p.isCorridor ? (p.isTrack ? 'track' : 'road') : p.readjustmentPiece?.role ||
                (p.cutByProposalIds?.length ? 'remainder' : p.cadastralPart ? 'part' : 'formed'),
            cadastreParcelIds: p.cadastreParcelIds || [],
            ...(p.parcelNumber ? { label: String(p.parcelNumber).slice(0, 120) } : {}),
            ...(producer ? { producedByProposalId: producer } : {}),
            cessionM2: cessionM2(fabric, piece, options),
            ...(ref ? { planningArea: { source: ref.providerId, recordId: ref.recordId } } : {})
        };
    }
    function serialize(fabric, box, options = {}) {
        const context = { ...options, cessions: new Map() };
        return forBox(fabric, box).map(piece => toPlot(fabric, piece, context));
    }
    return { serialize, isPlanPiece, forBox, cessionM2, toPlot, bbox, expand, intersects };
});
