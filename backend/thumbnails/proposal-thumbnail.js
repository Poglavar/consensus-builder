// Turns a proposal into a stored thumbnail PNG: works out which geometry the picture should frame,
// pulls the parent/neighbour parcel outlines for context, renders the tile-stitched image and writes
// it to the shared image store, returning the URL to put in proposal.screenshot_url.
//
// The geometry resolution mirrors reconstructProposalScreenshotDataUrl, the browser-side function
// this replaces (deleted from frontend/js/proposals/dialog-upload.js in the same change), so a
// server-rendered thumbnail frames a proposal the way the client-side one did.
//
// Indexed designs and agreements (plan-design-agreement.md, M2) render here too, keyed by CID: a
// design as the proposal it was authored as, with the parcels its binding found as its parcels; an
// agreement as every part of every design it links, in one frame over its input land.
import * as turf from '@turf/turf';
import { renderProposalThumbnailSet } from './tile-stitch.js';
import { fetchParcelPolygonsByIds } from './parcel-geometry.js';
import { saveImageBuffer } from '../utils/image-store.js';

// Mirrors PROPOSAL_GOAL_ICON_MAP in frontend/js/proposals/data.js — the badge drawn top-left.
const PROPOSAL_GOAL_ICON_MAP = {
    'as-is': '🟰',
    'square': '⛲️',
    'park': '🌳',
    'lake': '🐟',
    'station': '🚉',
    'single': '🏠',
    'buildings': '🏠',
    'road-track': '🛣️🛤️',
    'road/track': '🛣️🛤️',
    'urban-rule': '📜📐',
    'urban rule': '📜📐',
    'reparcellization': '✂️',
    'parcel-layout': '✂️',
    'ownership-transfer': '🔄',
    'ownership-transfer-to-me': '🔄',
    'ownership-transfer-from-me': '🔄'
};

// Goals with no meaningful map geometry — a thumbnail would just be a placeholder.
const PROPOSAL_SCREENSHOT_SKIP_GOALS = new Set([
    'urban-rule',
    'ownership-transfer',
    'ownership-transfer-to-me',
    'ownership-transfer-from-me'
]);

const THUMBNAIL_PADDING = 0.12;
const THUMBNAIL_ZOOM = 19;

// Port of normalizeGoalKey (frontend/js/proposals/core.js).
export function normalizeGoalKey(goal) {
    const raw = (goal || '').toString().trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('building')) return 'single';
    if (raw === 'road track') return 'road-track';
    if (raw === 'ownership transfer to me' || raw === 'ownership-transfer-to-me') return 'ownership-transfer-to-me';
    if (raw === 'ownership transfer from me' || raw === 'ownership-transfer-from-me') return 'ownership-transfer-from-me';
    if (raw === 'ownership transfer' || raw === 'ownership-transfer') return 'ownership-transfer';
    return raw;
}

export function resolveProposalGoalKey(proposal) {
    return normalizeGoalKey(proposal?.goal || '');
}

export function shouldSkipProposalThumbnail(proposal) {
    if (!proposal) return true;
    return PROPOSAL_SCREENSHOT_SKIP_GOALS.has(resolveProposalGoalKey(proposal));
}

function goalBadge(goalKey) {
    const icon = PROPOSAL_GOAL_ICON_MAP[normalizeGoalKey(goalKey)];
    return icon ? { text: icon } : null;
}

/**
 * A proposal is a road proposal if its authored goal says so or it carries road-specific geometry.
 */
function isRoadProposal(proposal) {
    const goalKey = resolveProposalGoalKey(proposal);
    if (goalKey === 'road-track') return true;
    return !!proposal.roadProposal;
}

function fromGeometry(geom) {
    if (!geom || !geom.coordinates) return null;
    if (geom.type === 'Polygon') return { polygon: geom.coordinates, polygonOrder: 'lnglat' };
    if (geom.type === 'MultiPolygon') return { polygon: geom.coordinates[0], polygonOrder: 'lnglat' };
    return null;
}

// Every polygon of a geometry (or Feature) as its own coordinate array, holes kept with their polygon.
function polygonCoordinates(geometry) {
    const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
    if (!g || !Array.isArray(g.coordinates)) return [];
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
}

