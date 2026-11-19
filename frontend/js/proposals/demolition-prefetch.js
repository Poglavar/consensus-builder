// proposals/demolition-prefetch.js — the land a design clears: a building design's site or land take
// and its footprints, a structure's body. The apply path registers it with demolition-index.js, which derives
// the existing buildings it razes or cuts; plan stats, Compare and MCP compare read the same regions.
// UMD so node tests and the server run the same code the browser runs.
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

    /** The authored building features of a member (geometry.buildings, else the sub-record's). */
    function buildingFeaturesOf(proposal) {
        if (!proposal) return [];
        if (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length) return proposal.geometry.buildings;
        return (proposal.buildingProposal && Array.isArray(proposal.buildingProposal.buildings)) ? proposal.buildingProposal.buildings : [];
    }

    // The canonical goal key (apply/route.js normalizeGoalKey, loaded after this file in the browser,
    // so read when called): 'single' is a Freeform building, 'buildings' a block or rule design.
    function goalKeyOf(proposal, helpers) {
        if (helpers && typeof helpers.normalizeGoalKey === 'function') return helpers.normalizeGoalKey(proposal.goal);
        const route = global.__applyRoute || (typeof require === 'function' ? require('./apply/route.js') : null);
        if (!route) throw new Error('apply/route.js (normalizeGoalKey) is not loaded');
        return route.normalizeGoalKey(proposal && proposal.goal);
    }

    /**
     * The ground a building design clears besides its footprints: its own land, never the rest of
     * the parcels it stands on, so a design in one corner of a large parcel leaves the rest of that
     * parcel standing, and two designs on one parcel do not clear each other. A design clears the
     * ground it takes (user decision 2026-10-22: a block rule's land loses its courtyard buildings
     * too):
     *   - a rule that models the EXISTING buildings (blockify mode 'existing' raises them) clears
     *     only what it redraws, so the ones it skipped stay standing: no land;
     *   - a Freeform building ('single') forms its own parcel from its exact reviewed land take
     *     (apply/buildings.js shouldFormOwnBuildingParcel), its footprints when it has none;
     *   - every other building design (block, row, rule, parcel-based) takes its site, the ground
     *     its binding is computed on (site-binding.js siteOf): the authored site, or the selected land
     *     the editor made its site (proposals/create.js); a design with no site stands on its
     *     footprints alone, as its binding does.
     * Returns { land } (a geometry, or null for the footprints alone).
     */
    function buildingLandOf(proposal, helpers = {}) {
        const sub = (proposal && proposal.buildingProposal) || {};
        if (sub.parameters && sub.parameters.mode === 'existing') return { land: null };
        if (goalKeyOf(proposal, helpers) === 'single') {
            const take = proposal.geometry && proposal.geometry.landTake;
            return { land: take ? (take.type === 'Feature' ? take.geometry : take) : null };
        }
        const site = proposal.site && proposal.site.type === 'Feature' ? proposal.site.geometry : proposal.site;
        return { land: site && (site.type === 'Polygon' || site.type === 'MultiPolygon') ? site : null };
    }

    /**
     * The demolition region of a building design: its land (buildingLandOf) plus its authored
     * footprints, as one Polygon or MultiPolygon the scan intersects buildings with. A Freeform
     * land take already holds its footprints and is the region as it is. Null when there is
     * nothing to scan.
     */
    function buildingDemolitionGeometry(proposal, helpers = {}) {
        if (!proposal) return null;
        const { land } = buildingLandOf(proposal, helpers);
        if (land && goalKeyOf(proposal, helpers) === 'single') return land;
        const polygons = polygonsOf(land ? [land] : []).concat(polygonsOf(buildingFeaturesOf(proposal)));
        if (!polygons.length) return null;
        return polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons };
    }

    /**
     * The region a member's demolition scan will ask about, or null for members that do not scan
     * on replay (roads keep their stored records).
     *
     * It MUST match what the apply path computes later from the same record — a prefetched region
     * smaller than the scanned one would hand the scan a list missing exactly the edge buildings.
     * Buildings: the ground the design takes (buildingDemolitionGeometry), read from the record
     * alone, as the apply path reads it.
     * Structures: the structure geometry, via the caller-supplied resolver (canonical fallback
     * lives on ProposalManager and is not reimplemented here).
     */
    function demolitionRegionOf(proposal, helpers = {}) {
        if (!proposal) return null;
        if (proposal.buildingProposal) return buildingDemolitionGeometry(proposal, helpers);
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

    const api = { demolitionRegionOf, collectDemolitionRegions, buildingLandOf, buildingDemolitionGeometry };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts loaded alongside this file.
    if (typeof window !== 'undefined') window.__demolitionPrefetch = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
