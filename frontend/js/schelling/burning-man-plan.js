// Burning Man plans: a city laid out as a clock face around the Man, after Black Rock City, the
// temporary city of the Burning Man festival. Ring streets circle the Man from the Esplanade outward
// (Esplanade, A, B, ...); radial streets are named by the hour (2:00 ... 10:00) and leave the open
// playa between 10:00 and 2:00, so every address is a time and a letter (4:30 & C). Shlomo Angel's
// arterials are part of it as of the meridian plan: 30 m wide and about 1 km apart, fixed.
// The second plan type of the Schelling plan layer (js/schelling/), beside the meridians and
// parallels (parcels/schelling-grid.js), with the contract the layer and the painting tool share:
// cells, blocks, plots, and the streets around chosen cells in the OSM form the corridor import
// reads. Pure: no network, no Leaflet (backend/test/burning-man-plan.test.js).
(function (root, factory) {
    // The grid loads later than this file in index.html, so both are looked up when first used.
    const grid = () => (root && root.SchellingGrid) || require('../parcels/schelling-grid.js');
    const streets = () => (root && root.SchellingStreets) || require('./schelling-streets.js');
    const api = factory(grid, streets);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BurningManPlan = api;
})(typeof window !== 'undefined' ? window : null, function (grid, streets) {
    'use strict';

    const ALGORITHM = 'burning-man';
    const DEG = Math.PI / 180;
    // The city takes the clock from 2:00 to 10:00 through 6:00, with a radial street every half hour.
    const CLOCK = Object.freeze({ fromHour: 2, toHour: 10, stepHours: 0.5 });
    const DEG_PER_HOUR = 30;
    const SPAN_DEG = (CLOCK.toHour - CLOCK.fromHour) * DEG_PER_HOUR;
    const BASE_STEP_DEG = CLOCK.stepHours * DEG_PER_HOUR;
    const BASE_SECTORS = SPAN_DEG / BASE_STEP_DEG;
    // Radial arterials run every so many hours: steps that divide the city's eight hours, so 2:00,
    // 6:00 and 10:00 are always arterials. The one whose spacing at the city's edge is nearest 1 km.
    const ARTERIAL_HOURS = Object.freeze([0.5, 1, 2, 4]);
    // Quarter-hour streets start at the first ring where a block has grown to twice its length at
    // the Esplanade, as in Black Rock City's outer rings; there is no finer level.
    const MAX_LEVEL = 1;
    // Arcs are chords of at most this angle: a ring 2 km out sags 0.3 m between vertices.
    const ARC_STEP_DEG = 2;
    const MAX_RINGS = 12;
    // A block shorter than this along its ring street is no block.
    const MIN_FACE_M = 10;

    // About Black Rock City's numbers: the Esplanade some 2,500 ft from the Man, blocks some 250 ft
    // deep between 40 ft streets, ring streets lettered A to K.
    const DEFAULTS = Object.freeze({ esplanadeM: 760, rings: 11, blockDepthM: 76, streetWidthM: 12, bearingDeg: 0 });

    const mod = (value, n) => ((value % n) + n) % n;
    const round = (value, digits) => Number(Number(value).toFixed(digits));
    const positive = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    // Of two choices, the one whose length is nearer the target by ratio, as the meridian plan
    // chooses its arcsecond step (schelling-grid.js chooseStep).
    const ratioError = (length, target) => Math.abs(Math.log(length / target));

    const ringName = j => (j === 0 ? 'Esplanade' : String.fromCharCode(64 + j));

    // ---- the plan --------------------------------------------------------------------------------

    const unitsPer = (plan, j) => 2 ** (plan.maxLevel - plan.levels[j]);
    const sectorsIn = (plan, j) => BASE_SECTORS * 2 ** plan.levels[j];
    const bearingOfUnit = (plan, u) => plan.bearingDeg + CLOCK.fromHour * DEG_PER_HOUR + u * plan.unitDeg;
    const isArterialRing = (plan, j) => j % plan.arterialRingStep === 0;
    const isArterialRadial = (plan, u) => u % plan.arterialUnits === 0;
    const ringWidthM = (plan, j) => (isArterialRing(plan, j) ? plan.arterialWidthM : plan.streetWidthM);
    const radialWidthM = (plan, u) => (isArterialRadial(plan, u) ? plan.arterialWidthM : plan.streetWidthM);

    function clockName(plan, u) {
        const minutes = Math.round(CLOCK.fromHour * 60 + u * plan.unitDeg * 2);
        return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    }

    // The plan for one Man: where he stands, how far out the Esplanade lies, how many lettered ring
    // streets follow it, the block depth, the local street width and the bearing 12:00 points to.
    // The arterials follow from those: the Esplanade and every ring nearest 1 km further out, the
    // radials on the clock step nearest 1 km apart at the edge. Blocks keep their depth: an arterial
    // ring pushes the rings beyond it out by its extra width.
    function planFor(options = {}) {
        const lat = Number(options.centre?.lat);
        const lng = Number(options.centre?.lng);
        if (!Number.isFinite(lat) || Math.abs(lat) > 85 || !Number.isFinite(lng)) {
            throw new RangeError('A Burning Man plan needs the Man’s position, at a latitude between -85 and 85.');
        }
        const esplanadeM = positive(options.esplanadeM, DEFAULTS.esplanadeM);
        const ringsInput = Math.round(Number(options.rings));
        const rings = Number.isFinite(ringsInput) ? Math.min(MAX_RINGS, Math.max(1, ringsInput)) : DEFAULTS.rings;
        const blockDepthM = positive(options.blockDepthM, DEFAULTS.blockDepthM);
        const streetWidthM = positive(options.streetWidthM, DEFAULTS.streetWidthM);
        const bearingInput = Number(options.bearingDeg);
        const bearingDeg = Number.isFinite(bearingInput) ? mod(bearingInput, 360) : DEFAULTS.bearingDeg;
        const { widthM: arterialWidthM, spacingTargetM } = grid().ARTERIAL;

        // Every ring step a whole number of block depths and local streets.
        const ringPitchM = blockDepthM + streetWidthM;
        const fewer = Math.max(1, Math.floor(spacingTargetM / ringPitchM));
        const arterialRingStep = ratioError(fewer * ringPitchM, spacingTargetM) <= ratioError((fewer + 1) * ringPitchM, spacingTargetM) ? fewer : fewer + 1;
        const ringWidth = j => (j % arterialRingStep === 0 ? arterialWidthM : streetWidthM);
        const radii = [esplanadeM];
        for (let j = 0; j < rings; j += 1) radii.push(radii[j] + ringWidth(j) / 2 + blockDepthM + ringWidth(j + 1) / 2);
        const levels = radii.slice(0, -1).map(r => Math.min(MAX_LEVEL, Math.floor(Math.log2(r / esplanadeM) + 1e-9)));
        const maxLevel = Math.max(...levels);
        const unitDeg = BASE_STEP_DEG / 2 ** maxLevel;
        const outerRadiusM = radii[rings];
        const arterialHours = ARTERIAL_HOURS.reduce((best, hours) => (
            ratioError(outerRadiusM * hours * DEG_PER_HOUR * DEG, spacingTargetM) < ratioError(outerRadiusM * best * DEG_PER_HOUR * DEG, spacingTargetM) ? hours : best));

        const code = `BM-${round(esplanadeM, 2)}-${rings}-${round(blockDepthM, 2)}-${round(streetWidthM, 2)}-${round(bearingDeg, 2)}@${round(lat, 5)},${round(lng, 5)}`;
        const plan = Object.freeze({
            algorithm: ALGORITHM,
            code,
            centre: Object.freeze({ lat, lng }),
            esplanadeM, rings, blockDepthM, streetWidthM, bearingDeg, arterialWidthM,
            radii: Object.freeze(radii),
            // The radial level of each band (the ground between ring j and ring j + 1): 0 = half hours.
            levels: Object.freeze(levels),
            maxLevel,
            // The finest radial step; every radial street and every junction sits on a whole unit.
            unitDeg,
            units: BASE_SECTORS * 2 ** maxLevel,
            outerRadiusM,
            arterialRingStep,
            arterialHours,
            arterialUnits: arterialHours * DEG_PER_HOUR / unitDeg,
            metersPerDegree: Object.freeze({ lat: grid().metersPerDegreeLat(lat), lon: grid().metersPerDegreeLon(lat) })
        });
        const shortest = Math.min(...Array.from({ length: BASE_SECTORS }, (_, i) => faceOf(plan, i, 0)));
        if (!(shortest >= MIN_FACE_M)) {
            throw new RangeError('Streets this wide leave no block by the Esplanade; move the Esplanade out or narrow the streets.');
        }
        return plan;
    }

    // ---- positions ---------------------------------------------------------------------------------
    // A local plane at the Man: x east and y north in metres; bearings clockwise from north.

    const lngLatOf = (plan, x, y) => [plan.centre.lng + x / plan.metersPerDegree.lon, plan.centre.lat + y / plan.metersPerDegree.lat];
    const xyOf = (plan, [lng, lat]) => [(lng - plan.centre.lng) * plan.metersPerDegree.lon, (lat - plan.centre.lat) * plan.metersPerDegree.lat];

    // `along` metres out on the radial of `bearing` and `side` metres to its clockwise side.
    function pointAt(plan, along, bearing, side = 0) {
        const b = bearing * DEG;
        return lngLatOf(plan, along * Math.sin(b) + side * Math.cos(b), along * Math.cos(b) - side * Math.sin(b));
    }

    function arc(plan, radius, fromBearing, toBearing) {
        const steps = Math.max(1, Math.ceil(Math.abs(toBearing - fromBearing) / ARC_STEP_DEG));
        return Array.from({ length: steps + 1 }, (_, k) => pointAt(plan, radius, fromBearing + (toBearing - fromBearing) * k / steps));
    }

    function areaM2(plan, ring) {
        let sum = 0;
        for (let k = 0; k < ring.length - 1; k += 1) {
            const [x0, y0] = xyOf(plan, ring[k]);
            const [x1, y1] = xyOf(plan, ring[k + 1]);
            sum += x0 * y1 - x1 * y0;
        }
        return Math.abs(sum) / 2;
    }

    // Where a point lies: its distance from the Man and its angle past 2:00, clockwise.
    function polarOf(plan, lat, lng) {
        const [x, y] = xyOf(plan, [Number(lng), Number(lat)]);
        return { r: Math.hypot(x, y), angle: mod(Math.atan2(x, y) / DEG - plan.bearingDeg - CLOCK.fromHour * DEG_PER_HOUR, 360) };
    }

    // ---- cells and blocks -----------------------------------------------------------------------
    // Cell (i, j) is the i-th sector, at its band's radial level, of the band between ring j and
    // ring j + 1. Its block is the cell less half of each street around it: arcs along the ring
    // streets and straight edges parallel to the radials.

    function blockRadii(plan, j) {
        return [plan.radii[j] + ringWidthM(plan, j) / 2, plan.radii[j + 1] - ringWidthM(plan, j + 1) / 2];
    }

    // The bearing across a block at a radius: fraction t of the way from its left side to its right.
    function sideBearings(plan, i, j) {
        const k = unitsPer(plan, j);
        const left = bearingOfUnit(plan, i * k);
        const right = bearingOfUnit(plan, (i + 1) * k);
        const leftHalf = radialWidthM(plan, i * k) / 2;
        const rightHalf = radialWidthM(plan, (i + 1) * k) / 2;
        return (radius, t) => {
            const from = left + Math.asin(leftHalf / radius) / DEG;
            const to = right - Math.asin(rightHalf / radius) / DEG;
            return from + t * (to - from);
        };
    }

    // The block's length along its inner ring street.
    function faceOf(plan, i, j) {
        const [inner] = blockRadii(plan, j);
        const at = sideBearings(plan, i, j);
        return inner * (at(inner, 1) - at(inner, 0)) * DEG;
    }

    // Part of a cell between radii a and b and between fractions ta and tb of the block's width.
    function cellPiece(plan, i, j, a, b, ta, tb) {
        const at = sideBearings(plan, i, j);
        const ring = [...arc(plan, a, at(a, ta), at(a, tb)), ...arc(plan, b, at(b, tb), at(b, ta))];
        ring.push(ring[0]);
        return ring;
    }

    function cellFeature(plan, id, ring, properties) {
        return {
            type: 'Feature',
            properties: Object.assign({
                id, parcelId: id, provenance: ALGORITHM, estimated: true,
                schelling: { algorithm: ALGORITHM, code: plan.code },
                area_m2: Math.round(areaM2(plan, ring))
            }, properties),
            geometry: { type: 'Polygon', coordinates: [ring] }
        };
    }

    function blockOf(plan, i, j) {
        const [inner, outer] = blockRadii(plan, j);
        const k = unitsPer(plan, j);
        return cellFeature(plan, `BM:${plan.code}:B:${i}:${j}`, cellPiece(plan, i, j, inner, outer, 0, 1), {
            kind: 'block', ring: ringName(j), from: clockName(plan, i * k), to: clockName(plan, (i + 1) * k)
        });
    }

    function allCells(plan) {
        const cells = [];
        for (let j = 0; j < plan.rings; j += 1) {
            for (let i = 0; i < sectorsIn(plan, j); i += 1) cells.push({ i, j });
        }
        return cells;
    }

    function bboxOf(coordinates) {
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        coordinates.forEach(([lng, lat]) => {
            box[0] = Math.min(box[0], lng); box[1] = Math.min(box[1], lat);
            box[2] = Math.max(box[2], lng); box[3] = Math.max(box[3], lat);
        });
        return box;
    }
    const touches = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    const lineOf = feature => (feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates);
    const inBox = (features, bbox) => (bbox ? features.filter(feature => touches(bboxOf(lineOf(feature)), bbox.map(Number))) : features);

    // Every cell whose block touches the box [west, south, east, north].
    function cellsInBbox(plan, bbox, limit = 20000) {
        const cells = allCells(plan).filter(({ i, j }) => touches(bboxOf(lineOf(blockOf(plan, i, j))), bbox.map(Number)));
        if (cells.length > limit) throw new RangeError(`Refusing to list ${cells.length} cells for one request.`);
        return cells;
    }

    const blocksInBbox = (plan, bbox) => cellsInBbox(plan, bbox).map(({ i, j }) => blockOf(plan, i, j));

    // The cell a point lies in, or null on the open playa, inside the Esplanade or beyond the city.
    function cellAt(plan, lat, lng) {
        const { r, angle } = polarOf(plan, lat, lng);
        if (angle >= SPAN_DEG || r < plan.radii[0] || r >= plan.radii[plan.rings]) return null;
        const j = plan.radii.findIndex((radius, index) => r >= radius && r < plan.radii[index + 1]);
        return { i: Math.floor(angle / (BASE_STEP_DEG / 2 ** plan.levels[j])), j };
    }

    // The cell nearest a point: the point brought into the city first. From the Man himself every
    // direction is as near, and the city's middle, 6:00, is taken.
    function cellNear(plan, lat, lng) {
        const { r, angle } = polarOf(plan, lat, lng);
        const a = r < 1 ? SPAN_DEG / 2
            : angle < SPAN_DEG ? angle : (angle - SPAN_DEG < (360 - SPAN_DEG) / 2 ? SPAN_DEG - 1e-9 : 0);
        const radius = Math.min(plan.radii[plan.rings] - 1e-6, Math.max(plan.radii[0], r));
        const j = plan.radii.findIndex((value, index) => radius >= value && radius < plan.radii[index + 1]);
        return { i: Math.floor(a / (BASE_STEP_DEG / 2 ** plan.levels[j])), j };
    }

    // The clock hour a cell lies in (4:00 to 5:00), every ring of it: the plan's superblock.
    function superblockOf(plan, i, j) {
        const hour = Math.floor(i / (2 * 2 ** plan.levels[j]));
        const cells = [];
        for (let band = 0; band < plan.rings; band += 1) {
            const perHour = 2 * 2 ** plan.levels[band];
            for (let sector = hour * perHour; sector < (hour + 1) * perHour; sector += 1) cells.push({ i: sector, j: band });
        }
        return { hour: [`${CLOCK.fromHour + hour}:00`, `${CLOCK.fromHour + hour + 1}:00`], cells };
    }

    // The cells the painting tool starts from: the clock hour nearest the point.
    function defaultCells(plan, lat, lng) {
        const { i, j } = cellNear(plan, lat, lng);
        return superblockOf(plan, i, j).cells;
    }

    // ---- plots ---------------------------------------------------------------------------------
    // As in the meridian plan: a block is two rows, one facing its inner ring street and one its
    // outer, meeting halfway; each row's frontage is halved `level` times. Id: block id, row (I or O)
    // and the halving path, clockwise: BM:<code>:B:i:j/I/011.

    function plotsOfBlock(plan, i, j, level) {
        const lvl = grid().plotLevelOf(level);
        if (lvl === null) return [];
        const [inner, outer] = blockRadii(plan, j);
        const middle = (inner + outer) / 2;
        const count = 2 ** lvl;
        const plots = [];
        [['I', inner, middle], ['O', middle, outer]].forEach(([row, a, b]) => {
            for (let k = 0; k < count; k += 1) {
                const path = lvl ? k.toString(2).padStart(lvl, '0') : '';
                plots.push(cellFeature(plan, `BM:${plan.code}:B:${i}:${j}/${row}${path ? '/' + path : ''}`,
                    cellPiece(plan, i, j, a, b, k / count, (k + 1) / count), { kind: 'plot', block: `${i}:${j}`, row, path, level: lvl }));
            }
        });
        return plots;
    }

    function plotsInBbox(plan, bbox, level, limit = 4000) {
        if (grid().plotLevelOf(level) === null) return [];
        return inBox(cellsInBbox(plan, bbox, limit).flatMap(({ i, j }) => plotsOfBlock(plan, i, j, level)), bbox);
    }

    // The plots of a block by the Esplanade between two local radials: the smallest common plot.
    function plotSize(plan, level) {
        const lvl = grid().plotLevelOf(level);
        const k = unitsPer(plan, 0);
        const i = Math.max(0, Array.from({ length: BASE_SECTORS }, (_, s) => s)
            .findIndex(s => !isArterialRadial(plan, s * k) && !isArterialRadial(plan, (s + 1) * k)));
        const [inner, outer] = blockRadii(plan, 0);
        const depthM = lvl === null ? outer - inner : (outer - inner) / 2;
        const areaM2Value = lvl === null ? blockOf(plan, i, 0).properties.area_m2 : plotsOfBlock(plan, i, 0, lvl)[0].properties.area_m2;
        return { frontageM: areaM2Value / depthM, depthM, areaM2: areaM2Value };
    }

    // ---- streets ---------------------------------------------------------------------------------
    // A junction is node (i, j): ring j at radial unit i. A ring street runs along ring j between
    // units; a radial street along unit i between rings. Street pieces of one line that follow each
    // other make one street, as in the meridian plan (schelling-streets.js runsOf).

    // The radial street of unit u begins at the first band whose sectors it bounds.
    function radialStart(plan, u) {
        for (let j = 0; j < plan.rings; j += 1) if (u % unitsPer(plan, j) === 0) return j;
        return null;
    }

    function streetsOf(plan, cells) {
        const unique = [...new Map(cells.map(cell => [`${cell.i}:${cell.j}`, cell])).values()];
        if (!unique.length) return [];
        const arcs = new Map();
        const radials = new Map();
        const add = (map, line, from) => {
            if (!map.has(line)) map.set(line, new Set());
            map.get(line).add(from);
        };
        unique.forEach(({ i, j }) => {
            const k = unitsPer(plan, j);
            for (let u = i * k; u < (i + 1) * k; u += 1) { add(arcs, j, u); add(arcs, j + 1, u); }
            add(radials, i * k, j);
            add(radials, (i + 1) * k, j);
        });
        const runsOf = streets().runsOf;
        const list = [];
        runsOf(arcs).forEach(({ line: j, from, to }) => {
            const nodes = [];
            for (let u = from; u <= to; u += 1) nodes.push({ i: u, j });
            list.push({ axis: 'ring', line: j, from, to, roadClass: isArterialRing(plan, j) ? 'arterial' : 'local', name: ringName(j), nodes });
        });
        runsOf(radials).forEach(({ line: u, from, to }) => {
            const nodes = [];
            for (let j = from; j <= to; j += 1) nodes.push({ i: u, j });
            list.push({ axis: 'radial', line: u, from, to, roadClass: isArterialRadial(plan, u) ? 'arterial' : 'local', name: clockName(plan, u), nodes });
        });
        return list;
    }

    function lengthOf(plan, street) {
        return street.axis === 'ring'
            ? plan.radii[street.line] * (street.to - street.from) * plan.unitDeg * DEG
            : plan.radii[street.to] - plan.radii[street.from];
    }

    function summary(plan, cells) {
        const unique = [...new Map(cells.map(cell => [`${cell.i}:${cell.j}`, cell])).values()];
        const list = streetsOf(plan, unique);
        const lengthM = { arterial: 0, local: 0 };
        list.forEach(street => { lengthM[street.roadClass] += lengthOf(plan, street); });
        const blockAreaM2 = unique.reduce((sum, { i, j }) => sum + blockOf(plan, i, j).properties.area_m2, 0);
        return { blocks: unique.length, streets: list.length, roads: streets().networksOf(list).length, lengthM, blockAreaM2 };
    }

    const streetWidthOf = (plan, street) => (street.axis === 'ring' ? ringWidthM(plan, street.line) : radialWidthM(plan, street.line));

    // The land of one street, reaching across the streets at its ends so corners close.
    function streetPolygon(plan, street) {
        const half = streetWidthOf(plan, street) / 2;
        let ring;
        if (street.axis === 'ring') {
            const r = plan.radii[street.line];
            const from = bearingOfUnit(plan, street.from) - Math.asin(radialWidthM(plan, street.from) / 2 / r) / DEG;
            const to = bearingOfUnit(plan, street.to) + Math.asin(radialWidthM(plan, street.to) / 2 / r) / DEG;
            ring = [...arc(plan, Math.max(0, r - half), from, to), ...arc(plan, r + half, to, from)];
        } else {
            const bearing = bearingOfUnit(plan, street.line);
            const a = plan.radii[street.from] - ringWidthM(plan, street.from) / 2;
            const b = plan.radii[street.to] + ringWidthM(plan, street.to) / 2;
            ring = [pointAt(plan, a, bearing, -half), pointAt(plan, b, bearing, -half), pointAt(plan, b, bearing, half), pointAt(plan, a, bearing, half)];
        }
        ring.push(ring[0]);
        return { type: 'Polygon', coordinates: [ring] };
    }

    // The import shape recordsFromImport reads: one OSM form, one road per connected network, every
    // way named as Black Rock City names its streets; arterials take the meridian plan's 30 m
    // cross-section. Ring ways carry their arc as extra vertices.
    function importForm(plan, cells, { laneTags } = {}) {
        if (typeof laneTags !== 'function') throw new TypeError('importForm needs laneTags(profile).');
        const tagsByClass = {
            arterial: { highway: 'primary', ...laneTags(streets().profileFor(plan, 'arterial')) },
            local: { highway: 'residential', ...laneTags(streets().profileFor(plan, 'local')) }
        };
        const elements = [];
        const junctions = new Map();
        const roads = [];
        let nextId = 1;
        const vertex = ([lon, lat]) => {
            elements.push({ type: 'node', id: nextId, lat, lon });
            nextId += 1;
            return nextId - 1;
        };
        const junction = ({ i, j }) => {
            const key = `${i}:${j}`;
            if (!junctions.has(key)) junctions.set(key, vertex(pointAt(plan, plan.radii[j], bearingOfUnit(plan, i))));
            return junctions.get(key);
        };
        const wayNodes = street => {
            if (street.axis === 'radial') return street.nodes.map(junction);
            const ids = [junction(street.nodes[0])];
            const radius = plan.radii[street.line];
            for (let u = street.from; u < street.to; u += 1) {
                const between = arc(plan, radius, bearingOfUnit(plan, u), bearingOfUnit(plan, u + 1)).slice(1, -1);
                between.forEach(point => ids.push(vertex(point)));
                ids.push(junction({ i: u + 1, j: street.line }));
            }
            return ids;
        };
        streets().networksOf(streetsOf(plan, cells)).forEach((group, index) => {
            const wayIds = group.map(street => {
                const nodes = wayNodes(street);
                const id = nextId;
                nextId += 1;
                elements.push({ type: 'way', id, nodes, tags: { ...tagsByClass[street.roadClass], name: street.name } });
                return id;
            });
            roads.push({ id: `burning-man-${index + 1}`, name: null, wayIds });
        });
        return { form: { elements }, roads };
    }

    // ---- the whole city, for drawing -------------------------------------------------------------

    // Centre lines of every ring and radial street, for small scales.
    function centreLines(plan) {
        const line = (coordinates, kind, roadClass, name) => ({ type: 'Feature', properties: { kind, roadClass, name, provenance: ALGORITHM }, geometry: { type: 'LineString', coordinates } });
        const lines = plan.radii.map((radius, j) => line(arc(plan, radius, bearingOfUnit(plan, 0), bearingOfUnit(plan, plan.units)),
            'ring', isArterialRing(plan, j) ? 'arterial' : 'local', ringName(j)));
        for (let u = 0; u <= plan.units; u += 1) {
            const start = radialStart(plan, u);
            if (start === null) continue;
            const bearing = bearingOfUnit(plan, u);
            lines.push(line([pointAt(plan, plan.radii[start], bearing), pointAt(plan, plan.outerRadiusM, bearing)],
                'radial', isArterialRadial(plan, u) ? 'arterial' : 'local', clockName(plan, u)));
        }
        return lines;
    }

    // The street land of the city: each ring whole, each radial between the rings it crosses.
    function streetFeatures(plan, bbox) {
        const street = (geometry, roadClass, name) => ({ type: 'Feature', properties: { kind: 'street', roadClass, name }, geometry });
        const features = plan.radii.map((_, j) => street(streetPolygon(plan, { axis: 'ring', line: j, from: 0, to: plan.units }),
            isArterialRing(plan, j) ? 'arterial' : 'local', ringName(j)));
        for (let j = 0; j < plan.rings; j += 1) {
            const [a, b] = blockRadii(plan, j);
            for (let u = 0; u <= plan.units; u += unitsPer(plan, j)) {
                const bearing = bearingOfUnit(plan, u);
                const half = radialWidthM(plan, u) / 2;
                const ring = [pointAt(plan, a, bearing, -half), pointAt(plan, b, bearing, -half), pointAt(plan, b, bearing, half), pointAt(plan, a, bearing, half)];
                ring.push(ring[0]);
                features.push(street({ type: 'Polygon', coordinates: [ring] }, isArterialRadial(plan, u) ? 'arterial' : 'local', clockName(plan, u)));
            }
        }
        return inBox(features, bbox);
    }

    // The numbers the panel states.
    function describe(plan) {
        const quarter = plan.levels.indexOf(1);
        const faces = allCells(plan).map(({ i, j }) => faceOf(plan, i, j));
        const arterialRadials = [];
        for (let u = 0; u <= plan.units; u += plan.arterialUnits) arterialRadials.push(clockName(plan, u));
        return {
            algorithm: ALGORITHM,
            code: plan.code,
            lat: round(plan.centre.lat, 5),
            lng: round(plan.centre.lng, 5),
            bearingDeg: plan.bearingDeg,
            esplanadeM: plan.esplanadeM,
            lastRing: ringName(plan.rings),
            outerRadiusM: round(plan.outerRadiusM, 0),
            quarterHoursFrom: quarter >= 0 ? ringName(quarter) : null,
            blocks: faces.length,
            blockDepthM: plan.blockDepthM,
            shortestFaceM: round(Math.min(...faces), 0),
            longestFaceM: round(Math.max(...faces), 0),
            arterialWidthM: plan.arterialWidthM,
            arterialRings: plan.radii.map((_, j) => j).filter(j => isArterialRing(plan, j)).map(ringName),
            arterialHours: plan.arterialHours,
            arterialRadials
        };
    }

    return Object.freeze({
        ALGORITHM, CLOCK, DEFAULTS, MAX_RINGS, ARTERIAL_HOURS,
        planFor, ringName, clockName, ringWidthM, radialWidthM,
        cellAt, cellNear, superblockOf, defaultCells, cellsInBbox, blockOf, blocksInBbox,
        plotsOfBlock, plotsInBbox, plotSize,
        streetsOf, summary, streetPolygon, importForm,
        centreLines, streetFeatures, describe
    });
});
