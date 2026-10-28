# Are people actually planning with Urban Game Theory?

Audit and draft implementation, 26 October 2026. Source base: `colosseum-worlds-fair` at
`90e42035eb7c8ff45b37dfe135f47a8ebe62120a`. Portable-plan export PR #32 is already merged
into that base. This work is separate from that PR and the ongoing full-suite QA work.

The useful question is whether planning work completes: creating or changing designs, retaining
drafts, importing/exporting a composition, saving a named-plan link, copying a link and publishing.
Pageviews cannot answer this. Existing publication data can show public output immediately;
private local planning needs additional, carefully scoped evidence. None of these measures is a
count of true people.

## What exists today

| Source / code | Evidence available | Limits |
| --- | --- | --- |
| `consensus.plan`, `consensus.design`, `consensus.agreement`; `routes/plans.js`, `routes/designs.js`, `routes/agreements.js` | Immutable published/indexed content and server creation times. A named plan references published designs. | A changed composition gets a new CID. The same CID is idempotent. Designs, named plans and agreements are distinct. Historical rows do not reliably identify UI versus MCP, automated agents or tests. They omit local editing. |
| `storage/pinning.js`, provider adapters, `/pins`, `/ipfs/upload` | IPFS publication and provider responses; existing logs name CIDs, objects and byte lengths. | Image pins, metadata pins, designs and plan JSON are different objects. Partial publication can pin data before indexing fails. Inventory is not visits, unique plans or people. Provider account inventory was not accessed. |
| `index.js`, nginx configuration | API errors/statuses; development SQL diagnostics; write/upload rate limits. Nginx forwards network addresses. | No general planning interaction ledger was found. The global error handler can log raw URLs/stacks and development logging can include query parameters. Existing infrastructure access-log configuration and retention were not verified on live hosts. Do not turn those raw logs into an analytics export. |
| `frontend/js/proposal-drafts.js`, `persistent-storage.js`, `browser-workspace.js`, `proposals/data.js` | Local drafts, local authored records and durable workspace transactions. | Private work usually stays on the device. The server cannot reconstruct all creation/edit/save activity from publication records. |
| MCP `mcp-server.mjs`, `mcp-http.mjs`, named-plan/draft tools | Structured tool errors and recovery instructions, bounded hosted transport/write budgets, private hosted drafts/previews. | Tool execution is not proof of a human user. No complete planning usage report or reliable historical caller attribution was found. The hosted MCP intentionally has no database credentials. |
| `frontend/js/ui-helpers.js` | Session status log, bounded to 2,000 entries, with copy action. | Human-readable messages can contain titles, parcel IDs and free text. This legacy copy is not a redacted diagnostic export. Many independent alerts/catches remain. |
| `/feedback`, private `consensus.feedback`, `scripts/feedback-inbox.mjs` | Explicit bug/feedback reports with receipts; existing private database inbox and optional Telegram notification. | Free text and optional page URL; validation strips fragments but retains query strings. This is a different disclosure/retention path. New diagnostics do not feed it or Telegram. |
| `/bets/events`, `/bets/metrics`, `bets/bets-telemetry.js` | Betting journey events with browser/session identifiers, outcomes and declared simulations. | Betting, not planning. Source creates persistent browser IDs and automatic flushing. The checked API route and nginx configuration do not protect `/bets/metrics`. Do not reuse it for sensitive planning diagnostics. |
| `frontend/index.html` | Existing Clarity bootstrap after page load for non-local hosts. | Already present before this work. This draft adds no Clarity, session replay or third-party analytics and does not alter or activate existing integrations. Live configuration and collected data were not inspected. |
| `/hackathon/operations.json`, `operations/public-status.js` | Public, redacted scheduled-job health. | An operational status surface, not a private usage dashboard. |

