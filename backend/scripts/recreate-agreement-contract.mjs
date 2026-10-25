#!/usr/bin/env node
// One-off recreation of old inline-design agreement records under the current plan-linked contract.
// Preparation is pure and reviewable. Apply publishes the reviewed manifest, but never mints or
// copies chain accounts, decisions, or balances.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cidOfObject, isCid, canonicalBytes } from '../cid.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { validatePlanContent } from '../routes/plans.js';
import { mapViewFromGeometry, planForDesigns } from '../agents/agreement-objects.js';

const TITLE_LIMIT = 500;
const AUTHOR = 'devnet-demo-recreation';
const PLAN_TITLE_LIMIT = 160;
const DAY_MS = 24 * 60 * 60 * 1000;
const fail = message => { throw new Error(message); };

function canonicalInstant(value, label) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
        fail(`${label} must be a canonical ISO instant.`);
    }
    return value;
}

function referencedDesignCids(row) {
    const content = row?.content;
    const fromContent = Array.isArray(content?.designs) ? content.designs.map(design => design?.cid)
        : Array.isArray(content?.designCids) ? content.designCids : row?.design_cids;
    if (!Array.isArray(fromContent) || fromContent.length === 0 || fromContent.some(cid => !isCid(cid))) {
        fail(`Agreement ${row?.cid ?? '(unknown)'} has no valid referenced design CIDs.`);
    }
    const referenced = [...new Set(fromContent)];
    if (referenced.length !== fromContent.length) fail(`Agreement ${row.cid} repeats a referenced design CID.`);
    if (Array.isArray(row.design_cids)) {
        const indexed = [...new Set(row.design_cids)].sort();
        if (indexed.length !== row.design_cids.length || JSON.stringify(indexed) !== JSON.stringify([...referenced].sort())) {
            fail(`Agreement ${row.cid} indexed design membership differs from its content.`);
        }
    }
    return referenced;
}

/** Prepare a reviewed, plan-linked recreation manifest from a raw production index export. */
export function prepareAgreementRecreation(snapshot, { authoredAt, renewDeadlineDays = 7 } = {}) {
    canonicalInstant(authoredAt, 'authoredAt');
    if (!Number.isInteger(renewDeadlineDays) || renewDeadlineDays < 1 || renewDeadlineDays > 365) {
        fail('renewDeadlineDays must be an integer from 1 to 365.');
    }
    if (!Array.isArray(snapshot?.agreements) || !snapshot.agreements.length || !Array.isArray(snapshot?.designs)) {
        fail('Snapshot must contain non-empty agreements and a designs array.');
    }
    const designs = new Map();
    for (const row of snapshot.designs) {
        if (!isCid(row?.cid) || !row.content || cidOfObject(row.content) !== row.cid) {
            fail(`Design ${row?.cid ?? '(unknown)'} does not match its content CID.`);
        }
        if (designs.has(row.cid)) fail(`Snapshot repeats design ${row.cid}.`);
        designs.set(row.cid, row);
    }

    const items = snapshot.agreements.map(row => {
        if (!isCid(row?.cid) || !row.content || cidOfObject(row.content) !== row.cid) {
            fail(`Agreement ${row?.cid ?? '(unknown)'} does not match its content CID.`);
        }
        if (row.content.schema !== 'agreement/v1' || !Object.hasOwn(row.content, 'designs') && !Object.hasOwn(row.content, 'designCids')) {
            fail(`Agreement ${row.cid} is not an old inline-membership agreement.`);
        }
        const refs = referencedDesignCids(row);
        const linkedDesigns = refs.map(cid => {
            const design = designs.get(cid);
            if (!design) fail(`Agreement ${row.cid} references missing design ${cid}.`);
            return design;
        });
        const sourceTitle = typeof row.content.title === 'string' ? row.content.title : '';
        if (!sourceTitle.trim()) fail(`Agreement ${row.cid} has no title to recreate.`);
        const title = `Devnet demo: ${sourceTitle}`.slice(0, TITLE_LIMIT);
        const view = mapViewFromGeometry(linkedDesigns.map(design => design.content.site || design.content.geometry), linkedDesigns[0]?.content.city);
        const plan = planForDesigns(`Devnet demo: ${sourceTitle}`.slice(0, PLAN_TITLE_LIMIT), linkedDesigns, view);
        const content = structuredClone(row.content);
        delete content.designs;
        delete content.designCids;
        content.planCid = plan.cid;
        content.title = title;
        content.author = AUTHOR;
        content.createdAt = authoredAt;
        const changes = ['new-plan-linked-agreement', 'title-prefixed', 'author-replaced', 'createdAt-reset'];
        if (content.deadline != null) {
            const deadlineMs = Date.parse(content.deadline);
            if (!Number.isFinite(deadlineMs)) fail(`Agreement ${row.cid} has an invalid deadline.`);
            if (deadlineMs <= Date.parse(authoredAt)) {
                content.deadline = new Date(Date.parse(authoredAt) + renewDeadlineDays * DAY_MS).toISOString();
                changes.push(`expired-deadline-renewed-${renewDeadlineDays}-days`);
            }
        }
        const planError = validatePlanContent(plan.content);
        if (planError) fail(`Recreated plan for ${row.cid} is invalid: ${planError}`);
        const checked = validateAgreementContent(content, { now: Date.parse(authoredAt), designCids: plan.content.designCids });
        if (!checked.ok) fail(`Recreated agreement ${row.cid} is invalid in ${checked.section}: ${checked.error}`);
        const cid = cidOfObject(content);
        if (cid === row.cid) fail(`Agreement ${row.cid} unexpectedly retained its source CID.`);
        return { sourceCid: row.cid, content, cid, plan, changes };
    });
    return { schema: 'agreement-recreation/v1', authoredAt, sourceCount: snapshot.agreements.length, items };
}

