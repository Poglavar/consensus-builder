// Unit and wiring tests for the parcel-layout editor's UI-state helpers: draw shortcuts, a layout's
// input parcels, and owner labels (used by the ownership panel). The wiring is checked on a real
// editor opened in helpers/parcel-layout-env.js.
import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeEditor, box } from './helpers/parcel-layout-env.js';

const require = createRequire(import.meta.url);
const {
    resolveDrawShortcut,
    resolveOwnerDisplayName,
    resolveOwnerLabel,
    genericOwnerKind,
    readjustmentInputFeatures
} = require('../../frontend/js/reparcellization-ui-state.js');
const styles = readFileSync(new URL('../../frontend/css/on-map-reparcellization.css', import.meta.url), 'utf8');
const locale = code => JSON.parse(readFileSync(new URL(`../../frontend/i18n/${code}.json`, import.meta.url), 'utf8'));

describe('saved layout inputs', () => {
    const original = { type: 'Feature', properties: { parcelId: 'HR-335550-1791/69', owner: 'Original owner' } };
    const replacement = { type: 'Feature', properties: { parcelId: 'HR-335550-1791/69#plan-1', owner: 'New owner' } };
    const sources = { cadastre: new Map([[original.properties.parcelId, original]]), live: new Map([[replacement.properties.parcelId, replacement]]) };

    it('recovers original owner facts for a saved plan after the live root was consumed', () => {
        expect(readjustmentInputFeatures({ ids: [original.properties.parcelId], source: 'cadastre' }, sources))
            .toEqual({ features: [original], missing: [] });
    });

    it('keeps new selections on their live pieces and does not resurrect consumed originals', () => {
        expect(readjustmentInputFeatures({ ids: [replacement.properties.parcelId] }, sources))
            .toEqual({ features: [replacement], missing: [] });
        expect(readjustmentInputFeatures({ ids: [original.properties.parcelId] }, sources))
            .toEqual({ features: [], missing: [original.properties.parcelId] });
    });
});

