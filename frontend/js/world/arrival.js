// Globe arrival: a city or proposal picked on the globe lands in 3D, orbiting the proposal among the
// real city. The decision and the index answer's parsing are pure (unit-tested in backend/test/world-arrival.test.js);
// the rest is thin wiring onto three-mode's existing focused entry (enterThreeMode({ focusProposalIds, fromUrl })).
(function (root) {
    'use strict';

    // Dive into 3D only when there is a proposal to frame and the city has 3D buildings to stand it
    // among; without buildings, 3D is flat parcels and the 2D map reads better. Motion (the orbit)
    // is three-mode's business: it stays still under reduced motion.
    function plan({ proposalId, buildingsSource }) {
        const hasProposal = typeof proposalId === 'string' && proposalId.length > 0;
        // Same rule as map-core.js: no `buildings` block means the default provider; only 'none' opts out.
        const hasBuildings = buildingsSource !== 'none';
        return { dive3D: hasProposal && hasBuildings };
    }

    // GET /designs is newest first; the arrival opens the first one by its CID (?design=<cid>).
    function latestDesignCid(payload) {
        const row = payload && Array.isArray(payload.designs) ? payload.designs[0] : null;
        return row && typeof row.cid === 'string' && row.cid ? row.cid : null;
    }

    const api = { plan, latestDesignCid };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root || !root.document) return;
    const global = root;

    const log = (...args) => console.log(`[${new Date().toISOString()}] [world-arrival]`, ...args);

    // The CID of the city's newest published design, or null when it has none.
    async function fetchLatestDesignCid(cityId) {
        const code = typeof global.normalizeCityCodeForApi === 'function' ? global.normalizeCityCodeForApi(cityId) : cityId;
        const url = `${global.getBackendBase()}/designs?city=${encodeURIComponent(code)}&limit=1`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
        const cid = api.latestDesignCid(await response.json());
        log(`latest design for ${cityId}: ${cid || '(none)'}`);
        return cid;
    }

    function buildingsSource() {
        const config = global.CityConfigManager && global.CityConfigManager.getCurrentCityConfig();
        return config && config.buildings ? config.buildings.source : undefined;
    }

    // Enters 3D framed on the proposal and resolves once the scene is up (threeModeReady), so the
    // globe's cover can stay over the 2D framing and the 3D load. Resolves false when it stays 2D.
    async function enter3D(proposal) {
        const key = global.getProposalKey(proposal);
        const decision = api.plan({ proposalId: key, buildingsSource: buildingsSource() });
        if (!decision.dive3D) { log(`staying in 2D (buildings: ${buildingsSource() || 'unknown'})`); return false; }
        const ready = await global.enterThreeMode({ fromUrl: true, focusProposalIds: [key] });
        if (!ready) { log('3D entry cancelled or unavailable; staying in the current view'); return false; }
        // Entering 3D closes the proposal card, which drops the selection, and a downloaded
        // (unapplied) proposal is drawn in 3D only while selected. Select it again without the 2D
        // card, the same call a 3D click on a proposal makes.
        global.selectAndHighlightProposal(key, null, false, false, true);
        return true;
    }

    root.WorldArrival = Object.assign({}, api, { fetchLatestDesignCid, enter3D });
})(typeof window !== 'undefined' ? window : null);
