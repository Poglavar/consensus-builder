import { MAX_CELL_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';

const MAX_LIMIT = 5000;

const SRID_WGS84 = 4326;
const SRID_DATASET = 32634; // Table geometry is MultiPolygon, 32634
const COMPOSITE_ID_SEPARATOR = '-';

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

function buildCompositeParcelId(cadmunCode, parcelNum) {
    const cadmun = (cadmunCode ?? '').toString().trim();
    const parcel = (parcelNum ?? '').toString().trim();
    if (!cadmun || !parcel) return '';
    return `${cadmun}${COMPOSITE_ID_SEPARATOR}${parcel}`;
}

function buildFeature(row) {
    const compositeId = buildCompositeParcelId(row.cadmun_code, row.parcel_num);
    const rawArea = row.calculated_area ?? row.area;
    const numericArea = Number(rawArea);
    const calculatedArea = Number.isFinite(numericArea) ? numericArea : undefined;
    const estimatedMarketPrice = Number.isFinite(numericArea) ? numericArea * 100 : undefined;
    // For Belgrade, parcelId is SR-<cadmun_code>-<parcel_num>
    const parcelId = compositeId ? `SR-${compositeId}` : null;
    return {
        type: 'Feature',
        properties: {
            smp: compositeId,
            parcelId: parcelId,
            cadmunCode: row.cadmun_code,
            cadmunNameCyr: row.cadmun_name_cyr,
            cadmunNameLat: row.cadmun_name_lat,
            cityNameCyr: row.city_name_cyr,
            cityNameLat: row.city_name_lat,
            parcelNum: row.parcel_num,
            parcelStatusCode: row.parcel_status_code,
            parcelStatusNameCyr: row.parcel_status_name_cyr,
            parcelStatusNameLat: row.parcel_status_name_lat,
            area: row.area,
            calculatedArea,
            estimatedMarketPrice,
            estimatedMarketPriceCurrency: 'EUR',
            sourceParcelId: row.source_parcel_id,
            rawFeature: row.raw_feature
        },
        geometry: row.geometry
    };
}

function parseParcelId(raw) {
    const value = (raw || '').toString().trim();
    if (!value) return null;
    const withoutPrefix = value.replace(/^(SR-)+/i, '');
    const parts = withoutPrefix.split(COMPOSITE_ID_SEPARATOR);
    if (parts.length !== 2) return null;
    const cadmunCode = parts[0]?.trim();
    const parcelNum = parts[1]?.trim();
    if (!cadmunCode || !parcelNum) return null;
    return { cadmunCode, parcelNum };
}

export function setupParcelBgRoute(app, pool) {
    app.get('/parcel-bg', async (req, res) => {
        const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
        const parcelIdParam = typeof req.query.parcel_id === 'string' ? req.query.parcel_id.trim() :
            (typeof req.query.parcelId === 'string' ? req.query.parcelId.trim() : '');
        const smp = typeof req.query.smp === 'string' ? req.query.smp.trim() : '';
        const cadmunCode = typeof req.query.cadmun === 'string' ? req.query.cadmun.trim() : '';
        const parcelNum = typeof req.query.parcel_num === 'string' ? req.query.parcel_num.trim() : '';
        const limit = parseLimit(req.query.limit);
        const bbox = parseBbox(bboxRaw);

        if (bboxRaw && !bbox) {
            return res.status(400).json({
                error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.'
            });
        }
        // Callers ask per 500 m grid cell; a bbox the size of a city (or the world) is not the app.
        if (bbox && wgs84BboxAreaKm2(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat) > MAX_CELL_BBOX_KM2) {
            return res.status(400).json({ error: `bbox too large (max ${MAX_CELL_BBOX_KM2} km²).` });
        }

        const parcelIdValue = parcelIdParam || smp;
        const parsedParcel = parseParcelId(parcelIdValue);
        const hasParcelId = Boolean(parsedParcel);
        const hasSmp = Boolean(smp);
        const hasCadmun = Boolean(cadmunCode);
        const hasParcelNum = Boolean(parcelNum);
        const hasBbox = Boolean(bbox);

        if (parcelIdValue && !parsedParcel) {
            return res.status(400).json({ error: 'Invalid parcel_id format. Expected SR-<cadmun_code>-<parcel_num> or <cadmun_code>-<parcel_num>.' });
        }

        if (!hasParcelId && !hasCadmun && !hasBbox) {
            return res.status(400).json({
                error: 'Provide bbox or parcel_id (SR-<cadmun>-<parcel_num>) to query Belgrade parcels.'
            });
        }

        let sql = `
            SELECT
                cadmun_code,
                cadmun_name_cyr,
                cadmun_name_lat,
                city_name_cyr,
                city_name_lat,
                parcel_num,
                parcel_status_code,
                parcel_status_name_cyr,
                parcel_status_name_lat,
                COALESCE(area, ST_Area(geom)) AS area,
                ST_Area(geom) AS calculated_area,
                source_parcel_id,
                raw_feature,
                ST_AsGeoJSON(ST_Transform(geom, ${SRID_WGS84}))::json AS geometry
            FROM parcel_bg
        `;
        const params = [];
        let queryType = hasBbox ? 'bbox' : 'all';
        const whereClauses = [];

        if (hasParcelId) {
            params.push(parsedParcel.cadmunCode, parsedParcel.parcelNum);
            whereClauses.push(`cadmun_code = $${params.length - 1} AND parcel_num = $${params.length}`);
            queryType = 'parcel';
        } else if (hasCadmun) {
            params.push(cadmunCode);
            whereClauses.push(`cadmun_code = $${params.length}`);
            if (hasParcelNum) {
                params.push(parcelNum);
                whereClauses.push(`parcel_num = $${params.length}`);
                queryType = 'parcel';
            }
        }

        if (hasBbox) {
            params.push(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
            const envelope4326 = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, ${SRID_WGS84})`;
            const envelopeDataset = `ST_Transform(${envelope4326}, ${SRID_DATASET})`;
            whereClauses.push(`geom && ${envelopeDataset}`);
            whereClauses.push(`ST_Intersects(geom, ${envelopeDataset})`);
            if (!hasCadmun && !hasParcelNum && !hasSmp) {
                queryType = 'bbox';
            }
        }

        if (whereClauses.length > 0) {
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        if (queryType !== 'parcel') {
            sql += ' ORDER BY cadmun_code, parcel_num';
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
                return res.status(404).json({ error: 'No parcels found for the provided filters.' });
            }

            const features = rows.map(buildFeature);
            res.json({
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    parcel_id: hasParcelId ? parcelIdValue : undefined,
                    smp: hasParcelId ? undefined : (smp || undefined),
                    cadmun: cadmunCode || undefined,
                    parcel_num: parcelNum || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined
                },
                truncated,
                features
            });
        } catch (error) {
            console.error('Error in /parcel-bg:', error);
            res.status(500).json({ error: 'Failed to fetch Belgrade parcels.' });
        }
    });
}
