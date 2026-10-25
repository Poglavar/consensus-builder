// Executes the production market agreement selectors against isolated CTE fixtures. Opt in only
// against the local geodata database; every statement is read-only and uses no persistent fixtures.
//   cd backend && set -a && . ./.env && set +a && RUN_DB_TESTS=1 npx vitest run test/markets-contract-db.test.js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGREEMENTS_BY_ACCOUNT_SQL, AGREEMENTS_SQL } from '../routes/markets.js';

const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

live('market selectors against plan contract fixtures', () => {
    let pool;
    beforeAll(async () => {
        const { createPool, isLocalDatabase } = await import('../db/connection.cjs');
        if (!isLocalDatabase()) throw new Error('Market contract integration tests require a local database');
        pool = createPool({ max: 1, statement_timeout: 15000, options: '-c default_transaction_read_only=on' });
    });
    afterAll(async () => { await pool?.end(); });

    it('admits only exact, valid plan-backed membership for both selectors', async () => {
        const fixtureRows = [
            ['current', 'p-current', ['d-one'], { planCid: 'p-current', sponsor: 'sponsor' }, 'd-one'],
            ['old-inline', 'p-old', ['d-one'], { designs: [{ title: 'legacy' }] }, 'd-one'],
            ['missing-plan', 'p-missing', ['d-one'], { planCid: 'p-missing' }, 'd-one'],
            ['membership-mismatch', 'p-mismatch', ['d-one'], { planCid: 'p-mismatch' }, 'd-two'],
            ['empty-membership', 'p-empty', [], { planCid: 'p-empty' }, ''],
            ['duplicate-membership', 'p-duplicate', ['d-one', 'd-one'], { planCid: 'p-duplicate' }, 'd-one'],
            ['malformed-membership', 'p-malformed', ['d-one'], { planCid: 'p-malformed' }, 7],
            ['non-array-plan', 'p-non-array', ['d-one'], { planCid: 'p-non-array' }, 'bad']
        ];
        const agreements = fixtureRows.map(([cid, planCid, designCids, content], index) => `
            ('${cid}', 'test-city', '${cid}', 'author', ARRAY[${designCids.map(value => `'${value}'`).join(',')}]::text[],
             ARRAY['HR-1-1']::text[], NULL::text, now() + interval '1 day', '${JSON.stringify(content).replaceAll("'", "''")}'::jsonb,
             jsonb_build_object('account', '${cid}'), NULL::text, NULL::text, NULL::text, now() - interval '${index} seconds')`).join(',');
        const plans = fixtureRows.filter(([cid, , , content]) => cid !== 'missing-plan' && content.planCid).map(([cid, planCid, , , planDesign]) => {
            const membership = cid === 'empty-membership' ? []
                : cid === 'duplicate-membership' ? ['d-one', 'd-one']
                    : cid === 'malformed-membership' ? [7]
                        : cid === 'non-array-plan' ? 'bad'
                        : [planDesign];
            return `('${planCid}', '${JSON.stringify({ schema: 'plan/v1', designCids: membership }).replaceAll("'", "''")}'::jsonb)`;
        }).join(',');
        const sqlFor = productionSql => `WITH
            fixture_agreement(cid, city, title, author, design_cids, input_parcel_ids, parcel_source_id, deadline,
                content, onchain, screenshot_url, screenshot_before_url, screenshot_pair_url, created_at) AS (
                VALUES ${agreements}
            ),
            fixture_plan(cid, content) AS (VALUES ${plans}),
            fixture_design(cid, content) AS (VALUES ('d-one', '{"title":"Indexed current title"}'::jsonb), ('d-two', '{"title":"Wrong title"}'::jsonb))
            ${productionSql.replaceAll('consensus.agreement', 'fixture_agreement')
                .replaceAll('consensus.plan', 'fixture_plan').replaceAll('consensus.design', 'fixture_design')}`;
        // The production selectors execute unchanged; only relation names resolve to read-only CTEs.
        const city = await pool.query(sqlFor(AGREEMENTS_SQL), ['test-city', 2000]);
        const accountSql = sqlFor(AGREEMENTS_BY_ACCOUNT_SQL);
        const accounts = await pool.query(accountSql, ['current']);
        expect(city.rows.map(row => row.cid)).toEqual(['current']);
        expect(city.rows[0].design_titles).toEqual(['Indexed current title']);
        expect(accounts.rows.map(row => row.cid)).toEqual(['current']);
        expect(accounts.rows[0].design_titles).toEqual(['Indexed current title']);
        for (const [cid] of fixtureRows.slice(1)) {
            const result = await pool.query(accountSql, [cid]);
            expect(result.rows, cid).toEqual([]);
        }
    }, 20000);
});
