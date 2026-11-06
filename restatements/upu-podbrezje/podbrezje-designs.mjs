// The UPU Podbrežje restatement's designs (README.md), built from the committed data only (data/*.geojson
// from extract-data.mjs, EPSG:3765, and data/sheet-3d.json, the masses measured on sheet 3.d). Two plans
// share them: the whole plan on an empty site, and the part of it that is still to be built (without the
// four built slabs A3–A6 and the two buildings under construction, A11 and kindergarten C1). Each
// building is one freeform design; the streets are two road designs (the built north and east streets,
// the unbuilt south street); the park and the two protective greens are park designs. No network, no
// database.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const turf = require('@turf/turf');
const proj4 = require('proj4');
const { corridorProfileFromOsmTags, corridorProfileWidth } = require(fileURLToPath(new URL('../../frontend/js/corridor-profile.js', import.meta.url)));

proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

export const CITY = 'zagreb';
export const PLAN_KEYS = Object.freeze({ full: 'upu-podbrezje', remainder: 'upu-podbrezje-preostalo' });
export const AUTHOR = 'UPU Podbrežje (Log-urbis d.o.o. za Grad Zagreb; SGGZ 8/07, izmjene 12/11)';
// The plan's own date: the City Assembly adopted the amendments on 12 July 2011 (SGGZ 12/11).
export const PLAN_DATE = '2011-07-12T00:00:00.000Z';
const SOURCE = 'UPU Podbrežje (SGGZ 8/07, izmjene i dopune SGGZ 12/11): odredbe za provođenje i kartografski prikaz'
    + ' 3.d Osnova krajobraznog uređenja naselja (sažetak za javnost, 2011.); kazete prema sloju planirane namjene'
    + ' površina Grada Zagreba.';
// Built and under construction: not part of the plan for the remainder.
export const NOT_IN_REMAINDER = Object.freeze(['A3', 'A4', 'A5', 'A6', 'A11', 'C1', 'ulice-sjever-istok']);

// The A kazete (odredbe, čl. 26–31 as amended): podrum and 9 storeys (P+8), ground storey at most 4.5 m,
// kig 1.0, kisn at most as tabled, on the tabled kazeta area. Height: 4.5 m + 8 × 3.0 m plus the 1 m
// parapet the four built slabs measure (GDI 29.5–29.7 m).
const SLAB = Object.freeze({ storeys: 9, heightM: 29.5, widthM: 18.7, northInsetM: 0.2, southClearanceM: 3.4 });
const KISN = Object.freeze({ A1: 2.95, A2: 3.0, A3: 2.95, A4: 3.0, A5: 2.95, A6: 3.0, A7: 2.5, A8: 2.7, A9: 2.9, A10: 2.8, A11: 3.15 });
// A1 and A2 are drawn as the twins of the built A3 and A4 (same kazeta size and shape, sheet 3.d draws
// them alike): the twin's footprint moved by the offset between the two kazete.
const TWINS = Object.freeze({ A1: 'A3', A2: 'A4' });
// Kazeta B (čl. 17–18): one free-standing building of podrum and 35 storeys, kig 1.0, above the second
// storey at most 25 % of the plot, kisn 2.0–5.0. The podium takes the mass sheet 3.d draws; the tower
// stands at its north end, by the railway stop, and is as slender as kisn 5.0 requires at 35 storeys.
const TOWER = Object.freeze({ storeys: 35, groundStoreyM: 4.5, storeyM: 3.2, podiumStoreys: 2, podiumHeightM: 9, kisn: 5.0 });
// Public buildings (čl. 19–23): podrum and 2 storeys (school: 3). The footprint is sheet 3.d's mass.
const PUBLIC = Object.freeze({
    C1: { title: 'dječji vrtić C1 (10 skupina)', storeys: 2, heightM: 8 },
    C2: { title: 'dječji vrtić C2 (8 skupina)', storeys: 2, heightM: 8 },
    D: { title: 'osnovna škola D (560 učenika u jednoj smjeni)', storeys: 2, heightM: 9 },
    E: { title: 'kulturno-informativni centar E', storeys: 2, heightM: 8 },
    F1: { title: 'bazenski kompleks F1 (bazen najmanje 33 × 25 m)', storeys: 2, heightM: 10 },
    F2: { title: 'univerzalna športska dvorana F2', storeys: 2, heightM: 10 }
});
// The south street (2011 amendments: a new street along the south edge with about 108 parking spaces):
// pavements both sides, perpendicular parking on the north (park) side, two traffic lanes.
const SOUTH_STREET_PROFILE = Object.freeze({ strips: [
    { type: 'sidewalk', width: 2 },
    { type: 'parking_perpendicular', width: 5 },
    { type: 'driving', width: 3, direction: 'backward' },
    { type: 'driving', width: 3, direction: 'forward' },
    { type: 'sidewalk', width: 2 }
] });
const CENTRELINE_SAMPLES = 48;
// Every design's intrusion allowance (site-binding.js): the plan's land-use lines are a digitized layer,
// stored to 1 cm, and run within a few centimetres of the cadastral lines they follow. Without it a
// park on the plan's line stands on hairline slivers of its neighbours' parcels that no piece covers.
const TOLERANCE_M = 0.05;