This is a source audit, not a production-data audit. No live database, private server logs,
pinning account or user sessions were accessed; no usage totals are invented. No protected web
admin surface was verified. The existing private database/CLI boundary is the appropriate first
report destination without new credentials or access changes. The configured workspace-wide
`../AGENTS.md` is absent, and `.agents` contains no readable skill files in this environment;
the repository's current `AGENTS.md` was read from the verified base.

## Options and recommendation

| Option | Benefit | Cost / limitation |
| --- | --- | --- |
| Existing database publication aggregates | Immediate first-party evidence of public planning output; no additional client tracking. | Misses private editing, failed attempts and unpublished work. Count revisions separately by record kind. |
| Provider pin inventory | Cross-check publication/storage health and partial successes. | Requires existing approved provider access; pins include assets and duplicates. Do not count pins as people or plans. |
| Local structured diagnostics plus explicit export | Consistent readable failures and useful support evidence while offline. | Support is voluntary; downloads do not measure total adoption. |
| Optional first-party action outcomes | Can show successful/failed planning work and temporary pseudonymous sessions; aggregate privately. | Needs reviewed disclosure, deployment, retention and abuse policy. Client reports are forgeable and incomplete. Random sessions are not people. |
| Third-party analytics/session replay | Can offer navigation/session tooling. | Unnecessary for this minimum scope and expressly excluded from implementation. Existing Clarity deserves a separate deployment/privacy decision. |

Recommendation: run the private existing-record report first. Review the common local error
experience and export next. Only then consider enabling server outcome collection and optional
explicit report submission. Automatic browser usage upload is deliberately not implemented.

## What this draft implements

`frontend/js/app-diagnostics.js` provides one closed error catalog, readable message, severity,
recoverability, allowlisted context and random correlation ID. Raw error messages/stacks are
never copied into its buffer or transport. Unhandled errors/rejections pass through that same
boundary; duplicate errors are suppressed without preventing the browser's normal handling.
The UI continues to use existing `finally` cleanup and busy controls.
Catalog messages, diagnostic controls and submission prompts use the current English, Spanish,
Croatian or Serbian locale, including after a language change. Machine codes and wire payloads
remain language-independent; English is the fallback while dictionaries load.

The buffer is memory-only: at most 100 entries, expiring after 24 hours when accessed, and gone
on refresh/tab close. A random session rotates after 30 minutes idle. Plan handles are random,
bounded, tab/session-local mappings; raw CIDs, draft IDs and workspace IDs are never exported.
There is no fingerprinting, persistent visitor identity, IP collection or bot/person inference.
These local observations are support diagnostics, not an automatic analytics upload.

The status-log dialog gains a separate **Download diagnostics** button, **Clear diagnostics**
and a short disclosure. Its JSON export contains only the fixed schema. It does not export the
legacy status log, plan geometry, names, free text, filenames, full URLs, query tokens,
credentials, wallets or network addresses.

An optional explicit send API requires `enabled: true` and `confirm: true`; the optional UI
button additionally requires `window.UGT_DIAGNOSTICS_SUBMISSION_ENABLED === true` and a user
confirmation. Nothing in this draft sets that flag. Sending is bounded to the latest 20 entries,
one attempt per minute, one request in flight, with connection/response timeouts and no background
retry. Failure preserves the local report and does not block editing. HTTP transport still exposes
the client's network address to the server and its proxies; it is not included in the payload.

`POST /diagnostics/reports` is separately disabled unless `UGT_DIAGNOSTICS_INGEST=true`. It sits
behind the existing origin guard, before the large application parser and authoring rate limiter.
It accepts at most 16 KiB/20 strict structured entries, rejects unknown/private fields and duplicate
IDs within a batch, and applies a fixed 60-request/minute global budget without an IP/identity map.
An origin check is not authentication; the enabled endpoint is abuse-limited, not proof of a
legitimate user. Client attribution is forced to `ui / client-report / unknown` and cannot claim
MCP/server/test provenance. Malformed/oversize bodies receive fixed responses without raw logging.

