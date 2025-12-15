import { POSTGIS_SRID } from '../utils/helpers.js';
const DEFAULT_LIMIT = 500;

function parseBbox(bboxRaw) {
    if (!bboxRaw) return null;
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
        return null;
    }
    return parts;
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

async function humanParcelIdToDbParcelId(parcelIdRaw, pool) {
    let trimmed = (parcelIdRaw || '').trim();
    if (!trimmed) return null;

    // Strip parcel part suffix (e.g., "/2", "/1") if present
    trimmed = trimmed.replace(/\/\d+$/, '');

    // Remove all HR- prefixes (handle cases like HR-HR-330779-1213)
    trimmed = trimmed.replace(/^(HR-)+/i, '');

    // If it looks like a direct numeric cestica_id, use it.
    if (/^[0-9]+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : null;
    }

    // Croatia format: <cad_mun>-<parcel> (HR- prefix already removed)
    const parts = trimmed.split('-');
    if (parts.length !== 2) {
        return null;
    }

    const cadMunRaw = parts[0].trim();
    const parcelNumber = parts[1].trim();

    if (!cadMunRaw || !parcelNumber) {
        return null;
    }

    const cadMun = Number(cadMunRaw);
    if (!Number.isFinite(cadMun)) {
        return null;
    }

    const sql = `
        SELECT p.cestica_id
        FROM parcel p
        WHERE p.broj_cestice = $1
        AND p.maticni_broj_ko = $2
        AND p.current = true
        LIMIT 1
    `;
    const { rows } = await pool.query(sql, [parcelNumber, cadMun]);
    if (!rows.length) {
        return null;
    }
    return rows[0].cestica_id;
}

export function setupAdsRoute(app, pool) {
    app.get('/ads', async (req, res) => {
        try {
            const bboxRaw = String(req.query.bbox || '').trim();
            const parcelIdRaw = String(req.query.parcel_id || '').trim();
            const minPublicationDateRaw = String(
                req.query.min_publication_date || req.query.min_date || ''
            ).trim();

            const bbox = parseBbox(bboxRaw);
            if (bboxRaw && !bbox) {
                return res.status(400).json({
                    error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.'
                });
            }

            const minPublicationDate = parseDate(minPublicationDateRaw);
            if (minPublicationDateRaw && !minPublicationDate) {
                return res.status(400).json({
                    error: 'Invalid min_publication_date. Use an ISO-8601 date.'
                });
            }

            let parcelCesticaId = null;
            if (parcelIdRaw) {
                parcelCesticaId = await humanParcelIdToDbParcelId(parcelIdRaw, pool);
                if (parcelCesticaId === null) {
                    return res.status(404).json({
                        error: 'Parcel not found for the provided parcel_id.'
                    });
                }
            }

            if (!bbox && parcelCesticaId === null && !minPublicationDate) {
                return res.status(400).json({
                    error: 'Provide at least one filter: bbox, parcel_id, or min_publication_date.'
                });
            }

            const whereClauses = ['p.current = true'];
            const params = [];

            if (bbox) {
                const start = params.length + 1;
                // bbox is expected in WGS84; transform to dataset SRID for intersection
                const envelope = `ST_Transform(ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326), ${POSTGIS_SRID})`;
                whereClauses.push(`p.geom && ${envelope}`);
                whereClauses.push(`ST_Intersects(p.geom, ${envelope})`);
                params.push(...bbox);
            }

            if (parcelCesticaId !== null) {
                whereClauses.push(`p.cestica_id = $${params.length + 1}`);
                params.push(parcelCesticaId);
            }

            if (minPublicationDate) {
                whereClauses.push(`a.publication_date >= $${params.length + 1}`);
                params.push(minPublicationDate);
            }

            const sql = `
                SELECT
                    a.platform AS ad_platform,
                    a.id AS ad_id,
                    a.version AS ad_version,
                    a.current AS ad_current,
                    a.publication_date,
                    a.url AS ad_url,
                    a.details,
                    a.text,
                    a.images,
                    a.category,
                    a.active,
                    a.updated_at AS ad_updated_at,
                    a.updated_by AS ad_updated_by,
                    ap.ad_url AS ad_parcel_url,
                    ap.ai_model,
                    ap.ai_prompt,
                    ap.ai_response,
                    ap.parcel_score,
                    ap.updated_at AS ad_parcel_updated_at,
                    ap.updated_by AS ad_parcel_updated_by,
                    p.cestica_id,
                    p.broj_cestice,
                    p.maticni_broj_ko,
                    ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
                    (
                        (to_jsonb(p) - 'geom')
                        || jsonb_build_object(
                            'parcel_id', CONCAT('HR-', p.maticni_broj_ko, '-', p.broj_cestice),
                            'parcelId', CONCAT('HR-', p.maticni_broj_ko, '-', p.broj_cestice)
                        )
                    ) AS parcel_properties
                FROM ads.ad_parcel ap
                JOIN ads.ad a
                    ON a.platform = ap.ad_platform
                    AND a.id = ap.ad_id
                JOIN parcel p
                    ON p.cestica_id = CAST(ap.cestica_id AS bigint)
                WHERE ${whereClauses.join(' AND ')}
                ORDER BY a.publication_date DESC NULLS LAST, a.updated_at DESC NULLS LAST
                LIMIT ${DEFAULT_LIMIT};
            `;

            const { rows } = await pool.query(sql, params);

            const items = rows.map(row => ({
                parcel: {
                    ...(row.parcel_properties || {}),
                    geometry: row.geometry
                },
                ad: {
                    platform: row.ad_platform,
                    id: row.ad_id,
                    version: row.ad_version,
                    current: row.ad_current,
                    publication_date: row.publication_date,
                    url: row.ad_url,
                    details: row.details,
                    text: row.text,
                    images: row.images,
                    category: row.category,
                    active: row.active,
                    updated_at: row.ad_updated_at,
                    updated_by: row.ad_updated_by
                },
                adParcel: {
                    ad_url: row.ad_parcel_url,
                    ai_model: row.ai_model,
                    ai_prompt: row.ai_prompt,
                    ai_response: row.ai_response,
                    parcel_score: row.parcel_score,
                    updated_at: row.ad_parcel_updated_at,
                    updated_by: row.ad_parcel_updated_by
                }
            }));

            res.json({
                count: items.length,
                limit: DEFAULT_LIMIT,
                filters: {
                    bbox: bboxRaw || null,
                    parcel_id: parcelIdRaw || null,
                    min_publication_date: minPublicationDate || null
                },
                items
            });
        } catch (error) {
            console.error('Error in /ads:', error);
            res.status(500).json({ error: 'Failed to fetch ads with parcels.' });
        }
    });
}
