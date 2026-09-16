// The agent runner's ledger: checkpoints in consensus.agent_run (one row per persona per UTC day,
// which is what makes a rerun resume instead of redo) and exact per-call model costs in
// consensus.agent_cost, which the daily spend cap reads back. Schema: backend/db/agents-ddl.sql.
// SQL lives here; the cap arithmetic is pure and sits at the bottom.

// Summaries carry whatever the chain steps return, and web3/kit hand back BigInts (counter values,
// lamports); JSON.stringify throws on those, which once lost a mint that had already landed.
function toJson(value) {
    return JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

const RUN_COLUMNS = 'id, run_id, persona, day, mode, status, started_at, finished_at, stage, summary, created_at, updated_at';

function requirePool(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('a pg pool (or a client) is required');
    return pool;
}

function requireText(value, label) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
    return value;
}

// Token counts: absent means zero, but a non-integer is a bug in the usage plumbing, not a zero.
function tokenCount(value, label) {
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    return value;
}

/** One run row, or null when the run has not started. */
export async function getRun(pool, runId) {
    requirePool(pool);
    requireText(runId, 'runId');
    const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS} FROM consensus.agent_run WHERE run_id = $1`,
        [runId]
    );
    return rows[0] ?? null;
}

/** Start (or resume) a run. Idempotent: a rerun of the same run_id keeps the row and its summary. */
export async function startRun(pool, { runId, persona, day, mode } = {}) {
    requirePool(pool);
    requireText(runId, 'runId');
    requireText(persona, 'persona');
    requireText(day, 'day');
    requireText(mode, 'mode');
    const { rows } = await pool.query(
        `INSERT INTO consensus.agent_run (run_id, persona, day, mode, status)
         VALUES ($1, $2, $3::date, $4, 'running')
         ON CONFLICT (run_id) DO UPDATE SET status = 'running', updated_at = now()
         RETURNING ${RUN_COLUMNS}`,
        [runId, persona, day, mode]
    );
    if (!rows[0]) throw new Error(`startRun wrote no row for ${runId}`);
    return rows[0];
}

/**
 * Advance a run's checkpoint. `summaryPatch` is merged into `summary` with jsonb `||` — a SHALLOW
 * merge, so a patch key replaces that whole key's value (the caller passes the complete object for
 * any key it touches). `finished_at` is stamped when the status becomes terminal.
 */
export async function updateRun(pool, runId, { stage = null, status = null, summaryPatch = null } = {}) {
    requirePool(pool);
    requireText(runId, 'runId');
    if (summaryPatch !== null && (typeof summaryPatch !== 'object' || Array.isArray(summaryPatch))) {
        throw new Error('summaryPatch must be a plain object');
    }
    const { rows } = await pool.query(
        `UPDATE consensus.agent_run
            SET stage       = COALESCE($2, stage),
                status      = COALESCE($3, status),
                summary     = summary || $4::jsonb,
                finished_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE finished_at END,
                updated_at  = now()
          WHERE run_id = $1
          RETURNING ${RUN_COLUMNS}`,
        [runId, stage, status, toJson(summaryPatch ?? {})]
    );
    if (!rows[0]) throw new Error(`no consensus.agent_run row for ${runId} — startRun() first`);
    return rows[0];
}

/**
 * Insert the exact cost of each model call in one statement (UNNEST of aligned arrays).
 * `usd` is never optional: a metered call without a price would silently shrink the daily total.
 *
 * @param {Array<{item: string, provider: string, model: string, batchId?: string|null,
 *                usage?: object, usd: number}>} items
 * @returns {Promise<number>} rows inserted
 */
export async function recordCosts(pool, runId, items) {
    requirePool(pool);
    requireText(runId, 'runId');
    if (!Array.isArray(items)) throw new Error('items must be an array');
    if (items.length === 0) return 0;

    const columns = {
        item: [], provider: [], model: [], batchId: [],
        input: [], output: [], cacheRead: [], cacheCreation: [], usd: []
    };
    for (const [index, entry] of items.entries()) {
        if (!entry || typeof entry !== 'object') throw new Error(`items[${index}] must be an object`);
        if (typeof entry.usd !== 'number' || !Number.isFinite(entry.usd)) {
            throw new Error(`items[${index}].usd must be a finite number, got ${JSON.stringify(entry.usd)}`);
        }
        const usage = entry.usage ?? {};
        columns.item.push(requireText(entry.item, `items[${index}].item`));
        columns.provider.push(requireText(entry.provider, `items[${index}].provider`));
        columns.model.push(requireText(entry.model, `items[${index}].model`));
        columns.batchId.push(entry.batchId ?? null);
        columns.input.push(tokenCount(usage.input_tokens, `items[${index}].usage.input_tokens`));
        columns.output.push(tokenCount(usage.output_tokens, `items[${index}].usage.output_tokens`));
        columns.cacheRead.push(tokenCount(usage.cache_read_input_tokens, `items[${index}].usage.cache_read_input_tokens`));
        columns.cacheCreation.push(tokenCount(usage.cache_creation_input_tokens, `items[${index}].usage.cache_creation_input_tokens`));
        columns.usd.push(String(entry.usd));
    }

    const result = await pool.query(
        `INSERT INTO consensus.agent_cost
             (run_id, item, provider, model, batch_id, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, usd)
         SELECT $1, item, provider, model, batch_id, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, usd
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[],
                       $8::int[], $9::int[], $10::numeric[])
             AS t(item, provider, model, batch_id, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens, usd)`,
        [runId, columns.item, columns.provider, columns.model, columns.batchId,
            columns.input, columns.output, columns.cacheRead, columns.cacheCreation, columns.usd]
    );
    return result?.rowCount ?? items.length;
}

/**
 * Everything spent on the given UTC day, in dollars. The day bounds are pinned to UTC explicitly so
 * the number does not shift with the server's session timezone.
 */
export async function dailySpendUsd(pool, day) {
    requirePool(pool);
    requireText(day, 'day');
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(usd), 0) AS usd
           FROM consensus.agent_cost
          WHERE created_at >= (($1::date)::timestamp AT TIME ZONE 'UTC')
            AND created_at <  ((($1::date) + 1)::timestamp AT TIME ZONE 'UTC')`,
        [day]
    );
    const raw = rows[0]?.usd;
    if (raw === undefined || raw === null) return 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`consensus.agent_cost returned a non-numeric sum: ${JSON.stringify(raw)}`);
    return value;
}

