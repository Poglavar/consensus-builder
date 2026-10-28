// Publishes a restatement (restatements/README.md) as designs plus one agreement per plan
// (plan-design-agreement.md, M3: a restated plan is its designs and one community-vote agreement over
// them, with no lens, money, allocations or deadline): every restatement script hands its plans to
// runRestatementCli. A plan is { key, title, author, city, parcelSourceId, groundFile,
// designs: [{ key, record }] } with the local design records in authored (replay) order. The steps:
//   --dry-run    build every design/v1 object (no network) and print it, and the agreement's CID when the
//                plan's ground file is current;
//   --designs    pin and index each design that is not a parcel layout (POST /pins, POST /designs); pin
//                each parcel layout and ask the binding of its site (POST /designs/binding): the index
//                takes a layout only with its agreement;
//   --capture    open the running app with agent-browser, apply the designs exactly as an agreement link
//                does and derive the agreement's land as agreement-sync.js deriveLand does, into the
//                plan's committed ground file;
//   --agreement  build the agreement/v1 object from the ground file, pin it and index it (POST
//                /agreements) with its parcel layouts.
// --apply gates every write to the courier and the index. Progress is checkpointed per design in
// ~/.config/ugt/restatements/<api host>/<plan key>.json, so a rerun skips what is published and a 429
// (waited out by the client) or a crash loses nothing. The same content always gives the same CIDs,
// so a rerun of a published plan publishes nothing new.

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { canonicalBytes } from '../../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../../storage/pinning.js';
import { agreementObject, communityRule, designObject, isParcelLayout, noMoney, planForDesigns } from '../../agents/agreement-objects.js';
import { cityMoney } from './frontend-city-money.mjs';
import { cleanApiBase, createIndexClient } from '../../agents/publication-client.js';

const require = createRequire(import.meta.url);
const formationDepth = require('../../../frontend/js/proposals/formation-depth.js');
const corridorOsmForm = require('../../../frontend/js/corridor-osm-form.js');

export const STATE_ROOT = path.join(os.homedir(), '.config', 'ugt', 'restatements');
// The index links at most this many designs to one agreement (routes/agreements.js
// MAX_AGREEMENT_DESIGNS; that module loads the proposal routes, so the number is restated here).
export const MAX_AGREEMENT_DESIGNS = 200;
// How long the app may take to load, apply a plan's designs and derive its land.
const CAPTURE_BUDGET_MS = 30 * 60 * 1000;
const CAPTURE_READY_MS = 5 * 60 * 1000;
// A condition wait that fails sooner than this did not time out: the command itself failed.
const WAIT_ERROR_MS = 5 * 1000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
// A refusal the script states itself; its message says everything, so no stack is printed for it.
const fail = message => { throw Object.assign(new Error(message), { stated: true }); };
const firstLine = error => String((error && error.message) || error).split('\n')[0];
const isInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
const sameText = (a, b) => canonicalBytes(a).equals(canonicalBytes(b));
const shortCid = cid => `${cid.slice(0, 12)}…${cid.slice(-6)}`;
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

// ---- the objects -------------------------------------------------------------------------------------

/**
 * A road definition as the app holds it: the view decoded from the OSM record it stores
 * (corridor-osm-form.js toRecord, then toView). A design published in any other view would hash
 * differently once the app has stored and reloaded it, and its agreement would read as changed.
 */
export function canonicalRoadDefinition(definition) {
    const view = corridorOsmForm.toView(corridorOsmForm.toRecord(structuredClone(definition)));
    const again = corridorOsmForm.toView(corridorOsmForm.toRecord(structuredClone(view)));
    if (!sameText(view, again)) throw new Error('the road does not read back as itself from its OSM record');
    return structuredClone(view);
}

/**
 * A local design record in the form the app keeps once it imports it (proposals/data.js
 * _normalizeProposal, design-sync.js importDesign): the road view as stored, no apply-time or alias
 * fields (formation-depth.js stripDerivedRecordData), no empty building parameters. Its createdAt (the
 * design's authoredAt) must be a fixed source date: the app fills an empty one with the import time,
 * which would give the imported design another CID.
 */
