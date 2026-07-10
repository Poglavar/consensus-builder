# Canton backlog

Findings from the 2026-07-10 session, while fixing Canton reachability and putting the proposal's IPFS
metadata onto the ledger. Everything here was reproduced against the live 5N Seaport sandbox validator on
Canton DevNet. Product/funding roadmap lives in `MILESTONES-CANTON.md`; this file is the engineering
debt behind it.

## Done in that session (for context)

- `canton/*.js` each rolled its own `apiBase()` and none honoured `?backend=`, the override `dev.sh`
  passes. They all defer to `getBackendBase()` now, so Canton works on laptop, dev and prod.
- `canton-counts.js` swallowed every failure in an empty catch, so a 502 from an unconfigured backend
  and an empty ledger both rendered as "no proposals". It now reports `unknown | ok | unavailable`.
- The create dialog never said which chain a proposal would mint on. `getActiveMintTarget()` names that
  decision once, in the same order `createProposal()` dispatches on.
- `PurchaseProposal`/`Sale` carry `imageUri` (package `0.4.0`, uploaded and vetted on DevNet). Verified
  on the ledger: create with the field stores it, create omitting it is accepted as `None`, `Accept`
  carries it into the `Sale`.

---

## 1. Party allocation leaks rights, and DevNet is now at the cap — BLOCKER

`backend/canton/proposals.js` `createProposal()` allocates a **fresh** `Lens-`, `Owner-` and `Buyer-`
party on *every* proposal, then grants each `actAs` on ledger user `6`. Nothing ever releases them.

Ledger user `6` currently holds **771 `actAs` rights** and is at the participant's limit:

```
POST /v2/users/6/rights -> 400
{"code":"TOO_MANY_USER_RIGHTS","cause":"grant user rights failed, as user \"6\" would have too many rights."}
```

Consequences today:

- `POST /canton/proposals` with auto-allocated parties **fails on DevNet**, on prod as well as locally.
- The user-facing error is misleading. The rights grant is best-effort and swallowed, so the failure
  surfaces later as `403 {"code":"NA","cause":"A security-sensitive error has been received"}` from
  `/v2/commands/submit-and-wait` — which reads like an auth problem, not a quota one.
- The shared sandbox is polluted: the rights list also contains other apps' parties (`bot-scalper`,
  `cloakrfqCoordinator`…), so we are consuming a shared resource.

Fix, roughly in order of value:

1. Stop allocating per proposal. A lens and an owner are properties of a *parcel*, not of an offer —
   reuse a stable party per (parcel, role), or a single app-wide lens. Only the buyer is per-user.
2. Release rights when a flow ends. `canton/ledger.js` has `grantActAs` and no revoke — one needs
   writing — or allocate under a short-lived user.
3. Surface `TOO_MANY_USER_RIGHTS` instead of hiding it in the best-effort `try/catch` around
   `grantActAs` (`proposals.js:46`, `:99`) — a quota error is not "not hosted by us".
4. Clean up the accumulated rights on user `6`.

## 2. Reads are scoped to one party, and the UI cannot tell "none" from "not mine"

`GET /canton/proposals?party=…` queries that party's ACS. A proposal is invisible unless the party is its
buyer, owner or lens observer — which is the privacy feature working correctly. But the parcel panel
renders the same empty state either way, so "you are not a stakeholder in these" looks like "there are
none". The public marker count (`/canton/parcel-counts`) already knows better; show the divergence.

## 3. `.public-party.json` is a single point of failure

The public party is pinned in `backend/canton/.public-party.json`
(`CantonPublic::1220a14ca128…`). A DevNet reset drops hosted parties, and `proposals.js:31-45` notes the
full party id "can't be recovered via the API" after re-allocation. Badges then silently go to zero
(see §2). Needs: a documented recovery path, `CANTON_PUBLIC_PARTY` as an override, and a startup check
that the pinned party still exists.

## 4. Package-name reference resolves to the newest vetted version

`packageRef` defaults to `#consensus-builder-daml` (`token.js:18`). The moment a new version is vetted,
**every** participant using that name starts creating contracts of it — including production, before its
backend is deployed. This turned out to be safe for an added `Optional` field (verified: omitting it is
accepted as `None`), but it will not be safe for a required field, a renamed field, or a changed choice.

Rules to keep: new fields are `Optional` and **appended last**; anything else needs a pinned
`CANTON_PACKAGE_REF` to a package id, and an upload-then-deploy order.

## 5. No `daml test` in CI, and the DAR is built out of band

`blockchain/daml/.gitignore` excludes `*.dar`. `daml test` is green but nothing runs it automatically,
and nothing checks upgrade compatibility against the previously vetted version (`daml build` can take
`upgrades: <old.dar>`; we do not have the old DAR checked in anywhere). A breaking template change would
only be discovered at upload time, on the shared validator.

## 6. No money moves

`price` is a plain `Decimal`; nothing settles. Blocked on the Amulet scan/registry URL for the 5n
sandbox — not in the credentials, not discoverable. This is milestone M1 in `MILESTONES-CANTON.md`.

## 7. Custodial only

All parties (lens, owner, buyer) are hosted on the one 5n sandbox validator via M2M user `6`. True
cross-participant self-custody hits `PACKAGE_SELECTION_FAILED`: external Loop wallets will not vet
third-party DARs. Milestone M2.

## 8. Environment parity

`CANTON_*` and `CCVIEW_*` live only in each host's `backend/.env`. The laptop now has them; **valhalla
(dev) does not**. Same eleven keys, copied from prod:

```
ssh do "grep -E '^(CANTON|CCVIEW)' /root/code/consensus-builder/backend/.env"
```

`cantonConfig()` returns empty strings when they are missing and `getAccessToken()` throws, so every
`/canton/*` route 502s — which, before §Done above, was invisible.

## 9. JSON Ledger API v2 quirks worth remembering

- Every path in `canton/ledger.js` is hardcoded to `/v2/...`; a version bump breaks all of them.
- `DEVNET-ACCESS.md:126` records a **200-element cap on wildcard ACS queries**. Ours are
  template-filtered, so they are not subject to it today — but a wildcard query is not a safe
  refactor, and it is worth confirming whether a filtered query has its own ceiling before
  `ProposalMarker` counts grow.
- `activeContracts` already probes several response shapes (`ledger.js:90-93`) because the shape has
  moved before.
- DevNet is explicitly ephemeral. A reset drops all contracts and hosted parties.