const data = name => JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${name}`, import.meta.url)), 'utf8'));
const round = value => Math.round(value * 1e8) / 1e8;
const toWgs = ([x, y]) => proj4('EPSG:3765', 'EPSG:4326', [x, y]).map(round);
const ringToWgs = ring => ring.map(toWgs);
const polygonToWgs = polygon => ({ type: 'Polygon', coordinates: polygon.coordinates.map(ringToWgs) });
const polygonToGrid = polygon => ({ type: 'Polygon', coordinates: polygon.coordinates.map(ring => ring.map(point => proj4('EPSG:4326', 'EPSG:3765', point))) });
const area = geometry => turf.area(turf.feature(geometry));
// Area of an EPSG:3765 (Multi)Polygon in m², on the plane (turf's area and clipping take lon/lat; its
// clipping is planar and serves the grid as well).
function planarArea(geometry) {
    const ringArea = ring => ring.reduce((sum, [x1, y1], i) => {
        const [x2, y2] = ring[(i + 1) % ring.length];
        return sum + x1 * y2 - x2 * y1;
    }, 0) / 2;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.reduce((sum, rings) => sum + Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);
}
const m2 = value => Math.round(value).toLocaleString('hr-HR');
const dec = value => String(value).replace('.', ',');

// ---- the plan grid -------------------------------------------------------------------------------------

// The plan's grid: the minimum-area rectangle of kazeta A4, u along its long side (north), v across
// (east), in metres (EPSG:3765). Every kazeta is laid out on it (all fields share its bearing).
function frameOf(ring) {
    let best = null;
    for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (length < 1) continue;
        const ux = (x2 - x1) / length;
        const uy = (y2 - y1) / length;
        const us = ring.map(([x, y]) => x * ux + y * uy);
        const vs = ring.map(([x, y]) => x * uy - y * ux);
        const box = { ux, uy, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
        box.area = (box.u1 - box.u0) * (box.v1 - box.v0);
        if (!best || box.area < best.area) best = box;
    }
    // Turn the frame so u is the longer side and points north, v points east.
    let { ux, uy } = best;
    if (best.u1 - best.u0 < best.v1 - best.v0) [ux, uy] = [uy, -ux];
    if (uy < 0) [ux, uy] = [-ux, -uy];
    const toLocal = ([x, y]) => [x * ux + y * uy, x * uy - y * ux];
    const toGrid = ([u, v]) => [u * ux + v * uy, u * uy - v * ux];
    return { toLocal, toGrid };
}

// A ring's extent on the grid.
function boxOn(grid, ring) {
    const local = ring.map(grid.toLocal);
    const us = local.map(point => point[0]);
    const vs = local.map(point => point[1]);
    return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
}

// A rectangle on the grid (u from south to north, v from west to east), as an EPSG:3765 polygon.
function rectangle(grid, { u0, u1, v0, v1 }) {
    const ring = [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]].map(grid.toGrid);
    return { type: 'Polygon', coordinates: [ring] };
}

// A building stands on its plot: what of its footprint the plot does not hold is cut off, and more than
// drawing noise (MAX_OFF_PLOT_M2) is refused.
const MAX_OFF_PLOT_M2 = 1;
function onPlot(geometry, plot, label) {
    const inside = turf.intersect(turf.feature(geometry), turf.feature(plot));
    if (!inside || inside.geometry.type !== 'Polygon') throw new Error(`${label}: the building does not stand on its plot in one piece`);
    const lost = planarArea(geometry) - planarArea(inside.geometry);
    if (lost > MAX_OFF_PLOT_M2) throw new Error(`${label}: ${lost.toFixed(1)} m² of the building is off its plot`);
    return inside.geometry;
}

// ---- the plan's members ----------------------------------------------------------------------------------

function kazete() {
    const features = data('kazete.geojson').features;
    const grid = frameOf(features.find(feature => feature.properties.kazeta === 'A4').geometry.coordinates[0]);
    // Each kazeta's building plot: a plot of the parcel layout, or the cadastral parcel that already is it.
    // The layout is in WGS84 as the app keeps it (extract-data.mjs GRID_DEG): `plotsWgs` as published,
    // `plots` the same on the grid for fitting the buildings.
    const layout = data('plots.geojson').features;
    const plotsWgs = new Map(layout.filter(feature => feature.properties.role !== 'pool').map(feature => [feature.properties.kazeta, feature.geometry]));
    const plots = new Map([...plotsWgs].map(([key, geometry]) => [key, polygonToGrid(geometry)]));
    const fields = new Map();
    for (const feature of features) {
        const geometry = feature.geometry;
        fields.set(feature.properties.kazeta, { ...feature.properties, geometry, box: boxOn(grid, geometry.coordinates[0]) });
    }
    return { grid, fields, plots, plotsWgs, layout };
}

// Sheet 3.d on the grid: v = scale · x + offset, least squares over the built slabs' centres across.
function fitSheet(sheet, grid, built) {
    const pairs = sheet.fit.map(kazeta => {
        const [x0, x1] = sheet.masses[kazeta].px;
        const box = boxOn(grid, built.get(kazeta).geometry.coordinates[0]);
        return [(x0 + x1) / 2, (box.v0 + box.v1) / 2];
    });
    const n = pairs.length;
    const sx = pairs.reduce((sum, [x]) => sum + x, 0);
    const sv = pairs.reduce((sum, [, v]) => sum + v, 0);
    const sxx = pairs.reduce((sum, [x]) => sum + x * x, 0);
    const sxv = pairs.reduce((sum, [x, v]) => sum + x * v, 0);
    const scale = (n * sxv - sx * sv) / (n * sxx - sx * sx);
    const offset = (sv - scale * sx) / n;
    const worst = Math.max(...pairs.map(([x, v]) => Math.abs(scale * x + offset - v)));
    if (worst > 1.5) throw new Error(`sheet 3.d does not fit the built slabs (worst ${worst.toFixed(2)} m)`);
    return { ...sheet, scale, offset };
}

// Sheet 3.d's mass of a kazeta as a rectangle on the grid: across where the fitted sheet draws it, along
// by its gap to the kazeta's north edge (the sheet draws at one scale both ways).
function sheetMass(sheet, field, kazeta) {
    const mass = sheet.masses[kazeta];
    if (!mass) throw new Error(`sheet 3.d draws no mass in kazeta ${kazeta}`);
    const [x0, x1, y0, y1] = mass.px;
    const u1 = field.box.u1 - sheet.scale * (y0 - mass.rowPx);
    return { u1, u0: u1 - sheet.scale * (y1 - y0), v0: sheet.scale * x0 + sheet.offset, v1: sheet.scale * x1 + sheet.offset };
}

function slabFootprint({ grid, fields }, field, sheet, kazeta, built) {
    const twin = TWINS[kazeta];
    if (twin) {
        const source = built.get(twin);
        const from = fields.get(twin).box;
        const [du, dv] = [field.box.u1 - from.u1, field.box.v0 - from.v0];
        const ring = source.geometry.coordinates[0].map(point => {
            const [u, v] = grid.toLocal(point);
            return grid.toGrid([u + du, v + dv]);
        });
        // The kazete are equal but not drawn identically: the moved twin keeps to its own kazeta.
        const moved = turf.intersect(turf.feature({ type: 'Polygon', coordinates: [ring] }), turf.feature(field.geometry)).geometry;
        if (moved.type !== 'Polygon') throw new Error(`${kazeta}: the twin of ${twin} falls apart in its kazeta`);
        return { geometry: moved, basis: `oblik izvedene zgrade ${twin} u istovjetnoj kazeti` };
    }
    // Across: centred where sheet 3.d draws the slab. Along: from the kazeta's north edge, as long as the
    // kazeta allows and kisn caps.
    const mass = sheetMass(sheet, field, kazeta);
    const centre = (mass.v0 + mass.v1) / 2;
    const capM = KISN[kazeta] * field.tableAreaM2 / SLAB.storeys / SLAB.widthM;
    const roomM = field.box.u1 - field.box.u0 - SLAB.northInsetM - SLAB.southClearanceM;
    const lengthM = Math.min(capM, roomM);
    const u1 = field.box.u1 - SLAB.northInsetM;
    const geometry = rectangle(grid, { u1, u0: u1 - lengthM, v0: centre - SLAB.widthM / 2, v1: centre + SLAB.widthM / 2 });
    return {
        geometry,
        basis: lengthM < roomM
            ? `položaj prema prikazu 3.d, duljina ${Math.round(lengthM)} m ograničena najvećim kisn ${dec(KISN[kazeta])}`
            : `položaj prema prikazu 3.d, duljina ${Math.round(lengthM)} m do 3,4 m od južnog ruba kazete`
    };
}

function buildingFeature(geometry, { heightM, storeys, block }) {
    return {
        type: 'Feature',
        properties: { type: 'proposedBuildingSingle', height: heightM, levels: storeys, rotation: 0, block },
        geometry: polygonToWgs(geometry)
    };
}

// A building is content on its plot (goal 'buildings', as in UPU Borovje): a freeform 'single' would take
// ground of its own and cut the plot a second time. The rest of the plot is green ground.
function buildingDesign({ key, title, description, createdAt, parts, storeys, heightM, plot }) {
    const blockName = `UPU Podbrežje ${key}`;
    return {
        key: `zgrada-${key.toLowerCase()}`,
        kazeta: key,
        record: {
            goal: 'buildings',
            title: `UPU Podbrežje – ${title}`,
            description: `${description} ${SOURCE}`,
            author: AUTHOR,
            city: CITY,
            createdAt,
            toleranceM: TOLERANCE_M,
            geometry: {
                buildings: parts.map(part => buildingFeature(part.geometry, { ...part, block: blockName })),
                surroundings: { treatment: 'green', polygon: structuredClone(plot) }
            },
            buildingProposal: { typologyType: 'single', blockName, parameters: { typology: 'single', floors: storeys, height: heightM, rotation: 0 } }
        }
    };
}

function residentialDesigns(plan, sheet, built) {
    const { fields, plots, plotsWgs } = plan;
    const permits = new Map(data('permits.geojson').features.map(feature => [feature.properties.kazeta, feature]));
    const keys = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11'];
    return keys.map(key => {
        const field = fields.get(key);
        const limitM2 = KISN[key] * field.tableAreaM2;
        let geometry;
        let basis;
        let heightM = SLAB.heightM;
        let createdAt = PLAN_DATE;
        let state;
        if (built.has(key)) {
            const source = built.get(key);
            geometry = source.geometry;
            heightM = source.properties.gdiHeightM;
            basis = `tlocrt izvedene zgrade (DGU zgrada ${source.properties.dguBuildingNumber}), visina ${dec(heightM)} m prema GDI snimci ${source.properties.gdiSurveyYear}.`;
            state = 'Izvedeno (1. faza).';
        } else if (permits.has(key)) {
            const source = permits.get(key);
            geometry = source.geometry;
            createdAt = `${source.properties.finalOn}T00:00:00.000Z`;
            basis = `tlocrt iz građevinske dozvole ${source.properties.caseId} (eDozvola, ${source.properties.finalOn}).`;
            state = 'U gradnji: 288 stanova i 3 poslovna prostora, završetak predviđen u prvoj polovici 2027.';
        } else {
            const slab = slabFootprint(plan, field, sheet, key, built);
            geometry = slab.geometry;
            basis = `${slab.basis}; širina ${dec(SLAB.widthM)} m kao izvedeni blokovi.`;
            state = 'Neizvedeno.';
        }
        geometry = onPlot(geometry, plots.get(key), key);
        const footprintM2 = area(polygonToWgs(geometry));
        const gbpM2 = footprintM2 * SLAB.storeys;
        if (gbpM2 > limitM2 * 1.005) throw new Error(`${key}: ${Math.round(gbpM2)} m² above ground exceeds kisn ${KISN[key]} × ${field.tableAreaM2} m²`);
        return buildingDesign({
            key,
            title: `stambena zgrada ${key}`,
            description: `Kazeta ${key} (${m2(field.tableAreaM2)} m²), višestambena zgrada podrum i 9 etaža (P+8), prizemlje do 4,5 m,`
                + ` najviše 40 % zatvorenog prizemlja. Tlocrt ${m2(footprintM2)} m², oko ${m2(gbpM2)} m² nadzemne GBP`
                + ` (najviše kisn ${dec(KISN[key])} × kazeta = ${m2(limitM2)} m²). Tlocrt: ${basis} ${state}`,
            createdAt,
            parts: [{ geometry, heightM, storeys: SLAB.storeys }],
            storeys: SLAB.storeys,
            heightM,
            plot: plotsWgs.get(key)
        });
    });
}

function towerDesign({ grid, fields, plots, plotsWgs }, sheet) {
    const field = fields.get('B');
    const mass = sheetMass(sheet, field, 'B');
    const podium = { u0: Math.max(mass.u0, field.box.u0 + 1), u1: Math.min(mass.u1, field.box.u1 - 1), v0: Math.max(mass.v0, field.box.v0 + 1), v1: mass.v1 };
    // The kazeta's east side runs along the railway at an angle: the podium keeps to the kazeta.
    const podiumBase = turf.intersect(turf.feature(rectangle(grid, podium)), turf.feature(plots.get('B'))).geometry;
    if (podiumBase.type !== 'Polygon') throw new Error('B: the podium falls apart in its kazeta');
    const podiumM2 = planarArea(podiumBase);
    const limitM2 = TOWER.kisn * field.tableAreaM2;
    const towerM2 = (limitM2 - TOWER.podiumStoreys * podiumM2) / (TOWER.storeys - TOWER.podiumStoreys);
    if (!(towerM2 > 0) || towerM2 > 0.25 * field.tableAreaM2) throw new Error(`B: a ${Math.round(towerM2)} m² tower floor breaks the 25 % rule`);
    const side = Math.sqrt(towerM2);
    const centre = (podium.v0 + podium.v1) / 2;
    const tower = { u1: podium.u1, u0: podium.u1 - side, v0: centre - side / 2, v1: centre + side / 2 };
    const towerGeometry = onPlot(rectangle(grid, tower), plots.get('B'), 'B tower');
    const podiumGeometry = turf.difference(turf.feature(podiumBase), turf.feature(towerGeometry)).geometry;
    if (podiumGeometry.type !== 'Polygon') throw new Error('B: the podium around the tower is not one polygon');

    const towerHeightM = Math.round((TOWER.groundStoreyM + (TOWER.storeys - 1) * TOWER.storeyM) * 10) / 10;
    return buildingDesign({
        key: 'B',
        title: 'poslovni toranj B',
        description: `Kazeta B (${m2(field.tableAreaM2)} m², mješovita pretežito poslovna namjena M2): samostojeća građevina podrum i 35 etaža,`
            + ` iznad druge etaže najviše 25 % čestice, kisn najviše 5,0 (${m2(limitM2)} m²); obvezan urbanističko-arhitektonski natječaj.`
            + ` Podij od dvije etaže (${m2(podiumM2)} m²) prema masi na prikazu 3.d, toranj ${Math.round(side)} × ${Math.round(side)} m`
            + ` visine ${dec(towerHeightM)} m uz stajalište na sjeveru, vitak koliko kisn 5,0 traži pri 35 etaža. Neizvedeno.`,
        createdAt: PLAN_DATE,
        parts: [
            { geometry: towerGeometry, heightM: towerHeightM, storeys: TOWER.storeys },
            { geometry: podiumGeometry, heightM: TOWER.podiumHeightM, storeys: TOWER.podiumStoreys }
        ],
        storeys: TOWER.storeys,
        heightM: towerHeightM,
        plot: plotsWgs.get('B')
    });
}

function publicDesigns({ grid, fields, plots, plotsWgs }, sheet) {
    const permits = new Map(data('permits.geojson').features.map(feature => [feature.properties.kazeta, feature]));
    return Object.entries(PUBLIC).map(([key, rule]) => {
        const field = fields.get(key);
        let geometry;
        let basis;
        let createdAt = PLAN_DATE;
        let state = 'Neizvedeno.';
        if (permits.has(key)) {
            const source = permits.get(key);
            geometry = source.geometry;
            createdAt = `${source.properties.receivedOn}T00:00:00.000Z`;
            basis = `iz građevinske dozvole ${source.properties.caseId} (eDozvola)`;
            state = 'U gradnji od studenoga 2024. (oko 200 djece).';
        } else {
            const mass = sheetMass(sheet, field, key);
            const clipped = turf.intersect(turf.feature(rectangle(grid, mass)), turf.feature(plots.get(key)));
            geometry = clipped.geometry;
            if (geometry.type !== 'Polygon') throw new Error(`${key}: the sheet's mass leaves its kazeta in pieces`);
            basis = 'prema masi na kartografskom prikazu 3.d';
        }
        geometry = onPlot(geometry, plots.get(key), key);
        const footprintM2 = area(polygonToWgs(geometry));
        return buildingDesign({
            key,
            title: rule.title,
            description: `Kazeta ${key} (${m2(field.tableAreaM2)} m²), javna i društvena / športska namjena. Tlocrt ${m2(footprintM2)} m² ${basis},`
                + ` ${rule.storeys} nadzemne etaže (${rule.heightM} m). ${state}`,
            createdAt,
            parts: [{ geometry, heightM: rule.heightM, storeys: rule.storeys }],
            storeys: rule.storeys,
            heightM: rule.heightM,
            plot: plotsWgs.get(key)
        });
    });
}

