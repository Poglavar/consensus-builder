// Pure reconstruction of the UPU Borovje ground mesh.
//
// The raster extraction is useful for locating the plan, but its traced road edge must not become
// dozens of 1–90 m² cadastral parcels. The actual plan extent is the union of parcelation.geojson,
// not the union of every whole cadastral parcel touched by that drawing. Inside that extent roads
// take their official IS cells plus their regular-width corridors; fragments below 150 m² join the
// road or a neighbouring real plot. The remaining ground is returned as one readjustment per
// connected component.

export const MIN_PLOT_AREA_M2 = 150;
export const WEST_ROAD_NAME = 'kolno-pjesacka-zapad';
export const ROAD_PROFILES = Object.freeze({
    SP: { strips: [
        { type: 'verge', width: 2.75 },
        { type: 'sidewalk', width: 2 },
        { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'cycleway', width: 2.5 },
        { type: 'sidewalk', width: 2 },
        { type: 'verge', width: 2.75 }
    ] },
    'IS-1': { strips: [
        { type: 'sidewalk', width: 5 },
        { type: 'driving', width: 4, direction: 'forward' },
        { type: 'driving', width: 4, direction: 'backward' },
        { type: 'sidewalk', width: 5 }
    ] },
    'IS-2': { strips: [{ type: 'sidewalk', width: 9 }] }
});

const clone = value => JSON.parse(JSON.stringify(value));
const feature = geometry => geometry?.type === 'Feature'
    ? geometry
    : { type: 'Feature', properties: {}, geometry };

export function geometryOf(value) {
    return value?.type === 'Feature' ? value.geometry : value;
}

export function explodePolygons(value) {
    const geometry = geometryOf(value);
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry];
    if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }));
    }
    return [];
}

function safeIntersection(turf, left, right) {
    try { return turf.intersect(feature(left), feature(right)); } catch (_) { return null; }
}

function safeDifference(turf, left, right) {
    try { return turf.difference(feature(left), feature(right)); } catch (_) { return null; }
}

export function unionAll(turf, values) {
    let union = null;
    for (const value of values || []) {
        if (!geometryOf(value)) continue;
        union = union ? turf.union(feature(union), feature(value)) : feature(value);
    }
    return union;
}

const areaOf = (turf, value) => value ? turf.area(feature(value)) : 0;

