// Postgres access for named plans (ens_plan, plans.md). The route and the scripts share these queries;
// everything about what a plan MEANS lives in plan-hash.js.

// What a member builds, in the shape plan-hash.js memberContent() reads.
const MEMBER_COLUMNS = `p.id, p.proposal_id, COALESCE(p.title, p.name) AS title, p.city, p.type,
    p.proposal_data->>'goal' AS goal, ST_AsGeoJSON(p.site, 9)::json AS site, p.cadastre_parcel_ids,
    p.offer, p.offer_currency, p.is_conditional, p.expires_at,
    p.deposit_enabled, p.deposit_percent, p.decay_enabled, p.decay_percent, p.decay_duration_ms,
    p.disbursement_mode, p.proposal_data,
    p.road_proposal, p.building_proposal, p.structure_proposal, p.reparcellization,
    p.proposal_data->'geometry' AS geometry, p.onchain_data`;

const PLAN_COLUMNS = `slug, proposal_ids, title, description, author, place, city, member_hashes, plan_hash,
    supersedes, onchain_data, created_at, (site IS NOT NULL) AS has_site`;

// A plan (alias `alias`) has a member filed in the city bound to `param`.
export const PLAN_IN_CITY_SQL = (alias, param) => `EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id IN (SELECT jsonb_array_elements_text(${alias}.proposal_ids)::int) AND p.city = ${param})`;

// The city a plan is filed under: the one most of its members are filed in (their sites'), the
// earliest member's on a tie; null when none has a city.
export function membersCity(members, ids) {
    const byId = new Map(members.map(member => [String(member.id), member]));
    const counts = new Map();
    for (const id of ids) {
        const city = byId.get(String(id))?.city;
        if (city) counts.set(city, (counts.get(city) || 0) + 1);
    }
    let best = null;
    for (const [city, n] of counts) if (best === null || n > counts.get(best)) best = city;
    return best;
}

export function createPlanStore(pool) {
    return {
        async members(ids) {
            if (!ids.length) return [];
            const { rows } = await pool.query(`SELECT ${MEMBER_COLUMNS} FROM proposal p WHERE p.id = ANY($1::int[])`,
                [ids.map(Number)]);
            return rows;
        },

        async plan(slug) {
            const { rows } = await pool.query(`SELECT ${PLAN_COLUMNS} FROM ens_plan WHERE slug = $1 LIMIT 1`, [slug]);
            return rows[0] || null;
        },

        async supersededBy(slug) {
            const { rows } = await pool.query('SELECT slug FROM ens_plan WHERE supersedes = $1 ORDER BY created_at', [slug]);
            return rows.map(row => row.slug);
        },

        // Slugs already taken by versions of the same base name (harbor, harbor-v2, …).
        async versionsOf(base) {
            const { rows } = await pool.query(`SELECT slug FROM ens_plan WHERE slug = $1 OR slug LIKE $2`,
                [base, `${base.replace(/[\\%_]/g, '\\$&')}-v%`]);
            return new Set(rows.map(row => row.slug));
        },

        // Plans of a city, newest first: those with a member filed in it, i.e. a member whose site
        // lies there (location-first.md phase 4), not the city the plan was named from. proposalIds
        // keeps the plans naming any of those proposal rows; parcelIds the plans with a member
        // declaring any of those cadastral parcels. Each row carries its member count and whether a
        // later version supersedes it.
        async list(city, { proposalIds = null, parcelIds = null } = {}) {
            const { rows } = await pool.query(`SELECT ${PLAN_COLUMNS},
                    jsonb_array_length(e.proposal_ids) AS member_count,
                    EXISTS (SELECT 1 FROM ens_plan n WHERE n.supersedes = e.slug) AS superseded
                FROM ens_plan e
                WHERE ($1::text IS NULL OR ${PLAN_IN_CITY_SQL('e', '$1')})
                  AND ($2::text[] IS NULL OR e.proposal_ids ?| $2::text[])
                  AND ($3::text[] IS NULL OR EXISTS (
                      SELECT 1 FROM proposal p
                      WHERE p.id IN (SELECT jsonb_array_elements_text(e.proposal_ids)::int)
                        AND p.cadastre_parcel_ids ?| $3::text[]))
                ORDER BY e.created_at DESC LIMIT 500`,
            [city || null, proposalIds && proposalIds.length ? proposalIds : null, parcelIds && parcelIds.length ? parcelIds : null]);
            return rows;
        },

        // Inserts once; a taken slug surfaces as Postgres 23505. The site is the union of the
        // members' sites, or NULL when any member has none (such a plan cannot be minted).
        async insert(plan) {
            const { rows } = await pool.query(`
                INSERT INTO ens_plan (slug, proposal_ids, title, description, author, place, city,
                    member_hashes, plan_hash, supersedes, site, creator_ip, creator_fingerprint)
                SELECT $1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
                    CASE WHEN bool_and(p.site IS NOT NULL) THEN ST_Multi(ST_Union(p.site)) END, $11, $12
                FROM proposal p WHERE p.id = ANY($13::int[])
                RETURNING ${PLAN_COLUMNS}`,
            [plan.slug, JSON.stringify(plan.proposalIds), plan.title, plan.description, plan.author, plan.place,
                plan.city, JSON.stringify(plan.memberHashes), plan.planHash, plan.supersedes, plan.creatorIp,
                plan.creatorFingerprint, plan.proposalIds.map(Number)]);
            return rows[0];
        },

        // For the mint script: the plan's identity and its site as GeoJSON.
        async mintInput(slug) {
            const { rows } = await pool.query(`
                SELECT slug, title, city, plan_hash, onchain_data, ST_AsGeoJSON(site, 9)::json AS site
                FROM ens_plan WHERE slug = $1`, [slug]);
            return rows[0] || null;
        },

        async recordMint(slug, onchain) {
            await pool.query('UPDATE ens_plan SET onchain_data = $1::jsonb, updated_at = now() WHERE slug = $2 AND onchain_data IS NULL',
                [JSON.stringify(onchain), slug]);
        }
    };
}