const round1 = value => Math.round(value * 10) / 10;

// The plan's parcel layouts: each connected pool of parcels the kazete re-divide (extract-data.mjs plots)
// cut into one plot per kazeta, as in UPU Borovje one layout per block the streets and kept parcels
// separate. The plots' names travel in the description only, in plot order.
function layoutDesigns({ layout }) {
    const pools = layout.filter(feature => feature.properties.role === 'pool');
    const plots = layout.filter(feature => feature.properties.role === 'plot');
    const kept = layout.filter(feature => feature.properties.role === 'parcel').map(feature => `${feature.properties.kazeta} (k.č. ${feature.properties.parcel})`);
    const parcels = pools[0].properties.parcels.length;
    return pools.map((pool, index) => {
        const own = plots.filter(plot => turf.booleanPointInPolygon(turf.pointOnFeature(turf.feature(plot.geometry)), turf.feature(pool.geometry)));
        const site = structuredClone(pool.geometry);
        return {
            key: `parcelacija-${index + 1}`,
            kazeta: `parcelacija-${index + 1}`,
            record: {
                goal: 'parcel-layout',
                title: `UPU Podbrežje – građevne čestice kazeta (${index + 1}/${pools.length})`,
                description: `Parcelacija prema planu: jedna građevna čestica površine kazete. Povezani dio ${index + 1} od ${pools.length}`
                    + ` (${m2(pool.properties.areaM2)} m²) dijeli se na ${own.length} čestica, redom: ${own.map(feature => feature.properties.kazeta).join(', ')}.`
                    + ` Ukupno se nanovo dijeli ${parcels} katastarskih čestica; kazete koje su već jedna katastarska čestica ostaju takve:`
                    + ` ${kept.join(', ')}; čestice izvedenih ulica i ulica izvan kazeta se ne diraju. ${SOURCE}`,
                author: AUTHOR,
                city: CITY,
                createdAt: PLAN_DATE,
                toleranceM: TOLERANCE_M,
                site,
                parcelLayout: {
                    algorithm: 'manual',
                    generatedAt: PLAN_DATE,
                    pool: structuredClone(site),
                    totalArea: round1(area(site)),
                    plots: own.map(feature => {
                        const geometry = structuredClone(feature.geometry);
                        return { geometry, area: round1(area(geometry)), source: 'geojson' };
                    })
                }
            }
        };
    });
}