Optional storage uses the existing database, with atomic exact-payload ID dedupe/conflict checks,
an advisory lock, at most two in-flight writes (including pending pool checkouts), 10,000 retained
rows and seven days of retained diagnostics. A checkout timeout returns promptly but retains its
concurrency slot until that checkout resolves or rejects; late clients are released immediately.
Enabled services prune on startup and hourly, including idle periods; reports exclude expired rows even before cleanup. Maximum physical age on an active service is
approximately seven days plus one hour. If the service stops or all collection is disabled, the
operator must continue the existing private cleanup command/schedule; a stopped service cannot
delete data. Backups and infrastructure logs need their own retention review. Dedupe ends when
rows expire or are evicted; replay after eviction cannot be ruled out. Capacity/rate/lock drops
make this a bounded sample, never a complete usage census.

`UGT_PLANNING_SERVER_OBSERVATIONS=true` independently enables fixed-route API publication
outcomes for `/plans`, `/designs`, `/agreements`, `/pins` and `/ipfs/upload`, based on completed
HTTP responses. They are API observations, with no invented sessions or caller classification;
`NODE_ENV=test` marks known tests. Early origin/parser refusals that occur before the observer
are not counted. A successful repeated publish action can be an existing object; publication
record counts remain separate. Pin attempts are artifacts, never unique plans.

The MCP registration boundary has an optional injected private recorder for allowlisted create,
edit and publish tools. It observes actual tool results, including structured failures, without
arguments/results or invented session IDs. **No recorder is connected in stdio or hosted MCP.**
Adding a hosted persistence path remains a reviewed follow-up; do not supply DB credentials to
the credential-free hosted MCP environment.

## Coverage inventory and migration pattern

| Path | Migrated / measured | Remaining scope |
| --- | --- | --- |
| Draft store | Successful create and meaningful edit; no-op edits excluded. Device-save result recorded separately; exhausted storage gets a common recoverable error. | Undo/redo, deletion and all editor-specific validations are not complete action coverage. A synchronous store acceptance during early workspace bootstrap is not proof of a later disk flush. |
| Portable-file controls | JSON/GeoJSON download completion; import invalid/oversize/cancel/atomic-commit success/failure; safe common alerts and restored controls. | Export success means the browser download was initiated, not that a user retained the file. Import success means the atomic mutation completed, not that designs were applied. |
| Named plans | Save success only after verified readback; save/open errors through common catalog. | Plan handles are local observations, not conceptual global identities across immutable revisions. |
| Design publication and sharing | Publish completion/failure/cancel from the exposed UI API; clipboard success/failure and manual-copy fallback; share-panel errors and design-index list failure. | Cached already-published designs can satisfy a publish action; count indexed records separately. Other import/download/preview paths still have their existing errors. |
| General create/apply | Owning operation/recovery handlers record thrown errors with their specific code; saved-but-not-applied error distinguished from save failure. The lower mutation boundary propagates errors without pre-classifying them or treating normal replay cancellation as a failure. | Direct creation paths outside the draft store do not yet have complete action counters. Existing validation notices, error branches returning `false`, parcel-source health UI, wallet, agreement, render/3D and source-provider messages remain partly ad hoc. |
| Runtime/workspace startup | Safe unexpected-error/rejection capture; workspace startup failure. | Handled console-only errors are not all captured; no console monkey-patch or stack capture. |
| API/MCP | Disabled API outcome observer and unconnected MCP observer with verifiable execution provenance. | Historical UI/MCP/test attribution is unknown; a request header is not trusted attribution. No hosted MCP session/unique-plan counting. |

This is not a claim that every frontend error has been standardized. The inventory comes from
reading the actual paths and exercising selected flows, not a grep count.

