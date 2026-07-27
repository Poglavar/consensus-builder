// Unit and wiring tests for land-readjustment draw shortcuts and the distinction between an
// unassigned output plot and an unnamed original owner in the accounting ledger.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { resolveDrawShortcut, resolveOwnerDisplayName } = require('../../frontend/js/reparcellization-ui-state.js');
const source = readFileSync(new URL('../../frontend/js/reparcellization.js', import.meta.url), 'utf8');

describe('land-readjustment UI state', () => {
    it('uses F, C, and U for finish, cancel, and undo while drawing', () => {
        expect(resolveDrawShortcut({ active: true, key: 'f' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'C' })).toBe('cancel');
        expect(resolveDrawShortcut({ active: true, key: 'u' })).toBe('undo');
        expect(resolveDrawShortcut({ active: true, key: 'Enter' })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'Backspace' })).toBeNull();
    });

    it('does not steal shortcuts outside drawing or while typing', () => {
        expect(resolveDrawShortcut({ active: false, key: 'f' })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', editable: true })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', metaKey: true })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', repeat: true })).toBeNull();
    });

    it('reserves “Unassigned” for ownerless plots and preserves real owner names', () => {
        expect(resolveOwnerDisplayName('Unassigned', 'Owner of 123', ['Unassigned']))
            .toBe('Owner of 123');
        expect(resolveOwnerDisplayName('Nedodijeljeno', 'Vlasnik 123', ['Nedodijeljeno']))
            .toBe('Vlasnik 123');
        expect(resolveOwnerDisplayName('Ada Lovelace', 'Owner of 123', ['Unassigned']))
            .toBe('Ada Lovelace');
    });

    it('wires the pure decisions into icon-free shortcut-labelled controls and the owner ledger', () => {
        expect(source).toContain('data-reparcel-undo>${t(\'reparcellization.modal.drawUndo\', \'Undo point\')} (U)</button>');
        expect(source).toContain('data-reparcel-finish>${t(\'reparcellization.modal.drawFinish\', \'Finish plot\')} (F)</button>');
        expect(source).toContain('data-reparcel-cancel-draw>${t(\'reparcellization.modal.drawCancel\', \'Cancel\')} (C)</button>');
        expect(source).toContain('const action = resolveDrawShortcut({');
        expect(source).toContain('displayName: resolveOwnerDisplayName(');
    });
});