function parkDesigns({ plotsWgs }) {
    const parks = [
        { key: 'G3', title: 'javni park G3', text: 'Javni park Z1 u središtu naselja: najmanje 70 % prirodnog terena za sadnju stabala, rekreacijska staza; uređuje se prema cjelovitom projektu krajobraznog uređenja, moguće fazno.' },
        { key: 'G1', title: 'zaštitno zelenilo G1', text: 'Zaštitna zelena površina Z uz prugu na sjeverozapadu.' },
        { key: 'G2', title: 'zaštitno zelenilo G2', text: 'Zaštitna zelena površina Z na jugoistoku, uz istočnu ulicu.' }
    ];
    return parks.map(park => {
        // A park is its plot exactly.
        const geometry = structuredClone(plotsWgs.get(park.key));
        return {
            key: `park-${park.key.toLowerCase()}`,
            kazeta: park.key,
            record: {
                goal: 'park',
                title: `UPU Podbrežje – ${park.title}`,
                description: `${park.text} Površina ${m2(area(geometry))} m². Neuređeno. ${SOURCE}`,
                author: AUTHOR,
                city: CITY,
                createdAt: PLAN_DATE,
                toleranceM: TOLERANCE_M,
                geometry,
                structureProposal: { kind: 'park', geometry: structuredClone(geometry), blockName: `UPU Podbrežje ${park.key}` }
            }
        };
    });
}

