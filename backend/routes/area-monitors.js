// Area Monitor API endpoints
// POST /area-monitors - Create a new area monitor
// GET /area-monitors - List area monitors
// GET /area-monitors/:id - Get an area monitor with ownership breakdown
// HEAD /area-monitors/:id - Check area monitor existence

import { POSTGIS_SRID } from '../utils/helpers.js';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';
import {
    buildOwnershipDetailBatchQuery,
    buildOwnershipType
} from './parcels.js';

const MAX_PARCELS = 400;
const MAX_NAME_LENGTH = 100;
const MIN_NAME_LENGTH = 3;
const MAX_MONITORS_PER_IP = 20;
const MAX_URL_LENGTH = 2048;
const MAX_FINGERPRINT_LENGTH = 64;

// Lightweight in-memory rate limiter (no external dependency)
function createRateLimiter({ windowMs, max, message }) {
    const hits = new Map();
    // Periodic cleanup to prevent memory leak
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (now - entry.start > windowMs) hits.delete(key);
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const key = req.ip || req.connection?.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || now - entry.start > windowMs) {
            entry = { start: now, count: 0 };
            hits.set(key, entry);
        }
        entry.count++;
        if (entry.count > max) {
            return res.status(429).json(message);
        }
        next();
    };
}

function validateGeoJSONPolygon(polygon) {
    if (!isPlainObject(polygon)) return false;
    if (polygon.type !== 'Polygon') return false;
    if (!Array.isArray(polygon.coordinates) || polygon.coordinates.length !== 1) return false;
    const ring = polygon.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return false;
    for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2) return false;
        const [lng, lat] = point;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
    }
    // First and last coordinate must match (closed ring)
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last)) return false;
    if (first[0] !== last[0] || first[1] !== last[1]) return false;
    return true;
}

function normalizeParcelId(parcelId) {
    const parsed = parseParcelId(parcelId);
    if (!parsed) return null;
    return `HR-${parsed.maticniBrojKo}-${parsed.brojCestice}`;
}

const areaMonitorCreateBodyValidator = createJsonBodyValidator({
    schema: {
        name: {
            required: true,
            validate: validators.string({
                minLength: MIN_NAME_LENGTH,
                maxLength: MAX_NAME_LENGTH,
                label: 'name',
                disallowControlChars: true,
                controlCharsMessage: 'Name contains invalid control characters.',
                minLengthMessage: `Name must be at least ${MIN_NAME_LENGTH} characters.`,
                maxLengthMessage: `Name must be at most ${MAX_NAME_LENGTH} characters.`
            })
        },
        polygon: {
            required: true,
            validate: validators.custom((value) => {
                if (!validateGeoJSONPolygon(value)) {
                    return validators.fail('Invalid polygon. Expected a valid GeoJSON Polygon with a closed ring.');
                }
                return validators.ok(value);
            })
        },
        parcelIds: {
            required: true,
            missingMessage: 'parcelIds must be a non-empty array.',
            validate: validators.arrayOf(
                validators.custom((value) => {
                    if (typeof value !== 'string' || value.trim().length === 0) {
                        return validators.fail('All parcelIds must be non-empty strings.');
                    }
                    const normalized = normalizeParcelId(value);
                    if (!normalized) {
                        return validators.fail('All parcelIds must use HR-<maticni_broj_ko>-<broj_cestice> format.');
                    }
                    return validators.ok(normalized);
                }),
                {
                    minItems: 1,
                    maxItems: MAX_PARCELS,
                    minItemsMessage: 'parcelIds must be a non-empty array.',
                    maxItemsMessage: `Maximum ${MAX_PARCELS} parcels per area monitor.`,
                    unique: true,
                    uniqueMessage: 'parcelIds must not contain duplicates.'
                }
            )
        },
        eojnUrl: {
            required: false,
            validate: validators.optional(validators.httpUrl({ maxLength: MAX_URL_LENGTH, label: 'eojnUrl' }))
        },
        skyscraperCityUrl: {
            required: false,
            validate: validators.optional(validators.httpUrl({ maxLength: MAX_URL_LENGTH, label: 'skyscraperCityUrl' }))
        },
        fingerprint: {
            required: false,
            validate: validators.optional(validators.string({
                maxLength: MAX_FINGERPRINT_LENGTH,
                label: 'fingerprint',
                pattern: /^[A-Za-z0-9:_-]+$/,
                patternMessage: 'fingerprint contains invalid characters.'
            }))
        }
    }
});

