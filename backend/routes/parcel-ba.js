import { normalizePossessionSheets, buildOwnershipSummary, pickOwnershipFields } from './parcels.js';

const MAX_LIMIT = 5000;

const SRID_WGS84 = 4326;

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
        cadMunicipalityName: 'Buenos Aires',
        possessors
    }];

    // Build payload in the same format as /parcels/ endpoint
    const parcelId = smp ? `AR-${smp}` : null;
    const payload = {
        parcelId: parcelId,
        possessionSheets: possessionSheets,
        parcelNumber: informationBasic?.parcela ?? null,
        section: informationBasic?.seccion ?? null,
        block: informationBasic?.manzana ?? null,
        cadMunicipalityName: 'Buenos Aires',
        // Keep additional fields for backward compatibility
        smp,
        informationBasic: row.information_basic,
        informationTechnical: row.information_technical,
        propertyHorizontal: row.property_horizontal,
        doors: row.doors,
        dateAdded: row.date_added,
        dateUpdated: row.date_updated
    };

    // Use pickOwnershipFields to normalize the format
    const normalized = pickOwnershipFields(payload, parcelId);

    // Add ownership summary (ownershipList and ownershipType)
    const summary = buildOwnershipSummary(payload);
    if (summary) {
        normalized.ownershipList = summary.ownershipList;
        normalized.ownershipType = summary.ownershipType;
    }

    return normalized;
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

function buildFeature(row, ownershipSummary = null) {
    // For Buenos Aires, parcelId is AR-<smp> where smp is already in format like "123-456A-789B"
    const parcelId = row.smp ? `AR-${row.smp}` : null;
    const informationTechnical = row.information_technical || {};
    const rawArea = row.area ?? informationTechnical?.superficie_total;
    const numericArea = Number(rawArea);
    const calculatedArea = Number.isFinite(numericArea) ? numericArea : undefined;
    const estimatedMarketPrice = Number.isFinite(numericArea) ? numericArea * 100 : undefined;
    const properties = {
        smp: row.smp,
        parcelId: parcelId,
        section: row.section,
        block: row.block,
        parcel: row.parcel,
        informationBasic: row.information_basic,
        informationTechnical: row.information_technical,
        propertyHorizontal: row.property_horizontal,
        doors: row.doors,
        dateAdded: row.date_added,
        dateUpdated: row.date_updated,
        calculatedArea,
        estimatedMarketPrice,
        estimatedMarketPriceCurrency: estimatedMarketPrice ? 'USDT' : undefined
    };

    // Add ownership data in the same format as /parcels/ endpoint
    // Prefer SQL-computed ownership data, fallback to JavaScript-computed summary
    if (row.ownership_list_json) {
        try {
            const ownershipList = typeof row.ownership_list_json === 'string'
                ? JSON.parse(row.ownership_list_json)
                : row.ownership_list_json;
            if (Array.isArray(ownershipList) && ownershipList.length > 0) {
                properties.ownershipList = ownershipList;
                properties.ownershipType = row.ownership_type || 'private individual';
            }
        } catch (e) {
            // Fall through to use JavaScript-computed summary if SQL parsing fails
            if (ownershipSummary) {
                properties.ownershipList = ownershipSummary.ownershipList;
                properties.ownershipType = ownershipSummary.ownershipType;
            }
        }
    } else if (ownershipSummary) {
        properties.ownershipList = ownershipSummary.ownershipList;
        properties.ownershipType = ownershipSummary.ownershipType;
    }

    return {
        type: 'Feature',
        properties,
        geometry: row.geometry
    };
}

async function fetchOwnershipForSmp(pool, smp) {
    const sql = `
        SELECT information_basic, information_technical, property_horizontal, doors, date_added, date_updated
        FROM parcel_ba
        WHERE smp = $1
        LIMIT 1
    `;
    const { rows } = await pool.query(sql, [smp]);
    if (!rows.length) {
        return null;
    }
    const row = rows[0];
    return buildOwnershipPayloadFromRow(row, smp);
}