// ---- streets -----------------------------------------------------------------------------------------------

const toPoints = coordinates => coordinates.map(toWgs).map(([lng, lat]) => ({ lat, lng }));

function roadDesign({ key, title, description, polygon, lines }) {
    const geometry = polygonToWgs(polygon);
    const segments = lines.map(line => toPoints(line.coordinates));
    const segmentProfiles = Object.fromEntries(lines.map(line => [line.id, structuredClone(line.profile)]));
    const definition = {
        kind: 'road',
        width: Math.max(...lines.map(line => corridorProfileWidth(line.profile))),
        points: structuredClone(segments),
        segments,
        segmentIds: lines.map(line => line.id),
        segmentProfiles,
        polygon: geometry,
        tunnels: [],
        demolishedBuildings: []
    };
    return {
        key,
        kazeta: key,
        record: {
            goal: 'road-track',
            title: `UPU Podbrežje – ${title}`,
            description: `${description} ${SOURCE}`,
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            toleranceM: TOLERANCE_M,
            geometry: structuredClone(geometry),
            roadProposal: { definition, isCorridor: true }
        }
    };
}

function chainLength(chain) {
    let total = 0;
    for (let i = 1; i < chain.length; i += 1) total += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]);
    return total;
}

function pointAt(chain, fraction) {
    const target = fraction * chainLength(chain);
    let walked = 0;
    for (let i = 1; i < chain.length; i += 1) {
        const [a, b] = [chain[i - 1], chain[i]];
        const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (walked + step >= target && step > 0) {
            const t = (target - walked) / step;
            return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        }
        walked += step;
    }
    return chain[chain.length - 1];
}

