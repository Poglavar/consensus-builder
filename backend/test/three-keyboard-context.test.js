// Unit and wiring tests for the 3D keyboard boundary. Unmodified keys belong exclusively to 3D
// while it is active, but browser shortcuts, text entry, and native controls must keep working.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { classifyThreeModeKeydown } = require('../../frontend/js/three-keyboard-context.js');
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');

describe('3D keyboard context', () => {
    it('blocks ordinary 2D shortcut keys only while 3D is active', () => {
        expect(classifyThreeModeKeydown({ active: false, key: 'r' })).toBe('pass');
        expect(classifyThreeModeKeydown({ active: true, key: 'r' })).toBe('block-2d');
        expect(classifyThreeModeKeydown({ active: true, key: 'C' })).toBe('block-2d');
    });

    it('preserves browser modifiers and native 3D control interaction', () => {
        expect(classifyThreeModeKeydown({ active: true, key: 'r', metaKey: true })).toBe('block-2d-native');
        expect(classifyThreeModeKeydown({ active: true, key: 'c', metaKey: true, target: { tagName: 'INPUT' } })).toBe('pass');
        expect(classifyThreeModeKeydown({ active: true, key: 'r', target: { tagName: 'SELECT' } })).toBe('pass');
        expect(classifyThreeModeKeydown({ active: true, key: 'Enter', target: { tagName: 'BUTTON' } })).toBe('pass');
        expect(classifyThreeModeKeydown({ active: true, key: 'r', target: { tagName: 'BUTTON' } })).toBe('block-2d');
        expect(classifyThreeModeKeydown({ active: true, key: 'Tab' })).toBe('pass');
        expect(classifyThreeModeKeydown({ active: true, key: 'F5' })).toBe('pass');
    });

    it('routes Escape through the 3D-owned actions', () => {
        expect(classifyThreeModeKeydown({ active: true, key: 'Escape', walkPickActive: true, hasIsolation: true }))
            .toBe('cancel-walk');
        expect(classifyThreeModeKeydown({ active: true, key: 'Escape', hasIsolation: true }))
            .toBe('clear-isolation');
        expect(classifyThreeModeKeydown({ active: true, key: 'Escape' })).toBe('block-2d');
    });

    it('loads the policy before 3D and installs a capture-phase boundary', () => {
        expect(indexSource.indexOf("'js/three-keyboard-context.js'"))
            .toBeLessThan(indexSource.indexOf("'js/three-mode.js'"));
        expect(threeModeSource).toContain("window.addEventListener('keydown', handleThreeModeKeyboardContext, true);");
        expect(threeModeSource).toContain('evt.stopImmediatePropagation();');
    });
});
