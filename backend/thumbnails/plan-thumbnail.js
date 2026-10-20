// A named plan's one whole-plan picture pair. Every member geometry is kept as its own polygon
// part in a common frame; no union is used, so overlapping footprints and their holes survive.
import { assertPlanCurrent } from '../plans/plan-commitment.js';
import { createLimiter } from './tile-source.js';
import { createPlanStore } from '../plans/plan-store.js';
import { normalizeKnownParcelSource } from '../markets/contests.js';

const PADDING = 0.12;
const ZOOM = 19;
const queued = new Set();
const renderLimiter = createLimiter(2);

function polygonCoordinates(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
}

function featureGeometry(feature) {
    return feature && feature.type === 'Feature' ? feature.geometry : feature;
}

function memberProposal(row) {
    const data = row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    return {
        ...data,
        type: row.type ?? null,
        goal: row.goal ?? null,
        cadastreParcelIds: row.cadastre_parcel_ids ?? [],
        roadProposal: row.road_proposal ?? null,
        buildingProposal: row.building_proposal ?? null,
        structureProposal: row.structure_proposal ?? null,
        reparcellization: row.reparcellization ?? null,
        geometry: row.geometry ?? null,
        // Plan hashes and the published serializer use authored site geometry. The PostGIS union
        // in row.site is only a spatial projection and must not stand in for that declaration.
        site: data.site ?? null
    };
}

// Preserve the thumbnail resolver's geometry precedence while retaining every MultiPolygon part.
export function resolvePlanMemberParts(row) {
    const proposal = memberProposal(row);
    const roadGeometry = proposal.roadProposal?.definition?.polygon;
    if (roadGeometry) {
        const parts = polygonCoordinates(roadGeometry);
        if (parts.length) return parts;
    }
    for (const geometry of [proposal.structureProposal?.geometry]) {
        const parts = polygonCoordinates(geometry);
        if (parts.length) return parts;
    }
    const slices = proposal.reparcellization?.polygons;
    if (Array.isArray(slices) && slices.length) {
        const parts = slices.flatMap(slice => polygonCoordinates(slice?.geometry));
        if (parts.length) return parts;
    }
    const geometry = proposal.geometry;
    const direct = polygonCoordinates(geometry);
    if (direct.length) return direct;
    if (Array.isArray(geometry?.buildings)) {
        const buildings = geometry.buildings.flatMap(feature => polygonCoordinates(featureGeometry(feature)));
        if (buildings.length) return buildings;
    }
    return polygonCoordinates(proposal.site);
}

export function collectPlanMemberParts(members) {
    return (Array.isArray(members) ? members : []).flatMap(resolvePlanMemberParts);
}

export function planMembersMatchSnapshot(plan, members) {
    if (!plan || !Array.isArray(members)) return false;
    const ids = Array.isArray(plan.proposal_ids) ? plan.proposal_ids.map(String) : [];
    const memberIds = members.map(member => String(member.id));
    if (new Set(memberIds).size !== memberIds.length
        || memberIds.length !== ids.length
        || ids.some(id => !memberIds.includes(id))) return false;
    try {
        assertPlanCurrent(plan, members);
        return true;
    } catch (error) {
        if (error?.code === 'plan-commitment-invalid' || error?.code === 'plan-members-changed') return false;
        throw error;
    }
}

