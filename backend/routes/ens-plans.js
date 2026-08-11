// Named-plan CRUD: a globally-unique, mutable name for a set of proposal ids,
// resolvable as <slug>.proposals.urbangametheory.eth (see ens.js gateway).
// Created from the "Share entire plan" flow. Mutation is gated by an edit token
// returned once at creation (no wallet needed).
import { createHash, randomBytes } from 'node:crypto';

const ENS_NAMESPACE = 'proposals.urbangametheory.eth';
// A named plan resolves to `<publicBaseUrl>/proposals/<id,id,id…>` (see ens.js), and that string is
// what the ENS `url` text record hands a browser. So the real limit is the LENGTH of that link, not
// a count — the count was 50, which is a fifth of an ordinary plan here and refused naming outright.
//
// 1800 leaves room under the ~2000 characters that proxies and older browsers can be relied on for,
// with 150 of it reserved for the base URL this file cannot see. A count cap alone goes quietly
// wrong as ids grow: 300 four-digit ids fit comfortably, 300 seven-digit ones do not.
const MAX_PROPOSALS = 1000;
const MAX_RESOLVED_URL = 1800;
const BASE_URL_ALLOWANCE = 150;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/; // 3–63 chars, no edge hyphen
const NUMERIC_LABEL_RE = /^[0-9]+(-[0-9]+)*$/;          // reserved for proposal ids
const PROPOSAL_ID_RE = /^[0-9]+$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function validateSlug(raw) {
    const slug = (raw || '').toString().trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return { error: 'Invalid name. Use 3–63 chars: a–z, 0–9, hyphens (not at the ends).' };
    if (NUMERIC_LABEL_RE.test(slug)) return { error: 'Name cannot be only digits/hyphens (those are reserved for proposal ids).' };
    return { slug };
}

function validateProposalIds(value) {
    if (!Array.isArray(value) || value.length === 0) return { error: 'proposalIds must be a non-empty array.' };
    if (value.length > MAX_PROPOSALS) return { error: `Too many proposals (max ${MAX_PROPOSALS}).` };
    const ids = value.map((v) => (v === undefined || v === null ? '' : v.toString().trim()));
    if (!ids.every((id) => PROPOSAL_ID_RE.test(id))) return { error: 'Each proposal id must be a numeric (minted) id.' };

    const unique = [...new Set(ids)];
    // Measured on the deduplicated list, because that is what the link will actually carry.
    const linkLength = BASE_URL_ALLOWANCE + '/proposals/'.length + unique.join(',').length;
    if (linkLength > MAX_RESOLVED_URL) {
        // Say how far over, and roughly what fits — "too long" alone leaves you guessing at how
        // many to drop.
        const perId = Math.max(2, Math.round(unique.join(',').length / unique.length));
        const fits = Math.floor((MAX_RESOLVED_URL - BASE_URL_ALLOWANCE - '/proposals/'.length) / perId);
        return {
            error: `That plan's link would be ${linkLength} characters, over the ${MAX_RESOLVED_URL} a `
                + `name can carry. ${unique.length} proposals is about ${unique.length - fits} too many `
                + `— roughly ${fits} fit.`
        };
    }
    return { ids: unique };
}

const planView = (row) => ({
    slug: row.slug,
    name: `${row.slug}.${ENS_NAMESPACE}`,
    proposalIds: Array.isArray(row.proposal_ids) ? row.proposal_ids : [],
    title: row.title || null,
    city: row.city || null,
    url: `/proposals/${(Array.isArray(row.proposal_ids) ? row.proposal_ids : []).join(',')}`,
});

export function setupEnsPlansRoute(app, pool) {
    // Availability / fetch a named plan.
    app.get('/plans/:slug', async (req, res) => {
        const { slug } = validateSlug(req.params.slug);
        if (!slug) return res.status(404).json({ error: 'Not found' });
        const { rows } = await pool.query('SELECT * FROM ens_plan WHERE slug = $1 LIMIT 1', [slug]);
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(planView(rows[0]));
    });

    // Create a named plan; returns the editToken once (store it to edit later).
    app.post('/plans', async (req, res) => {
        const { slug, error: slugErr } = validateSlug(req.body?.slug);
        if (slugErr) return res.status(400).json({ error: slugErr });
        const { ids, error: idErr } = validateProposalIds(req.body?.proposalIds);
        if (idErr) return res.status(400).json({ error: idErr });
        const title = req.body?.title ? req.body.title.toString().slice(0, 200) : null;
        const city = req.body?.city ? req.body.city.toString().slice(0, 32) : null;

        const editToken = randomBytes(24).toString('hex');
        try {
            const { rows } = await pool.query(
                `INSERT INTO ens_plan (slug, proposal_ids, title, city, edit_token_hash, creator_ip, creator_fingerprint)
                 VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7) RETURNING *`,
                [slug, JSON.stringify(ids), title, city, sha256(editToken), req.ip || null, req.body?.fingerprint || null],
            );
            res.status(201).json({ ...planView(rows[0]), editToken });
        } catch (e) {
            if (e.code === '23505') return res.status(409).json({ error: 'That name is taken.' });
            throw e;
        }
    });

    // Update a named plan (mutable) — requires the edit token.
    app.put('/plans/:slug', async (req, res) => {
        const { slug } = validateSlug(req.params.slug);
        if (!slug) return res.status(404).json({ error: 'Not found' });
        const editToken = req.body?.editToken;
        if (!editToken) return res.status(400).json({ error: 'editToken required.' });

        const { rows } = await pool.query('SELECT * FROM ens_plan WHERE slug = $1 LIMIT 1', [slug]);
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        if (sha256(editToken.toString()) !== rows[0].edit_token_hash) {
            return res.status(403).json({ error: 'Invalid edit token.' });
        }

        const sets = [];
        const params = [];
        if (req.body.proposalIds !== undefined) {
            const { ids, error } = validateProposalIds(req.body.proposalIds);
            if (error) return res.status(400).json({ error });
            params.push(JSON.stringify(ids));
            sets.push(`proposal_ids = $${params.length}::jsonb`);
        }
        if (req.body.title !== undefined) {
            params.push(req.body.title ? req.body.title.toString().slice(0, 200) : null);
            sets.push(`title = $${params.length}`);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

        params.push(slug);
        const { rows: updated } = await pool.query(
            `UPDATE ens_plan SET ${sets.join(', ')}, updated_at = now() WHERE slug = $${params.length} RETURNING *`,
            params,
        );
        res.json(planView(updated[0]));
    });
}
