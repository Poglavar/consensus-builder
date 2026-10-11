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
    this._attrs = new Map(Object.entries(attrs));
    this.attributes = [...this._attrs].map(([name, value]) => ({ name, value }));
    this.classList = new Set((this.getAttribute('class') || '').split(/\s+/));
    this.classList.contains = name => this.classList.has(name);
  }

  closest(selector) {
    return (/button/.test(selector) && this.tagName === 'BUTTON') || (/\ba\b/.test(selector) && this.tagName === 'A') ? this : null;
  }

  getAttribute(name) { return this._attrs.get(name) ?? null; }
  hasAttribute(name) { return this._attrs.has(name); }
  getBoundingClientRect() { return { width: 48, height: 24 }; }
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
