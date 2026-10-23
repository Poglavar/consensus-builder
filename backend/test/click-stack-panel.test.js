// Characterization of the click stack panel (frontend/js/click-stack/click-stack-panel.js): the real
// script, the real model and a small fake DOM (helpers/fake-dom.js), with every collaborator a spy.
// It asserts what a map click opens or closes, which section expands, where the hosted panel lives,
// and how the stack steps aside when another surface takes the dock.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/click-stack/click-stack-model.js');
const panelSource = readFileSync(new URL('../../frontend/js/click-stack/click-stack-panel.js', import.meta.url), 'utf8');
const editLockSource = readFileSync(new URL('../../frontend/js/map-edit-lock.js', import.meta.url), 'utf8');

const SPOT_A = { lat: 45.81, lng: 15.97 };
const SPOT_B = { lat: 45.82, lng: 15.98 };
const SPOT_EMPTY = { lat: 45.83, lng: 15.99 };
const parcelFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
const HITS_A = {
    designs: [{ id: 'd1', label: 'Park', createdAt: '2026-10-01', proposal: { proposalId: 'd1' } },
        { id: 'd2', label: 'School', createdAt: '2026-09-01', proposal: { proposalId: 'd2' } }],
    parcels: [{ id: 'p1', label: '12', feature: parcelFeature, live: true }]
};
const HITS_B = { parcels: [{ id: 'p2', label: '13', feature: parcelFeature, live: true }] };

function loadPanel({ memory = null, withEditLock = false } = {}) {
    const doc = makeDocument();
    const mapContainer = doc.createElement('div');
    mapContainer.id = 'map-container';
    doc.body.appendChild(mapContainer);
    // The docked panels live in their own homes; the stack borrows them.
    const dock = doc.createElement('div');
    dock.id = 'dock';
    mapContainer.appendChild(dock);
    const panel = (id, className) => {
        const el = doc.createElement('aside');
        el.id = id;
        el.className = className;
        dock.appendChild(el);
        return el;
    };
    const proposalPanel = panel('proposal-details-panel', 'info-panel right-dock-panel');
    const parcelPanel = panel('parcel-info-panel', 'info-panel right-dock-panel');
    const inspector = panel('planning-inspector', 'planning-inspector');
    inspector.hidden = true;

    const observers = [];
    class MutationObserver {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
    }
    const storage = new Map(memory ? [['cb.clickStack.expanded', memory]] : []);
    const clock = { now: 1_000_000 };
    class ClockDate extends Date { static now() { return clock.now; } }
    const hitsBySpot = new Map([[SPOT_A.lat, HITS_A], [SPOT_B.lat, HITS_B]]);
    // The real collaborators find their panel by id, as the browser does.
    const byId = id => doc.getElementById(id);
    const context = {
        console: { info: () => {}, error: console.error, warn: console.warn, log: () => {} },
        Date: ClockDate,
        document: doc,
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
        MutationObserver,
        addEventListener: vi.fn(),
        navigator: {},
        __clickStackModel: model,
        ClickStackHits: { hitsAt: vi.fn(latlng => hitsBySpot.get(latlng.lat) || {}) },
        __drillUi: { stackAt: vi.fn(() => [{ kind: 'parcel', id: 'p1', depth: 0 }, { kind: 'proposal', key: 'd1' }]) },
        MapPick: { active: () => false, pick: vi.fn() },
        highlightFeaturesForHover: vi.fn(),
        selectAndHighlightProposal: vi.fn(() => byId('proposal-details-panel')?.classList.add('visible')),
        hideProposalDetailsPanel: vi.fn(() => byId('proposal-details-panel')?.classList.remove('visible')),
        hideParcelInfoPanel: vi.fn(() => byId('parcel-info-panel')?.classList.remove('visible')),
        ProposalSelection: { clear: vi.fn() },
        LiveParcelFabric: { get: id => (String(id).startsWith('p') ? parcelFeature : null) },
        ParcelsUISelection: { selectParcelFromStack: vi.fn(() => byId('parcel-info-panel')?.classList.add('visible')) },
        ParcelMenu: { factsFor: vi.fn(() => ({ parcelId: 'p1' })), factsLine: () => '120 m²' },
        UiCommands: { commandsFor: () => [], createBrowserContext: () => ({}), labelOf: entry => entry.id, runCommand: vi.fn() },
        PlanningViews: { select: vi.fn(id => { if (id === null) inspector.hidden = true; }), isInspecting: () => !inspector.hidden,
            inspectBuilding: vi.fn(() => { inspector.hidden = false; }), selectAt: vi.fn(() => { inspector.hidden = false; }) },
        AgreementPanel: { isOpen: () => false, close: vi.fn(), open: vi.fn() }
    };
    context.window = context;
    vm.createContext(context);
    if (withEditLock) vm.runInContext(editLockSource, context);
    vm.runInContext(panelSource, context);
    const api = context.ClickStack;
    const stackEl = () => doc.getElementById('click-stack');
    const section = kind => stackEl()?.querySelector(`.click-stack__section[data-kind="${kind}"]`) || null;
    return {
        api, context, doc, storage, clock, dock, proposalPanel, parcelPanel, inspector, stackEl, section,
        // One physical click; time moves on so the next one is not the same click reaching a second layer.
        click(latlng) { clock.now += 1000; return api.handleClick(latlng); },
        observe() { observers.forEach(observer => observer.callback([])); },
        kinds: () => [...(stackEl()?.querySelectorAll('.click-stack__section') || [])].map(el => el.dataset.kind)
    };
}

