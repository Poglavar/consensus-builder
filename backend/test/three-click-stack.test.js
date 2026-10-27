import { testI18n } from './helpers/i18n.js';
// The 3D model view's click stack (frontend/js/three-click-stack.js): which sections a click in the
// scene shows, in what order (Built → Design → Permitted → Parcel), which one opens, and which
// instance a strip shows first. The panel is checked in the browser; these are its pure rules.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const stack = require('../../frontend/js/three-click-stack.js');
const relations = require('../../frontend/js/click-stack/click-stack-relations.js');
const model = require('../../frontend/js/click-stack/click-stack-model.js');

const feature = { type: 'Feature', properties: {}, geometry: null };

it('places scoped agreements immediately above Plans in the model view', () => {
    const value = stack.buildThreeStack({ built: [{ id: 'b1' }], plans: [{ id: 'p1', cid: 'p1' }],
        agreements: [{ id: 'a1', planCid: 'p1' }, { id: 'wrong', planCid: 'p2' }] }, { focus: 'plans' });
    expect(value.sections.map(row => row.kind)).toEqual(['built', 'agreements', 'plans']);
    expect(value.sections[1].count).toBe(1); expect(value.expanded).toBe('plans');
});

describe('3D click stack contextual selection', () => {
    it('hides the design count and authored type while collapsed, retaining the selected design name', () => {
        const document = makeDocument();
        const context = {
            document, console, ClickStackRelations: relations,
            ProposalDesignGoals: require('../../frontend/js/proposals/design-goals.js')
        };
        context.i18n ||= testI18n();
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack;
        api.show({ designs: [
            { id: 'd1', label: 'Park', proposal: { goal: 'park' } },
            { id: 'd2', label: 'School', proposal: { goal: 'single' } }
        ] }, { focus: 'designs' }, { activate: vi.fn() });
        const section = () => document.querySelector('.click-stack__section[data-kind="designs"]');
        const row = () => section().querySelector('.click-stack__row');
        const title = () => row().querySelector('.click-stack__row-title');
        const detail = () => row().querySelector('.click-stack__row-detail');
        const badge = () => row().querySelector('.proposal-type-badge');

        expect(title().textContent).toBe('Design (2)');
        expect(detail().textContent).toBe('Park');
        expect(badge().dataset.designGoal).toBe('park');
        row().click();
        expect(title().textContent).toBe('Design');
        expect(detail().textContent).toBe('Park');
        expect(badge()).toBeNull();
        row().click();
        expect(title().textContent).toBe('Design (2)');
        expect(detail().textContent).toBe('Park');
        expect(badge().dataset.designGoal).toBe('park');
    });

    it('cycles repeated scene picks, retains the camera policy on refresh, and resets for a new or closed stack', () => {
        const document = makeDocument();
        const context = { document, console };
        context.i18n ||= testI18n();
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack, activated = [];
        const adapter = { activate: (kind, _item, _body, options) => activated.push([kind, options.fromCycle === true]) };
        const input = { built: [{ id: 'b1' }], designs: [{ id: 'd1' }], parcels: [{ id: 'p1' }] };
        const click = { key: 'building-1' };
        api.show(input, { focus: 'built', click }, adapter);
        expect(api.cycleForClick({ key: 'building-2' })).toBe(false);
        expect(api.cycleForClick(click)).toBe(true);
        expect(api.expanded()).toBe('designs');
        api.refresh();
        api.cycleForClick(click);
        expect(api.expanded()).toBe('parcels');
        api.cycleForClick(click);
        expect(api.expanded()).toBe('built');
        expect(activated).toEqual([['built', false], ['designs', true], ['designs', true], ['parcels', true], ['built', true]]);
        api.close({ silent: true });
        expect(api.cycleForClick(click)).toBe(false);
        api.show(input, { focus: 'built' }, adapter);
        expect(api.cycleForClick(click)).toBe(false);
    });
    it('retains shared-view selection policy through scene refresh and section reopening', () => {
        const document = makeDocument();
        const context = { document, console };
        context.i18n ||= testI18n();
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
        const context = { document, console, __clickStackModel: model, ClickStackRelations: relations };
        context.i18n ||= testI18n();
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack, focused = [];
        const adapter = { activate: (_kind, item, body) => { body.textContent = item.label; }, focus: (kind, item) => focused.push([kind, item.id]) };
        api.show({ designs: [{ id: 'a', label: 'Garden', proposal: { cadastreParcelIds: ['p'] } }], parcels: [{ id: 'p', label: '12' }] }, { focus: 'designs' }, adapter);
        const section = kind => document.querySelector(`.click-stack__section[data-kind="${kind}"]`);
        expect(section('designs').querySelector('.click-stack__choices')).toBeNull();
        section('parcels').querySelector('.click-stack__row').click();
        expect(api.current()).toMatchObject({ selectedKind: 'parcels', expanded: 'parcels' });
        expect(section('parcels').querySelector('.click-stack__choices').textContent).toContain('Designs on this parcel:');
        expect(section('parcels').querySelector('[data-action="related"]').dataset.id).toBe('a');
        section('parcels').querySelector('.click-stack__row').click();
        expect(api.current()).toMatchObject({ selectedKind: 'parcels', expanded: null });
        expect(section('parcels').classList.contains('is-selected')).toBe(true);
        expect(document.querySelector('.click-stack__choices')).toBeNull();
        expect(focused).toEqual([['parcels', 'p']]);
    });

    it('adds asynchronous memberships without changing design focus, retains collapse, selects native instances, and ignores stale results', async () => {
        const document = makeDocument();
        const pending = [];
        const mounted = [];
        const context = {
            document, console, __clickStackModel: model, ClickStackRelations: relations,
            DesignSync: { publishedCid: proposal => proposal?.cid || null },
            DesignMemberships: { mountSection: vi.fn((...args) => mounted.push(args)) },
            loadDesignMemberships: vi.fn((proposal, callback) => new Promise(resolve => pending.push({ proposal, callback, resolve })))
        };
        context.i18n ||= testI18n();
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack;
        const adapter = { activate: vi.fn(), focus: vi.fn() };
        const first = { id: 'd1', label: 'Road', proposal: { proposalId: 'd1', cid: 'cid-d1' } };
        const second = { id: 'd2', label: 'Park', proposal: { proposalId: 'd2', cid: 'cid-d2' } };
        api.show({ designs: [first, second], parcels: [{ id: 'p1' }] }, { focus: 'designs' }, adapter);
        expect(pending).toHaveLength(1);
        document.querySelector('.click-stack__section[data-kind="designs"] .click-stack__row').click();
        expect(api.current().expanded).toBeNull();

        const session = {
            cid: 'cid-d1', dispose: vi.fn(),
            instances(kind) { return kind === 'plans'
                ? [{ id: 'plan-1', label: 'Spatial plan', designCids: ['cid-d1'] }, { id: 'plan-2', label: 'Plan option', designCids: ['cid-d1'] }]
                : []; }
        };
        pending[0].callback(session);
        pending[0].resolve(session);
        await Promise.resolve();
        expect(api.current().sections.map(section => section.kind)).toEqual(['plans', 'designs', 'parcels']);
        expect(document.querySelector('.click-stack__section[data-kind="agreements"]')).toBeNull();
        expect(api.current()).toMatchObject({ selectedKind: 'designs', expanded: null });

        document.querySelector('.click-stack__section[data-kind="plans"] .click-stack__row').click();
        const selector = document.querySelector('.click-stack__section[data-kind="plans"] .click-stack__selector');
        expect(selector).not.toBeNull();
        selector.value = 'plan-2';
        selector.dispatchEvent({ type: 'change', target: selector });
        const plans = api.current().sections.find(section => section.kind === 'plans');
        expect(plans.instances[plans.selectedIndex].id).toBe('plan-2');
        expect(context.DesignMemberships.mountSection).toHaveBeenCalled();
        const onFocus = mounted.at(-1)[5].onFocus;
        onFocus({ id: 'plan-2' });
        expect(adapter.focus).toHaveBeenLastCalledWith('plans', { id: 'plan-2' });
        document.querySelector('.click-stack__section[data-kind="plans"] .click-stack__row').click();
        const afterCollapse = adapter.focus.mock.calls.length;
        onFocus({ id: 'plan-2' });
        expect(adapter.focus).toHaveBeenCalledTimes(afterCollapse + 1);
        document.querySelector('.click-stack__section[data-kind="designs"] .click-stack__row').click();
        const afterSwitch = adapter.focus.mock.calls.length;
        onFocus({ id: 'plan-2' });
        expect(adapter.focus).toHaveBeenCalledTimes(afterSwitch);

        const designSelector = document.querySelector('.click-stack__section[data-kind="designs"] .click-stack__selector');
        designSelector.value = 'd2';
        designSelector.dispatchEvent({ type: 'change', target: designSelector });
        expect(pending).toHaveLength(2);
        const kindsBeforeStale = api.current().sections.map(section => section.kind);
        pending[0].callback({ cid: 'stale', instances: () => [{ id: 'stale-plan' }], dispose: vi.fn() });
        expect(api.current().sections.map(section => section.kind)).toEqual(kindsBeforeStale);
        api.close({ silent: true });
        pending[1].callback({ cid: 'closed', instances: () => [{ id: 'closed-agreement' }], dispose: vi.fn() });
        expect(api.isOpen()).toBe(false);
    });

    it('rejects an in-flight membership result when the same local design publishes a new CID, then resyncs', () => {
        const document = makeDocument();
        const proposal = { proposalId: 'd1', cid: 'current' };
        const pending = [];
        const context = {
            document, console, __clickStackModel: model, ClickStackRelations: relations,
            DesignSync: { publishedCid: record => record?.cid || null },
            loadDesignMemberships: vi.fn((record, callback) => new Promise(resolve => pending.push({ record, callback, resolve })))
        };
        context.i18n ||= testI18n();
        context.window = context;
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/three-click-stack.js', import.meta.url), 'utf8'), context);
        const api = context.ThreeClickStack;
        api.show({ designs: [{ id: 'd1', label: 'Road', proposal }] }, { focus: 'designs' }, { activate: vi.fn(), focus: vi.fn() });
        expect(pending).toHaveLength(1);
        proposal.cid = 'revised';
        const stale = { cid: 'current', dispose: vi.fn(), instances: kind => kind === 'plans' ? [{ id: 'stale-plan' }] : [{ id: 'stale-agreement' }] };
        pending[0].callback(stale);
        pending[0].resolve(stale);
        expect(stale.dispose).toHaveBeenCalled();
        expect(pending).toHaveLength(2);
        expect(api.current().sections.map(section => section.kind)).toEqual(['designs']);
        const current = { cid: 'revised', dispose: vi.fn(), instances: kind => kind === 'plans' ? [{ id: 'current-plan', label: 'Current', membershipDesignCid: 'revised' }] : [{ id: 'current-agreement' }] };
        pending[1].callback(current);
        expect(api.current().sections.map(section => section.kind)).toEqual(['plans', 'designs']);
    });
});

