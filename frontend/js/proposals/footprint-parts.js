// Which geometry a proposal's footprint is made of — the one definition shared by the browser
// (plan-order.footprintOf, the publish gate), the API (undeclared-parcel check) and the
// legacy-declaration migration. Pure and dependency-free: it only SELECTS and validates the authored
// GeoJSON parts; each caller unions them with its own engine (turf in the browser, PostGIS on the
// server), so the rule for "what counts as this proposal's ground" cannot drift between them.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__footprintParts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // A footprint this large is not a proposal but an attack on the parcel query (or a bug).
    const MAX_FOOTPRINT_VERTICES = 100000;

    const isPosition = value => Array.isArray(value) && value.length >= 2
        && Number.isFinite(value[0]) && Number.isFinite(value[1]);

    // Returns the vertex count of a valid Polygon/MultiPolygon, or -1 when the coordinates are not
    // well-formed GeoJSON (rings of >= 4 finite positions).
    function polygonVertexCount(geometry) {
        const ringsOf = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!Array.isArray(ringsOf)) return -1;
        let count = 0;
        for (const rings of ringsOf) {
            if (!Array.isArray(rings) || !rings.length) return -1;
            for (const ring of rings) {
                if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return -1;
                count += ring.length;
            }
        }
        return count;
    }

    function asPolygonGeometry(value) {
        const geometry = value && value.type === 'Feature' ? value.geometry : value;
        return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') ? geometry : null;
    }

    // A stored centreline: `points` (one segment) or `segments`, of {lat,lng} or [lng,lat].
    function centerlineSegments(definition) {
        const raw = (Array.isArray(definition.points) && definition.points.length && definition.points)
            || (Array.isArray(definition.segments) && definition.segments) || [];
        if (!raw.length) return [];
        const toPosition = point => {
            if (!point) return null;
            const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : NaN));
            const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : NaN));
            return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
        };
        const segments = Array.isArray(raw[0]) && !isPosition(raw[0]) ? raw : [raw];
        return segments
            .map(segment => (Array.isArray(segment) ? segment.map(toPosition).filter(Boolean) : []))
            .filter(segment => segment.length >= 2);
    }

    /**
     * The authored parts of a proposal's footprint.
     * @returns {{ polygons: object[], centerline: null|{ definition: object, segments: number[][][],
     *   halfWidthM: number }, sources: string[], approximate: boolean, vertexCount: number,
     *   invalid: string|null }}
     * `centerline` is set only for a road stored without its corridor polygon (older records): the
     * browser rebuilds the exact corridor from the definition, the server buffers the centreline
     * by width/2, which is why such a footprint is `approximate`.
     */
    function footprintParts(proposal) {
        const out = { polygons: [], centerline: null, sources: [], approximate: false, vertexCount: 0, invalid: null };
        if (!proposal || typeof proposal !== 'object') return out;
        const add = (source, value) => {
            if (out.invalid || value === undefined || value === null) return;
            const geometry = asPolygonGeometry(value);
            if (!geometry) return;
            const vertices = polygonVertexCount(geometry);
            if (vertices < 0) {
                out.invalid = `${source} is not a valid Polygon/MultiPolygon`;
                return;
            }
            out.vertexCount += vertices;
            out.polygons.push(geometry);
            if (out.sources.indexOf(source) === -1) out.sources.push(source);
        };

        const plan = proposal.reparcellization;
        if (plan && Array.isArray(plan.polygons)) {
            plan.polygons.forEach(polygon => add('reparcellization.polygons', polygon && polygon.geometry));
        }
        const definition = proposal.roadProposal && proposal.roadProposal.definition;
        if (definition && definition.polygon) {
            add('roadProposal.definition.polygon', definition.polygon);
        } else if (definition && typeof definition === 'object') {
            const segments = centerlineSegments(definition);
            const width = Number(definition.width);
            if (segments.length && Number.isFinite(width) && width > 0) {
                out.centerline = { definition, segments, halfWidthM: width / 2 };
                out.vertexCount += segments.reduce((sum, segment) => sum + segment.length, 0);
                out.approximate = true;
                out.sources.push('roadProposal.definition centreline (width/2 buffer)');
            }
        }
        if (proposal.structureProposal) add('structureProposal.geometry', proposal.structureProposal.geometry);
        // A readjustment's authored polygons are its complete footprint; `proposal.geometry` on a
        // readjustment was an apply-time union of whatever live pool it consumed.
        if (!plan) add('geometry', proposal.geometry);
        add('buildingGeometry', proposal.buildingGeometry);
        if (proposal.geometry && Array.isArray(proposal.geometry.buildings)) {
            proposal.geometry.buildings.forEach(building => add('geometry.buildings', building));
        }
        if (!out.invalid && out.vertexCount > MAX_FOOTPRINT_VERTICES) {
            out.invalid = `footprint has ${out.vertexCount} vertices (limit ${MAX_FOOTPRINT_VERTICES})`;
        }
        return out;
    }

    function hasFootprint(parts) {
        return !!parts && !parts.invalid && (parts.polygons.length > 0 || !!parts.centerline);
    }

    return { MAX_FOOTPRINT_VERTICES, footprintParts, hasFootprint, polygonVertexCount };
});
