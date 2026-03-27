// GET /parcels?bbox=minX,minY,maxX,maxY OR ?coordinates=x,y OR ?parcel_number=broj_cestice OR ?parcel_identifier=broj_cestice-maticni_broj_ko OR ?parcel_id=HR-123,HR-456
// Supports both WGS84 (lon,lat) and HTRS96/TM (EPSG:3765) coordinates
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_CESTICE
// parcel_id accepts comma-separated list of parcel IDs with country prefix (e.g., "HR-333020-234/1" or "HR-123" for CESTICA_ID fallback)
// NOTE: This route is Zagreb-specific (Croatia). For Buenos Aires use /parcel-ba, for Belgrade use /parcel-bg
// The parcelId field is constructed as HR-<MATICNI_BROJ_KO>-<BROJ_CESTICE> for Zagreb parcels

// parcel_info CTE: uses the latest version per parcel (versioned, no current flag).
// Keys (maticni_broj_ko, broj_cestice) are stored directly on parcel_info rows.
function buildParcelInfoWithKeys() {
    return `
        WITH parcel_detail_with_keys AS (
            SELECT DISTINCT ON (pi.cestica_id)
                pi.details,
                pi.maticni_broj_ko,
                pi.broj_cestice
            FROM parcel_info pi
            WHERE pi.details IS NOT NULL
            ORDER BY pi.cestica_id, pi.version DESC
        )
    `;
}

// Single-parcel ownership lookup from parcel_info.
function buildParcelInfoOwnershipQuery() {
    return `
        SELECT DISTINCT ON (cestica_id) details
        FROM parcel_info
        WHERE maticni_broj_ko = $1
        AND broj_cestice = $2
        AND details IS NOT NULL
        ORDER BY cestica_id, version DESC
        LIMIT 1
    `;
}

// Batch ownership lookup from parcel_info for multiple parcels.
export function buildOwnershipDetailBatchQuery() {
    return `
        SELECT DISTINCT ON (pi.maticni_broj_ko, pi.broj_cestice)
            pi.maticni_broj_ko,
            pi.broj_cestice,
            pi.details
        FROM parcel_info pi
        JOIN (SELECT * FROM unnest($1::bigint[], $2::text[]) AS t(maticni_broj_ko, broj_cestice)) rk
          ON pi.maticni_broj_ko = rk.maticni_broj_ko
         AND pi.broj_cestice = rk.broj_cestice
        WHERE pi.details IS NOT NULL
        ORDER BY pi.maticni_broj_ko, pi.broj_cestice, pi.version DESC
    `;
}

const GOVERNMENT_OWNERSHIP_KEYWORDS = [
    'AUTOBUSNI KOLODVOR',
    'BOLNICA',
    'CISTOCA',
    'ČISTOĆA',
    'DIOKI',
    'DOM ZDRAVLJA',
    'DRUSTVENO VLASNISTVO',
    'DRUŠTVENO VLASNIŠTVO',
    'ELEKTROPRIVREDA',
    'GRAD ZAGREB',
    'GRAD KAŠTELA',
    'GRAD TROGIR',
    'GRADSKA PLINARA',
    'HEP D.D.',
    'HOLDING',
    'HRVATSKA RADIOTELEVIZIJA',
    'HRVATSKE VODE',
    'HRVATSKI OPERATOR',
    'INA MAZIVA',
    'INA-INDUSTRIJA NAFTE',
    'INA - INDUSTRIJA NAFTE',
    'INA, D.D.',
    'INFRASTRUKTURA',
    'JADRANSKI NAFTOVOD',
    'JAVNA',
    'JAVNO',
    'KLINIKA',
    'MINISTARSTVO',
    'OSNOVNA SKOLA',
    'OSNOVNA ŠKOLA',
    'REPUBLIKA HRVATSKA',
    'STUDENTSKI CENTAR',
    'STUDENTSKI DOM',
    'SREDNJA ŠKOLA',
    'SUME',
    'ŠUME',
    'SVEUCILISTE',
    'SVEUČILIŠTE',
    'TEHNICKA SKOLA',
    'TEHNIČKA ŠKOLA',
    'TVORNICA ZELJEZNICKIH VOZILA GREDELJ',
    'TVORNICA ŽELJEZNIČKIH VOZILA GREDELJ',
    'TZV GREDELJ',
    'TŽV GREDELJ',
    'VELESAJAM',
    'VODOOPSKRBA',
    'VODOPRIVREDA ZAGREB',
    'ZAGREBACKI ELEKTRICNI',
    'ZAGREBAČKI ELEKTRIČNI',
    'ZELJEZNICE',
    'ŽELJEZNICE',
    'ZRINJEVAC KOMUNALNA',
    'ZUPANIJA',
    'ŽUPANIJA'
];

