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
        classes: new Set(),
        get classList() {
            const classes = this.classes;
            return { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } };
        },
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
    };
}

function paintStrip(mode, extra = {}, { sceneWork = false } = {}) {
    const buttons = new Map(['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-ai-toggle']
        .map(id => [id, button()]));
    const window = {
        __mapModeState: { desired: mode },
        PhotorealMode: { isActive: () => mode === 'photo', isLoading: () => false },
        ...extra
    };
    const document = { getElementById: id => buttons.get(id) || null };
    const paint = new Function('window', 'document', 'threeI18n', 'isActive', 'isTransitioning3D', 'renderingStatusRelease',
        'sceneWorkLoading', `${functionSource}; return updateModeButtonStates;`)(window, document, (_key, fallback) => fallback,
        mode !== '2d', false, null, () => sceneWork);
    paint();
    return buttons;
}

const update = mode => paintStrip(mode).get('mode-ai-toggle');

describe('AI mode-strip visibility', () => {
    it('hides the AI action in 2D and authored 3D, and shows it in photo mode', () => {
        expect(update('2d')).toMatchObject({ hidden: true, disabled: true });
        expect(update('model')).toMatchObject({ hidden: true, disabled: true });
        expect(update('photo')).toMatchObject({ hidden: false, disabled: false });
    });
});

describe('2D tile while cadastral parcels load', () => {
    it('spins the 2D tile in every view while parcels load, and only then', () => {
        for (const mode of ['2d', 'model', 'photo']) {
            const loading = paintStrip(mode, { mapParcelsLoading: () => true });
            expect(loading.get('mode-2d-toggle').classes.has('mode-btn-loading')).toBe(true);
            expect(loading.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(false);
            const idle = paintStrip(mode, { mapParcelsLoading: () => false });
            expect(idle.get('mode-2d-toggle').classes.has('mode-btn-loading')).toBe(false);
        }
    });
});

describe('Model tile while the 3D scene still loads after entry', () => {
    it('spins the model tile in model view while buildings or scenery load, not in photo view', () => {
        const spins = (mode, sceneWork) => paintStrip(mode, {}, { sceneWork }).get('mode-3d-toggle').classes.has('mode-btn-loading');
        expect(spins('model', true)).toBe(true);
        expect(spins('model', false)).toBe(false);
        expect(spins('photo', true)).toBe(false);
        expect(spins('2d', true)).toBe(false);
    });
});
