// The vLAB restatement's designs (README.md), built from the committed data only: data/model.geojson
// (the author's site model placed on the map by extract-model.mjs), data/site.geojson (the site's
// cadastral parcels) and data/kept-buildings.geojson (the existing buildings the plan keeps). Every
// design is made with the app's own constructors (backend/agents/mcp-geometry.js, the generators the MCP
// drafts with), and each takes only its own ground: later designs are cut by earlier ones. No network,
// no database.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appTurf as turf, corridorRuntime, intentDesign } from '../../backend/agents/mcp-geometry.js';

const require = createRequire(import.meta.url);
const FreeformLandTake = require('../../frontend/js/freeform-land-take.js');

export const CITY = 'zagreb';
export const PLAN_KEY = 'vlab';
export const AUTHOR = 'vLAB – Ivan Gavran Vlahović (2026)';
// The date of the author's published texts (vlab_content_42.json _meta.exportedAt, 19 April 2026).
export const PLAN_DATE = '2026-04-19T00:00:00.000Z';
const SOURCE = 'Izvedeno iz autorova javno objavljenog 3D modela i tekstova (vlab.igv.hr, 2026), smještenog na kartu prema osam orijentira.';
// Ground a design may lose to an earlier one by drawing noise (m²); more is refused.
const MAX_LOST_M2 = 1;
// Pieces of a space smaller than this after cutting are debris, not a square (m²).
const MIN_SPACE_PIECE_M2 = 25;
// Existing buildings the plan keeps are kept clear of new spaces by this margin (m).
const KEPT_MARGIN_M = 0.5;
// The author's ground-floor render (PP.jpg) shows about sixteen trees in the park.
const PARK_TREES = 16;
const FOOTWAY_WIDTH_M = 4;
// The passage reaches this far beyond the museum's walls on each side, onto the square and the plaza (m).
const PASSAGE_APRON_M = 3;

