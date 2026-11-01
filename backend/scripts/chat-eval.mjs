#!/usr/bin/env node
// Run explicitly budgeted model evaluations against a live hosted MCP, checkpointing every paid call.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createMcpToolCaller } from '../chat/mcp-client.js';
import { runTurn } from '../chat/turn-runner.js';
import { scoreTurn } from '../chat/eval-score.js';
import { costUsd } from '../chat/cost.js';
import { createChatModelCaller, MAX_CHAT_INPUT_TOKENS } from '../chat/model.js';
import { isSupportedChatModel } from '../chat/openai-config.js';
import { cidOfObject } from '../cid.js';

export const USAGE = 'Usage: node scripts/chat-eval.mjs --run --cases <json> --mcp <url> --model <id> --budget-usd <amount> --input-price <usd/MTok> --output-price <usd/MTok> --cache-read-price <usd/MTok> --cache-write-price <usd/MTok> --output <checkpoint.json> [--provider anthropic|openai] [--limit N] [--case id] [--retry-failed]';
/**
 * Case contract: {id,language,context,turns:[{text,expect}]}. `context.planSeed` is a list of
 * free MCP setup calls: {tool,args,asPlan?,useWorkingPlan?}. `context.selection.memberIndex` is
 * eval metadata only; after setup, the runner opens the returned private plan with ugt_get_plan,
 * verifies the member CID against its canonical content, and replaces the selector with that CID
 * (plus optional buildingIndex) before constructing the model context. Other selections such as
 * parcelIds must be observed source IDs. Turn expectations use scoreTurn's tools, forbidTools,
 * outcome, planChanged, and dotted args assertions.
 */
