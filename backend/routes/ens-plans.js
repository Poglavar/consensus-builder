// Named plans: a globally-unique, IMMUTABLE name for an ordered set of proposal ids, resolvable as
// <slug>.proposals.urbangametheory.eth (see ens.js gateway). Created from the "Share entire plan" flow
// or by scripts. There is no update: a revision is a new plan (`<name>-v2`) that records `supersedes`.
// Each member's content is hashed at creation, so a member repaired in place later shows up as
// changed instead of silently altering a plan people bet on. Design of record: plans.md.
import { createPlanStore } from '../plans/plan-store.js';
import { changedMembers, memberHash, nextVersionSlug, planHash } from '../plans/plan-hash.js';

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

const text = (value, max) => (value === undefined || value === null || value === '' ? null : value.toString().trim().slice(0, max) || null);

const planView = (row) => ({
    slug: row.slug,
    name: `${row.slug}.${ENS_NAMESPACE}`,
    proposalIds: Array.isArray(row.proposal_ids) ? row.proposal_ids : [],
    title: row.title || null,
    description: row.description || null,
    author: row.author || null,
    place: row.place || null,
    city: row.city || null,
    planHash: row.plan_hash || null,
    supersedes: row.supersedes || null,
    onchain: row.onchain_data || null,
    mintable: row.has_site === true,
    createdAt: row.created_at || null,
    url: `/proposals/${(Array.isArray(row.proposal_ids) ? row.proposal_ids : []).join(',')}`,
});

export function setupEnsPlansRoute(app, pool, { store = createPlanStore(pool) } = {}) {
    // Plans of a city, newest first (the Bets sheet groups them into contests).
    app.get('/plans', async (req, res) => {
        const city = text(req.query.city, 32);
        const rows = await store.list(city);
        res.json({ plans: rows.map(planView) });
    });

    // Fetch a named plan, with each member checked against the content the plan was named with.
    app.get('/plans/:slug', async (req, res) => {
        const { slug } = validateSlug(req.params.slug);
        if (!slug) return res.status(404).json({ error: 'Not found' });
        const row = await store.plan(slug);
        if (!row) return res.status(404).json({ error: 'Not found' });
        const ids = Array.isArray(row.proposal_ids) ? row.proposal_ids : [];
        const [members, supersededBy] = await Promise.all([store.members(ids), store.supersededBy(slug)]);
        const byId = new Map(members.map(member => [String(member.id), member]));
        // Plans named before hashing existed have no member hashes: nothing to compare, nothing "changed".
        const changed = new Set(row.member_hashes ? changedMembers(row.member_hashes, members) : []);
        res.json({
            ...planView(row),
            supersededBy,
            members: ids.map(id => {
                const member = byId.get(String(id));
                return member
                    ? { id: String(id), proposalId: member.proposal_id, title: member.title, type: member.type,
                        goal: member.goal, changed: changed.has(String(id)) }
                    : { id: String(id), missing: true, changed: row.member_hashes ? true : false };
            }),
        });
    });

    // Name a plan. Immutable from here on; a taken name answers 409 with the next free `-vN`.
    app.post('/plans', async (req, res) => {
        const { slug, error: slugErr } = validateSlug(req.body?.slug);
        if (slugErr) return res.status(400).json({ error: slugErr });
        const { ids, error: idErr } = validateProposalIds(req.body?.proposalIds);
        if (idErr) return res.status(400).json({ error: idErr });
        let supersedes = null;
        if (req.body?.supersedes) {
            const { slug: previous, error } = validateSlug(req.body.supersedes);
            if (error || !(await store.plan(previous))) return res.status(400).json({ error: 'supersedes must name an existing plan.' });
            supersedes = previous;
        }

        const members = await store.members(ids);
        const found = new Set(members.map(member => String(member.id)));
        const missing = ids.filter(id => !found.has(id));
        if (missing.length) return res.status(400).json({ error: `No such proposal: ${missing.slice(0, 5).join(', ')}.` });
        const byId = new Map(members.map(member => [String(member.id), member]));
        const memberHashes = Object.fromEntries(ids.map(id => [id, memberHash(byId.get(id))]));

        try {
            const row = await store.insert({
                slug, proposalIds: ids, memberHashes,
                // Over stable proposal ids, not row ids: the same plan hashes the same in every database.
                planHash: planHash(ids.map(id => ({ proposalId: byId.get(id).proposal_id, hash: memberHashes[id] }))),
                title: text(req.body?.title, 200), description: text(req.body?.description, 4000),
                author: text(req.body?.author, 200), place: text(req.body?.place, 120), city: text(req.body?.city, 32),
                supersedes, creatorIp: req.ip || null, creatorFingerprint: text(req.body?.fingerprint, 64),
            });
            res.status(201).json(planView(row));
        } catch (e) {
            if (e.code !== '23505') throw e;
            const suggestion = nextVersionSlug(slug, await store.versionsOf(slug.replace(/-v\d+$/, '')));
            res.status(409).json({ error: 'That name is taken. Named plans never change; name the revision instead.', suggestion });
        }
    });
}
