// GET /parcels?bbox=minX,minY,maxX,maxY OR ?coordinates=x,y OR ?parcel_number=broj_cestice OR ?parcel_identifier=broj_cestice-maticni_broj_ko
// Supports both WGS84 (lon,lat) and HTRS96/TM (EPSG:3765) coordinates
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_CESTICE

const OWNERSHIP_DETAIL_QUERIES = [
    `
        SELECT details
        FROM parcel_detail
        WHERE cestica_id = $1
        LIMIT 1
    `,
    `
        SELECT details
        FROM parcel_detail.details
        WHERE cestica_id = $1
        LIMIT 1
    `
];

function sanitizeOwnershipString(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim();
}

function normalizePossessorEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const name = sanitizeOwnershipString(entry.name || entry.possessorName || '');
    if (!name) {
        return null;
    }

    const ownership = sanitizeOwnershipString(
        entry.ownership ||
        entry.actualShareText ||
        entry.condominiumShareOwnership ||
        entry.condominiumShareNumber ||
        ''
    );

    const address = sanitizeOwnershipString(entry.address || entry.place || '');

    const normalized = { name };
    if (address) {
        normalized.address = address;
    }
    if (ownership) {
        normalized.ownership = ownership;
    }
    return normalized;
}

function normalizePossessors(rawPossessors) {
    if (!Array.isArray(rawPossessors)) {
        return [];
    }
    return rawPossessors
        .map(normalizePossessorEntry)
        .filter(Boolean);
}

function normalizePossessionSheets(rawSheets) {
    if (!Array.isArray(rawSheets)) {
        return [];
    }

    return rawSheets.map(sheet => {
        const normalizedSheet = {
            possessionSheetId: sheet?.possessionSheetId ?? sheet?.possession_sheet_id ?? null,
            possessionSheetNumber: sheet?.possessionSheetNumber ?? sheet?.possession_sheet_number ?? null,
            cadMunicipalityId: sheet?.cadMunicipalityId ?? sheet?.cad_municipality_id ?? null,
            cadMunicipalityName: sheet?.cadMunicipalityName ?? sheet?.cad_municipality_name ?? null,
            possessors: normalizePossessors(sheet?.possessors)
        };

        if (!normalizedSheet.possessors.length) {
            normalizedSheet.possessors = [];
        }

        return normalizedSheet;
    });
}

function pickOwnershipFields(payload, fallbackParcelId) {
    const numericParcelId = Number(payload?.parcelId ?? fallbackParcelId);
    const base = {
        parcelId: Number.isFinite(numericParcelId) ? numericParcelId : fallbackParcelId,
        possessionSheets: normalizePossessionSheets(payload?.possessionSheets)
    };

    const optionalKeys = [
        'parcelNumber',
        'cadMunicipalityId',
        'cadMunicipalityRegNum',
        'cadMunicipalityName',
        'institutionId',
        'address',
        'area',
        'buildingRemark',
        'detailSheetNumber',
        'hasBuildingRight',
        'parcelParts',
        'parcelLinks',
        'lrUnitsFromParcelLinks'
    ];

    optionalKeys.forEach((key) => {
        if (payload && payload[key] !== undefined) {
            base[key] = payload[key];
        }
    });

    return base;
}

async function fetchParcelOwnership(pool, parcelId) {
    let payloadRow = null;
    let missingRelationError = null;

    for (const queryText of OWNERSHIP_DETAIL_QUERIES) {
        try {
            const result = await pool.query(queryText, [parcelId]);
            if (result.rows.length) {
                payloadRow = result.rows[0];
                break;
            }
        } catch (error) {
            if (error && error.code === '42P01') {
                missingRelationError = error;
                continue;
            }
            const wrapped = new Error(`Failed to read cached ownership for parcel ${parcelId}`);
            wrapped.cause = error;
            throw wrapped;
        }
    }

    if (!payloadRow) {
        if (missingRelationError) {
            const configError = new Error('Ownership table is not configured in the current database.');
            configError.statusCode = 503;
            configError.cause = missingRelationError;
            throw configError;
        }
        const notFoundError = new Error('Ownership data not found for the requested parcel.');
        notFoundError.statusCode = 404;
        throw notFoundError;
    }

    let payload = payloadRow?.details;
    if (!payload) {
        const missingError = new Error('Ownership record exists but has no details payload.');
        missingError.statusCode = 404;
        throw missingError;
    }

    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (err) {
            const parseError = new Error('Cached ownership payload is not valid JSON.');
            parseError.cause = err;
            parseError.statusCode = 500;
            throw parseError;
        }
    }

    if (!payload || typeof payload !== 'object') {
        const invalidError = new Error('Cached ownership payload is missing structured data.');
        invalidError.statusCode = 500;
        throw invalidError;
    }

    return pickOwnershipFields(payload, parcelId);
}

