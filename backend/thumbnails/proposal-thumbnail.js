// Turns a proposal into a stored thumbnail PNG: works out which geometry the picture should frame,
// pulls the parent/neighbour parcel outlines for context, renders the tile-stitched image and writes
// it to the shared image store, returning the URL to put in proposal.screenshot_url.
//
// The geometry resolution mirrors reconstructProposalScreenshotDataUrl, the browser-side function
// this replaces (deleted from frontend/js/proposals/dialog-upload.js in the same change), so a
// server-rendered thumbnail frames a proposal the way the client-side one did.
import * as turf from '@turf/turf';
import { renderProposalThumbnail } from './tile-stitch.js';
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
    'decide-later': '🪡',
    'decide later': '🪡',
    'reparcellization': '✂️',
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
    return normalizeGoalKey(proposal?.goal || proposal?.proposalType || proposal?.type || '');
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
 * A proposal is a road proposal if it says so OR if it simply has a roadProposal on it.
 *
 * The goal key alone is not enough: older proposals store type `road`/`Track` with no `goal` at all,
 * and the browser's version of this only ever matched the exact key 'road-track'. That is why 33 road
 * proposals whose corridor could be drawn from their stored centerline had no thumbnail — the code
 * that would have drawn them was behind a check they could never pass.
 */
function isRoadProposal(proposal) {
    const goalKey = resolveProposalGoalKey(proposal);
    if (goalKey === 'road-track' || goalKey === 'road' || goalKey === 'track') return true;
    return !!proposal.roadProposal;
}

function fromGeometry(geom) {
    if (!geom || !geom.coordinates) return null;
    if (geom.type === 'Polygon') return { polygon: geom.coordinates, polygonOrder: 'lnglat' };
    if (geom.type === 'MultiPolygon') return { polygon: geom.coordinates[0], polygonOrder: 'lnglat' };
    return null;
}

/**
 * Pull the coordinate ring the thumbnail should highlight out of whatever the proposal stored.
 * Port of the browser's resolveProposalPolygonForScreenshot, which this replaces.
 * @returns {{ polygon: Array|null, polygonOrder?: string, fitToPolygonOnly?: boolean }}
 */
