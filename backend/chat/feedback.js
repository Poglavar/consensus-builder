// Relay-owned report receipts make a same-turn retry safe without leaking private map references.
import { createHash } from 'node:crypto';
export function feedbackArgs(input = {}, conversation = {}, instruction = '') {
    const args = { kind: input.kind || 'bug', message: input.message, confirm: input.confirm };
    if (input.pageUrl != null) {
        const url = new URL(input.pageUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || url.hash || [...url.searchParams.keys()].some(key => /draft|token|secret|password|auth|key|signature/i.test(key))) {
            throw Object.assign(new Error('Feedback cannot include private draft links or credentials.'), { code: 'private-feedback-url' });
        }
        args.pageUrl = url.href;
    }
    const digest = createHash('sha256').update(JSON.stringify([conversation.id || 'local', conversation.turns || 0,
        instruction, args.kind, args.message, args.pageUrl || null])).digest('hex');
    args.reportId = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
    return args;
}
