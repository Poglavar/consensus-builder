// Anonymous betting funnel events. This is deliberately separate from chain-backed /agent/activity:
// browser interactions are analytics, while only confirmed transactions belong in public activity.
import rateLimit from 'express-rate-limit';

export const BET_EVENT_NAMES = Object.freeze([
    'entry', 'discovery', 'market_open', 'comparison_view', 'agreement_open', 'quote',
    'action_start', 'action_status', 'action_end', 'position_view', 'share', 'return', 'close',
    'asset_select', 'standings_view', 'public_positions_view'
]);
const ACTIONS = new Set(['create', 'buy', 'sell', 'resolve', 'claim', 'stake', 'link-wallet', 'check-receipt']);
const SIDES = new Set(['yes', 'no']);
const RESULTS = new Set(['started', 'preparing', 'awaiting_signature', 'submitted', 'confirmed', 'succeeded', 'failed', 'cancelled', 'unknown']);
const ASSETS = new Set(['points', 'devnet-usdc']);
const MODES = new Set(['visitor', 'simulated']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;
const FIELDS = new Set([
    'id', 'visitorId', 'sessionId', 'actorMode', 'simulationRun', 'occurredAt', 'name', 'city',
    'agreementAccount', 'agreementCid', 'action', 'side', 'result', 'asset', 'entryPoint', 'errorCode'
]);

function validSlug(value, max) { return typeof value === 'string' && value.length <= max && SLUG.test(value); }
function validIso(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) return false;
    const datePart = value.slice(0, 10);
    return new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) === datePart;
}
function optionalText(value, max) {
    return value === undefined || value === null || (typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
}
function optionalEnum(value, values) { return value === undefined || value === null || values.has(value); }

export function validateBetEvents(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'events')) {
        return { error: 'body must contain only an events array' };
    }
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) {
        return { error: 'events must contain 1–20 events' };
    }
    const seen = new Set();
    const events = [];
    for (const [index, event] of body.events.entries()) {
        const invalid = message => ({ error: `events[${index}].${message}` });
        if (!event || typeof event !== 'object' || Array.isArray(event)) return invalid('must be an object');
        if (Object.keys(event).some(key => !FIELDS.has(key))) return invalid('contains an unsupported field');
        if (typeof event.id !== 'string' || !UUID.test(event.id)) return invalid('id must be a UUID');
        if (seen.has(event.id)) return invalid('id must be unique within the batch');
        seen.add(event.id);
        if (typeof event.visitorId !== 'string' || !UUID.test(event.visitorId)) return invalid('visitorId must be a UUID');
        if (typeof event.sessionId !== 'string' || !UUID.test(event.sessionId)) return invalid('sessionId must be a UUID');
        if (!MODES.has(event.actorMode)) return invalid('actorMode must be visitor or simulated');
        if (event.actorMode === 'simulated' ? !validSlug(event.simulationRun, 40) : event.simulationRun !== undefined && event.simulationRun !== null) {
            return invalid('simulationRun is required only for simulated actors');
        }
        if (!validIso(event.occurredAt)) {
            return invalid('occurredAt must be an ISO date/time');
        }
        if (!BET_EVENT_NAMES.includes(event.name)) return invalid('name is not allowed');
        if (!optionalText(event.city, 80)) return invalid('city must be at most 80 characters');
        if (event.agreementAccount != null && (typeof event.agreementAccount !== 'string' || !ACCOUNT.test(event.agreementAccount))) {
            return invalid('agreementAccount must be a base58 account address');
        }
        if (!optionalText(event.agreementCid, 120)) return invalid('agreementCid must be at most 120 characters');
        if (!optionalEnum(event.action, ACTIONS)) return invalid('action is not allowed');
        if (!optionalEnum(event.side, SIDES)) return invalid('side must be yes, no, or null');
        if (!optionalEnum(event.result, RESULTS)) return invalid('result is not allowed');
        if (!optionalEnum(event.asset, ASSETS)) return invalid('asset must be points, devnet-usdc, or null');
        if (event.entryPoint != null && !validSlug(event.entryPoint, 40)) return invalid('entryPoint must be a slug of at most 40 characters');
        if (event.errorCode != null && !validSlug(event.errorCode, 80)) return invalid('errorCode must be a slug of at most 80 characters');
        events.push({
            id: event.id, visitorId: event.visitorId, sessionId: event.sessionId, actorMode: event.actorMode,
            simulationRun: event.simulationRun ?? null, occurredAt: event.occurredAt, name: event.name,
            city: event.city ?? null, agreementAccount: event.agreementAccount ?? null,
            agreementCid: event.agreementCid ?? null, action: event.action ?? null, side: event.side ?? null,
            result: event.result ?? null, asset: event.asset ?? null, entryPoint: event.entryPoint ?? null,
            errorCode: event.errorCode ?? null
        });
    }
    return { value: events };
}