/** Runs for one day (or every run, newest first, when no day is given). */
export async function listRuns(pool, { day = null } = {}) {
    requirePool(pool);
    const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS} FROM consensus.agent_run
          WHERE ($1::date IS NULL OR day = $1::date)
          ORDER BY started_at DESC`,
        [day]
    );
    return rows;
}

/** Throws when this run would push the day over the cap. Exactly at the cap is allowed. */
export function assertUnderCap({ spentUsd, estimateUsd, capUsd } = {}) {
    for (const [label, value] of [['spentUsd', spentUsd], ['estimateUsd', estimateUsd], ['capUsd', capUsd]]) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${label} must be a finite number, got ${JSON.stringify(value)}`);
        }
    }
    const total = spentUsd + estimateUsd;
    if (total > capUsd) {
        throw new Error(`daily LLM cap reached: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} = $${total.toFixed(4)} > cap $${capUsd.toFixed(4)}`);
    }
    return total;
}

/** The day's spend cap in dollars, from AGENT_LLM_DAILY_CAP_USD (default 1000). */
export function dailyCapUsd(env = {}) {
    const raw = env?.AGENT_LLM_DAILY_CAP_USD;
    if (raw === undefined || raw === null || raw === '') return 1000;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`AGENT_LLM_DAILY_CAP_USD must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return value;
}