// The axis of a street band: its two long sides, walked between its two end edges (the longest edge at
// each end of the band), averaged at equal fractions of their length.
export function bandCentreline(polygon, samples = CENTRELINE_SAMPLES) {
    const ring = polygon.coordinates[0].slice(0, -1);
    const xs = ring.map(point => point[0]);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const edges = ring.map((point, index) => {
        const next = ring[(index + 1) % ring.length];
        return { index, length: Math.hypot(next[0] - point[0], next[1] - point[1]), midX: (point[0] + next[0]) / 2 };
    });
    const endEdge = test => edges.filter(edge => test(edge.midX)).sort((a, b) => b.length - a.length)[0];
    const east = endEdge(x => x > maxX - 5);
    const west = endEdge(x => x < minX + 5);
    if (!east || !west || east.index === west.index) throw new Error('the street band has no two end edges');
    const walk = (from, to) => {
        const chain = [];
        for (let i = (from + 1) % ring.length; ; i = (i + 1) % ring.length) {
            chain.push(ring[i]);
            if (i === to) break;
        }
        return chain;
    };
    const one = walk(east.index, west.index); // from the east end's far vertex to the west end's near one
    const other = walk(west.index, east.index).reverse();
    return Array.from({ length: samples + 1 }, (_, step) => {
        const a = pointAt(one, step / samples);
        const b = pointAt(other, step / samples);
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }).reverse(); // west to east, so the north (park) side is on the left
}

