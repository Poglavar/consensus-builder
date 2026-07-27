// Headless contract tests for the shared click-to-copy helper and its compact acknowledgement.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/ui-helpers.js', import.meta.url), 'utf8');

function createElement(tagName) {
    const classes = new Set();
    return {
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

    return { window, document, elements, created, setTimeout };
}

describe('copyTextWithFeedback', () => {
    it('copies the full value and shows a localized compact acknowledgement', async () => {
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        const harness = loadCopyHelper({ clipboard, copiedLabel: 'Copiado' });

        await expect(harness.window.copyTextWithFeedback('seat grounded=true tiles=51')).resolves.toBe(true);
        expect(clipboard.writeText).toHaveBeenCalledWith('seat grounded=true tiles=51');
        expect(harness.elements.get('copy-feedback-toast').textContent).toBe('Copiado');
        expect(harness.elements.get('copy-feedback-toast').classList.contains('visible')).toBe(true);
        expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1100);
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