describe('click stack panel: a click opens, the same click closes', () => {
    it('opens the spot with the topmost section expanded and its panel hosted in the section', () => {
        const h = loadPanel();
        expect(h.click(SPOT_A)).toBe(true);
        expect(h.context.ClickStackHits.hitsAt).toHaveBeenCalledWith(SPOT_A, { onPublished: expect.any(Function) });
        expect(h.api.isOpen()).toBe(true);
        expect(h.stackEl().classList.contains('visible')).toBe(true);
        expect(h.doc.body.classList.contains('click-stack-open')).toBe(true);
        expect(h.kinds()).toEqual(['designs', 'parcels']);
        // No remembered kind: the topmost expandable section, its newest design.
        expect(h.api.current().expanded).toBe('designs');
        expect(h.context.selectAndHighlightProposal).toHaveBeenCalledWith('d1', null, false, true);
        expect(h.proposalPanel.parentNode).toBe(h.section('designs').querySelector('.click-stack__body'));
        expect(h.proposalPanel.classList.contains('is-hosted')).toBe(true);
        // Two designs: a strip with the selected one pressed.
        const chips = h.section('designs').querySelectorAll('.click-stack__chip');
        expect(chips.map(chip => [chip.dataset.id, chip.getAttribute('aria-pressed')])).toEqual([['d1', 'true'], ['d2', 'false']]);
    });

    it('shows the parcel\'s published proposals when they arrive, keeping the parcel open', () => {
        const h = loadPanel();
        h.click(SPOT_B);
        expect(h.api.current().expanded).toBe('parcels');
        const { onPublished } = h.context.ClickStackHits.hitsAt.mock.calls[0][1];
        h.context.ClickStackHits.hitsAt.mockImplementation(() => ({ ...HITS_B,
            designs: [{ id: 'bafy-park', label: 'Park', serverId: 'bafy-park', onParcel: true, proposal: { cid: 'bafy-park' } }] }));
        onPublished();
        expect(h.kinds()).toEqual(['designs', 'parcels']);
        expect(h.api.current().expanded).toBe('parcels');
        expect(h.parcelPanel.parentNode).toBe(h.section('parcels').querySelector('.click-stack__body'));
        expect(h.context.selectAndHighlightProposal).not.toHaveBeenCalled();
        // A later answer for a spot no longer shown changes nothing.
        h.context.ClickStackHits.hitsAt.mockImplementation(latlng => (latlng.lat === SPOT_A.lat ? HITS_A : HITS_B));
        h.click(SPOT_A);
        onPublished();
        expect(h.api.current().expanded).toBe('designs');
    });

    it('closes on a second click on the same topmost object and puts the hosted panel back', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.click(SPOT_A);
        expect(h.api.isOpen()).toBe(false);
        expect(h.stackEl().classList.contains('visible')).toBe(false);
        expect(h.doc.body.classList.contains('click-stack-open')).toBe(false);
        expect(h.proposalPanel.parentNode).toBe(h.dock);
        expect(h.proposalPanel.classList.contains('is-hosted')).toBe(false);
        expect(h.proposalPanel.classList.contains('visible')).toBe(false);
        expect(h.context.ProposalSelection.clear).toHaveBeenCalled();
    });

    it('treats one physical click reaching two layers as one click', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        expect(h.api.handleClick({ ...SPOT_A })).toBe(true); // same point, same millisecond
        expect(h.api.isOpen()).toBe(true);
        expect(h.context.ClickStackHits.hitsAt).toHaveBeenCalledTimes(1);
    });

    it('switches to another spot, and closes on a spot with nothing', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.click(SPOT_B);
        expect(h.api.isOpen()).toBe(true);
        expect(h.kinds()).toEqual(['parcels']);
        expect(h.proposalPanel.parentNode).toBe(h.dock);
        expect(h.parcelPanel.parentNode).toBe(h.section('parcels').querySelector('.click-stack__body'));
        expect(h.context.ParcelsUISelection.selectParcelFromStack).toHaveBeenCalledWith('p2');
        h.click(SPOT_EMPTY);
        expect(h.api.isOpen()).toBe(false);
        expect(h.parcelPanel.parentNode).toBe(h.dock);
        // Nothing open and nothing there: nothing happens.
        expect(h.click(SPOT_EMPTY)).toBe(true);
        expect(h.api.isOpen()).toBe(false);
    });

    it('does nothing while the map is held by an editor', () => {
        const h = loadPanel({ withEditLock: true });
        h.context.__mapEditLock.claim('park-editor');
        expect(h.click(SPOT_A)).toBe(false);
        expect(h.api.isOpen()).toBe(false);
        expect(h.context.ClickStackHits.hitsAt).not.toHaveBeenCalled();
    });

    it('closes on Escape and on the close button', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.stackEl().querySelector('.click-stack__close').click();
        expect(h.api.isOpen()).toBe(false);
        h.click(SPOT_A);
        const escape = { type: 'keydown', key: 'Escape', defaultPrevented: false, target: h.doc.body, preventDefault() { this.defaultPrevented = true; } };
        h.doc.dispatchEvent(escape);
        expect(h.api.isOpen()).toBe(false);
        expect(escape.defaultPrevented).toBe(true);
    });
});

