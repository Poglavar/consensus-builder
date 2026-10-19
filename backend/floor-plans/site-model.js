// Assembles one located site's model: footprint (permitted building, surveyed building or parcels),
// storey envelope (step 2a) and the fit of every processed plan posted for that site (step 2b).
// Read-only: returns the model for review; nothing here publishes geometry.
import { buildEnvelope } from './envelope.js';
import { fingerprint } from '../buildings/floor-models.js';
import { fitPlan, toLocalMetres, toLngLat, transformRing, ringArea } from './plan-placement.js';
import { sameStreet } from './site-scoring.js';
import { sheetContexts } from './sheet-context.js';
import { projectInventory, projectSources } from './project-inventory.js';
import { currentProcessedPlans } from '../floor-plan-archive/processed-catalogue.js';
import { currentOriginalPlans, hasUsableGeometry, normalizeUnitId } from './original-plan-sources.js';

const closeRing = ring => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ? [...ring, ring[0]] : ring);

// The site's identity across postings: its permit case, else its address point, else its parcels.
export function siteKey(candidate) {
    const caseId = candidate?.permits?.find(p => p.caseId)?.caseId;
    if (caseId) return `permit:${caseId}`;
    const point = candidate?.addressPoints?.[0]?.id;
    if (point) return `address:${point}`;
    const parcels = (candidate?.parcels || []).map(p => `${p.ko}:${p.kc}`).sort();
    return parcels.length ? `parcels:${parcels.join(',')}` : null;
}

async function surveyHeight(db, candidate) {
    const survey = [...new Set(candidate.survey || [])];
    if (!survey.length) return null;
    const row = (await db.query(`SELECT max(z_max - z_min) AS height FROM public.gdi_building_3d WHERE object_id::text = ANY($1::text[])`, [survey])).rows[0];
    return row?.height === null || row?.height === undefined ? null : Number(row.height);
}