const usage = `Usage:
  node backend/scripts/recreate-agreement-contract.mjs --prepare --snapshot <path> --out <path> --authored-at <ISO>
  node backend/scripts/recreate-agreement-contract.mjs --apply --prepared <path> --api <URL> --origin <HTTPS origin> [--operator-pinning]

Preparation writes a reviewable manifest. Apply publishes each new plan and agreement, checkpoints
each confirmed item beside the manifest, and does not mint or transfer chain state.
--operator-pinning uses locally configured Pinata credentials for this approved maintenance batch;
the ordinary API still validates and indexes every object.`;

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (!key.startsWith('--')) fail(`Unexpected argument ${key}.\n${usage}`);
        if (args[key]) fail(`Repeated argument ${key}.`);
        if (key === '--prepare' || key === '--apply' || key === '--help' || key === '--operator-pinning') args[key] = true;
        else {
            const value = argv[++index];
            if (!value || value.startsWith('--')) fail(`${key} needs a value.`);
            args[key] = value;
        }
    }
    return args;
}

async function atomicJson(path, value) {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
}

async function applyManifest(args) {
    for (const key of ['--prepared', '--api', '--origin']) if (!args[key]) fail(`Apply requires ${key}.\n${usage}`);
    const origin = new URL(args['--origin']);
    if (origin.protocol !== 'https:' || origin.origin !== args['--origin']) fail('--origin must be an explicit HTTPS origin without a path.');
    const manifest = JSON.parse(await readFile(args['--prepared'], 'utf8'));
    if (manifest?.schema !== 'agreement-recreation/v1' || !Array.isArray(manifest.items) || manifest.sourceCount !== manifest.items.length) {
        fail('Prepared file is not a complete agreement-recreation/v1 manifest.');
    }
    const manifestCid = cidOfObject(manifest);
    const receiptPath = `${resolve(args['--prepared'])}.receipt.json`;
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (receipt && (receipt.schema !== 'agreement-recreation-receipt/v1' || receipt.manifestCid !== manifestCid || !receipt.items || typeof receipt.items !== 'object')) {
        fail(`Checkpoint ${receiptPath} belongs to a different manifest or is malformed.`);
    }
    receipt ||= { schema: 'agreement-recreation-receipt/v1', manifestCid, items: {} };
    const { createIndexClient } = await import('../agents/publication-client.js');
    const index = createIndexClient({ apiBase: args['--api'], origin: args['--origin'], waitOnRateLimit: true,
        log: message => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`) });
    const operatorPin = args['--operator-pinning'] ? (await import('../storage/pinning.js')).pinBytes : null;
    for (const item of manifest.items) {
        if (receipt.items[item.sourceCid]) {
            if (receipt.items[item.sourceCid].cid !== item.cid) fail(`Checkpoint CID differs for source ${item.sourceCid}.`);
            continue;
        }
        if (!isCid(item.sourceCid) || !item.content || cidOfObject(item.content) !== item.cid || item.content.planCid !== item.plan?.cid ||
            !item.plan?.content || cidOfObject(item.plan.content) !== item.plan.cid) fail(`Prepared item ${item.sourceCid} failed CID or plan verification.`);
        if (Object.hasOwn(item.content, 'onchain')) fail(`Prepared agreement ${item.cid} must not carry chain state.`);
        const planError = validatePlanContent(item.plan.content);
        if (planError) fail(`Prepared plan ${item.plan.cid} is invalid: ${planError}`);
        const checked = validateAgreementContent(item.content, { now: Date.parse(manifest.authoredAt), designCids: item.plan.content.designCids });
        if (!checked.ok) fail(`Prepared agreement ${item.cid} is invalid in ${checked.section}: ${checked.error}`);
        let result;
        if (operatorPin) {
            await operatorPin({ bytes: canonicalBytes(item.plan.content), cid: item.plan.cid, name: `plan-${item.plan.cid}` });
            await operatorPin({ bytes: canonicalBytes(item.content), cid: item.cid, name: `agreement-${item.cid}` });
            const indexed = await index.indexAgreement(item.cid, item.content, { plan: item.plan });
            result = { cid: item.cid, ...indexed };
        } else {
            result = await index.publishAgreement(item.content, { plan: item.plan });
        }
        if (result.cid !== item.cid || result.row?.cid !== item.cid || result.row?.content?.planCid !== item.plan.cid ||
            !Buffer.from(canonicalBytes(result.row.content)).equals(canonicalBytes(item.content))) {
            fail(`Index response for ${item.cid} did not verify against the prepared content and plan.`);
        }
        receipt.items[item.sourceCid] = { cid: item.cid, created: result.created, indexedAt: new Date().toISOString() };
        await atomicJson(receiptPath, receipt);
        process.stdout.write(`${item.sourceCid} -> ${item.cid}${result.created ? ' (created)' : ' (already indexed)'}\n`);
    }
    process.stdout.write(`Completed ${Object.keys(receipt.items).length}/${manifest.items.length}; receipt: ${receiptPath}\n`);
}

async function main(argv) {
    if (!argv.length || argv.includes('--help')) { process.stdout.write(`${usage}\n`); return; }
    const args = parseArgs(argv);
    if (Boolean(args['--prepare']) === Boolean(args['--apply'])) fail(`Choose exactly one of --prepare or --apply.\n${usage}`);
    if (args['--prepare']) {
        for (const key of ['--snapshot', '--out', '--authored-at']) if (!args[key]) fail(`Prepare requires ${key}.\n${usage}`);
        const snapshot = JSON.parse(await readFile(args['--snapshot'], 'utf8'));
        const manifest = prepareAgreementRecreation(snapshot, { authoredAt: args['--authored-at'] });
        await atomicJson(args['--out'], manifest);
        process.stdout.write(`Prepared ${manifest.items.length} new agreements at ${resolve(args['--out'])}\n`);
        return;
    }
    await applyManifest(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