function parseParcelId(parcelId) {
    if (!parcelId || typeof parcelId !== 'string') return null;

    let normalized = parcelId.trim();
    // Remove HR- prefixes
    normalized = normalized.replace(/^(HR-)+/i, '');

    // Parse <maticni_broj_ko>-<broj_cestice> format
    const dashIdx = normalized.indexOf('-');
    if (dashIdx > 0) {
        const cadMunRaw = normalized.slice(0, dashIdx).trim();
        const parcelNumber = normalized.slice(dashIdx + 1).trim();
        const cadMun = Number(cadMunRaw);
        if (Number.isFinite(cadMun) && parcelNumber) {
            return { maticniBrojKo: cadMun, brojCestice: parcelNumber };
        }
    }

    return null;
}

function buildOverlayGeometryQuery() {
    return `
        WITH monitor_geom AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), ${POSTGIS_SRID}) AS geom
        ),
        clipped AS (
            SELECT
                'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
                ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Intersection(p.geom, mg.geom)), 3)) AS clipped_geom
            FROM parcel p
            CROSS JOIN monitor_geom mg
            WHERE p.current = true
              AND p.geom && mg.geom
              AND ST_Intersects(p.geom, mg.geom)
        )
        SELECT
            parcel_id,
            ST_AsGeoJSON(ST_Transform(clipped_geom, 4326))::json AS geometry
        FROM clipped
        WHERE clipped_geom IS NOT NULL
          AND NOT ST_IsEmpty(clipped_geom)
    `;
}

async function fetchBatchOwnership(pool, parcelIds) {
    const parsed = parcelIds.map(id => ({ id, ...parseParcelId(id) })).filter(p => p.maticniBrojKo != null);
    if (!parsed.length) {
        return [];
    }

    const maticniArray = parsed.map(p => p.maticniBrojKo);
    const brojArray = parsed.map(p => p.brojCestice);

    // Build a lookup map from parcel key back to original ID
    const keyToId = new Map();
    parsed.forEach(p => {
        keyToId.set(`${p.maticniBrojKo}-${p.brojCestice}`, p.id);
    });

    let rows = null;
    try {
        const result = await pool.query(buildOwnershipDetailBatchQuery(), [maticniArray, brojArray]);
        rows = result.rows;
    } catch (error) {
        if (error?.code !== '42P01') throw error;
    }

    if (!rows) {
        return [];
    }

    return rows.map(row => {
        const key = `${row.maticni_broj_ko}-${row.broj_cestice}`;
        const parcelId = keyToId.get(key) || `HR-${key}`;
        let payload = row.details;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        const ownershipType = payload ? buildOwnershipType(payload) : null;
        return {
            parcelId,
            ownershipType: ownershipType || null
        };
    });
}

