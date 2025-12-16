const MAX_LIMIT = 5000;

const SRID_WGS84 = 4326;
const SRID_DATASET = 32634; // Table geometry is MultiPolygon, 32634
const CITY_NAME = 'Belgrade';
const COMPOSITE_ID_SEPARATOR = '-';

function gcd(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return 1;
    }
    return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

function convertPercentToFraction(percentValue) {
    if (!Number.isFinite(percentValue)) {
        return null;
    }
    const percentString = percentValue.toString();
    const decimalPart = percentString.includes('.') ? percentString.split('.')[1] : '';
    const scale = Math.pow(10, decimalPart.length);
    const numerator = Math.round(percentValue * scale);
    const denominator = 100 * scale;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
    }
    const divisor = gcd(numerator, denominator) || 1;
    return `${numerator / divisor}/${denominator / divisor}`;
}

function buildPossessorsFromPropertyHorizontal(propertyHorizontal) {
    const units = Array.isArray(propertyHorizontal?.phs) ? propertyHorizontal.phs : [];
    if (!units.length) {
        return [{
            name: 'Unknown owner',
            ownership: '1/1',
            condominiumShareOwnership: '100%',
            condominiumShareNumber: '',
            address: ''
        }];
    }
    return units.map((unit, index) => {
        const depto = (unit?.dpto ?? '').toString().trim();
        const piso = (unit?.piso ?? '').toString().trim();
        const porcentualRaw = Number(unit?.porcentual);
        const fraction = convertPercentToFraction(porcentualRaw) || '1/1';
        const hasPercent = Number.isFinite(porcentualRaw);
        const sharePercentText = hasPercent ? `${porcentualRaw}%` : '100%';
        const possessor = {
            name: depto ? `dpto ${depto}` : `Unit ${index + 1}`,
            ownership: fraction,
            condominiumShareOwnership: sharePercentText || '',
            condominiumShareNumber: unit?.pdahorizontal ? String(unit.pdahorizontal) : ''
        };
        if (piso) {
            possessor.address = `Piso ${piso}`;
        }
        return possessor;
    });
}

function buildOwnershipPayloadFromRow(row, smp) {
    const informationBasic = row.information_basic || {};
    const propertyHorizontal = row.property_horizontal || {};
    const possessors = buildPossessorsFromPropertyHorizontal(propertyHorizontal);
    const possessionSheets = [{
        possessionSheetId: propertyHorizontal?.pdahorizontal ?? null,
        possessionSheetNumber: propertyHorizontal?.pdahorizontal ?? null,
        cadMunicipalityName: CITY_NAME,
        possessors
    }];
    return {
        smp,
        section: informationBasic?.seccion ?? null,
        block: informationBasic?.manzana ?? null,
        parcel: informationBasic?.parcela ?? null,
        possessionSheets,
        informationBasic: row.information_basic,
        informationTechnical: row.information_technical,
        propertyHorizontal: row.property_horizontal,
        doors: row.doors,
        dateAdded: row.date_added,
        dateUpdated: row.date_updated
    };
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

async function fetchOwnershipForParcelId(pool, parcelId) {
    const parsed = parseParcelId(parcelId);
    if (!parsed) return null;
    const { cadmunCode, parcelNum } = parsed;
    const sql = `
        SELECT cadmun_code, parcel_num, cadmun_name_cyr, cadmun_name_lat, city_name_cyr, city_name_lat, parcel_status_code, parcel_status_name_cyr, parcel_status_name_lat, area, source_parcel_id, raw_feature
        FROM parcel_bg
        WHERE cadmun_code = $1 AND parcel_num = $2
        LIMIT 1
    `;
    const { rows } = await pool.query(sql, [cadmunCode, parcelNum]);
    if (!rows.length) {
        return null;
    }
    const row = rows[0];
    const compositeId = buildCompositeParcelId(cadmunCode, parcelNum);
    return buildOwnershipPayloadFromRow(row, compositeId);
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
        const parcelIdParam = typeof req.query.parcel_id === 'string' ? req.query.parcel_id.trim() :
            (typeof req.query.parcelId === 'string' ? req.query.parcelId.trim() : '');
        const smp = typeof req.query.smp === 'string' ? req.query.smp.trim() : '';
        const cadmunCode = typeof req.query.cadmun === 'string' ? req.query.cadmun.trim() : '';
        const parcelNum = typeof req.query.parcel_num === 'string' ? req.query.parcel_num.trim() : '';
        const limit = parseLimit(req.query.limit);
        const bbox = parseBbox(typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '');

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
                area,
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

        if (limit && queryType !== 'parcel') {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
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
                    parcel_id: hasParcelId ? parcelIdValue : undefined,
                    smp: hasParcelId ? undefined : (smp || undefined),
                    cadmun: cadmunCode || undefined,
                    parcel_num: parcelNum || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined
                },
                features
            });
        } catch (error) {
            console.error('Error in /parcel-bg:', error);
            res.status(500).json({ error: 'Failed to fetch Belgrade parcels.' });
        }
    });

    app.get('/parcel-bg/:parcelId/ownership', async (req, res) => {
        const parcelId = (req.params.parcelId || '').trim();
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required.' });
        }
        const parsed = parseParcelId(parcelId);
        if (!parsed) {
            return res.status(400).json({
                error: 'Invalid parcelId format. Expected SR-<cadmun_code>-<parcel_num> or <cadmun_code>-<parcel_num>.'
            });
        }
        try {
            const ownership = await fetchOwnershipForParcelId(pool, parcelId);
            if (!ownership) {
                return res.status(404).json({ error: 'Ownership data not found for the requested parcelId.' });
            }
            res.json(ownership);
        } catch (error) {
            console.error(`Error in /parcel-bg/${parcelId}/ownership:`, error);
            res.status(500).json({ error: 'Failed to fetch Belgrade ownership data.' });
        }
    });
}