function parseSince(value, now) {
    if (value === undefined) return new Date(now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (!validIso(value)) return null;
    return new Date(value).toISOString();
}

export function setupBetsEventsRoute(app, pool, options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const limiter = options.rateLimiter || rateLimit({
        windowMs: 60_000, limit: options.requestLimit ?? 180,
        standardHeaders: true, legacyHeaders: false,
        message: { error: 'rate_limited', message: 'Too many betting telemetry requests.' }
    });

    app.post('/bets/events', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { value, error } = validateBetEvents(req.body);
        if (error) return res.status(400).json({ error: 'invalid_events', message: error });
        let client;
        try {
            client = typeof pool.connect === 'function' ? await pool.connect() : pool;
            await client.query('BEGIN');
            const dbEvents = value.map(event => ({
                id: event.id, visitor_id: event.visitorId, session_id: event.sessionId,
                actor_mode: event.actorMode, simulation_run: event.simulationRun,
                occurred_at: event.occurredAt, name: event.name, city: event.city,
                agreement_account: event.agreementAccount, agreement_cid: event.agreementCid,
                action: event.action, side: event.side, result: event.result, asset: event.asset,
                entry_point: event.entryPoint, error_code: event.errorCode
            }));
            const { rows } = await client.query(`
                INSERT INTO consensus.bet_event AS existing (
                    id, visitor_id, session_id, actor_mode, simulation_run, occurred_at, name, city,
                    agreement_account, agreement_cid, action, side, result, asset, entry_point, error_code
                )
                SELECT event.id, event.visitor_id, event.session_id, event.actor_mode, event.simulation_run,
                    event.occurred_at, event.name, event.city, event.agreement_account, event.agreement_cid,
                    event.action, event.side, event.result, event.asset, event.entry_point, event.error_code
                FROM jsonb_to_recordset($1::jsonb) AS event(
                    id uuid, visitor_id uuid, session_id uuid, actor_mode text, simulation_run text,
                    occurred_at timestamptz, name text, city text, agreement_account text, agreement_cid text,
                    action text, side text, result text, asset text, entry_point text, error_code text
                )
                ON CONFLICT (id) DO UPDATE SET id = existing.id
                WHERE existing.visitor_id = EXCLUDED.visitor_id
                  AND existing.session_id = EXCLUDED.session_id
                  AND existing.actor_mode = EXCLUDED.actor_mode
                  AND existing.simulation_run IS NOT DISTINCT FROM EXCLUDED.simulation_run
                  AND existing.occurred_at = EXCLUDED.occurred_at
                  AND existing.name = EXCLUDED.name
                  AND existing.city IS NOT DISTINCT FROM EXCLUDED.city
                  AND existing.agreement_account IS NOT DISTINCT FROM EXCLUDED.agreement_account
                  AND existing.agreement_cid IS NOT DISTINCT FROM EXCLUDED.agreement_cid
                  AND existing.action IS NOT DISTINCT FROM EXCLUDED.action
                  AND existing.side IS NOT DISTINCT FROM EXCLUDED.side
                  AND existing.result IS NOT DISTINCT FROM EXCLUDED.result
                  AND existing.asset IS NOT DISTINCT FROM EXCLUDED.asset
                  AND existing.entry_point IS NOT DISTINCT FROM EXCLUDED.entry_point
                  AND existing.error_code IS NOT DISTINCT FROM EXCLUDED.error_code
                RETURNING id`, [JSON.stringify(dbEvents)]);
            if (rows.length !== value.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'event_id_conflict', message: 'An event id was already used for different event data.' });
            }
            await client.query('COMMIT');
            return res.status(202).json({ accepted: rows.length });
        } catch (err) {
            if (client) { try { await client.query('ROLLBACK'); } catch { /* original error wins */ } }
            console.error(`[${new Date().toISOString()}] POST /bets/events failed`);
            return res.status(500).json({ error: 'event_storage_failed', message: 'Betting events could not be stored.' });
        } finally {
            if (client !== pool) client?.release?.();
        }
    });

    app.get('/bets/metrics', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const mode = req.query.mode === undefined ? 'visitor' : req.query.mode;
        if (!MODES.has(mode)) return res.status(400).json({ error: 'invalid_mode', message: 'mode must be visitor or simulated' });
        const since = parseSince(req.query.since, now);
        if (!since) return res.status(400).json({ error: 'invalid_since', message: 'since must be an ISO date/time' });
        try {
            const { rows } = await pool.query(`
                WITH scoped AS (
                    SELECT visitor_id, session_id, name, action, result
                    FROM consensus.bet_event
                    WHERE actor_mode = $1 AND received_at >= $2::timestamptz
                ), visitor_sessions AS (
                    SELECT visitor_id, count(DISTINCT session_id) AS sessions
                    FROM scoped GROUP BY visitor_id
                ), by_name AS (
                    SELECT name, count(*)::int AS count FROM scoped GROUP BY name
                ), funnel AS (
                    SELECT name, action, result, count(*)::int AS events,
                        count(DISTINCT visitor_id)::int AS visitors,
                        count(DISTINCT session_id)::int AS sessions
                    FROM scoped GROUP BY name, action, result
                )
                SELECT count(DISTINCT visitor_id)::int AS visitors,
                    count(DISTINCT session_id)::int AS sessions,
                    (SELECT count(*)::int FROM visitor_sessions WHERE sessions > 1) AS return_visitors,
                    (SELECT COALESCE(jsonb_object_agg(name, count), '{}'::jsonb) FROM by_name) AS event_counts,
                    (SELECT COALESCE(jsonb_agg(funnel ORDER BY name, action, result), '[]'::jsonb) FROM funnel) AS funnel
                FROM scoped`, [mode, since]);
            const row = rows[0] || {};
            return res.json({
                label: 'Anonymous browser activity', mode,
                window: { since, basis: 'server received_at' },
                visitors: Number(row.visitors || 0), sessions: Number(row.sessions || 0),
                returnVisitors: Number(row.return_visitors || 0), eventCounts: row.event_counts || {},
                funnel: row.funnel || []
            });
        } catch {
            console.error(`[${new Date().toISOString()}] GET /bets/metrics failed`);
            return res.status(500).json({ error: 'metrics_unavailable', message: 'Betting metrics are unavailable.' });
        }
    });
}