Migration pattern: choose a fixed catalog code and allowlisted surface; call
`AppDiagnostics.run(operation, { entity, code, context }, action)` around a completed operation,
or `report(error, { code, context })` at a recovery boundary. Keep raw data in the planning flow,
not in telemetry context. Treat cancellation separately. Record a save only at its real persistence
boundary. Keep field-level authoring guidance in its UI; add new safe catalog guidance when needed
instead of showing untrusted server text. Preserve existing recovery and busy-control cleanup.
Avoid counting the same draft and its final saved record as two globally unique plans.

## Read the private report

Using the backend's **existing** authorized environment, without creating credentials:

```sh
cd backend
node --env-file=.env scripts/planning-usage.mjs --days 30
```

This reads existing publication tables only and returns daily UTC revision counts, separately for
named plans, designs and agreements. It does not enable collection or access a provider account.
It returns no authored content, identifiers or user-level rows. The shared database connection
helper requires a nonempty `DATABASE_URL` before any connection or cleanup; ambient `PG*` settings
are not an alternative database selection path.

After a separately approved diagnostic schema/rollout, `--diagnostics` includes aggregate
outcomes and distinct observed session/plan handles, separated by source/evidence/test status.
These handles must not be labeled people or globally unique plans. Never add client/API/MCP
outcomes together. `--prune-diagnostics` performs private bounded-storage maintenance, including
when collection is disabled. No new HTTP metrics/dashboard endpoint is provided.

## Deployment and review decisions still open

- This is a draft review change. Do not merge, deploy, set collection flags, apply the optional
  SQL or connect a recorder as part of this task. The SQL is intentionally absent from deploy DDL.
- Decide whether server-only completion counts are sufficient before enabling client submission.
  Review the UI disclosure, data controller/access arrangements, applicable consent requirements,
  deletion requests, retention, backups and infrastructure logging. This document makes no legal
  compliance claim.
- Keep new dashboards private. Reuse verified existing access, or obtain separate approval for
  any new credential/access setup. The existing public betting metrics route is not that boundary.
- If enabled later, apply the reviewed schema with the existing role, test with synthetic local
  inputs, verify cleanup even during disabled/idle periods, and evaluate capacity drops. A global
  budget intentionally trades completeness for bounded resource use.
- Review existing Clarity/betting collection separately. No real-world error injection or live
  tracking activation is part of validation.

MCP parity: authored records, editable fields and validators are unchanged. Existing
`ugt_draft_plan`, `ugt_edit_plan`, design editing and portable-file inspection remain the parity
paths. The optional MCP observer wraps existing registration without adding tools or changing
their outputs. Focused tests cover that boundary and existing named-plan/server contracts. The
queue, CLI guard, error classification and translation fixes introduce no human editing operation
or schema/discovery change, so the existing granular MCP operations remain sufficient.

## Validation and practical limits

New focused checks cover event semantics; safe error/context reconstruction; malformed/oversize
reports; bounded rate/concurrency/dedupe/retention/storage; network outages and timeouts; local
export; unhandled-error storms; real draft-store edits/save failures; portable-control recovery;
named-plan readback; clipboard recovery; API/MCP attribution and private report semantics.
Regression checks use the real pg-pool queue under checkout starvation and test late release and
rejection recovery; real mutation-boundary import/cancellation; a CLI subprocess with missing/empty
`DATABASE_URL`; and language changes across all four dictionaries. Browser checks also cover
localized import alerts, disclosure, optional-send confirmation/outcomes and busy cleanup.
The PostgreSQL integration check is restricted to an explicit disposable test DB and runs in CI.
Existing authoring/export/share/MCP regression tests are included in the focused workflow.

The source workspace initially had a stale checkout and shell GitHub/npm egress returned proxy
503 errors. Current source files were materialized read-only through the connected GitHub API
into an isolated local workspace; the remote commit is built on the exact verified upstream tree,
preserving every untouched file. Local supplemental tests may use already installed dependencies;
the draft workflow installs the repository lockfile and checks out the exact PR head. The separate
full-suite QA findings are outside this change, and focused checks do not imply the whole suite is
green. No live database totals, real browser adoption numbers or production retention assertions
are supplied by this source-only task.