const INSTITUTION_OWNERSHIP_KEYWORDS = [
    'KAPTOL',
    'CRKVA',
    'UDRUGA',
    'ASOCIJACIJA',
    'SAVEZ',
    'NADBISKUPIJA',
    'BISKUPIJA',
    'ŽUPA'
];

const COMPANY_OWNERSHIP_MARKERS = [
    'D.D.',
    'D.D',
    'D.O.O.',
    'D.O.O',
    'J.D.O.O.',
    'J.D.O.O'
];

const FRACTION_REGEX = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/;

function extractOwnershipPropsFromRow(row) {
    const raw = row?.ownership_details ?? row?.details;
    if (!raw) return {};

    let payload = raw;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (err) {
            return {};
        }
    }

    if (!payload || typeof payload !== 'object') {
        return {};
    }

    const summary = buildOwnershipSummary(payload);
    if (!summary) {
        return {};
    }

    return {
        ownershipList: summary.ownershipList,
        ownershipType: summary.ownershipType
    };
}

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

export function normalizePossessionSheets(rawSheets) {
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

function parseSharePercent(rawShare) {
    const shareText = sanitizeOwnershipString(rawShare).replace(',', '.');
    if (!shareText) {
        return null;
    }

    const percentMatch = shareText.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
    if (percentMatch) {
        const value = Number(percentMatch[1]);
        return Number.isFinite(value) ? value : null;
    }

    const fractionMatch = shareText.match(FRACTION_REGEX);
    if (fractionMatch) {
        const numerator = Number(fractionMatch[1]);
        const denominator = Number(fractionMatch[2]);
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
            return (numerator / denominator) * 100;
        }
    }

    const numericValue = Number(shareText);
    if (Number.isFinite(numericValue)) {
        // Treat values <= 1 as ratios, otherwise as direct percentages
        return numericValue <= 1 ? numericValue * 100 : numericValue;
    }

    return null;
}

function normalizeShareDistribution(rawOwners) {
    if (!Array.isArray(rawOwners) || rawOwners.length === 0) {
        return [];
    }

    const ownersWithShare = rawOwners.map(owner => ({
        ownerLabel: sanitizeOwnershipString(owner.ownerLabel),
        percentage: owner.percentage
    })).filter(owner => !!owner.ownerLabel);

    if (!ownersWithShare.length) {
        return [];
    }

    const providedShares = ownersWithShare.some(owner => Number.isFinite(owner.percentage));
    let working = ownersWithShare.map(owner => ({
        ownerLabel: owner.ownerLabel,
        percentage: Number.isFinite(owner.percentage) ? owner.percentage : null
    }));

    if (!providedShares) {
        const equalShare = 100 / working.length;
        return working.map(owner => ({
            ownerLabel: owner.ownerLabel,
            percentageShare: Number(equalShare.toFixed(4))
        }));
    }

    const totalProvided = working.reduce((sum, owner) => sum + (Number.isFinite(owner.percentage) ? owner.percentage : 0), 0);
    const scale = totalProvided > 0 ? 100 / totalProvided : 0;

    working = working.map(owner => ({
        ownerLabel: owner.ownerLabel,
        percentageShare: Number.isFinite(owner.percentage)
            ? Number((owner.percentage * scale).toFixed(4))
            : 0
    }));

    const scaledTotal = working.reduce((sum, owner) => sum + owner.percentageShare, 0);
    const diff = Number((100 - scaledTotal).toFixed(4));
    if (Math.abs(diff) > 0.0001 && working.length) {
        const last = working[working.length - 1];
        last.percentageShare = Number((last.percentageShare + diff).toFixed(4));
    }

    return working;
}

