// Exercise the real chat controller against streamed events while a map editor owns an unsaved draft.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../frontend/js/chat/chat-panel.js', import.meta.url), 'utf8');
const editorSummary = { kind: 'parcel-layout', tab: 'editing', algorithm: 'equal', plotCount: 3, dirty: true, drawing: 'nodes' };
function panel(initialEditor = editorSummary) {
    let editor = initialEditor;
    const document = makeDocument();
    const conversation = { id: 'conversation', city: 'london' };
    const window = {
        __chatTranscript: require('../../frontend/js/chat/chat-transcript.js'),
        __chatContext: require('../../frontend/js/chat/chat-context.js'),
        currentCityId: 'london', location: new URL('https://app.test/'),
        addEventListener: vi.fn(), getParcelLayoutEditorContext: () => editor,
        OnMapEditor: { getOwner: () => editor?.kind || null },
        i18n: { t: key => key, getLanguage: () => 'en' },
        crypto: { randomUUID: () => 'turn-key' },
        ChatClient: { conversation: () => null, start: vi.fn(async () => conversation),
            turn: vi.fn(), sync: vi.fn(async () => ({ ...conversation, plan: { cid: 'foreign', draftRef: 'foreign-ref' } })) },
        ChatNavigation: { apply: vi.fn(async () => {}) },
        DraftLink: { load: vi.fn(async () => { throw new Error('A draft should not be loaded during help.'); }) },
        PlanDialog: { syncSharedPlanOnMap: vi.fn() },
        handleSharedDesignRoute: vi.fn(),
        BusyControl: { track: (_button, action) => action() }
    };
    vm.runInNewContext(source, { window, document, URL });
    const root = document.createElement('div'); document.body.append(root);
    window.ChatPanel.mount(root);
    return { window, document, root, setEditor(value) {
        editor = value;
        document.dispatchEvent({ type: 'on-map-editor-preview-change' });
    } };
}
const reply = onEvent => {
    onEvent({ name: 'reply', text: 'Use Draw a line to split the plots.' });
    onEvent({ name: 'done', turns: 1 });
};
const mutations = onEvent => {
    onEvent({ name: 'view', view: { at: '51.5,-0.1,18' } });
    onEvent({ name: 'selection', selection: { parcelIds: ['other'] } });
    onEvent({ name: 'plan', cid: 'foreign', draftRef: 'foreign-ref' });
};
function expectNoMapChanges(window) {
    expect(window.ChatNavigation.apply).not.toHaveBeenCalled();
    expect(window.DraftLink.load).not.toHaveBeenCalled();
    expect(window.PlanDialog.syncSharedPlanOnMap).not.toHaveBeenCalled();
    expect(window.handleSharedDesignRoute).not.toHaveBeenCalled();
    expect(window.ChatPanel.state().lastPlan).toBeNull();
}

describe('chat beside an active editor', () => {
    it('sends the current editor summary and renders help while ignoring stale mutation events', async () => {
        const { window, root } = panel();
        window.ChatClient.turn.mockImplementation(async (_id, body, { onEvent }) => {
            expect(body.context.activeEditor).toEqual(editorSummary);
            mutations(onEvent); reply(onEvent);
        });
        await window.ChatPanel.send('How do I split a plot?');
        expect(window.ChatClient.turn).toHaveBeenCalledTimes(1);
        expect(root.textContent).toContain('Use Draw a line');
        expect(window.ChatPanel.state().error).toBeNull();
        expectNoMapChanges(window);
    });

    it('does not apply a recovered conversation plan after a stream failure', async () => {
        const { window } = panel();
        window.ChatClient.turn.mockRejectedValue(new Error('Stream interrupted'));
        await window.ChatPanel.send('Explain the drawing options');
        expect(window.ChatClient.sync).toHaveBeenCalledTimes(1);
        expect(window.ChatPanel.state().error.code).toBe('stream_error');
        expectNoMapChanges(window);
    });

    it('keeps a turn read-only if an editor opens and closes while its reply is pending', async () => {
        const { window, setEditor } = panel(null);
        window.ChatClient.turn.mockImplementation(async (_id, body, { onEvent }) => {
            expect(body.context.activeEditor).toBeUndefined();
            setEditor(editorSummary); setEditor(null);
            mutations(onEvent); reply(onEvent);
        });
        await window.ChatPanel.send('Explain the map');
        expectNoMapChanges(window);
    });

    it('continues applying navigation normally when there is no editor', async () => {
        const { window } = panel(null);
        const event = { name: 'view', view: { at: '51.5,-0.1,18' } };
        window.ChatClient.turn.mockImplementation(async (_id, body, { onEvent }) => {
            expect(body.context.activeEditor).toBeUndefined();
            onEvent(event); reply(onEvent);
        });
        await window.ChatPanel.send('Pan north');
        expect(window.ChatNavigation.apply).toHaveBeenCalledWith(event);
        expect(window.ChatPanel.state().error).toBeNull();
    });
});
