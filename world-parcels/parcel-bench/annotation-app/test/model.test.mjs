import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeState, saveLocal, acknowledge, acceptRemote, resolveConflict, validateReview, taskList } from '../public/model.mjs';
const batch = { samples: [{ id: 's', width: 100, height: 100 }], tasks: [{ id: 'pair', sample_id: 's', a: [10, 10], b: [20, 20] }] };
const review = { id: 'pair', sample_id: 's', a: [10, 10], b: [20, 20], relation: 'separate', trace: [], note: '' };
test('rejects null, out of bounds, identical anchors, and unfinished traces', () => {
  for (const a of [[null, 10], [0, 10], [100, 10], [NaN, 10], [20, 20]]) assert.throws(() => validateReview({ ...review, a }, batch));
  assert.throws(() => validateReview({ ...review, trace: [[10, 10]] }, batch));
  assert.throws(() => validateReview({ ...review, sample_id: 'unknown' }, batch));
});
test('a network acknowledgement preserves a newer edit saved during the request', () => {
  const initial = saveLocal(makeState(batch), review, 'first');
  const newer = saveLocal(initial, { ...review, relation: 'unclear' }, 'second');
  const acknowledged = acknowledge(newer, initial.entries.pair, { id: 'pair', revision: 1, value: review });
  assert.equal(acknowledged.entries.pair.value.relation, 'unclear');
  assert.equal(acknowledged.entries.pair.revision, 1);
  assert.equal(acknowledged.entries.pair.dirty, true);
});
test('remote conflicts retain the local judgment until explicit resolution', () => {
  const local = saveLocal(makeState(batch), review, 'first');
  const remote = { id: 'pair', revision: 2, mutation_id: 'remote', value: { ...review, relation: 'same_surface' } };
  const conflicted = acceptRemote(local, [remote]);
  assert.equal(conflicted.entries.pair.value.relation, 'separate');
  assert.equal(conflicted.entries.pair.conflict, remote);
  const keep = resolveConflict(conflicted, 'pair', true, 'new');
  assert.equal(keep.entries.pair.revision, 2); assert.equal(keep.entries.pair.dirty, true);
  const take = resolveConflict(conflicted, 'pair', false, 'new');
  assert.equal(take.entries.pair.value.relation, 'same_surface'); assert.equal(take.entries.pair.dirty, false);
});
test('a lost acknowledgement can retry its own mutation without a false conflict', () => {
  const local = saveLocal(makeState(batch), review, 'first');
  const remote = { id: 'pair', revision: 1, mutation_id: 'first', value: review };
  const refreshed = acceptRemote(local, [remote]);
  assert.equal(refreshed.entries.pair.conflict, undefined);
  assert.equal(acknowledge(refreshed, local.entries.pair, remote).entries.pair.dirty, false);
});
test('custom pairs discovered on another device appear in navigation', () => {
  const id = 'custom_21e3e68b-55f3-4ac9-ad80-03ad4bfe61a4';
  const value = validateReview({ ...review, id }, batch);
  const state = acceptRemote(makeState(batch), [{ id, revision: 1, value }]);
  assert.equal(taskList(state).length, 2);
});