describe('click stack panel: the remembered section', () => {
    it('expands the remembered kind when the spot has it', () => {
        const h = loadPanel({ memory: 'parcels' });
        h.click(SPOT_A);
        expect(h.api.current().expanded).toBe('parcels');
        expect(h.context.ParcelsUISelection.selectParcelFromStack).toHaveBeenCalledWith('p1');
        expect(h.context.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(h.parcelPanel.parentNode).toBe(h.section('parcels').querySelector('.click-stack__body'));
        expect(h.section('parcels').classList.contains('is-expanded')).toBe(true);
        expect(h.section('designs').classList.contains('is-expanded')).toBe(false);
    });

    it('falls back to the topmost section when the remembered kind is absent', () => {
        const h = loadPanel({ memory: 'built' });
        h.click(SPOT_A);
        expect(h.api.current().expanded).toBe('designs');
    });

    it('remembers the section a row click expands, and moves the hosted panel with it', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.section('parcels').querySelector('.click-stack__row').click();
        expect(h.storage.get('cb.clickStack.expanded')).toBe('parcels');
        expect(h.api.current().expanded).toBe('parcels');
        expect(h.parcelPanel.parentNode).toBe(h.section('parcels').querySelector('.click-stack__body'));
        // The design's card went home and does not count as hosted any more.
        expect(h.proposalPanel.parentNode).toBe(h.dock);
        expect(h.proposalPanel.classList.contains('is-hosted')).toBe(false);
        // The expanded row again: everything collapses to rows and the panel is closed.
        h.section('parcels').querySelector('.click-stack__row').click();
        expect(h.api.current().expanded).toBeNull();
        expect(h.parcelPanel.parentNode).toBe(h.dock);
        expect(h.context.hideParcelInfoPanel).toHaveBeenCalled();
    });

    // KNOWN BUG (reported, not fixed here): expand() re-renders the sections while the design's card
    // is still inside the old section body, so the card is detached from the document before the
    // newly chosen design is shown and hosted. getElementById then finds no card, the section ends
    // with nothing hosted and the card is closed. Flip to it() once click-stack-panel.js expand()
    // releases the hosted panel before render().
    it('keeps the design card hosted when another design is chosen in the strip', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.section('designs').querySelector('.click-stack__chip[data-id="d2"]').click();
        expect(h.context.selectAndHighlightProposal).toHaveBeenLastCalledWith('d2', null, false, true);
        expect(h.proposalPanel.parentNode).toBe(h.section('designs').querySelector('.click-stack__body'));
        expect(h.proposalPanel.classList.contains('visible')).toBe(true);
    });
});