function streetDesigns() {
    const land = new Map(data('road-land.geojson').features.map(feature => [feature.properties.key, feature.geometry]));
    const built = data('built-streets.geojson').features.map(feature => {
        const profile = corridorProfileFromOsmTags(feature.properties.tags, feature.properties.widthMeters || undefined);
        if (!profile || !(corridorProfileWidth(profile) > 0)) throw new Error(`${feature.properties.id}: no usable profile from its OSM tags`);
        return { id: feature.properties.id, coordinates: feature.geometry.coordinates, profile, lengthM: feature.properties.lengthM };
    });
    const builtLengthM = built.reduce((sum, line) => sum + line.lengthM, 0);
    const south = bandCentreline(land.get('jug'));
    const southLengthM = chainLength(south);
    return [
        roadDesign({
            key: 'ulice-sjever-istok',
            title: 'sjeverna i istočna ulica',
            description: `Sjeverna ulica s parkiralištima uz Aveniju Većeslava Holjevca i istočna ulica (Radmanovačka), na prometnoj`
                + ` površini IS plana sjeverno i istočno od kazeta (${m2(area(polygonToWgs(land.get('sjever-istok'))))} m²).`
                + ` Osi i profili izvedenih ulica prema OpenStreetMapu (${built.length} ${built.length % 10 >= 2 && built.length % 10 <= 4 && (built.length % 100 < 10 || built.length % 100 >= 20) ? 'dionice' : 'dionica'}, ${m2(builtLengthM)} m). Izvedeno.`,
            polygon: land.get('sjever-istok'),
            lines: built
        }),
        roadDesign({
            key: 'ulica-jug',
            title: 'južna ulica',
            description: `Južna ulica uz južni rub naselja (izmjene 2011.: nova prometnica s oko 108 parkirališnih mjesta), na prometnoj`
                + ` površini IS plana južno od kazeta (${m2(area(polygonToWgs(land.get('jug'))))} m²); os ${m2(southLengthM)} m po sredini`
                + ` površine. Profil 15 m: nogostupi 2 m, okomito parkiranje uz park (sjever), dva prometna traka po 3 m.`
                + ' Lokacijska dozvola P20241219-1666482-Z02 (2024.). Neizvedeno.',
            polygon: land.get('jug'),
            lines: [{ id: 'upu-ulica-jug', coordinates: south, profile: structuredClone(SOUTH_STREET_PROFILE) }]
        })
    ];
}