export function canonicalDesignRecord(local, label) {
    if (!local || typeof local !== 'object' || Array.isArray(local)) fail(`${label}: a design record is an object`);
    if (!isInstant(local.createdAt)) {
        fail(`${label}: a restatement design needs a fixed source date as its createdAt (an ISO instant), got ${JSON.stringify(local.createdAt)}`);
    }
    let record = structuredClone(local);
    if (record.roadProposal?.definition) {
        try {
            record.roadProposal.definition = canonicalRoadDefinition(record.roadProposal.definition);
        } catch (error) {
            fail(`${label}: ${error.message}`);
        }
    }
    record = formationDepth.stripDerivedRecordData(record);
    const parameters = record.buildingProposal?.parameters;
    if (parameters && typeof parameters === 'object') {
        Object.keys(parameters).forEach(key => { if (parameters[key] === null || parameters[key] === undefined) delete parameters[key]; });
    }
    return record;
}

/**
 * The design/v1 objects of a plan, in its order: [{ key, content, cid, layout, bytes }]. Refuses what
 * the courier or the index would refuse later (an object over the pin limit, more designs than an
 * agreement links, a parcel layout without its site, a design of another city), and two designs that
 * are one object.
 */
export function planObjects(plan) {
    if (!Array.isArray(plan.designs) || !plan.designs.length) fail(`${plan.key}: the plan has no designs`);
    if (plan.designs.length > MAX_AGREEMENT_DESIGNS) {
        fail(`${plan.key}: ${plan.designs.length} designs, but an agreement links at most ${MAX_AGREEMENT_DESIGNS}`);
    }
    const seen = new Map();
    return plan.designs.map(({ key, record }) => {
        const label = `${plan.key}/${key}`;
        const canonical = canonicalDesignRecord(record, label);
        let object;
        try { object = designObject(canonical); }
        catch (error) { fail(`${label}: ${error.message}`); }
        const { content, cid } = object;
        const bytes = canonicalBytes(content).length;
        if (bytes > MAX_PINNED_OBJECT_BYTES) fail(`${label}: the design is ${bytes} bytes; the courier pins at most ${MAX_PINNED_OBJECT_BYTES}`);
        if (seen.has(cid)) fail(`${plan.key}: designs ${seen.get(cid)} and ${key} are the same object (${cid})`);
        seen.set(cid, key);
        if (content.city !== plan.city) fail(`${label}: the design names city ${content.city}, the plan ${plan.city}`);
        const layout = isParcelLayout(content);
        if (layout && !content.site) fail(`${label}: a parcel layout is published with its site (its pool), so its binding can be asked before its agreement`);
        return { key, content, cid, layout, bytes };
    });
}

// The ground file is current when it was captured over exactly these designs, in this order.
function groundIsCurrent(ground, objects) {
    return !!ground && Array.isArray(ground.designCids) && ground.designCids.length === objects.length
        && ground.designCids.every((cid, index) => cid === objects[index].cid);
}

/** The plan's agreement/v1 object (decision A: a community vote, no lens, money, allocations or deadline). */
export function planAgreement(plan, objects, ground) {
    const { content, cid, plan: namedPlan } = agreementObject({
        title: plan.title,
        author: plan.author,
        sponsor: null,
        city: plan.city,
        createdAt: null,
        plan: planForDesigns(plan.title, objects),
        designs: objects.map(object => ({ cid: object.cid, goal: object.content.goal, title: object.content.title })),
        parcels: ground.inputs.map(parcel => ({
            parcelId: parcel.parcelId,
            areaM2: parcel.areaM2,
            ...(plan.parcelSourceId ? { parcelSourceId: plan.parcelSourceId } : {})
        })),
        openGroundM2: ground.openGroundM2,
        outputs: ground.outputs,
        allocations: [],
        money: noMoney(cityMoney(plan.city).currentCurrency()),
        rule: communityRule([]),
        deadline: null
    });
    const bytes = canonicalBytes(content).length;
    if (bytes > MAX_PINNED_OBJECT_BYTES) fail(`${plan.key}: the agreement is ${bytes} bytes; the courier pins at most ${MAX_PINNED_OBJECT_BYTES}`);
    return { content, cid, bytes, plan: namedPlan };
}

// The parcels the index would refuse as the agreement's inputs, as routes/agreements.js
// inputsAgainstBindings counts them: bound but not an input (missing), an input no design binds (extra,
// not judged when a binding's coverage is unknown).
function inputsAgainstBindings(inputParcelIds, bindings) {
    const bound = new Set();
    let unverified = false;
    for (const binding of bindings) {
        if (binding?.coverage === 'unknown') unverified = true;
        for (const hit of binding?.parcels || []) bound.add(String(hit.parcelId));
    }
    const inputs = new Set(inputParcelIds.map(String));
    return {
        missing: [...bound].filter(id => !inputs.has(id)).sort(),
        extra: unverified ? [] : [...inputs].filter(id => !bound.has(id)).sort()
    };
}

