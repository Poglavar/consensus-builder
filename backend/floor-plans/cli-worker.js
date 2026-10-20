// One explicitly invoked subscription-CLI chunk, sharing the existing readers and task identities.
import { createCliLlm } from '../../../agents/lib/llm-cost/cli.mjs';
import { DEFAULT_MAX_TOKENS } from '../../../agents/lib/llm-cost/llm.mjs';
import { eligibleListingSql, sourcePlanAssetSql } from './source-policy.js';

const TABLES = { buildings: 'building_task', images: 'image_task', plans: 'plan_task' };

export function cliTaskSelection(adapter, { taskIds = false } = {}) {
    const table = TABLES[adapter.stage];
    if (!table) throw new Error('Unknown CLI stage.');
    const currentOwner = adapter.stage === 'buildings'
        ? `t.url=l.url AND l.location->>'sourceSha256'=q.source_sha256
           AND l.location_status IN ('ambiguous','probable')
           AND jsonb_array_length(COALESCE(l.location->'candidates','[]'))>0`
        : `t.url=q.source_url AND ${sourcePlanAssetSql()}
           AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))`;
    const ownership = adapter.stage === 'images'
        ? `EXISTS (SELECT 1 FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256
             JOIN floor_plan.listing l ON ${sourcePlanAssetSql()}
               AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
             WHERE t.kind='asset' AND t.current_sha256=q.source_sha256 AND b.bytes_available)`
        : `EXISTS (SELECT 1 FROM floor_plan.listing l JOIN floor_plan.target t ON ${currentOwner}
             WHERE l.url=q.listing_url AND t.current_sha256=q.source_sha256 AND ${eligibleListingSql()})`;
    return `SELECT q.* FROM floor_plan.${table} q WHERE q.processor=$1 AND q.status='queued'
        AND NOT (q.result ? 'paidResponse') AND ${ownership}${taskIds ? ' AND q.id=ANY($3::text[])' : ''}
        ORDER BY (q.result ? 'cliResponse') DESC,q.created_at,q.id LIMIT $2`;
}