export function resolveProposalPolygon(proposal) {
    if (!proposal) return { polygon: null };

    if (isRoadProposal(proposal)) {
        const rp = proposal.roadProposal || {};
        const def = rp.definition || proposal.definition || {};
        const candidates = [
            rp.polygon,
            rp.superGeometry,
            rp.geometry,
            def.polygon,
            proposal.geometry && proposal.geometry.roadGeometry && proposal.geometry.roadGeometry.polygon
        ];
        for (const candidate of candidates) {
            const resolved = fromGeometry(candidate);
            if (resolved) return { ...resolved, fitToPolygonOnly: true };
        }

        // Last resort: buffer the centerline by half the road width to synthesise a polygon.
        const points = Array.isArray(def.points) ? def.points : [];
        const width = Number.isFinite(Number(def.width)) ? Number(def.width) : 0;
        if (points.length >= 2 && width > 0) {
            try {
                const coords = points
                    .map(p => {
                        const lng = Number(p && (p.lng ?? p.lon ?? p.longitude ?? p[0]));
                        const lat = Number(p && (p.lat ?? p.latitude ?? p[1]));
                        return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
                    })
                    .filter(Boolean);
                if (coords.length >= 2) {
                    const buffered = turf.buffer(turf.lineString(coords), width / 2, { units: 'meters' });
                    const resolved = fromGeometry(buffered && buffered.geometry);
                    if (resolved) return { ...resolved, fitToPolygonOnly: true };
                }
            } catch (err) {
                console.warn('[thumbnail] Failed to buffer road centerline:', err.message);
            }
        }
    }

    if (proposal.buildingGeometry) {
        const resolved = fromGeometry(proposal.buildingGeometry);
        if (resolved) return resolved;
    }

    if (proposal.structureProposal && proposal.structureProposal.geometry) {
        const resolved = fromGeometry(proposal.structureProposal.geometry);
        if (resolved) return resolved;
    }

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

    // Generic geometry collection fallback (e.g. parcel-only proposals)
    if (proposal.geometry && Array.isArray(proposal.geometry.buildings)) {
        for (const f of proposal.geometry.buildings) {
            const resolved = fromGeometry(f && f.geometry);
            if (resolved) return resolved;
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

function ringsToPolygonGeometries(rings) {
    return rings.map(coords => ({ type: 'Polygon', coordinates: coords }));
}

export function getProposalParentParcelIds(proposal) {
    const ids = Array.isArray(proposal?.parentParcelIds)
        ? proposal.parentParcelIds
        : (Array.isArray(proposal?.roadProposal?.parentParcelIds) ? proposal.roadProposal.parentParcelIds : []);
    return ids.map(id => (id === null || id === undefined ? null : String(id))).filter(Boolean);
}

/**
 * Assemble everything the renderer needs for one proposal: the highlighted polygon, the parent
 * parcel outlines (which expand the frame for building proposals) and the goal badge.
 * @returns {Promise<Object|null>} renderer options, or null when the proposal has no usable geometry
 */
export async function buildThumbnailRenderOptions(pool, proposal, city) {
    if (!proposal || shouldSkipProposalThumbnail(proposal)) return null;

    const parentParcelIds = getProposalParentParcelIds(proposal);
    const parentPolygons = parentParcelIds.length
        ? await fetchParcelPolygonsByIds(pool, city, parentParcelIds)
        : [];

    let { polygon, polygonOrder, fitToPolygonOnly } = resolveProposalPolygon(proposal);

    // Parcel-only proposals (merge / decide-later) have no geometry of their own: the picture is the
    // union of the parent parcels.
    if (!polygon && parentPolygons.length) {
        if (parentPolygons.length === 1) {
            polygon = parentPolygons[0];
            polygonOrder = 'lnglat';
        } else {
            const merged = unionGeometries(ringsToPolygonGeometries(parentPolygons));
            const resolved = merged ? fromGeometry(merged) : null;
            polygon = resolved ? resolved.polygon : parentPolygons[0];
            polygonOrder = 'lnglat';
        }
    }

    if (!polygon) return null;

    // Building proposals frame the parent parcel too (the building sits inside it, and the dashed
    // outline is what shows that); for other goals the parents either already ARE the polygon
    // (merge) or are irrelevant to the picture (a road corridor cuts across many of them).
    const isBuildingProposal = !!(proposal.buildingGeometry || proposal.buildingProposal);
    const parcelPolygons = isBuildingProposal ? parentPolygons : [];

    // Older road proposals have no goal key at all, so fall back to the road badge for them.
    const badge = goalBadge(resolveProposalGoalKey(proposal))
        || (isRoadProposal(proposal) ? goalBadge('road-track') : null);

    return {
        polygon,
        parcelPolygons,
        padding: THUMBNAIL_PADDING,
        zoom: THUMBNAIL_ZOOM,
        badge,
        polygonOrder: polygonOrder || 'auto',
        parcelPolygonOrder: 'lnglat',
        fitToPolygonOnly: !!fitToPolygonOnly
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
 * @returns {Promise<{ url: string|null, buffer: Buffer, frame: Object, tiles: Object }|null>}
 *          null when the proposal has no geometry worth rendering; throws when rendering fails
 */
export async function generateAndStoreProposalThumbnail(pool, proposal, { city, proposalId, baseUrl, dryRun = false }) {
    const renderOptions = await buildThumbnailRenderOptions(pool, proposal, city);
    if (!renderOptions) return null;

    const { buffer, frame, tiles } = await renderProposalThumbnail(renderOptions);

    // A thumbnail whose tiles all failed is a grey rectangle — worse than no thumbnail, because it
    // would be indistinguishable from a real one and never regenerated.
    if (tiles.total > 0 && tiles.loaded === 0) {
        throw new Error(`All ${tiles.total} basemap tiles failed to load`);
    }

    if (dryRun) {
        return { url: null, fileName: null, buffer, frame, tiles, bytes: buffer.length };
    }

    const { fileName, imagePath } = saveImageBuffer(buffer, `proposal-thumb-${proposalId}-${Date.now()}`);
    const url = `${String(baseUrl).replace(/\/$/, '')}${imagePath}`;
    return { url, fileName, imagePath, buffer, frame, tiles, bytes: buffer.length };
}

export { PROPOSAL_SCREENSHOT_SKIP_GOALS, PROPOSAL_GOAL_ICON_MAP };