// ---- files ---------------------------------------------------------------------------------------------

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`${file}: ${error.message}`);
    }
}

// Written whole or not at all: a kill mid-write leaves the previous file.
async function writeJsonAtomic(file, value, indent = 1) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, indent)}\n`);
    await rename(temporary, file);
}

function statePath(apiBase, plan) {
    return path.join(STATE_ROOT, slug(new URL(apiBase).host), `${slug(plan.key)}.json`);
}

async function readState(apiBase, plan) {
    const file = statePath(apiBase, plan);
    const state = await readJson(file);
    return { file, value: state || { comment: 'Checkpoint of restatement-publish.mjs: what this API holds of the plan, by CID.', api: apiBase, plan: plan.key, designs: {}, agreements: {} } };
}

const saveState = state => writeJsonAtomic(state.file, state.value, 2);

// ---- steps ---------------------------------------------------------------------------------------------

// A parcel layout's binding: what its site takes on the server (POST /designs/binding, a read), kept in
// the checkpoint. The index binds the layout the same way when its agreement carries it.
async function layoutBinding(client, state, plan, object) {
    const entry = state.value.designs[object.cid] || { goal: object.content.goal, title: object.content.title, layout: true };
    state.value.designs[object.cid] = entry;
    if (!entry.binding) {
        entry.binding = (await client.designBinding({
            site: object.content.site, toleranceM: object.content.toleranceM, city: plan.city, parcelSourceId: plan.parcelSourceId
        })).binding;
        await saveState(state);
    }
    return entry.binding;
}

function printObjects(plan, objects) {
    objects.forEach((object, index) => {
        const tag = object.layout ? ' [parcel layout: published with the agreement]' : '';
        log(`${plan.key} ${index + 1}/${objects.length} ${object.content.goal} ${object.cid} "${object.content.title}" (${object.bytes} bytes)${tag}`);
    });
}

async function stepDryRun(plan, objects, ctx) {
    printObjects(plan, objects);
    const ground = await readJson(plan.groundFile);
    if (!groundIsCurrent(ground, objects)) {
        log(`${plan.key}: ${ground ? 'the ground file was captured over other designs' : 'no ground file yet'} (${path.relative(process.cwd(), plan.groundFile)}): run --capture for its agreement`);
        return;
    }
    const agreement = planAgreement(plan, objects, ground);
    log(`${plan.key}: agreement ${agreement.cid} "${plan.title}" over ${objects.length} designs, ${ground.inputs.length} input parcels, ${ground.outputs.length} outputs (${agreement.bytes} bytes)`);
    if (ctx.app) log(`${plan.key}: link ${agreementLink(ctx.app, agreement.cid, plan.city)}`);
}

async function stepDesigns(plan, objects, ctx) {
    if (!ctx.apply) {
        const state = ctx.api ? (await readState(ctx.api, plan)).value : { designs: {} };
        objects.forEach((object, index) => {
            const entry = state.designs[object.cid] || {};
            const done = entry.indexed || (object.layout && entry.pinned && entry.binding);
            const action = object.layout ? 'pin and ask its binding' : 'pin and index';
            log(`${plan.key} ${index + 1}/${objects.length} ${object.content.goal} ${object.cid} "${object.content.title}": ${done ? 'done (checkpoint)' : `would ${action}`}`);
        });
        log(`${plan.key}: DRY RUN: nothing pinned or indexed (add --apply)`);
        return;
    }
    const client = ctx.client();
    const state = await readState(ctx.api, plan);
    // What the index holds already (a layout once another plan's agreement carried it): a rerun, or a
    // run from another machine, skips it.
    const held = await client.getDesigns(objects.map(object => object.cid));
    for (const [index, object] of objects.entries()) {
        const prefix = `${plan.key} ${index + 1}/${objects.length} ${object.content.goal} ${shortCid(object.cid)} "${object.content.title}"`;
        const entry = state.value.designs[object.cid] || { goal: object.content.goal, title: object.content.title, layout: object.layout };
        state.value.designs[object.cid] = entry;
        const row = held.get(object.cid);
        if (row) {
            if (!entry.indexed || !entry.binding) {
                Object.assign(entry, { indexed: true, binding: row.binding });
                await saveState(state);
            }
            log(`${prefix}: already indexed (${row.binding?.parcels?.length ?? 0} parcels)`);
            continue;
        }
        if (object.layout) {
            if (!entry.pinned) {
                Object.assign(entry, { pinned: true, pinnedAt: (await client.pin('design', object.content)).pinnedAt ?? null });
                await saveState(state);
            }
            const binding = await layoutBinding(client, state, plan, object);
            log(`${prefix}: pinned; binds ${binding.parcels.length} parcels (coverage ${binding.coverage}); indexed with the agreement`);
            continue;
        }
        if (!entry.pinned) {
            Object.assign(entry, { pinned: true, pinnedAt: (await client.pin('design', object.content)).pinnedAt ?? null });
            await saveState(state);
        }
        const indexed = await client.indexDesign(object.cid, object.content, { parcelSourceId: plan.parcelSourceId });
        Object.assign(entry, { indexed: true, binding: indexed.row.binding });
        await saveState(state);
        log(`${prefix}: ${indexed.created ? 'indexed' : 'already indexed'} (${indexed.row.binding?.parcels?.length ?? 0} parcels)`);
    }
    log(`${plan.key}: ${objects.length} designs published to ${ctx.api} · checkpoint ${state.file}`);
}

// The page job (an async IIFE): wait for the app, serve the parcel layouts the index does not hold
// yet, apply the designs as an agreement link does (handleSharedDesignRoute) and derive the land as
// agreement-sync.js deriveLand does. It runs in the background and leaves its outcome on
// window.__restatementCapture, which the node side waits on, so no single browser command outlives
// the tool's own timeout.
export function capturePageScript(config) {
    return `(() => {
    const config = ${JSON.stringify(config)};
    if (window.__restatementCapture && window.__restatementCapture.state === 'running') return 'already running';
    const job = { state: 'running', log: [], result: null, error: null };
    window.__restatementCapture = job;
    const note = message => {
        const line = '[' + new Date().toISOString() + '] ' + message;
        job.log.push(line);
        console.log('[restatement-capture] ' + line);
    };
    const fail = message => { throw new Error(message); };
    const NEEDED = ['map', 'handleSharedDesignRoute', 'DesignSync', 'DesignRecord', 'AgreementGround', 'AgreementDialog',
        'LiveParcelFabric', 'CadastralParcelRepository', 'proposalStorage', 'PersistentStorage', 'agentStorage', 'isApplied', 'turf'];
    (async () => {
        note('waiting for the app');
        const t0 = Date.now();
        while (NEEDED.some(name => window[name] == null)) {
            if (Date.now() - t0 > config.readyMs) fail('the app did not load ' + NEEDED.filter(name => window[name] == null).join(', '));
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        // A link opens without the newcomer's profile dialog (user-management.js isProposalDeepLinkPath).
        window.shouldSkipWelcomeForProposalLink = () => true;
        // The index holds every design but the parcel layouts, which it takes only with their agreement:
        // the batch read answers them from here, as the rows the index will hold.
        const layoutRows = new Map(config.layoutRows.map(row => [row.cid, row]));
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
            if (method !== 'POST' || !/\\/designs\\/batch\\/?$/.test(url.pathname) || !init || typeof init.body !== 'string') return nativeFetch(input, init);
            const asked = JSON.parse(init.body).cids || [];
            if (!asked.some(cid => layoutRows.has(cid))) return nativeFetch(input, init);
            const rest = asked.filter(cid => !layoutRows.has(cid));
            const items = new Map();
            if (rest.length) {
                const response = await nativeFetch(input, { ...init, body: JSON.stringify({ cids: rest }) });
                if (!response.ok) return response;
                (await response.json()).items.forEach(item => items.set(item.cid, item));
            }
            const merged = asked.map(cid => (layoutRows.has(cid) ? { cid, design: layoutRows.get(cid) } : items.get(cid) || { cid, design: null }));
            return new Response(JSON.stringify({ items: merged, count: merged.filter(item => item.design).length }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        note('applying ' + config.cids.length + ' design(s)');
        const opened = await window.handleSharedDesignRoute(config.cids, { openDetails: false, enter3D: false, summary: false, frame: false });
        if (opened.blocked) fail('the app opened the designs in another city');
        if (opened.failed.length) {
            fail(opened.failed.length + ' design(s) could not be applied: ' + opened.failed.map(item => (item.label || item.id) + ': ' + item.reason).join('; '));
        }
        const localToCid = new Map();
        const records = config.cids.map(cid => {
            const id = opened.localIds.get(cid);
            const record = id ? window.proposalStorage.getProposal(id) : null;
            if (!record) fail('design ' + cid + ' has no local record after the import');
            if (!window.isApplied(record)) fail('design ' + cid + ' is not applied');
            localToCid.set(String(id), cid);
            return record;
        });
        // The CID the app computes for each design as it now holds it: an agreement over these CIDs
        // reads as current in the app only if the import changed nothing.
        const designs = records.map((record, index) => ({ cid: config.cids[index], here: window.DesignRecord.cidOf(record) }));
        note('deriving the land');
        const fabric = window.LiveParcelFabric;
        const ids = window.AgreementDialog.inputParcelIds(records, fabric);
        let features = [];
        if (ids.length && !(window.ParcelGroundFallback && window.ParcelGroundFallback.isWithoutParcels && window.ParcelGroundFallback.isWithoutParcels())) {
            const loaded = await window.CadastralParcelRepository.ensureIds(ids, { retainOnly: true });
            features = Array.isArray(loaded && loaded.features) ? loaded.features : [];
        }
        const derived = window.AgreementGround.derive({
            designs: records,
            fabric,
            originals: window.AgreementDialog.originalsById(features, fabric && fabric.featureId),
            area: feature => window.turf.area(feature)
        });
        const outputs = derived.outputs.map(output => {
            let producedBy = null;
            if (output.producedBy !== null && output.producedBy !== undefined) {
                producedBy = localToCid.get(String(output.producedBy)) || null;
                if (!producedBy) fail('piece ' + output.hash + ' is produced by ' + output.producedBy + ', which is not a design of this plan');
            }
            return { hash: output.hash, areaM2: output.areaM2, fromParcelIds: output.fromParcelIds, role: output.role, producedBy };
        });
        job.result = {
            designs,
            inputs: derived.inputs.parcels.map(parcel => ({ parcelId: parcel.parcelId, areaM2: parcel.areaM2 })),
            openGroundM2: derived.inputs.openGroundM2,
            outputs
        };
        note('derived ' + job.result.inputs.length + ' input parcels and ' + outputs.length + ' outputs');
        job.state = 'done';
    })().catch(error => {
        job.error = String((error && error.stack) || error);
        job.state = 'failed';
        note('failed: ' + ((error && error.message) || error));
    });
    return 'started';
})()`;
}

// agent-browser prints an eval's value as JSON; a string value may itself be JSON.
function parseEvalOutput(text) {
    const trimmed = String(text || '').trim();
    let value;
    try { value = JSON.parse(trimmed); } catch (_) { return trimmed; }
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return value; }
    }
    return value;
}

function agreementLink(app, cid, city) {
    return `${app.replace(/\/+$/, '')}/agreements/${cid}?city=${encodeURIComponent(city)}`;
}

async function captureInApp(plan, config, ctx) {
    const session = `restatement-${slug(plan.key)}-${process.pid}`;
    const browser = (args, options = {}) => execFileSync('agent-browser', ['--session', session, ...args],
        { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const url = `${ctx.app.replace(/\/+$/, '')}/?city=${encodeURIComponent(plan.city)}&reduceMotion=1&backend=${encodeURIComponent(ctx.api)}`;
    try {
        log(`${plan.key}: opening the app (agent-browser session ${session})`);
        try {
            browser(['open', url], { timeout: 180_000 });
        } catch (error) {
            // A slow load can outlast the command; the page is checked rather than opened twice.
            const at = String(browser(['get', 'url'])).trim();
            if (!at.startsWith(ctx.app.replace(/\/+$/, ''))) throw error;
            log(`${plan.key}: the app is still loading (${firstLine(error)}); continuing`);
        }
        browser(['eval', '--stdin'], { input: capturePageScript(config), timeout: 120_000 });
        const deadline = Date.now() + CAPTURE_BUDGET_MS;
        let shown = 0;
        for (;;) {
            const waitedSince = Date.now();
            try {
                browser(['wait', '--fn', "window.__restatementCapture && window.__restatementCapture.state !== 'running'"], { timeout: 180_000 });
            } catch (error) {
                // agent-browser gives up on a condition after its own timeout (25 s by default); that is
                // judged by the job's state below. A quicker failure is an error of the command itself.
                if (Date.now() - waitedSince < WAIT_ERROR_MS) throw new Error(`agent-browser wait failed: ${firstLine(error)}`);
            }
            const job = parseEvalOutput(browser(['eval', 'window.__restatementCapture ? { state: window.__restatementCapture.state, log: window.__restatementCapture.log } : null'], { timeout: 120_000 }));
            if (!job || typeof job !== 'object') throw new Error('the page lost the capture job (it reloaded or navigated away)');
            job.log.slice(shown).forEach(line => log(`${plan.key}: app ${line}`));
            shown = job.log.length;
            if (job.state === 'failed') {
                throw new Error(`the app could not derive the land: ${parseEvalOutput(browser(['eval', 'window.__restatementCapture.error'], { timeout: 120_000 }))}`);
            }
            if (job.state === 'done') break;
            if (Date.now() > deadline) throw new Error(`the app did not finish within ${CAPTURE_BUDGET_MS / 60000} minutes`);
        }
        return parseEvalOutput(browser(['eval', 'window.__restatementCapture.result'], { timeout: 120_000 }));
    } finally {
        try { browser(['close'], { timeout: 120_000 }); } catch (error) { log(`${plan.key}: closing session ${session} failed: ${firstLine(error)}`); }
    }
}

async function stepCapture(plan, objects, ctx) {
    const client = ctx.client();
    const state = await readState(ctx.api, plan);
    const held = await client.getDesigns(objects.map(object => object.cid));
    const unpublished = objects.filter(object => !object.layout && !held.has(object.cid));
    if (unpublished.length) {
        fail(`${plan.key}: the index at ${ctx.api} does not hold ${unpublished.length} design(s) (${unpublished.map(object => object.key).join(', ')}): run --designs --apply first`);
    }
    // The rows the index will hold for the parcel layouts once their agreement carries them (a layout
    // another agreement carried already is read from the index like any design).
    const layoutRows = [];
    for (const object of objects.filter(candidate => candidate.layout && !held.has(candidate.cid))) {
        layoutRows.push({
            cid: object.cid, city: plan.city, goal: object.content.goal, title: object.content.title, author: object.content.author,
            originCid: null, binding: await layoutBinding(client, state, plan, object), content: object.content,
            screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null, createdAt: null
        });
    }
    const cids = objects.map(object => object.cid);
    const result = await captureInApp(plan, { cids, layoutRows, readyMs: CAPTURE_READY_MS }, ctx);
    if (!result || !Array.isArray(result.designs) || !Array.isArray(result.inputs) || !Array.isArray(result.outputs)) {
        fail(`${plan.key}: the app answered no land: ${JSON.stringify(result).slice(0, 300)}`);
    }
    const changed = result.designs.filter(design => design.here !== design.cid);
    if (changed.length) {
        fail(`${plan.key}: the app holds ${changed.length} design(s) differently from their published object, so an agreement over them would read as changed: `
            + changed.map(design => `${design.cid} → ${design.here}`).join(', '));
    }
    if (!result.inputs.length && !(result.openGroundM2 > 0)) fail(`${plan.key}: the designs take no land in the app`);
    const known = new Set(cids);
    const stray = result.outputs.filter(output => output.producedBy !== null && !known.has(output.producedBy));
    if (stray.length) fail(`${plan.key}: ${stray.length} output(s) name a producer outside the plan`);
    // The index admits the agreement only when its inputs are exactly what the designs bind there.
    const layoutBindings = new Map(layoutRows.map(row => [row.cid, row.binding]));
    const land = inputsAgainstBindings(result.inputs.map(parcel => parcel.parcelId),
        objects.map(object => (held.has(object.cid) ? held.get(object.cid).binding : layoutBindings.get(object.cid))));
    if (land.missing.length || land.extra.length) {
        fail(`${plan.key}: the app derives input parcels the index would refuse${land.missing.length ? `; bound on the server but not derived: ${land.missing.join(', ')}` : ''}`
            + `${land.extra.length ? `; derived but bound by no design: ${land.extra.join(', ')}` : ''}`);
    }
    const ground = {
        comment: `Generated by ${plan.script} --capture: the land the app derives for this plan's agreement (its designs applied as an agreement link applies them, AgreementGround.derive). --agreement builds the agreement from it; recapture when a design changes.`,
        plan: plan.key,
        designCids: cids,
        inputs: result.inputs,
        openGroundM2: result.openGroundM2,
        outputs: result.outputs
    };
    const agreement = planAgreement(plan, objects, ground);
    await writeJsonAtomic(plan.groundFile, ground);
    log(`${plan.key}: ${result.inputs.length} input parcels, ${result.outputs.length} outputs, open ground ${Math.round(result.openGroundM2)} m² → ${path.relative(process.cwd(), plan.groundFile)} · agreement ${agreement.cid}`);
}

async function stepAgreement(plan, objects, ctx) {
    const ground = await readJson(plan.groundFile);
    if (!ground) fail(`${plan.key}: no ground file (${path.relative(process.cwd(), plan.groundFile)}): run --capture first`);
    if (!groundIsCurrent(ground, objects)) {
        fail(`${plan.key}: the ground file was captured over other designs than the plan's current ones: recapture (--capture)`);
    }
    const agreement = planAgreement(plan, objects, ground);
    const layouts = objects.filter(object => object.layout);
    log(`${plan.key}: agreement ${agreement.cid} "${plan.title}": ${objects.length} designs (${layouts.length} parcel layout(s)), ${ground.inputs.length} input parcels, ${ground.outputs.length} outputs (${agreement.bytes} bytes)`);
    const link = ctx.app ? agreementLink(ctx.app, agreement.cid, plan.city) : null;
    if (!ctx.apply) {
        log(`${plan.key}: DRY RUN: the agreement is not pinned or indexed (add --apply --api <api>)`);
        return;
    }
    const client = ctx.client();
    const state = await readState(ctx.api, plan);
    const existing = await client.getAgreement(agreement.cid);
    if (existing) {
        state.value.agreements[agreement.cid] = { indexedAt: existing.createdAt || null };
        await saveState(state);
        log(`${plan.key}: agreement ${agreement.cid} is already indexed${link ? ` · ${link}` : ''}`);
        return;
    }
    // Every design the agreement links must be indexed, or travel with it (the layouts).
    const held = await client.getDesigns(objects.map(object => object.cid));
    const unpublished = objects.filter(object => !object.layout && !held.has(object.cid));
    if (unpublished.length) fail(`${plan.key}: the index does not hold ${unpublished.length} design(s) (${unpublished.map(object => object.key).join(', ')}): run --designs --apply first`);
    const bindings = [];
    for (const object of objects) {
        bindings.push(held.has(object.cid) ? held.get(object.cid).binding : await layoutBinding(client, state, plan, object));
    }
    const land = inputsAgainstBindings(ground.inputs.map(parcel => parcel.parcelId), bindings);
    if (land.missing.length || land.extra.length) {
        fail(`${plan.key}: the index would refuse the agreement's inputs: they must be exactly the parcels its designs bind on the server`
            + `${land.missing.length ? `; bound but not inputs: ${land.missing.join(', ')}` : ''}${land.extra.length ? `; inputs no design binds: ${land.extra.join(', ')}` : ''}`);
    }
    // The layouts the index does not hold yet travel with the agreement, pinned (one it holds was pinned
    // when another agreement carried it).
    const carried = layouts.filter(object => !held.has(object.cid));
    for (const object of carried) {
        const entry = state.value.designs[object.cid];
        if (!entry.pinned) {
            Object.assign(entry, { pinned: true, pinnedAt: (await client.pin('design', object.content)).pinnedAt ?? null });
            await saveState(state);
        }
    }
    const published = await client.publishAgreement(agreement.content, { plan: agreement.plan,
        designs: carried.map(object => ({ cid: object.cid, content: object.content })) });
    for (const object of carried) state.value.designs[object.cid].indexed = true;
    state.value.agreements[agreement.cid] = { indexedAt: published.row.createdAt ?? null };
    await saveState(state);
    log(`${plan.key}: agreement ${agreement.cid} ${published.created ? 'indexed' : 'was already indexed'} with ${carried.length} parcel layout(s) carried${link ? ` · ${link}` : ''}`);
}

// ---- the command line ------------------------------------------------------------------------------

function usage({ script, describe, keys, extra }) {
    const own = Object.entries(extra).map(([name, option]) => `${`  --${name}${option.type === 'string' ? ' <value>' : ''}`.padEnd(17)} ${option.description}`).join('\n');
    return `Usage: node ${script} <step…> [options]

Publishes ${describe} as designs plus one agreement per plan (backend/scripts/lib/restatement-publish.mjs).

Steps (run in this order when several are given):
  --dry-run      Build the design objects from the committed data and print each design's goal, title
                 and CID, and the agreement's CID when the plan's ground file is current. No network.
  --designs      Pin and index every design that is not a parcel layout; pin each parcel layout and ask
                 the binding of its site (the index takes a layout with its agreement).
  --capture      Open the running app with agent-browser, apply the designs as an agreement link does and
                 write the land it derives (input parcels, output pieces) to the plan's ground file.
  --agreement    Build the agreement from the ground file; pin it and index it with its parcel layouts.

Options:
  --api <url>     The API (required by --designs, --capture and --agreement --apply).
  --app <url>     The running app (required by --capture; links the agreement when given).
  --origin <url>  Origin header for writes; required with --apply when the API is not on localhost.
  --apply         Write to the courier and the index. Without it the steps print what they would publish.
  --only <keys>   Comma-separated plan keys (default: every plan).
  --help          This text.
${own ? `\nOptions of this script:\n${own}\n` : ''}
Plans: ${keys.join(', ')}
Checkpoints: ${STATE_ROOT.replace(os.homedir(), '~')}/<api host>/<plan key>.json`;
}

/**
 * The command line of a restatement script.
 * @param {{ script: string, describe: string, planKeys: string[], plans: (values) => Promise<object[]>,
 *   options?: { [name]: { type: 'string' | 'boolean', description: string } } }} options
 *   script: the path printed in usage and ground files; planKeys: the plan keys (for usage and --only,
 *   without building anything); plans: builds the plans from the parsed command line; options: the
 *   script's own options, besides the steps'
 */
export async function runRestatementCli({ script, describe, planKeys, plans, options = {}, argv = process.argv.slice(2) }) {
    const own = Object.fromEntries(Object.entries(options).map(([name, option]) => [name, { type: option.type }]));
    const help = () => usage({ script, describe, keys: planKeys, extra: options });
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                ...own,
                'dry-run': { type: 'boolean' }, designs: { type: 'boolean' }, capture: { type: 'boolean' }, agreement: { type: 'boolean' },
                api: { type: 'string' }, app: { type: 'string' }, origin: { type: 'string' }, apply: { type: 'boolean' },
                only: { type: 'string' }, help: { type: 'boolean' }
            },
            strict: true
        }));
    } catch (error) {
        console.error(`${error.message}\n\n${help()}`);
        process.exitCode = 1;
        return;
    }
    const steps = ['dry-run', 'designs', 'capture', 'agreement'].filter(step => values[step]);
    if (values.help || !steps.length) {
        console.log(help());
        return;
    }
    try {
        const api = values.api ? cleanApiBase(values.api) : null;
        const app = values.app ? cleanApiBase(values.app) : null;
        if (!api && ((values.designs && values.apply) || values.capture || (values.agreement && values.apply))) {
            fail('--api <url> is required for --designs --apply, --capture and --agreement --apply');
        }
        if (values.capture && !app) fail('--capture needs --app <app url>');
        const local = api ? LOCAL_HOSTS.has(new URL(api).hostname) : false;
        if (values.apply && api && !local && !values.origin) fail('--apply to an API that is not on localhost needs --origin <app origin> (the origin its write guard admits)');
        const origin = values.origin ? cleanApiBase(values.origin) : (api ? new URL(api).origin : null);
        const only = values.only ? new Set(values.only.split(',').map(key => key.trim()).filter(Boolean)) : null;
        if (only) {
            const unknown = [...only].filter(key => !planKeys.includes(key));
            if (unknown.length) fail(`unknown plan key(s): ${unknown.join(', ')} (plans: ${planKeys.join(', ')})`);
        }
        let client = null;
        const ctx = {
            api, app, apply: values.apply === true,
            client: () => {
                if (!api) fail('this step needs --api <url>');
                client = client || createIndexClient({ apiBase: api, origin, waitOnRateLimit: true, log });
                return client;
            }
        };
        const built = (await plans(values)).filter(plan => !only || only.has(plan.key));
        for (const [index, plan] of built.entries()) {
            const objects = planObjects(plan);
            log(`plan ${index + 1}/${built.length} ${plan.key} "${plan.title}": ${objects.length} designs (${objects.filter(object => object.layout).length} parcel layout(s))`);
            const planned = { ...plan, script };
            if (steps.includes('dry-run')) await stepDryRun(planned, objects, ctx);
            if (steps.includes('designs')) await stepDesigns(planned, objects, ctx);
            if (steps.includes('capture')) await stepCapture(planned, objects, ctx);
            if (steps.includes('agreement')) await stepAgreement(planned, objects, ctx);
        }
        log(`done: ${steps.join(', ')} for ${built.length} plan(s)`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ${script} failed: ${error.stated ? error.message : (error.stack || error.message)}`);
        process.exitCode = 1;
    }
}
