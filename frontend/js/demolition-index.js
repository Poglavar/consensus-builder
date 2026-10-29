// The applied plan's demolitions in this browser, derived (demolition-derive.js) from the land each
// applied design takes against the buildings the city's sources give for that land, loaded through
// the cell loader like every other building (docs/source-loading-plan.md, F4). Nothing is stored on
// the designs: a commit, a source switch or a stand-in cell derives again, and `demolitionsChanged`
// tells the 2D map, the 3D scene and the other views to redraw.
(function (root) {
    'use strict';

    const EVENT = 'demolitionsChanged';
    const log = (...args) => console.log(`[${new Date().toISOString()}] [demolitions]`, ...args);

    // The land a building or structure design took when it was last applied (its parcels plus its
    // footprints, or its carved body), registered by the apply path. Roads need none: their land is
    // their stored footprint.
    const appliedRegions = new Map();
    let state = { records: new Map(), tunnelled: new Map(), stock: [], stockKeys: new Set(), takerIds: '', incomplete: false, version: 0, signature: null };
    let running = null;
    let dirty = false;

    function registerRegion(proposalId, geometry) {
        if (proposalId == null) return;
        if (geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) appliedRegions.set(String(proposalId), geometry);
        else appliedRegions.delete(String(proposalId));
    }

    const isAppliedSub = (proposal, sub) => (typeof root.isApplied === 'function' ? root.isApplied(proposal, sub) : false);

    function allProposals() {
        const store = root.proposalStorage;
        return store?.peekAllProposals?.() || store?.getAllProposals?.() || [];
    }

    // [{ proposalId, region, tunnels }] for the given designs (every applied one by default).
    function takersOf(proposals, { appliedOnly = true } = {}) {
        const takers = [];
        for (const proposal of proposals || []) {
            const id = proposal?.proposalId ?? proposal?.id;
            if (id == null) continue;
            const road = proposal.roadProposal;
            if (road?.definition?.polygon && (!appliedOnly || isAppliedSub(proposal, road))) {
                let tunnels = [];
                try { tunnels = root.DemolitionDerive.tunnelRegionsOf(road.definition); } catch (error) {
                    console.error(`[${new Date().toISOString()}] [demolitions] the tunnels of road ${id} could not be built; its buildings read as taken`, error);
                }
                takers.push({ proposalId: String(id), region: road.definition.polygon, tunnels });
                continue;
            }
            const sub = proposal.structureProposal || proposal.buildingProposal;
            const region = appliedRegions.get(String(id));
            if (sub && region && (!appliedOnly || isAppliedSub(proposal, sub))) takers.push({ proposalId: String(id), region, tunnels: [] });
        }
        return takers;
    }

    function signatureOf(takers, sourceKey) {
        // Region identity by a cheap digest of its coordinates: same land, same answer.
        const digest = value => {
            const text = JSON.stringify(value);
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
            return `${text.length}.${hash}`;
        };
        return JSON.stringify([sourceKey, takers.map(taker => [taker.proposalId, digest(taker.region), digest(taker.tunnels)]).sort()]);
    }

    // The buildings under some land (takers' regions): every cell any region's box touches, each from
    // the city's sources at that place, a stand-in's duplicates of an earlier source's buildings
    // dropped. → { buildings: [{ key, geometry, rank, item, source }], failed }
    async function loadStock(takers) {
        const cellsApi = root.BuildingCells;
        const loader = root.BuildingCellLoader;
        const manager = root.CityConfigManager;
        if (!takers.length || !cellsApi || !loader || !manager) return { buildings: [], failed: 0 };
        const gridSize = Number(manager.getParcelGridSize?.());
        const toLatLng = (easting, northing) => manager.datasetToLatLng(easting, northing);
        const byKey = new Map();
        const cellsBySources = new Map();
        for (const taker of takers) {
            const box = root.DemolitionDerive.bboxOf(taker.region);
            if (!box) continue;
            const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
            const sources = root.SourceList.inUse(manager.getBuildingSources(centre[1], centre[0]));
            if (!sources.length) continue;
            const group = cellsBySources.get(sources.join('>')) || { sources, cells: new Map() };
            cellsApi.cellsCovering({ box, centre, gridSize, toDataset: root.wgs84ToDataset, toLatLng })
                .forEach(cell => group.cells.set(cell.key, cell));
            cellsBySources.set(sources.join('>'), group);
        }
        let failed = 0;
        const standIn = [];
        for (const { sources, cells } of cellsBySources.values()) {
            const summary = await loader.load({ kind: 'footprints', sources, cells: [...cells.values()], onCell: (_cell, result) => {
                if (result.failed) return;
                const rank = sources.indexOf(result.source);
                for (const item of result.items) {
                    if (!item?.geometry || item.id == null) continue;
                    const building = { key: `${result.source}:${item.id}`, geometry: item.geometry, rank, item, source: result.source };
                    byKey.set(building.key, building);
                    if (rank > 0) standIn.push(building);
                }
            } });
            failed += summary.failed;
        }
        if (standIn.length && root.turf) {
            const earlier = [...byKey.values()].filter(building => building.rank === 0);
            root.BuildingCells.coveredKeys(standIn, earlier, root.turf).forEach(key => byKey.delete(key));
        }
        return { buildings: [...byKey.values()], failed };
    }

    async function derivePass() {
        const takers = takersOf(allProposals());
        const sourceKey = root.CityConfigManager?.getBuildingSourceKey?.() || '';
        const signature = signatureOf(takers, sourceKey);
        if (signature === state.signature && !state.incomplete) return false;
        const stock = await loadStock(takers);
        const derived = root.DemolitionDerive.derive({ takers, buildings: stock.buildings }, root.turf);
        derived.failures.forEach(({ key, error }) => {
            console.error(`[${new Date().toISOString()}] [demolitions] building ${key} could not be measured against the plan; it is drawn untouched`, error);
        });
        state = { records: derived.records, tunnelled: derived.tunnelled, stock: stock.buildings,
            stockKeys: new Set(stock.buildings.map(building => building.key)), takerIds: idsOf(takers),
            incomplete: stock.failed > 0, version: state.version + 1, signature };
        log(`${derived.records.size} demolished or cut, ${derived.tunnelled.size} passed under, by ${takers.length} designs over ${stock.buildings.length} buildings${stock.failed ? `; ${stock.failed} areas did not load` : ''}`);
        return true;
    }

    // Derive again (coalesced: a call while a pass runs schedules one more after it).
    function refresh() {
        if (running) { dirty = true; return running; }
        running = (async () => {
            let changed = false;
            try {
                do {
                    dirty = false;
                    changed = (await derivePass()) || changed;
                } while (dirty);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [demolitions] deriving the plan's demolitions failed`, error);
            } finally {
                running = null;
            }
            if (changed) root.dispatchEvent?.(new root.CustomEvent(EVENT, { detail: { version: state.version } }));
            return state.version;
        })();
        return running;
    }

    // Every record, optionally as if one design were not applied (a design being edited scans the
    // buildings as they stand without its own demolitions).
    function records({ excludeProposalId = null } = {}) {
        if (excludeProposalId == null) return [...state.records.values()];
        const excluded = String(excludeProposalId);
        const touched = [...state.records.values()].filter(record => record.proposalIds?.includes(excluded));
        if (!touched.length) return [...state.records.values()];
        const takers = takersOf(allProposals()).filter(taker => taker.proposalId !== excluded);
        const again = root.DemolitionDerive.derive({ takers, buildings: touched.map(record => ({ key: record.id, geometry: record.geometry })) }, root.turf).records;
        return [...state.records.values()].filter(record => !record.proposalIds?.includes(excluded)).concat([...again.values()]);
    }

    const idsOf = takers => takers.map(taker => taker.proposalId).sort().join('|');

    // The carve of a set of applied designs (every applied one by default; the build-out timeline
    // shows fewer): { records: Map<key, record>, carveOf(key, footprint) }. `carveOf` answers like
    // corridor-carve.js carveBuildingByObjectId — null untouched, { remainder: null, demolished } razed,
    // { remainder, demolished } cut — and measures a building the stock does not hold (a 3D mesh
    // with no footprint of its own) by `footprint()`, its outline as drawn.
    function carveRecords(proposals = null) {
        const takers = takersOf(proposals || allProposals());
        const records = idsOf(takers) === state.takerIds ? state.records
            : (takers.length ? root.DemolitionDerive.derive({ takers, buildings: state.stock }, root.turf).records : new Map());
        const late = new Map();
        const carveOf = (key, footprint) => {
            let record = records.get(String(key)) || null;
            if (!record && !state.stockKeys.has(String(key)) && takers.length && typeof footprint === 'function') {
                if (!late.has(key)) {
                    const geometry = footprint();
                    late.set(key, geometry ? root.DemolitionDerive.derive({ takers, buildings: [{ key, geometry }] }, root.turf).records.get(key) || null : null);
                }
                record = late.get(key);
            }
            if (!record) return null;
            return record.remainder ? { remainder: record.remainder, demolished: record.demolishedPart || null }
                : { remainder: null, demolished: record.geometry || null };
        };
        return { records, carveOf };
    }

    // The existing buildings under some land as pool features (properties.id and .source), for a
    // review of a design that is not applied yet. Throws when an area did not load: an incomplete
    // stock must never read as empty ground.
    async function stockUnder(geometries) {
        const takers = (geometries || []).filter(Boolean).map((region, index) => ({ proposalId: `stock:${index}`, region }));
        const stock = await loadStock(takers);
        if (stock.failed) throw new Error('The building data for this land is incomplete.');
        return stock.buildings.map(({ item, source }) => {
            const { geometry, ...properties } = item;
            return { type: 'Feature', properties: { ...properties, source }, geometry };
        });
    }

    const recordFor = key => state.records.get(String(key)) || null;
    const tunnelledKeys = () => new Set(state.tunnelled.keys());
    const status = () => ({ version: state.version, incomplete: state.incomplete, pending: !!running });

    for (const event of ['parcelFabricCommitted', 'appliedCorridorsChanged']) root.addEventListener?.(event, () => { refresh(); });
    root.addEventListener?.('sourceListChanged', () => { state = { ...state, signature: null }; refresh(); });

    root.DemolitionIndex = { EVENT, registerRegion, refresh, records, carveRecords, recordFor, tunnelledKeys, status, takersOf, stockUnder };
})(typeof window !== 'undefined' ? window : globalThis);
