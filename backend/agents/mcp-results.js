// MCP result boundaries: public prose is untrusted data; failures carry local recovery guidance.
const PROSE = new Set(['title', 'description', 'author', 'name', 'displayName', 'text', 'message']);
const errorResults = new WeakSet();
const CANONICAL = new Set(['design/v1', 'agreement/v1', 'plan/v1']);
// Only local contract producers may brand schema objects. Public data cannot opt out of
// prose marking merely by using schema-like keys or the name `schema`.
const schemaDocuments = new WeakSet();
export function trustedMetadata(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('Trusted local metadata must be an object');
    schemaDocuments.add(schema);
    return schema;
}

export const trustedSchemaDocument = trustedMetadata;
export const isTrustedMetadata = value => !!value && typeof value === 'object' && schemaDocuments.has(value);

export function markUntrusted(value) {
    if (Array.isArray(value)) return value.map(markUntrusted);
    if (!value || typeof value !== 'object') return value;
    // Canonical objects and inspection values must remain byte-for-byte reusable.
    if (errorResults.has(value)) return value;
    if (schemaDocuments.has(value)) return value;
    // A schema marker is data, never proof of provenance. Preserve exact canonical bytes
    // inside an explicit envelope even at the root or in arbitrary arrays/record fields.
    if (CANONICAL.has(value.schema)) return { untrusted: { content: value } };
    const out = {}, untrusted = {};
    for (const [key, item] of Object.entries(value)) {
        if (PROSE.has(key) || (key === 'next' && !isTrustedMetadata(item))) untrusted[key] = item;
        else if (['content', 'design', 'agreement', 'plan'].includes(key) && CANONICAL.has(item?.schema)) untrusted[key] = item;
        else out[key] = key === 'next' || key === 'untrustedValue' || key === 'untrusted' ? item : markUntrusted(item);
    }
    if (Object.keys(untrusted).length) out.untrusted = { ...out.untrusted, ...untrusted };
    return out;
}

export function toolError(error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(error.code) ? error.code : 'tool-failed';
    // body.next is supplied by another service and must never become an instruction.
    const next = error?.next || (code === 'structure-over-road'
        ? { action: 'Move or resize the structure clear of the applied road, or revise/remove the road design itself.' }
        : /^(design|plan)-revision-mismatch$/.test(code)
            ? { tool: code.startsWith('design') ? 'ugt_inspect_design' : 'ugt_inspect_plan', action: 'Inspect the intended revision and use its CID as expectedCid.' }
            : { action: 'Correct the arguments using the tool schema, or retry an unavailable source.' });
    const result = { code, message: error?.upstream !== undefined || error?.body !== undefined ? 'Source request failed.' : 'Tool request failed.', next, untrusted: { message: error?.message || String(error),
        ...(error?.upstream !== undefined || error?.body !== undefined ? { upstream: error.upstream ?? error.body } : {}) } };
    for (const key of ['field', 'constraints', 'currentCid', 'expectedCid', 'arguments']) {
        if (error?.[key] !== undefined) result[key] = error[key];
    }
    if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.status = error.status;
    if (typeof error?.source === 'string') {
        try { const url = new URL(error.source); if (['https:', 'http:'].includes(url.protocol)) result.source = url.origin; } catch { /* Not an HTTP source. */ }
    }
    if (typeof error?.retryable === 'boolean') result.retryable = error.retryable;
    if (Number.isSafeInteger(error?.retryAfter) && error.retryAfter >= 0) result.retryAfter = error.retryAfter;
    for (const key of ['cid', 'stage', 'url']) if (typeof error?.[key] === 'string') result[key] = error[key];
    if (Array.isArray(error?.pinnedCids) && error.pinnedCids.every(cid => typeof cid === 'string')) result.pinnedCids = error.pinnedCids;
    if (typeof error?.indexed === 'boolean') result.indexed = error.indexed;
    if (code === 'structure-over-road') {
        result.roadId = error.roadProposalId || error.roadId || null;
        if (Number.isFinite(error.overlapM2)) result.overlapM2 = error.overlapM2;
    }
    errorResults.add(result);
    return result;
}
