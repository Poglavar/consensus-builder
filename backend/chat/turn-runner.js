import { CHAT_TOOL_ALLOWLIST, injectPlanArgs, restrictHelpTopic, toModelTools } from './tool-catalog.js';
import { compactForModel, planFromResult, summarizeStep } from './tool-results.js';
import { contextBlock, SYSTEM_PROMPT } from './system-prompt.js';
import { injectMapArgs, navigationResult } from './navigation.js';
import { costUsd } from './cost.js';

// Pure orchestration for one chat turn; callers own persistence, transport, and cancellation policy.
const clone = value => structuredClone(value ?? []);
const err = (message, code) => ({ type: 'error', code, message });
const toolBlock = content => Array.isArray(content) ? content.filter(block => block.type === 'tool_use') : [];
const toolResultBlock = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

export async function runTurn({ conversation = {}, text = '', context = {}, callModel, callTool, mcpTools, emit = () => {}, limits = {}, prices = {}, now = Date.now, signal } = {}) {
    const maxSteps = Math.max(1, Number(limits.maxSteps) || 8), messages = clone(conversation.messages || []);
    let plan = conversation.plan || null, planHistory = clone(conversation.planHistory || []), usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const mapContext = structuredClone(context);
    let totalCost = 0, planChanged = false, modelCalls = 0, usageUncertain = false, outcome;
    messages.push({ role: 'user', content: contextBlock({ ...context, instruction: text }, plan, conversation.notes || []) });
    const finish = () => ({ messages, plan, planHistory, steps, usage, costUsd: totalCost, planChanged, modelCalls, usageUncertain, outcome });
    const steps = [];
    const addUsage = value => { for (const key of Object.keys(usage)) usage[key] += Number(value?.[key]) || 0; totalCost = costUsd(usage, prices); };
    const listed = mcpTools || await callTool.listTools?.() || conversation.mcpTools || [];
    const toolList = toModelTools(Array.isArray(listed) ? listed : listed.tools || []);
    const modelCall = async closing => {
        modelCalls++;
        const response = await callModel({ system: SYSTEM_PROMPT, tools: toolList, messages, ...(closing ? { toolChoice: { type: 'none' } } : {}) }, { signal });
        addUsage(response.usage);
        return response;
    };
    for (let n = 1; n <= maxSteps + 1; n++) {
        if (signal?.aborted) { outcome = err('The turn was cancelled.', 'aborted'); break; }
        const beforeCall = messages.length;
        let response;
        try { response = await modelCall(n === maxSteps + 1); }
        catch (error) {
            if (error.noModelCall) modelCalls = Math.max(0, modelCalls - 1);
            else usageUncertain = true;
            outcome = err(error.message || 'The model request failed.', error.code || 'model-error'); break;
        }
        if (response.stop_reason === 'refusal') { outcome = err('I can only help with design work in this app.', 'refused'); messages.splice(beforeCall); break; }
        const assistant = { role: 'assistant', content: response.content || [] };
        messages.push(assistant);
        const uses = toolBlock(assistant.content);
        if (!uses.length) {
            const reply = (assistant.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            outcome = { type: 'reply', text: reply }; break;
        }
        if (n > maxSteps) { messages.splice(beforeCall); outcome = err('I reached the step limit. Please ask me to continue.', 'step_limit'); break; }
        if (uses.length > 1) {
            messages.push({ role: 'user', content: uses.map(block => toolResultBlock(block.id, JSON.stringify({ ok: false, code: 'parallel-tools-not-supported', message: 'Please make one tool request at a time.' }), true)) });
            continue;
        }
        const use = uses[0], name = use.name, input = use.input || {};
        if (!CHAT_TOOL_ALLOWLIST.includes(name) && !['ask_person', 'undo_last_change'].includes(name)) {
            messages.push({ role: 'user', content: [toolResultBlock(use.id, JSON.stringify({ ok: false, code: 'tool-not-available', message: 'That tool is not available in chat.' }), true)] });
            continue;
        }
        if (name === 'ask_person') {
            const question = String(input.question || '').slice(0, 1000), options = (Array.isArray(input.options) ? input.options : []).slice(0, 8).map(o => ({ label: String(o.label || '').slice(0, 160), ...(o.ref ? { ref: String(o.ref).slice(0, 300) } : {}) }));
            messages.push({ role: 'user', content: [toolResultBlock(use.id, JSON.stringify({ ok: true, question, options }))] });
            const reply = { ok: true, question, options };
            steps.push({ n, tool: name, ok: true, ms: 0 });
            emit('step', { n, tool: name, summary: summarizeStep(name, input, reply), ok: true });
            outcome = { type: 'question', question, options }; break;
        }
        if (name === 'undo_last_change') {
            const hadPrior = planHistory.length > 0, prior = planHistory.pop();
            if (hadPrior) { plan = prior?.draftRef ? { draftRef: prior.draftRef, cid: prior.cid } : null; planChanged = true; }
            const reply = hadPrior ? { ok: true, plan: plan ? { cid: plan.cid } : null, message: 'The last plan change was undone.' } : { ok: false, code: 'nothing-to-undo', message: 'There is no plan change to undo.' };
            messages.push({ role: 'user', content: [toolResultBlock(use.id, JSON.stringify(reply), !hadPrior)] });
            steps.push({ n, tool: name, ok: hadPrior, ...(hadPrior ? {} : { code: 'nothing-to-undo' }), ms: 0 });
            emit('step', { n, tool: name, summary: summarizeStep(name, input, reply), ok: hadPrior, ...(!hadPrior ? { code: 'nothing-to-undo' } : {}) });
            continue;
        }
        let result, args;
        const toolStarted = now();
        try {
            args = name === 'ugt_help' ? restrictHelpTopic(input) : input;
            args = injectMapArgs(name, injectPlanArgs(name, args, plan), mapContext);
            result = await callTool(name, args, { signal });
        } catch (error) { result = { isError: true, structuredContent: { ok: false, code: error.code || 'tool-error', message: error.message } }; }
        const wasAborted = signal?.aborted;
        const compact = compactForModel(name, result), parsed = (() => { try { return JSON.parse(compact); } catch { return {}; } })();
        const ok = !result?.isError && parsed.ok !== false;
        const navigation = ok ? navigationResult(name, result) : null;
        if (navigation) {
            if (navigation.name === 'view') mapContext.view = navigation.data.view;
            else mapContext.selection = { ...mapContext.selection, ...navigation.data.selection };
            emit(navigation.name, navigation.data);
        }
        const nextPlan = ok ? planFromResult(name, result) : null;
        if (nextPlan && nextPlan.cid && nextPlan.cid !== plan?.cid) {
            planHistory.push(plan ? { ...plan, turn: conversation.turns || 0 } : { draftRef: null, cid: null, turn: conversation.turns || 0 });
            planHistory = planHistory.slice(-25); plan = nextPlan; planChanged = true;
        }
        const ms = Math.max(0, now() - toolStarted);
        steps.push({ n, tool: name, ok, ...(ok ? {} : { code: parsed.code || 'tool-error' }), ms });
        emit('step', { n, tool: name, summary: summarizeStep(name, args, result), ok, ...(!ok ? { code: parsed.code || 'tool-error' } : {}) });
        messages.push({ role: 'user', content: [toolResultBlock(use.id, compact, !ok)] });
        if (wasAborted) { outcome = err('The turn was cancelled.', 'aborted'); break; }
    }
    if (!outcome) outcome = err('The turn could not be completed.', 'turn-incomplete');
    return finish();
}
