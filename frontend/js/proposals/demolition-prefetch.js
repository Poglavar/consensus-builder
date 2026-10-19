// proposals/demolition-prefetch.js — one request for a whole replay's demolition ground.
//
// Applying a building or structure proposal scans for the buildings it would demolish, and that
// scan used to fetch footprints from the server once per proposal — a replay of 300 members was
// hundreds of round trips, most of them cold-cache. The regions are known up front (each member's
// authored buildings, or a structure's footprint), so they are collected here and asked as ONE
// POST /buildings/under, whose per-region answers ride into each member's scan as
// `preloadedBuildings`.
//
// The prewarm alternative — fill the whole city's footprint pool once — was measured and rejected:
// a plan-wide fetch returns `truncated: true` at 4,000 buildings, and a scan against a truncated
// pool silently records FEWER demolitions. Per-region there is nothing to truncate.
//
// Pure collection and mapping here; the fetch itself stays in proposal-manager with the other
// replay orchestration. UMD so node tests run the same code the browser runs.
(function (global) {
    'use strict';

    /** Polygon coordinate sets of a features array — Step 4's demolitionRegion construction. */
    function polygonsOf(features) {
        const polygons = [];
        (Array.isArray(features) ? features : []).forEach(raw => {
            const geometry = raw && raw.type === 'Feature' ? raw.geometry : (raw && raw.type ? raw : raw && raw.geometry);
            if (!geometry) return;
            if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) polygons.push(geometry.coordinates);
            else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
                geometry.coordinates.forEach(coords => polygons.push(coords));
            }
        });
        return polygons;
    }

    /**
     * The region a member's demolition scan will ask about, or null for members that do not scan
     * on replay (roads keep their stored records).
     *
     * It MUST match what the apply path computes later from the same record — a prefetched region
     * smaller than the scanned one would hand the scan a list missing exactly the edge buildings.
     * Buildings: the union-as-MultiPolygon of `geometry.buildings` (the same array Step 4 clips).
     * Structures: the structure geometry, via the caller-supplied resolver (canonical fallback
     * lives on ProposalManager and is not reimplemented here).
     */
    function demolitionRegionOf(proposal, helpers = {}) {
        if (!proposal) return null;
        if (proposal.buildingProposal) {
            const features = (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length)
                ? proposal.geometry.buildings
                : proposal.buildingProposal.buildings;
            const polygons = polygonsOf(features);
            if (!polygons.length) return null;
            return polygons.length === 1
                ? { type: 'Polygon', coordinates: polygons[0] }
                : { type: 'MultiPolygon', coordinates: polygons };
        }
        if (proposal.structureProposal) {
            const resolve = typeof helpers.structureGeometry === 'function' ? helpers.structureGeometry : null;
            const geometry = resolve ? resolve(proposal) : (proposal.structureProposal.geometry || null);
            if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
            if (!Array.isArray(geometry.coordinates)) return null;
            return geometry;
        }
        return null;
    }

    /** Every scanning member's region, keyed by the proposalId the apply path will look up. */
    function collectDemolitionRegions(appliedList, helpers = {}) {
        const regions = [];
        const seen = new Set();
        (Array.isArray(appliedList) ? appliedList : []).forEach(proposal => {
            const key = proposal && proposal.proposalId !== undefined && proposal.proposalId !== null
                ? String(proposal.proposalId) : null;
            if (!key || seen.has(key)) return;
            const geometry = demolitionRegionOf(proposal, helpers);
            if (!geometry) return;
            seen.add(key);
            regions.push({ key, geometry });
        });
        return regions;
    }

    /**
     * The bulk response's per-region lists as pool-shaped features — the SAME property shape
     * loadProviderFootprints gives the footprint pool ({id, height_m, floors, source}), because
     * corridor-tunnel's buildingIdentifier keys demolition records on `properties.id` and a
     * different shape here would mint records no other consumer could match.
     */
    function buildingFeaturesFromBulk(regionsPayload, source) {
        const byKey = new Map();
        if (!regionsPayload || typeof regionsPayload !== 'object') return byKey;
        Object.keys(regionsPayload).forEach(key => {
            const entries = Array.isArray(regionsPayload[key]) ? regionsPayload[key] : [];
            byKey.set(String(key), entries
                .filter(entry => entry && entry.geometry)
                .map(entry => ({
                    type: 'Feature',
                    properties: {
                        id: entry.id,
                        height_m: (typeof entry.height_m === 'number' && Number.isFinite(entry.height_m)) ? entry.height_m : null,
                        floors: (typeof entry.floors === 'number' && Number.isFinite(entry.floors)) ? entry.floors : null,
                        source: source || null
                    },
                    geometry: entry.geometry
                })));
        });
        return byKey;
    }

    const api = { demolitionRegionOf, collectDemolitionRegions, buildingFeaturesFromBulk };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts loaded alongside this file.
    if (typeof window !== 'undefined') window.__demolitionPrefetch = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