const flags = new Set(['--run', '--cases', '--mcp', '--model', '--budget-usd', '--input-price', '--output-price', '--cache-read-price', '--cache-write-price', '--output', '--provider', '--limit', '--case', '--retry-failed']);
export function parseArgs(argv) {
    const out = { run: false, retryFailed: false }, seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]; if (!flags.has(key)) throw new Error(`Unknown option: ${key}`);
        if (seen.has(key)) throw new Error(`Repeated option: ${key}`); seen.add(key);
        if (key === '--run') { out.run = true; continue; }
        if (key === '--retry-failed') { out.retryFailed = true; continue; }
        if (out[key.slice(2)] != null || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing or repeated value for ${key}`);
        out[key.slice(2).replaceAll('-', '')] = argv[++i];
    }
    if (!out.run) return { run: false };
    for (const key of ['cases', 'mcp', 'model', 'budgetusd', 'inputprice', 'outputprice', 'cachereadprice', 'cachewriteprice', 'output']) if (!out[key]) throw new Error(`--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)} is required with --run`);
    for (const key of ['budgetusd', 'inputprice', 'outputprice', 'cachereadprice', 'cachewriteprice']) if (!Number.isFinite(Number(out[key])) || Number(out[key]) < 0) throw new Error(`--${key} must be a finite non-negative number`);
    if (Number(out.budgetusd) <= 0) throw new Error('--budget-usd must be greater than zero');
    if (out.limit && (!Number.isInteger(Number(out.limit)) || Number(out.limit) < 1)) throw new Error('--limit must be a positive integer');
    return out;
}
export const pricesOf = args => ({ input: Number(args.inputprice), output: Number(args.outputprice), cache_read: Number(args.cachereadprice), cache_creation: Number(args.cachewriteprice) });
export function callEstimateUsd(prices, { messages = [], tools = [], system = '' } = {}) {
    const inputTokens = MAX_CHAT_INPUT_TOKENS;
    return costUsd({ input_tokens: inputTokens, cache_creation_input_tokens: inputTokens, output_tokens: 2048 }, prices);
}
export function checkpointFingerprint(cases, { provider = 'anthropic', model, mcp, prices }) {
    return createHash('sha256').update(JSON.stringify({ cases, provider, model, mcp: new URL(mcp).href, prices })).digest('hex');
}
export function writeCheckpoint(path, checkpoint) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
}
export function assertBudget({ spentUsd, budgetUsd, nextEstimateUsd }) {
    if (spentUsd + nextEstimateUsd > budgetUsd + 1e-9) throw Object.assign(new Error('Evaluation budget would be exceeded before the next model call.'), { code: 'eval-budget-exhausted', noModelCall: true });
}
export function planFromSeed(tool, result) {
    const value = result?.structuredContent || result || {};
    if (result?.isError || value.placement?.status === 'refused') throw new Error(`${tool} could not prepare the eval plan: ${value.untrusted?.message || value.message || value.placement?.status || 'tool-error'}`);
    const plan = value.plan?.draftRef ? value.plan : ['ugt_draft_plan','ugt_get_plan'].includes(tool) ? value : null;
    if (!plan?.draftRef || !plan.cid) throw new Error(`${tool} did not return a private working-plan reference and CID.`);
    return { draftRef: plan.draftRef, cid: plan.cid };
}
export function resolveSeededSelection(selection, planResult) {
    const value = planResult?.structuredContent || planResult || {};
    const members = value.designs || [];
    const index = Number(selection?.memberIndex);
    if (!Number.isInteger(index) || index < 0 || !members[index]) throw new Error('Eval selection.memberIndex does not resolve to a seeded plan member.');
    const member = members[index], design = member.untrusted?.content || member.untrusted?.design || member.content || member.design;
    const designCid = member.cid;
    if (!designCid || !design || cidOfObject(design) !== designCid) throw new Error(`Seeded plan member ${index} has no matching canonical design content and CID.`);
    const out = { designCid };
    if (selection.buildingIndex != null) {
        const buildingIndex = Number(selection.buildingIndex);
        if (!Number.isInteger(buildingIndex) || buildingIndex < 0 || !design.geometry?.buildings?.[buildingIndex]) throw new Error(`Eval selection buildingIndex does not resolve within seeded design ${designCid}.`);
        out.buildingIndex = buildingIndex;
    }
    return out;
}

export async function refreshSelectionFromPlan(mcp, selection, plan) {
    if (selection?.memberIndex == null) return selection;
    if (!plan) throw new Error('Eval selection.memberIndex requires a seeded working plan.');
    const resolved = await mcp.callTool('ugt_get_plan', { plan: plan.draftRef });
    if (resolved.isError) throw new Error(`Could not open the current eval plan: ${resolved.structuredContent?.untrusted?.message || 'tool-error'}`);
    return resolveSeededSelection(selection, resolved);
}

export function contextForEvalCase(item) {
    return { ...structuredClone(item.context || {}), language: item.language };
}

export function assertEvalTurnCanContinue(result, checkpoint) {
    if (checkpoint.inflight) throw new Error(`Checkpoint records an uncertain paid call for ${checkpoint.inflight.case}; stopping before another call.`);
    if (result.outcome?.code === 'eval-budget-exhausted') throw Object.assign(new Error('Evaluation budget exhausted; stopping with remaining cases incomplete.'), { code: 'eval-budget-exhausted' });
}

async function main(argv) {
    let args;
    try { args = parseArgs(argv); } catch (error) { console.error(`${error.message}\n${USAGE}`); process.exitCode = 2; return; }
    if (!args.run) { console.log(USAGE); return; }
    const provider = args.provider || process.env.CHAT_PROVIDER || 'anthropic';
    if (!['anthropic', 'openai'].includes(provider)) { console.error('--provider must be anthropic or openai.'); process.exitCode = 2; return; }
    if (!isSupportedChatModel(provider, args.model)) { console.error(`Model ${args.model} is not configured for ${provider}.`); process.exitCode = 2; return; }
    const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error(`${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is required to run a paid evaluation.`); process.exitCode = 2; return; }
    const allCases = JSON.parse(readFileSync(args.cases, 'utf8'));
    const selected = allCases.filter(c => !args.case || c.id === args.case).slice(0, args.limit ? Number(args.limit) : undefined);
    if (!selected.length) throw new Error('No evaluation cases selected.');
    const prices = pricesOf(args), budgetUsd = Number(args.budgetusd), fingerprint = checkpointFingerprint(selected, { provider, model: args.model, mcp: args.mcp, prices });
    let checkpoint = { fingerprint, provider, model: args.model, mcp: new URL(args.mcp).href, prices, budgetUsd, spentUsd: 0, cases: {}, inflight: null };
    if (existsSync(args.output)) {
        checkpoint = JSON.parse(readFileSync(args.output, 'utf8'));
        if (checkpoint.fingerprint !== fingerprint) throw new Error('Checkpoint fingerprint differs from the selected cases or run configuration.');
        if (Number(checkpoint.budgetUsd) !== budgetUsd) throw new Error('Checkpoint budget differs from --budget-usd.');
        if (checkpoint.inflight) throw new Error(`Checkpoint records an uncertain paid call for ${checkpoint.inflight.case}; refusing to spend again blindly.`);
        if (Object.values(checkpoint.cases || {}).some(row => row.status === 'running') && !args.retryFailed) throw new Error('Checkpoint has an incomplete case; pass --retry-failed to restart incomplete cases within the remaining budget.');
    }
    const modelCaller = createChatModelCaller({ provider, apiKey, model: args.model });
    const mcp = createMcpToolCaller({ url: args.mcp });
    try {
        const mcpTools = (await mcp.listTools()).tools;
        for (const item of selected) {
            const prior = checkpoint.cases[item.id];
            if (prior?.status === 'passed') continue;
            if (prior?.status === 'failed' && !args.retryFailed) continue;
            const calls = [], turnScores = [], runContext = contextForEvalCase(item);
            const memberSelector = runContext.selection?.memberIndex == null ? null : { ...runContext.selection };
            let conversation = { messages: [], plan: null, planHistory: [], turns: 0 };
            for (const seed of runContext.planSeed || []) {
                const seedArgs = { ...(seed.args || {}) };
                if (seed.useWorkingPlan && conversation.plan) seedArgs.plan = conversation.plan.draftRef;
                const result = await mcp.callTool(seed.tool, seedArgs);
                if (result.isError) throw new Error(`Case ${item.id} seed ${seed.tool} failed: ${result.structuredContent?.untrusted?.message || result.structuredContent?.message || 'tool-error'}`);
                if (seed.asPlan || result.structuredContent?.plan?.draftRef || ['ugt_draft_plan','ugt_get_plan'].includes(seed.tool)) conversation.plan = planFromSeed(seed.tool, result);
            }
            if (memberSelector) {
                if (!conversation.plan) throw new Error(`Case ${item.id} uses an eval member selector without a seeded working plan.`);
            }
            delete runContext.planSeed;
            for (let turnIndex = 0; turnIndex < item.turns.length; turnIndex++) {
                const turn = item.turns[turnIndex];
                if (memberSelector) runContext.selection = await refreshSelectionFromPlan(mcp, memberSelector, conversation.plan);
                const turnCalls = [];
                const callModel = async (request, { signal } = {}) => {
                    const estimate = callEstimateUsd(prices, request);
                    assertBudget({ spentUsd: checkpoint.spentUsd, budgetUsd, nextEstimateUsd: estimate });
                    checkpoint.inflight = { case: item.id, turn: turnIndex, estimateUsd: estimate, startedAt: new Date().toISOString() };
                    writeCheckpoint(args.output, checkpoint);
                    let response;
                    try { response = await modelCaller(request, { signal }); }
                    catch (error) {
                        if (error.noModelCall) { checkpoint.inflight = null; writeCheckpoint(args.output, checkpoint); }
                        throw error;
                    }
                    const usd = costUsd(response.usage, prices);
                    checkpoint.spentUsd = Math.round((checkpoint.spentUsd + usd) * 1e6) / 1e6;
                    checkpoint.inflight = null;
                    checkpoint.cases[item.id] = { status: 'running', calls: [...calls], turnScores: [...turnScores], usage: response.usage, lastCallUsd: usd };
                    writeCheckpoint(args.output, checkpoint);
                    return response;
                };
                const callTool = async (name, toolArgs, options) => {
                    const result = await mcp.callTool(name, toolArgs, options);
                    const row = { tool: name, args: toolArgs, isError: Boolean(result.isError), result: result.structuredContent };
                    calls.push(row); turnCalls.push(row);
                    return result;
                };
                const result = await runTurn({ conversation, text: turn.text, context: { ...runContext, instruction: turn.text }, callModel, callTool, mcpTools, prices, limits: { maxSteps: 8 } });
                assertEvalTurnCanContinue(result, checkpoint);
                conversation = { ...conversation, messages: result.messages, plan: result.plan, planHistory: result.planHistory, turns: turnIndex + 1 };
                const scoreCalls = [...turnCalls, ...result.steps.filter(step => ['ask_person', 'undo_last_change'].includes(step.tool)).map(step => ({ tool: step.tool, args: {} }))];
                turnScores.push({ score: scoreTurn(turn.expect || {}, result, scoreCalls), outcome: result.outcome, planChanged: result.planChanged, costUsd: result.costUsd });
                checkpoint.cases[item.id] = { status: 'running', calls, turnScores, plan: conversation.plan };
                writeCheckpoint(args.output, checkpoint);
            }
            const passed = turnScores.every(row => row.score.passed);
            checkpoint.cases[item.id] = { status: passed ? 'passed' : 'failed', calls, turnScores, plan: conversation.plan };
            writeCheckpoint(args.output, checkpoint);
            console.log(`${item.id}: ${passed ? 'passed' : 'failed'}; spent $${checkpoint.spentUsd.toFixed(6)}`);
        }
    } finally { await mcp.close(); }
    console.log(`Completed ${selected.length} cases; spent $${checkpoint.spentUsd.toFixed(6)} of $${budgetUsd.toFixed(2)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
