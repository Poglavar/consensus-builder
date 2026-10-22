<!-- Server Affordabot operations and evidence limits. -->
# Affordabot

One scheduled research design a day (07:20 UTC), using the existing algorithmic proposer
(`agents/run.mjs`): the design is published by its CID under a binding owners' agreement over its
parcel (Affordabot is registered as the parcel's sole owner in the lens member's devnet owner registry),
minted on devnet and, on a later run, approved, attested and executed, with the server's parcel binding,
devnet funding, the agreement deadline and run checkpoints. The bot costs $0 in model calls; its market stake is 0.01 devnet USDC, capped at
0.02 per run. Repeated invocations on the same UTC day resume the same run and cannot create a second
daily pick.

Six enabled study areas: Hong Kong, Sydney, Los Angeles, Honolulu, Melbourne, San Francisco.
Cities rotate, with extra turns for the two highest price/income ratios. Values are from
[Demographia 2026, Table 3](https://frontiercentre.org/wp-content/uploads/Demographia-International-Housing-Affordability-2026-Edition-1.pdf),
Q3 2025, 96 metropolitan markets in eight countries. This is not an exhaustive worldwide ranking;
metropolitan statistics are context for bounded municipal study windows. Other high-ranked markets
(San Jose, Adelaide, Vancouver, Brisbane) need qualified parcel sources and jurisdiction routing.

The bot builds a six-floor courtyard where geometry permits, otherwise compact housing, wholly
inside a setback envelope. Geometry is resized to the coverage limit before GFA/home counts.
Design inputs (6 floors, 3 m setback, 60% coverage, 50 m² net homes, 80% efficiency) are assumptions,
not zoning. No worldwide euro rent defaults or owner uplift offers are used. Public/cooperative/
limited-profit delivery, an affordability covenant, verified local costs and funding are prerequisites.
Exact amendments remain unknown until sourced local planning controls exist.

Each run tries at most three bounded windows. Each window uses complete Overpass replies for mapped roads/rail, buildings, transit and public/
sensitive uses. Mapped buildings/public uses exclude the parcel; transport corridors exclude the setback envelope. Parking aisles/driveways may be redeveloped, subject to ownership/access review; a stop must be within 800 m straight line.
OSM completeness is not inventory completeness, vacancy, walking access or planning permission.
The published design's description carries the research summary (sources, assumptions, gaps); the
structured screening evidence, source timestamps and evidence gaps persist with each candidate in the
run checkpoint (`consensus.agent_run.summary.candidates[].housing`).
Missing/partial screening fails the run. No candidate is an explicit no-picks result, not a fabricated design.

Planning-authority official contact links appear in every design description. Published agreements
generate a durable `summary.outreach` review queue, keyed by agreement CID and linking
`/agreements/<cid>`. Read with:

```sh
cd backend
node agents/affordabot-outreach.mjs --list
```

Drafts are not sent. Recipients and exact jurisdiction must be reviewed before sending. No personal
staff addresses are guessed. X is disabled: unsolicited automated mentions are prohibited by
[X automation rules](https://help.x.com/en/rules-and-policies/x-automation); opt-in is required.

Activate from the ecosystem file and persist PM2; never restart unrelated bots:

```sh
pm2 restart agents/ecosystem.config.cjs --only consensus-builder-affordabot --update-env
pm2 save
```

The bot monitor must check the durable `affordabot` row (status, outcome and actual publication
count/freshness), not the shared agents log or another persona's output. Outreach queue failures
must fail the invocation. Successful scheduled runs stay silent on Telegram.
