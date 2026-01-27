import { buildOwnershipSummary } from './parcels.js';

const MAX_LIMIT = 5000;

const SRID_WGS84 = 4326;
const SRID_DATASET = 3765; // EPSG:3765 - same as Zagreb (HTRS96/TM)
const CITY_NAME = 'Ljubljana';
const COUNTRY_PREFIX = 'SI';

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
    // The eid_parcela is the identifier
    return withoutPrefix || null;
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

async function fetchOwnershipForParcelId(pool, eidParcela) {
    const sql = `
        SELECT
            p.eid_parcela,
            p.ko_id,
            p.naziv,
            p.st_parcele,
            p.povrsina,
            o.share_num,
            o.share_den,
            o.oseba_id,
            o.meta
        FROM parcel_lj p
        LEFT JOIN parcel_lj_owner o ON o.parcel_eid = p.eid_parcela AND o.current = true
        WHERE p.eid_parcela = $1 AND p.current = true
    `;

    const { rows } = await pool.query(sql, [eidParcela]);
    if (!rows.length) {
        return null;
    }

    const firstRow = rows[0];
    const parcelId = `${COUNTRY_PREFIX}-${eidParcela}`;

    // Build possessors from ownership rows
    const possessors = rows
        .filter(row => row.oseba_id)
        .map(row => {
            const shareNum = Number(row.share_num) || 1;
            const shareDen = Number(row.share_den) || 1;

            let ownerName = `Owner ${row.oseba_id}`;
            if (row.meta && typeof row.meta === 'object') {
                if (row.meta.ime) {
                    ownerName = row.meta.ime;
                } else if (row.meta.naziv) {
                    ownerName = row.meta.naziv;
                }
            }

            return {
                name: ownerName,
                ownership: `${shareNum}/${shareDen}`,
                address: ''
            };
        });

    if (possessors.length === 0) {
        possessors.push({
            name: 'Unknown owner',
            ownership: '1/1',
            address: ''
        });
    }

    const possessionSheets = [{
        possessionSheetId: null,
        possessionSheetNumber: null,
        cadMunicipalityName: firstRow.naziv || CITY_NAME,
        possessors
    }];

    const payload = {
        parcelId,
        possessionSheets,
        parcelNumber: firstRow.st_parcele,
        koId: firstRow.ko_id,
        koName: firstRow.naziv,
        cadMunicipalityName: firstRow.naziv || CITY_NAME,
        area: firstRow.povrsina
    };

    // Add ownership summary
    const summary = buildOwnershipSummary(payload);
    if (summary) {
        payload.ownershipList = summary.ownershipList;
        payload.ownershipType = summary.ownershipType;
    }

    return payload;
}

export function setupParcelLjRoute(app, pool) {
    app.get('/parcel-lj', async (req, res) => {
        const parcelIdParam = typeof req.query.parcel_id === 'string' ? req.query.parcel_id.trim() :
            (typeof req.query.parcelId === 'string' ? req.query.parcelId.trim() : '');
        const eidParam = typeof req.query.eid === 'string' ? req.query.eid.trim() : '';
        const koId = typeof req.query.ko_id === 'string' ? req.query.ko_id.trim() :
            (typeof req.query.koId === 'string' ? req.query.koId.trim() : '');
        const stParcele = typeof req.query.st_parcele === 'string' ? req.query.st_parcele.trim() : '';
        const limit = parseLimit(req.query.limit);
        const bbox = parseBbox(typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '');

        const eidParcela = parseParcelId(parcelIdParam) || eidParam;
        const hasEid = Boolean(eidParcela);
        const hasKoId = Boolean(koId);
        const hasStParcele = Boolean(stParcele);
        const hasBbox = Boolean(bbox);

        if (!hasEid && !hasKoId && !hasBbox) {
            return res.status(400).json({
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
                ST_Area(geom) AS calculated_area,
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

        if (limit && queryType !== 'parcel') {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
        }

        try {
            const { rows } = await pool.query(sql, params);
            if (!rows.length) {
                return res.status(404).json({ error: 'No parcels found for the provided filters.' });
            }

            // Fetch ownership data for all parcels
            const eidParcelas = rows.map(r => r.eid_parcela).filter(Boolean);
            const ownershipMap = await fetchOwnershipForParcels(pool, eidParcelas);

            const features = rows.map(row => {
                const ownershipData = ownershipMap.get(row.eid_parcela) || null;
                return buildFeature(row, ownershipData);
            });

            res.json({
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    parcel_id: hasEid ? parcelIdParam : undefined,
                    eid: eidParcela || undefined,
                    ko_id: koId || undefined,
                    st_parcele: stParcele || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined
                },
                features
            });
        } catch (error) {
            console.error('Error in /parcel-lj:', error);
            res.status(500).json({ error: 'Failed to fetch Ljubljana parcels.' });
        }
    });

    app.get('/parcel-lj/:parcelId/ownership', async (req, res) => {
        const parcelId = (req.params.parcelId || '').trim();
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required.' });
        }
        const eidParcela = parseParcelId(parcelId);
        if (!eidParcela) {
            return res.status(400).json({
                error: 'Invalid parcelId format. Expected SI-<eid_parcela> or <eid_parcela>.'
            });
        }
        try {
            const ownership = await fetchOwnershipForParcelId(pool, eidParcela);
            if (!ownership) {
                return res.status(404).json({ error: 'Ownership data not found for the requested parcelId.' });
            }
            res.json(ownership);
        } catch (error) {
            console.error(`Error in /parcel-lj/${parcelId}/ownership:`, error);
            res.status(500).json({ error: 'Failed to fetch Ljubljana ownership data.' });
        }
    });
}
