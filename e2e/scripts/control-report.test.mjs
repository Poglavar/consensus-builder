// A failed spec or an observed-but-unclicked button must never count as browser click coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeControlCoverage, checkControlCoverage, checkExemptionGuards } from '../helpers/control-report.mjs';

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
  assert.ok(errors.some(error => error.includes('Button removed')));
  assert.ok(errors.some(error => error.includes('New button')));
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
  assert.ok(errors.some(error => error.includes('Unattributed button') && error.includes('Locate me')));
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
