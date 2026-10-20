import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import database from '../db/connection.cjs';

const enabled = process.env.RUN_PUBLICATION_POSTGRES_TESTS === '1';
const suite = enabled ? describe : describe.skip;
const proposalDdl = readFileSync(fileURLToPath(new URL('../routes/proposals-ddl.sql', import.meta.url)), 'utf8');
const planDdl = readFileSync(fileURLToPath(new URL('../ens/ens-plan-ddl.sql', import.meta.url)), 'utf8');
const publicationDdl = readFileSync(fileURLToPath(new URL('../db/publication-immutability.sql', import.meta.url)), 'utf8');

let client;
let schema;
let serial = 0;
let savepoint = 0;
let testSavepoint;

function commitment(ids = ['1']) {
    return Object.fromEntries(ids.map((id, index) => [id, String(index + 1).padStart(64, '0')]));
}

function proposalData(id, fields = {}) {
    return {
        id, proposalId: `authored-${id}`, proposal_id: `authored-${id}`,
        type: 'structure', cadastreParcelIds: [`parcel-${id}`],
        structureProposal: { geometry: { coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] } },
        ...fields,
    };
}

async function insertProposal(id = ++serial, extra = {}) {
    const authoredId = `authored-${id}`;
    const data = proposalData(id);
    const defaults = {
        city: 'test-city', name: `Proposal ${id}`, title: `Title ${id}`, description: 'original', author: 'tester',
        type: 'structure', offer: 10, budget: 20, lifecycle_status: 'Active', epoch_year: 2035,
        cadastre_parcel_ids: [`parcel-${id}`], accepted_parcel_ids: null, owner_acceptances: null,
        ownership_flow: null, cadastre_frame: null, site: null, binding: null, road_proposal: null,
        building_proposal: null, structure_proposal: { kind: 'block', geometry: { x: 1 } }, reparcellization: null,
        lens: null, bounds: null, onchain_data: null, screenshot_url: null,
        proposal_data: data,
    };
    const row = { ...defaults, proposal_id: authoredId, id, ...extra };
    const columns = Object.keys(row);
    const values = Object.values(row).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
        `INSERT INTO proposal (${columns.join(', ')}) VALUES (${placeholders})`, values,
    );
    return row;
}

async function insertPlan(slug = `plan-${++serial}`, overrides = {}) {
    const row = {
        slug, proposal_ids: ['1'], member_hashes: commitment(['1']), plan_hash: 'f'.repeat(64),
        title: 'Original title', supersedes: null, onchain_data: null,
        ...overrides,
    };
    await client.query(
        `INSERT INTO ens_plan (slug, proposal_ids, member_hashes, plan_hash, title, supersedes, onchain_data)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7::jsonb)`,
        [row.slug, JSON.stringify(row.proposal_ids), JSON.stringify(row.member_hashes), row.plan_hash,
            row.title, row.supersedes, row.onchain_data === null ? null : JSON.stringify(row.onchain_data)],
    );
    return row;
}

async function expectConstraintFailure(query, params, constraint) {
    await client.query(`SAVEPOINT rejected_${++savepoint}`);
    let failure;
    try {
        await client.query(query, params);
    } catch (error) {
        failure = error;
    }
    await client.query(`ROLLBACK TO SAVEPOINT rejected_${savepoint}`);
    await client.query(`RELEASE SAVEPOINT rejected_${savepoint}`);
    expect(failure, `expected PostgreSQL constraint ${constraint}`).toBeTruthy();
    expect(failure.constraint).toBe(constraint);
}

