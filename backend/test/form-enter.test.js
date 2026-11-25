// The Enter rule shared by every form (frontend/js/ui/form-enter.js): Enter submits from text
// fields only, never from a select or a non-text input; the browser specs check it on real forms.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { blocksImplicitSubmit, install } = require('../../frontend/js/ui/form-enter.js');

describe('Enter submits a form from text fields only', () => {
    const form = {};
    it('blocks implicit submission from selects and non-text inputs in a form', () => {
        expect(blocksImplicitSubmit({ tagName: 'SELECT', form })).toBe(true);
        for (const type of ['checkbox', 'radio', 'range', 'color', 'file']) expect(blocksImplicitSubmit({ tagName: 'INPUT', type, form })).toBe(true);
    });

    it('leaves text fields, buttons, textareas and controls outside a form alone', () => {
        for (const type of ['text', 'date', 'datetime-local', 'number', 'submit', 'button']) expect(blocksImplicitSubmit({ tagName: 'INPUT', type, form })).toBe(false);
        expect(blocksImplicitSubmit({ tagName: 'BUTTON', form })).toBe(false);
        expect(blocksImplicitSubmit({ tagName: 'TEXTAREA', form })).toBe(false);
        expect(blocksImplicitSubmit({ tagName: 'SELECT', form: null })).toBe(false);
        expect(blocksImplicitSubmit(null)).toBe(false);
    });

    it('installs one capture listener per document that cancels Enter on a select', () => {
        const listeners = [];
        const doc = { addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }) };
        install(doc); install(doc);
        expect(listeners.map(entry => [entry.type, entry.capture])).toEqual([['keydown', true]]);
        let prevented = 0;
        const press = (key, target) => listeners[0].handler({ key, target, isComposing: false, preventDefault: () => { prevented++; } });
        press('Enter', { tagName: 'SELECT', form });
        press('Enter', { tagName: 'INPUT', type: 'text', form });
        press('ArrowDown', { tagName: 'SELECT', form });
        expect(prevented).toBe(1);
    });
});
