// A saved running row is live only while its PostgreSQL advisory lock has an owner.
export async function latestRun(db, { pipeline = false } = {}) {
    const table = pipeline ? 'pipeline_run' : 'run';
    const key = pipeline ? 'floor-plan-daily' : 'floor-plan-crawl';
    const row = (await db.query(`SELECT r.*, EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND granted AND objsubid=1
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
          AND objid=(hashtext($1)::bigint & 4294967295)::oid) AS worker_active
        FROM floor_plan.${table} r ORDER BY created_at DESC LIMIT 1`, [key])).rows[0];
    if (!row) return null;
    const { worker_active, ...run } = row;
    if (run.status === 'running' && !worker_active) return { ...run, status: 'interrupted', recordedStatus: 'running', workerActive: false };
    return { ...run, workerActive: Boolean(worker_active) && run.status === 'running' };
}