describe('parcel-layout UI state', () => {
    it('uses F (or Enter), C, and U for finish, cancel, and undo while drawing', () => {
        expect(resolveDrawShortcut({ active: true, key: 'f' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'C' })).toBe('cancel');
        expect(resolveDrawShortcut({ active: true, key: 'u' })).toBe('undo');
        expect(resolveDrawShortcut({ active: true, key: 'Enter' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'Enter', editable: true })).toBeNull();
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

    it('localizes known generic owner labels while retaining source-stable identities', () => {
        const samples = {
            en: { private: 'Private owner', public: 'Public land' },
            es: { private: 'Propietario privado', public: 'Suelo público' },
            hr: { private: 'Privatni vlasnik', public: 'Javno zemljište' },
            sr: { private: 'Privatni vlasnik', public: 'Javno zemljište' }
        };
        for (const [language, expected] of Object.entries(samples)) {
            const dictionary = locale(language);
            const translate = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], dictionary) || fallback;
            const privateOwner = resolveOwnerLabel('Privatni vlasnik', 'Owner of parcel', translate);
            const publicLand = resolveOwnerLabel('Public land', 'Owner of parcel', translate);
            expect(privateOwner.displayName).toBe(expected.private);
            expect(publicLand.displayName).toBe(expected.public);
            expect(privateOwner.identityName).toBe('Privatni vlasnik');
            expect(publicLand.identityName).toBe('Public land');
        }
        expect(resolveOwnerLabel('REPUBLIKA HRVATSKA', 'Owner', (_key, fallback) => fallback))
            .toEqual({ displayName: 'REPUBLIKA HRVATSKA', identityName: 'REPUBLIKA HRVATSKA' });
        expect(genericOwnerKind('Republika Hrvatska')).toBeNull();
    });

    // A real editor on one 40 × 50 m parcel, opened and torn down per test.
    let env = null;
    afterEach(() => { env?.dispose(); env = null; });
    async function openEditor(beforeOpen = () => {}) {
        env = makeEditor({
            parcels: [{ id: 'P1', geometry: box(0, 0, 40, 50) }],
            selection: { ids: ['P1'] }
        });
        beforeOpen();
        expect(await env.editor.openParcelLayoutEditor()).toBe(true);
        return env;
    }

    it('wires the draw shortcuts into icon-free shortcut-labelled controls', async () => {
        const w = await openEditor();
        expect(w.$('[data-reparcel-undo]').textContent).toBe('Undo point (U)');
        expect(w.$('[data-reparcel-finish]').textContent).toBe('Finish plot (F)');
        expect(w.$('[data-reparcel-cancel-draw]').textContent).toBe('Cancel (C)');
        // The keys reach the draw tools through resolveDrawShortcut: C cancels a stroke under way.
        w.$('[data-reparcel-draw]').click();
        expect(w.state.drawing.active).toBe(true);
        w.key('c');
        expect(w.state.drawing.active).toBe(false);
    });

    it('uses the shared map editor session and never destroys the app map on close', async () => {
        const w = await openEditor(() => {
            globalThis.L.tileLayer = () => { throw new Error('the editor added a tile layer'); };
            globalThis.L.map = () => { throw new Error('the editor made its own Leaflet map'); };
        });
        const [options] = globalThis.OnMapEditor.open.calls[0];
        expect(options).toMatchObject({ owner: 'parcel-layout', modes: ['2d'], handleEscape: false });
        const session = w.session();
        expect(w.state.map).toBe(session.map);
        expect(w.state.map).toBe(globalThis.map);
        const removed = [];
        globalThis.map.remove = () => removed.push('map');
        w.$('[data-reparcel-cancel]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(session.close.calls).toHaveLength(1);
        expect(removed).toEqual([]);
        // The overlays it added are gone from the map; the map itself stays.
        expect(globalThis.map.getLayers().filter(layer => layer.kind === 'geojson')).toEqual([]);
    });

    it('keeps layout undo and an active draw toolbar visible when secondary tools are collapsed', async () => {
        const w = await openEditor();
        const group = w.$('[data-reparcel-alg-group]');
        const persistent = w.$('.reparcel-persistent-controls');
        const toolbar = w.$('[data-reparcel-draw-toolbar]');
        // Undo/redo live outside the collapsible secondary controls, ahead of the draw toolbar.
        expect(persistent.closest('[data-reparcel-secondary-controls]')).toBeNull();
        expect(group.children.indexOf(persistent)).toBeGreaterThan(group.children.indexOf(w.$('[data-reparcel-secondary-controls]')));
        expect(group.children.indexOf(persistent)).toBeLessThan(group.children.indexOf(toolbar));
        expect(persistent.querySelector('[data-reparcel-undo-edit]').disabled).toBe(true);
        // The layouts and their count fold away with the other secondary tools.
        expect(w.$('[data-parcel-layout-count-field]').closest('[data-reparcel-secondary-controls]')).not.toBeNull();
        expect(toolbar.hidden).toBe(true);
        // The active mode is named in the panel and handed to the shared editor's hint.
        expect(w.$('[data-reparcel-active-mode]').textContent).toBe('Edit boundaries (nodes) active');
        expect(w.session().setHint.calls.at(-1)).toEqual(['Edit boundaries (nodes) active']);
        expect(styles).toContain('.on-map-editor.is-collapsed .reparcel-secondary-controls { display: none; }');
        // Phones: edge to edge, the mode strip hangs from the top-left (css/map.css).
        expect(styles).toMatch(/\.on-map-editor__tools\.reparcel-tools-map \{[^}]*left: 12px;[^}]*width: calc\(100vw - 24px\);/);
        expect(styles).toMatch(/\.reparcel-actions \[data-reparcel-cancel\],[\s\S]*?min-width: 0;/);
    });
});
