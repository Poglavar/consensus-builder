// The AI renderer consumes a photoreal scene, so the mode-strip action must only be visible in
// photo mode. Exercise the actual updateModeButtonStates function with small DOM controls.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const start = source.indexOf('function updateModeButtonStates()');
const end = source.indexOf('\n    window.updateModeButtonStates = updateModeButtonStates;', start);
if (start < 0 || end <= start) throw new Error('Could not find updateModeButtonStates in three-mode.js');
const functionSource = source.slice(start, end);

function button() {
    return {
        hidden: false,
        disabled: false,
        attributes: new Map(),
        classList: { toggle() {} },
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
    };
}

function update(mode) {
    const buttons = new Map(['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-ai-toggle']
        .map(id => [id, button()]));
    const window = {
        __mapModeState: { desired: mode },
        PhotorealMode: { isActive: () => mode === 'photo', isLoading: () => false }
    };
    const document = { getElementById: id => buttons.get(id) || null };
    const paint = new Function('window', 'document', 'threeI18n', 'isActive', 'isTransitioning3D', 'renderingOverlayEl',
        `${functionSource}; return updateModeButtonStates;`)(window, document, (_key, fallback) => fallback,
        mode !== '2d', false, null);
    paint();
    return buttons.get('mode-ai-toggle');
}

describe('AI mode-strip visibility', () => {
    it('hides the AI action in 2D and authored 3D, and shows it in photo mode', () => {
        expect(update('2d')).toMatchObject({ hidden: true, disabled: true });
        expect(update('model')).toMatchObject({ hidden: true, disabled: true });
        expect(update('photo')).toMatchObject({ hidden: false, disabled: false });
    });
});
