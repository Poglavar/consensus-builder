// Pure immutable reducer for the chat transcript and turn status.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chatTranscript = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const initial = () => ({ conversation: null, messages: [], pending: false,
        totals: { spentUsd: 0, turns: 0 }, lastPlan: null, error: null });
    function serializeConversation(state, { you = 'You', agent = 'Agent', options = 'Options' } = {}) {
        return (state?.messages || []).map(message => {
            const lines = [];
            const text = String(message.text || '').trim();
            if (text) lines.push(`${message.role === 'user' ? you : agent}: ${text}`);
            if (message.role === 'agent' && message.options?.length) {
                lines.push(`${options}: ${message.options.map(option => String(option.label || '').trim()).filter(Boolean).join(' · ')}`);
            }
            return lines.filter(Boolean).join('\n');
        }).filter(Boolean).join('\n\n');
    }
    function errorKey(code, status) {
        if (code === 'map_command_failed') return 'chat.errors.mapCommand';
        if (code === 'budget_exhausted' || status === 402) return 'chat.errors.budget';
        if (String(code || '').startsWith('rate_limited') || status === 429) return 'chat.errors.rateLimited';
        if (status >= 500 || ['unavailable', 'budget_check_failed'].includes(code)) return 'chat.errors.unavailable';
        return 'chat.errors.stream';
    }
    function reduce(state = initial(), action = {}) {
        const next = { ...state, messages: state.messages.map(message => ({ ...message,
            steps: [...(message.steps || [])], options: [...(message.options || [])] })),
            totals: { ...state.totals }, lastPlan: state.lastPlan ? { ...state.lastPlan } : null };
        const findPending = () => [...next.messages].reverse().find(message => message.role === 'agent' && message.pending);
        switch (action.type) {
        case 'conversation': next.conversation = action.conversation || null; next.error = null; break;
        case 'conversation:sync':
            next.conversation = { ...(next.conversation || {}), ...(action.conversation || {}) };
            if (action.conversation?.turns != null) next.totals.turns = Number(action.conversation.turns) || 0;
            if (action.conversation?.spentUsd != null) next.totals.spentUsd = Number(action.conversation.spentUsd) || 0;
            next.error = null;
            break;
        case 'turn:start':
            next.pending = true; next.error = null;
            next.messages.push({ id: action.id || `user-${next.messages.length}`, role: 'user', text: String(action.text || ''), pending: false, steps: [], options: [] });
            next.messages.push({ id: action.responseId || `agent-${next.messages.length}`, role: 'agent', text: '', pending: true, steps: [], options: [], plan: null, costUsd: null, code: null });
            break;
        case 'event': {
            const event = action.event || action;
            const message = findPending();
            if (!message) break;
            if (event.name === 'step') message.steps.push(copy(event));
            else if (event.name === 'question') { message.text = event.text || event.question || ''; message.options = copy(event.options || []); }
            else if (event.name === 'reply') { message.text = event.text || ''; if (event.costUsd != null) message.costUsd = Number(event.costUsd); }
            else if (event.name === 'plan') message.plan = copy(event);
            else if (event.name === 'done') {
                if (next.conversation) next.conversation = { ...next.conversation, debugCosts: event.debugCosts === true };
                if (event.reply && !message.text) message.text = event.reply;
                if (event.turnCostUsd != null) message.costUsd = Number(event.turnCostUsd);
                else if (event.costUsd != null) message.costUsd = Number(event.costUsd);
                next.pending = false; message.pending = false;
                if (Number.isFinite(Number(event.turns))) next.totals.turns = Number(event.turns);
                else if (!message.code) next.totals.turns += 1;
                if (Number.isFinite(Number(event.conversationSpentUsd))) next.totals.spentUsd = Number(event.conversationSpentUsd);
                else if (Number.isFinite(Number(event.spentUsd))) next.totals.spentUsd = Number(event.spentUsd);
                else if (Number.isFinite(message.costUsd)) next.totals.spentUsd += message.costUsd;
            } else if (event.name === 'error') {
                if (next.conversation) next.conversation = { ...next.conversation, debugCosts: event.debugCosts === true };
                message.code = event.code || 'stream_error'; message.text = event.message || '';
                if (event.turnCostUsd != null) message.costUsd = Number(event.turnCostUsd);
                if (Number.isFinite(Number(event.turns))) next.totals.turns = Number(event.turns);
                if (Number.isFinite(Number(event.conversationSpentUsd))) next.totals.spentUsd = Number(event.conversationSpentUsd);
                message.pending = false; next.pending = false; next.error = { code: message.code, status: event.status };
            }
            break;
        }
        case 'turn:failed': {
            const code = action.code || 'stream_error'; const message = findPending();
            if (message) { message.role = 'error'; message.code = code; message.pending = false; message.text = ''; }
            else next.messages.push({ id: action.id || `error-${next.messages.length}`, role: 'error', text: '', code, pending: false, steps: [], options: [] });
            next.pending = false; next.error = { code, status: action.status, key: errorKey(code, action.status) }; break;
        }
        case 'turn:end': next.pending = false; next.messages.forEach(message => { if (message.pending) message.pending = false; }); break;
        case 'plan:applied': next.lastPlan = { ...(action.plan || {}), kind: action.kind || action.plan?.kind || 'edit', applied: true, error: null }; break;
        case 'plan:failed': next.lastPlan = { ...(action.plan || {}), kind: action.kind || action.plan?.kind || 'edit', applied: false, error: action.error || 'plan_failed' }; break;
        case 'undo:done': next.lastPlan = { ...(action.plan || {}), kind: 'undo', applied: true, error: null }; break;
        case 'reset': return initial();
        default: break;
        }
        return next;
    }
    return { initial, reduce, errorKey, serializeConversation };
});