describe('3D click stack rules', () => {
    it('continues at the same spot when selection changes the ray hit, but resets on another parcel or object elsewhere', () => {
        const click = { key: 'parcel-1', parcelId: 'p1', point: { x: 100, y: 100 } };
        expect(stack.sameClick(click, { ...click, key: 'new-design-surface' })).toBe(true);
        expect(stack.sameClick(click, { ...click, key: 'building-2', point: { x: 140, y: 100 } })).toBe(false);
        expect(stack.sameClick(click, { ...click, key: 'parcel-2', parcelId: 'p2' })).toBe(false);
        expect(stack.sameClick(null, click)).toBe(false);
    });
    it('cycles through present sections, wraps, reopens collapsed content and retains instance choices', () => {
        let current = stack.buildThreeStack({ built: [{ id: 'b1' }, { id: 'b2' }], parcels: [{ id: 'p1' }] }, { focus: 'built', selected: { built: 'b2' } });
        current = stack.cycle(current);
        expect(current.expanded).toBe('parcels');
        current = stack.cycle(current);
        expect(current.expanded).toBe('built');
        expect(stack.selectedInstance(current, 'built').id).toBe('b2');
        expect(stack.cycle({ ...current, expanded: null }).expanded).toBe('built');
        expect(stack.cycle(stack.buildThreeStack({ parcels: [{ id: 'p1' }] })).expanded).toBe('parcels');
        expect(stack.cycle(stack.buildThreeStack({})).expanded).toBeNull();
    });
    it('orders Built, Plans, Design, Permitted, Parcel and ignores agreement memberships', () => {
        const built = stack.buildThreeStack({
            parcels: [{ id: 'HR-1-2', label: '2' }],
            designs: [{ id: 'd1', label: 'Park' }],
            built: [{ id: 'b1', label: '', feature }],
            plans: [{ id: 'pl1', label: 'Plan' }],
            agreements: [{ id: 'ag1', label: 'Agreement' }]
        }, { focus: 'designs' });
        expect(built.sections.map(section => section.kind)).toEqual(['built', 'plans', 'designs', 'parcels']);
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
