// The pure parts of the dialog helper (frontend/js/ui/dialogs.js): which answer of a confirm is the
// primary (the safe one when the OK is destructive), and how an alert message with a {{txLink}}
// placeholder splits into text, link and line breaks. The DOM parts are exercised in a browser.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { confirmActions, linkedMessageParts } = require('../../frontend/js/ui/dialogs.js');
const t = (key, fallback) => fallback;

describe('confirm answers', () => {
    it('makes OK the primary and focuses it for an ordinary confirm', () => {
        const actions = confirmActions({ okText: 'Apply', cancelText: 'Not now' }, t);
        expect(actions.map(a => [a.id, a.label, a.role, !!a.autofocus, a.value])).toEqual([
            ['cancel', 'Not now', 'secondary', false, false],
            ['ok', 'Apply', 'primary', true, true]
        ]);
    });

    it('makes the safe answer the primary when the OK is destructive', () => {
        const actions = confirmActions({ destructive: true, okText: 'Discard', cancelText: 'Keep editing' }, t);
        expect(actions.map(a => [a.id, a.label, a.role, !!a.autofocus])).toEqual([
            ['cancel', 'Keep editing', 'primary', true],
            ['ok', 'Discard', 'danger', false]
        ]);
    });

    it('falls back to the translated OK / Cancel', () => {
        const actions = confirmActions({}, (key) => `<${key}>`);
        expect(actions.map(a => a.label)).toEqual(['<common.cancel>', '<common.ok>']);
    });
});

describe('alert message with a transaction link', () => {
    it('splits text, link mark and line breaks in order', () => {
        expect(linkedMessageParts('Minted.\nSee {{txLink}} for the record.')).toEqual([
            { text: 'Minted.' }, { br: true }, { text: 'See ' }, { link: true }, { text: ' for the record.' }
        ]);
    });

    it('keeps a message without the placeholder as plain lines', () => {
        expect(linkedMessageParts('one\ntwo')).toEqual([{ text: 'one' }, { br: true }, { text: 'two' }]);
        expect(linkedMessageParts(null)).toEqual([]);
    });
});
