import { test } from 'vitest';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function fixture(orientation) {
    const window = {};
    const document = { readyState: 'loading', addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL('../../frontend/js/ui/tabs.js', import.meta.url)), 'utf8'), { window, document });
    const tabs = [0, 1, 2].map(i => ({ selected: i === 0, hidden: false, disabled: false, isConnected: true,
        getAttribute(name) { return name === 'aria-selected' ? String(this.selected) : null; },
        focus() { this.focused = true; }, click() { tabs.forEach(tab => { tab.selected = tab === this; }); window.CbTabs.sync(list); } }));
    const list = { querySelectorAll() { return tabs; }, getAttribute() { return orientation; },
        addEventListener(name, handler) { this.handler = handler; } };
    window.CbTabs.bind(list);
    return { tabs, list, window, key(index, key) { const event = { target: tabs[index], key, preventDefault() { this.prevented = true; } }; list.handler(event); return event; } };
}

test('horizontal tabs wrap, activate via click, and maintain one tab stop', () => {
    const f = fixture();
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), [0, -1, -1]);
    assert.equal(f.key(0, 'ArrowLeft').prevented, true);
    assert.equal(f.tabs[2].focused, true);
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), [-1, -1, 0]);
    f.key(2, 'Home');
    assert.equal(f.tabs[0].selected, true);
    f.key(0, 'End');
    assert.equal(f.tabs[2].selected, true);
});

test('vertical tabs use up/down and skip disabled and hidden tabs', () => {
    const f = fixture('vertical');
    f.tabs[1].disabled = true;
    assert.equal(f.key(0, 'ArrowRight').prevented, undefined);
    f.key(0, 'ArrowDown');
    assert.equal(f.tabs[2].selected, true);
    f.tabs[0].hidden = true;
    f.key(2, 'Home');
    assert.equal(f.tabs[2].selected, true);
});

test('restores focus when activation replaces a tab', () => {
    let replacementFocused = false;
    const window = {};
    const document = { readyState: 'loading', addEventListener() {}, getElementById(id) {
        assert.equal(id, 'replacement-tab');
        return { focus() { replacementFocused = true; } };
    } };
    vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL('../../frontend/js/ui/tabs.js', import.meta.url)), 'utf8'), { window, document });
    const tabs = [0, 1].map(index => ({ id: index ? 'replacement-tab' : 'first-tab', isConnected: true,
        getAttribute() { return String(index === 0); }, focus() {}, click() { this.isConnected = false; } }));
    const list = { querySelectorAll() { return tabs; }, getAttribute() { return null; }, addEventListener(_, handler) { this.handler = handler; } };
    window.CbTabs.bind(list);
    list.handler({ target: tabs[0], key: 'ArrowRight', preventDefault() {} });
    assert.equal(replacementFocused, true);
});
