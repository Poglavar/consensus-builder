// Check that coverage identities include dynamic buttons and preserve their actual JavaScript.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { instrumentControls } from '../helpers/control-source.mjs';

test('literal, interpolated and concatenated buttons keep their handlers and content', () => {
  const source = `const label = 'Open'; const id = 'details';
    const a = '<button onclick="openDetails()">Open</button>';
    const b = \`<button id="\${id}" class="\${label.toLowerCase()}">\${label}</button>\`;
    const c = '<button id="' + id + '">Close</button>';
    globalThis.output = [a, b, c];`;
  const instrumented = instrumentControls(source, 'js/example.js');
  assert.equal(instrumented.sites.length, 3);
  const original = {}, candidate = {};
  vm.runInNewContext(source, original);
  vm.runInNewContext(instrumented.code, candidate);
  assert.deepEqual(Array.from(candidate.output, item => item.replace(/ data-ui-control=control-[\w-]+/g, '')), Array.from(original.output));
});

test('factory instrumentation returns the real button and preserves its caller context', () => {
  const source = `globalThis.output = document.createElement('button'); output.label = 'Close';`;
  const real = { setAttribute(name, value) { this[name] = value; } };
  const context = { document: { createElement(tag) { assert.equal(tag, 'button'); return real; } } };
  const instrumented = instrumentControls(source, 'js/factory.js');
  vm.runInNewContext(instrumented.code, context);
  assert.equal(instrumented.sites.length, 1);
  assert.equal(context.output, real);
  assert.equal(real.label, 'Close');
  assert.equal(real['data-ui-control'], instrumented.sites[0].id);
});

test('comments and import maps are not controls; duplicate real buttons receive separate identities', () => {
  const source = `<!-- <button>obsolete</button> -->
    <script type="importmap">{"imports":{"three":"/three.js"}}</script>
    <script>// document.createElement('button');\nconst title = 'Ready';</script>
    <button class="close">Close</button><button class="close">Close</button>`;
  const instrumented = instrumentControls(source, 'index.html');
  assert.equal(instrumented.sites.length, 2);
  assert.notEqual(instrumented.sites[0].id, instrumented.sites[1].id);
  assert.deepEqual(instrumentControls('\n\n' + source, 'index.html').sites.map(site => site.id), instrumented.sites.map(site => site.id));
});

test('runtime button roles and generic factories preserve the real element and return value', () => {
  const source = `const tag = 'tr'; const row = document.createElement(tag);
    const before = row; globalThis.result = row.setAttribute('role', 'button'); globalThis.row = row;`;
  const context = { document: { createElement(tag) { return { tagName: tag.toUpperCase(), getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } }; } } };
  const instrumented = instrumentControls(source, 'js/rows.mjs');
  vm.runInNewContext(instrumented.code, context);
  assert.equal(context.result, undefined);
  assert.equal(context.row.role, 'button');
  assert.equal(context.row['data-ui-control'], instrumented.sites.map(site => site.id).join(' '));
  assert.equal(instrumented.sites.length, 2);
  assert.equal(instrumented.sites[0].interaction, 'auto');
});

test('button-styled anchor markup is inventoried while ordinary links remain links', () => {
  const source = `const markup = '<a href="/one" class="btn btn-action">Share</a><a href="/two" class="lens-link-btn">Explorer</a><a href="/about">About</a>'; globalThis.output = markup;`;
  const instrumented = instrumentControls(source, 'js/links.js');
  assert.equal(instrumented.sites.length, 2);
  const original = {}, candidate = {};
  vm.runInNewContext(source, original);
  vm.runInNewContext(instrumented.code, candidate);
  assert.equal(candidate.output.replace(/ data-ui-control=control-[\w-]+/g, ''), original.output);
});

test('button-styled anchor factories are identified by classes in their own block', () => {
  const source = `const link = document.createElement('a'); link.href = '/explorer'; link.className = 'btn btn-secondary'; globalThis.output = link;
    function ordinaryLink() { const link = document.createElement('a'); link.className = 'inline-link'; return link; } globalThis.plain = ordinaryLink();`;
  const instrumented = instrumentControls(source, 'js/anchor-factory.js');
  assert.equal(instrumented.sites.length, 1);
  const context = { document: { createElement(tag) { return { tagName: tag, setAttribute(name, value) { this[name] = value; } }; } } };
  vm.runInNewContext(instrumented.code, context);
  assert.equal(context.output.href, '/explorer');
  assert.equal(context.output.className, 'btn btn-secondary');
  assert.equal(context.output['data-ui-control'], instrumented.sites[0].id);
  assert.equal(context.plain['data-ui-control'], undefined);
});

test('icon action anchors created by assignment retain their source identity', () => {
  const source = `let action; if (!action) { action = document.createElement('a'); action.className = 'wallet-attest-link'; } globalThis.output = action;`;
  const instrumented = instrumentControls(source, 'js/icon-action.js');
  assert.equal(instrumented.sites.length, 1);
  const context = { document: { createElement() { return { setAttribute(name, value) { this[name] = value; } }; } } };
  vm.runInNewContext(instrumented.code, context);
  assert.equal(context.output['data-ui-control'], instrumented.sites[0].id);
});

test('inputs, selects and textareas retain their HTML and receive value-change identities', () => {
  const source = `const html = '<input type="range" id="height"><input type="checkbox" id="traffic"><select id="mode"><option>A</option></select><textarea id="notes"></textarea><input type="hidden" id="internal">'; globalThis.output = html;`;
  const instrumented = instrumentControls(source, 'js/fields.js');
  assert.equal(instrumented.sites.length, 4);
  assert.deepEqual(instrumented.sites.map(site => [site.interaction, site.controlType]), [
    ['change', 'range'], ['change', 'checkbox'], ['change', 'select'], ['change', 'textarea'],
  ]);
  const original = {}, candidate = {};
  vm.runInNewContext(source, original);
  vm.runInNewContext(instrumented.code, candidate);
  assert.equal(candidate.output.replace(/ data-ui-control=control-[\w-]+/g, ''), original.output);
});

test('native field factories retain their object identity and later type assignments', () => {
  const source = `const slider = document.createElement('input'); slider.type = 'range'; globalThis.output = slider;`;
  const instrumented = instrumentControls(source, 'js/field-factory.js');
  const field = { setAttribute(name, value) { this[name] = value; } };
  const context = { document: { createElement() { return field; } } };
  vm.runInNewContext(instrumented.code, context);
  assert.equal(instrumented.sites.length, 1);
  assert.equal(instrumented.sites[0].interaction, 'change');
  assert.equal(context.output, field);
  assert.equal(field.type, 'range');
  assert.equal(field['data-ui-control'], instrumented.sites[0].id);
});

test('ARIA sliders retain their role and require value-change coverage', () => {
  const source = `const slider = document.createElement('div'); slider.setAttribute('role', 'slider'); globalThis.output = slider;`;
  const instrumented = instrumentControls(source, 'js/slider.js');
  const real = { getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } };
  const context = { document: { createElement() { return real; } } };
  vm.runInNewContext(instrumented.code, context);
  assert.equal(instrumented.sites.length, 1);
  assert.equal(instrumented.sites[0].interaction, 'change');
  assert.equal(instrumented.sites[0].controlType, 'slider');
  assert.equal(real.role, 'slider');
  assert.equal(context.output, real);
});
