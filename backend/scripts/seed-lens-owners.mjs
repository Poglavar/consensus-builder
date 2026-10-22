#!/usr/bin/env node
// Registers proposer personas as the sole owners of the parcels their runs picked, in the lens member's
// devnet owner registry (consensus.lens_devnet_owner; agents/lens-owner-registry.js), so the binding
// owners' agreements the runner proposes on that land are ones each persona can get decided itself
// (plan-design-agreement.md M3). The picks come from the runner's checkpoints (consensus.agent_run) of one
// day, or one parcel is named. A parcel another wallet holds is reported and never replaced; a contest pick
// is skipped (its rival is not the owner). Dry run unless --apply; the registry is the checkpoint, so a
// rerun registers only what is still missing. agents/run.mjs --seed-owners does the same for each pick.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createPool, describeDatabase } from '../db/connection.cjs';
import { listRuns } from '../agents/ledger.js';
import {
    OWNER_TABLE, agentRegistrationNote, planOwnerRegistrations, readParcelOwners, registerSoleOwners
} from '../agents/lens-owner-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, '..');
export const EXIT_CONFLICTS = 3;

function usage(code) {
    console.log([
        'Register proposer personas as the sole owners (owner_count 1) of the parcels their runs picked, in the',
        `lens member's devnet owner registry (${OWNER_TABLE}). Nothing runs without a parameter.`,
        '',
        'Usage:',
        '  node scripts/seed-lens-owners.mjs --day YYYY-MM-DD [--slot LABEL] [--persona NAME] [--apply]',
        '  node scripts/seed-lens-owners.mjs --parcel ID --persona NAME [--apply]',
        '',
        '  --day YYYY-MM-DD   The picks of that day\'s runs (consensus.agent_run checkpoints; run with',
        '                     agents/run.mjs --live --until chosen first when the picks are new)',
        '  --slot LABEL       Only the runs of that slot (run ids <day>-<slot>-<persona>); default every run of the day',
        '  --persona NAME     Only this proposer persona (required with --parcel)',
        '  --parcel ID        Register this one parcel to --persona instead of reading picks',
        '  --apply            Write the registry. Without it the script prints what it would register (dry run)',
        '  --env-file PATH    The .env holding DATABASE_URL (default backend/.env)',
        '  --help             This text',
        '',
        'A parcel another wallet already holds is reported and left as it is; a contest pick (an answer to another',
        `persona's agreement) is skipped. Exit 0 when every wanted parcel is its persona's alone, ${EXIT_CONFLICTS} when a`,
        'parcel is held by someone else or wanted by two personas.'
    ].join('\n'));
    process.exit(code);
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function parseArgs(argv) {
    if (!argv.length) usage(0);
    const args = { apply: false };
    const valued = new Set(['--day', '--slot', '--persona', '--parcel', '--env-file']);
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help') usage(0);
        if (token === '--apply') { args.apply = true; continue; }
        if (!valued.has(token)) { console.error(`unknown option ${token}`); usage(2); }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { console.error(`${token} needs a value`); usage(2); }
        args[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        i += 1;
    }
    if (args.parcel && !args.persona) { console.error('--parcel needs --persona'); usage(2); }
    if (args.parcel && (args.day || args.slot)) { console.error('--parcel names one parcel; it takes no --day or --slot'); usage(2); }
    if (!args.parcel && !args.day) { console.error('give --day (picks of that day) or --parcel with --persona'); usage(2); }
    if (args.day && !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) { console.error(`--day must be YYYY-MM-DD, got ${args.day}`); usage(2); }
    if (args.slot && !/^[a-z0-9][a-z0-9-]{0,15}$/.test(args.slot)) { console.error(`--slot must be a short [a-z0-9-] label, got ${args.slot}`); usage(2); }
    return args;
}

/** The proposer personas of a personas.json document by name (agents/personas.json by default). */
export function proposerPersonas(file = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'agents', 'personas.json'), 'utf8'))) {
    return new Map((file.personas || []).filter(p => (p.role || 'proposer') === 'proposer').map(p => [p.name, p]));
}

function walletOf(personas, name) {
    const persona = personas.get(name);
    if (!persona) throw new Error(`no proposer persona named ${name} in agents/personas.json`);
    if (!persona.wallet) throw new Error(`persona ${name} has no wallet yet`);
    return persona.wallet;
}

