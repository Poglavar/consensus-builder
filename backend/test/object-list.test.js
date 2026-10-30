// The shared object-list behaviour (frontend/js/ui/object-list.js): hover and focus outline an item's
// object, a click keeps it outlined until clicked again, controls inside an item keep their own
// actions, and a pressed item stays pressed when its list is rendered anew.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { makeDocument, makeEvent } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const ObjectList = require('../../frontend/js/ui/object-list.js');

function list(doc, keys) {
    const host = doc.createElement('ul');
    for (const key of keys) {
        const row = doc.createElement('li');
        row.className = 'row';
        if (key) row.dataset.key = key;
        const name = doc.createElement('span');
        name.textContent = key || 'no shape';
        const open = ObjectList.openButton(doc, key, null);
        row.append(name, open);
        host.appendChild(row);
    }
    return host;
}

describe('object list', () => {
    it('outlines on hover, keeps a clicked item, and leaves controls and shapeless items alone', () => {
        const doc = makeDocument();
        const host = list(doc, ['a', 'b', '']);
        doc.body.appendChild(host);
        const shown = [];
        const bound = ObjectList.bind(host, { item: '.row', keyOf: row => row.dataset.key || null,
            show: (key, { pinned }) => shown.push(`${key}${pinned ? '!' : ''}`), restore: () => shown.push('-') });
        const [a, b, none] = host.querySelectorAll('.row');
        const move = (type, target, relatedTarget = null) => target.dispatchEvent(makeEvent(type, { target, relatedTarget }));

        move('mouseover', a);
        move('mouseout', a, host);
        move('mouseover', none);
        none.click();
        a.querySelector('.object-list__open').click();
        expect(shown.splice(0)).toEqual(['a', '-']);
        expect(a.getAttribute('aria-pressed')).toBeNull();

        b.click();
        move('mouseover', a);
        move('mouseout', a, host);
        expect(shown.splice(0)).toEqual(['b!', 'a', 'b']);
        expect(b.getAttribute('aria-pressed')).toBe('true');
        expect(bound.pinnedKey()).toBe('b');
        b.click();
        expect(shown.splice(0)).toEqual(['-']);
        expect(b.getAttribute('aria-pressed')).toBe('false');
        expect(bound.pinnedKey()).toBeNull();
    });

    it('keeps the same object pressed when its list is rendered anew, and resets on request', () => {
        const doc = makeDocument();
        const host = doc.createElement('div');
        doc.body.appendChild(host);
        host.appendChild(list(doc, ['a', 'b']));
        const shown = [];
        const bound = ObjectList.bind(host, { item: '.row', keyOf: row => row.dataset.key,
            show: key => shown.push(key), restore: () => shown.push('-') });
        host.querySelectorAll('.row')[1].click();
        host.replaceChildren(list(doc, ['b', 'a']));
        expect(bound.pinnedKey()).toBe('b');
        const fresh = host.querySelectorAll('.row')[0];
        expect(fresh.getAttribute('aria-pressed')).toBe('true');
        bound.reset();
        expect(fresh.getAttribute('aria-pressed')).toBe('false');
        expect(bound.pinnedKey()).toBeNull();
    });

    it('names its open button after the object and runs only its own action', () => {
        const doc = makeDocument();
        const onOpen = vi.fn();
        const parent = vi.fn();
        const holder = doc.createElement('div');
        holder.addEventListener('click', parent);
        const open = ObjectList.openButton(doc, 'Riverside', { i18n: { t: (key, { title }) => `${key}:${title}` } }, { onOpen });
        holder.appendChild(open);
        open.click();
        expect(open.getAttribute('aria-label')).toBe('lists.openNamed:Riverside');
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(parent).not.toHaveBeenCalled();
    });
});
