#!/usr/bin/env node
'use strict';

// Thin bridge from the raw, process-group-managed Codex runner to the shared CLI accounting
// implementation. Codex stdout remains the runner's durable JSONL artifact; this helper reads it
// only after the turn ends and records token consumption against the ChatGPT subscription.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const MARKER_NAME = 'usage-accounting.json';
const ALLOWED_META = new Set(['callId', 'jobName', 'taskId', 'role', 'attempt']);

function resolveSharedDir(env = process.env) {
  const candidates = [
    env.AGENTS_LLM_COST_DIR,
    path.resolve(__dirname, '../../../agents/lib/llm-cost'),
  ].filter(Boolean).map((value) => path.resolve(value));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cli.cjs')) && fs.existsSync(path.join(candidate, 'index.cjs'))) {
      return candidate;
    }
  }
  throw new Error('shared agents/lib/llm-cost module was not found; set AGENTS_LLM_COST_DIR to its directory');
}

function loadShared(dir = resolveSharedDir()) {
  return {
    cli: require(path.join(dir, 'cli.cjs')),
    cost: require(path.join(dir, 'index.cjs')),
    models: require(path.join(dir, 'llm.cjs')),
  };
}

function safeMeta(value, callId) {
  const meta = { callId };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ALLOWED_META) {
      if (key === 'callId' || value[key] === undefined || value[key] === null) continue;
      const item = value[key];
      if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) meta[key] = item;
    }
  }
  return meta;
}

function compactReceipt(row, request) {
  return {
    recorded: true,
    ts: row.ts,
    repo: row.repo,
    script: row.script,
    model: row.model,
    callId: request.callId,
    billing: 'subscription',
  };
}

async function findLedgerRow(ledgerPath, callId, fsApi = fs) {
  if (!ledgerPath || !fsApi.existsSync(ledgerPath)) return null;
  const lines = readline.createInterface({
    input: fsApi.createReadStream(ledgerPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.callId === callId) return row;
    }
  } finally {
    lines.close();
  }
  return null;
}

