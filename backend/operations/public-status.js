import { landOracleStatsPath, readRunStats } from './run-stats.js';

const HOUR_MS = 3_600_000;

function asTime(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
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
    const successful = row.status === 'done' && ['completed', 'no-picks', 'no-eligible-proposal'].includes(outcome);
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

export function buildPublicOperationsStatus({ runs = [], landOracle = null, prospective = null, now = Date.now() } = {}) {
    const latest = role => runs.find(row => {
        const summaryRole = row?.summary?.role || 'proposer';
        return summaryRole === role;
    }) || null;
    const jobs = [
        publicAgentRun(latest('proposer'), { role: 'proposer', schedule: 'daily at 02:00 UTC', maxAgeHours: 36, now }),
        publicAgentRun(latest('supporter'), { role: 'supporter', schedule: 'daily at 02:15 UTC', maxAgeHours: 36, now }),
        publicLandOracle(landOracle, now),
        publicResolver(prospective, now)
    ];
    const healthy = jobs.every(job => job.status === 'completed' && job.freshness.state === 'fresh');
    return { version: 1, generatedAt: new Date(Number(now)).toISOString(), status: healthy ? 'healthy' : 'attention', jobs };
}

export async function readPublicOperationsStatus({ pool, env = process.env, prospectiveStatus, now = Date.now(), statsReader = readRunStats } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new Error('pool is required');
    const result = await pool.query(`
        SELECT run_id, persona, status, stage, summary, finished_at, updated_at
        FROM consensus.agent_run
        ORDER BY updated_at DESC
        LIMIT 100
    `);
    return buildPublicOperationsStatus({
        runs: result.rows || [],
        landOracle: statsReader(landOracleStatsPath(env)),
        prospective: prospectiveStatus,
        now
    });
}
