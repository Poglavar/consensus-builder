<!-- Contract and verification guide for browser betting events, distinct from verified chain activity. -->
# Betting journey instrumentation

`frontend/js/bets/bets-telemetry.js` sends acknowledged batches to `POST /bets/events`.
The server persists them in `consensus.bet_event` (`backend/routes/bets-events-ddl.sql`).
Retries keep the same event IDs; an exact duplicate is acknowledged once, while reuse of an ID
with different data fails the entire batch. The client retains unacknowledged events for its next
attempt. Browser storage may be disabled, so the event counts are observed activity, not a census.

Events cover entry, discovery, market overview, comparison, agreement navigation, valid quotes,
action attempts and transaction stages, positions, sharing, return navigation and closing.
`action_end` separates confirmed completion, failure, cancellation and unknown confirmation.
A transaction submitted without a known confirmation remains unknown. A later rendering error
cannot add a second, failed transaction outcome. An already-existing market is a successful
read, not a newly confirmed creation transaction.

`GET /bets/metrics` returns the last 30 days of visitor activity by default. `since` accepts an ISO
date/time and filters server receipt time. `mode=simulated` selects test activity instead.
The response includes distinct browsers and sessions, browsers seen in multiple sessions, event
counts and funnel groups by event, action and result. It exposes no raw browser identities.
These are client-reported observations, not proof of real people, demand or chain settlement.

Instrumentation is separate from the betting books described in
[`betting-lmsr-points.md`](betting-lmsr-points.md). A points account authenticates server-side
trades with its own opaque credential; telemetry uses anonymous browser and session IDs. Neither
credential is sent with telemetry. A reported action or confirmed points receipt is not evidence of
a Solana transaction, and simulated visitor metrics do not represent outside-pilot participants.

The browser generates an anonymous visitor ID and a tab-session ID, renewing the session after
30 minutes without betting activity so a later return in the same tab can be counted. It sends the source event time
as `occurredAt`; the database also records receipt time. It sends only allowed context fields,
such as city, agreement identity, asset, action, side, entry point and error code. Full URLs,
wallet addresses, names and free-text errors are not part of the payload.

For a simulated persona, append `betTest=curious-resident` (or another short slug) to the local
preview's query. Each named run has separate browser/session identities. Localhost and automation
browsers default to simulated activity even without the query. Returning to the same test run
retains its browser identity; a new tab session can exercise return measurement. Browser-only
identity is neither authentication nor Sybil resistance.

Targeted checks:

- Headless unit tests: `test/bets-events.test.js`, `test/bets-telemetry.test.js` from `backend`.
- Headless Playwright: `tests/bets-telemetry.spec.ts` from `e2e`; its simulated wallet outcomes are
  test fixtures and never evidence of a live transaction.
- The points journey in `tests/bets-points.spec.ts` uses the real local PostgreSQL ledger and an
  explicitly simulated agreement source. It covers buys, sales, reloads, settlement, claims and
  recovery of a committed trade whose HTTP acknowledgement was lost. The local harness refuses
  ordinary points accounts and keeps all activity in its designated simulation run.
- A local headed browser can exercise public source records through a preview API which writes
  only the new telemetry events to the local database. Read the stored rows and both metric modes
  afterward; ordinary visitor metrics must exclude those walkthroughs.

Asset selection, opening the standings and inspecting public positions have their own events.
Wallet linking and pending-receipt checks use the same started/finished action events as trading.
These events do not include the inspected profile ID or the wallet address.
