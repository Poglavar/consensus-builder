import { readFileSync } from 'node:fs';
import { landOracleStatsPath, readRunStats } from './run-stats.js';

const HOUR_MS = 3_600_000;

function asTime(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function latestRow(rows, predicate) {
    return rows.filter(predicate).reduce((latest, row) => !latest || asTime(row.started_at || row.updated_at || row.finished_at) > asTime(latest.started_at || latest.updated_at || latest.finished_at)
        ? row : latest, null);
}

function freshness(endedAt, maxAgeHours, now) {
    const ended = asTime(endedAt);
    if (!ended) return { state: 'unavailable', ageHours: null, maxAgeHours };
    const ageHours = Math.max(0, (Number(now) - ended) / HOUR_MS);
    return { state: ageHours <= maxAgeHours ? 'fresh' : 'stale', ageHours: Number(ageHours.toFixed(2)), maxAgeHours };
}

function publicAgentRun(row, { role, schedule, maxAgeHours, now }) {
    if (!row) return { role, schedule, status: 'unavailable', freshness: freshness(null, maxAgeHours, now), lastRun: null };
    const summary = row.summary && typeof row.summary === 'object' ? row.summary : {};
    const endedAt = row.finished_at || row.updated_at || null;
    const transaction = summary.support?.signature
        || Object.values(summary.posts || {}).find(item => item?.signature)?.signature
        || Object.values(summary.mints || {}).find(item => item?.signature)?.signature
        || null;
    const outcome = summary.outcome || null;
    // 'already-supported' is a deliberate no-op day for the supporter, not a failure.
    const successful = row.status === 'done' && ['completed', 'no-picks', 'no-eligible-proposal', 'already-supported'].includes(outcome);
    return {
        role,
        schedule,
        status: successful ? 'completed' : row.status || 'unknown',
        freshness: freshness(endedAt, maxAgeHours, now),
        lastRun: {
            id: row.run_id,
            persona: row.persona,
            stage: row.stage,
            outcome,
            endedAt,
            transaction
        }
    };
}

function publicLandOracle(stats, now) {
    const endedAt = stats?.endedAt || null;
    return {
        role: 'land-oracle',
        schedule: 'daily at 02:30 UTC',
        status: stats?.runStatus || 'unavailable',
        freshness: freshness(endedAt, 36, now),
        lastRun: stats ? {
            verdict: stats.verdict || null,
            endedAt,
            counters: stats.counters || null,
            error: stats.error || null
        } : null
    };
}

function publicResolver(status, now) {
    const run = status?.resolver?.lastRun || null;
    const endedAt = run?.endedAt || null;
    return {
        role: 'prospective-resolver',
        schedule: status?.resolver?.cadence || 'hourly at minute 45',
        status: run?.status || 'unavailable',
        freshness: freshness(endedAt, 3, now),
        lastRun: run ? { status: run.status || null, phase: run.phase || null, endedAt } : null
    };
}

// Society roles (agents/society-run.mjs) are optional: a deployment may not run them at all. They
// live in `optionalJobs`, never in `jobs`, so the proof audit's "every job completed and fresh" check
// is unchanged. No row = not configured; a newest row older than its window = inactive (stopped, not
// broken); only a recent run counts toward the overall status, where a failure is real attention.
export const OPTIONAL_SOCIETY_ROLES = [
    { role: 'contrarian', schedule: 'every 2 hours at minute 20 UTC', maxAgeHours: 36 },
    { role: 'speculator', schedule: 'every 3 hours at minute 40 UTC', maxAgeHours: 36 }
];
const SOCIETY_OK_OUTCOMES = ['completed', 'no-action', 'replayed', 'cap-reached'];
const CORE_AGENT_ROLES = new Set(['proposer', 'supporter', 'lens-member']);

function readConfiguredPersonas() {
    try {
        const config = JSON.parse(readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8'));
        return Array.isArray(config.personas) ? config.personas : [];
    } catch {
        return [];
    }
}

function publicSocietyRun(row, { role, schedule, maxAgeHours, now }) {
    if (!row) return { role, schedule, optional: true, configured: false, status: 'not-configured', freshness: freshness(null, maxAgeHours, now), lastRun: null };
    const summary = row.summary && typeof row.summary === 'object' ? row.summary : {};
    const endedAt = row.finished_at || row.updated_at || null;
    const execution = summary.society?.execution || {};
    const fresh = freshness(endedAt, maxAgeHours, now);
    const successful = row.status === 'done' && SOCIETY_OK_OUTCOMES.includes(summary.outcome);
    const configured = fresh.state === 'fresh';
    return {
        role,
        schedule,
        optional: true,
        configured,
        status: !configured ? 'inactive' : successful ? 'completed' : row.status || 'unknown',
        freshness: fresh,
        lastRun: {
            id: row.run_id,
            persona: row.persona,
            stage: row.stage,
            outcome: summary.outcome || null,
            turn: summary.turn ?? null,
            endedAt,
            transaction: execution.signature || execution.stakeSignature || null
        }
    };
}

function publicConfiguredAgentRun(row, persona, now) {
    const society = !CORE_AGENT_ROLES.has(persona.role);
    const common = {
        role: persona.role,
        persona: persona.name,
        schedule: society ? 'configured society schedule' : (persona.role === 'proposer' ? 'configured proposer schedule' : 'configured supporter schedule'),
        maxAgeHours: 36,
        now
    };
    if (society) return { ...publicSocietyRun(row, common), persona: persona.name };
    return { ...publicAgentRun(row, common), persona: persona.name };
}

export function buildPublicOperationsStatus({ runs = [], landOracle = null, prospective = null, now = Date.now(), configuredPersonas = readConfiguredPersonas() } = {}) {
    const latest = role => latestRow(runs, row => {
        const summaryRole = row?.summary?.role || 'proposer';
        return summaryRole === role;
    });
    // Multi-turn society invocations write several rows a day; the newest finished one is the outcome.
    const latestFinished = role => latestRow(runs, row => row?.summary?.role === role && row.status !== 'running');
    const optionalJobs = OPTIONAL_SOCIETY_ROLES.map(spec => publicSocietyRun(latestFinished(spec.role), { ...spec, now }));
    const jobs = [
        publicAgentRun(latest('proposer'), { role: 'proposer', schedule: 'every 3 hours, three proposers staggered', maxAgeHours: 36, now }),
        publicAgentRun(latest('supporter'), { role: 'supporter', schedule: 'every 3 hours at minute 45 UTC', maxAgeHours: 36, now }),
        publicLandOracle(landOracle, now),
        publicResolver(prospective, now)
    ];
    // The role-level jobs above are kept as the stable hackathon proof contract. This per-persona
    // view makes every configured proposer/society actor visible, so one builder's failure cannot
    // be hidden by another proposer's more recent success.
    const agentRuns = configuredPersonas
        .filter(persona => persona?.name && typeof persona.role === 'string'
            && (persona.role === 'proposer' || !CORE_AGENT_ROLES.has(persona.role)))
        .map(persona => {
            const row = latestRow(runs, candidate => candidate?.persona === persona.name);
            return publicConfiguredAgentRun(row, persona, now);
        });
    const healthy = jobs.every(job => job.status === 'completed' && job.freshness.state === 'fresh')
        && optionalJobs.every(job => !job.configured || job.status === 'completed')
        && agentRuns.filter(job => job.role === 'proposer').every(job => job.status === 'completed' && job.freshness.state === 'fresh')
        && agentRuns.filter(job => job.role !== 'proposer').every(job => !job.configured || job.status === 'completed');
    return { version: 1, generatedAt: new Date(Number(now)).toISOString(), status: healthy ? 'healthy' : 'attention', jobs, optionalJobs, agentRuns };
}

export async function readPublicOperationsStatus({ pool, env = process.env, prospectiveStatus, now = Date.now(), statsReader = readRunStats } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new Error('pool is required');
    const result = await pool.query(`
        WITH ranked_persona_runs AS (
            SELECT run_id, persona, status, stage, summary, started_at, finished_at, updated_at,
                   ROW_NUMBER() OVER (PARTITION BY persona ORDER BY started_at DESC, updated_at DESC) AS persona_rank
            FROM consensus.agent_run
        )
        SELECT run_id, persona, status, stage, summary, started_at, finished_at, updated_at
        FROM ranked_persona_runs
        WHERE persona_rank <= 20
        ORDER BY updated_at DESC
    `);
    return buildPublicOperationsStatus({
        runs: result.rows || [],
        landOracle: statsReader(landOracleStatsPath(env)),
        prospective: prospectiveStatus,
        now
    });
}
