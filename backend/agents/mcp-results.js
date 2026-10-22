// MCP result boundaries: public prose is untrusted data; failures carry a recovery instruction.
const PROSE = new Set(['title', 'description', 'author', 'name', 'displayName', 'text', 'message']);

export function markUntrusted(value) {
    if (Array.isArray(value)) return value.map(markUntrusted);
    if (!value || typeof value !== 'object') return value;
    if (value.code && value.next) return value;
    // Canonical objects must remain byte-for-byte reusable: mark the entire object, not its fields.
    if (['design/v1', 'agreement/v1'].includes(value.schema)) return value;
    const out = {}, untrusted = {};
    for (const [key, item] of Object.entries(value)) {
        if (PROSE.has(key)) untrusted[key] = item;
        else if (['content', 'design', 'agreement'].includes(key) && ['design/v1', 'agreement/v1'].includes(item?.schema)) untrusted[key] = item;
        else out[key] = key === 'next' ? item : markUntrusted(item);
    }
    if (Object.keys(untrusted).length) out.untrusted = { ...out.untrusted, ...untrusted };
    return out;
}

export function toolError(error) {
    return { code: error?.code || 'tool-failed', message: error?.message || String(error),
        next: error?.next || error?.body?.next || { action: 'Correct the arguments using the tool schema, or retry an unavailable source.' } };
}