describe('click stack panel: other surfaces and the dock', () => {
    it('steps aside when another surface opens a hostable panel, leaving that panel open', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        // A list or a route opens the parcel panel outside the stack.
        h.parcelPanel.classList.add('visible');
        h.observe();
        expect(h.api.isOpen()).toBe(false);
        expect(h.parcelPanel.classList.contains('visible')).toBe(true);
        expect(h.parcelPanel.parentNode).toBe(h.dock);
        // Ours is released without being closed by the stack.
        expect(h.proposalPanel.parentNode).toBe(h.dock);
        expect(h.proposalPanel.classList.contains('is-hosted')).toBe(false);
        expect(h.context.hideProposalDetailsPanel).not.toHaveBeenCalled();
    });

    it('steps aside, without closing it, when the panel another surface opens has closed ours', () => {
        const h = loadPanel({ memory: 'parcels' });
        h.click(SPOT_A);
        expect(h.api.current().expanded).toBe('parcels');
        // Showing a design from elsewhere hides the hosted parcel panel and opens the inspector.
        h.parcelPanel.classList.remove('visible');
        h.inspector.hidden = false;
        h.observe();
        expect(h.api.isOpen()).toBe(false);
        expect(h.inspector.hidden).toBe(false);
        expect(h.parcelPanel.parentNode).toBe(h.dock);
        expect(h.context.hideParcelInfoPanel).not.toHaveBeenCalled();
    });

    it('steps aside when the agreement panel takes the dock', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.context.AgreementPanel.isOpen = () => true;
        h.observe();
        expect(h.api.isOpen()).toBe(false);
    });

    it('collapses the section when its hosted panel closes itself, staying open', () => {
        const h = loadPanel();
        h.click(SPOT_A);
        h.proposalPanel.classList.remove('visible');
        h.observe();
        expect(h.api.isOpen()).toBe(true);
        expect(h.api.current().expanded).toBeNull();
        expect(h.proposalPanel.parentNode).toBe(h.dock);
    });

    it('closes the panels another surface left open when it opens a spot', () => {
        const h = loadPanel();
        h.parcelPanel.classList.add('visible');
        h.inspector.hidden = false;
        h.click(SPOT_A);
        expect(h.context.hideParcelInfoPanel).toHaveBeenCalled();
        expect(h.context.PlanningViews.select).toHaveBeenCalledWith(null);
        expect(h.api.isOpen()).toBe(true);
    });
});

describe('click stack panel: a surface picking designs', () => {
    it('hands the topmost design at the point to MapPick and opens nothing', () => {
        const h = loadPanel();
        h.context.MapPick.active = () => true;
        expect(h.click(SPOT_A)).toBe(true);
        expect(h.context.MapPick.pick).toHaveBeenCalledWith('d1');
        expect(h.context.ClickStackHits.hitsAt).not.toHaveBeenCalled();
        expect(h.api.isOpen()).toBe(false);
    });

    // KNOWN BUG (reported, not fixed here): with the real map-edit-lock.js loaded (always, in the
    // app), blocksSelection() is true while MapPick is active, and handleClick returns before its
    // MapPick branch. Structure and corridor clicks (drill-ui handleSurfaceClick) therefore pick
    // nothing in pick mode. Flip to it() once handleClick checks MapPick before blocked().
    it('hands the topmost design to MapPick with the real edit lock loaded', () => {
        const h = loadPanel({ withEditLock: true });
        h.context.MapPick.active = () => true;
        h.click(SPOT_A);
        expect(h.context.MapPick.pick).toHaveBeenCalledWith('d1');
    });
});
