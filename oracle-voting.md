# Oracle-backed owner voting

## What this branch implements

`ProposalNFT.mintOracleVote` fixes an ownership oracle, a voting oracle, an electorate size,
a closing timestamp, and a payout wallet at proposal creation. The ownership oracle must
approve a commitment over the author, exact parcel list, owner count, deadline, chain, and
proposal contract before minting. It then reports opaque owner IDs. The voting oracle
reports each accepted owner's latest choice: abstain (0), yes (1), or no (2). Each change
is a transaction and event; only the latest choice counts.

Anyone can call `finalizeOracleVote` after the deadline. It executes only if the oracle
registered the entire approved electorate and every registered owner currently votes yes.
Otherwise it expires. Escrow is then released by `withdrawOracleFunds` to the fixed payout
wallet on success or the original funder on failure. Both calls are permissionless, so a
keeper can submit them; the destination cannot be changed by the caller. This branch does
not deploy or schedule that keeper. `blockchain/scripts/finalize-oracle-votes.mjs` is a
one-shot dry-run/`--apply` keeper that can be scheduled after deployment. ETH and CityMemeToken are supported on chain; the
current creation form sends ETH when the offer currency is ETH.

`OracleReporter` is the reference provider contract. A service wallet approved by the
reporter owner can approve electorates, report owners, and bind verified owner IDs to
wallets. Once bound, a voter sends `castMyVote` from their own wallet; the reporter
forwards the choice to the proposal contract. An alternative provider can replace either
oracle if it implements the same report calls and electorate approval getter. The current
voting UI expects `walletOwnerId` and `castMyVote` on the selected voting oracle.

The creation form supports existing EAS votes, Certilia eOsobna, and custom oracle
contracts. Certilia is disabled until the connected chain's
`frontend/contracts/addresses.json` entry has `CertiliaReady: true`,
`CertiliaOwnerOracle`, and `CertiliaVoteOracle`. Those fields must only be added after
the service described below is operational. The author enters the oracle-approved owner
count and, for funded votes, an explicit payout wallet. An unapproved count fails at mint.
Chain reads expose the selected addresses, roster size, yes/no totals, and finalization
state; the interface shows vote controls, a tally, finalize, and release actions.
The new methods require deploying the updated `ProposalNFT` and changing the chain's
`ProposalNFT` address. Existing deployed contracts cannot be upgraded by this branch.

## Technology demonstrator sequence

The on-chain oracle path can be demonstrated now with `OracleReporter`, a synthetic
owner roster, and test wallets. The Forge tests exercise owner registration, repeated
on-chain vote changes, deadline finalization, and ETH/token settlement. This proves the
contract interface without a live identity provider or land-registry connection.

The next live integration experiment is a Certilia Developer application and one
test login. Capture the actual OIDC discovery metadata, requested OIB claim, and
authentication method/assurance claim. Verify that the result distinguishes eOsobna
from other Certilia login methods. Then run one end-to-end test: authenticated OIB →
synthetic matching roster → wallet challenge → oracle registration → on-chain vote →
changed vote → finalization. The live ownership feed can replace the synthetic roster
through the same owner-oracle interface once available.

The public Certilia page confirms OAuth2/OpenID Connect and self-service application
registration, but its public documentation does not establish the exact claim names,
scope, or assurance values. Those are empirical checks for the registered client.

## Certilia service to build for the live path

1. Register this application with Certilia Developer as an OpenID Connect client. Use the
   authorization-code flow with PKCE, a state parameter, and a nonce. Validate the ID
   token's issuer, audience, signature, nonce, and lifetime against the provider's
   discovery/JWKS metadata; request the OIB claim and verify its documented location.
   Verify the returned assurance level and authentication method against Certilia's
   integration documentation before calling the option “eOsobna”; an ordinary Certilia
   login must not silently qualify as an eOsobna authentication.
   Certilia/AKD describe the IDP as OAuth2/OpenID Connect and say it can return verified
   name, surname, and OIB: <https://www.certilia.com/poslovni-korisnici/identity-provider>
   and <https://www.akd.hr/en/solutions/digital-identity-solutions/idp/identity-provider>.
2. Obtain an authorized current ownership source that returns natural-person owners and
   OIBs for the proposal's exact cadastral parcels. The stored `parcel_info.details`
   person list has no structured OIB; the linked land-registry B sheet has
   `lrOwners[].taxNumber` but only partial local coverage. Do not use that cache as a
   complete electorate or assume its public REST response may be systematically reused.
   The structured official land-registry person service requires institutional approval:
   <https://catalog.uredjenazemlja.hr/katalogpodataka/serviszadohvatupisanihosobauzemljinimknjigama>.
3. Resolve parcel identifiers and ownership as of a documented snapshot time. Exclude
   legal entities from citizen voting, handle co-owners and disputed/missing OIBs, and
   deduplicate a natural person across parcels. The provider must approve the complete
   owner count before mint; an incomplete or disputed roster means the proposal cannot
   be made executable. Later title changes require an explicit policy and likely a new
   proposal because the electorate is fixed at creation.
4. At voter enrollment, have the wallet sign a short-lived challenge bound to chain ID,
   proposal contract, proposal ID, wallet, nonce, and expiry. Complete Certilia login,
   match its verified OIB exactly against the authorized roster, and derive an opaque
   owner ID with a server-secret HMAC over OIB and proposal ID. Never put an OIB, name,
   or plain OIB hash on chain. A plain hash is enumerable because OIBs have a small
   structured space. Report the owner ID and bind that ID to the proven wallet through
   the selected oracle contracts. Store only what is needed for audit and re-enrollment.
5. The voter then chooses yes, no, or abstain on chain from the bound wallet. Re-login
   can be required by service policy for wallet re-binding; a normal vote change needs
   the wallet transaction. The service operator's reporter key can still override a
   vote, so key custody, audit events, and an independent operating policy matter.
6. Run a keeper that identifies closed, unfinalized oracle proposals and submits
   `finalizeOracleVote`, then `withdrawOracleFunds` if escrow exists. Retry idempotently
   and verify the emitted events and final state. No offchain event or timer can make an
   EVM contract execute without a transaction.

This branch contains no Certilia credentials, production OIB lookup, or live identity
callback. The reference contract can be tested with synthetic identities and owners.