const data = name => JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${name}`, import.meta.url)), 'utf8'));
const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const area = geometry => (geometry ? turf.area(feature(geometry)) : 0);
const round1 = value => Math.round(value * 10) / 10;

function union(geometries) {
    const list = geometries.filter(Boolean);
    if (!list.length) return null;
    return list.slice(1).reduce((merged, geometry) => turf.union(merged, feature(geometry)), feature(list[0])).geometry;
}
function difference(geometry, cut) {
    if (!geometry || !cut) return geometry;
    const rest = turf.difference(feature(geometry), feature(cut));
    return rest ? rest.geometry : null;
}
function parts(geometry, minM2) {
    if (!geometry) return [];
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.map(coordinates => ({ type: 'Polygon', coordinates })).filter(polygon => area(polygon) >= minM2);
}
const asMulti = polygons => (polygons.length === 1 ? polygons[0] : { type: 'MultiPolygon', coordinates: polygons.map(polygon => polygon.coordinates) });

/** The committed model, read into its parts. */
export function vlabModel() {
    const features = data('model.geojson').features;
    const pick = predicate => features.filter(item => predicate(item.properties));
    const one = predicate => {
        const found = pick(predicate);
        if (found.length !== 1) throw new Error(`model.geojson: expected one feature, found ${found.length}`);
        return found[0];
    };
    return {
        vlab: pick(p => p.kind === 'building' && p.key === 'vlab'),
        tower: pick(p => p.kind === 'building' && p.key === 'tower').sort((a, b) => a.properties.heightM - b.properties.heightM),
        park: one(p => p.kind === 'park').geometry,
        plaza: one(p => p.kind === 'plaza').geometry,
        passage: one(p => p.kind === 'line' && p.key === 'passage'),
        link: one(p => p.kind === 'line' && p.key === 'link'),
        site: union(data('site.geojson').features.map(item => item.geometry)),
        sitePlots: data('site.geojson').features.map(item => item.properties),
        kept: data('kept-buildings.geojson').features
    };
}

// ---- constructors --------------------------------------------------------------------------------------

// A design/v1 object back as the local record the publisher takes: authoredAt is the record's createdAt,
// and a road's definition is the view the app decodes from its stored OSM form.
function localRecord(content) {
    const { schema, authoredAt, origin, toleranceM, ...rest } = content;
    const record = { ...rest, createdAt: authoredAt };
    if (record.roadProposal?.definition) {
        record.roadProposal = { ...record.roadProposal, definition: corridorRuntime.osm.toView(record.roadProposal.definition) };
    }
    return record;
}

const authorship = (title, description) => ({ title, description: `${description} ${SOURCE}`, author: AUTHOR, city: CITY, authoredAt: PLAN_DATE });

/**
 * A Freeform building of stepped parts (each its own footprint and height, never stacked), taking only
 * its footprint, as the MCP's Freeform constructor does for one footprint.
 */
// Its parts state one `buildingId`: they are one building, with one hue and one glass tint.
function steppedBuilding({ title, description, blockName, buildingId, facade, parts: steps, model = null }) {
    const footprint = union(steps.map(step => step.geometry));
    const tallest = steps.reduce((top, step) => (step.heightM > top.heightM ? step : top), steps[0]);
    const content = intentDesign.build({ kind: 'building', site: footprint, footprint, floors: tallest.floors, height: tallest.heightM,
        use: tallest.use, ...authorship(title, description) }, { turf });
    const buildings = steps.map(step => ({ type: 'Feature', geometry: step.geometry,
        properties: { type: 'proposedBuildingSingle', floors: step.floors, height: step.heightM, use: step.use, rotation: 0, footprintMode: 'polygon', block: blockName, buildingId,
            ...(facade ? { facade } : {}), ...(model || {}) } }));
    const land = FreeformLandTake.plan({ buildings, parcels: [], whole: new Set(), turf });
    const record = localRecord(content);
    record.goal = 'single';
    record.site = structuredClone(land.footprint.geometry);
    record.geometry = { buildings, landTake: structuredClone(land.take.geometry) };
    record.buildingProposal = { typologyType: 'single', blockName,
        parameters: { typology: 'single', floors: tallest.floors, height: tallest.heightM, use: tallest.use, rotation: 0 } };
    return record;
}

function space({ title, description, kind, geometry, treeCount }) {
    return localRecord(intentDesign.build({ kind: 'space', spaceKind: kind, site: geometry, ...(kind === 'park' ? { treeCount } : {}),
        ...authorship(title, description) }, { turf }));
}

/**
 * A footway (pavement only, so it bridges a road rather than joining it) along points [{ lng, lat,
 * level }]; tunnelEdges are the indices of edges that pass through a kept building (corridor-tunnel.js).
 */
function footway({ title, description, points, tunnelEdges = [] }) {
    const content = intentDesign.build({ kind: 'road', points: points.map(point => [point.lng, point.lat]),
        lanes: [{ type: 'sidewalk', width: FOOTWAY_WIDTH_M }], ...authorship(title, description) }, { turf });
    const view = corridorRuntime.osm.toView(content.roadProposal.definition);
    const levelled = view.points[0].map((point, index) => (points[index].level ? { ...point, level: points[index].level } : point));
    view.points = [levelled];
    view.segments = [levelled.map(point => ({ ...point }))];
    view.tunnels = tunnelEdges.map(index => {
        const from = levelled[index], to = levelled[index + 1];
        const key = point => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
        const edgeKey = [key(from), key(to)].sort().join('|');
        return { id: `building-tunnel:${edgeKey}`, kind: 'building', edgeKey, from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng }, segmentId: view.segmentIds?.[0] || null };
    });
    const material = corridorRuntime.footprint.materialize(view);
    view.polygon = material.polygon;
    view.constructionFrame = material.constructionFrame;
    const record = localRecord(content);
    record.site = structuredClone(material.polygon);
    record.roadProposal = { ...record.roadProposal, definition: view };
    return record;
}

// ---- the plan's pieces ---------------------------------------------------------------------------------

const lngLat = ([lng, lat]) => ({ lng, lat });

// The passage: the stretch of the drawn route that crosses the museum, with an apron onto the square
// and the plaza; the edge inside the museum is a building tunnel, so the museum stands.
function passagePoints(model, museum) {
    const line = turf.lineString(model.passage.geometry.coordinates);
    const crossings = turf.lineIntersect(line, feature(museum)).features.map(point => point.geometry.coordinates);
    if (crossings.length < 2) throw new Error('the passage route does not cross the museum');
    const along = point => turf.nearestPointOnLine(line, point, { units: 'meters' }).properties.location;
    const sorted = crossings.sort((a, b) => along(a) - along(b));
    const entry = sorted[0], exit = sorted[sorted.length - 1];
    const at = metres => turf.along(line, metres, { units: 'meters' }).geometry.coordinates;
    return {
        points: [at(Math.max(0, along(entry) - PASSAGE_APRON_M)), entry, exit, at(along(exit) + PASSAGE_APRON_M)].map(lngLat),
        lengthM: round1(along(exit) - along(entry))
    };
}

// The Cibona link, from the plaza's corner over Tratinska ulica onto the Cibona terrace. The model's
// ribbon rises from the street edge west of the plaza (level 0) to the bridge deck (level +1, 5 m in
// the author's text), which lands on the terrace at the same height.
function linkPoints(model) {
    const coordinates = model.link.geometry.coordinates.slice().reverse();
    return coordinates.map((coordinate, index) => ({ ...lngLat(coordinate), level: index === 0 ? 0 : 1 }));
}

/**
 * Every design in claim order, each with the ground it takes after the earlier ones. With `authorModel`
 * ({ modelUrl, modelOrigin, rotation }, prepare-model.mjs) the vLAB building is the author's own model,
 * with its interiors, standing georeferenced on the building's whole footprint.
 */
export function vlabDesigns({ authorModel = null } = {}) {
    const model = vlabModel();
    const keptGround = turf.buffer(feature(union(model.kept.map(item => item.geometry))), KEPT_MARGIN_M, { units: 'meters' }).geometry;
    const museum = union(model.kept.filter(item => item.properties.keptBy === 'kul_inn_tech_muzej').map(item => item.geometry));
    let taken = null;
    const designs = [];
    // A building or a corridor keeps its exact geometry: losing ground to an earlier design is an error.
    const claimExact = (key, record) => {
        const ground = record.geometry?.landTake || record.site;
        const lost = area(ground) - area(difference(ground, taken));
        if (lost > MAX_LOST_M2) throw new Error(`${key}: ${lost.toFixed(1)} m² overlaps an earlier design`);
        taken = union([taken, ground]);
        designs.push({ key, record });
    };
    // A space is what is left of its drawn ground. The app applies a park or square as one connected
    // area, so each connected piece is its own design, largest first: build(ground, index, count).
    const claimSpace = (key, geometry, build) => {
        const pieces = parts(difference(difference(geometry, taken), keptGround), MIN_SPACE_PIECE_M2).sort((a, b) => area(b) - area(a));
        if (!pieces.length) throw new Error(`${key}: nothing is left of the space`);
        pieces.forEach((ground, index) => {
            taken = union([taken, ground]);
            designs.push({ key: pieces.length > 1 ? `${key}-${index + 1}` : key, record: build(ground, index, pieces.length) });
        });
    };
    const pieceTitle = (title, index, count) => (count > 1 ? `${title} (${index + 1}/${count})` : title);

    const vlabParts = model.vlab.map(item => ({ geometry: item.geometry, heightM: item.properties.heightM, floors: Math.max(1, item.properties.storeys), use: 'public' }));
    const footprintM2 = Math.round(area(union(vlabParts.map(step => step.geometry))));
    if (authorModel) {
        claimExact('zgrada-vlab-model', steppedBuilding({
            title: 'vLAB – zgrada (autorov model)',
            description: `Zgrada vLAB kao autorov 3D model s interijerom svih etaža (−2 do +6); tlocrt ${footprintM2} m², do 32 m.`,
            blockName: 'vLAB', buildingId: 'vlab',
            model: { source: 'upload', modelUrl: authorModel.modelUrl, modelName: 'vLAB (Ivan Gavran Vlahović)', modelOrigin: authorModel.modelOrigin, rotation: authorModel.rotation },
            parts: [{ geometry: union(vlabParts.map(step => step.geometry)), heightM: 32, floors: 7, use: 'public' }]
        }));
    } else claimExact('zgrada-vlab', steppedBuilding({
        title: 'vLAB – zgrada',
        description: `Višenamjenska zgrada vLAB, ispostava Zagrebačkoga velesajma: dvorane i auditoriji, galerije, trgovine, ugostiteljstvo, wellness, uredi i institucionalni partneri;`
            + ` tlocrt ${footprintM2} m², stepenasti volumen do ${Math.max(...vlabParts.map(step => step.heightM))} m (P+6),`
            + ` dvije podzemne etaže s 374 parkirna mjesta (−2: 281, −1: 93) koje ovaj prikaz ne modelira.`,
        // The author's renders show a glazed building, its park front a liftable glass facade.
        blockName: 'vLAB', buildingId: 'vlab', facade: 'glass-large', parts: vlabParts
    }));

    // The author's tower: three stepped volumes, 1535 / 697 / 377 m² and 18 / 12 / 36 m, with 4 / 3 / 10 floors.
    const towerUses = ['office', 'residential', 'residential'];
    const towerFloors = [4, 7, 17];
    claimExact('toranj', steppedBuilding({
        title: 'vLAB – toranj',
        description: 'Mješoviti toranj od 66 m u tri stepenasta volumena s javnim terasama na prijelazima, oko 12 000 m² ukupne površine, 17 etaža:'
            + ' donji volumen (1535 m², 18 m, 4 etaže) poslovni, srednji (697 m², 12 m, 3 etaže) i gornji (377 m², 36 m, 10 etaža) pretežno stambeni, oko 50 stanova.',
        blockName: 'vLAB toranj', buildingId: 'vlab-toranj', facade: 'glass-medium',
        parts: model.tower.map((item, index) => ({ geometry: item.geometry, heightM: item.properties.heightM, floors: towerFloors[index], use: towerUses[index] }))
    }));

    const passage = passagePoints(model, museum);
    claimExact('prolaz', footway({
        title: 'vLAB – prolaz kroz Tehnički muzej',
        description: `Pješački prolaz ispod zgrade Tehničkog muzeja Nikola Tesla (${Math.round(passage.lengthM)} m ispod zgrade) na spoju dvorana A i B,`
            + ' prema natječajnom projektu Bauera i Haberlea iz 1935.; povezuje novi park i trg sa sjevera s plazom muzeja na jugu. Zgrada muzeja ostaje.',
        points: passage.points, tunnelEdges: [1]
    }));

    claimExact('veza-cibona', footway({
        title: 'vLAB – pješački most prema Ciboni',
        description: 'Pješački most s rampom preko Tratinske ulice: svladava oko 5 m visinske razlike između plaze muzeja i platoa Cibone i spaja park, prolaz, plazu i Cibonu u jedan pješački potez od 400 do 500 m.',
        points: linkPoints(model)
    }));

    const parkM2 = area(difference(difference(model.park, taken), keptGround));
    claimSpace('park', model.park, (ground, index, count) => space({ kind: 'park', geometry: ground, treeCount: Math.round(PARK_TREES * area(ground) / parkM2),
        title: pieceTitle('vLAB – park', index, count), description: `Javni park na mjestu uklonjenog željezničkog nasipa uz Jukićevu ulicu, s terasama prema pruzi (${Math.round(area(ground))} m²).` }));
    claimSpace('plaza-muzeja', model.plaza, (ground, index, count) => space({ kind: 'square', geometry: ground,
        title: pieceTitle('vLAB – plaza Tehničkog muzeja', index, count), description: `Plaza ispred Tehničkog muzeja vraćena gradu: bez ograde, otvorena sa Savske (${Math.round(area(ground))} m²).` }));
    const plots = model.sitePlots.map(plot => plot.number).join(', ');
    claimSpace('trg', model.site, (ground, index, count) => space({ kind: 'square', geometry: ground,
        title: pieceTitle('vLAB – trg', index, count), description: `Javni trg kao vanjski nastavak zgrade vLAB: priredbe, sajmovi, okupljanja i instalacije;`
            + ` ostatak lokacije (k.č. ${plots}, k.o. Centar) izvan zgrade, tornja i parka (${Math.round(area(ground))} m²).` }));
    return designs;
}

/** The local variant with the author's model (prepare-model.mjs output in the gitignored cache/). */
export function vlabModelPlan(authorModel) {
    return {
        key: `${PLAN_KEY}-autorov-model`,
        title: 'vLAB – transformacija prostora između Cibone i Westina (autorov model)',
        author: AUTHOR,
        city: CITY,
        parcelSourceId: 'oss-wfs',
        groundFile: fileURLToPath(new URL(`./cache/ground-${PLAN_KEY}-autorov-model.json`, import.meta.url)),
        designs: vlabDesigns({ authorModel })
    };
}

/** The plan as restatement-publish.mjs takes it. */
export function vlabPlan() {
    return {
        key: PLAN_KEY,
        title: 'vLAB – transformacija prostora između Cibone i Westina',
        author: AUTHOR,
        city: CITY,
        parcelSourceId: 'oss-wfs',
        groundFile: fileURLToPath(new URL(`./ground/${PLAN_KEY}.json`, import.meta.url)),
        designs: vlabDesigns()
    };
}
