# Bogotá agreement sample data

## Open the prepared demos

Run the local frontend and API from this checkout. Pass their verified origins to the preview launcher:

```sh
node backend/scripts/serve-bogota-agreement-demo.mjs \
  --frontend "$UGT_DEMO_FRONTEND" --backend "$UGT_DEMO_BACKEND" \
  --port "$UGT_DEMO_PREVIEW_PORT" --links /tmp/bogota-demo-links.json
```

The launcher prints three links and saves them to the requested file: owners' agreement,
its counter-agreement, and community poll. It uses the existing private-draft import flow and serves
only on loopback. Opening a link applies the Plan and saves an editable local draft. Links have no
expiry. Their objects are retained in the checkout's ignored `backend/uploads/bogota-agreement-demo/`
directory. Stop the preview process when finished; restarting it with the same frontend, API and
preview port restores the same links. The frontend, API and preview process must be running to open
them. Keep the storage directory when moving the checkout. Nothing is pinned, published or signed.

## Five-minute walkthrough

1. Open the owners' link. Show the four adjoining lots, public space on Carrera 17 and five-storey
   building; use Models 3D to tilt and rotate. Choose daylight in the lighting control if needed.
2. In **Input parcels**, show the four parcel-owner allocation groups. **Parcel ownership rights**
   imports `ownership.json`: Alma owns two parcels, Bruno owns another and shares one with Camila.
   The identities resolve the same parcel allocations and cash, without changing the Plan.
3. In **Rules**, show Colombia's 51% area test, two distinct approving owners and the separate authority.
   All counted co-owners must approve before their parcel's area counts. Without complete ownership,
   the minimum remains unresolved; it never passes just because there are four parcels.
4. Compare the counter-agreement link. Its Plan and valuations are identical, but one piece goes to a
   different parcel-owner group. **Persons** shows the resulting COP balances and co-owner shares.
5. Open the community-poll link to show a separate electorate and the three-code sample roster.
   It is a draft, with no ballots or owner signatures. Live balloting starts only after publication;
   community support does not substitute for owners' decisions or the required authority.

## Files and regeneration

`node backend/scripts/prepare-bogota-agreement-demo.mjs` refreshes these files from one bounded public parcel read. To regenerate after the ground has already been saved, use `node backend/scripts/prepare-bogota-agreement-demo.mjs --from-sampledata docs/demo/bogota-agreements/sampledata.json`; that path performs no network request. The script writes local files only. It never pins, indexes, publishes, signs or contacts voters.

- `plan.json` is the portable `ugt-plan-file/v1`; import it with the browser's plan-file actions. It contains a manual parcel layout on the union of four adjoining lots, a public-space plot, and a five-storey building footprint inside a buildable plot. The layout plots tile the full source pool. Import creates unapplied local drafts and saved plan membership/view; it does not import agreements or change cadastral ground.
- `sampledata.json` contains the matching canonical design members and plan, three native `agreement/v1` records, and the actual parcel ground. The agreement outputs, parcel areas, and source-based valuations come from replaying those canonical designs through the app derivation. That replay splits the parcel containing the building into a building footprint and its remainder, so the agreement has six outputs even though the authored layout has five plots. The public-space strip meets Carrera 17; the building footprint follows its lot with a small inset. The first agreement and counter-agreement share the same plan CID and valuations; the counter changes one output recipient. The community agreement carries only voter-code hashes.
- `ownership.json` is an importable `parcel-rights/v1` example. It contains synthetic holders, including one person holding multiple parcels and a separate co-owner case; the synthetic authority belongs to the agreement rule, separately from owners. Its parcel areas use the exact measured ground areas.
- `example-voters-private.json` is a separate mode-restricted (`0600`) example roster with invented codes. Keep it with the demo operator; it is not a real eligible-voter list.

The source parcel IDs and geometry come from the CC BY 4.0 CAR mirror of UAECD Bogotá lots, layer 9, with the app's 2021-12 source identity. The POT source is described in [`../../bogota-pot-source.md`](../../bogota-pot-source.md). The owners' rule pins the current `co-readjustment` scheme and its 51% area-support policy, with a synthetic authority ID. All people, authority, rights, valuations and voter entries are invented examples; they do not identify owners or establish consent.

For local indexing, the existing `POST /agreements` route accepts `{ cid, content, plan, designs }`: select one agreement row from `sampledata.json`, set `plan` to `{ cid: sampledata.references.planCid, content: sampledata.planFile.plan }`, and set `designs` to `sampledata.planFile.designs`. The route checks the plan CID, validates each carried design and its parcel binding, checks that the agreement's input parcel IDs match the linked designs' combined binding, and indexes the carried plan/designs/agreement together. Send this payload only to the explicitly selected local API. Sample preparation does not make that request. Agreement CIDs are immutable. Community voting is a poll; only the owners' variants are binding.