export function declaredHrParcelIds(member) {
    let binding = member.binding;
    if (typeof binding === 'string') {
        try { binding = JSON.parse(binding); } catch { return []; }
    }
    const source = normalizeKnownParcelSource(binding?.parcelSource);
    if (source?.sourceId !== 'hr-cadastre' || source.snapshotId !== null) return [];
    return Array.isArray(member.cadastre_parcel_ids)
        ? [...new Set(member.cadastre_parcel_ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
        : [];
}

async function parcelContextByCity(pool, members) {
    const { fetchParcelPolygonsByIds } = await import('./parcel-geometry.js');
    const groups = new Map();
    for (const member of members) {
        const city = typeof member.city === 'string' ? member.city.trim() : '';
        const ids = declaredHrParcelIds(member);
        if (!city || !ids.length) continue;
        const group = groups.get(city) || new Set();
        ids.forEach(id => group.add(id));
        groups.set(city, group);
    }
    const geometries = await Promise.all([...groups].map(([city, ids]) => fetchParcelPolygonsByIds(pool, city, [...ids])));
    return geometries.flat();
}

async function renderPlan(pool, plan, members) {
    if (!planMembersMatchSnapshot(plan, members)) return null;
    const parts = collectPlanMemberParts(members);
    if (!parts.length) return null;
    const { renderProposalThumbnailSet } = await import('./tile-stitch.js');
    const parcelPolygons = await parcelContextByCity(pool, members);
    // The shared renderer keeps each member polygon path separate in one common frame, so holes
    // remain local to their own footprint and overlapping members do not cancel one another.
    return renderProposalThumbnailSet({
        polygonParts: parts,
        polygonOrder: 'lnglat',
        parcelPolygons,
        parcelPolygonOrder: 'lnglat',
        padding: PADDING,
        zoom: ZOOM
    });
}

async function loadPlan(pool, slug) {
    const { rows } = await pool.query('SELECT slug, proposal_ids, member_hashes, plan_hash, city, thumbnail_before_url, thumbnail_pair_url FROM ens_plan WHERE slug = $1 LIMIT 1', [slug]);
    const plan = rows[0];
    if (!plan) return null;
    const ids = Array.isArray(plan.proposal_ids) ? plan.proposal_ids : [];
    if (!ids.length) return { plan, members: [] };
    // Keep the thumbnail's hash input aligned with the canonical plan-store member projection.
    const members = await createPlanStore(pool).members(ids);
    const bindings = await pool.query(`SELECT id, COALESCE(binding, proposal_data->'binding') AS binding FROM proposal WHERE id = ANY($1::int[])`, [ids.map(Number)]);
    const bindingById = new Map(bindings.rows.map(row => [String(row.id), row.binding]));
    return { plan, members: members.map(member => ({ ...member, binding: bindingById.get(String(member.id)) ?? null })) };
}

/** Render and optionally persist the after/before/pair set for one immutable named plan. */
export async function generateAndStorePlanThumbnail(pool, slug, { baseUrl = '', dryRun = false } = {}) {
    const loaded = await loadPlan(pool, slug);
    if (!loaded) return null;
    const { plan, members } = loaded;
    if (!dryRun && !parseOrigin(baseUrl)) throw new Error('Persisting plan thumbnails requires an explicit public base URL origin.');
    if (plan.thumbnail_before_url && plan.thumbnail_pair_url) return null;
    const set = await renderPlan(pool, plan, members);
    if (!set) return null;
    if (set.tiles.total > 0 && set.tiles.loaded === 0) throw new Error(`All ${set.tiles.total} basemap tiles failed to load`);
    if (dryRun) return { ...set, urls: null };

    // Recheck the member snapshot before storing any file; rows changed during rendering leave no stale URL.
    const latest = await loadPlan(pool, slug);
    if (!latest || latest.plan.plan_hash !== plan.plan_hash || !planMembersMatchSnapshot(latest.plan, latest.members)) return null;
    const { saveImageBuffer } = await import('../utils/image-store.js');
    const origin = parseOrigin(baseUrl);
    const stamp = Date.now();
    const after = saveImageBuffer(set.after.buffer, `plan-thumb-${slug}-${stamp}`);
    const before = saveImageBuffer(set.before.buffer, `plan-before-${slug}-${stamp}`);
    const pair = saveImageBuffer(set.pair.buffer, `plan-pair-${slug}-${stamp}`);
    const urls = {
        after: `${origin}${after.imagePath}`,
        before: `${origin}${before.imagePath}`,
        pair: `${origin}${pair.imagePath}`
    };
    const update = await pool.query(`
        UPDATE ens_plan SET thumbnail_url = $1, thumbnail_before_url = $2, thumbnail_pair_url = $3, updated_at = NOW()
        WHERE slug = $4 AND plan_hash = $5 AND thumbnail_before_url IS NULL AND thumbnail_pair_url IS NULL`,
    [urls.after, urls.before, urls.pair, slug, plan.plan_hash]);
    return { ...set, urls, updated: update.rowCount > 0 };
}

function parseOrigin(value) {
    try {
        const parsed = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
        return parsed.origin;
    } catch { return null; }
}

/** In-memory fast path after plan creation; the restartable CLI retries failed or interrupted jobs. */
export function enqueuePlanThumbnail(pool, slug, options = {}) {
    if (!slug || queued.has(slug)) return null;
    queued.add(slug);
    const promise = renderLimiter.run(() => generateAndStorePlanThumbnail(pool, slug, options))
        .then(result => {
            if (result) console.log(`[${new Date().toISOString()}] [plan-thumbnail] ${slug}: rendered ${result.tiles.loaded}/${result.tiles.total} tiles`);
            else console.warn(`[${new Date().toISOString()}] [plan-thumbnail] ${slug}: skipped (missing or changed member snapshot)`);
            return result;
        })
        .catch(error => {
            console.error(`[${new Date().toISOString()}] [plan-thumbnail] ${slug}: RENDER FAILED; backfill can retry`, error);
            return null;
        })
        .finally(() => queued.delete(slug));
    return promise;
}
