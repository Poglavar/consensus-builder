import { buildOwnershipSummary, pickOwnershipFields } from './parcels.js';

const MAX_LIMIT = 5000;
const SRID_WGS84 = 4326;
const CITY_NAME = 'Colorado';
const PARCEL_ID_PREFIX = 'US-CO';
const GEOM_TABLE = 'parcel_co_geom';
const UNIT_TABLE = 'parcel_co_unit';
const GEOMETRY_TABLE_ALIAS = 'g';
const UNIT_TABLE_ALIAS = 'u';

const ALLOWED_GEOMETRY_COLUMNS = new Set(['geom', 'geometry']);
const GEOMETRY_COLUMN = (() => {
    const raw = (process.env.PARCEL_CO_GEOMETRY_COLUMN || '').toString().trim().toLowerCase();
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
    if (Array.isArray(row?.parcel_ids)) {
        return row.parcel_ids.map(value => (value || '').toString().trim()).filter(Boolean);
    }
    const fallback = (row?.parcel_id || '').toString().trim();
    return fallback ? [fallback] : [];
}

function buildFeature(row) {
    const parcelIds = extractParcelIds(row);
    const parcelValue = row.parcel_id || parcelIds[0] || null;
    const owners = aggregateOwners(row.owner_primary, row.owner_secondary);
    const { summary } = buildOwnershipSummaryFromOwners(parcelValue, owners);
    const parcelId = buildParcelId(parcelValue);
    const calculatedArea = Number.isFinite(Number(row.calculated_area)) ? Number(row.calculated_area) : undefined;
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
        properties.ownershipList = summary.ownershipList;
        properties.ownershipType = summary.ownershipType;
    }

    return {
        type: 'Feature',
        properties,
        geometry: row.geometry
    };
}

export function setupParcelCoRoute(app, pool) {
    app.get('/parcel-co', async (req, res) => {
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

        const hasParcel = Boolean(parcelValue);
        const hasBbox = Boolean(bbox);

        if (!hasParcel && !hasBbox) {
            return res.status(400).json({
                error: 'Provide bbox or parcel_id to query Colorado parcels.'
            });
        }

        let sql = `
            SELECT
                MIN(${UNIT_TABLE_ALIAS}.parcel_id) AS parcel_id,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.parcel_id), NULL) AS parcel_ids,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.owner_primary), NULL) AS owner_primary,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.owner_secondary), NULL) AS owner_secondary,
                ST_AsGeoJSON(${GEOMETRY_REF})::json AS geometry,
                ST_Area(${GEOMETRY_REF}::geography) AS calculated_area
            FROM ${GEOM_TABLE} ${GEOMETRY_TABLE_ALIAS}
            LEFT JOIN ${UNIT_TABLE} ${UNIT_TABLE_ALIAS}
              ON ${UNIT_TABLE_ALIAS}.geom_id = ${GEOMETRY_TABLE_ALIAS}.geom_id
        `;
        const params = [];
        const whereClauses = [];
        let queryType = hasBbox ? 'bbox' : 'parcel';

        if (hasParcel) {
            params.push(parcelValue);
            whereClauses.push(`${GEOMETRY_TABLE_ALIAS}.geom_id IN (SELECT geom_id FROM ${UNIT_TABLE} WHERE parcel_id = $${params.length})`);
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

        sql += ` GROUP BY ${GEOMETRY_TABLE_ALIAS}.geom_id, ${GEOMETRY_REF}`;

        if (queryType !== 'parcel') {
            sql += ' ORDER BY parcel_id';
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
            if (!rows.length) {
                return res.status(404).json({ error: 'No parcels found for the provided filters.' });
            }

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
            console.error('Error in /parcel-co:', error);
            res.status(500).json({ error: 'Failed to fetch Colorado parcels.' });
        }
    });

    app.get('/parcel-co/:parcelId/ownership', async (req, res) => {
        const parcelId = normalizeParcelValue((req.params.parcelId || '').trim());
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required.' });
        }

        if (!isValidParcelValue(parcelId)) {
            return res.status(400).json({
                error: 'Invalid parcelId format. Expected US-CO-<parcel_id> or <parcel_id>.'
            });
        }

        const sql = `
            SELECT
                MIN(${UNIT_TABLE_ALIAS}.parcel_id) AS parcel_id,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.parcel_id), NULL) AS parcel_ids,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.owner_primary), NULL) AS owner_primary,
                array_remove(array_agg(DISTINCT ${UNIT_TABLE_ALIAS}.owner_secondary), NULL) AS owner_secondary
            FROM ${UNIT_TABLE} ${UNIT_TABLE_ALIAS}
            WHERE ${UNIT_TABLE_ALIAS}.geom_id IN (
                SELECT geom_id
                FROM ${UNIT_TABLE}
                WHERE parcel_id = $1
            )
            GROUP BY ${UNIT_TABLE_ALIAS}.geom_id
            LIMIT 1
        `;

        try {
            const { rows } = await pool.query(sql, [parcelId]);
            if (!rows.length) {
                return res.status(404).json({ error: 'Ownership data not found for the requested parcelId.' });
            }

            const row = rows[0];
            const owners = aggregateOwners(row.owner_primary, row.owner_secondary);
            const { payload, summary } = buildOwnershipSummaryFromOwners(row.parcel_id, owners);
            const normalized = pickOwnershipFields(payload, buildParcelId(row.parcel_id));
            if (summary) {
                normalized.ownershipList = summary.ownershipList;
                normalized.ownershipType = summary.ownershipType;
            }

            res.json(normalized);
        } catch (error) {
            console.error(`Error in /parcel-co/${parcelId}/ownership:`, error);
            res.status(500).json({ error: 'Failed to fetch Colorado ownership data.' });
        }
    });
}
