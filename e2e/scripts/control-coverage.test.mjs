// Purpose: characterize trusted pointer-tap attribution when a renderer captures events away from the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

class FakeElement {
  constructor(tagName, attrs = {}, textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    this.disabled = false;
    this.readOnly = false;
    this.type = attrs.type || '';
    this.value = attrs.value || '';
    this.checked = false;
    this.left = 0;
    this.top = 0;
    this._attrs = new Map(Object.entries(attrs));
    this.attributes = [...this._attrs].map(([name, value]) => ({ name, value }));
    this.classList = new Set((this.getAttribute('class') || '').split(/\s+/));
    this.classList.contains = name => this.classList.has(name);
  }

  closest(selector) {
    if (selector.includes('[role="slider"]') && this.getAttribute('role') === 'slider') return this;
    if (selector.includes('.blockify-handle--gap')
        && (this.classList.contains('blockify-handle--gap') || this.classList.contains('blockify-handle--wing'))) return this;
    if (selector.startsWith('input:not')) {
      return ['INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName)
        && !['hidden', 'button', 'submit', 'reset'].includes(this.type) ? this : null;
    }
    return (/button/.test(selector) && this.tagName === 'BUTTON') || (/\ba\b/.test(selector) && this.tagName === 'A') ? this : null;
  }

  getAttribute(name) { return this._attrs.get(name) ?? null; }
  hasAttribute(name) { return this._attrs.has(name); }
  getBoundingClientRect() { return { left: this.left, top: this.top, width: 48, height: 24 }; }
  setPosition(left, top) { this.left = left; this.top = top; }
}

async function instrumentedRecorder(extraControls = []) {
  const events = [];
  const button = new FakeElement('button', { 'data-ui-control': 'control-city-label-1' }, 'Tokyo');
  const canvas = new FakeElement('canvas');
  const listeners = new Map();
  const document = {
    readyState: 'complete',
    documentElement: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelectorAll() { return [button, ...extraControls]; },
  };
  class MutationObserver { observe() {} }
  const sandbox = {
    process: { env: { UI_CONTROL_COVERAGE: '1' } },
    URL,
    Buffer,
    Element: FakeElement,
    MutationObserver,
    document,
    location: { origin: 'https://map.example' },
    setTimeout,
    queueMicrotask,
    getComputedStyle: () => ({ visibility: 'visible', pointerEvents: 'auto' }),
  };
  sandbox.window = sandbox;
  sandbox.__recordUiControl = event => events.push(event);

  let initScript;
  let initArg;
  const context = {
    async exposeBinding() {},
    async addInitScript(fn, arg) { initScript = fn; initArg = arg; },
  };
  let source = fs.readFileSync(new URL('../helpers/control-coverage.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import \{ BrowserContext, TestInfo \} from '@playwright\/test';\s*/m, '')
    .replace('export async function recordControlCoverage', 'globalThis.recordControlCoverage = async function recordControlCoverage');
  vm.runInNewContext(source, sandbox, { filename: 'control-coverage.ts' });
  const testInfo = { project: { use: { baseURL: 'https://map.example/' } }, async attach() {} };
  await sandbox.recordControlCoverage(async watch => watch(context), testInfo, async () => {});
  if (!initScript) throw new Error('Recorder did not install its document initializer');
  Object.assign(sandbox, { document, window: sandbox });
  initScript.call(sandbox, initArg);

  return {
    events,
    button,
    canvas,
    dispatch(type, target, props = {}) { listeners.get(type)?.({ type, target, ...props }); },
  };
}

function pointer(type, target, pointerId, x, y, isTrusted = true) {
  return { target, pointerId, clientX: x, clientY: y, timeStamp: 100, isTrusted };
}

function click(target, pointerId, x, y, isTrusted = true) {
  return { target, pointerId, clientX: x, clientY: y, timeStamp: 101, isTrusted };
}

test('captured pointer tap credits the original source button once after its trusted click', async () => {
  const recorder = await instrumentedRecorder();
  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 7, 20, 20));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 7, 23, 24));
  recorder.dispatch('click', recorder.canvas, click(recorder.canvas, 7, 23, 24));

