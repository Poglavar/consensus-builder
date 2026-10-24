import { databaseSourceError, isDatabaseSourceError } from './database-source-error.js';
import { MAX_CELL_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';

const MAX_LIMIT = 5000;

const SRID_WGS84 = 4326;
const SRID_DATASET = 3765; // EPSG:3765 - same as Zagreb (HTRS96/TM)
const COUNTRY_PREFIX = 'SI';

function isValidParcelValue(value) {
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

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

function buildFeature(row, ownershipData = null) {
    // parcelId is SI-<eid_parcela>
    const parcelId = row.eid_parcela ? `${COUNTRY_PREFIX}-${row.eid_parcela}` : null;
    const rawArea = row.calculated_area ?? row.povrsina;
    const numericArea = Number(rawArea);
    const calculatedArea = Number.isFinite(numericArea) ? numericArea : undefined;
    const estimatedMarketPrice = Number.isFinite(numericArea) ? numericArea * 100 : undefined;

    const properties = {
        parcelId: parcelId,
        eidParcela: row.eid_parcela,
        parcelaId: row.parcela_id,
        koId: row.ko_id,
        naziv: row.naziv,
        stParcele: row.st_parcele,
        povrsina: row.povrsina,
        calculatedArea,
        estimatedMarketPrice,
        estimatedMarketPriceCurrency: 'EUR',
        upravniStatusId: row.upravni_status_id,
        gradParc: row.grad_parc,
        omejitev: row.omejitev,
        skupniDelEtazna: row.skupni_del_etazna,
        dateAdded: row.date_added
    };

    // Add ownership data if available
    if (ownershipData) {
        properties.ownershipList = ownershipData.ownershipList;
        properties.ownershipType = ownershipData.ownershipType;
    }

    return {
        type: 'Feature',
        properties,
        geometry: row.geometry
    };
}

function parseParcelId(raw) {
    const value = (raw || '').toString().trim();
    if (!value) return null;
    // Remove SI- prefix if present
    const withoutPrefix = value.replace(/^(SI-)+/i, '');
    if (!withoutPrefix || !isValidParcelValue(withoutPrefix)) {
        return null;
    }
    // The eid_parcela is the identifier
    return withoutPrefix;
}

async function fetchOwnershipForParcels(pool, eidParcelas) {
    if (!eidParcelas || eidParcelas.length === 0) {
        return new Map();
    }

    const sql = `
        SELECT
            parcel_eid,
            share_num,
            share_den,
            oseba_id,
            meta
        FROM parcel_lj_owner
        WHERE parcel_eid = ANY($1::text[])
          AND current = true
        ORDER BY parcel_eid, oseba_id
    `;

    try {
        const { rows } = await pool.query(sql, [eidParcelas]);

        // Group by parcel_eid
        const ownershipMap = new Map();

        rows.forEach(row => {
            const eid = row.parcel_eid;
            if (!ownershipMap.has(eid)) {
                ownershipMap.set(eid, []);
            }

            const shareNum = Number(row.share_num) || 1;
            const shareDen = Number(row.share_den) || 1;
            const percentageShare = (shareNum / shareDen) * 100;

            // Try to get owner label from meta, fallback to oseba_id
            let ownerLabel = `Owner ${row.oseba_id}`;
            if (row.meta && typeof row.meta === 'object') {
                if (row.meta.ime) {
                    ownerLabel = row.meta.ime;
                } else if (row.meta.naziv) {
                    ownerLabel = row.meta.naziv;
                }
            }

            ownershipMap.get(eid).push({
                ownerLabel,
                percentageShare: Number(percentageShare.toFixed(4))
            });
        });

        // Convert to ownership summary format
        const summaryMap = new Map();
        ownershipMap.forEach((owners, eid) => {
            if (owners.length > 0) {
                const ownershipType = owners.length === 1 ? 'private individual' : 'mixed';
                summaryMap.set(eid, {
                    ownershipList: owners,
                    ownershipType
                });
            }
        });

        return summaryMap;
    } catch (error) {
        console.warn('Failed to fetch ownership for Ljubljana parcels:', error);
        return new Map();
    }
}


export async function lookup(pool, { query = {}, body: bodyInput, params: pathParams = {} } = {}) {
        const bboxRaw = typeof query.bbox === 'string' ? query.bbox.trim() : '';
        const parcelIdParam = typeof query.parcel_id === 'string' ? query.parcel_id.trim() :
            (typeof query.parcelId === 'string' ? query.parcelId.trim() : '');
        const eidParam = typeof query.eid === 'string' ? query.eid.trim() : '';
        const koId = typeof query.ko_id === 'string' ? query.ko_id.trim() :
            (typeof query.koId === 'string' ? query.koId.trim() : '');
        const stParcele = typeof query.st_parcele === 'string' ? query.st_parcele.trim() : '';
        const limit = parseLimit(query.limit);
        const bbox = parseBbox(bboxRaw);

        if (bboxRaw && !bbox) {
            throw databaseSourceError(400, {
                error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.'
            });
        }
        // Callers ask per 500 m grid cell; a bbox the size of a city (or the world) is not the app.
        if (bbox && wgs84BboxAreaKm2(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat) > MAX_CELL_BBOX_KM2) {
            throw databaseSourceError(400, { error: `bbox too large (max ${MAX_CELL_BBOX_KM2} km²).` });
        }

        const eidParcela = parseParcelId(parcelIdParam) || eidParam;
        if (parcelIdParam && !parseParcelId(parcelIdParam)) {
            throw databaseSourceError(400, {
                error: 'Invalid parcel_id format. Expected SI-<eid_parcela> or <eid_parcela>.'
            });
        }
        const hasEid = Boolean(eidParcela);
        const hasKoId = Boolean(koId);
        const hasStParcele = Boolean(stParcele);
        const hasBbox = Boolean(bbox);

        if (!hasEid && !hasKoId && !hasBbox) {
            throw databaseSourceError(400, {
                error: 'Provide bbox or parcel_id (SI-<eid_parcela>) to query Ljubljana parcels.'
            });
        }

        let sql = `
            SELECT
                eid_parcela,
                parcela_id,
                ko_id,
                naziv,
                st_parcele,
                povrsina,
                upravni_status_id,
                grad_parc,
                omejitev,
                skupni_del_etazna,
                date_added,
                ST_Area(ST_Transform(geom, 4326)::geography) AS calculated_area,
                ST_AsGeoJSON(ST_Transform(geom, ${SRID_WGS84}))::json AS geometry
            FROM parcel_lj
            WHERE current = true
        `;
        const params = [];
        let queryType = hasBbox ? 'bbox' : 'all';
        const whereClauses = [];

        if (hasEid) {
            params.push(eidParcela);
            whereClauses.push(`eid_parcela = $${params.length}`);
            queryType = 'parcel';
        } else if (hasKoId) {
            params.push(koId);
            whereClauses.push(`ko_id = $${params.length}::int`);
            if (hasStParcele) {
                params.push(stParcele);
                whereClauses.push(`st_parcele = $${params.length}`);
                queryType = 'parcel';
            }
        }

        if (hasBbox) {
            params.push(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
            const envelope4326 = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, ${SRID_WGS84})`;
            const envelopeDataset = `ST_Transform(${envelope4326}, ${SRID_DATASET})`;
            whereClauses.push(`geom && ${envelopeDataset}`);
            whereClauses.push(`ST_Intersects(geom, ${envelopeDataset})`);
            if (!hasKoId && !hasStParcele && !hasEid) {
                queryType = 'bbox';
            }
        }

        if (whereClauses.length > 0) {
            sql += ` AND ${whereClauses.join(' AND ')}`;
        }

        if (queryType !== 'parcel') {
            sql += ' ORDER BY ko_id, st_parcele';
        }

        // Always bounded: without ?limit this used to return every matching row (a world bbox or
        // a bare filter returned the whole table, raw features included). One extra row tells us
        // whether the answer was cut short.
        // Key lookups (queryType 'parcel') name their rows and stay unlimited.
        const effectiveLimit = queryType === 'parcel' ? Infinity : (limit || MAX_LIMIT);
        if (queryType !== 'parcel') {
            params.push(effectiveLimit + 1);
            sql += ` LIMIT $${params.length}`;
        }

        try {
            const { rows: fetched } = await pool.query(sql, params);
            const truncated = fetched.length > effectiveLimit;
            const rows = truncated ? fetched.slice(0, effectiveLimit) : fetched;
            if (!rows.length) {
                throw databaseSourceError(404, { error: 'No parcels found for the provided filters.' });
            }

            // Fetch ownership data for all parcels
            const eidParcelas = rows.map(r => r.eid_parcela).filter(Boolean);
            const ownershipMap = await fetchOwnershipForParcels(pool, eidParcelas);

            const features = rows.map(row => {
                const ownershipData = ownershipMap.get(row.eid_parcela) || null;
                return buildFeature(row, ownershipData);
            });

            return {
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    parcel_id: hasEid ? (parcelIdParam || undefined) : undefined,
                    eid: eidParcela || undefined,
                    ko_id: koId || undefined,
                    st_parcele: stParcele || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined
                },
                truncated,
                features
            };
        } catch (error) {
            if (isDatabaseSourceError(error)) throw error;
            console.error('Error in /parcel-lj:', error);
            throw databaseSourceError(500, { error: 'Failed to fetch Ljubljana parcels.' });
        }

}
