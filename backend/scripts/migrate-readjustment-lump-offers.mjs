// Give the land readjustments published before the per-owner cash ledger (Dec 2025) a ledger that
// matches their offer, so the v2 deal validator accepts them: the lump `offer` is split across the
// owners by their stored `percent` (largest remainder, exact to the cent) into each owner's
// `cashOffer`, and the currency becomes EUR (the only one readjustment cash may use).
//
// A row qualifies only when its offer is positive, no owner carries cashOffer/cashPayment yet, no
// owner is ownerless ground, and the owner percents are finite and sum to 1. Anything else is
// reported and left alone. Each migrated record must pass validateReadjustmentProposal before it
// is written.
//
// Reversible: the previous offer, offer_currency, reparcellization and proposal_data go into
// proposal_lump_offer_backup_v1 first, and --restore puts them back. Idempotent: a migrated row
// has a ledger and no longer qualifies.
//
//   node scripts/migrate-readjustment-lump-offers.mjs --help
//   node scripts/migrate-readjustment-lump-offers.mjs              # dry run (default)
//   node scripts/migrate-readjustment-lump-offers.mjs --ids 18,19
//   node scripts/migrate-readjustment-lump-offers.mjs --apply
//   node scripts/migrate-readjustment-lump-offers.mjs --restore

import { createPool } from '../db/connection.cjs';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { serializeProposalRow } from '../proposals/serializer.js';
import { validateReadjustmentProposal } from '../routes/reparcellization.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export const MIGRATION_ID = 'readjustment-lump-offer-v1';
export const BACKUP_TABLE = 'proposal_lump_offer_backup_v1';
const CURRENCY = 'EUR';
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// Split `cents` by `weights` (summing to 1) into integer cents that sum exactly to `cents`.
export function splitCents(cents, weights) {
    const raw = weights.map(weight => cents * weight);
    const out = raw.map(Math.floor);
    let left = cents - out.reduce((sum, value) => sum + value, 0);
    const order = raw.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) out[order[k][1]] += 1;
    return out;
}

// Pure: what one row becomes, or why it is left alone.
export function planRow(row) {
    const rep = row.reparcellization;
    const offer = row.offer == null ? null : Number(row.offer);
    if (!isPlainObject(rep) || !Array.isArray(rep.ownerShares) || !rep.ownerShares.length) return { class: 'skipped', reason: 'no-owner-ledger' };
    if (!isNumber(offer) || offer <= 0) return { class: 'skipped', reason: 'no-offer' };
    const owners = rep.ownerShares;
    if (owners.some(owner => owner && (owner.cashOffer !== undefined || owner.cashPayment !== undefined))) return { class: 'skipped', reason: 'has-ledger' };
    if (owners.some(owner => owner?.noOwner === true || owner?.ownerKey === 'open-ground')) return { class: 'skipped', reason: 'ownerless-ground' };
    const weights = owners.map(owner => owner?.percent);
    if (weights.some(weight => !isNumber(weight) || weight < 0)) return { class: 'skipped', reason: 'bad-percent' };
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(total - 1) > 1e-6) return { class: 'skipped', reason: 'percents-not-1', detail: String(total) };
    const offerCents = Math.round(offer * 100);
    const cents = splitCents(offerCents, weights.map(weight => weight / total));
    const ownerShares = owners.map((owner, index) => ({ ...owner, cashOffer: cents[index] / 100 }));
    const reparcellization = { ...rep, ownerShares };
    const data = isPlainObject(row.proposal_data) ? row.proposal_data : {};
    const proposalData = { ...data, offerCurrency: CURRENCY,
        ...(isPlainObject(data.reparcellization) ? { reparcellization: { ...data.reparcellization, ownerShares } } : {}) };
    return { class: 'migratable', offer, offerCurrency: CURRENCY, reparcellization, proposalData, cents };
}

// The record as the API serves it after the change must pass the server's deal validation.
export function validateMigrated(row, plan) {
    const proposal = serializeProposalRow({ ...row, offer_currency: plan.offerCurrency, reparcellization: plan.reparcellization, proposal_data: plan.proposalData });
    const result = validateReadjustmentProposal(proposal);
    return result.valid ? null : result.errors.map(error => error.message).join('; ');
}