  const clicks = recorder.events.filter(event => event.kind === 'clicked');
  assert.equal(clicks.length, 1);
  assert.deepEqual(Array.from(clicks[0].sourceIds), ['control-city-label-1']);
});

test('pointerdown alone, drags, cancelled taps, mismatched pointers, and synthetic clicks get no credit', async () => {
  const recorder = await instrumentedRecorder();
  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 1, 10, 10));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 1, 10, 10));
  // No trusted click follows this otherwise valid down/up pair.

  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 2, 10, 10));
  recorder.dispatch('pointermove', recorder.canvas, pointer('pointermove', recorder.canvas, 2, 30, 10));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 2, 30, 10));
  recorder.dispatch('click', recorder.canvas, click(recorder.canvas, 2, 30, 10));

  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 3, 10, 10));
  recorder.dispatch('pointercancel', recorder.canvas, pointer('pointercancel', recorder.canvas, 3, 10, 10));
  recorder.dispatch('click', recorder.canvas, click(recorder.canvas, 3, 10, 10));

  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 4, 10, 10));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 4, 10, 10));
  recorder.dispatch('click', recorder.canvas, click(recorder.canvas, 5, 10, 10));
  recorder.dispatch('click', recorder.button, click(recorder.button, 6, 10, 10, false));

  assert.equal(recorder.events.filter(event => event.kind === 'clicked').length, 0);
});

test('ordinary trusted pointer click on the button is not double-counted', async () => {
  const recorder = await instrumentedRecorder();
  recorder.dispatch('pointerdown', recorder.button, pointer('pointerdown', recorder.button, 9, 20, 20));
  recorder.dispatch('pointerup', recorder.button, pointer('pointerup', recorder.button, 9, 20, 20));
  recorder.dispatch('click', recorder.button, click(recorder.button, 9, 20, 20));

  const clicks = recorder.events.filter(event => event.kind === 'clicked');
  assert.equal(clicks.length, 1);
  assert.deepEqual(Array.from(clicks[0].sourceIds), ['control-city-label-1']);
});

test('styled anchor actions are discovered and clicked; ordinary links are excluded', async () => {
  const actions = ['btn btn-action', 'lens-link-btn', 'wallet-attest-link'].map((className, index) =>
    new FakeElement('a', { class: className, 'data-ui-control': `control-anchor-${index}` }, 'Open'));
  const plain = new FakeElement('a', { class: 'inline-link' }, 'About');
  const recorder = await instrumentedRecorder([...actions, plain]);
  for (const anchor of [...actions, plain]) {
    recorder.dispatch('pointerdown', anchor, pointer('pointerdown', anchor, 4, 20, 20));
    recorder.dispatch('pointerup', anchor, pointer('pointerup', anchor, 4, 20, 20));
    recorder.dispatch('click', anchor, click(anchor, 4, 20, 20));
  }
  assert.equal(recorder.events.filter(event => event.kind === 'observed' && event.tag === 'a').length, 3);
  assert.deepEqual(recorder.events.filter(event => event.kind === 'clicked').map(event => event.sourceIds[0]),
    ['control-anchor-0', 'control-anchor-1', 'control-anchor-2']);
});

test('form coverage requires real value changes and rejects synthetic, disabled and read-only input', async () => {
  const slider = new FakeElement('input', { type: 'range', 'data-ui-control': 'slider', value: '10' });
  const checkbox = new FakeElement('input', { type: 'checkbox', 'data-ui-control': 'checkbox' });
  const select = new FakeElement('select', { 'data-ui-control': 'select', value: 'old' });
  const recorder = await instrumentedRecorder([slider, checkbox, select]);
  slider.value = '20';
  recorder.dispatch('input', slider, { isTrusted: false });
  recorder.dispatch('input', slider, { isTrusted: true });
  checkbox.checked = true;
  recorder.dispatch('change', checkbox, { isTrusted: true });
  select.value = 'new';
  recorder.dispatch('change', select, { isTrusted: true });
  slider.disabled = true;
  recorder.dispatch('input', slider, { isTrusted: true });
  select.readOnly = true;
  recorder.dispatch('change', select, { isTrusted: true });
  const changed = recorder.events.filter(event => event.kind === 'changed');
  assert.deepEqual(changed.map(event => [event.sourceIds[0], event.value, event.method]), [
    ['slider', '20', 'native-input'], ['checkbox', true, 'native-input'], ['select', 'new', 'native-input'],
  ]);
  assert.equal(recorder.events.filter(event => event.kind === 'clicked').length, 0);
});

