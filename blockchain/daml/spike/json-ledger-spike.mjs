// Auth + JSON Ledger API v2 spike harness for the Canton purchase flow.
// Proves end-to-end against EITHER a local Canton 3.x ledger OR DevNet (5n sandbox):
//   optional OIDC token -> optional DAR upload -> (lens) create cert
//   -> (buyer) create proposal w/ owner as observer -> (owner) sees it in ACS
//   -> (owner) Accept -> Sale created, proposal archived.
//
// Zero dependencies: Node >= 18 global fetch. Configure via env (see .env.example).
// Run:  node json-ledger-spike.mjs   (optionally `set -a; . ./.env; set +a` first)

const env = process.env;
const API = (env.LEDGER_API_URL || "http://localhost:7575").replace(/\/$/, "");
const USER_ID = env.USER_ID || "ledger-api-user";
// Package reference for templateIds. The leading '#' lets Canton 3.x resolve by
// package NAME (from daml.yaml) instead of a pinned package hash.
const PKG = env.PACKAGE_REF || "#consensus-builder-daml";
const DAR_PATH = env.DAR_PATH || "";           // if set, uploaded before the flow
const PARCEL_ID = env.PARCEL_ID || "PARCEL-1";
const PRICE = env.PRICE || "100.0";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const die = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); process.exit(1); };

// --- OAuth: fetch a bearer token, or use a directly-provided one. ------------
// Supports client_credentials and password grants (per Canton Keycloak docs).
async function getToken(role) {
  // Role-specific bearer wins (LENS_TOKEN / OWNER_TOKEN / BUYER_TOKEN), else shared.
  const direct = env[`${role}_TOKEN`] || env.BEARER_TOKEN;
  if (direct) return direct;
  if (!env.TOKEN_URL) return null; // no auth (e.g. local sandbox with auth disabled)

  const body = new URLSearchParams({
    grant_type: env.GRANT_TYPE || "client_credentials",
    client_id: env[`${role}_CLIENT_ID`] || env.CLIENT_ID || "",
    scope: env.SCOPE || "openid",
  });
  if (env.CLIENT_SECRET) body.set("client_secret", env.CLIENT_SECRET);
  if ((env.GRANT_TYPE || "") === "password") {
    body.set("username", env[`${role}_USERNAME`] || env.USERNAME || "");
    body.set("password", env[`${role}_PASSWORD`] || env.PASSWORD || "");
  }
  if (env.AUDIENCE) body.set("audience", env.AUDIENCE);

  const res = await fetch(env.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) die(`token request (${role}) ${res.status}`, await res.text());
  const j = await res.json();
  if (!j.access_token) die(`no access_token for ${role}`, j);
  return j.access_token;
}

function headers(token, contentType = "application/json") {
  const h = { "Content-Type": contentType };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function api(path, { token, method = "POST", body, raw, soft } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(token, raw ? "application/octet-stream" : "application/json"),
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (soft) { log(`  (soft) ${method} ${path} -> ${res.status}: ${text.slice(0, 160)}`); return null; }
    die(`${method} ${path} -> ${res.status}`, text);
  }
  return text ? JSON.parse(text) : {};
}

// --- ledger helpers ----------------------------------------------------------
async function ledgerEnd(token) {
  const j = await api("/v2/state/ledger-end", { token, method: "GET" });
  return j.offset;
}

async function allocateParty(token, hint) {
  const j = await api("/v2/parties", { token, body: { partyIdHint: hint } });
  const party = j.partyDetails?.party || j.party;
  if (!party) die("party allocation returned no party", j);
  return party;
}

function newCommandId(tag) { return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }

async function submit(token, actAs, command, readAs = []) {
  return api("/v2/commands/submit-and-wait", {
    token,
    body: {
      commands: [command],
      userId: USER_ID,
      commandId: newCommandId("spike"),
      actAs: [actAs],
      readAs,
    },
  });
}

// Query the ACS at the current ledger end, scoped to ONE party reading ONE
// template — scoping is required on a busy shared validator (a wildcard query
// blows past the node's 200-element response cap).
async function activeContracts(token, party, templateId) {
  const activeAtOffset = await ledgerEnd(token);
  const j = await api("/v2/state/active-contracts", {
    token,
    body: {
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } } } }],
          },
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