async function fetchOwnershipSummariesForSmps(pool, smps) {
    const summaryMap = new Map();
    const uniqueSmps = Array.from(new Set((smps || [])
        .map(value => (value || '').toString().trim())
        .filter(Boolean)));

    if (!uniqueSmps.length) {
        return summaryMap;
    }

    try {
        const sql = `
            SELECT smp, information_basic, information_technical, property_horizontal, doors, date_added, date_updated
            FROM parcel_ba
            WHERE smp = ANY($1::text[])
        `;
        const { rows } = await pool.query(sql, [uniqueSmps]);

        rows.forEach(row => {
            const smp = row.smp;
            if (!smp) {
                return;
            }

            const payload = buildOwnershipPayloadFromRow(row, smp);
            const summary = buildOwnershipSummary(payload);
            if (summary) {
                summaryMap.set(smp, summary);
            }
        });
    } catch (error) {
        console.warn('Failed to fetch ownership summaries for Buenos Aires parcels:', error);
    }

    return summaryMap;
}

const SMP_REGEX = /^[0-9]{3}-[0-9]{3}[A-Za-z]?-[0-9]{3}[A-Za-z]?$/;

export function setupParcelBaRoute(app, pool) {
    app.get('/parcel-ba', async (req, res) => {
        let smp = typeof req.query.smp === 'string' ? req.query.smp.trim() : '';
        // Strip AR- prefix if present (handle both AR-002-062-000 and 002-062-000 formats)
        if (smp) {
            smp = smp.replace(/^(AR-)+/i, '');
        }
        const section = typeof req.query.section === 'string' ? req.query.section.trim() : '';
        const block = typeof req.query.block === 'string' ? req.query.block.trim() : '';
        const parcel = typeof req.query.parcel === 'string' ? req.query.parcel.trim() : '';
        const limit = parseLimit(req.query.limit);
        const bbox = parseBbox(typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '');

        const hasSmp = Boolean(smp);
        const hasSection = Boolean(section);
        const hasBlock = Boolean(block);
        const hasParcel = Boolean(parcel);
        const hasBbox = Boolean(bbox);

        if (!hasSmp && !hasSection && !hasBbox) {
            return res.status(400).json({
                error: 'Provide bbox, smp, or at least section (optionally with block/parcel) to query Buenos Aires parcels.'
            });
        }

        if (hasBlock && !hasSection) {
            return res.status(400).json({ error: 'block filter requires section to be provided.' });
        }

        if (hasParcel && (!hasSection || !hasBlock)) {
            return res.status(400).json({ error: 'parcel filter requires both section and block to be provided.' });
        }

        if (!hasBbox && !hasSection && (hasBlock || hasParcel)) {
            return res.status(400).json({ error: 'block/parcel filter requires at least section or bbox to be provided.' });
        }

        let sql = `
            SELECT
                smp,
                section,
                block,
                parcel,
                COALESCE((information_technical->>'superficie_total')::numeric, ST_Area(geometry::geography)) AS area,
                ST_AsGeoJSON(geometry)::json AS geometry,
                information_basic,
                information_technical,
                property_horizontal,
                doors,
                date_added,
                date_updated,
                -- Extract ownership data directly in SQL
                CASE
                    WHEN property_horizontal IS NULL OR property_horizontal->'phs' IS NULL THEN NULL
                    ELSE (
                        SELECT json_agg(
                            json_build_object(
                                'ownerLabel', 
                                CASE 
                                    WHEN (unit->>'dpto') IS NOT NULL AND (unit->>'dpto') != '' 
                                    THEN 'dpto ' || (unit->>'dpto')
                                    ELSE 'Unit ' || idx::text
                                END,
                                'percentageShare',
                                CASE
                                    WHEN (unit->>'porcentual') IS NOT NULL AND (unit->>'porcentual') != ''
                                    THEN GREATEST(0, LEAST(100, CAST((unit->>'porcentual') AS NUMERIC)))
                                    ELSE NULL
                                END
                            )
                            ORDER BY (unit->>'dpto'), (unit->>'piso'), idx
                        )
                        FROM jsonb_array_elements(property_horizontal->'phs') WITH ORDINALITY AS t(unit, idx)
                        WHERE unit IS NOT NULL
                    )
                END AS ownership_list_json,
                -- Compute ownership type based on number of units
                CASE
                    WHEN property_horizontal IS NULL OR property_horizontal->'phs' IS NULL THEN NULL
                    ELSE (
                        SELECT CASE
                            WHEN jsonb_array_length(property_horizontal->'phs') = 0 THEN NULL
                            WHEN jsonb_array_length(property_horizontal->'phs') = 1 THEN 'private individual'
                            ELSE 'mixed'
                        END
                    )
                END AS ownership_type
            FROM parcel_ba
        `;
        const params = [];
        let queryType = hasBbox ? 'bbox' : 'section';
        const whereClauses = [];

        if (hasSmp) {
            params.push(smp);
            whereClauses.push(`smp = $${params.length}`);
            queryType = 'parcel';
        } else {
            if (hasSection) {
                params.push(section);
                whereClauses.push(`section = $${params.length}`);
                if (hasBlock) {
                    params.push(block);
                    whereClauses.push(`block = $${params.length}`);
                    if (hasParcel) {
                        params.push(parcel);
                        whereClauses.push(`parcel = $${params.length}`);
                        queryType = 'parcel';
                    } else {
                        queryType = 'block';
                    }
                } else {
                    queryType = 'section';
                }
            }
        }

        if (hasBbox) {
            params.push(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
            const envelopeExpr = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, ${SRID_WGS84})`;
            whereClauses.push(`geometry && ${envelopeExpr}`);
            if (!hasSection && !hasBlock && !hasParcel && !hasSmp) {
                queryType = 'bbox';
            }
        }

        if (whereClauses.length > 0) {
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        if (queryType !== 'parcel') {
            sql += ' ORDER BY block, parcel';
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

            // Fetch ownership summaries for all parcels in batch
            let ownershipSummaryMap = new Map();
            try {
                const smpsForOwnership = rows
                    .map(r => (r.smp || '').toString().trim())
                    .filter(Boolean);
                ownershipSummaryMap = await fetchOwnershipSummariesForSmps(pool, smpsForOwnership);
            } catch (ownershipError) {
                console.warn('Ownership enrichment failed for /parcel-ba', ownershipError);
            }

            // Build features with ownership data
            const features = rows.map(row => {
                const smp = (row.smp || '').toString().trim();
                const ownershipSummary = smp ? ownershipSummaryMap.get(smp) : null;
                return buildFeature(row, ownershipSummary);
            });

            res.json({
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    smp: smp || undefined,
                    section: section || undefined,
                    block: block || undefined,
                    parcel: parcel || undefined,
                    bbox: hasBbox ? `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}` : undefined,
                    limit: limit || undefined
                },
                features
            });
        } catch (error) {
            console.error('Error in /parcel-ba:', error);
            res.status(500).json({ error: 'Failed to fetch Buenos Aires parcels.' });
        }
    });

    app.get('/parcel-ba/:smp/ownership', async (req, res) => {
        let smp = (req.params.smp || '').trim();
        // Strip AR- prefix if present (handle both AR-002-062-000 and 002-062-000 formats)
        if (smp) {
            smp = smp.replace(/^(AR-)+/i, '');
        }
        if (!smp) {
            return res.status(400).json({ error: 'SMP identifier is required.' });
        }
        if (!SMP_REGEX.test(smp)) {
            return res.status(400).json({
                error: 'Invalid SMP format. Expected e.g. 001-005-027A or 001-025A-002.'
            });
        }
        try {
            const ownership = await fetchOwnershipForSmp(pool, smp);
            if (!ownership) {
                return res.status(404).json({ error: 'Ownership data not found for the requested SMP.' });
            }
            res.json(ownership);
        } catch (error) {
            console.error(`Error in /parcel-ba/${smp}/ownership:`, error);
            res.status(500).json({ error: 'Failed to fetch Buenos Aires ownership data.' });
        }
    });
}

