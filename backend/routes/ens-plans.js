// Named-plan CRUD: a globally-unique, mutable name for a set of proposal ids,
// resolvable as <slug>.proposals.urbangametheory.eth (see ens.js gateway).
// Created from the "Share entire plan" flow. Mutation is gated by an edit token
// returned once at creation (no wallet needed).
import { createHash, randomBytes } from 'node:crypto';

const ENS_NAMESPACE = 'proposals.urbangametheory.eth';
const MAX_PROPOSALS = 50;
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
    return { ids: [...new Set(ids)] };
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