// --- the flow ----------------------------------------------------------------
const main = async () => {
  log(`Ledger API: ${API}  package: ${PKG}  userId: ${USER_ID}`);

  const lensTok = await getToken("LENS");
  const ownerTok = await getToken("OWNER");
  const buyerTok = await getToken("BUYER");
  const adminTok = env.ADMIN_TOKEN || lensTok; // for party alloc / DAR upload
  log(`auth: ${lensTok ? "bearer tokens in use" : "no auth (open ledger)"}`);

  if (DAR_PATH) {
    const { readFile } = await import("node:fs/promises");
    log(`uploading DAR ${DAR_PATH} ...`);
    await api("/v2/packages", { token: adminTok, raw: true, body: await readFile(DAR_PATH) });
    log("DAR uploaded.");
  }

  // Parties: use provided IDs (DevNet/Loop) or allocate fresh (unique hint per run).
  const tag = `${Date.now()}`;
  const lens = env.LENS_PARTY || (await allocateParty(adminTok, `Lens-${tag}`));
  const owner = env.OWNER_PARTY || (await allocateParty(adminTok, `Owner-${tag}`));
  const buyer = env.BUYER_PARTY || (await allocateParty(adminTok, `Buyer-${tag}`));

  // The acting user must have actAs rights on these parties. If GRANT_RIGHTS_USER
  // is set (e.g. our admin user "6"), self-grant CanActAs for each (idempotent-ish).
  if (env.GRANT_RIGHTS_USER) {
    for (const p of [lens, owner, buyer]) {
      await api(`/v2/users/${env.GRANT_RIGHTS_USER}/rights`, {
        token: adminTok, soft: true,
        body: { userId: env.GRANT_RIGHTS_USER, rights: [{ kind: { CanActAs: { value: { party: p } } } }] },
      });
    }
    log(`granted actAs on lens/owner/buyer to user ${env.GRANT_RIGHTS_USER}`);
  }
  log(`parties:\n  lens=${lens}\n  owner=${owner}\n  buyer=${buyer}`);

  // 1) Lens attests ownership.
  log("1) lens creates OwnershipCertificate ...");
  await submit(lensTok, lens, {
    CreateCommand: {
      templateId: `${PKG}:Proposal:OwnershipCertificate`,
      createArguments: { lens, owner, parcelId: PARCEL_ID },
    },
  });
  const [cert] = await activeContracts(lensTok, lens, `${PKG}:Proposal:OwnershipCertificate`);
  if (!cert) die("certificate not visible to lens after create");
  log(`   cert contractId: ${cert.contractId}`);

  // 2) Buyer proposes, naming owner as observer.
  log("2) buyer creates PurchaseProposal (owner as observer) ...");
  await submit(buyerTok, buyer, {
    CreateCommand: {
      templateId: `${PKG}:Proposal:PurchaseProposal`,
      createArguments: { buyer, owner, lens, parcelId: PARCEL_ID, price: PRICE, certCid: cert.contractId },
    },
  });

  // 3) VISIBILITY CHECK: the owner sees the proposal addressed to them.
  log("3) querying ACS as OWNER (visibility check) ...");
  const ownerProposals = await activeContracts(ownerTok, owner, `${PKG}:Proposal:PurchaseProposal`);
  if (!ownerProposals.length) die("proposal NOT visible to owner — observer wiring wrong");
  const proposal = ownerProposals[0];
  log(`   ✓ owner sees proposal ${proposal.contractId} (price=${proposal.createArgument?.price ?? PRICE})`);

  // 4) Owner accepts -> Sale.
  log("4) owner exercises Accept ...");
  await submit(ownerTok, owner, {
    ExerciseCommand: {
      templateId: `${PKG}:Proposal:PurchaseProposal`,
      contractId: proposal.contractId,
      choice: "Accept",
      choiceArgument: {},
    },
  });

  // 5) Confirm Sale exists and proposal archived (from owner's view).
  log("5) confirming Sale + archival ...");
  const sales = await activeContracts(ownerTok, owner, `${PKG}:Proposal:Sale`);
  const stillProposed = await activeContracts(ownerTok, owner, `${PKG}:Proposal:PurchaseProposal`);
  if (!sales.length) die("Sale not created after Accept");
  if (stillProposed.length) die("PurchaseProposal not archived after Accept");
  log(`   ✓ Sale ${sales[0].contractId} created; proposal archived.`);

  log("SPIKE OK — auth + JSON Ledger API v2 + full purchase flow verified.");
};

main().catch((e) => die("unhandled", e?.stack || e));
