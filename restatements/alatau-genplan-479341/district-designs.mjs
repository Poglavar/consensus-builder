// The designs restating one district of Alatau's general plan (Decree No. 727, 2025; README.md), built
// from the committed data only: data/zones.geojson (the plan's zones in the district) and
// data/district.geojson (the district outline). One parcel layout whose plots are the plan's zones, one
// road placed in the street ground (road-in-parcel), one park per green or parks zone. Parks and the
// road come from the app's own intent builder (frontend/js/intent-design.js, as MCP drafts them); the
// layout's plots are the zone polygons, checked with the app's layout validation. No network.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appTurf as turf, intentDesign } from '../../backend/agents/mcp-geometry.js';
import { cityDrivingSide } from '../../backend/scripts/lib/frontend-city-money.mjs';

const require = createRequire(import.meta.url);
// The road's construction frame is checked with proj4 (frontend/js/metric-frame.js), which node finds
// only from backend/; given here, the scripts run from any directory.
globalThis.proj4 ??= createRequire(new URL('../../backend/package.json', import.meta.url))('proj4');
const LayoutValidation = require('../../frontend/js/parcel-layout-validation.js');
const PlanFile = require('../../frontend/js/plan-file.js');
const USE_NAMES = require('../../frontend/i18n/en.json').planningViews.use;

export const CITY = 'alatau';
export const PLAN_KEY = 'alatau-genplan-479341';
export const PLAN_TITLE = 'Alatau general plan (2025) · district around block 479341';
export const AUTHOR = 'General plan of Alatau, Decree of the Government of the Republic of Kazakhstan No. 727 of 9 September 2025';
// The decree's date. Each design is one millisecond after the one before it, so the app applies them
// in this order (formation order is creation time, then the local id, which an import draws at random):
// the layout, then the road placed in its street ground, then the parks on its plots.
export const DECREE_DATE = '2025-09-09T00:00:00.000Z';
export const PARCEL_SOURCE_ID = 'kz-alatau-pkk';
export const PLAN_FILE = fileURLToPath(new URL(`./${PLAN_KEY}.ugt.json`, import.meta.url));
const SOURCE_NOTE = 'Restated from the functional zones of the Alatau general plan (Decree No. 727 of 9 September 2025)'
    + ' in the state urban-planning cadastre (map.gov4c.kz, layer kz:gpzone).';
// Ground the plan leaves without a zone, inside the district, at least this large (m²), is named in
// the layout's description; smaller differences are the zones' drawing noise.
const MIN_UNZONED_M2 = 1;
const PLOT_ORDER = { 'housing-high': 0, 'housing-mid': 0, public: 1, green: 2, transport: 3 };

