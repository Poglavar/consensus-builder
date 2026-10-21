// Keep the drill controls visible and clear of the shared planning inspector across layouts.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/drill-ui.js', import.meta.url), 'utf8');

class FakeElement {
    constructor(id = '') {
        this.id = id;
        this.hidden = false;
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.children = [];
        this.listeners = {};
        this._classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => this._classes.add(name)),
            remove: (...names) => names.forEach(name => this._classes.delete(name)),
            contains: name => this._classes.has(name),
            toggle: (name, force) => {
                const enabled = force === undefined ? !this._classes.has(name) : !!force;
                if (enabled) this._classes.add(name);
                else this._classes.delete(name);
                return enabled;
            }
        };
    }
    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    appendChild(child) { this.children.push(child); return child; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, height: 0 }; }
}

function loadDrill({ width = 1280, inspectorHidden = false } = {}) {
    const inspector = new FakeElement('planning-inspector');
    inspector.hidden = inspectorHidden;
    inspector.rect = { top: 500, bottom: 650, height: 150 };
    const elements = new Map([[inspector.id, inspector]]);
    const body = {
        appendChild(element) { elements.set(element.id, element); return element; },
        contains(element) { return elements.get(element.id) === element; }
    };
    let planningObserver = null;
    class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe(element, options) {
            if (element === inspector) {
                expect(options.attributeFilter).toContain('hidden');
                planningObserver = this.callback;
            }
        }
    }
    const document = {
        body,
        createElement: () => new FakeElement(),
        getElementById: id => elements.get(id) || null,
        addEventListener: vi.fn()
    };
    const feature = { type: 'Feature', properties: { parcelId: 'P-1' }, geometry: { type: 'Polygon', coordinates: [] } };
    const proposal = { kind: 'proposal', key: 'proposal-1', proposal: { proposalId: 'proposal-1', title: 'Proposal' } };
    const parcel = { kind: 'parcel', id: 'P-1', depth: 0, feature };
    const context = {
        document,
        innerHeight: 800,
        addEventListener: vi.fn(),
        matchMedia: query => ({ matches: query.includes('767.98') ? width <= 767.98 : width <= 899.98 }),
        MutationObserver,
        ResizeObserver: class { observe() {} },
        LiveParcelFabric: { queryBounds: () => [feature], featureId: () => 'P-1' },
        turf: { booleanPointInPolygon: () => true },
        __drillStack: { buildDrillStack: () => [proposal, parcel] },
        selectAndHighlightProposal: vi.fn(),
        selectParcel: vi.fn()
    };
    context.window = context;
    vm.runInNewContext(source, context);
    context.__drillUi.handleSurfaceClick({ lat: 2, lng: 1 });
    return { api: context.__drillUi, inspector, panel: elements.get('drill-stack-panel'), refreshInspector: () => planningObserver?.() };
}

describe('drill stack beside the planning inspector', () => {
    // A visible planning inspector keeps the stack alive when no parcel or proposal is selected.
    it('stays open while the visible inspector is its only neighbour', () => {
        const harness = loadDrill();
        expect(harness.panel.classList.contains('visible')).toBe(true);

        harness.api.hideIfNothingSelected();
        expect(harness.panel.classList.contains('visible')).toBe(true);
    });

    // Hiding the inspector is observed and closes the stack when it was the final visible neighbour.
    it('closes when the inspector is hidden and its observer runs', () => {
        const harness = loadDrill();
        expect(harness.panel.classList.contains('visible')).toBe(true);
        harness.inspector.hidden = true;
        harness.refreshInspector();
        expect(harness.panel.classList.contains('visible')).toBe(false);
    });

    // Dock offsets follow the inspector's 900px breakpoint while drill phone clearances stay at 768px.
    it('uses the inspector bottom on desktop and its top on tablets and phones', () => {
        const desktop = loadDrill();
        expect(desktop.panel.style.top).toBe('660px');
        expect(desktop.panel.style.maxHeight).toBe('68px');

        const tablet = loadDrill({ width: 800 });
        expect(tablet.panel.style.top).toBe('58px');
        expect(tablet.panel.style.maxHeight).toBe('432px');

        const phone = loadDrill({ width: 390 });
        expect(phone.panel.style.top).toBe('62px');
        expect(phone.panel.style.maxHeight).toBe('428px');
    });
});
