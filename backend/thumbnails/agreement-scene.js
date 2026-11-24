// Prepare the two states of the same published plan without applying it to a live map.
import * as turf from '@turf/turf';
import planYield from '../../frontend/js/proposals/plan-yield.js';
import applyRoute from '../../frontend/js/proposals/apply/route.js';
import demolition from '../../frontend/js/proposals/demolition-prefetch.js';
import demolitionDerive from '../../frontend/js/demolition-derive.js';
import buildingGround from '../../frontend/js/building-ground.js';
import { createBuildingProviders } from '../buildings/index.js';
import { readAlatauHeightEstimates } from '../buildings/alatau-gba-heights.js';
import { parcelSourceCatalog, parcelSourceById } from '../parcels/sources.js';
import { cityBuildingSources } from '../scripts/lib/frontend-city-money.mjs';
import { fetchParcelPolygonsByIds, hasParcelContext } from './parcel-geometry.js';

function polygonOf(value) {
    const geometry = value?.type === 'Feature' ? value.geometry : value;
    return ['Polygon', 'MultiPolygon'].includes(geometry?.type) && geometry.coordinates?.length ? geometry : null;
}

function authoredSurfaces(design) {
    const surfaces = [];
    function add(value, kind) {
        const geometry = polygonOf(value);
        if (geometry) surfaces.push({ geometry, kind });
    }
    const surroundings = buildingGround.surfaceOf(design);
    if (surroundings) add(surroundings.polygon, surroundings.treatment);
    if (design.roadProposal) add(design.roadProposal.definition?.polygon, 'road');
    if (design.structureProposal) add(design.structureProposal.geometry, design.structureProposal.kind);
    for (const plot of design.parcelLayout?.plots || []) add(plot.geometry, 'parcel-layout');
    for (const slice of design.reparcellization?.polygons || []) add(slice.geometry, 'parcel-layout');
    return surfaces;
}

// The bound cadastral ground is context on both sides. An unavailable parcel service must
// not turn the building footprint into a purported parcel boundary or hide the proposal.
async function inputGround(pool, subject) {
    const { city, designs, inputParcelIds: ids = [] } = subject;
    if (!ids.length || ids.length > 200) return [];
    if (hasParcelContext(city)) {
        const rings = await fetchParcelPolygonsByIds(pool, city, ids);
        return rings.map(coordinates => ({ type: 'Polygon', coordinates }));
    }
    const sourceId = subject.parcelSourceId || designs.find(d => d.binding?.parcelSource?.sourceId)?.binding.parcelSource.sourceId;
    if (!parcelSourceCatalog.sources.some(s => s.id === sourceId)) return [];
    const { adapter } = parcelSourceById(sourceId);
    const ground = await adapter.queryIds(ids);
    return (ground.features || []).map(polygonOf).filter(Boolean);
}

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

// Before depicts what the configured dataset maps here. A missing or capped response
// cannot supply that view. An empty response describes only the mapped stock.
async function readStock(pool, city, bounds, options) {
    const [west, south, east, north] = bounds;
    const lonMetres = Math.max(1, Math.cos((south + north) * Math.PI / 360) * 111320);
    const pad = Math.max(25, Math.min(120, Math.max((east - west) * lonMetres, (north - south) * 110574) * .5));
    const padX = pad / lonMetres, padY = pad / 110574;
    // Avoid asking a city provider for a metropolitan-scale or antimeridian-spanning image.
    if ((east - west) * lonMetres + 2 * pad > 1200 || (north - south) * 110574 + 2 * pad > 1200) return null;
    const view = turf.bboxPolygon([west - padX, south - padY, east + padX, north + padY]).geometry;
    const providers = options.buildingProvider ? null : createBuildingProviders(pool);
    const sources = options.buildingProvider ? ['fixture'] : cityBuildingSources(city);
    for (const source of sources) {
        try {
            const provider = options.buildingProvider || providers.resolveSource(source);
            const result = await provider.footprintsUnder([{ key: 'view', geometry: view }]);
            const rows = result?.regions?.get('view');
            if (result?.unavailable || result?.truncated || result?.partial || !Array.isArray(rows)) continue;
            const buildings = new Map();
            let estimate;
            if (source === 'osm' && city === 'alatau') {
                try { estimate = readAlatauHeightEstimates(process.env.ALATAU_GBA_HEIGHTS_FILE); }
                catch { /* Optional heights do not affect the observed footprints. */ }
            }
            for (const row of rows) {
                const geometry = polygonOf(row.geometry);
                if (!geometry || row.id == null) throw new Error('Incomplete building footprint');
                const floors = positive(row.floors);
                const key = String(row.id);
                const height = positive(row.height_m) ?? (floors ? floors * 3 : null)
                    ?? estimate?.({ properties: { osm_id: key } })?.heightM ?? null;
                buildings.set(key, { key, geometry, height, floors });
            }
            return [...buildings.values()];
        } catch { /* Try the next configured dataset; a failed read never establishes an empty site. */ }
    }
    return null;
}

export async function buildAgreementScene(pool, subject, options = {}) {
    const designs = subject.designs.map(row => row.content);
    const proposed = designs.flatMap(design => planYield.buildingFeaturesOf(design).map(feature => {
        const { heightM: height, floors } = planYield.measureBuilding(feature, design.buildingProposal);
        return { geometry: polygonOf(feature), height, floors };
    }).filter(b => b.geometry));
    const surfaces = designs.flatMap(authoredSurfaces);
    if (!proposed.length && !surfaces.length) return null;

    let ground = [];
    try {
        ground = options.parcelResolver ? await options.parcelResolver(subject.inputParcelIds || []) : await inputGround(pool, subject);
    } catch { /* Authored geometry still frames the view when cadastral context is unavailable. */ }
    const sites = [...ground, ...designs.map(design => design.site)].map(polygonOf).filter(Boolean);
    const shapes = [...proposed, ...surfaces].map(item => item.geometry).concat(sites);
    const bounds = turf.bbox(turf.featureCollection(shapes.map(g => turf.feature(g))));
    const scene = { sites, surfaces, proposed, bounds, before: [], retained: [], baselineComplete: false };
    const before = await readStock(pool, subject.city, bounds, options);
    if (!before) return scene;

    const takers = designs.flatMap((design, index) => {
        const road = design.roadProposal?.definition;
        const region = road ? polygonOf(road.polygon) : demolition.demolitionRegionOf(design, applyRoute);
        return region ? [{ proposalId: String(index), region, tunnels: road ? demolitionDerive.tunnelRegionsOf(road) : [] }] : [];
    });
    const { records, failures } = demolitionDerive.derive({ buildings: before, takers }, turf);
    if (failures.length) return scene;
    const retained = before.flatMap(block => {
        const cut = records.get(block.key);
        if (!cut) return [block];
        return cut.remainder ? [{ ...block, geometry: cut.remainder }] : [];
    });
    return { ...scene, before, retained, baselineComplete: true };
}

export default buildAgreementScene;
