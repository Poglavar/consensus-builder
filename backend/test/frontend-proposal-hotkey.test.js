import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/js/proposals/create.js'), 'utf8');

function hotkeyHarness({ modeSupported = true, available = true, ids = ['parcel-1'], multi = false } = {}) {
    const calls = [];
    const commands = {
        createBrowserContext: vi.fn(() => ({ mode: modeSupported ? '2d' : 'model' })),
        supportsMode: vi.fn(() => modeSupported),
        isAvailable: vi.fn(() => available),
        runCommand: vi.fn(id => calls.push(id))
    };
    const window = { UiCommands: commands, multiParcelSelection: multi ? { isActive: true } : null };
    const document = { querySelector: vi.fn(() => null) };
    const context = {
        window,
        document,
        isEditableElement: () => false,
        getCurrentParcelSelectionContext: () => ({ ids, layers: [] }),
        showProposalDialog: vi.fn(),
        updateStatus: vi.fn(),
        getProposalI18nHelper: () => (key, fallback) => fallback
    };
    vm.runInNewContext(SOURCE, context, { filename: 'frontend/js/proposals/create.js' });
    return { handler: context.handleCreateProposalHotkey, commands, calls, context };
}

const keyEvent = () => ({ key: 'c', target: { tagName: 'DIV' }, preventDefault: vi.fn() });

describe('proposal creation hotkey', () => {
    it('dispatches the matching shared parcel or selection proposal command', () => {
        const parcel = hotkeyHarness();
        const parcelEvent = keyEvent();
        parcel.handler(parcelEvent);
        expect(parcel.commands.runCommand).toHaveBeenCalledWith('parcel.propose', expect.any(Object));
        expect(parcelEvent.preventDefault).toHaveBeenCalledOnce();
        expect(parcel.context.showProposalDialog).not.toHaveBeenCalled();

        const selection = hotkeyHarness({ multi: true, ids: ['parcel-1', 'parcel-2'] });
        const selectionEvent = keyEvent();
        selection.handler(selectionEvent);
        expect(selection.commands.runCommand).toHaveBeenCalledWith('selection.propose', expect.any(Object));
        expect(selectionEvent.preventDefault).toHaveBeenCalledOnce();
    });

    it('does nothing in model/photo mode and when the shared command is unavailable', () => {
        const model = hotkeyHarness({ modeSupported: false });
        const modelEvent = keyEvent();
        model.handler(modelEvent);
        expect(model.commands.runCommand).not.toHaveBeenCalled();
        expect(modelEvent.preventDefault).not.toHaveBeenCalled();

        const unavailable = hotkeyHarness({ available: false });
        const unavailableEvent = keyEvent();
        unavailable.handler(unavailableEvent);
        expect(unavailable.commands.runCommand).not.toHaveBeenCalled();
        expect(unavailableEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does not dispatch C without a selected parcel', () => {
        const empty = hotkeyHarness({ ids: [] });
        const event = keyEvent();
        empty.handler(event);
        expect(empty.commands.isAvailable).not.toHaveBeenCalled();
        expect(empty.commands.runCommand).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(empty.context.updateStatus).toHaveBeenCalledOnce();
    });
});