export function setupAreaMonitorsRoute(app, pool) {

    const createLimiter = createRateLimiter({
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 5,
        message: { error: 'Too many area monitors created. Try again later.' }
    });

    const readLimiter = createRateLimiter({
        windowMs: 60 * 1000, // 1 minute
        max: 100,
        message: { error: 'Too many requests. Try again later.' }
    });

    // POST /area-monitors
    app.post('/area-monitors', createLimiter, areaMonitorCreateBodyValidator, async (req, res) => {
        try {
            const {
                name,
                polygon,
                parcelIds,
                eojnUrl,
                skyscraperCityUrl,
                fingerprint
            } = req.validatedBody;

            // Resolve creator IP (trust proxy is configured in index.js)
            const creatorIp = req.ip || req.connection?.remoteAddress || null;

            // Rate limit: max monitors per IP
            if (creatorIp) {
                const { rows: countRows } = await pool.query(
                    'SELECT COUNT(*)::int AS cnt FROM area_monitor WHERE creator_ip = $1',
                    [creatorIp]
                );
                if (countRows[0]?.cnt >= MAX_MONITORS_PER_IP) {
                    return res.status(429).json({ error: `Maximum ${MAX_MONITORS_PER_IP} area monitors per IP address.` });
                }
            }

            const insertSql = `
                INSERT INTO area_monitor (name, polygon, parcel_ids, parcel_count, eojn_url, skyscrapercity_url, creator_ip, creator_fingerprint)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, name, created_at
            `;
            const { rows } = await pool.query(insertSql, [
                name,
                JSON.stringify(polygon),
                JSON.stringify(parcelIds),
                parcelIds.length,
                eojnUrl,
                skyscraperCityUrl,
                creatorIp,
                fingerprint
            ]);

            const created = rows[0];
            res.status(201).json({
                id: created.id,
                name: created.name,
                createdAt: created.created_at
            });
        } catch (error) {
            console.error('Error creating area monitor:', error);
            res.status(500).json({ error: 'Failed to create area monitor.' });
        }
    });

    // GET /area-monitors
    app.get('/area-monitors', readLimiter, async (req, res) => {
        try {
            const { rows } = await pool.query(`
                SELECT id, name, parcel_count, created_at, updated_at
                FROM area_monitor
                ORDER BY updated_at DESC, id DESC
            `);

            res.json({
                monitors: rows.map(row => ({
                    id: row.id,
                    name: row.name,
                    parcelCount: row.parcel_count,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at
                }))
            });
        } catch (error) {
            console.error('Error listing area monitors:', error);
            res.status(500).json({ error: 'Failed to list area monitors.' });
        }
    });

    // HEAD /area-monitors/:id
    app.head('/area-monitors/:id', readLimiter, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).end();
            }

            const { rows } = await pool.query(
                'SELECT id, updated_at FROM area_monitor WHERE id = $1',
                [id]
            );

            if (!rows.length) {
                return res.status(404).end();
            }

            res.set('Last-Modified', new Date(rows[0].updated_at).toUTCString());
            res.status(200).end();
        } catch (error) {
            console.error('Error in HEAD /area-monitors/:id:', error);
            res.status(500).end();
        }
    });

    // GET /area-monitors/:id/overlay
    app.get('/area-monitors/:id/overlay', readLimiter, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Invalid area monitor ID.' });
            }

            const { rows } = await pool.query(
                'SELECT id, polygon FROM area_monitor WHERE id = $1',
                [id]
            );

            if (!rows.length) {
                return res.status(404).json({ error: 'Area monitor not found.' });
            }

            const monitor = rows[0];
            if (!validateGeoJSONPolygon(monitor.polygon)) {
                return res.status(500).json({ error: 'Stored monitor polygon is invalid.' });
            }

            const overlayResult = await pool.query(buildOverlayGeometryQuery(), [JSON.stringify(monitor.polygon)]);

            const features = overlayResult.rows
                .filter(row => row.geometry)
                .map(row => ({
                    type: 'Feature',
                    geometry: row.geometry,
                    properties: {
                        parcelId: row.parcel_id
                    }
                }));

            return res.json({
                type: 'FeatureCollection',
                features
            });
        } catch (error) {
            console.error('Error fetching area monitor overlay:', error);
            return res.status(500).json({ error: 'Failed to fetch area monitor overlay.' });
        }
    });

    // GET /area-monitors/:id
    app.get('/area-monitors/:id', readLimiter, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Invalid area monitor ID.' });
            }

            const { rows } = await pool.query(
                'SELECT * FROM area_monitor WHERE id = $1',
                [id]
            );

            if (!rows.length) {
                return res.status(404).json({ error: 'Area monitor not found.' });
            }

            const monitor = rows[0];
            const parcelIds = monitor.parcel_ids || [];

            // Fetch ownership for all parcels in a single batch query
            let parcels = [];
            try {
                parcels = await fetchBatchOwnership(pool, parcelIds);
            } catch (ownershipError) {
                console.warn(`Failed to fetch batch ownership for monitor ${id}:`, ownershipError);
                // Return monitor without ownership data rather than failing entirely
                parcels = parcelIds.map(parcelId => ({ parcelId, ownershipType: null }));
            }

            // Build a map for quick lookup
            const ownershipMap = new Map(parcels.map(p => [p.parcelId, p]));

            // Ensure all parcel IDs are represented (some may not have ownership data)
            const allParcels = parcelIds.map(parcelId => {
                const found = ownershipMap.get(parcelId);
                return found || { parcelId, ownershipType: null };
            });

            const governmentCount = allParcels.filter(p => p.ownershipType === 'government').length;

            const responseBody = {
                monitor: {
                    id: monitor.id,
                    name: monitor.name,
                    polygon: monitor.polygon,
                    parcelIds: parcelIds,
                    parcelCount: monitor.parcel_count,
                    eojnUrl: monitor.eojn_url,
                    skyscraperCityUrl: monitor.skyscrapercity_url,
                    createdAt: monitor.created_at,
                    updatedAt: monitor.updated_at
                },
                parcels: allParcels,
                summary: {
                    total: parcelIds.length,
                    governmentOwned: governmentCount,
                    remaining: parcelIds.length - governmentCount
                }
            };

            res.json(responseBody);
        } catch (error) {
            console.error('Error fetching area monitor:', error);
            res.status(500).json({ error: 'Failed to fetch area monitor.' });
        }
    });
}
