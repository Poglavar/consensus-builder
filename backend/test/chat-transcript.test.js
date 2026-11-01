// Pure reducer tests for streamed chat events, errors and conversation reset.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const chat = require('../../frontend/js/chat/chat-transcript.js');

describe('chat transcript reducer', () => {
    it('requires an explicit server debug flag for cost display on each turn', () => {
        let state = chat.reduce(chat.initial(), { type: 'conversation', conversation: { id: 'c1', debugCosts: true } });
        state = chat.reduce(state, { type: 'turn:start', text: 'Hello' });
        state = chat.reduce(state, { type: 'event', event: { name: 'done', conversationSpentUsd: 0.1, turns: 1 } });
        expect(state.conversation.debugCosts).toBe(false);
        state = chat.reduce(state, { type: 'turn:start', text: 'Again' });
        state = chat.reduce(state, { type: 'event', event: { name: 'done', debugCosts: true, conversationSpentUsd: 0.2, turns: 2 } });
        expect(state.conversation.debugCosts).toBe(true);
    });

    it('records a question with selectable options and ends the turn', () => {
        let state = chat.initial();
        state = chat.reduce(state, { type: 'turn:start', text: 'Which building?', id: 'u1' });
        state = chat.reduce(state, { type: 'event', event: { name: 'question', text: 'Which one?', options: [{ label: 'A', ref: 'cid-a' }] } });
        state = chat.reduce(state, { type: 'event', event: { name: 'done', turnCostUsd: 0.02, conversationSpentUsd: 0.12, turns: 4 } });
        expect(state.messages[0].text).toBe('Which building?');
        expect(state.messages[1]).toMatchObject({ text: 'Which one?', options: [{ label: 'A', ref: 'cid-a' }], pending: false });
        expect(state.messages[1].costUsd).toBe(0.02);
        expect(state.totals).toEqual({ spentUsd: 0.12, turns: 4 });
    });
    it('keeps plan events beside the reply and represents a 402 as a settled error', () => {
        let state = chat.reduce(chat.initial(), { type: 'turn:start', text: 'Move it' });
        state = chat.reduce(state, { type: 'event', event: { name: 'plan', draftRef: 'https://example.test/draft' } });
        state = chat.reduce(state, { type: 'event', event: { name: 'reply', text: 'Moved.' } });
        expect(state.messages.at(-1)).toMatchObject({ text: 'Moved.', plan: { draftRef: 'https://example.test/draft' } });
        state = chat.reduce(state, { type: 'turn:failed', code: 'budget_exhausted', status: 402 });
        expect(state.pending).toBe(false);
        expect(state.messages.at(-1)).toMatchObject({ role: 'error', code: 'budget_exhausted', pending: false });
        expect(state.error.key).toBe('chat.errors.budget');
    });
    it('does not mutate prior state and resets conversation totals', () => {
        const original = chat.initial();
        const changed = chat.reduce(original, { type: 'conversation', conversation: { id: 'c1' } });
        expect(original.conversation).toBeNull();
        expect(chat.reduce(changed, { type: 'reset' })).toEqual(chat.initial());
    });
    it('resyncs server totals without clearing the transcript', () => {
        let state = chat.reduce(chat.initial(), { type: 'turn:start', text: 'Hello' });
        state = chat.reduce(state, { type: 'conversation:sync', conversation: { id: 'c1', turns: 4, spentUsd: 0.125, plan: { cid: 'p1' } } });
        expect(state.messages).toHaveLength(2);
        expect(state.conversation).toMatchObject({ id: 'c1', plan: { cid: 'p1' } });
        expect(state.totals).toEqual({ turns: 4, spentUsd: 0.125 });
    });
    it('serializes the full visible conversation with localized role and option labels', () => {
        let state = chat.reduce(chat.initial(), { type: 'turn:start', text: 'Find a park' });
        state = chat.reduce(state, { type: 'event', event: { name: 'question', text: 'Which one?', options: [{ label: 'North' }, { label: 'South' }] } });
        state = chat.reduce(state, { type: 'event', event: { name: 'done', turnCostUsd: 0.01, conversationSpentUsd: 0.01, turns: 1 } });
        expect(chat.serializeConversation(state, { you: 'Vous', agent: 'Agent', options: 'Options' }))
            .toBe('Vous: Find a park\n\nAgent: Which one?\nOptions: North · South');
    });
});
