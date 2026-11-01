import { describe, expect, it, vi } from 'vitest';
import { runTurn } from '../chat/turn-runner.js';
import { compactForModel } from '../chat/tool-results.js';
import { toModelTools } from '../chat/tool-catalog.js';
import { feedbackArgs } from '../chat/feedback.js';
import { validateFeedback } from '../routes/feedback.js';
describe('chat feedback receipts', () => {
    it('reuses a receipt for identical retry payloads and separates later requests', () => {
        const input = { kind: 'feedback', message: 'Make parcel labels larger', confirm: true, reportId: 'model-supplied' };
        const conversation = { id: 'conversation', turns: 3 };
        const first = feedbackArgs(input, conversation, 'Please record that suggestion');
        expect(first).toEqual(feedbackArgs(input, conversation, 'Please record that suggestion'));
        expect(first.reportId).not.toBe(input.reportId);
        expect(validateFeedback(first).error).toBeUndefined();
        expect(feedbackArgs(input, { ...conversation, turns: 4 }).reportId).not.toBe(first.reportId);
        expect(feedbackArgs({ ...input, message: 'Different report' }, conversation).reportId).not.toBe(first.reportId);
    });
    it('relays only the requested report with a stable receipt across a failed retry', async () => {
        const input = { kind: 'feedback', message: 'Larger parcel labels, please', confirm: true, reportId: 'invented' };
        const replies = [
            { content: [{ type: 'tool_use', id: 'one', name: 'ugt_submit_feedback', input }] },
            { content: [{ type: 'tool_use', id: 'two', name: 'ugt_submit_feedback', input }] },
            { content: [{ type: 'text', text: 'Your suggestion was recorded.' }] }
        ];
        const callTool = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ report: { id: 'receipt', status: 'received' } });
        const result = await runTurn({ text: 'Please record my feedback: larger parcel labels', conversation: { id: 'conversation', turns: 1 },
            context: { city: 'london', selection: { parcelIds: ['private-selection'] } }, callTool, callModel: async () => replies.shift(), mcpTools: [], prices: { input: 0, output: 0, cache_read: 0, cache_creation: 0 } });
        expect(callTool).toHaveBeenCalledTimes(2);
        expect(callTool.mock.calls[0][1]).toEqual(callTool.mock.calls[1][1]);
        expect(callTool.mock.calls[1][1]).toEqual({ ...input, reportId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
        expect(JSON.stringify(callTool.mock.calls)).not.toContain('private-selection');
        expect(result.planChanged).toBe(false); expect(result.agreementChanged).toBe(false);
        expect(result.steps.map(step => step.ok)).toEqual([false, true]);
        expect(JSON.parse(compactForModel('ugt_submit_feedback', { report: { id: 'receipt', status: 'received' }, privateText: 'omit' })))
            .toEqual({ ok: true, report: { id: 'receipt', status: 'received' } });
        expect(toModelTools([{ name: 'ugt_submit_feedback', inputSchema: { properties: { reportId: {}, message: {} } } }])[0].input_schema.properties.reportId).toBeUndefined();
    });
    it('does not manufacture authorization and only accepts public page links', () => {
        expect(feedbackArgs({ message: 'Something failed' }).confirm).toBeUndefined();
        for (const pageUrl of ['https://app.example/?draft=private', 'https://app.example/#private', 'https://user:password@app.example/', 'https://app.example/?access_token=private']) {
            expect(() => feedbackArgs({ message: 'Report', pageUrl })).toThrow(expect.objectContaining({ code: 'private-feedback-url' }));
        }
        expect(feedbackArgs({ message: 'Report', pageUrl: 'https://app.example/feedback.html' }).pageUrl).toBe('https://app.example/feedback.html');
    });
});
