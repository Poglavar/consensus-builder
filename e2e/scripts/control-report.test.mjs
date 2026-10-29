// A failed spec or an observed-but-unclicked button must never count as browser click coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readControlResults, summarizeControlCoverage, checkControlCoverage, checkExemptionGuards, controlReportFromLedger } from '../helpers/control-report.mjs';

test('only clicks from passing tests cover a source site', () => {
  const sites = ['passed', 'failed', 'observed', 'never-rendered'].map(id => ({ id, source: 'example.js' }));
  const event = (sourceId, kind = 'clicked') => ({ sourceId, kind, label: sourceId, attrs: {} });
  const summary = summarizeControlCoverage(sites, [
    { key: 'green', status: 'passed', events: [event('passed'), event('observed', 'observed')] },
    { key: 'red', status: 'failed', events: [event('failed')] },
  ]);
  assert.equal(summary.counts.clicked, 1);
  assert.deepEqual(summary.uncovered.map(control => control.id), ['failed', 'observed', 'never-rendered']);
  assert.deepEqual(summary.controls[0].clicks, ['green']);
});

test('a role assigned to a factory element records both source identities', () => {
  const sites = ['factory', 'role'].map(id => ({ id, source: 'rows.js' }));
  const summary = summarizeControlCoverage(sites, [{ key: 'row opens details', status: 'passed', events: [
    { sourceIds: ['factory', 'role'], kind: 'clicked', label: 'Transaction', attrs: {} }
  ] }]);
  assert.equal(summary.counts.clicked, 2);
});

test('clicking a field cannot replace a passing value-change assertion', () => {
  const sites = ['changed', 'clicked', 'failed'].map(id => ({ id, source: 'fields.js', interaction: 'change' }));
  const event = (sourceId, kind) => ({ sourceId, kind, label: sourceId, attrs: { type: 'range' } });
  const summary = summarizeControlCoverage(sites, [
    { key: 'green', status: 'passed', events: [event('changed', 'changed'), event('clicked', 'clicked')] },
    { key: 'red', status: 'failed', events: [event('failed', 'changed')] },
  ]);
  assert.equal(summary.counts.changed, 1);
  assert.equal(summary.counts.clicked, 0);
  assert.deepEqual(summary.controls[0].changes, ['green']);
  assert.deepEqual(summary.uncovered.map(control => control.id), ['clicked', 'failed']);
  assert.ok(checkControlCoverage(summary, { controls: sites }).some(error => error.includes('No passing change: fields.js:undefined clicked')));
});

