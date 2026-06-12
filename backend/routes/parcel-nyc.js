import { buildOwnershipSummary, pickOwnershipFields } from './parcels.js';
import { fetchNycOwners, isPlaceholderOwner, isCondoBillingLot } from './nyc-condo-owners.js';

const MAX_LIMIT = 5000;
const SRID_WGS84 = 4326;
const CITY_NAME = 'New York';
const PARCEL_ID_PREFIX = 'US-NY';
const GEOM_TABLE = 'parcel_nyc_geom';
const UNIT_TABLE = 'parcel_nyc_unit';
const GEOMETRY_TABLE_ALIAS = 'g';
const UNIT_TABLE_ALIAS = 'u';

const ALLOWED_GEOMETRY_COLUMNS = new Set(['geom', 'geometry']);
const GEOMETRY_COLUMN = (() => {
    const raw = (process.env.PARCEL_NYC_GEOMETRY_COLUMN || '').toString().trim().toLowerCase();
    return ALLOWED_GEOMETRY_COLUMNS.has(raw) ? raw : 'geom';
})();
const GEOMETRY_REF = `${GEOMETRY_TABLE_ALIAS}.${GEOMETRY_COLUMN}`;

function parseLimit(rawValue) {
    if (!rawValue) {
        return null;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(rawValue) {
    if (!rawValue) {
        return null;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }

    return parsed;
}

function parseBbox(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
        return null;
    }
    const parts = rawValue.split(',').map(Number);
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) {
        return null;
    }
    const [minLon, minLat, maxLon, maxLat] = parts;
    if (minLon >= maxLon || minLat >= maxLat) {
        return null;
    }
    return { minLon, minLat, maxLon, maxLat };
}

function normalizeOwnerKey(value) {
    return (value || '')
        .toString()
        .trim()
        .replace(/\s+/g, ' ')
        .toUpperCase();
}

function splitOwners(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw
            .map(value => (value || '').toString().trim())
            .filter(Boolean);
    }
    if (typeof raw !== 'string') return [];
    const trimmed = raw.trim();
    return trimmed ? [trimmed] : [];
}

function aggregateOwners(ownerPrimary, ownerSecondary) {
    const owners = [...splitOwners(ownerPrimary), ...splitOwners(ownerSecondary)];
    if (!owners.length) {
        return [];
    }

    const seen = new Set();
    const unique = [];
    owners.forEach(owner => {
        const normalized = normalizeOwnerKey(owner);
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        unique.push(owner);
    });
    return unique;
}

function buildParcelId(rawParcel) {
    const parcel = (rawParcel ?? '').toString().trim();
    if (!parcel) return null;
    if (parcel.toUpperCase().startsWith(`${PARCEL_ID_PREFIX}-`)) {
        return parcel;
    }
    return `${PARCEL_ID_PREFIX}-${parcel}`;
}

function normalizeParcelValue(rawParcelId) {
    const value = (rawParcelId ?? '').toString().trim();
    if (!value) return '';
    return value.replace(new RegExp(`^(${PARCEL_ID_PREFIX}-)+`, 'i'), '');
}

function isValidParcelValue(parcelValue) {
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parcelValue);
}

function buildPossessorsFromOwners(owners) {
    const normalizedOwners = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (!normalizedOwners.length) {
        return [{
            name: 'Unknown owner',
            ownership: '1/1',
            address: ''
        }];
    }

    const shareText = `1/${normalizedOwners.length}`;
    return normalizedOwners.map(name => ({
        name,
        ownership: shareText,
        address: ''
    }));
}

function buildOwnershipPayload(parcelValue, owners) {
    const parcelId = buildParcelId(parcelValue);
    const possessors = buildPossessorsFromOwners(owners);
    return {
        parcelId,
        parcelNumber: parcelValue ?? null,
        cadMunicipalityName: CITY_NAME,
        possessionSheets: [{
            possessionSheetId: null,
            possessionSheetNumber: null,
            cadMunicipalityName: CITY_NAME,
            possessors
        }]
    };
}

