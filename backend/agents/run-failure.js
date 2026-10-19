import { updateRun } from './ledger.js';

// Error messages from RPC and HTTP clients often include credential-bearing URLs. Store a short,
// useful diagnostic without persisting query strings, tokens or third-party endpoint paths in the
// public ledger (RPC providers put API keys in the path). Our own API's paths carry no secrets and
// say what failed, so for our hosts the path is kept: "api.urbangametheory.xyz/parcel-sources/x".
const OWN_HOST = /(^|\.)urbangametheory\.xyz$|^localhost$|^127\.0\.0\.1$/i;

function describeUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { return '[redacted URL]'; }
    const path = url.pathname === '/' ? '' : url.pathname;
    if (OWN_HOST.test(url.hostname)) return `${url.host}${path}`;
    return path ? `${url.host}/[path redacted]` : url.host;
}

export function safeFailureDiagnostic(error) {
    const message = typeof error === 'string' ? error : error?.message || String(error || 'Unknown failure');
    return String(message)
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, describeUrl)
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