test('native picker boundary only credits its exact select value and never arbitrary synthetic changes', async () => {
  const select = new FakeElement('select', { 'data-ui-control': 'picker', 'data-ui-native-select-boundary': '18' });
  const input = new FakeElement('input', { 'data-ui-control': 'number', 'data-ui-native-select-boundary': '18' });
  const recorder = await instrumentedRecorder([select, input]);
  select.value = '12';
  recorder.dispatch('change', select, { isTrusted: false });
  input.value = '18';
  recorder.dispatch('change', input, { isTrusted: false });
  select.value = '18';
  recorder.dispatch('input', select, { isTrusted: false });
  recorder.dispatch('change', select, { isTrusted: false });
  const changes = recorder.events.filter(event => event.kind === 'changed');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].value, '18');
  assert.equal(changes[0].method, 'native-select-boundary');
  assert.equal(changes[0].attrs['data-ui-native-select-boundary'], undefined);
});

test('generated checkbox variants retain their associated user-facing labels', async () => {
  const first = new FakeElement('input', { type: 'checkbox', 'data-ui-control': 'surveys' });
  const second = new FakeElement('input', { type: 'checkbox', 'data-ui-control': 'surveys' });
  first.labels = [{ textContent: 'Survey A' }];
  second.labels = [{ textContent: 'Survey B' }];
  const recorder = await instrumentedRecorder([first, second]);
  first.checked = second.checked = true;
  recorder.dispatch('change', first, { isTrusted: true });
  recorder.dispatch('change', second, { isTrusted: true });
  assert.deepEqual(recorder.events.filter(event => event.kind === 'changed').map(event => event.label), ['Survey A', 'Survey B']);
});

test('file chooser data is recorded as an explicit OS boundary without crediting empty selections', async () => {
  const file = new FakeElement('input', { type: 'file', 'data-ui-control': 'upload' });
  const recorder = await instrumentedRecorder([file]);
  file.files = [];
  recorder.dispatch('change', file, { isTrusted: false });
  file.files = [{ name: 'building.glb' }];
  recorder.dispatch('change', file, { isTrusted: false });
  const changed = recorder.events.filter(event => event.kind === 'changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].method, 'file-chooser-boundary');
  assert.deepEqual(Array.from(changed[0].value), ['building.glb']);
});

test('native date/time picker boundary requires the exact marked datetime input value', async () => {
  const attrs = { 'data-ui-control': 'date-picker', 'data-ui-native-datetime-boundary': '2035-06-15T14:30' };
  const picker = new FakeElement('input', { ...attrs, type: 'datetime-local' });
  const text = new FakeElement('input', { ...attrs, type: 'text' });
  const recorder = await instrumentedRecorder([picker, text]);
  picker.value = '2035-06-15T14:29';
  recorder.dispatch('change', picker, { isTrusted: false });
  picker.value = text.value = '2035-06-15T14:30';
  recorder.dispatch('input', picker, { isTrusted: false });
  recorder.dispatch('change', text, { isTrusted: false });
  recorder.dispatch('change', picker, { isTrusted: false });
  const changes = recorder.events.filter(event => event.kind === 'changed');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].method, 'native-datetime-boundary');
  assert.equal(changes[0].value, '2035-06-15T14:30');
  assert.equal(changes[0].attrs['data-ui-native-datetime-boundary'], undefined);
});

test('the native date/time picker boundary also covers a date input', async () => {
  const picker = new FakeElement('input', { 'data-ui-control': 'deadline', 'data-ui-native-datetime-boundary': '2035-06-15', type: 'date' });
  const recorder = await instrumentedRecorder([picker]);
  picker.value = '2035-06-15';
  recorder.dispatch('change', picker, { isTrusted: false });
  const changes = recorder.events.filter(event => event.kind === 'changed');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].method, 'native-datetime-boundary');
  assert.equal(changes[0].value, '2035-06-15');
});