function buildOwnershipSummaryFromOwners(parcelValue, owners) {
    const payload = buildOwnershipPayload(parcelValue, owners);
    const summary = buildOwnershipSummary(payload);
    return { payload, summary };
}

function extractParcelIds(row) {
    if (Array.isArray(row?.swis_sbl_ids)) {
        return row.swis_sbl_ids.map(value => (value || '').toString().trim()).filter(Boolean);
    }
    const fallback = (row?.swis_sbl_id || '').toString().trim();
    return fallback ? [fallback] : [];
}

function buildFeature(row) {
    const parcelIds = extractParcelIds(row);
    const parcelValue = row.swis_sbl_id || parcelIds[0] || null;
    const owners = aggregateOwners(row.primary_owner, null)
        .filter(name => !isPlaceholderOwner(name));
    const { summary } = buildOwnershipSummaryFromOwners(parcelValue, owners);
    const parcelId = buildParcelId(parcelValue);
    const calculatedArea = Number.isFinite(Number(row.shape_area)) ? Number(row.shape_area) : undefined;
    const estimatedMarketPrice = Number.isFinite(calculatedArea) ? calculatedArea * 100 : undefined;

    const properties = {
        parcelId,
        parcel: parcelValue,
        parcel_id: parcelValue,
        parcelIds: parcelIds.length > 0 ? parcelIds : undefined,
        calculatedArea,
        estimatedMarketPrice,
        estimatedMarketPriceCurrency: estimatedMarketPrice ? 'USD' : undefined
    };

    if (summary) {
        properties.ownershipType = summary.ownershipType;
        // A condo billing lot's only recorded "owner" is the condominium association,
        // not the individual unit owners. Omit the owner list here so the parcel panel
        // resolves the real unit owners on demand via /parcel-nyc/:id/ownership instead
        // of trusting this single-entity stub from the bulk load. ownershipType is kept
        // so map colouring still works without a per-parcel lookup.
        if (!isCondoBillingLot(parcelValue)) {
            properties.ownershipList = summary.ownershipList;
        }
    }

    return {
        type: 'Feature',
        properties,
        geometry: row.geom
    };
}

