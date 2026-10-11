import { updateRun } from './ledger.js';

// Error messages from RPC and HTTP clients often include credential-bearing URLs. Store a short,
// useful diagnostic without persisting endpoint paths, query strings or tokens in the public ledger.
export function safeFailureDiagnostic(error) {
    const message = typeof error === 'string' ? error : error?.message || String(error || 'Unknown failure');
    return String(message)
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
        .slice(0, 240);
}

export async function markAgentRunFailed(pool, runId, error, { stage = null, summaryPatch = {} } = {}) {
    return updateRun(pool, runId, {
        ...(stage ? { stage } : {}),
        status: 'failed',
        summaryPatch: {
            ...summaryPatch,
            outcome: 'failed',
            error: safeFailureDiagnostic(error)
        }
    });
}
