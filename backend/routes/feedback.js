// A private maintainer inbox, shared by the web form and MCP. Reports are never publicly listed.
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';

export function validateFeedback(body) {
    const invalid = message => ({ error: message });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Provide a feedback object.');
    if (!['bug', 'feedback'].includes(body.kind)) return invalid('kind must be bug or feedback.');
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000) return invalid('message must contain 1–8000 characters.');
    if (body.reportId != null && (typeof body.reportId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.reportId))) return invalid('reportId must be a UUID.');
    const source = body.source ?? 'api';
    if (!['web', 'mcp', 'api'].includes(source)) return invalid('source must be web, mcp or api.');
    let pageUrl = null;
    if (body.pageUrl != null && body.pageUrl !== '') {
        if (typeof body.pageUrl !== 'string' || body.pageUrl.length > 2048) return invalid('pageUrl must be an HTTP(S) URL of at most 2048 characters.');
        try {
            const url = new URL(body.pageUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return invalid('pageUrl must be an HTTP(S) URL without credentials.');
            url.hash = ''; // Private draft fragments can contain an entire unpublished design.
            pageUrl = url.href;
        } catch { return invalid('pageUrl must be an HTTP(S) URL.'); }
    }
    return { value: { id: body.reportId || randomUUID(), kind: body.kind, message: body.message.trim(), pageUrl, source } };
}

export function setupFeedbackRoute(app, pool, { requestLimit = 30, onReceived = () => {} } = {}) {
    const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: requestLimit, standardHeaders: 'draft-7', legacyHeaders: false,
        message: { code: 'feedback-rate-limited', error: 'Too many reports; please try again later.' } });
    app.post('/feedback', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { value, error } = validateFeedback(req.body);
        if (error) return res.status(400).json({ code: 'invalid-feedback', error });
        try {
            // A client keeps its reportId when retrying after a lost response. Reusing an ID for
            // different content is refused rather than overwriting a report or returning its text.
            const { rows } = await pool.query(`
                INSERT INTO consensus.feedback AS existing (id, kind, message, page_url, source)
                VALUES ($1::uuid, $2, $3, $4, $5)
                ON CONFLICT (id) DO UPDATE SET id = existing.id
                WHERE existing.kind = EXCLUDED.kind AND existing.message = EXCLUDED.message
                    AND existing.page_url IS NOT DISTINCT FROM EXCLUDED.page_url AND existing.source = EXCLUDED.source
                RETURNING id, created_at`, [value.id, value.kind, value.message, value.pageUrl, value.source]);
            if (!rows.length) return res.status(409).json({ code: 'feedback-id-conflict', error: 'This reportId was already used for different feedback.' });
            // Delivery is independent of the receipt: a stored report stays saved if Telegram
            // is unavailable. A wake-up is only a hint; pending work is retained in the database.
            try { onReceived(); } catch { console.error('[feedback] notification wake-up failed; report remains saved'); }
            return res.status(201).json({ report: { id: rows[0].id, status: 'received', createdAt: rows[0].created_at } });
        } catch {
            // Do not log the report text or connection details.
            console.error(`[${new Date().toISOString()}] [feedback] storing report failed`);
            return res.status(503).json({ code: 'feedback-unavailable', error: 'Your report was not saved. Please retry with the same reportId.' });
        }
    });
}