export function parseArgs(argv) {
    const args = { apply: false, restore: false, ids: null, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--restore') args.restore = true;
        else if (arg === '--dry-run') { /* the default */ }
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') {
            const list = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
            if (!list.length || list.some(value => !/^\d+$/.test(value))) throw new Error('--ids needs comma-separated numeric row ids');
            args.ids = list.map(Number);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (args.apply && args.restore) throw new Error('Pass either --apply or --restore, not both.');
    return args;
}

function usage() {
    console.log([
        'Split the lump offer of pre-ledger land readjustments into per-owner cashOffer (EUR).',
        '',
        '  (default)   Dry run: report what each readjustment would become. Writes nothing.',
        `  --apply     Back each row up into ${BACKUP_TABLE}, then write it (one transaction per row).`,
        `  --restore   Put every row in ${BACKUP_TABLE} (or --ids) back as it was.`,
        '  --ids LIST  Limit to comma-separated numeric row ids.',
        '  --help      Show this message.',
        '',
        'Connection: DATABASE_URL (backend/.env, or exported to point at another database).'
    ].join('\n'));
}

const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] ${message}`);
const ROW_COLUMNS = '*, ST_AsGeoJSON(site, 9)::jsonb AS site';

async function proposalSchema(db) {
    const { rows } = await db.query(`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'proposal'::regclass`);
    return rows[0].schema;
}

async function ensureBackupTable(db, schema) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${schema}.${BACKUP_TABLE} (
        id INTEGER PRIMARY KEY,
        offer NUMERIC(20,8),
        offer_currency VARCHAR(10),
        reparcellization JSONB,
        proposal_data JSONB NOT NULL,
        backed_up_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
}

async function applyRow(pool, id, schema) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        const { rows } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows.length) { await client.query('ROLLBACK'); return { status: 'gone' }; }
        const plan = planRow(rows[0]);
        if (plan.class !== 'migratable') { await client.query('ROLLBACK'); return { status: `now-${plan.reason}` }; }
        const invalid = validateMigrated(rows[0], plan);
        if (invalid) { await client.query('ROLLBACK'); return { status: 'failed', error: `still invalid: ${invalid}` }; }
        // The first backup of a row is the pre-migration state; a re-run never overwrites it.
        await client.query(`INSERT INTO ${schema}.${BACKUP_TABLE} (id, offer, offer_currency, reparcellization, proposal_data)
            SELECT id, offer, offer_currency, reparcellization, proposal_data FROM proposal WHERE id = $1
            ON CONFLICT (id) DO NOTHING`, [id]);
        await client.query(`UPDATE proposal SET offer_currency = $1, reparcellization = $2::jsonb, proposal_data = $3::jsonb,
            updated_at = now() WHERE id = $4`, [plan.offerCurrency, JSON.stringify(plan.reparcellization), JSON.stringify(plan.proposalData), id]);
        // Verify from the row as stored, not from the absence of an error.
        const { rows: after } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1`, [id]);
        const recheck = validateReadjustmentProposal(serializeProposalRow(after[0]));
        if (!recheck.valid) throw new Error(`stored row does not validate: ${recheck.errors[0].message}`);
        await client.query('COMMIT');
        return { status: 'written' };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return { status: 'failed', error: error.detail || error.message };
    } finally {
        client.release();
    }
}

async function restore(pool, args) {
    const client = await pool.connect();
    try {
        const schema = await proposalSchema(client);
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        const filter = args.ids ? 'AND b.id = ANY($1::int[])' : '';
        const result = await client.query(`UPDATE proposal p
            SET offer = b.offer, offer_currency = b.offer_currency, reparcellization = b.reparcellization,
                proposal_data = b.proposal_data, updated_at = now()
            FROM ${schema}.${BACKUP_TABLE} b WHERE p.id = b.id ${filter}`, args.ids ? [args.ids] : []);
        await client.query('COMMIT');
        log(`restored ${result.rowCount} row(s) from ${schema}.${BACKUP_TABLE}`);
        return 0;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[${ts()}] restore failed: ${error.message}`);
        return 1;
    } finally {
        client.release();
    }
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set — refusing to guess a database.');
        return 1;
    }
    const pool = createPool();
    try {
        if (args.restore) return await restore(pool, args);
        const reader = await pool.connect();
        try {
            if (!args.apply) await reader.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
            const { rows: [target] } = await reader.query('SELECT current_database() AS db, current_user AS usr');
            log(`${MIGRATION_ID} · mode ${args.apply ? 'APPLY' : 'DRY RUN'} · db ${target.db} as ${target.usr}`);
            const schema = await proposalSchema(reader);
            const filter = args.ids ? 'AND id = ANY($1::int[])' : '';
            const { rows } = await reader.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE reparcellization IS NOT NULL ${filter} ORDER BY id`, args.ids ? [args.ids] : []);
            const migratable = [];
            const skipped = {};
            for (const row of rows) {
                const plan = planRow(row);
                if (plan.class !== 'migratable') { skipped[plan.reason] = (skipped[plan.reason] || 0) + 1; continue; }
                const invalid = validateMigrated(row, plan);
                log(`#${row.id} ${row.proposal_id} offer ${plan.offer} ${row.offer_currency} → ${plan.offerCurrency} over ${plan.cents.length} owners [${plan.cents.map(c => (c / 100).toFixed(2)).join(', ')}] · ${invalid ? `STILL INVALID: ${invalid}` : 'validates'}`);
                if (!invalid) migratable.push(row.id);
            }
            log(`${rows.length} readjustment(s) read · ${migratable.length} migratable · skipped ${JSON.stringify(skipped)}`);
            if (!args.apply) return 0;
            await reader.query('SET ROLE geo_user');
            await ensureBackupTable(reader, schema);
            await reader.query('RESET ROLE');
            let failed = 0;
            for (const [index, id] of migratable.entries()) {
                const outcome = await applyRow(pool, id, schema);
                if (outcome.status !== 'written') failed += 1;
                log(`apply ${index + 1}/${migratable.length} #${id} ${outcome.status}${outcome.error ? ` · ${outcome.error}` : ''}`);
            }
            return failed ? 1 : 0;
        } finally {
            reader.release();
        }
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    run().then(code => { process.exitCode = code; }, error => { console.error(`[${ts()}] ${error.stack || error.message}`); process.exitCode = 1; });
}