test('custom sliders require a changed ARIA value after trusted keyboard or pointer input', async () => {
  const slider = new FakeElement('div', { 'data-ui-control': 'divider', role: 'slider', 'aria-valuenow': '50' });
  const recorder = await instrumentedRecorder([slider]);
  recorder.dispatch('keydown', slider, { isTrusted: false, key: 'ArrowRight' });
  slider._attrs.set('aria-valuenow', '52');
  await Promise.resolve();
  recorder.dispatch('keydown', slider, { isTrusted: true, key: 'ArrowRight' });
  slider._attrs.set('aria-valuenow', '54');
  await Promise.resolve();
  recorder.dispatch('keydown', slider, { isTrusted: true, key: 'Tab' });
  await Promise.resolve();
  recorder.dispatch('pointerdown', slider, pointer('pointerdown', slider, 9, 10, 10));
  slider._attrs.set('aria-valuenow', '70');
  recorder.dispatch('pointerup', slider, pointer('pointerup', slider, 9, 50, 10));
  await Promise.resolve();
  assert.deepEqual(recorder.events.filter(event => event.kind === 'changed').map(event => [event.value, event.method]), [
    ['54', 'native-slider-key'], ['70', 'native-slider-pointer'],
  ]);
});

test('blockify gap and wing handles record changed positions after trusted pointer drags', async () => {
  for (const kind of ['gap', 'wing']) {
    const handle = new FakeElement('div', { class: `blockify-handle blockify-handle--${kind}` });
    const recorder = await instrumentedRecorder([handle]);
    recorder.dispatch('pointerdown', handle, pointer('pointerdown', handle, 31, 10, 10));
    handle.setPosition(42, 57);
    recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 31, 42, 57));

    const drags = recorder.events.filter(event => event.kind === 'changed');
    assert.equal(drags.length, 1);
    assert.equal(drags[0].interaction, 'change');
    assert.equal(drags[0].controlType, 'drag');
    assert.equal(drags[0].method, 'native-pointer-drag');
    assert.deepEqual({ ...drags[0].value }, { left: 42, top: 57 });
    assert.equal(recorder.events.some(event => event.kind === 'observed' && event.controlType === 'drag'), true);
  }
});

test('blockify handles do not earn drag coverage without actual movement', async () => {
  const handle = new FakeElement('div', { class: 'blockify-handle blockify-handle--gap' });
  const recorder = await instrumentedRecorder([handle]);
  recorder.dispatch('pointerdown', handle, pointer('pointerdown', handle, 32, 10, 10));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 32, 10, 10));

  assert.equal(recorder.events.filter(event => event.kind === 'changed').length, 0);
});

test('blockify handle pointer cancellation discards movement without drag coverage', async () => {
  const handle = new FakeElement('div', { class: 'blockify-handle blockify-handle--wing' });
  const recorder = await instrumentedRecorder([handle]);
  recorder.dispatch('pointerdown', handle, pointer('pointerdown', handle, 33, 10, 10));
  handle.setPosition(42, 57);
  recorder.dispatch('pointercancel', recorder.canvas, pointer('pointercancel', recorder.canvas, 33, 42, 57));
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 33, 42, 57));

  assert.equal(recorder.events.filter(event => event.kind === 'changed').length, 0);
});

test('synthetic movement and clicks on blockify handles never earn drag or click coverage', async () => {
  const handle = new FakeElement('div', { class: 'blockify-handle blockify-handle--gap' });
  const recorder = await instrumentedRecorder([handle]);
  recorder.dispatch('pointerdown', handle, pointer('pointerdown', handle, 34, 10, 10, false));
  handle.setPosition(42, 57);
  recorder.dispatch('pointerup', recorder.canvas, pointer('pointerup', recorder.canvas, 34, 42, 57, false));
  recorder.dispatch('click', handle, click(handle, 34, 42, 57, false));
  // Even a trusted click on this drag-only handle has no button behavior to cover.
  recorder.dispatch('click', handle, click(handle, -1, 42, 57, true));

  assert.equal(recorder.events.filter(event => ['changed', 'clicked'].includes(event.kind)).length, 0);
});