export function setupParcelsRoute(app, pool) {
    app.get('/parcels', async (req, res) => {
        try {
            const bbox = String(req.query.bbox || '').trim();
            const coordinates = String(req.query.coordinates || '').trim();
            const parcelNumber = String(req.query.parcel_number || '').trim();
            const parcelIdentifier = String(req.query.parcel_identifier || '').trim();

            // Validate that at least one parameter is provided
            if (!bbox && !coordinates && !parcelNumber && !parcelIdentifier) {
                return res.status(400).json({ error: 'Missing required parameter. Provide either bbox, coordinates, parcel_number, or parcel_identifier.' });
            }

            // Validate that only one parameter is provided
            const paramCount = [bbox, coordinates, parcelNumber, parcelIdentifier].filter(p => p).length;
            if (paramCount > 1) {
                return res.status(400).json({ error: 'Provide only one parameter: bbox, coordinates, parcel_number, or parcel_identifier.' });
            }

            let sql, params;

            if (bbox) {
                // Handle bbox parameter
                const parts = bbox.split(',').map(n => Number(n));
                if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
                    return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

                sql = `
                    SELECT
                        CESTICA_ID,
                        BROJ_CESTICE,
                        MATICNI_BROJ_KO,
                        ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry,
                        ST_Area(geom) AS calculated_area
                    FROM parcel
                    WHERE 1=1
                    AND current=true
                    AND geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                    AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                    LIMIT 2000
                `;
                params = [minX, minY, maxX, maxY];
            } else if (coordinates) {
                // Handle coordinates parameter
                const parts = coordinates.split(',').map(n => Number(n));
                if (parts.length !== 2 || parts.some(v => !isFinite(v))) {
                    return res.status(400).json({ error: 'Invalid coordinates. Expected x,y format.' });
                }
                const [x, y] = parts;

                // Detect coordinate system based on value ranges
                // WGS84: longitude -180 to 180, latitude -90 to 90
                // EPSG:3765 (HTRS96/TM): x ~400000-800000, y ~4000000-5000000
                const isWGS84 = (x >= -180 && x <= 180 && y >= -90 && y <= 90);
                const isHTRS96 = (x >= 300000 && x <= 900000 && y >= 4000000 && y <= 5500000);

                if (!isWGS84 && !isHTRS96) {
                    return res.status(400).json({
                        error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
                    });
                }

                if (isWGS84) {
                    // Transform from WGS84 (EPSG:4326) to HTRS96/TM (EPSG:3765)
                    sql = `
                        SELECT
                            CESTICA_ID,
                            BROJ_CESTICE,
                            MATICNI_BROJ_KO,
                            ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry,
                            ST_Area(geom) AS calculated_area
                        FROM parcel
                        WHERE 1=1
                        AND current=true
                        AND ST_Contains(geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765))
                        LIMIT 1
                    `;
                } else {
                    // Use coordinates as-is (already in EPSG:3765)
                    sql = `
                        SELECT
                            CESTICA_ID,
                            BROJ_CESTICE,
                            MATICNI_BROJ_KO,
                            ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry,
                            ST_Area(geom) AS calculated_area
                        FROM parcel
                        WHERE 1=1
                        AND current=true
                        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 3765))
                        LIMIT 1
                    `;
                }
                params = [x, y];
            } else if (parcelNumber) {
                // Handle parcel_number parameter - search by broj_cestice
                sql = `
                    SELECT
                        p.CESTICA_ID,
                        p.BROJ_CESTICE,
                        p.MATICNI_BROJ_KO,
                        ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
                        ST_Area(p.geom) AS calculated_area,
                        cm.naziv AS cadastral_municipality_name,
                        cm.maticni_broj AS cadastral_municipality_id
                    FROM parcel p
                    LEFT JOIN cadastral_municipality cm ON p.maticni_broj_ko = cm.maticni_broj
                    WHERE p.BROJ_CESTICE = $1
                    AND p.current = true
                    AND cm.grad_opcina = 'ZAGREB'
                    ORDER BY p.CESTICA_ID
                `;
                params = [parcelNumber];
            } else if (parcelIdentifier) {
                // Handle parcel_identifier (BROJ_CESTICE-MATICNI_BROJ_KO)
                const hyphenIndex = parcelIdentifier.lastIndexOf('-');
                if (hyphenIndex === -1) {
                    return res.status(400).json({ error: 'Invalid parcel_identifier. Expected format parcel_number-maticni_broj_ko.' });
                }

                const numberPart = parcelIdentifier.slice(0, hyphenIndex).trim();
                const municipalityPart = parcelIdentifier.slice(hyphenIndex + 1).trim();

                if (!numberPart || !municipalityPart) {
                    return res.status(400).json({ error: 'Invalid parcel_identifier. Both parcel number and cadastral municipality id are required.' });
                }

                sql = `
                    SELECT
                        p.CESTICA_ID,
                        p.BROJ_CESTICE,
                        p.MATICNI_BROJ_KO,
                        ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
                        ST_Area(p.geom) AS calculated_area,
                        cm.naziv AS cadastral_municipality_name,
                        cm.maticni_broj AS cadastral_municipality_id
                    FROM parcel p
                    LEFT JOIN cadastral_municipality cm ON p.maticni_broj_ko = cm.maticni_broj
                    WHERE p.BROJ_CESTICE = $1
                    AND p.MATICNI_BROJ_KO = $2
                    AND p.current = true
                    ORDER BY p.CESTICA_ID
                `;
                params = [numberPart, municipalityPart];
            }

            const { rows } = await pool.query(sql, params);

            // Build GeoJSON FeatureCollection with expected property names
            const features = rows.map(r => ({
                type: 'Feature',
                properties: {
                    CESTICA_ID: String((r.cestica_id ?? r.cesticaid ?? r.cestica) || ''),
                    BROJ_CESTICE: String((r.broj_cestice ?? r.brojcestice) || ''),
                    MATICNI_BROJ_KO: String(r.maticni_broj_ko || ''),
                    calculatedArea: Number(r.calculated_area) || undefined,
                    // Include cadastral municipality info if available
                    ...(r.cadastral_municipality_name && {
                        cadastralMunicipality: {
                            id: r.cadastral_municipality_id,
                            name: r.cadastral_municipality_name
                        }
                    })
                },
                geometry: r.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/parcels/:parcelId/ownership', async (req, res) => {
        const parcelId = (req.params.parcelId || '').trim();
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required in the path.' });
        }
        if (!/^[A-Za-z0-9-]+$/.test(parcelId)) {
            return res.status(400).json({ error: 'parcelId may only contain letters, numbers, or dashes.' });
        }

        try {
            const ownership = await fetchParcelOwnership(pool, parcelId);
            res.json(ownership);
        } catch (error) {
            const upstreamStatus = error?.statusCode;
            const statusCode = upstreamStatus === 404
                ? 404
                : upstreamStatus === 400
                    ? 400
                    : upstreamStatus === 504
                        ? 504
                        : upstreamStatus
                            ? 502
                            : (error?.name === 'AbortError' ? 504 : 500);

            const message = statusCode === 404
                ? 'Ownership data not found for the requested parcel.'
                : statusCode === 400
                    ? 'Upstream data source rejected the request.'
                    : statusCode === 504
                        ? 'Ownership data request timed out.'
                        : 'Failed to retrieve parcel ownership information.';

            console.error(`Error in /parcels/${parcelId}/ownership:`, error);
            res.status(statusCode).json({ error: message });
        }
    });
}