function normalizeOwnerLabel(value) {
    return sanitizeOwnershipString(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase();
}

function includesAnyKeyword(label, keywords) {
    if (!label) return false;
    return keywords.some(keyword => label.includes(keyword));
}

function classifyOwnershipType(ownerLabel) {
    const normalizedLabel = normalizeOwnerLabel(ownerLabel);
    if (!normalizedLabel) {
        return 'private individual';
    }
    if (includesAnyKeyword(normalizedLabel, GOVERNMENT_OWNERSHIP_KEYWORDS)) {
        return 'government';
    }
    if (includesAnyKeyword(normalizedLabel, INSTITUTION_OWNERSHIP_KEYWORDS)) {
        return 'institution';
    }
    if (includesAnyKeyword(normalizedLabel, COMPANY_OWNERSHIP_MARKERS)) {
        return 'company';
    }
    return 'private individual';
}

function computeOwnershipTypeFromLabels(ownerLabels) {
    const types = (ownerLabels || [])
        .map(classifyOwnershipType)
        .filter(Boolean);

    if (!types.length) {
        return 'private individual';
    }

    const unique = Array.from(new Set(types));
    return unique.length === 1 ? unique[0] : 'mixed';
}

function extractOwnershipRecords(payload) {
    // parcel_info format: upisaneOsobe[] with naziv (name) and udio (share fraction e.g. "1/2")
    if (Array.isArray(payload?.upisaneOsobe) && payload.upisaneOsobe.length > 0) {
        return payload.upisaneOsobe
            .filter(o => o?.naziv)
            .map(o => ({
                ownerLabel: sanitizeOwnershipString(o.naziv),
                ownershipRaw: sanitizeOwnershipString(o.udio || '')
            }))
            .filter(r => r.ownerLabel);
    }

    // Other city routes (BA, NYC, CO, LJ) use possessionSheets[].possessors[] format
    const normalizedSheets = normalizePossessionSheets(payload?.possessionSheets);
    const records = [];

    normalizedSheets.forEach(sheet => {
        (sheet?.possessors || []).forEach(possessor => {
            if (possessor?.name) {
                records.push({
                    ownerLabel: possessor.name,
                    ownershipRaw: possessor.ownership || ''
                });
            }
        });
    });

    if (!records.length && Array.isArray(payload?.owners)) {
        payload.owners.forEach(owner => {
            const name = sanitizeOwnershipString(owner?.name || '');
            if (name) {
                records.push({
                    ownerLabel: name,
                    ownershipRaw: sanitizeOwnershipString(owner?.ownership || owner?.actualShareText || '')
                });
            }
        });
    }

    return records;
}

export function buildOwnershipSummary(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const records = extractOwnershipRecords(payload);
    if (!records.length) {
        return null;
    }

    const ownersWithShares = records.map(record => ({
        ownerLabel: record.ownerLabel,
        percentage: parseSharePercent(record.ownershipRaw)
    })).filter(record => !!record.ownerLabel);

    const ownershipList = normalizeShareDistribution(ownersWithShares);
    if (!ownershipList.length) {
        return null;
    }

    const ownershipType = computeOwnershipTypeFromLabels(ownershipList.map(entry => entry.ownerLabel));
    return { ownershipList, ownershipType };
}

export function buildOwnershipType(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const records = extractOwnershipRecords(payload);
    if (!records.length) {
        return null;
    }

    const ownerLabels = records
        .map(record => sanitizeOwnershipString(record.ownerLabel))
        .filter(Boolean);

    if (!ownerLabels.length) {
        return null;
    }

    return computeOwnershipTypeFromLabels(ownerLabels);
}

export function pickOwnershipFields(payload, fallbackParcelId) {
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

function extractParcelKey(row) {
    const maticni = Number(row?.maticni_broj_ko);
    const broj = row?.broj_cestice;
    if (!Number.isFinite(maticni) || !broj) {
        return null;
    }
    return { maticni_broj_ko: maticni, broj_cestice: String(broj) };
}

function buildParcelSelectQuery({
    whereClause = '',
    includeMunicipality = false,
    limitClause = '',
    orderByClause = ''
} = {}) {
    const detailCte = buildParcelInfoWithKeys();
    const municipalitySelect = includeMunicipality ? `,
            cm.naziv AS cadastral_municipality_name,
            cm.maticni_broj AS cadastral_municipality_id` : '';
    const municipalityJoin = includeMunicipality ? '\n        LEFT JOIN cadastral_municipality cm ON p.maticni_broj_ko = cm.maticni_broj' : '';

    return `
        ${detailCte}
        SELECT
            p.CESTICA_ID,
            p.BROJ_CESTICE,
            p.MATICNI_BROJ_KO,
            'HR-' || p.MATICNI_BROJ_KO || '-' || p.BROJ_CESTICE AS parcelId,
            ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
            ST_Area(p.geom) AS calculated_area${municipalitySelect},
            pdx.details AS ownership_details
        FROM parcel p${municipalityJoin}
        LEFT JOIN parcel_detail_with_keys pdx
          ON pdx.maticni_broj_ko = p.maticni_broj_ko
         AND pdx.broj_cestice = p.broj_cestice
        WHERE 1=1
        AND p.current = true
        ${whereClause}
        ${orderByClause}
        ${limitClause}
    `;
}

async function fetchParcelOwnership(pool, parcelId) {
    const parcelKeyResult = await pool.query(`
        SELECT maticni_broj_ko, broj_cestice
        FROM parcel
        WHERE cestica_id = $1
        AND current = true
        LIMIT 1
    `, [parcelId]);

    const parcelKey = extractParcelKey(parcelKeyResult.rows?.[0]);
    if (!parcelKey) {
        const missingError = new Error('Ownership data not found for the requested parcel.');
        missingError.statusCode = 404;
        throw missingError;
    }

    let payloadRow = null;

    try {
        const result = await pool.query(buildParcelInfoOwnershipQuery(), [parcelKey.maticni_broj_ko, parcelKey.broj_cestice]);
        if (result.rows.length) {
            payloadRow = result.rows[0];
        }
    } catch (error) {
        if (error && error.code === '42P01') {
            const configError = new Error('Ownership table is not configured in the current database.');
            configError.statusCode = 503;
            configError.cause = error;
            throw configError;
        }
        const wrapped = new Error('Failed to read cached ownership for parcel');
        wrapped.cause = error;
        throw wrapped;
    }

    if (!payloadRow) {
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

    const ownership = pickOwnershipFields(payload, parcelId);
    const summary = buildOwnershipSummary(payload);
    if (summary) {
        ownership.ownershipList = summary.ownershipList;
        ownership.ownershipType = summary.ownershipType;
    }

    return ownership;
}

async function resolveParcelIdToCesticaId(pool, parcelId) {
    if (!parcelId) return null;

    let normalizedParcelId = parcelId.trim();

    // Remove all HR- prefixes (handle cases like HR-HR-330779-1213)
    normalizedParcelId = normalizedParcelId.replace(/^(HR-)+/i, '');

    // Check if parcelId is a numeric cestica_id
    if (/^[0-9]+$/.test(normalizedParcelId)) {
        const numeric = Number(normalizedParcelId);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
    }

    // Parse <maticni_broj_ko>-<broj_cestice> format (HR- prefix already removed)
    // broj_cestice can contain slashes (e.g. "2941/1"), so split on first dash only
    const dashIdx = normalizedParcelId.indexOf('-');
    if (dashIdx > 0) {
        const cadMunRaw = normalizedParcelId.slice(0, dashIdx).trim();
        const parcelNumber = normalizedParcelId.slice(dashIdx + 1).trim();

        if (cadMunRaw && parcelNumber) {
            const cadMun = Number(cadMunRaw);
            if (Number.isFinite(cadMun)) {
                try {
                    const lookupSql = `
                        SELECT cestica_id
                        FROM parcel
                        WHERE broj_cestice = $1
                        AND maticni_broj_ko = $2
                        AND current = true
                        LIMIT 1
                    `;
                    const { rows } = await pool.query(lookupSql, [parcelNumber, cadMun]);
                    if (rows.length && rows[0].cestica_id) {
                        return rows[0].cestica_id;
                    }
                } catch (lookupError) {
                    console.warn(`Failed to lookup cestica_id for ${parcelId}:`, lookupError);
                }
            }
        }
    } else if (dashIdx < 0) {
        // Format: <cestica_id> (fallback format, no dash)
        const cesticaIdNum = Number(normalizedParcelId);
        if (Number.isFinite(cesticaIdNum) && cesticaIdNum > 0) {
            return cesticaIdNum;
        }
    }

    return null;
}

function isValidParcelPathId(parcelId) {
    if (!parcelId) {
        return false;
    }

    let normalizedParcelId = parcelId.trim();
    normalizedParcelId = normalizedParcelId.replace(/^(HR-)+/i, '');

    if (!normalizedParcelId) {
        return false;
    }

    if (/^[0-9]+$/.test(normalizedParcelId)) {
        const numeric = Number(normalizedParcelId);
        return Number.isFinite(numeric) && numeric > 0;
    }

    const dashIdx = normalizedParcelId.indexOf('-');
    if (dashIdx <= 0) {
        return false;
    }

    const cadMunRaw = normalizedParcelId.slice(0, dashIdx).trim();
    const parcelNumber = normalizedParcelId.slice(dashIdx + 1).trim();

    return /^[0-9]+$/.test(cadMunRaw) && Boolean(parcelNumber);
}

function parseParcelLookupToken(rawParcelId) {
    let trimmed = String(rawParcelId || '').trim();
    if (!trimmed) {
        return null;
    }

    trimmed = trimmed.replace(/^(HR-)+/i, '');

    if (/^[0-9]+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) && numeric > 0
            ? { type: 'cestica_id', value: numeric }
            : null;
    }

    const dashIdx = trimmed.indexOf('-');
    if (dashIdx <= 0) {
        return null;
    }

    const cadMunRaw = trimmed.slice(0, dashIdx).trim();
    const brojCestice = trimmed.slice(dashIdx + 1).trim();
    if (!/^[0-9]+$/.test(cadMunRaw) || !brojCestice) {
        return null;
    }

    const cadMun = Number(cadMunRaw);
    return Number.isFinite(cadMun)
        ? { type: 'parcel_key', cadMun, brojCestice }
        : null;
}

export function setupParcelsRoute(app, pool) {
    // GET /parcels/parcelIds?ids=HR-313467-860/1,HR-313475-329
    // Batch fetch by parcelId strings. Returns GeoJSON FeatureCollection.
    app.get('/parcels/parcelIds', async (req, res) => {
        try {
            const rawIds = String(req.query.ids || '').trim();
            if (!rawIds) {
                return res.status(400).json({ error: 'Missing required parameter ids (comma-separated parcelIds).' });
            }

            const parsed = rawIds
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(id => {
                    const parsedId = parseParcelLookupToken(id);
                    if (!parsedId || parsedId.type !== 'parcel_key') return null;
                    return { parcelId: id, maticni: parsedId.cadMun, broj: parsedId.brojCestice };
                })
                .filter(Boolean);

            if (!parsed.length || parsed.length !== rawIds.split(',').map(s => s.trim()).filter(Boolean).length) {
                return res.status(400).json({ error: 'No valid parcelIds provided. Expected HR-<maticni_broj_ko>-<broj_cestice> format.' });
            }

            // Build VALUES list for composite match
            const valuesSql = parsed.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(',');
            const params = parsed.flatMap(p => [p.maticni, p.broj]);

            const sql = `
                SELECT
                    p.CESTICA_ID,
                    p.BROJ_CESTICE,
                    p.MATICNI_BROJ_KO,
                    'HR-' || p.MATICNI_BROJ_KO || '-' || p.BROJ_CESTICE AS parcelId,
                    ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
                    ST_Area(p.geom) AS calculated_area,
                    pd.details AS ownership_details
                FROM parcel p
                LEFT JOIN LATERAL (
                    SELECT DISTINCT ON (pi.cestica_id) pi.details
                    FROM parcel_info pi
                    WHERE pi.cestica_id = p.cestica_id
                      AND pi.details IS NOT NULL
                    ORDER BY pi.cestica_id, pi.version DESC
                    LIMIT 1
                ) pd ON TRUE
                WHERE p.current = true
                AND (p.MATICNI_BROJ_KO, p.BROJ_CESTICE) IN (${valuesSql})
            `;

            const result = await pool.query(sql, params);
            const features = result.rows.map(row => ({
                type: 'Feature',
                geometry: row.geometry,
                properties: {
                    CESTICA_ID: row.cestica_id,
                    BROJ_CESTICE: row.broj_cestice,
                    MATICNI_BROJ_KO: row.maticni_broj_ko,
                    parcelId: row.parcelid,
                    calculated_area: row.calculated_area,
                    ...extractOwnershipPropsFromRow(row)
                }
            }));

            return res.json({ type: 'FeatureCollection', features });
        } catch (error) {
            console.error('Error in GET /parcels/parcelIds:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/parcels', async (req, res) => {
        try {
            const bbox = String(req.query.bbox || '').trim();
            const coordinates = String(req.query.coordinates || '').trim();
            const parcelNumber = String(req.query.parcel_number || '').trim();
            const parcelIdentifier = String(req.query.parcel_identifier || '').trim();
            const parcelId = String(req.query.parcel_id || '').trim();

            // Validate that at least one parameter is provided
            if (!bbox && !coordinates && !parcelNumber && !parcelIdentifier && !parcelId) {
                return res.status(400).json({ error: 'Missing required parameter. Provide either bbox, coordinates, parcel_number, parcel_identifier, or parcel_id.' });
            }

            // Validate that only one parameter is provided
            const paramCount = [bbox, coordinates, parcelNumber, parcelIdentifier, parcelId].filter(p => p).length;
            if (paramCount > 1) {
                return res.status(400).json({ error: 'Provide only one parameter: bbox, coordinates, parcel_number, parcel_identifier, or parcel_id.' });
            }

            let sql, params;

            if (bbox) {
                // Handle bbox parameter
                const parts = bbox.split(',').map(n => Number(n));
                if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
                    return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

                sql = buildParcelSelectQuery({
                    whereClause: `AND p.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
        AND ST_Intersects(p.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))`,
                    limitClause: 'LIMIT 2000'
                });
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
                    sql = buildParcelSelectQuery({
                        whereClause: 'AND ST_Contains(p.geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765))',
                        limitClause: 'LIMIT 1'
                    });
                } else {
                    // Use coordinates as-is (already in EPSG:3765)
                    sql = buildParcelSelectQuery({
                        whereClause: 'AND ST_Contains(p.geom, ST_SetSRID(ST_MakePoint($1, $2), 3765))',
                        limitClause: 'LIMIT 1'
                    });
                }
                params = [x, y];
            } else if (parcelNumber) {
                // Handle parcel_number parameter - search by broj_cestice
                sql = buildParcelSelectQuery({
                    includeMunicipality: true,
                    whereClause: `AND p.BROJ_CESTICE = $1
        AND cm.grad_opcina = 'ZAGREB'`,
                    orderByClause: 'ORDER BY p.CESTICA_ID'
                });
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

                if (!/^[0-9]+$/.test(municipalityPart)) {
                    return res.status(400).json({ error: 'Invalid parcel_identifier. Cadastral municipality id must be numeric.' });
                }

                sql = buildParcelSelectQuery({
                    includeMunicipality: true,
                    whereClause: `AND p.BROJ_CESTICE = $1
        AND p.MATICNI_BROJ_KO = $2`,
                    orderByClause: 'ORDER BY p.CESTICA_ID'
                });
                params = [numberPart, municipalityPart];
            } else if (parcelId) {
                // Handle parcel_id parameter (comma-separated list of parcel IDs with country prefix, e.g., "HR-123,HR-456" or "HR-333020-234/1,HR-333020-235/2")
                const parcelIdList = parcelId.split(',').map(id => id.trim()).filter(Boolean);

                if (parcelIdList.length === 0) {
                    return res.status(400).json({ error: 'Invalid parcel_id. Provide at least one valid parcel_id.' });
                }

                // Parse each parcel_id to cestica_id
                const cesticaIdList = [];
                for (const rawParcelId of parcelIdList) {
                    const parsedToken = parseParcelLookupToken(rawParcelId);
                    if (!parsedToken) {
                        return res.status(400).json({
                            error: 'Invalid parcel_id. Expected positive numeric cestica_id values or HR-<maticni_broj_ko>-<broj_cestice>.'
                        });
                    }

                    if (parsedToken.type === 'cestica_id') {
                        cesticaIdList.push(parsedToken.value);
                        continue;
                    }

                    const lookupSql = `
                        SELECT cestica_id
                        FROM parcel
                        WHERE broj_cestice = $1
                        AND maticni_broj_ko = $2
                        AND current = true
                        LIMIT 1
                    `;

                    try {
                        const { rows } = await pool.query(lookupSql, [parsedToken.brojCestice, parsedToken.cadMun]);
                        if (rows.length && rows[0].cestica_id) {
                            cesticaIdList.push(rows[0].cestica_id);
                            continue;
                        }
                    } catch (queryError) {
                        console.warn(`Failed to lookup cestica_id for ${rawParcelId}:`, queryError);
                    }
                }

                if (cesticaIdList.length === 0) {
                    return res.status(400).json({ error: 'Invalid parcel_id. Could not resolve any valid CESTICA_ID from the provided parcel_ids.' });
                }

                // Build parameterized query with IN clause
                const placeholders = cesticaIdList.map((_, i) => `$${i + 1}`).join(',');
                sql = buildParcelSelectQuery({
                    whereClause: `AND p.CESTICA_ID IN (${placeholders})`,
                    orderByClause: 'ORDER BY p.CESTICA_ID'
                });
                params = cesticaIdList;
            }

            const { rows } = await pool.query(sql, params);

            // Build GeoJSON FeatureCollection with expected property names
            const features = rows.map(r => ({
                type: 'Feature',
                properties: {
                    CESTICA_ID: String((r.cestica_id ?? r.cesticaid ?? r.cestica) || ''),
                    BROJ_CESTICE: String((r.broj_cestice ?? r.brojcestice) || ''),
                    MATICNI_BROJ_KO: String(r.maticni_broj_ko || ''),
                    parcelId: r.parcelid || (r.maticni_broj_ko && r.broj_cestice ? `HR-${r.maticni_broj_ko}-${r.broj_cestice}` : null) || String((r.cestica_id ?? r.cesticaid ?? r.cestica) || ''),
                    calculatedArea: Number(r.calculated_area) || undefined,
                    estimatedMarketPrice: Number.isFinite(Number(r.calculated_area)) ? Number(r.calculated_area) * 100 : undefined,
                    estimatedMarketPriceCurrency: 'EUR',
                    // Include cadastral municipality info if available
                    ...(r.cadastral_municipality_name && {
                        cadastralMunicipality: {
                            id: r.cadastral_municipality_id,
                            name: r.cadastral_municipality_name
                        }
                    }),
                    ...extractOwnershipPropsFromRow(r)
                },
                geometry: r.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /parcels/:parcelId/neighbours - returns parcels that share a boundary with the requested parcel
    // Use regex to allow slashes in parcelId (e.g. HR-335649-456/1)
    app.get(/^\/parcels\/(.+)\/neighbours$/, async (req, res) => {
        const parcelId = (req.params[0] || '').trim();
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required in the path.' });
        }

        if (!isValidParcelPathId(parcelId)) {
            return res.status(400).json({
                error: 'Invalid parcelId path parameter. Expected a numeric cestica_id or HR-<maticni_broj_ko>-<broj_cestice>.'
            });
        }

        const numericParcelId = await resolveParcelIdToCesticaId(pool, parcelId);
        if (!numericParcelId) {
            return res.status(404).json({ error: 'Parcel not found.' });
        }

        const targetExists = await pool.query(
            'SELECT 1 FROM parcel WHERE cestica_id = $1 AND current = true LIMIT 1',
            [numericParcelId]
        );

        if (!targetExists.rows.length) {
            return res.status(404).json({ error: 'Parcel not found.' });
        }

        try {
            const neighbourSql = `
                WITH target AS (
                    SELECT geom
                    FROM parcel
                    WHERE cestica_id = $1
                      AND current = true
                    LIMIT 1
                )
                SELECT
                    n.cestica_id,
                    n.broj_cestice,
                    n.maticni_broj_ko,
                    'HR-' || n.maticni_broj_ko || '-' || n.broj_cestice AS parcelid,
                    ST_AsGeoJSON(ST_Transform(n.geom, 4326))::json AS geometry
                FROM target t
                JOIN parcel n
                  ON n.current = true
                 AND n.cestica_id <> $1
                 AND ST_Touches(n.geom, t.geom)
            `;

            const { rows } = await pool.query(neighbourSql, [numericParcelId]);

            const features = rows.map(row => ({
                type: 'Feature',
                geometry: row.geometry,
                properties: {
                    CESTICA_ID: String(row.cestica_id || ''),
                    BROJ_CESTICE: String(row.broj_cestice || ''),
                    MATICNI_BROJ_KO: String(row.maticni_broj_ko || ''),
                    parcelId: row.parcelid
                }
            }));

            return res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /parcels/:parcelId/neighbours:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Use regex to allow slashes in parcelId (e.g. HR-335649-456/1)
    app.get(/^\/parcels\/(.+)\/ownership$/, async (req, res) => {
        const parcelId = (req.params[0] || '').trim();
        if (!parcelId) {
            return res.status(400).json({ error: 'parcelId is required in the path.' });
        }

        if (!isValidParcelPathId(parcelId)) {
            return res.status(400).json({
                error: 'Invalid parcelId path parameter. Expected a numeric cestica_id or HR-<maticni_broj_ko>-<broj_cestice>.'
            });
        }

        let numericParcelId = null;
        let normalizedParcelId = parcelId;

        // Strip parcel part suffix (e.g., "/2", "/1") if present
        normalizedParcelId = normalizedParcelId.replace(/\/\d+$/, '');

        // Remove all HR- prefixes (handle cases like HR-HR-330779-1213)
        normalizedParcelId = normalizedParcelId.replace(/^(HR-)+/i, '');

        // Check if parcelId is a numeric cestica_id
        if (/^[0-9]+$/.test(normalizedParcelId)) {
            const numeric = Number(normalizedParcelId);
            if (Number.isFinite(numeric) && numeric > 0) {
                numericParcelId = numeric;
            }
        } else {
            // Try to parse <maticni_broj_ko>-<broj_cestice> format (HR- prefix already removed)
            const parts = normalizedParcelId.split('-');
            if (parts.length === 2) {
                const cadMunRaw = parts[0].trim();
                const parcelNumber = parts[1].trim();

                if (cadMunRaw && parcelNumber) {
                    const cadMun = Number(cadMunRaw);
                    if (Number.isFinite(cadMun)) {
                        // Query to get cestica_id from broj_cestice and maticni_broj_ko
                        try {
                            const lookupSql = `
                                SELECT cestica_id
                                FROM parcel
                                WHERE broj_cestice = $1
                                AND maticni_broj_ko = $2
                                AND current = true
                                LIMIT 1
                            `;
                            const { rows } = await pool.query(lookupSql, [parcelNumber, cadMun]);
                            if (rows.length && rows[0].cestica_id) {
                                numericParcelId = rows[0].cestica_id;
                            }
                        } catch (lookupError) {
                            console.warn(`Failed to lookup cestica_id for ${parcelId}:`, lookupError);
                        }
                    }
                }
            }
        }

        if (!numericParcelId) {
            return res.status(404).json({ error: 'Ownership data not found for the requested parcel.' });
        }

        try {
            const ownership = await fetchParcelOwnership(pool, numericParcelId);
            res.json(ownership);
        } catch (error) {
            // Handle PostgreSQL numeric value out of range error (22003) as 404
            if (error?.cause?.code === '22003') {
                return res.status(404).json({ error: 'Ownership data not found for the requested parcel.' });
            }

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

            // Only log as error if it's not a 404 (404 is expected for parcels without ownership data)
            if (statusCode === 404) {
                // Don't log 404s - they're expected for some parcels
            } else {
                console.error(`Error in /parcels/${parcelId}/ownership:`, error);
            }
            res.status(statusCode).json({ error: message });
        }
    });
}