async function siteFootprint(db, candidate) {
    const buildingFeatures = (candidate.featureIds || []).filter(id => id.startsWith('eDozvola_building_polygon.'));
    if (buildingFeatures.length) {
        // One design state: the polygons of the single most authoritative case, never a union across
        // cases (a location permit's separate annex would otherwise fuse into the building).
        const row = (await db.query(`WITH ranked AS (
                SELECT case_id, case_kind, COALESCE(final_on, decided_on, received_on) AS on_date,
                    CASE WHEN case_kind ILIKE 'građevinska dozvola%' THEN 1 WHEN case_kind ILIKE 'prijava početka%' THEN 2
                         WHEN case_kind ILIKE 'uporabna%' THEN 3 WHEN case_kind ILIKE 'lokacijska%' THEN 4 ELSE 5 END AS rank
                FROM public.edozvola_feature WHERE id = ANY($1::text[])),
            chosen AS (SELECT case_id, case_kind FROM ranked ORDER BY rank, on_date DESC NULLS LAST, case_id LIMIT 1)
            SELECT c.case_id, c.case_kind, ST_AsGeoJSON(ST_Transform(ST_Union(ST_MakeValid(f.geom)), 4326))::jsonb AS g,
                ST_Area(ST_Union(ST_MakeValid(f.geom))) AS area
            FROM chosen c JOIN public.edozvola_feature f ON f.case_id = c.case_id AND f.id = ANY($1::text[])
            GROUP BY c.case_id, c.case_kind`, [buildingFeatures])).rows[0];
        if (row?.g) return { geometry: row.g, source: 'permit-footprint', areaM2: Number(row.area), caseId: row.case_id, caseKind: row.case_kind };
    }
    const survey = [...new Set(candidate.survey || [])];
    if (survey.length) {
        const row = (await db.query(`SELECT ST_AsGeoJSON(ST_Transform(ST_Union(geom2d_3765), 4326))::jsonb AS g, ST_Area(ST_Union(geom2d_3765)) AS area,
            max(z_max - z_min) AS height FROM public.gdi_building_3d WHERE object_id::text = ANY($1::text[])`, [survey])).rows[0];
        if (row?.g) return { geometry: row.g, source: 'survey-building', areaM2: Number(row.area), surveyHeightM: row.height === null ? null : Number(row.height) };
    }
    const parcels = (candidate.parcels || []).filter(p => p.ko && p.kc);
    if (parcels.length) {
        const row = (await db.query(`SELECT ST_AsGeoJSON(ST_Transform(ST_Union(geom), 4326))::jsonb AS g, ST_Area(ST_Union(geom)) AS area
            FROM public.parcel WHERE current AND (maticni_broj_ko::text, broj_cestice) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [parcels.map(p => String(p.ko)), parcels.map(p => p.kc)])).rows[0];
        if (row?.g) return { geometry: row.g, source: 'parcels', areaM2: Number(row.area) };
    }
    return null;
}

// Outer ring of a processed plan in metres, y north (image rows grow downward).
export function planOutline(model) {
    const [w, h] = model.architecture?.dimensionsM || [];
    const ring = model.architecture?.slabs?.[0]?.[0];
    if (!(w > 0 && h > 0) || !Array.isArray(ring) || ring.length < 3) return null;
    return ring.map(([u, v]) => [u * w, -v * h]);
}

// A printed north arrow fixes rotation softly: turn the plan so its north points up (+y).
export function northRotationDeg(model) {
    const north = model.source?.northPx;
    if (!Array.isArray(north) || north.length !== 2) return null;
    const [[x1, y1], [x2, y2]] = north;
    const theta = Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI;
    return ((90 - theta) % 360 + 360) % 360;
}

const SIDE_DEG = { top: 0, right: 90, bottom: 180, left: 270 };
const circularMean = degrees => {
    const x = degrees.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0), y = degrees.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
    return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
};

// A street printed along one edge of the drawing lies in that direction from the building: the
// rotation that maps the page edge onto the street's real bearing orients the plan.
async function rotationFromStreets(db, footprint, streets) {
    const rotations = [];
    for (const { name, side } of streets) {
        const rows = (await db.query(`WITH c AS (SELECT ST_Transform(ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3765) AS p)
            SELECT s.street_name, degrees(ST_Azimuth(c.p, ST_ClosestPoint(s.geom, c.p))) AS bearing, ST_Distance(s.geom, c.p) AS distance
            FROM public.street s, c WHERE s.current AND s.city_name = 'Zagreb' AND ST_DWithin(s.geom, c.p, 250)
            ORDER BY distance`, [JSON.stringify(footprint)])).rows.filter(row => sameStreet(row.street_name, name));
        if (rows.length && Number.isFinite(Number(rows[0].bearing))) rotations.push(((SIDE_DEG[side] - Number(rows[0].bearing)) % 360 + 360) % 360);
    }
    return rotations.length ? circularMean(rotations) : null;
}

export function storeysFromSheet(sheet) {
    const st = sheet?.storeys;
    if (!st?.aboveGround) return null;
    const upper = st.aboveGround - 1 - (st.recessedTop ? 1 : 0);
    if (upper < 0) return null;
    return `${'Po+'.repeat(st.belowGround || 0)}P${upper ? `+${upper}` : ''}${st.recessedTop ? '+Uk' : ''}`;
}

function largestRing(geometry) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.map(rings => rings[0]).sort((a, b) => ringArea(b) - ringArea(a))[0];
}

// Plans posted for the site: reviewed models first, then machine readings of sheets that have no
// reviewed model. One entry per source sheet and unit.
export async function sitePlans(db, listingUrls) {
    const reviewed = (await db.query(`SELECT DISTINCT ON (e.sha256) e.sha256, e.model, COALESCE(e.model->'source'->>'listingUrl', l.url) AS listing_url
        FROM floor_plan.extraction e
        LEFT JOIN floor_plan.target t ON t.current_sha256 = e.sha256 AND t.kind = 'asset'
        LEFT JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url', t.url, 'listingOwned', true))
        WHERE e.status = 'reviewed' AND e.model ? 'architecture'
          AND (e.model->'source'->>'listingUrl' = ANY($1::text[]) OR l.url = ANY($1::text[]))
        ORDER BY e.sha256`, [listingUrls])).rows.map(row => ({ id: `reviewed-${row.sha256.slice(0, 12)}`, kind: 'reviewed', ...row }));
    const machine = (await currentProcessedPlans(db)).filter(row => listingUrls.includes(row.listing_url)
        && !reviewed.some(r => r.sha256 === row.source_sha256))
        .map(row => ({ ...row, sha256: row.source_sha256, kind: 'machine' }));
    const geometry = [...reviewed, ...machine];
    const originals = await currentOriginalPlans(db, listingUrls, { processedPlans: machine });
    for (const original of originals) {
        const existing = geometry.find(plan => plan.sha256 === original.sha256
            && (plan.model.source?.page || 1) === original.model.source.page
            && (!original.model.unitId || normalizeUnitId(plan.model.unitId) === normalizeUnitId(original.model.unitId)));
        if (existing) {
            original.model.quality = existing.model.quality || original.model.quality;
            original.reviewStatus = existing.reviewStatus || existing.status || (existing.kind === 'reviewed' ? 'reviewed' : 'needs_review');
        }
    }
    return [...geometry, ...originals];
}

export async function siteModel(db, listingUrl, { referencesDb = db } = {}) {
    const listing = (await db.query(`SELECT url, facts, location, location_status FROM floor_plan.listing WHERE url = $1`, [listingUrl])).rows[0];
    if (!listing?.location?.candidates?.length) throw new Error('The listing has no located site.');
    const top = listing.location.candidates[0];
    const key = siteKey(top);
    // Every posting whose best site is the same place contributes its plans and facts.
    const siblings = (await db.query(`SELECT url, facts, location FROM floor_plan.listing
        WHERE location_status IN ('located','probable') AND location->'candidates'->0 IS NOT NULL`)).rows
        .filter(row => siteKey(row.location.candidates[0]) === key);
    const footprint = await siteFootprint(referencesDb, top);
    const permitHeights = (top.permits || []).map(p => p.height).filter(Boolean);
    const storeySources = [...permitHeights.map(text => ({ kind: 'permit', text })),
        ...siblings.map(row => row.location?.signals?.floors).filter(Boolean).map(text => ({ kind: 'listing', text }))];
    const plans = await sitePlans(db, siblings.map(s => s.url));
    // The highest posted floor is a lower bound on the storey count when nothing else states it.
    const topFloor = Math.max(...plans.map(row => row.model.floor).filter(Number.isInteger));
    if (Number.isFinite(topFloor) && topFloor > 0) storeySources.push({ kind: 'plans-lower-bound', text: `P+${topFloor}` });
    const sheets = await sheetContexts(db, plans.map(row => row.sha256).filter(Boolean));
    for (const sheet of sheets.values()) {
        const formula = storeysFromSheet(sheet);
        if (formula) storeySources.unshift({ kind: `sheet-${sheet.kind}`, text: formula });
    }
    const elevations = [...plans.map(row => ({ level: row.model.floor, elevationM: row.model.elevationM })),
        ...[...sheets.values()].flatMap(sheet => sheet.elevations || [])];
    const envelope = buildEnvelope({ footprint: footprint?.geometry || null, footprintSource: footprint?.source || null,
        // An existing building's surveyed height informs the storeys whatever the footprint's source.
        storeySources, surveyHeightM: footprint?.surveyHeightM ?? await surveyHeight(referencesDb, top), elevations });
    let placements = [];
    if (footprint) {
        const outer = largestRing(footprint.geometry), origin = outer[0];
        const target = toLocalMetres(outer.slice(0, -1), origin);
        for (const row of plans) {
            if (!hasUsableGeometry(row.model)) continue;
            const outline = planOutline(row.model);
            const sheet = sheets.get(row.sha256);
            const sheetNorth = typeof sheet?.orientation?.northDeg === 'number' ? sheet.orientation.northDeg : null;
            const rotation = northRotationDeg(row.model) ?? sheetNorth
                ?? (sheet?.orientation?.streets?.length ? await rotationFromStreets(referencesDb, footprint.geometry, sheet.orientation.streets) : null);
            const positionPrior = sheet?.keyPlan?.unitCenter ? { center: sheet.keyPlan.unitCenter, weight: 0.2 } : null;
            // Plan geometry is stored in metres (dimensionsM), so its own scale is the prior; reviewed
            // unit models carry a unitId but no scope field.
            const scope = row.model.scope || (row.model.unitId ? 'unit' : 'floor');
            // Measured scales hold within a few percent; estimated ones are only a starting point.
            const basis = row.model.source?.scaleBasis;
            const scalePrior = basis === 'unknown' ? null
                : row.model.source?.scaleEstimated ? { mPerUnit: 1, tolerance: 0.24, weight: 0.3 } : { mPerUnit: 1, tolerance: 0.03, weight: 1.5 };
            const fit = outline ? fitPlan({ plan: outline, target, scope, scalePrior, positionPrior,
                rotationPrior: rotation === null ? null : { deg: rotation } }) : { status: 'unplaced', reason: 'no-outline', placements: [] };
            const best = fit.placements?.[0];
            placements.push({ planId: row.id, kind: row.kind, sourceSha256: row.sha256, listingUrl: row.listing_url, unitId: row.model.unitId, scope, floor: row.model.floor,
                status: fit.status, reason: fit.reason || null, margin: fit.margin ?? null, alternatives: (fit.placements || []).length,
                priors: { rotationDeg: rotation, rotationBasis: northRotationDeg(row.model) !== null || sheetNorth !== null ? 'north-arrow' : rotation !== null ? 'street-labels' : null,
                    keyPlan: positionPrior?.center || null, scaleBasis: basis || (row.kind === 'reviewed' ? 'reviewed' : null) },
                best: best ? { ...best, outline: closeRing(toLngLat(transformRing(outline, best), origin)) } : null });
        }
    }
    const point = top.addressPoints?.[0];
    const label = point ? `${point.street} ${point.number}` : top.permits?.find(p => p.streets?.length)?.streets[0] || key;
    return { schema: 'site-model.v1', siteKey: key, label, listingUrl, siblings: siblings.map(s => s.url), location: { status: listing.location_status, score: top.score,
        reasons: top.reasons }, footprint: footprint ? { source: footprint.source, areaM2: Math.round(footprint.areaM2), caseId: footprint.caseId || null,
        caseKind: footprint.caseKind || null } : null, envelope, placements,
        inventory: projectInventory(siblings, plans),
        sources: projectSources(siblings),
        parcels: (top.parcels || []).map(p => ({ ko: p.ko, kc: p.kc })) };
}

// Build and store one model per located site (grouped by site key). Idempotent: an unchanged model
// keeps its row; a changed one replaces it. Sites whose postings carry no plans are still stored,
// because their envelope and location are reviewable on their own. A pass over every site also
// removes the models of sites no longer located (the table is derived, so nothing is lost).
function validateListingUrls(urls) {
    if (urls === undefined) return;
    if (!Array.isArray(urls) || urls.length === 0 || urls.some(value => {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return true;
        try {
            const url = new URL(value);
            return !['http:', 'https:'].includes(url.protocol) || !url.hostname;
        } catch { return true; }
    })) throw new Error('Site-model listing URLs must be a non-empty array of absolute HTTP(S) URLs.');
}

export async function buildSiteModels(db, { limit = 500, log = console.log, build = siteModel, deadline = Infinity,
    urls = undefined, referencesDb = db } = {}) {
    validateListingUrls(urls);
    const rows = (await db.query(`SELECT url, location FROM floor_plan.listing
        WHERE location_status IN ('located','probable') AND location->'candidates'->0 IS NOT NULL
          AND ($1::text[] IS NULL OR url = ANY($1::text[])) ORDER BY url`, [urls])).rows;
    const bySite = new Map();
    for (const row of rows) {
        const key = siteKey(row.location.candidates[0]);
        if (key && !bySite.has(key)) bySite.set(key, row.url);
    }
    const result = { sites: bySite.size, built: 0, changed: 0, failed: 0, retired: 0, deferred: 0 };
    let index = 0;
    for (const [key, url] of [...bySite].slice(0, limit)) {
        if (Date.now() >= deadline) break;
        index++;
        try {
            const model = await build(db, url, { referencesDb });
            const hash = fingerprint(model);
            const saved = await db.query(`INSERT INTO floor_plan.site_model(site_key, listing_urls, model, model_hash) VALUES($1,$2,$3,$4)
                ON CONFLICT(site_key) DO UPDATE SET listing_urls=excluded.listing_urls, model=excluded.model, model_hash=excluded.model_hash,
                    built_at=now(), updated_at=now() WHERE floor_plan.site_model.model_hash IS DISTINCT FROM excluded.model_hash`,
            [key, JSON.stringify(model.siblings), JSON.stringify(model), hash]);
            result.built++;
            result.changed += saved.rowCount || 0;
        } catch (error) {
            result.failed++;
            log(JSON.stringify({ at: new Date().toISOString(), stage: 'site-models', site: key, error: error.message }));
        }
        if (index % 25 === 0) log(JSON.stringify({ at: new Date().toISOString(), stage: 'site-models', progress: `${index}/${Math.min(limit, bySite.size)}`, ...result }));
    }
    // A truncated pass cannot tell an unvisited site from a retired one.
    result.deferred = bySite.size - result.built - result.failed;
    if (urls === undefined && !result.deferred && !result.failed) {
        // This builder owns listing-derived sites. Registered archival floor models have their
        // own source registry and do not become retired when absent from the listing crawl.
        const retired = await db.query(`DELETE FROM floor_plan.site_model
            WHERE split_part(site_key, ':', 1) = ANY($2::text[])
              AND NOT (site_key = ANY($1::text[]))`, [[...bySite.keys()], ['permit', 'address', 'parcels']]);
        result.retired = retired.rowCount || 0;
    }
    result.status = result.failed || result.deferred ? 'partial' : 'complete';
    return result;
}