// A parcel layout's plots, each drawn as its own part so the borders it draws stay visible.
function layoutPlotParts(layout) {
    return Array.isArray(layout?.plots) ? layout.plots.flatMap(plot => polygonCoordinates(plot?.geometry)) : [];
}

/**
 * Pull the coordinate ring the thumbnail should highlight out of whatever the proposal stored.
 * Port of the browser's resolveProposalPolygonForScreenshot, which this replaces.
 * @returns {{ polygon: Array|null, polygonParts?: Array, polygonOrder?: string, fitToPolygonOnly?: boolean }}
 *   polygonParts: independent polygons drawn in one frame (a parcel layout's plots)
 */
export function resolveProposalPolygon(proposal) {
    if (!proposal) return { polygon: null };

    if (isRoadProposal(proposal)) {
        const resolved = fromGeometry(proposal.roadProposal?.definition?.polygon);
        if (resolved) return { ...resolved, fitToPolygonOnly: true };
    }

    if (proposal.buildingGeometry) {
        const resolved = fromGeometry(proposal.buildingGeometry);
        if (resolved) return resolved;
    }

    if (proposal.structureProposal && proposal.structureProposal.geometry) {
        const resolved = fromGeometry(proposal.structureProposal.geometry);
        if (resolved) return resolved;
    }

    const plots = layoutPlotParts(proposal.parcelLayout);
    if (plots.length) return { polygon: plots[0], polygonParts: plots, polygonOrder: 'lnglat' };

    // Reparcellization: union the slice geometries so the thumbnail frames the whole carve-up.
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length) {
        const slices = proposal.reparcellization.polygons
            .map(s => s && s.geometry)
            .filter(g => g && g.coordinates && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
        if (slices.length === 1) {
            const resolved = fromGeometry(slices[0]);
            if (resolved) return resolved;
        } else if (slices.length > 1) {
            const merged = unionGeometries(slices);
            const resolved = merged ? fromGeometry(merged) : null;
            if (resolved) return resolved;
            const first = fromGeometry(slices[0]);
            if (first) return first;
        }
    }

    if (proposal.geometry && (proposal.geometry.type === 'Polygon' || proposal.geometry.type === 'MultiPolygon')) {
        const resolved = fromGeometry(proposal.geometry);
        if (resolved) return resolved;
    }

    // A plan's buildings (geometry.buildings, one feature each): every footprint is drawn, before the
    // site, so two plans on one site do not share a picture of the site alone (the two Candlestick
    // Point plans rendered byte-identical thumbnails, 2026-10-12).
    if (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length) {
        const parts = [];
        for (const f of proposal.geometry.buildings) {
            const g = f && f.geometry;
            if (!g || !Array.isArray(g.coordinates)) continue;
            if (g.type === 'Polygon') parts.push(g.coordinates);
            else if (g.type === 'MultiPolygon') parts.push(...g.coordinates);
        }
        if (parts.length) return { polygon: parts.length === 1 ? parts[0] : parts, polygonOrder: 'lnglat' };
    }

    // The proposal's site (PARCEL-OPTIONAL.md): its ground, a MultiPolygon, and on open ground (an
    // explore city, unsurveyed land) the only geometry a record may have. Every part is framed.
    const site = proposal.site;
    if (site && Array.isArray(site.coordinates) && site.coordinates.length) {
        if (site.type === 'Polygon') return { polygon: site.coordinates, polygonOrder: 'lnglat' };
        if (site.type === 'MultiPolygon') {
            return { polygon: site.coordinates.length === 1 ? site.coordinates[0] : site.coordinates, polygonOrder: 'lnglat' };
        }
    }

    return { polygon: null };
}

function unionGeometries(geometries) {
    try {
        let merged = null;
        for (const geom of geometries) {
            const feature = { type: 'Feature', properties: {}, geometry: geom };
            merged = merged ? (turf.union(merged, feature) || merged) : feature;
        }
        return merged ? merged.geometry : null;
    } catch (err) {
        console.warn('[thumbnail] turf.union failed:', err.message);
        return null;
    }
}

export function getProposalCadastreParcelIds(proposal) {
    const ids = Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
    return ids.map(id => (id === null || id === undefined ? null : String(id))).filter(Boolean);
}

