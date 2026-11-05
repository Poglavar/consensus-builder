// Private aggregate report using existing publication records first. Never return authored fields.
export async function readPlanningUsage(pool, { days = 30, diagnostics = false } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
    const publications = await pool.query(`
        SELECT kind, day, count(*)::int AS revisions FROM (
            SELECT 'named-plan' AS kind, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
                FROM consensus.plan WHERE created_at >= now() - ($1 * interval '1 day')
            UNION ALL
            SELECT 'design', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                FROM consensus.design WHERE created_at >= now() - ($1 * interval '1 day')
            UNION ALL
            SELECT 'agreement', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                FROM consensus.agreement WHERE created_at >= now() - ($1 * interval '1 day')
        ) records GROUP BY kind, day ORDER BY day, kind`, [days]);
    const report = {
        version: 1, generatedAt: new Date().toISOString(), window: { days, basis: 'server created_at / received_at; UTC days' },
        publicationRecords: { daily: publications.rows, meaning: 'Indexed immutable revisions; named plans, designs and agreements are separate. Repeated identical content is one row. These are neither all local plans nor people.', attribution: 'unknown: historical rows do not reliably identify UI, MCP or tests' },
        diagnostics: { included: false, meaning: 'No collection is enabled by running this report.' }
    };
    if (!diagnostics) return report;
    // Browser sessions (one tab, 30 minutes idle) through the planning funnel. Observations carry no
    // client clock, so "where people stop" is each session's furthest stage, not its last event.
    const funnel = await pool.query(`
        WITH scoped AS (
            SELECT payload FROM consensus.planning_diagnostic
            WHERE received_at >= now() - (LEAST($1, 7) * interval '1 day') AND payload->>'source' = 'ui'
        ), staged AS (
            SELECT payload->>'sessionId' AS session_id, CASE
                WHEN payload->>'operation' = 'open' AND payload->>'entity' = 'workspace' THEN 1
                WHEN payload->>'operation' = 'inspect' THEN 2
                WHEN payload->>'operation' = 'start' THEN 3
                WHEN payload->>'operation' IN ('create', 'edit', 'import') THEN 4
                WHEN (payload->>'operation' = 'save' AND payload->>'entity' = 'plan') OR payload->>'operation' = 'export' THEN 5
                WHEN payload->>'operation' IN ('publish', 'share') THEN 6
            END AS stage
            FROM scoped WHERE payload->>'kind' = 'operation' AND payload->>'outcome' = 'success'
        ), furthest AS (
            SELECT session_id, max(stage) AS stage FROM staged WHERE stage IS NOT NULL GROUP BY session_id
        ), failures AS (
            SELECT DISTINCT payload->>'sessionId' AS session_id,
                COALESCE(payload->>'code', (payload->>'operation') || '-' || (payload->>'entity') || '-failure') AS failure
            FROM scoped WHERE payload->>'outcome' = 'failure'
        )
        SELECT
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('stage', stage, 'sessions', sessions) ORDER BY stage), '[]'::jsonb)
                FROM (SELECT s.stage, count(*)::int AS sessions FROM generate_series(1, 6) s(stage)
                      JOIN furthest f ON f.stage >= s.stage GROUP BY s.stage) reach) AS reached,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('stage', stage, 'sessions', sessions) ORDER BY stage), '[]'::jsonb)
                FROM (SELECT stage, count(*)::int AS sessions FROM furthest GROUP BY stage) stop) AS stopped_at,
            (SELECT COALESCE(jsonb_agg(row_to_json(byFailure) ORDER BY sessions DESC, failure), '[]'::jsonb)
                FROM (SELECT x.failure, count(*)::int AS sessions,
                        count(*) FILTER (WHERE COALESCE(f.stage, 0) < 6)::int AS sessions_not_published
                      FROM failures x LEFT JOIN furthest f USING (session_id) GROUP BY x.failure) byFailure) AS failures`, [days]);
    const names = ['opened app', 'inspected the map', 'started a design', 'created or edited a design', 'saved a plan or exported', 'published or shared'];
    const label = rows => rows.map(row => ({ ...row, name: names[row.stage - 1] }));
    const stages = funnel.rows[0] || {};
    report.funnel = {
        reached: label(stages.reached || []), stoppedAt: label(stages.stopped_at || []), failures: stages.failures || [],
        meaning: 'Browser tab sessions (30 minutes idle), not people. reached counts sessions at or beyond each stage; stoppedAt is each session\'s furthest stage. failures counts sessions that saw each failure, and how many of them never published or shared. Each distinct observation is uploaded once per session; local and automated browsers are not uploaded.'
    };
    // Expired rows are excluded even if the cleanup service was stopped. Storage is a bounded
    // sample (10,000 rows / seven days), not a complete usage census.
    const observations = await pool.query(`
        WITH scoped AS (
            SELECT payload FROM consensus.planning_diagnostic
            WHERE received_at >= now() - (LEAST($1, 7) * interval '1 day')
        ), groups AS (
            SELECT payload->>'source' AS source, payload->>'evidence' AS evidence, payload->>'test' AS test,
                payload->>'kind' AS kind, payload->>'operation' AS operation, payload->>'entity' AS entity,
                payload->>'outcome' AS outcome, payload->>'code' AS code, count(*)::int AS events
            FROM scoped GROUP BY 1,2,3,4,5,6,7,8
        ), handles AS (
            SELECT payload->>'source' AS source, payload->>'evidence' AS evidence, payload->>'test' AS test,
                count(DISTINCT payload->>'sessionId') FILTER (
                    WHERE payload->>'kind' = 'operation' AND payload->>'outcome' = 'success'
                        AND payload->>'operation' IN ('create','edit','save','share','publish','import','export'))::int AS observed_sessions,
                count(DISTINCT payload->>'planId') FILTER (
                    WHERE payload->>'kind' = 'operation' AND payload->>'outcome' = 'success'
                        AND payload->>'entity' = 'plan' AND payload->>'operation' <> 'open')::int AS observed_plan_handles
            FROM scoped GROUP BY 1,2,3
        )
        SELECT (SELECT COALESCE(jsonb_agg(groups), '[]'::jsonb) FROM groups) AS outcomes,
               (SELECT COALESCE(jsonb_agg(handles), '[]'::jsonb) FROM handles) AS handles`, [days]);
    report.diagnostics = { included: true, ...observations.rows[0],
        meaning: 'Client reports are self-reported, incomplete and may be replayed or fabricated. Server observations identify the executing API/MCP path only. Unknown is not human or bot. Temporary browser sessions are not people. Plan handles identify observed local compositions in one tab/session; they are not globally unique plans. Publication attempts, pin uploads and indexed revisions are separate measures. Never add client/server outcomes together.',
        bounds: { maximumRows: 10000, maximumDays: 7, idleSessionMinutes: 30, automaticClientUpload: 'first occurrence per session' } };
    return report;
}