export async function runCliStage(db, adapter, {
    limit = 1, engine = 'codex', model = null, effort, taskIds = null,
    timeoutMs = 600_000, maxOutputTokens = DEFAULT_MAX_TOKENS,
    llm, log = value => console.log(JSON.stringify(value)),
} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('CLI limit must be 1..20.');
    if (!['claude', 'codex'].includes(engine)) throw new Error('CLI engine must be claude or codex.');
    if (model !== null && (typeof model !== 'string' || !model.trim())) throw new Error('Invalid CLI model.');
    if (effort !== undefined && !['medium', 'high'].includes(effort)) throw new Error('CLI effort must be medium or high.');
    if (taskIds !== null && (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 20
        || new Set(taskIds).size !== taskIds.length || taskIds.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid CLI task IDs.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw new Error('Invalid CLI timeout.');
    const table = TABLES[adapter.stage], selection = cliTaskSelection(adapter, { taskIds: taskIds !== null });
    // CLI readers may share the pipeline, while paid batch submission/collection remains exclusive.
    // Each caller needs its own connection: adapters use transactions while storing results.
    const locked = (await db.query("SELECT pg_try_advisory_lock_shared(hashtext('floor-plan-ai')) AS locked")).rows[0].locked;
    if (!locked) throw new Error('Another floor-plan recognition worker is running.');
    const result = { mode: 'subscription-cli', engine, model, effort, processor: adapter.processor, selected: 0,
        completed: 0, local: 0, replayed: 0, deferred: 0, failed: 0, costUsd: 0 };
    const requestBuilder = { batchRequest: (id, options) => ({ id, options }) };
    const add = counters => { for (const [key, value] of Object.entries(counters || {})) {
        if (typeof value === 'number') result[key] = (result[key] || 0) + value;
    } };
    try {
        const tasks = (await db.query(selection, [adapter.processor, limit, ...(taskIds === null ? [] : [taskIds])])).rows;
        for (const candidate of tasks) {
            const claimed = (await db.query("SELECT pg_try_advisory_lock(hashtext('floor-plan-cli-task'),hashtext($1)) AS locked", [candidate.id])).rows[0].locked;
            if (!claimed) { result.busy = (result.busy || 0) + 1; continue; }
            try {
                // Another reader may have finished after our initial selection. Recheck status,
                // ownership and cached responses only after holding this task's session lock.
                const task = (await db.query(cliTaskSelection(adapter, { taskIds: true }), [adapter.processor, 1, [candidate.id]])).rows[0];
                if (!task) continue;
                result.selected++;
                // A killed invocation may have consumed subscription usage. Keep that uncertainty visible.
                if (task.result?.cliAttempt && !task.result?.cliResponse) {
                    await db.query(`UPDATE floor_plan.${table} SET status='error',error=$2,updated_at=now() WHERE id=$1`,
                        [task.id, 'Unfinished CLI attempt; inspect its checkpoint before retrying.']);
                    result.deferred++; log({ task: task.id, phase: 'unfinished-cli-attempt', ...result }); continue;
                }
                const deadline = Date.now() + timeoutMs;
                try {
                    let item = task.result?.cliResponse;
                    if (item) result.replayed++;
                    else {
                        const prepared = await adapter.prepare(db, task, requestBuilder, { deadline, maxOutputTokens });
                        if (prepared.localResult) { add(prepared.localResult); result.local++; continue; }
                        if (prepared.request?.id !== task.id) throw new Error('CLI request identity mismatch.');
                        const evidence = { ...prepared.evidence, billing: { mode: 'subscription', engine },
                            cliAttempt: { startedAt: new Date().toISOString(), engine, model, effort } };
                        await db.query(`UPDATE floor_plan.${table} SET result=result||$2::jsonb,updated_at=now()
                            WHERE id=$1 AND status='queued'`, [task.id, JSON.stringify(evidence)]);
                        task.result = { ...task.result, ...evidence };
                        log({ task: task.id, phase: 'cli-started', ...result });
                        llm ||= createCliLlm({ engine, repo: 'consensus-builder', script: `floor-plan-cli-${adapter.processor}`, timeoutMs });
                        const response = await llm.complete({ ...prepared.request.options,
                            ...(model ? { model } : {}), ...(effort ? { effort } : {}), allowedTools: ['Read'] });
                        if (response.costUsd !== 0) throw new Error('Subscription CLI returned metered spend.');
                        item = { data: response.data, text: response.text, model: response.model, usage: response.usage,
                            equivalentUsd: response.equivalentUsd, costUsd: 0 };
                        // Save before domain validation: a replay never calls the model again.
                        await db.query(`UPDATE floor_plan.${table} SET result=result||$2::jsonb,usage=$3,cost_usd=0,
                            updated_at=now() WHERE id=$1`, [task.id, JSON.stringify({ cliResponse: item }), JSON.stringify(item.usage)]);
                        task.result.cliResponse = item;
                    }
                    add(await adapter.apply(db, task, item, { deadline })); result.completed++;
                } catch (error) {
                    result.failed++;
                    await db.query(`UPDATE floor_plan.${table} SET status='error',error=$2,updated_at=now() WHERE id=$1`, [task.id, error.message]);
                    log({ task: task.id, phase: 'cli-error', error: error.message, ...result });
                    // Stop this manual chunk if the subscription cannot serve calls.
                    if (/rate.?limit|usage.?limit|(?:weekly|daily|monthly)\s+limit|quota|not logged|authentication|login|credit/i.test(error.message)) break;
                }
                log({ task: task.id, phase: 'cli-checkpoint', ...result });
            } finally { await db.query("SELECT pg_advisory_unlock(hashtext('floor-plan-cli-task'),hashtext($1))", [candidate.id]); }
        }
        result.status = result.failed || result.deferred ? 'needs-attention' : 'complete';
        return result;
    } finally { await db.query("SELECT pg_advisory_unlock_shared(hashtext('floor-plan-ai'))"); }
}