/**
 * Assemble everything the renderer needs for one proposal: the highlighted polygon, the cadastral
 * parcel outlines (which expand the frame for building proposals) and the goal badge.
 * @returns {Promise<Object|null>} renderer options, or null when the proposal has no usable geometry
 */
export async function buildThumbnailRenderOptions(pool, proposal, city) {
    if (!proposal || shouldSkipProposalThumbnail(proposal)) return null;

    // A record draws its own geometry; one with parcels and nothing of its own has no picture.
    const { polygon, polygonParts, polygonOrder, fitToPolygonOnly } = resolveProposalPolygon(proposal);
    if (!polygon) return null;

    // Building proposals frame the cadastral parcel too (the building sits inside it, and the dashed
    // outline is what shows that); for other goals those parcels are irrelevant to the picture (a
    // road corridor cuts across many of them), so they are not read.
    const isBuildingProposal = !!(proposal.buildingGeometry || proposal.buildingProposal);
    const cadastreParcelIds = isBuildingProposal ? getProposalCadastreParcelIds(proposal) : [];
    const parcelPolygons = cadastreParcelIds.length
        ? await fetchParcelPolygonsByIds(pool, city, cadastreParcelIds)
        : [];

    // Older road proposals have no goal key at all, so fall back to the road badge for them.
    const badge = goalBadge(resolveProposalGoalKey(proposal))
        || (isRoadProposal(proposal) ? goalBadge('road-track') : null);

    return {
        polygon,
        ...(polygonParts ? { polygonParts } : {}),
        parcelPolygons,
        padding: THUMBNAIL_PADDING,
        zoom: THUMBNAIL_ZOOM,
        badge,
        polygonOrder: polygonOrder || 'auto',
        parcelPolygonOrder: 'lnglat',
        fitToPolygonOnly: !!fitToPolygonOnly
    };
}

// The parcels a design's binding found (proposals/binding.js): what a proposal declared, for a design.
function boundParcelIds(binding) {
    return (Array.isArray(binding?.parcels) ? binding.parcels : []).map(hit => String(hit.parcelId));
}

// A design is drawn as the proposal it was authored as: its design/v1 content, with the parcels its
// binding found standing in for a proposal's declared ones (a building design frames them).
export function designRenderSubject({ content, binding }) {
    return { ...content, cadastreParcelIds: boundParcelIds(binding) };
}

/**
 * The polygon parts of one design, by the thumbnail resolver's precedence: the road's land, the
 * structure, the layout's plots, the geometry, its buildings, else the site. Every MultiPolygon part
 * is kept; nothing is unioned, so overlapping designs and their holes survive in a shared frame.
 */
export function resolveDesignParts(content) {
    const road = polygonCoordinates(content?.roadProposal?.definition?.polygon);
    if (road.length) return road;
    const structure = polygonCoordinates(content?.structureProposal?.geometry);
    if (structure.length) return structure;
    const plots = layoutPlotParts(content?.parcelLayout);
    if (plots.length) return plots;
    const geometry = content?.geometry;
    const direct = polygonCoordinates(geometry);
    if (direct.length) return direct;
    if (Array.isArray(geometry?.buildings)) {
        const buildings = geometry.buildings.flatMap(polygonCoordinates);
        if (buildings.length) return buildings;
    }
    return polygonCoordinates(content?.site);
}

/**
 * An agreement's picture: every design it links, each part separate, over the outlines of its input
 * land (which the frame always includes: the agreement settles all of it).
 * @param {{ city: string|null, designs: { content: object }[], inputParcelIds: string[] }} agreement
 * @returns {Promise<Object|null>} renderer options, or null when no design has geometry to draw
 */
export async function buildAgreementRenderOptions(pool, { city, designs, inputParcelIds }) {
    const parts = (Array.isArray(designs) ? designs : []).flatMap(design => resolveDesignParts(design?.content));
    if (!parts.length) return null;
    const parcelPolygons = await fetchParcelPolygonsByIds(pool, city, inputParcelIds || []);
    return {
        polygon: parts[0],
        polygonParts: parts,
        polygonOrder: 'lnglat',
        parcelPolygons,
        parcelPolygonOrder: 'lnglat',
        padding: THUMBNAIL_PADDING,
        zoom: THUMBNAIL_ZOOM
    };
}

