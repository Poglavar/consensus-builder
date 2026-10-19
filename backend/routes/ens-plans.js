// Named plans: a globally-unique, IMMUTABLE name for an ordered set of proposal row IDs, resolvable as
// <slug>.proposals.urbangametheory.eth (see ens.js gateway). Created from the "Share entire plan" flow
// or by scripts. There is no update: a revision is a new plan (`<name>-v2`) that records `supersedes`.
// Each member's content is hashed at creation, so a member repaired in place later shows up as
// changed instead of silently altering a plan people bet on. Design of record: plans.md.
import { createPlanStore, membersCity } from '../plans/plan-store.js';
import { normalizeCityCode } from './proposals.js';
import { changedMembers, memberHash, nextVersionSlug, planHash } from '../plans/plan-hash.js';
import { proposalAccountOf } from '../markets/contests.js';

const ENS_NAMESPACE = 'proposals.urbangametheory.eth';
// Named plans resolve to the existing short `/proposals/<slug>` route. That route fetches the
// membership from GET /plans/:slug, so ENS text-record size is independent of plan size. Keep a
// generic member cap to bound plan reads, hashing, and persistence payloads.
const MAX_PROPOSALS = 5000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/; // 3–63 chars, no edge hyphen
const NUMERIC_LABEL_RE = /^[0-9]+(-[0-9]+)*$/;          // reserved for proposal ids
const PROPOSAL_ROW_ID_RE = /^[0-9]+$/;
// Parcel ids differ by provider (HR-335533-2895/2, a BBL, a geometry hash); they only reach a bound parameter.
const PARCEL_ID_RE = /^.{1,200}$/;
const MAX_FILTER_IDS = 500;

// A comma-separated query filter: null when absent, false when malformed or too long.
function idList(raw, pattern) {
    if (raw === undefined || raw === null || raw === '') return null;
    const ids = [...new Set(String(raw).split(',').map(id => id.trim()).filter(Boolean))];
    if (!ids.length) return null;
    if (ids.length > MAX_FILTER_IDS || !ids.every(id => pattern.test(id))) return false;
    return ids;
}

function validateSlug(raw) {
    const slug = (raw || '').toString().trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return { error: 'Invalid name. Use 3–63 chars: a–z, 0–9, hyphens (not at the ends).' };
    if (NUMERIC_LABEL_RE.test(slug)) return { error: 'Name cannot be only digits/hyphens (those are reserved for proposal ids).' };
    return { slug };
}

function validateProposalRowIds(value) {
    if (!Array.isArray(value) || value.length === 0) return { error: 'proposalRowIds must be a non-empty array.' };
    const ids = value.map((v) => (v === undefined || v === null ? '' : v.toString().trim()));
    if (!ids.every((id) => PROPOSAL_ROW_ID_RE.test(id))) return { error: 'proposalRowIds must contain database row IDs (digits), not authored IDs or chain references.' };

    const unique = [...new Set(ids)];
    if (unique.length > MAX_PROPOSALS) return { error: `Too many proposals (max ${MAX_PROPOSALS}).` };
    return { ids: unique };
}

const text = (value, max) => (value === undefined || value === null || value === '' ? null : value.toString().trim().slice(0, max) || null);

const planView = (row) => ({
    slug: row.slug,
    name: `${row.slug}.${ENS_NAMESPACE}`,
    proposalRowIds: Array.isArray(row.proposal_ids) ? row.proposal_ids : [],
    title: row.title || null,
    description: row.description || null,
    author: row.author || null,
    place: row.place || null,
    city: row.city || null,
    planHash: row.plan_hash || null,
    supersedes: row.supersedes || null,
    onchain: row.onchain_data || null,
    // The plan's own Solana proposal account once minted: its betting pool (markets/contests.js).
    proposalAccount: proposalAccountOf(row.onchain_data),
    mintable: row.has_site === true,
    createdAt: row.created_at || null,
    // Listing only: how many proposals the plan names, and whether a later version replaces it.
    ...(row.member_count === undefined ? {} : { memberCount: Number(row.member_count) }),
    ...(row.superseded === undefined ? {} : { superseded: row.superseded === true }),
    url: `/proposals/${row.slug}`,
});

export function setupEnsPlansRoute(app, pool, { store = createPlanStore(pool) } = {}) {
    // Plans of a city, newest first (the Bets sheet groups them into contests). ?proposal_row_ids=1,2
    // narrows to the plans naming any of those proposal rows (which plans a proposal is part of);
    // ?parcel_ids=a,b to the plans with a member on any of those cadastral parcels.
    app.get('/plans', async (req, res) => {
        if (Object.prototype.hasOwnProperty.call(req.query, 'proposal_ids')) {
            return res.status(400).json({ error: 'Use proposal_row_ids to filter plans by database row IDs.' });
        }
        const city = normalizeCityCode(text(req.query.city, 32));
        const proposalRowIds = idList(req.query.proposal_row_ids, PROPOSAL_ROW_ID_RE);
        const parcelIds = idList(req.query.parcel_ids, PARCEL_ID_RE);
        if (proposalRowIds === false || parcelIds === false) {
            return res.status(400).json({ error: `proposal_row_ids are database row IDs and parcel_ids cadastral IDs, at most ${MAX_FILTER_IDS} of each.` });
        }
        const rows = await store.list(city, { proposalRowIds, parcelIds });
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
                    ? { proposalRowId: String(id), authoredProposalId: member.proposal_id, title: member.title, type: member.type,
                        goal: member.goal, changed: changed.has(String(id)) }
                    : { proposalRowId: String(id), missing: true, changed: row.member_hashes ? true : false };
            }),
        });
    });

    // Name a plan. Immutable from here on; a taken name answers 409 with the next free `-vN`.
    app.post('/plans', async (req, res) => {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'proposalIds')) {
            return res.status(400).json({ error: 'Use proposalRowIds to name the database rows in the plan.' });
        }
        const { slug, error: slugErr } = validateSlug(req.body?.slug);
        if (slugErr) return res.status(400).json({ error: slugErr });
        const { ids, error: idErr } = validateProposalRowIds(req.body?.proposalRowIds);
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
                slug, proposalRowIds: ids, memberHashes,
                // Over stable proposal ids, not row ids: the same plan hashes the same in every database.
                planHash: planHash(ids.map(id => ({ proposalId: byId.get(id).proposal_id, hash: memberHashes[id] }))),
                title: text(req.body?.title, 200), description: text(req.body?.description, 4000),
                author: text(req.body?.author, 200), place: text(req.body?.place, 120),
                // where its members' sites are, not the view it was named from (location-first.md phase 4)
                city: membersCity(members, ids) || normalizeCityCode(text(req.body?.city, 32)),
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