// ---- plans --------------------------------------------------------------------------------------------------

/** Every design of the plan in replay order: streets, parks, then buildings. */
export function podbrezjeDesigns() {
    const plan = kazete();
    const built = new Map(data('built.geojson').features.map(feature => [feature.properties.kazeta, feature]));
    const sheet = fitSheet(data('sheet-3d.json'), plan.grid, built);
    return [
        ...streetDesigns(),
        ...layoutDesigns(plan),
        ...parkDesigns(plan),
        ...residentialDesigns(plan, sheet, built),
        towerDesign(plan, sheet),
        ...publicDesigns(plan, sheet)
    ];
}

const groundFile = key => fileURLToPath(new URL(`./ground/${key}.json`, import.meta.url));

function planOf(key, title, designs, viewSettings) {
    return {
        key,
        title,
        author: AUTHOR,
        city: CITY,
        // The imported Croatian cadastre in the app database, as the app binds a Zagreb design.
        parcelSourceId: 'oss-wfs',
        groundFile: groundFile(key),
        designs: designs.map(({ key: designKey, record }) => ({ key: designKey, record })),
        viewSettings
    };
}

/** The whole plan on an empty site: both streets, the parks and all eighteen buildings. */
export function fullPlan() {
    // Built shown around the plan; on the site only what the plan keeps (its designs replace the rest).
    return planOf(PLAN_KEYS.full, 'UPU Podbrežje', podbrezjeDesigns(), { existing: 'solid', existingScope: 'surviving' });
}

/** What is still to be built: the whole plan without A3–A6, A11, C1 and the built north and east streets. */
export function remainderPlan() {
    return planOf(PLAN_KEYS.remainder, 'UPU Podbrežje – preostali dio plana',
        podbrezjeDesigns().filter(design => !NOT_IN_REMAINDER.includes(design.kazeta)),
        // The remainder completes a built neighbourhood: the built slabs stay in view.
        { existing: 'solid', existingScope: 'all' });
}
