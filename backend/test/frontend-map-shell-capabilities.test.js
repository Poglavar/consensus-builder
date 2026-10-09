import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

class FakeClassList {
    constructor(...initial) { this.values = new Set(initial); }
    contains(value) { return this.values.has(value); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    toggle(value, force) {
        const shouldAdd = force === undefined ? !this.values.has(value) : !!force;
        if (shouldAdd) this.values.add(value); else this.values.delete(value);
        return shouldAdd;
    }
}

class FakeStyle {
    values = new Map();
    setProperty(name, value) { this.values.set(name, value); }
    removeProperty(name) { this.values.delete(name); }
}

class FakeElement {
    constructor({ id = '', classes = [], attributes = {}, hidden = false } = {}) {
        this.id = id;
        this.classList = new FakeClassList(...classes);
        this.attributes = new Map(Object.entries(attributes));
        this.hidden = hidden;
        this.disabled = false;
        this.style = new FakeStyle();
        this.listeners = new Map();
        this.children = [];
        this.parentElement = null;
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    closest(selector) { return selector === '[data-sheet-anchor]' ? null : null; }
    getBoundingClientRect() { return { top: 10, bottom: 50, left: 10, right: 50, width: 40, height: 40 }; }
    focus() { this.ownerDocument.activeElement = this; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    querySelectorAll() { return []; }
    getClientRects() { return this.hidden ? [] : [{}]; }
}

function bootMapShell() {
    const documentListeners = new Map();
    const body = new FakeElement();
    body.style = new FakeStyle();
    const modes = [
        new FakeElement({ id: 'two-d', attributes: { 'data-map-modes': '2d' } }),
        new FakeElement({ id: 'three-d', attributes: { 'data-map-modes': '3d' }, hidden: true }),
        new FakeElement({ id: 'photo', attributes: { 'data-map-modes': 'photo' }, hidden: true })
    ];
    const measureSheet = new FakeElement({ id: 'measurement-sheet', classes: ['map-sheet'], attributes: { 'data-map-modes': '2d' }, hidden: true });
    const activitySheet = new FakeElement({ id: 'activity-sheet', classes: ['map-sheet'], hidden: true });
    const trigger = new FakeElement({ id: 'measurement-trigger', attributes: { 'data-sheet-target': 'measurement-sheet' } });
    const nav = ['proposals', 'bets', 'activity'].map(id => new FakeElement({ id }));
    const elements = new Map([[measureSheet.id, measureSheet], [activitySheet.id, activitySheet]]);
    for (const element of [...modes, ...nav, trigger]) elements.set(element.id, element);

    const doc = {
        body,
        activeElement: body,
        listeners: documentListeners,
        getElementById: id => elements.get(id) || null,
        querySelectorAll(selector) {
            if (selector === '.map-sheet') return [measureSheet, activitySheet];
            if (selector === '[data-sheet-target]') return [trigger];
            if (selector === '[data-sheet-close]') return [];
            if (selector === '[data-map-modes]') return [...modes, measureSheet];
            if (selector.startsWith('[data-sheet-target="')) return trigger.getAttribute('data-sheet-target') === selector.slice(20, -2) ? [trigger] : [];
            return [];
        },
        addEventListener(type, listener) {
            const listeners = documentListeners.get(type) || [];
            listeners.push(listener);
            documentListeners.set(type, listeners);
        },
        dispatchEvent(event) {
            for (const listener of documentListeners.get(event.type) || []) listener(event);
            return true;
        },
        createElement() { return new FakeElement(); }
    };
    for (const element of elements.values()) element.ownerDocument = doc;

    class FakeCustomEvent {
        constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    }
    const windowListeners = new Map();
    const win = {
        document: doc,
        CustomEvent: FakeCustomEvent,
        innerWidth: 1200,
        innerHeight: 800,
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: callback => callback(),
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'js/ui/map-shell.js'), 'utf8'), { window: win, console });
    win.MapShell.initializeMapShell();
    return { win, doc, body, modes, measureSheet, activitySheet, trigger, nav, windowListeners };
}

describe('MapShell mode capabilities', () => {
    it('initializes view controls without opening supported sheets, then closes an incompatible active sheet', () => {
        const { win, doc, body, modes, measureSheet, activitySheet, nav } = bootMapShell();
        const shell = win.MapShell;

        expect(modes.map(control => control.hidden)).toEqual([false, true, true]);
        expect(measureSheet.hidden).toBe(true);
        expect(activitySheet.hidden).toBe(true);
        expect(shell.isOpen('measurement-sheet')).toBe(false);
        expect(shell.isOpen('activity-sheet')).toBe(false);

        shell.openSheet(activitySheet, { focus: false });
        expect(activitySheet.hidden).toBe(false);
        shell.closeSheets();
        shell.openSheet(measureSheet, { focus: false });
        expect(shell.isOpen('measurement-sheet')).toBe(true);

        const closed = [];
        doc.addEventListener('mapshell:sheetclosed', event => {
            closed.push({ id: event.detail.id, wasOpenAtDispatch: shell.isOpen(event.detail.id) });
        });
        body.classList.add('three-mode-active');
        shell.syncModeAvailability();

        expect(modes.map(control => control.hidden)).toEqual([true, false, true]);
        expect(measureSheet.hidden).toBe(true);
        expect(shell.isOpen('measurement-sheet')).toBe(false);
        expect(closed).toEqual([{ id: 'measurement-sheet', wasOpenAtDispatch: false }]);
        expect(nav.every(button => button.disabled === false)).toBe(true);

        body.classList.remove('three-mode-active');
        body.classList.add('realistic-mode-active');
        shell.syncModeAvailability();
        expect(modes.map(control => control.hidden)).toEqual([true, true, false]);
        expect(nav.every(button => button.disabled === false)).toBe(true);
    });
});