function writeMarker(markerPath, marker, fsApi = fs) {
  const temporary = `${markerPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fsApi.renameSync(temporary, markerPath);
}

function parseUsage(stdout, parser) {
  const parsed = parser(stdout);
  if (parsed?.usage) return parsed;

  // Some Codex builds include partial usage on turn.failed. The shared parser currently reads
  // turn.completed, so adapt that event into the shared parser's accepted envelope rather than
  // reimplementing token normalization or pricing here.
  for (const line of String(stdout).split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const usage = event?.type === 'turn.failed' ? (event.usage || event.error?.usage) : null;
    if (!usage || typeof usage !== 'object') continue;
    const recovered = parser(JSON.stringify({ type: 'turn.completed', usage }));
    if (recovered?.usage) return { ...parsed, usage: recovered.usage };
  }
  return parsed;
}

function makeAccounting({ shared = loadShared(), fsApi = fs, findExisting = findLedgerRow } = {}) {
  const stripEnv = shared.cli?.ENGINES?.codex?.stripEnv;
  const parseCodexEvents = shared.cli?.parseCodexEvents;
  const computeCost = shared.cost?.computeCost;
  const recordSubscriptionRun = shared.cost?.recordSubscriptionRun;
  const resolveModel = shared.cost?.resolveModel || ((model) => model);
  const ledgerPath = shared.cost?.LEDGER;
  if (!Array.isArray(stripEnv) || typeof parseCodexEvents !== 'function'
      || typeof computeCost !== 'function' || typeof recordSubscriptionRun !== 'function') {
    throw new Error('shared llm-cost module is missing Codex subscription accounting APIs');
  }

  async function record(request) {
    if (request?.billing !== 'subscription') {
      throw new Error('billing must be subscription; metered calls are not accepted by this helper');
    }
    const stdoutPath = typeof request.stdoutPath === 'string' ? path.resolve(request.stdoutPath) : '';
    const model = typeof request.model === 'string' ? request.model.trim() : '';
    const callId = request.meta?.callId;
    if (!stdoutPath || !model || typeof callId !== 'string' || !callId.trim()) {
      throw new Error('record requires stdoutPath, model, and meta.callId');
    }
    if (path.basename(path.dirname(stdoutPath)) !== callId) {
      throw new Error('meta.callId must match the Codex output directory name');
    }
    if (!fsApi.existsSync(stdoutPath)) throw new Error('Codex stdout JSONL file does not exist');

    const markerPath = path.join(path.dirname(stdoutPath), MARKER_NAME);
    const lockPath = `${markerPath}.lock`;
    let lock;
    try {
      lock = fsApi.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('usage accounting is already in progress for this output file');
      throw error;
    }

    try {
      const stdout = fsApi.readFileSync(stdoutPath, 'utf8');
      const fingerprint = crypto.createHash('sha256').update(stdout).digest('hex');
      const outputPathFingerprint = crypto.createHash('sha256').update(stdoutPath).digest('hex');
      const resolvedModel = resolveModel(model);
      const repo = request.repo || 'unknown';
      const script = request.script || 'unknown';
      const meta = safeMeta(request.meta, callId);
      const existingMarker = fsApi.existsSync(markerPath) ? JSON.parse(fsApi.readFileSync(markerPath, 'utf8')) : null;
      if (existingMarker) {
        if (existingMarker.callId !== callId || existingMarker.stdoutPath !== stdoutPath
            || existingMarker.fingerprint !== fingerprint) {
          throw new Error('existing accounting marker belongs to a different call or output');
        }
        return { ...existingMarker.receipt, status: 'already_recorded' };
      }

      const existingLedger = await findExisting(ledgerPath, callId, fsApi);
      if (existingLedger) {
        if (existingLedger.callFingerprint !== fingerprint || existingLedger.repo !== repo
            || existingLedger.callPathFingerprint !== outputPathFingerprint
            || existingLedger.script !== script || existingLedger.model !== resolvedModel) {
          throw new Error('callId already exists in the usage ledger for a different output or call');
        }
        const receipt = compactReceipt(existingLedger, { callId });
        const result = {
          status: 'already_recorded', billing: 'subscription', model: resolvedModel,
          usage: {
            input_tokens: existingLedger.input_tokens,
            output_tokens: existingLedger.output_tokens,
            cache_creation_input_tokens: existingLedger.cache_creation_input_tokens,
            cache_read_input_tokens: existingLedger.cache_read_input_tokens,
          },
          costUsd: 0,
          equivalentUsd: Number.isFinite(existingLedger.equivalent_usd) ? existingLedger.equivalent_usd : null,
          priceStatus: Number.isFinite(existingLedger.equivalent_usd) ? 'priced' : 'unknown_price',
          ledgerReceipt: receipt,
        };
        writeMarker(markerPath, { version: 1, callId, stdoutPath, fingerprint, receipt: result }, fsApi);
        return result;
      }

      const parsed = parseUsage(stdout, parseCodexEvents);
      const usage = parsed?.usage;
      if (!usage || !Object.values(usage).some((value) => Number.isFinite(value) && value > 0)) {
        const result = {
          status: 'missing_usage', billing: 'subscription', model: resolvedModel, usage: null,
          costUsd: 0, equivalentUsd: null, priceStatus: 'missing_usage', ledgerReceipt: null,
        };
        writeMarker(markerPath, { version: 1, callId, stdoutPath, fingerprint, receipt: result }, fsApi);
        return result;
      }

      let equivalentUsd = null;
      let priceStatus = 'priced';
      try {
        equivalentUsd = computeCost(resolvedModel, usage);
      } catch (error) {
        priceStatus = /no rate for model/i.test(String(error?.message)) ? 'unknown_price' : 'pricing_error';
      }

      const row = recordSubscriptionRun({
        repo, script, model: resolvedModel, usage, equivalentUsd,
        meta: { ...meta, callFingerprint: fingerprint, callPathFingerprint: outputPathFingerprint },
      });
      const result = {
        status: 'recorded', billing: 'subscription', model: resolvedModel, usage,
        costUsd: 0, equivalentUsd: Number.isFinite(equivalentUsd) ? equivalentUsd : null,
        priceStatus, ledgerReceipt: compactReceipt(row, { callId }),
      };
      writeMarker(markerPath, { version: 1, callId, stdoutPath, fingerprint, receipt: result }, fsApi);
      return result;
    } finally {
      fsApi.closeSync(lock);
      try { fsApi.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  return { environmentKeys: () => [...stripEnv], record };
}

async function runOperation(request, options) {
  if (request?.operation === 'models') {
    const shared = options?.shared || loadShared();
    return {
      research: shared.models.resolveCall('openai', { tier: 'cheap', model: request.researchModel }),
      review: shared.models.resolveCall('openai', { model: request.reviewModel }),
    };
  }
  const accounting = makeAccounting(options);
  if (request?.operation === 'environmentKeys') {
    return { environmentKeys: accounting.environmentKeys() };
  }
  if (request?.operation === 'record') return accounting.record(request);
  throw new Error('operation must be environmentKeys or record');
}

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await runOperation(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`parcel-research-accounting: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MARKER_NAME, resolveSharedDir, loadShared, makeAccounting, parseUsage, runOperation };
