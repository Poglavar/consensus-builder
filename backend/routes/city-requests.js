// City requests: the world view's "Ask for this city" button. POST /cities/requests counts one
// request for a place (rate limited per IP); GET /cities/requests lists the most requested places,
// a demand signal for which parcel source to load next. Table: routes/city-requests-ddl.sql.

import rateLimit from 'express-rate-limit';

const log = (message) => console.log(`[${new Date().toISOString()}] [city-requests] ${message}`);

export const CITY_REQUEST_LIMIT_PER_HOUR = 30;
const PLACE_KEY = /^[A-Za-z0-9:._,-]{1,120}$/;

// Returns { value } or { error } for a POST body.
export function validateCityRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const placeKey = text(b.placeKey, 200);
    if (!PLACE_KEY.test(placeKey)) return { error: 'placeKey must be 1-120 characters of letters, digits and :._,-' };
    const name = text(b.name, 160);
    if (!name) return { error: 'name is required' };
    const { lat, lon } = b;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'lat must be a number in [-90, 90]' };
    if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return { error: 'lon must be a number in [-180, 180]' };
    return { value: { placeKey, name, country: text(b.country, 160) || null, lat, lon } };
}

const rowToJson = row => ({
    placeKey: row.place_key,
    name: row.name,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    requestCount: row.request_count,
    firstRequestedAt: row.first_requested_at,
    lastRequestedAt: row.last_requested_at
});

export function setupCityRequestsRoute(app, pool, { requestLimit = CITY_REQUEST_LIMIT_PER_HOUR } = {}) {
    const limiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: requestLimit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'too_many_requests', message: 'Too many city requests from this address; try again later.' }
    });

    app.post('/cities/requests', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { value, error } = validateCityRequest(req.body);
        if (error) return res.status(400).json({ error: 'invalid_request', message: error });
        try {
            const { rows } = await pool.query(
                `INSERT INTO consensus.city_request (place_key, name, country, lat, lon, request_count)
                 VALUES ($1, $2, $3, $4, $5, 1)
                 ON CONFLICT (place_key) DO UPDATE SET
                     request_count = consensus.city_request.request_count + 1,
                     last_requested_at = now(),
                     updated_at = now()
                 RETURNING place_key, name, country, lat, lon, request_count, first_requested_at, last_requested_at`,
                [value.placeKey, value.name, value.country, value.lat, value.lon]
            );
            log(`request for ${value.placeKey} (${value.name}) -> ${rows[0].request_count}`);
            res.status(201).json({ request: rowToJson(rows[0]) });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] POST /cities/requests failed:`, err);
            res.status(500).json({ error: 'Failed to record the city request' });
        }
    });

    app.get('/cities/requests', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        try {
            const { rows } = await pool.query(
                `SELECT place_key, name, country, lat, lon, request_count, first_requested_at, last_requested_at
                 FROM consensus.city_request
                 ORDER BY request_count DESC, last_requested_at DESC
                 LIMIT $1`,
                [limit]
            );
            res.json({ requests: rows.map(rowToJson) });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] GET /cities/requests failed:`, err);
            res.status(500).json({ error: 'Failed to load city requests' });
        }
    });
}