test('a generic factory tracks buttons and fields as distinct interaction variants', () => {
  const site = { id: 'factory', source: 'form.js', interaction: 'auto' };
  const events = [
    { sourceId: 'factory', kind: 'clicked', interaction: 'click', label: 'Save', attrs: { class: 'save' } },
    { sourceId: 'factory', kind: 'clicked', interaction: 'change', label: 'Name', attrs: { name: 'name' } },
    { sourceId: 'factory', kind: 'changed', interaction: 'change', label: 'Height', attrs: { name: 'height' } },
  ];
  const summary = summarizeControlCoverage([site], [{ key: 'form', status: 'passed', events }]);
  assert.equal(summary.counts.clicked, 1);
  assert.equal(summary.counts.changed, 1);
  assert.equal(summary.controls[0].variants[1].interactions.length, 0);
  const errors = checkControlCoverage(summary, { controls: [{ ...site, variants: [
    { name: 'name field', interaction: 'change', attrs: { name: 'name' } },
    { name: 'height field', interaction: 'change', attrs: { name: 'height' } },
    { name: 'save button', interaction: 'click', classes: ['save'] },
  ] }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name field/);
});

test('an excluded control must remain unreachable and its source guard unchanged', () => {
  const contract = { controls: [{ id: 'legacy', source: 'legacy.js', exempt: 'The modal has no callers', mustRemainInactive: true,
    guards: [{ pattern: '\\bopenLegacy\\b', occurrences: 1 }] }] };
  const summary = summarizeControlCoverage([{ id: 'legacy', source: 'legacy.js' }], [{ key: 'boot', status: 'passed', events: [
    { sourceId: 'legacy', kind: 'observed', label: 'Close', attrs: {} }
  ] }]);
  assert.match(checkControlCoverage(summary, contract).join('\n'), /became reachable/);
  assert.equal(checkExemptionGuards(contract, new Map([['legacy.js', 'function openLegacy() {}']])).length, 0);
  assert.match(checkExemptionGuards(contract, new Map([['legacy.js', 'function openLegacy() {}'], ['app.js', 'openLegacy()']])).join('\n'), /references changed/);
});

test('the gate rejects deleted buttons, new buttons, failed tests and unclicked factory actions', () => {
  const sites = [{ id: 'factory', source: 'menu.js', line: 1 }, { id: 'new', source: 'menu.js', line: 2 }];
  const summary = summarizeControlCoverage(sites, [{ key: 'menu opens', status: 'passed', events: [
    { sourceId: 'factory', kind: 'clicked', label: 'Open', attrs: { class: 'menu-open' } },
    { sourceId: 'factory', kind: 'observed', label: 'Delete', attrs: { class: 'menu-delete' } },
  ] }]);
  const errors = checkControlCoverage(summary, { controls: [
    { id: 'factory', source: 'menu.js', variants: [{ name: 'delete action', classes: ['menu-delete'] }] },
    { id: 'deleted', source: 'menu.js' },
  ] });
  assert.equal(errors.length, 4);
  assert.ok(errors.some(error => error.includes('delete action')));
  assert.ok(errors.some(error => error.includes('Control removed')));
  assert.ok(errors.some(error => error.includes('New control')));
  const failed = summarizeControlCoverage([], [{ key: 'broken', status: 'failed', events: [] }]);
  assert.deepEqual(checkControlCoverage(failed, { controls: [] }), ['Test failed: broken']);
});

test('closed action domains and runtime controls cannot acquire an unreviewed button', () => {
  const summary = summarizeControlCoverage([{ id: 'menu', source: 'menu.js' }], [{ key: 'buttons work', status: 'passed', events: [
    { sourceId: 'menu', kind: 'clicked', label: 'Open', attrs: { 'data-command': 'open' } },
    { sourceId: 'menu', kind: 'observed', label: 'Delete', attrs: { 'data-command': 'delete' } },
    { kind: 'clicked', label: 'Zoom in', attrs: { class: 'leaflet-control-zoom-in' } },
    { kind: 'observed', label: 'Locate me', attrs: { class: 'leaflet-control-locate' } },
  ] }]);
  const errors = checkControlCoverage(summary, {
    controls: [{ id: 'menu', exhaustiveVariants: true, variants: [{ name: 'open', attrs: { 'data-command': 'open' } }] }],
    checkRuntimeControls: true,
    runtimeControls: [{ name: 'zoom in', classes: ['leaflet-control-zoom-in'] }, { name: 'zoom out', classes: ['leaflet-control-zoom-out'] }],
  });
  assert.equal(errors.length, 3);
  assert.ok(errors.some(error => error.includes('Unreviewed action variant') && error.includes('Delete')));
  assert.ok(errors.some(error => error.includes('No passing click for runtime button: zoom out')));
  assert.ok(errors.some(error => error.includes('Unattributed control') && error.includes('Locate me')));
});

test('exclusions require a checked source condition', () => {
  assert.deepEqual(checkExemptionGuards({ controls: [{ id: 'dead', exempt: 'Unused modal' }] }, new Map()), [
    'Missing source guard for exemption: dead',
  ]);
});

test('dead variants become required when an orphan action helper gains a caller', () => {
  const contract = { controls: [], variantExclusions: [{ name: 'unused share actions',
    guards: [{ pattern: '\\bshowOldShare\\b', occurrences: 1 }] }] };
  const sources = new Map([['share.js', 'function showOldShare() {}']]);
  assert.deepEqual(checkExemptionGuards(contract, sources), []);
  sources.set('menu.js', 'button.onclick = showOldShare;');
  assert.match(checkExemptionGuards(contract, sources).join('\n'), /unused share actions/);
});


test('result parsing retains runtime skip evidence without inventing a passing outcome', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'control-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'results.json');
  fs.writeFileSync(filename, JSON.stringify({ suites: [{ title: 'optional external work', specs: [{
    file: 'tests/external.spec.ts', title: 'sends an external transaction', line: 10,
    tests: [{ projectName: 'chromium', expectedStatus: 'skipped', status: 'skipped', annotations: [],
      results: [{ status: 'skipped', duration: 2, annotations: [{ type: 'skip', description: 'set EXTERNAL_TEST=1' }] }]
    }]
  }] }] }));
  const [record] = readControlResults([filename]);
  assert.equal(record.status, 'skipped');
  assert.equal(record.expectedStatus, 'skipped');
  assert.equal(record.outcome, 'skipped');
  assert.equal(record.projectName, 'chromium');
  assert.deepEqual(record.annotations, [{ type: 'skip', description: 'set EXTERNAL_TEST=1' }]);
});

test('only a declared opt-in skip is accepted and it never covers a button', () => {
  const rule = { file: 'tests/external.spec.ts', title: 'sends an external transaction',
    projectName: 'chromium', skipReason: 'set EXTERNAL_TEST=1' };
  const skipped = { ...rule, key: 'external transaction', status: 'skipped', expectedStatus: 'skipped',
    outcome: 'skipped', annotations: [{ type: 'skip', description: rule.skipReason }], events: [] };
  const contract = { controls: [], allowedSkips: [rule] };
  const summary = summarizeControlCoverage([], [skipped]);
  assert.equal(summary.counts.skipped, 1);
  assert.equal(summary.counts.passed, 0);
  assert.deepEqual(checkControlCoverage(summary, contract), []);
  assert.deepEqual(checkControlCoverage(summary, { controls: [] }), ['Test skipped: external transaction']);

  for (const change of [
    { file: 'tests/another.spec.ts' }, { title: 'another transaction' }, { projectName: 'another-browser' },
    { status: 'failed' }, { status: 'not-run' }, { expectedStatus: 'passed' }, { outcome: 'unexpected' },
    { annotations: [] }, { annotations: [{ type: 'skip', description: 'some other reason' }] },
  ]) {
    const rejected = summarizeControlCoverage([], [{ ...skipped, ...change }]);
    assert.equal(checkControlCoverage(rejected, contract).length, 1, JSON.stringify(change));
  }

  const sites = [{ id: 'send', source: 'external.js', line: 1 }];
  const clickedBeforeSkip = summarizeControlCoverage(sites, [{ ...skipped, events: [
    { sourceId: 'send', kind: 'clicked', label: 'Send', attrs: {} }
  ] }]);
  assert.equal(clickedBeforeSkip.counts.clicked, 0);
  assert.deepEqual(checkControlCoverage(clickedBeforeSkip, { ...contract, controls: sites }), [
    'No passing click: external.js:1 send',
  ]);
});

test('a continued controls run reads back from its ledger like a JSON report, latest result per test', () => {
  const entry = (status, outcome, events) => ({
    id: '[chromium] › menu.spec.ts:4:3 › menu › opens', project: 'chromium', file: 'menu.spec.ts', line: 4, column: 3,
    titles: ['menu', 'opens'], status, outcome, durationMs: 120, expectedStatus: 'passed',
    annotations: [{ type: 'issue', description: 'x' }], controlEvents: events,
  });
  const clicked = [{ sourceId: 'menu-button', kind: 'clicked', label: 'Menu', attrs: {} }];
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'control-ledger-')), 'results.json');
  fs.writeFileSync(filename, JSON.stringify(controlReportFromLedger([entry('failed', 'unexpected', []), entry('passed', 'expected', clicked)])));
  assert.deepEqual(readControlResults([filename]), [{
    key: 'menu.spec.ts › chromium › menu.spec.ts › menu › opens', title: 'opens', file: 'menu.spec.ts', line: 4,
    status: 'passed', duration: 120, events: clicked, projectName: 'chromium', expectedStatus: 'passed',
    outcome: 'expected', annotations: [{ type: 'issue', description: 'x' }],
  }]);
});
