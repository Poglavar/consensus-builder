// The browser's side of the restrictions stage: which rule sets the current city uses
// (`planning.ruleSetIds`), their configuration (data/planning-sources.json, served with the page),
// one constraint loader for the session, and the existing buildings of the view to place listed
// buildings on. The publisher is asked directly from the browser (planning.data.gov.uk sends
// CORS *); our server is not on this path. Used by the Permitted layer and the Permitted check.
(function (root) {
    'use strict';
    let configuration = null, loader = null;
    function config() {
        configuration ??= fetch('data/planning-sources.json', { cache: 'no-cache' }).then(response => {
            if (!response.ok) throw new Error(`Planning configuration HTTP ${response.status}`);
            return response.json();
        }).catch(error => { configuration = null; throw error; });
        return configuration;
    }
    function ruleSetIds(city) {
        return root.CityConfigManager?.getCityConfig(city)?.planning?.ruleSetIds || [];
    }
    // The city's rule sets as configured, in the order it names them.
    async function ruleSets(city) {
        const ids = ruleSetIds(city);
        if (!ids.length) return [];
        const settings = await config();
        return ids.map(id => (settings.ruleSets || []).find(ruleSet => ruleSet.id === id)).filter(Boolean);
    }
    // The constraint reads for a box: [{ ruleSet, source, areas, partial }], or null when the city
    // has no rule set. `effects` limits the datasets (the map reads only what cuts the envelope).
    async function load(city, bbox, { effects = null } = {}) {
        const ids = ruleSetIds(city);
        if (!ids.length) return null;
        const settings = await config();
        loader ??= root.PlanningConstraintSources.createLoader({ config: settings, scene: root.PlanningScene, fetch: (url, init) => root.fetch(url, init) });
        return loader.load(ids, bbox, { effects });
    }
    // Which designations one footprint lies in, without their geometry (the publisher tests the
    // intersection). The footprint is set in by 0.25 m so a designation it only touches along an
    // edge does not count, as the check's 0.5 m² overlap rule does for read geometry.
    async function membership(city, footprint, { effects = null } = {}) {
        const ids = ruleSetIds(city);
        if (!ids.length) return null;
        const settings = await config();
        loader ??= root.PlanningConstraintSources.createLoader({ config: settings, scene: root.PlanningScene, fetch: (url, init) => root.fetch(url, init) });
        let inset = null;
        try { inset = root.turf.buffer(footprint, -0.25, { units: 'meters' }); } catch (_) { inset = null; }
        const geometry = ['Polygon', 'MultiPolygon'].includes(inset?.geometry?.type) ? inset.geometry : footprint.geometry;
        return loader.membership(ids, geometry, { effects });
    }
    // Restrictions from the reads, placed on the existing buildings the map holds for `bbox`.
    function resolve(reads, bbox) {
        const turf = root.turf;
        const near = (root.buildingFeaturePool || []).filter(feature => {
            if (!feature?.geometry) return false;
            const box = turf.bbox(feature);
            return box[0] <= bbox[2] && box[2] >= bbox[0] && box[1] <= bbox[3] && box[3] >= bbox[1];
        });
        return root.PlanningRestrictions.restrictionsFor(reads, { buildings: near, geometryOps: turf });
    }
    // The submission target of the city's jurisdiction (planning/application-preview.js), or null.
    async function submissionTarget(city) {
        const ids = ruleSetIds(city);
        return ids.length ? root.PlanningApplicationPreview.targetFor(await config(), ids) : null;
    }
    root.PlanningRestrictionFeed = { load, membership, resolve, ruleSetIds, ruleSets, submissionTarget };
})(window);
