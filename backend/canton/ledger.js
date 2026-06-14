// Thin client for the Canton JSON Ledger API v2 (5n sandbox DevNet). Wraps the
// calls proven in the spike: token-authed requests with auto-refresh on 401,
// party allocation + actAs grants, command submission, and scoped ACS queries.
// All functions take a `cfg` (see token.js cantonConfig); the route layer injects it.

import { getAccessToken, cantonConfig } from './token.js';

let cmdSeq = 0;
const newCommandId = (tag = 'cmd') => `${tag}-${Date.now()}-${cmdSeq++}`;

// Core request helper: attaches the bearer token, retries once on 401 with a
// forced token refresh. Returns parsed JSON (or {} for empty bodies).
async function call(cfg, path, { method = 'POST', body, raw } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(cfg, { force: attempt > 0 });
    const res = await fetch(`${cfg.ledgerApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': raw ? 'application/octet-stream' : 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue; // token expired -> refresh + retry
    const text = await res.text();
    if (!res.ok) throw new Error(`canton ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

export async function ledgerEnd(cfg = cantonConfig()) {
  const j = await call(cfg, '/v2/state/ledger-end', { method: 'GET' });
  return j.offset;
}

export async function uploadDar(cfg, bytes) {
  return call(cfg, '/v2/packages', { raw: true, body: bytes });
}

export async function allocateParty(cfg, partyIdHint) {
  const j = await call(cfg, '/v2/parties', { body: { partyIdHint } });
  const party = j.partyDetails?.party || j.party;
  if (!party) throw new Error('canton: party allocation returned no party');
  return party;
}

// List parties known to the participant. Used to reuse an existing well-known
// party (e.g. the public registry party) instead of blindly re-allocating it.
export async function listParties(cfg = cantonConfig()) {
  const j = await call(cfg, '/v2/parties', { method: 'GET' });
  return Array.isArray(j) ? j : (j.partyDetails || j.parties || []);
}

// Grant a ledger user CanActAs on a party (admin op). Idempotent in practice.
export async function grantActAs(cfg, userId, party) {
  return call(cfg, `/v2/users/${userId}/rights`, {
    body: { userId, rights: [{ kind: { CanActAs: { value: { party } } } }] },
  });
}

export async function submitAndWait(cfg, { command, actAs, readAs = [], userId = cfg.userId, tag }) {
  return call(cfg, '/v2/commands/submit-and-wait', {
    body: { commands: [command], userId, commandId: newCommandId(tag), actAs: [].concat(actAs), readAs },
  });
}

export function createContract(cfg, { templateId, args, actAs, userId }) {
  return submitAndWait(cfg, {
    command: { CreateCommand: { templateId, createArguments: args } },
    actAs, userId, tag: 'create',
  });
}

export function exerciseChoice(cfg, { templateId, contractId, choice, arg = {}, actAs, userId }) {
  return submitAndWait(cfg, {
    command: { ExerciseCommand: { templateId, contractId, choice, choiceArgument: arg } },
    actAs, userId, tag: 'exercise',
  });
}

// Active contracts for ONE party + ONE template. Scoping is required on the
// shared validator (a wildcard query exceeds the node's 200-element response cap).
export async function activeContracts(cfg, party, templateId) {
  const activeAtOffset = await ledgerEnd(cfg);
  const j = await call(cfg, '/v2/state/active-contracts', {
    body: {
      eventFormat: {
        filtersByParty: {
          [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } } } }] },
        },
        verbose: false,
      },
      verbose: false,
      activeAtOffset,
    },
  });
  const entries = Array.isArray(j) ? j : (j.result || j.activeContracts || []);
  return entries
    .map((e) => e?.contractEntry?.JsActiveContract?.createdEvent || e?.createdEvent || e?.created)
    .filter(Boolean);
}
