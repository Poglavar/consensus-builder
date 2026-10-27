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
        bounds: { maximumRows: 10000, maximumDays: 7, idleSessionMinutes: 30, automaticClientUpload: false } };
    return report;
}