// One tile fetch, three pictures: the thumbnail, the same ground without the subject, and the two
// side by side (dividers.md, M3), stored as <kind>-thumb|before|pair-<key>-<stamp>.
async function renderAndStore(renderOptions, { kind, key, baseUrl, dryRun }) {
    const set = await renderProposalThumbnailSet(renderOptions);
    const { frame, tiles } = set;
    const buffer = set.after.buffer;
    const beforeBuffer = set.before.buffer;
    const pairBuffer = set.pair.buffer;

    // A thumbnail whose tiles all failed is a grey rectangle — worse than no thumbnail, because it
    // would be indistinguishable from a real one and never regenerated.
    if (tiles.total > 0 && tiles.loaded === 0) {
        throw new Error(`All ${tiles.total} basemap tiles failed to load`);
    }

    if (dryRun) {
        return { url: null, beforeUrl: null, pairUrl: null, fileName: null, buffer, beforeBuffer, pairBuffer, frame, tiles, bytes: buffer.length };
    }

    const stamp = Date.now();
    const origin = String(baseUrl).replace(/\/$/, '');
    const { fileName, imagePath } = saveImageBuffer(buffer, `${kind}-thumb-${key}-${stamp}`);
    const before = saveImageBuffer(beforeBuffer, `${kind}-before-${key}-${stamp}`);
    const pair = saveImageBuffer(pairBuffer, `${kind}-pair-${key}-${stamp}`);
    return {
        url: `${origin}${imagePath}`, beforeUrl: `${origin}${before.imagePath}`, pairUrl: `${origin}${pair.imagePath}`,
        fileName, imagePath, buffer, beforeBuffer, pairBuffer, frame, tiles, bytes: buffer.length
    };
}

/**
 * Render and store a proposal thumbnail.
 * @param {Object} pool - pg pool (may be null: the thumbnail then renders without parcel context)
 * @param {Object} proposal - the proposal JSON (proposal_data)
 * @param {Object} options
 * @param {string} options.city - normalized city id
 * @param {string|number} options.proposalId - used for the file name
 * @param {string} options.baseUrl - absolute origin the stored file will be served from
 * @param {boolean} [options.dryRun=false] - render but store nothing; `url` comes back null
 * @returns {Promise<{ url: string|null, beforeUrl: string|null, pairUrl: string|null, buffer: Buffer,
 *                     beforeBuffer: Buffer, pairBuffer: Buffer, frame: Object, tiles: Object }|null>}
 *          null when the proposal has no geometry worth rendering; throws when rendering fails
 */
export async function generateAndStoreProposalThumbnail(pool, proposal, { city, proposalId, baseUrl, dryRun = false }) {
    const renderOptions = await buildThumbnailRenderOptions(pool, proposal, city);
    if (!renderOptions) return null;
    return renderAndStore(renderOptions, { kind: 'proposal', key: proposalId, baseUrl, dryRun });
}

/**
 * Render and store the thumbnail set of an indexed design or agreement, named by its CID.
 * @param {Object} pool - pg pool (parcel context; may be null)
 * @param {{ kind: 'design', cid: string, city: string|null, content: object, binding: object }
 *       | { kind: 'agreement', cid: string, city: string|null, designs: { content: object }[], inputParcelIds: string[] }} subject
 * @param {{ baseUrl: string, dryRun?: boolean }} options - as generateAndStoreProposalThumbnail
 * @returns {Promise<Object|null>} as generateAndStoreProposalThumbnail; null when there is nothing to draw
 */
export async function generateAndStoreContentThumbnail(pool, subject, { baseUrl, dryRun = false } = {}) {
    if (!subject || !['design', 'agreement'].includes(subject.kind)) throw new Error(`Unknown thumbnail subject ${subject?.kind}.`);
    const renderOptions = subject.kind === 'agreement'
        ? await buildAgreementRenderOptions(pool, subject)
        : await buildThumbnailRenderOptions(pool, designRenderSubject(subject), subject.city);
    if (!renderOptions) return null;
    return renderAndStore(renderOptions, { kind: subject.kind, key: subject.cid, baseUrl, dryRun });
}

export { PROPOSAL_SCREENSHOT_SKIP_GOALS, PROPOSAL_GOAL_ICON_MAP };