const data = name => JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${name}`, import.meta.url)), 'utf8'));
const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const area = geometry => turf.area(feature(geometry));
const round1 = value => Math.round(value * 10) / 10;
const authoredAt = index => new Date(Date.parse(DECREE_DATE) + index).toISOString();
const useName = use => USE_NAMES[use.key] || use.key;
const plotName = plot => `${useName(plot.use)}, zone ${plot.zoneId}${plot.clipped ? ' (district part)' : ''}`;

function polygonParts(geometry) {
    if (!geometry) return [];
    return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
}

// A zone's ground in the district: the whole zone when it lies inside, else its part inside.
function clipToDistrict(geometry, outline) {
    const inside = turf.intersect(feature(geometry), feature(outline));
    if (!inside) return null;
    const parts = polygonParts(inside.geometry).filter(rings => area({ type: 'Polygon', coordinates: rings }) >= MIN_UNZONED_M2);
    if (!parts.length) return null;
    return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
}

/** The district: its outline, every zone's plot in plot order, the pool they tile and the unzoned ground. */
export function districtGround() {
    const zones = data('zones.geojson');
    const district = data('district.geojson');
    const outline = district.geometry;
    const plots = zones.features.map(zone => {
        const whole = area(zone.geometry);
        const geometry = clipToDistrict(zone.geometry, outline);
        if (!geometry) throw new Error(`zone ${zone.id} has no ground in the district`);
        const inside = area(geometry);
        return { zoneId: String(zone.id), use: zone.properties.use, geometry, areaM2: inside, clipped: whole - inside > MIN_UNZONED_M2 };
    }).sort((a, b) => (PLOT_ORDER[a.use.group] ?? 9) - (PLOT_ORDER[b.use.group] ?? 9) || Number(a.zoneId) - Number(b.zoneId));
    // The ground no zone covers is left out of the pool: the plan says nothing of it.
    let covered = null;
    for (const plot of plots) covered = covered ? turf.union(covered, feature(plot.geometry)) : feature(plot.geometry);
    const left = turf.difference(feature(outline), covered);
    const unzoned = polygonParts(left?.geometry).map(rings => ({ type: 'Polygon', coordinates: rings }))
        .filter(polygon => area(polygon) >= MIN_UNZONED_M2);
    if (unzoned.some(polygon => polygon.coordinates.length > 1)) throw new Error('unzoned ground with a hole is not expected');
    if (outline.type !== 'Polygon') throw new Error('the district outline is one polygon');
    const pool = { type: 'Polygon', coordinates: [outline.coordinates[0], ...unzoned.map(polygon => [...polygon.coordinates[0]].reverse())] };
    return { zones, district, outline, plots, pool, unzoned };
}

function layoutDesign(ground) {
    const { plots, pool, unzoned } = ground;
    const parcelLayout = {
        algorithm: 'manual',
        generatedAt: DECREE_DATE,
        pool: structuredClone(pool),
        totalArea: round1(area(pool)),
        plots: plots.map(plot => ({ geometry: structuredClone(plot.geometry), area: round1(plot.areaM2), source: 'geojson' }))
    };
    const checked = LayoutValidation.validate(parcelLayout, { turf });
    if (!checked.valid) throw new Error(`the block layout is not valid: ${checked.errors.map(error => error.message).join('; ')}`);
    const unzonedText = unzoned.length
        ? ` ${unzoned.map(polygon => `${Math.round(area(polygon))} m²`).join(', ')} inside the district carry no zone and stay as they are.`
        : '';
    return {
        key: 'block-layout',
        record: {
            goal: 'parcel-layout',
            title: 'Alatau general plan · block layout around block 479341',
            description: 'The general plan lays the land out anew: every zone is its own lot (land readjustment).'
                + ` Plots in order: ${plots.map((plot, index) => `${index + 1} ${plotName(plot)}`).join('; ')}.${unzonedText} ${SOURCE_NOTE}`,
            author: AUTHOR,
            city: CITY,
            createdAt: authoredAt(0),
            site: structuredClone(pool),
            parcelLayout
        }
    };
}

// A design the app's intent builder makes (frontend/js/intent-design.js), as a local record.
function intentRecord(intent, index) {
    const published = intentDesign.build({ ...intent, author: AUTHOR, city: CITY, authoredAt: authoredAt(index) }, { turf });
    return { ...published, createdAt: published.authoredAt };
}

function roadDesign(plot, index) {
    return {
        key: 'streets',
        record: intentRecord({
            kind: 'road', bounded: true, site: plot.geometry, drivingSide: cityDrivingSide(CITY),
            title: 'Alatau general plan · streets around block 479341',
            description: `The street ground of the plan's road zone ${plot.zoneId} in the district, to the centrelines of its bounding streets;`
                + ` lanes fitted to each street's width with pavements and verges to the block edges. ${SOURCE_NOTE}`
        }, index)
    };
}

function parkDesign(plot, index) {
    return {
        key: `park-${plot.zoneId}`,
        record: intentRecord({
            kind: 'space', spaceKind: 'park', site: plot.geometry,
            title: `Alatau general plan · ${useName(plot.use).toLowerCase()} · zone ${plot.zoneId}`,
            description: `${useName(plot.use)}, zone ${plot.zoneId}${plot.clipped ? ' (its part in the district)' : ''}. ${SOURCE_NOTE}`
        }, index)
    };
}

/** The plan as restatement-publish.mjs takes it: the layout, the road, then one park per green zone. */
export function districtPlan() {
    const ground = districtGround();
    const street = ground.plots.filter(plot => plot.use.group === 'transport');
    if (street.length !== 1) throw new Error(`expected one road zone in the district, found ${street.length}`);
    const green = ground.plots.filter(plot => plot.use.group === 'green');
    return {
        key: PLAN_KEY,
        title: PLAN_TITLE,
        author: AUTHOR,
        city: CITY,
        parcelSourceId: PARCEL_SOURCE_ID,
        groundFile: fileURLToPath(new URL(`./ground/${PLAN_KEY}.json`, import.meta.url)),
        ground,
        designs: [
            layoutDesign(ground),
            roadDesign(street[0], 1),
            ...green.map((plot, offset) => parkDesign(plot, 2 + offset))
        ]
    };
}

/** The plan as a portable plan file (ugt-plan-file/v1), opening in 2D over the district. */
export async function districtPlanFile(plan = districtPlan()) {
    const [west, south, east, north] = turf.bbox(feature(plan.ground.outline));
    const view = { at: `${((south + north) / 2).toFixed(6)},${((west + east) / 2).toFixed(6)},16`, mode: '2d', city: CITY, language: 'en' };
    // Each design binds the Kazakh cadastral map (EGKN PKK) where it reaches registered parcels.
    const source = { sourceId: PARCEL_SOURCE_ID, snapshotId: null };
    return PlanFile.create(plan.designs.map(design => ({ ...design.record, planFileSource: source })), { title: plan.title, view });
}
