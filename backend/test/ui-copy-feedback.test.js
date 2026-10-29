// Headless contract tests for the shared click-to-copy helper and its acknowledgement, a short notice.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/ui-helpers.js', import.meta.url), 'utf8');

function createElement(tagName) {
    const classes = new Set();
    const listeners = {};
    return {
        listeners,
        tagName,
        id: '',
        className: '',
        textContent: '',
        value: '',
        style: {},
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name)
        },
        setAttribute: vi.fn(),
        addEventListener: vi.fn((type, fn) => { listeners[type] = fn; }),
        children: [],
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn()
    };
}

function loadCopyHelper({ clipboard, copiedLabel = 'Copied', execCommandResult = true } = {}) {
    const elements = new Map();
    const created = [];
    const document = {
        addEventListener: vi.fn(),
        getElementById: vi.fn(id => elements.get(id) || null),
        createElement: vi.fn(tagName => {
            const element = createElement(tagName);
            created.push(element);
            return element;
        }),
        execCommand: vi.fn(() => execCommandResult),
        body: {
            appendChild: vi.fn(element => {
                if (element.id) elements.set(element.id, element);
            })
        }
    };
    const window = {
        i18n: { t: vi.fn(key => key === 'common.copied' ? copiedLabel : key) }
    };
    const setTimeout = vi.fn(() => 1);

    vm.runInNewContext(source, {
        window,
        document,
        navigator: clipboard ? { clipboard } : {},
        requestAnimationFrame: callback => callback(),
        setTimeout,
        clearTimeout: vi.fn(),
        console: { warn: vi.fn() }
    });

    // The notice the copy helper shows: the one pill inside the notice container.
    const notice = () => harnessNotice(elements);
    return { window, document, elements, created, setTimeout, notice };
}

function harnessNotice(elements) {
    const container = elements.get('ephemeral-message-container');
    return container && container.children.length ? container.children[container.children.length - 1] : null;
}

describe('copyTextWithFeedback', () => {
    it('copies the full value and shows a localized compact acknowledgement', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard, copiedLabel: 'Copiado' });

        await expect(harness.window.copyTextWithFeedback('seat grounded=true tiles=51')).resolves.toBe(true);
        expect(clipboard.writeText).toHaveBeenCalledWith('seat grounded=true tiles=51');
        expect(harness.notice().textContent).toBe('Copiado');
        expect(harness.notice().className).toContain('cb-toast--notice');
        expect(harness.notice().classList.contains('visible')).toBe(true);
        expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1400);
    });

    it('falls back to a temporary textarea when Clipboard API is unavailable', async () => {
        const harness = loadCopyHelper();

        await expect(harness.window.copyTextWithFeedback('HR-335347-123/4')).resolves.toBe(true);
        const textarea = harness.created.find(element => element.tagName === 'textarea');
        expect(textarea.value).toBe('HR-335347-123/4');
        expect(textarea.select).toHaveBeenCalledOnce();
        expect(harness.document.execCommand).toHaveBeenCalledWith('copy');
        expect(textarea.remove).toHaveBeenCalledOnce();
    });
});

// A DOM node just rich enough for closest(): a tag, attributes, classes and a parent.
function node(tag, { attrs = {}, classes = [], text = '', parent = null } = {}) {
    const el = { tagName: tag.toUpperCase(), attrs, classes: new Set(classes), textContent: text, parent, title: '' };
    const matches = selector => selector.split(',').map(part => part.trim()).some(part => {
        const role = part.match(/^\[role="(\w+)"\]$/);
        if (role) return el.attrs.role === role[1];
        if (part.startsWith('.')) return el.classes.has(part.slice(1));
        if (part === '[contenteditable]') return 'contenteditable' in el.attrs;
        return el.tagName === part.toUpperCase();
    });
    el.closest = selector => { for (let at = el; at; at = at.parent) if (at.matchesSelf(selector)) return at; return null; };
    el.matchesSelf = matches;
    return el;
}

describe('any message on screen copies itself on a click', () => {
    const clickHandler = harness => harness.document.addEventListener.mock.calls.find(([type]) => type === 'click')[1];

    it('copies a panel\'s status line, whatever shows it', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard });
        const notice = node('div', { attrs: { role: 'status' }, classes: ['corridor-editor-notice'], text: '  Could not complete that road change — reverted:\n  Plot 7 has no ground left. ' });
        await clickHandler(harness)({ target: notice });
        expect(clipboard.writeText).toHaveBeenCalledWith('Could not complete that road change — reverted: Plot 7 has no ground left.');
        expect(harness.notice().textContent).toBe('Copied');
    });

    it('copies from a click on the message\'s text, but not from a control inside it', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard });
        const alert = node('p', { attrs: { role: 'alert' }, text: 'The chain account could not be read. Retry' });
        const span = node('span', { parent: alert, text: 'The chain account could not be read.' });
        const retry = node('button', { parent: alert, text: 'Retry' });
        await clickHandler(harness)({ target: retry });
        expect(clipboard.writeText).not.toHaveBeenCalled();
        await clickHandler(harness)({ target: span });
        expect(clipboard.writeText).toHaveBeenCalledWith('The chain account could not be read. Retry');
    });

    it('leaves a notice to its own handler, and ignores empty lines and other clicks', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard });
        await clickHandler(harness)({ target: node('div', { attrs: { role: 'status' }, classes: ['cb-toast', 'is-copyable'], text: 'Saved' }) });
        await clickHandler(harness)({ target: node('p', { attrs: { role: 'status' }, text: '   ' }) });
        await clickHandler(harness)({ target: node('div', { text: 'A paragraph that is not a message' }) });
        expect(clipboard.writeText).not.toHaveBeenCalled();
    });
});

describe('a notice copies itself on a click', () => {
    it('shows the copy cursor and copies the full message when clicked', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard });

        harness.window.showEphemeralMessage('Save failed: HTTP 500 (proposal 879)', 5000, 'error');
        const pill = harness.notice();
        expect(pill.classList.contains('is-copyable')).toBe(true);
        expect(pill.title).toBe('Copy to clipboard');

        await pill.listeners.click();
        expect(clipboard.writeText).toHaveBeenCalledWith('Save failed: HTTP 500 (proposal 879)');
        expect(harness.notice().textContent).toBe('Copied');
    });
});