export function setupParcelNycRoute(app, pool) {
    app.get('/parcel-nyc', async (req, res) => {
        const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
        const parcelIdParam = typeof req.query.parcel_id === 'string' ? req.query.parcel_id.trim() :
            (typeof req.query.parcelId === 'string' ? req.query.parcelId.trim() :
                (typeof req.query.parcel === 'string' ? req.query.parcel.trim() : ''));
        const parcelValue = normalizeParcelValue(parcelIdParam);
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const bbox = parseBbox(bboxRaw);

        if (bboxRaw && !bbox) {
            return res.status(400).json({
                error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.'
            });
        }

        if (parcelIdParam && !isValidParcelValue(parcelValue)) {
            return res.status(400).json({
                error: 'Invalid parcel_id format. Expected US-NY-<parcel_id> or <parcel_id>.'
            });
        }

        const hasParcel = Boolean(parcelValue);
        const hasBbox = Boolean(bbox);

        if (!hasParcel && !hasBbox) {
            return res.status(400).json({
                error: 'Provide bbox or parcel_id to query New York parcels.'
            });
        }

        let sql = `
            SELECT
                g.geom_id,
                g.shape_length,
                g.shape_area,
                ST_AsGeoJSON(${GEOMETRY_REF})::json AS geom,
                array_remove(array_agg(DISTINCT u.swis_sbl_id), NULL) AS swis_sbl_ids,
                array_remove(array_agg(DISTINCT u.primary_owner), NULL) AS primary_owner
            FROM ${GEOM_TABLE} ${GEOMETRY_TABLE_ALIAS}
            LEFT JOIN ${UNIT_TABLE} ${UNIT_TABLE_ALIAS}
              ON ${UNIT_TABLE_ALIAS}.geom_id = ${GEOMETRY_TABLE_ALIAS}.geom_id
        `;
        const params = [];
        const whereClauses = [];
        let queryType = hasBbox ? 'bbox' : 'parcel';

        if (hasParcel) {
            params.push(parcelValue);
            whereClauses.push(`(${UNIT_TABLE_ALIAS}.swis_sbl_id = $${params.length} OR ${UNIT_TABLE_ALIAS}.swis_print_key_id = $${params.length})`);
            queryType = 'parcel';
        }

        if (hasBbox) {
            params.push(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
            const envelopeExpr = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, ${SRID_WGS84})`;
            whereClauses.push(`${GEOMETRY_REF} && ${envelopeExpr}`);
            whereClauses.push(`ST_Intersects(${GEOMETRY_REF}, ${envelopeExpr})`);
            if (!hasParcel) {
                queryType = 'bbox';
            }
        }

        if (whereClauses.length > 0) {
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        sql += ` GROUP BY ${GEOMETRY_TABLE_ALIAS}.geom_id, g.shape_length, g.shape_area, ${GEOMETRY_REF}`;

        if (queryType !== 'parcel') {
            sql += ` ORDER BY (SELECT MIN(u2.swis_sbl_id) FROM ${UNIT_TABLE} u2 WHERE u2.geom_id = g.geom_id)`;
        }

        if (limit && queryType !== 'parcel') {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
        }

        if (offset && queryType !== 'parcel') {
            params.push(offset);
            sql += ` OFFSET $${params.length}`;
        }

        try {
            const { rows } = await pool.query(sql, params);
            const features = rows.map(buildFeature);
            res.json({
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    parcel_id: parcelIdParam || undefined,
                    parcel: parcelValue || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined,
                    offset: offset || undefined
                },
                features
            });
        } catch (error) {
            console.error('Error in /parcel-nyc:', error);
            res.status(500).json({ error: 'Failed to fetch New York parcels.' });
        }
    });

    app.get('/parcel-nyc/:parcelId/ownership', async (req, res) => {
        const parcelId = normalizeParcelValue((req.params.parcelId || '').trim());
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required.' });
        }

        if (!isValidParcelValue(parcelId)) {
            return res.status(400).json({
                error: 'Invalid parcelId format. Expected US-NY-<parcel_id> or <parcel_id>.'
            });
        }

        const sql = `
            SELECT
                u.swis_sbl_id,
                MIN(u.sbl) AS sbl,
                array_remove(array_agg(DISTINCT u.primary_owner), NULL) AS primary_owner
            FROM ${UNIT_TABLE} u
            WHERE u.swis_sbl_id = $1 OR u.swis_print_key_id = $1
            GROUP BY u.swis_sbl_id
            LIMIT 1
        `;

        try {
            const { rows } = await pool.query(sql, [parcelId]);
            if (!rows.length) {
                return res.status(404).json({ error: 'Ownership data not found for the requested parcelId.' });
            }

            const row = rows[0];
            // Drop the "UNAVAILABLE OWNER" placeholder the NY State source carries for
            // condos/commercial lots. Resolve real owners on demand from NYC DOF when
            // either nothing usable is left, or this is a condo billing lot (whose
            // recorded "owner" is just the condominium association, not the individual
            // unit owners we want to list).
            let owners = aggregateOwners(row.primary_owner, null)
                .filter(name => !isPlaceholderOwner(name));
            if (row.sbl && (!owners.length || isCondoBillingLot(row.sbl))) {
                try {
                    const resolved = await fetchNycOwners(row.sbl);
                    if (resolved.owners.length) {
                        owners = resolved.owners;
                    }
                } catch (lookupError) {
                    console.error(`NYC DOF owner lookup failed for ${row.sbl}:`, lookupError.message);
                }
            }
            const { payload, summary } = buildOwnershipSummaryFromOwners(row.swis_sbl_id, owners);
            const normalized = pickOwnershipFields(payload, buildParcelId(row.swis_sbl_id));
            if (summary) {
                normalized.ownershipList = summary.ownershipList;
                normalized.ownershipType = summary.ownershipType;
            }

            res.json(normalized);
        } catch (error) {
            console.error(`Error in /parcel-nyc/${parcelId}/ownership:`, error);
            res.status(500).json({ error: 'Failed to fetch New York ownership data.' });
        }
    });
}