// The 3D model view's click stack (frontend/js/three-click-stack.js): which sections a click in the
// scene shows, in what order (Built → Design → Permitted → Parcel), which one opens, and which
// instance a strip shows first. The panel is checked in the browser; these are its pure rules.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const stack = require('../../frontend/js/three-click-stack.js');

const feature = { type: 'Feature', properties: {}, geometry: null };

describe('3D click stack contextual selection', () => {
    it('retains shared-view selection policy through scene refresh and section reopening', () => {
        const document = makeDocument();
        const context = { document, console };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack, activated = [];
        api.show({ designs: [{ id: 'garden', preserveView: true }] }, { focus: 'designs' }, {
            activate: (_kind, item) => activated.push({ id: item.id, preserveView: item.preserveView })
        });
        api.refresh();
        const row = document.querySelector('.click-stack__row');
        row.click();
        document.querySelector('.click-stack__row').click();
        expect(activated).toEqual(Array(3).fill({ id: 'garden', preserveView: true }));
    });

    it('navigates between design and parcel, keeping collapsed selection focused', () => {
        const document = makeDocument();
        const context = { document, console, __clickStackModel: require('../../frontend/js/click-stack/click-stack-model.js') };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack, focused = [];
        const adapter = { activate: (_kind, item, body) => { body.textContent = item.label; }, focus: (kind, item) => focused.push([kind, item.id]) };
        api.show({ designs: [{ id: 'a', label: 'Garden', proposal: { cadastreParcelIds: ['p'] } }], parcels: [{ id: 'p', label: '12' }] }, { focus: 'designs' }, adapter);
        const section = kind => document.querySelector(`.click-stack__section[data-kind="${kind}"]`);
        expect(section('designs').querySelector('.click-stack__choices').dataset.kind).toBe('parcels');
        section('designs').querySelector('[data-id="p"]').click();
        expect(api.current()).toMatchObject({ selectedKind: 'parcels', expanded: 'parcels' });
        expect(section('parcels').querySelector('.click-stack__choices').dataset.kind).toBe('designs');
        section('parcels').querySelector('.click-stack__row').click();
        expect(api.current()).toMatchObject({ selectedKind: 'parcels', expanded: null });
        expect(section('parcels').classList.contains('is-selected')).toBe(true);
        expect(document.querySelector('.click-stack__choices')).toBeNull();
        expect(focused).toEqual([['parcels', 'p']]);
    });
});

describe('3D click stack rules', () => {
    it('orders the sections Built, Design, Permitted, Parcel and leaves out empty ones', () => {
        const built = stack.buildThreeStack({
            parcels: [{ id: 'HR-1-2', label: '2' }],
            designs: [{ id: 'd1', label: 'Park' }],
            built: [{ id: 'b1', label: '', feature }]
        }, { focus: 'designs' });
        expect(built.sections.map(section => section.kind)).toEqual(['built', 'designs', 'parcels']);
        expect(built.expanded).toBe('designs');
    });

    it('opens what the click hit, else the parcel', () => {
        expect(stack.focusOf({ planningId: 'm1' })).toBe('permitted');
        expect(stack.focusOf({ builtFeature: feature, parcelId: 'HR-1' })).toBe('built');
        expect(stack.focusOf({ proposalId: 'd1', parcelId: 'HR-1' })).toBe('designs');
        expect(stack.focusOf({ parcelId: 'HR-1' })).toBe('parcels');
        expect(stack.focusOf(null)).toBe('parcels');
        // A focus with no section of its own falls to the bottom section, the parcel.
        expect(stack.buildThreeStack({ parcels: [{ id: 'HR-1' }] }, { focus: 'designs' }).expanded).toBe('parcels');
    });

    it('lists several proposals or buildings as a strip, the clicked one first selected, each once', () => {
        const built = stack.buildThreeStack({
            designs: [{ id: 'd1', label: 'A' }, { id: 'd2', label: 'B' }, { id: 'd2', label: 'B again' }]
        }, { focus: 'designs', selected: { designs: 'd2' } });
        const [designs] = built.sections;
        expect(designs).toMatchObject({ count: 2, multi: true, selectedIndex: 1 });
        expect(stack.selectedInstance(built, 'designs').label).toBe('B');
        const single = stack.buildThreeStack({ built: [{ id: 'b1', feature }] });
        expect(single.sections[0].multi).toBe(false);
    });

    it('expands one section at a time and keeps a strip choice', () => {
        let built = stack.buildThreeStack({ built: [{ id: 'b1' }, { id: 'b2' }], parcels: [{ id: 'HR-1' }] }, { focus: 'parcels' });
        built = stack.expand(stack.selectInstance(built, 'built', 'b2'), 'built');
        expect(built.expanded).toBe('built');
        expect(stack.selectedInstance(built, 'built').id).toBe('b2');
        // A kind the stack does not hold changes nothing.
        expect(stack.expand(built, 'designs')).toBe(built);
    });

    it('labels buildings by name or address and parcels by their cadastral number', () => {
        expect(stack.buildingLabel({ properties: { name: 'Kazalište' } })).toBe('Kazalište');
        expect(stack.buildingLabel({ properties: { addr_street: 'Ilica' } })).toBe('Ilica');
        expect(stack.buildingLabel({ properties: {} })).toBe('');
        expect(stack.parcelLabel('HR-339164-2432/1')).toBe('2432/1');
        expect(stack.parcelLabel('UK-77')).toBe('UK-77');
    });
});