// What the day's runs picked: one entry per pick, its parcel and its persona's wallet; contest picks and
// picks without their candidate are reported and left out.
export function picksOfRuns(runs, personas, { day, slot, persona }) {
    const wanted = [];
    const skipped = [];
    for (const run of runs) {
        if (persona && run.persona !== persona) continue;
        if (!personas.has(run.persona)) continue;
        if (slot && !String(run.run_id).startsWith(`${day}-${slot}-`)) continue;
        const summary = run.summary || {};
        const candidates = new Map((summary.candidates || []).map(candidate => [candidate.candidateId, candidate]));
        for (const pick of summary.picks || []) {
            const candidate = candidates.get(pick.candidateId);
            if (!candidate?.parcelId) { skipped.push({ runId: run.run_id, pickId: pick.pickId, reason: 'no candidate parcel in the checkpoint' }); continue; }
            if (candidate.rival) { skipped.push({ runId: run.run_id, pickId: pick.pickId, parcelId: String(candidate.parcelId), reason: `contest pick answering ${candidate.rival.persona}` }); continue; }
            wanted.push({ parcelId: String(candidate.parcelId), wallet: walletOf(personas, run.persona), persona: run.persona, pickId: pick.pickId, runId: run.run_id });
        }
    }
    return { wanted, skipped };
}

/**
 * What the script does once its arguments are parsed, on an injected pool (the registry and the run
 * checkpoints) and persona map: plan the registrations, write them under --apply, read them back.
 * @param args { day?, slot?, persona?, parcel?, apply }
 * @returns {Promise<{ exitCode: number, wanted: object[], skipped: object[], plan: object, results: object[] }>}
 *   exitCode EXIT_CONFLICTS when a wanted parcel is held by another wallet or wanted by two personas
 */
export async function seedLensOwners(args, { pool, personas, log: write = log } = {}) {
    let wanted;
    let skipped = [];
    if (args.parcel) {
        wanted = [{ parcelId: String(args.parcel), wallet: walletOf(personas, args.persona), persona: args.persona }];
    } else {
        const runs = await listRuns(pool, { day: args.day });
        ({ wanted, skipped } = picksOfRuns(runs, personas, args));
        write(`${runs.length} run(s) on ${args.day}${args.slot ? ` · slot ${args.slot}` : ''}${args.persona ? ` · persona ${args.persona}` : ''}: ${wanted.length} pick(s) to own, ${skipped.length} skipped`);
        for (const item of skipped) write(`   skip ${item.pickId} (${item.runId})${item.parcelId ? ` ${item.parcelId}` : ''}: ${item.reason}`);
    }
    const owners = await readParcelOwners(pool, wanted.map(item => item.parcelId));
    const plan = planOwnerRegistrations(wanted, owners);
    write(`plan: ${plan.register.length} to register · ${plan.registered.length} already their persona's alone · ${plan.conflicts.length} held by someone else`);
    for (const item of plan.registered) write(`   ok       ${item.parcelId} → ${item.persona} ${item.wallet}`);
    for (const item of plan.conflicts) write(`   conflict ${item.parcelId} → ${item.persona}: ${item.reason}; left as it is`);
    for (const item of plan.register) write(`   ${args.apply ? 'register' : 'would register'} ${item.parcelId} → ${item.persona} ${item.wallet}`);

    let late = [];
    let results = [];
    if (args.apply && plan.register.length) {
        results = await registerSoleOwners(pool, plan.register, { note: agentRegistrationNote('seed-lens-owners.mjs'), log: write });
        late = results.filter(result => result.outcome === 'conflict');
        const inserted = results.filter(result => result.outcome === 'inserted').length;
        write(`registered ${inserted}/${plan.register.length}${late.length ? ` · ${late.length} taken by another wallet meanwhile` : ''}`);
        // Read back what was written: the registry, not this script's report of itself.
        const after = await readParcelOwners(pool, plan.register.map(item => item.parcelId));
        const missing = plan.register.filter(item => !(after.get(item.parcelId) || []).some(row => row.owner === item.wallet));
        if (missing.length && missing.length !== late.length) throw new Error(`registry read-back is missing ${missing.map(item => item.parcelId).join(', ')}`);
    } else if (!args.apply) {
        write('dry run: nothing written (add --apply)');
    }
    const conflicts = plan.conflicts.length + late.length;
    write(`done: ${plan.registered.length + (args.apply ? plan.register.length - late.length : 0)} parcel(s) their persona's alone${args.apply ? '' : ` (${plan.register.length} more after --apply)`} · ${conflicts} conflict(s)`);
    return { exitCode: conflicts ? EXIT_CONFLICTS : 0, wanted, skipped, plan, results };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const envFile = path.resolve(args.envFile || path.join(BACKEND_ROOT, '.env'));
    if (!fs.existsSync(envFile)) throw new Error(`env file ${envFile} does not exist`);
    dotenv.config({ path: envFile, quiet: true });
    const database = describeDatabase();
    const personas = proposerPersonas();
    const pool = createPool();
    try {
        log(`${args.apply ? 'APPLY' : 'dry run'} · registry ${OWNER_TABLE} on ${database.host}:${database.port}/${database.database} as ${database.user}`);
        const { exitCode } = await seedLensOwners(args, { pool, personas, log });
        if (exitCode) process.exitCode = exitCode;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] FAILED: ${error?.message || error}`);
        process.exit(1);
    });
}