suite('publication immutability PostgreSQL triggers', () => {
    beforeAll(async () => {
        dotenv.config({ path: resolve(fileURLToPath(new URL('../.env', import.meta.url))), quiet: true });
        const info = database.describeDatabase();
        if (!database.isLocalDatabase() || info.database !== 'geodata') {
            throw new Error('Refusing publication immutability integration test: DATABASE_URL must target local geodata.');
        }
        client = database.createClient({ connectionTimeoutMillis: 5000 });
        await client.connect();
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        schema = `v03_test_${randomBytes(6).toString('hex')}`;
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET LOCAL search_path TO ${schema}, public`);
        await client.query(proposalDdl);
        await client.query(planDdl);
        await client.query(publicationDdl);
        await client.query(publicationDdl);
    }, 30000);

    beforeEach(async () => {
        testSavepoint = `case_${++savepoint}`;
        await client.query(`SAVEPOINT ${testSavepoint}`);
    });

    afterEach(async () => {
        await client.query(`ROLLBACK TO SAVEPOINT ${testSavepoint}`);
        await client.query(`RELEASE SAVEPOINT ${testSavepoint}`);
    });

    afterAll(async () => {
        if (client) {
            try { await client.query('ROLLBACK'); } finally { await client.end(); }
        }
    });

    it('rejects changed authored geometry nested in proposal_data', async () => {
        const row = await insertProposal();
        await expectConstraintFailure(
            `UPDATE proposal SET proposal_data = jsonb_set(proposal_data, '{structureProposal,geometry,coordinates,0,0,0}', '9'::jsonb) WHERE id = $1`,
            [row.id], 'proposal_published_content_immutable',
        );
    });

    it.each([
        ['structure design', 'UPDATE proposal SET structure_proposal = $1::jsonb WHERE id = $2', [JSON.stringify({ kind: 'changed' })]],
        ['cadastre membership', 'UPDATE proposal SET cadastre_parcel_ids = $1::jsonb WHERE id = $2', ['["other-parcel"]']],
        ['site geometry', "UPDATE proposal SET site = ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326)) WHERE id = $1", []],
        ['financial offer', 'UPDATE proposal SET offer = 99 WHERE id = $1', []],
        ['authored identifier', "UPDATE proposal SET proposal_id = 'renamed' WHERE id = $1", []],
        ['row identifier', 'UPDATE proposal SET id = id + 100000 WHERE id = $1', []],
    ])('rejects changes to %s', async (_label, sql, values) => {
        const row = await insertProposal();
        const params = values.length ? [...values, row.id] : [row.id];
        await expectConstraintFailure(sql, params, 'proposal_published_content_immutable');
    });

    it('allows labels, epoch, lifecycle, approval state, chain attachment and the immediate identity mirror fill', async () => {
        const id = ++serial;
        const data = proposalData(id);
        delete data.id;
        delete data.proposalId;
        delete data.proposal_id;
        const row = await insertProposal(id, { proposal_data: data });
        await client.query(
            `UPDATE proposal SET name = 'New name', title = 'New title', description = 'New description',
                epoch_year = 2045, lifecycle_status = 'Executed', accepted_parcel_ids = '["parcel-1"]'::jsonb,
                owner_acceptances = '{"owner":true}'::jsonb, onchain_data = '{"mint":"once"}'::jsonb,
                proposal_data = jsonb_set(jsonb_set(jsonb_set(proposal_data, '{id}', to_jsonb(id)),
                    '{proposalId}', to_jsonb(proposal_id)), '{proposal_id}', to_jsonb(proposal_id))
             WHERE id = $1`, [row.id],
        );
        await client.query(`UPDATE proposal SET screenshot_url = 'https://example.test/thumb.png' WHERE id = $1`, [row.id]);
        await client.query(`UPDATE proposal SET proposal_data = jsonb_set(proposal_data, '{lifecycleStatus}', '"Executed"'::jsonb) WHERE id = $1`, [row.id]);
    });

    it('allows a fork as a new row while preserving the original', async () => {
        const original = await insertProposal();
        const forkId = original.id + 1;
        const fork = await insertProposal(forkId, {
            proposal_id: 'authored-fork',
            name: 'Fork',
            structure_proposal: { kind: 'new-design' },
            proposal_data: proposalData(forkId, { proposalId: 'authored-fork', proposal_id: 'authored-fork',
                sourceProposalId: original.proposal_id, structureProposal: { kind: 'new-design' } }),
        });
        const { rows } = await client.query('SELECT proposal_id, structure_proposal FROM proposal WHERE id = ANY($1::int[]) ORDER BY id', [[original.id, fork.id]]);
        expect(rows).toHaveLength(2);
        expect(rows[0].proposal_id).toBe(`authored-${original.id}`);
        expect(rows[0].structure_proposal).toEqual(original.structure_proposal);
        expect(rows[1].proposal_id).toBe('authored-fork');
    });

    it('rejects a design overwrite through an operator UPSERT', async () => {
        const row = await insertProposal();
        await expectConstraintFailure(
            `INSERT INTO proposal (id, proposal_id, type, cadastre_parcel_ids, proposal_data, structure_proposal)
             SELECT id + 1000, proposal_id, type, cadastre_parcel_ids, proposal_data, '{"kind":"changed"}'::jsonb
             FROM proposal WHERE id = $1
             ON CONFLICT (proposal_id) DO UPDATE SET structure_proposal = EXCLUDED.structure_proposal`,
            [row.id], 'proposal_published_content_immutable',
        );
    });

    it.each([
        ['null member list', null, commitment(['1']), 'f'.repeat(64)],
        ['empty member list', [], {}, 'f'.repeat(64)],
        ['partial hashes', ['1', '2'], commitment(['1']), 'f'.repeat(64)],
        ['malformed member hash', ['1'], { '1': 'G'.repeat(64) }, 'f'.repeat(64)],
        ['extra member hash', ['1'], { ...commitment(['1']), '2': 'e'.repeat(64) }, 'f'.repeat(64)],
        ['missing plan hash', ['1'], commitment(['1']), null],
        ['malformed plan hash', ['1'], commitment(['1']), 'F'.repeat(64)],
    ])('rejects a plan with %s', async (_label, ids, hashes, planHash) => {
        await expectConstraintFailure(
            `INSERT INTO ens_plan (slug, proposal_ids, member_hashes, plan_hash) VALUES ('invalid-plan', $1::jsonb, $2::jsonb, $3)`,
            [ids === null ? 'null' : JSON.stringify(ids), JSON.stringify(hashes), planHash],
            'named_plan_complete_commitment',
        );
    });

    it('rejects non-string, nondigit and duplicate membership IDs', async () => {
        for (const ids of [['1', '1'], ['one'], [1]]) {
            await expectConstraintFailure(
                `INSERT INTO ens_plan (slug, proposal_ids, member_hashes, plan_hash) VALUES ('invalid-members', $1::jsonb, $2::jsonb, $3)`,
                [JSON.stringify(ids), JSON.stringify(commitment(ids.map(String))), 'f'.repeat(64)],
                'named_plan_complete_commitment',
            );
        }
    });

    it.each([
        ['membership', "proposal_ids = '[\"2\"]'::jsonb"],
        ['member commitment', "member_hashes = '{\"1\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}'::jsonb"],
        ['plan commitment', `plan_hash = '${'e'.repeat(64)}'`],
        ['title', "title = 'Rewritten'"],
        ['supersedes', "supersedes = 'another-plan'"],
    ])('rejects rewriting a named plan %s', async (_label, assignment) => {
        const plan = await insertPlan();
        await expectConstraintFailure(`UPDATE ens_plan SET ${assignment} WHERE slug = $1`, [plan.slug], 'named_plan_identity_immutable');
    });

    it('allows chain data to attach once and rejects a second overwrite', async () => {
        await insertPlan('chain-plan');
        await client.query(`UPDATE ens_plan SET onchain_data = '{"mint":"first"}'::jsonb WHERE slug = 'chain-plan'`);
        await expectConstraintFailure(
            `UPDATE ens_plan SET onchain_data = '{"mint":"second"}'::jsonb WHERE slug = 'chain-plan'`,
            [], 'named_plan_chain_reference_immutable',
        );
    });

    it('rejects rewriting a named plan through an operator UPSERT', async () => {
        const plan = await insertPlan();
        await expectConstraintFailure(
            `INSERT INTO ens_plan (slug, proposal_ids, member_hashes, plan_hash, title)
             SELECT slug, proposal_ids, member_hashes, plan_hash, 'Rewritten' FROM ens_plan WHERE slug = $1
             ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title`,
            [plan.slug], 'named_plan_identity_immutable',
        );
    });
});