export function roadDefinitionFor(streets, polygon) {
    const features = (streets || []).map(item => item?.type === 'Feature' ? item : feature(item));
    const segments = features.map(item => item.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
    const segmentIds = features.map(item => `upu-${item.properties?.name}`);
    const segmentProfiles = {};
    features.forEach((item, index) => {
        segmentProfiles[segmentIds[index]] = clone(ROAD_PROFILES[item.properties?.kind] || {
            strips: [{ type: 'driving', width: Number(item.properties?.width_m) || 10 }]
        });
    });
    return {
        kind: 'road',
        width: Math.max(...features.map(item => Number(item.properties?.width_m) || 0), 1),
        points: clone(segments),
        segments: clone(segments),
        segmentIds,
        segmentProfiles,
        polygon: clone(geometryOf(polygon)),
        tunnels: [],
        demolishedBuildings: []
    };
}

function nearestRoad(turf, piece, mainRoad, westRoad) {
    const probe = turf.buffer(feature(piece), 0.5, { units: 'meters', steps: 2 });
    const main = areaOf(turf, safeIntersection(turf, probe, mainRoad));
    const west = areaOf(turf, safeIntersection(turf, probe, westRoad));
    return main >= west ? 'main' : 'west';
}

function roadFootprints(turf, parcelation, streets, pool) {
    const buffered = streets.features.map(street => ({
        street,
        geometry: turf.buffer(
            street,
            Number(street.properties?.width_m || 10) / 2,
            { units: 'meters', steps: 2 }
        )
    }));
    const westEntries = buffered.filter(entry => entry.street.properties?.name === WEST_ROAD_NAME);
    const mainEntries = buffered.filter(entry => entry.street.properties?.name !== WEST_ROAD_NAME);
    if (westEntries.length !== 1 || !mainEntries.length) {
        throw new Error('Borovje street groups are incomplete');
    }

    const mainBase = unionAll(turf, mainEntries.map(entry => entry.geometry));
    const westBase = westEntries[0].geometry;
    const mainCells = [];
    const westCells = [];
    parcelation.features.filter(item => item.properties?.kind === 'IS').forEach(cell => {
        const mainHit = areaOf(turf, safeIntersection(turf, cell, mainBase));
        const westHit = areaOf(turf, safeIntersection(turf, cell, westBase));
        (mainHit >= westHit ? mainCells : westCells).push(cell);
    });

    let westRoad = safeIntersection(turf, unionAll(turf, [westBase, ...westCells]), pool);
    let mainRoad = safeIntersection(turf, unionAll(turf, [mainBase, ...mainCells]), pool);
    mainRoad = safeDifference(turf, mainRoad, westRoad) || mainRoad;
    if (explodePolygons(mainRoad).length !== 1 || explodePolygons(westRoad).length !== 1) {
        throw new Error('Each Borovje road proposal must be one connected polygon');
    }
    return {
        main: { geometry: geometryOf(mainRoad), streets: mainEntries.map(entry => clone(entry.street)) },
        west: { geometry: geometryOf(westRoad), streets: westEntries.map(entry => clone(entry.street)) }
    };
}

export function buildBorovjeTopology(parcelationInput, streetsInput, turf, options = {}) {
    if (!turf) throw new Error('Turf is required');
    const minPlotAreaM2 = Number(options.minPlotAreaM2) || MIN_PLOT_AREA_M2;
    const parcelation = clone(parcelationInput);
    const streets = clone(streetsInput);
    const pool = unionAll(turf, parcelation.features);
    if (!pool) throw new Error('The UPU parcelation has no polygonal extent');

    const roads = roadFootprints(turf, parcelation, streets, pool);
    let roadUnion = unionAll(turf, [roads.main.geometry, roads.west.geometry]);

    // A component too small to be a parcel is street-edge debris. Give it to the road it touches,
    // so the road reaches the plan boundary and the readjustment never acquires a grey wedge there.
    const firstFree = explodePolygons(safeDifference(turf, pool, roadUnion));
    for (const piece of firstFree.filter(item => areaOf(turf, item) < minPlotAreaM2)) {
        const target = nearestRoad(turf, piece, roads.main.geometry, roads.west.geometry);
        roads[target].geometry = geometryOf(unionAll(turf, [roads[target].geometry, piece]));
    }
    roadUnion = unionAll(turf, [roads.main.geometry, roads.west.geometry]);
    const freeComponents = explodePolygons(safeDifference(turf, pool, roadUnion))
        .filter(item => areaOf(turf, item) >= minPlotAreaM2)
        .sort((a, b) => areaOf(turf, b) - areaOf(turf, a));

    // Intersect the source M1/Z1/R2 cells with the clean connected blocks. A road can shave a tiny
    // corner from a source cell; that corner is not promoted to a new parcel.
    const rawPlots = [];
    for (const source of parcelation.features.filter(item => item.properties?.kind !== 'IS')) {
        for (const component of freeComponents) {
            for (const geometry of explodePolygons(safeIntersection(turf, source, component))) {
                rawPlots.push({
                    properties: clone(source.properties || {}),
                    geometry,
                    areaM2: areaOf(turf, geometry)
                });
            }
        }
    }
    const plots = rawPlots.filter(plot => plot.areaM2 >= minPlotAreaM2);
    const scraps = rawPlots.filter(plot => plot.areaM2 < minPlotAreaM2);
    for (const scrap of scraps) {
        const probe = turf.buffer(feature(scrap.geometry), 0.5, { units: 'meters', steps: 2 });
        let best = -1;
        let bestScore = 0;
        plots.forEach((plot, index) => {
            const score = areaOf(turf, safeIntersection(turf, probe, plot.geometry));
            if (score > bestScore) { best = index; bestScore = score; }
        });
        if (best >= 0) {
            const merged = unionAll(turf, [plots[best].geometry, scrap.geometry]);
            if (explodePolygons(merged).length === 1) {
                plots[best].geometry = geometryOf(merged);
                plots[best].areaM2 = areaOf(turf, merged);
                continue;
            }
        }
        const target = nearestRoad(turf, scrap.geometry, roads.main.geometry, roads.west.geometry);
        roads[target].geometry = geometryOf(unionAll(turf, [roads[target].geometry, scrap.geometry]));
    }

    roadUnion = unionAll(turf, [roads.main.geometry, roads.west.geometry]);
    const plotUnion = unionAll(turf, plots.map(plot => plot.geometry));
    const readjustmentGeometries = explodePolygons(plotUnion)
        .sort((a, b) => areaOf(turf, b) - areaOf(turf, a));
    const readjustments = readjustmentGeometries.map((geometry, index) => ({
        index,
        geometry,
        areaM2: areaOf(turf, geometry),
        plots: plots.filter(plot => areaOf(turf, safeIntersection(turf, plot.geometry, geometry)) > 1)
    }));

    const mesh = unionAll(turf, [roadUnion, plotUnion]);
    const gapM2 = areaOf(turf, safeDifference(turf, pool, mesh));
    const outsideM2 = areaOf(turf, safeDifference(turf, mesh, pool));
    const overlapM2 = areaOf(turf, safeIntersection(turf, roadUnion, plotUnion));
    const brokenPlots = plots.filter(plot => explodePolygons(plot.geometry).length !== 1 || plot.areaM2 < minPlotAreaM2);
    if (gapM2 > 0.5 || outsideM2 > 0.5 || overlapM2 > 0.5 || brokenPlots.length) {
        throw new Error(`Invalid Borovje mesh: gap ${gapM2.toFixed(2)}, outside ${outsideM2.toFixed(2)}, overlap ${overlapM2.toFixed(2)}, broken plots ${brokenPlots.length}`);
    }
    if (readjustments.some(entry => entry.plots.length === 0)) {
        throw new Error('A Borovje readjustment component has no replacement parcels');
    }

    return {
        pool: geometryOf(pool),
        roads,
        plots,
        readjustments,
        stats: {
            poolM2: areaOf(turf, pool),
            roadsM2: areaOf(turf, roadUnion),
            plotsM2: areaOf(turf, plotUnion),
            gapM2,
            outsideM2,
            overlapM2,
            readjustmentCount: readjustments.length,
            plotCount: plots.length,
            minPlotM2: Math.min(...plots.map(plot => plot.areaM2))
        }
    };
}
