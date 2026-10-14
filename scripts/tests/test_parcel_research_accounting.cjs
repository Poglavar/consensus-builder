'use strict';
// Verify subscription usage receipts and model selection without provider calls or real ledger writes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const helper = require('../lib/parcel-research-accounting.cjs');
const sharedCli = helper.loadShared().cli;

const completed = JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 9,
} });

function harness(root, price = 0.42) {
  const rows = [];
  const shared = {
    cli: sharedCli,
    cost: {
      LEDGER: path.join(root, 'fake-ledger.jsonl'),
      resolveModel: (model) => model,
      computeCost: () => {
        if (price instanceof Error) throw price;
        return price;
      },
      recordSubscriptionRun: (entry) => {
        const row = {
          ts: '2026-10-14T00:00:00.000Z', repo: entry.repo, script: entry.script,
          model: entry.model, billing: 'subscription', cost_usd: 0,
          equivalent_usd: entry.equivalentUsd,
          input_tokens: entry.usage.input_tokens, output_tokens: entry.usage.output_tokens,
          cache_creation_input_tokens: entry.usage.cache_creation_input_tokens,
          cache_read_input_tokens: entry.usage.cache_read_input_tokens, ...entry.meta,
        };
        rows.push(row);
        return row;
      },
    },
  };
  const accounting = helper.makeAccounting({
    shared,
    findExisting: async (_ledger, callId) => rows.find((row) => row.callId === callId) || null,
  });
  return { accounting, rows };
}

function withTemp(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function outputFile(root, callId, content = `${completed}\n`) {
  const dir = path.join(root, callId);
  fs.mkdirSync(dir, { recursive: true });
  const stdoutPath = path.join(dir, 'stdout.jsonl');
  fs.writeFileSync(stdoutPath, content);
  return stdoutPath;
}

function request(stdoutPath, meta = {}) {
  return {
    operation: 'record', billing: 'subscription', stdoutPath,
    model: 'gpt-5.6-luna', repo: 'consensus-builder', script: 'run-valhalla-parcel-research',
    meta: { callId: path.basename(path.dirname(stdoutPath)), jobName: 'africa-top1000', taskId: 'city:42', role: 'research', ...meta },
  };
}

test('environmentKeys returns only shared Codex strip-env names', async (t) => {
  const root = withTemp(t, 'parcel-accounting-env-');
  const { accounting } = harness(root);
  assert.deepEqual(accounting.environmentKeys(), sharedCli.ENGINES.codex.stripEnv);
  const result = await helper.runOperation({ operation: 'environmentKeys' });
  assert.deepEqual(result.environmentKeys, sharedCli.ENGINES.codex.stripEnv);
  assert.ok(!JSON.stringify(result).includes('sk-'));
});

test('records normalized usage and subscription equivalent once with a compact receipt', async (t) => {
  const root = withTemp(t, 'parcel-accounting-record-');
  const stdoutPath = outputFile(root, 'call-001');
  const { accounting, rows } = harness(root);
  const result = await accounting.record(request(stdoutPath));

  assert.equal(result.status, 'recorded');
  assert.equal(result.billing, 'subscription');
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.deepEqual(result.usage, {
    input_tokens: 60, output_tokens: 9, cache_read_input_tokens: 40, cache_creation_input_tokens: 5,
  });
  assert.equal(result.costUsd, 0);
  assert.equal(result.equivalentUsd, 0.42);
  assert.equal(result.priceStatus, 'priced');
  assert.equal(result.ledgerReceipt.callId, 'call-001');
  assert.equal(Object.hasOwn(result, 'prompt'), false);
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].callFingerprint.length, 64);

  assert.equal((await accounting.record(request(stdoutPath))).status, 'already_recorded');
  assert.equal(rows.length, 1);
});

test('uses shared Codex parsing to retain parseable failed-turn usage', async (t) => {
  const root = withTemp(t, 'parcel-accounting-failed-');
  const failed = JSON.stringify({ type: 'turn.failed', usage: {
    input_tokens: 30, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 4,
  }, error: { message: 'provider failed after partial output' } });
  const stdoutPath = outputFile(root, 'call-failed', `${failed}\n`);
  const { accounting } = harness(root);
  const result = await accounting.record(request(stdoutPath));
  assert.deepEqual(result.usage, {
    input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
  });
  assert.equal(result.status, 'recorded');
});

test('refuses changed call IDs or output files', async (t) => {
  const root = withTemp(t, 'parcel-accounting-conflict-');
  const stdoutPath = outputFile(root, 'call-original');
  const { accounting } = harness(root);
  await accounting.record(request(stdoutPath));
  await assert.rejects(accounting.record(request(stdoutPath, { callId: 'call-other' })), /different call or output|callId must match/);
  const alternateOutput = path.join(path.dirname(stdoutPath), 'other.jsonl');
  fs.writeFileSync(alternateOutput, completed + '\n');
  await assert.rejects(accounting.record({ ...request(stdoutPath), stdoutPath: alternateOutput }), /different call or output/);
  await assert.rejects(accounting.record(request(outputFile(root, 'call-original', `${completed}\n{}\n`))), /different/);
  const otherPath = outputFile(root, 'other-directory');
  await assert.rejects(accounting.record({ ...request(otherPath), meta: { ...request(otherPath).meta, callId: 'call-original' } }), /callId must match/);
});

test('does not fabricate usage when JSONL has no usage event', async (t) => {
  const root = withTemp(t, 'parcel-accounting-missing-');
  const stdoutPath = outputFile(root, 'call-no-usage', '{"type":"turn.failed","error":{"message":"stopped"}}\n');
  const { accounting, rows } = harness(root);
  const result = await accounting.record(request(stdoutPath));
  assert.equal(result.status, 'missing_usage');
  assert.equal(result.usage, null);
  assert.equal(result.equivalentUsd, null);
  assert.equal(result.costUsd, 0);
  assert.equal(rows.length, 0);
  assert.equal((await accounting.record(request(stdoutPath))).status, 'already_recorded');
  assert.equal(rows.length, 0);
});

test('records consumption but explicitly leaves unknown model pricing unset', async (t) => {
  const root = withTemp(t, 'parcel-accounting-unpriced-');
  const stdoutPath = outputFile(root, 'call-unpriced');
  const { accounting, rows } = harness(root, new Error('llm-cost: no rate for model gpt-9-test'));
  const result = await accounting.record(request(stdoutPath));
  assert.equal(result.status, 'recorded');
  assert.equal(result.priceStatus, 'unknown_price');
  assert.equal(result.equivalentUsd, null);
  assert.equal(result.costUsd, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].equivalent_usd, null);
});

test('requires parent-established subscription billing', async (t) => {
  const root = withTemp(t, 'parcel-accounting-billing-');
  const stdoutPath = outputFile(root, 'call-metered');
  const { accounting } = harness(root);
  await assert.rejects(accounting.record({ ...request(stdoutPath), billing: 'metered' }), /billing must be subscription/);
});

test('delegates default tiers and explicit model overrides to shared model configuration', async () => {
  const calls = [];
  const shared = { models: { resolveCall: (provider, options) => {
    calls.push({ provider, options });
    return { model: options.model || (options.tier === 'cheap' ? 'cheap-test' : 'review-test') };
  } } };
  const result = await helper.runOperation({ operation: 'models', researchModel: 'override-test' }, { shared });
  assert.equal(result.research.model, 'override-test');
  assert.equal(result.review.model, 'review-test');
  assert.deepEqual(calls, [
    { provider: 'openai', options: { tier: 'cheap', model: 'override-test' } },
    { provider: 'openai', options: { model: undefined } },
  ]);
});
