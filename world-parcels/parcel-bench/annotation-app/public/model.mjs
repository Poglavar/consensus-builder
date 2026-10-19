export const SCHEMA = 'plot-review-batch-v1';
export const REVIEW_SCHEMA = 'plot-review-export-v1';
const idPattern = /^[A-Za-z0-9_-]{1,120}$/;
export const validId = value => typeof value === 'string' && idPattern.test(value);
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export function invariant(ok, message) { if (!ok) throw new Error(message); }
export function validPoint(point, sample) {
  return Array.isArray(point) && point.length === 2 && point.every(finite)
    && point[0] > 0 && point[0] < sample.width && point[1] > 0 && point[1] < sample.height;
}
export function validateBatch(batch) {
  invariant(batch?.schema === SCHEMA && validId(batch.id), 'Invalid batch schema or id');
  invariant(/^[a-f0-9]{64}$/.test(batch.batch_hash), 'Missing batch hash');
  invariant(Array.isArray(batch.samples) && batch.samples.length > 0, 'Empty batch');
  const ids = new Set();
  for (const sample of batch.samples) {
    invariant(validId(sample.id) && !ids.has(sample.id), 'Invalid or duplicate sample id');
    ids.add(sample.id);
    invariant(Number.isInteger(sample.width) && sample.width > 0 && Number.isInteger(sample.height) && sample.height > 0, 'Invalid image dimensions');
    invariant(Array.isArray(sample.bbox) && sample.bbox.length === 4 && sample.bbox.every(finite) && sample.bbox[2] > sample.bbox[0] && sample.bbox[3] > sample.bbox[1], 'Invalid metric extent');
    invariant(/^EPSG:\d+$/.test(sample.crs), 'Missing sample CRS');
    invariant(/^[a-f0-9]{64}$/.test(sample.image_sha256) && sample.image === `images/${sample.id}.jpg`, 'Invalid image binding');
    invariant(typeof sample.title === 'string' && typeof sample.attribution === 'string' && typeof sample.license === 'string', 'Missing imagery provenance');
  }
  invariant(Array.isArray(batch.tasks) && batch.tasks.length > 0, 'Empty tasks');
  const tasks = new Set();
  for (const task of batch.tasks) {
    invariant(validId(task.id) && !tasks.has(task.id) && ids.has(task.sample_id), 'Invalid task identity');
    tasks.add(task.id);
    const sample = batch.samples.find(s => s.id === task.sample_id);
    invariant((task.a === null && task.b === null) || (validPoint(task.a, sample) && validPoint(task.b, sample) && JSON.stringify(task.a) !== JSON.stringify(task.b)), 'Invalid suggested anchors');
  }
  return batch;
}
export function validateReview(value, batch) {
  invariant(value && validId(value.id), 'Invalid review id');
  const sample = batch.samples.find(s => s.id === value.sample_id);
  invariant(sample, 'Unknown image');
  const task = batch.tasks.find(t => t.id === value.id);
  invariant(task ? task.sample_id === value.sample_id : /^custom_[a-f0-9-]{36}$/.test(value.id), 'Review must belong to its task');
  invariant(['separate', 'same_surface', 'unclear'].includes(value.relation), 'Choose a relation');
  invariant(validPoint(value.a, sample) && validPoint(value.b, sample) && JSON.stringify(value.a) !== JSON.stringify(value.b), 'Place two distinct points inside the image');
  invariant(Array.isArray(value.trace) && value.trace.length <= 400 && value.trace.every(p => validPoint(p, sample)) && value.trace.length !== 1, 'A trace needs at least two points');
  invariant(typeof value.note === 'string' && value.note.length <= 1000, 'Note is too long');
  return { id: value.id, sample_id: value.sample_id, a: [...value.a], b: [...value.b], relation: value.relation, trace: value.trace.map(p => [...p]), note: value.note.trim() };
}
export function makeState(batch) {
  return { batch, entries: {}, customTasks: [], index: 0 };
}
export function saveLocal(state, value, mutationId) {
  const review = validateReview(value, state.batch);
  const previous = state.entries[review.id];
  return { ...state, entries: { ...state.entries, [review.id]: {
    ...previous, value: review, revision: previous?.revision || 0, dirty: true, mutationId,
  } } };
}
export function acceptRemote(state, records) {
  const entries = { ...state.entries };
  for (const record of records) {
    const local = entries[record.id];
    if (!local?.dirty) entries[record.id] = { value: record.value, revision: record.revision, dirty: false };
    else if (record.revision > local.revision && record.mutation_id !== local.mutationId)
      entries[record.id] = { ...local, conflict: record };
  }
  return { ...state, entries };
}
export function acknowledge(state, sent, record) {
  const local = state.entries[record.id];
  if (!local) return state;
  // A new local edit may have been saved while this network request was in flight.
  const entry = local.mutationId === sent.mutationId
    ? { value: record.value, revision: record.revision, dirty: false }
    : { ...local, revision: record.revision, conflict: undefined };
  return { ...state, entries: { ...state.entries, [record.id]: entry } };
}
export function resolveConflict(state, id, keepLocal, mutationId) {
  const entry = state.entries[id];
  invariant(entry?.conflict, 'No conflict to resolve');
  const remote = entry.conflict;
  return { ...state, entries: { ...state.entries, [id]: keepLocal
    ? { value: entry.value, revision: remote.revision, dirty: true, mutationId }
    : { value: remote.value, revision: remote.revision, dirty: false } } };
}
export function taskList(state) {
  const tasks = [...state.batch.tasks, ...state.customTasks];
  const ids = new Set(tasks.map(t => t.id));
  for (const { value } of Object.values(state.entries)) if (!ids.has(value.id)) {
    tasks.push({ id: value.id, sample_id: value.sample_id, a: value.a, b: value.b });
    ids.add(value.id);
  }
  return tasks;
}
export function exportLocal(state) {
  return { schema: REVIEW_SCHEMA, batch_hash: state.batch.batch_hash, batch: state.batch,
    exported_at: new Date().toISOString(), origin: 'phone-backup',
    reviews: Object.entries(state.entries).map(([id, entry]) => ({ id, revision: entry.revision, value: entry.value, pending_sync: entry.dirty, conflict: entry.conflict || null })) };
}
