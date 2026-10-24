# MCP road junction validation — 2026-10-24

## Cause and correction

The Digbeth agreement `bafkreig2o7mfofimfnct7fe4xml4cg6p27mvzkrfpn2rnf47r4xqm52kre`
contained three independently authored MCP streets. Each had one uninterrupted stretch, no shared
crossing vertices and no foreign junction arms. The renderer found zero junctions. MCP agreement
drafting had bypassed the map editor's network authoring step.

MCP drafting and plan revision now use the same topology engine to author the complete included
road network before binding parcels or deriving ground. Affected streets store their split
stretches, neighbouring arms and rebuilt footprint, including junction corner land. Returned
changes identify revised design CIDs. Read-only inspection replays the exact supplied content.
Whole-street conveniences remain usable after a street is split at its junctions. Node identity
includes level, preventing coincident vertices at different elevations from joining.

## Targeted headless unit runs

Every command ran from `backend`, with `npx vitest run` and `--maxWorkers=1`. No full suite or
Playwright suite was run; no run was stopped.

| Run | Explicit test files | Result |
| --- | --- | --- |
| 1 | `test/mcp-road-network.test.js` | 6 passed. |
| 2 | `test/mcp-plan.test.js`, `test/mcp-ground.test.js`, `test/mcp-runtime.test.js`, `test/mcp-drafts.test.js`, `test/corridor-authoring.test.js` | 45 passed. |
| 3 | `test/mcp-road-network.test.js`, `test/corridor-authoring.test.js` | 20 passed, 1 failed: pre-existing coordinate-only node identity split coincident vertices on different levels. Fixed node identity to include level. |
| 4 | `test/mcp-road-network.test.js`, `test/mcp-edit.test.js`, `test/corridor-geometry.test.js`, `test/corridor-network-nodes.test.js`, `test/corridor-authoring.test.js` | 108 passed, including the previously failing level case and whole-street widening after junction splitting. |
| 5 | `test/mcp-road-network.test.js` | 7 passed after adding exact read-only replay coverage for an unconnected agreement. |

The final checks cover 139 distinct tests in nine files. Regression coverage includes the exact
Digbeth centerlines, both crossroads, footprint replay, unchanged originals, idempotent redrafting,
road removal, neighbour profile updates, final CID reporting, self-crossings, near-misses, protected
tunnel edges and grade separation.

## Actual agreement and headed browser verification

- Read the original public agreement and its 17 canonical designs. Ran the local MCP plan editor
  against those exact inputs, using production parcel binding/source reads and no publication.
- The private revision changed only Spine Street, Garden Street and North Street. Its cadastral
  input stayed unchanged and it retained 30 ground outputs.
- Revised agreement CID: `bafkreienncgx7klgpaz4syiismigqhvrkxtfw6ztjpy55ou2pq3tf2gczi`.
- Opened its exact private fragment preview in dedicated headed Chrome against local port 8097.
  Verified all 17 designs applied, with two junction layers and road stretch counts 3 / 2 / 2.
- Inspected both 2D and 3D screenshots: carriageways connect, corner pavements follow the junctions,
  and through-markings stop at the approaches. Browser error collection was empty.
- Verified port 8097 serves this checkout with `Cache-Control: no-store, must-revalidate`.
  The ignored local entry page is `/tmp/digbeth-junctions.html` under the frontend server.
- Closed both task browser sessions; the final session inventory was empty.

The original published agreement remains immutable. Corrected geometry is available in the private
revision and needs separate publication to become a new public agreement link. A concurrent session
included the implementation in commit `53236d3f0` while browser verification was in progress.

## Production deployment verification

Deployed application commit `df6feb784` from `colosseum-worlds-fair` to the frontend, API and
MCP service. Frontend release `deploy-502` serves the expected commit and the changed JavaScript
matches the local source byte for byte. Cloudflare purge succeeded. The backend deployment's
production HTTP smoke check passed its health request, warmup and eight parcel bounding-box reads.

The public MCP service returned a private revision of the original Digbeth agreement: 17 designs,
three revised roads, two degree-four junctions and unchanged cadastral input. The first verification
harness expected `content` instead of the hosted response's `untrusted.content`; checking the saved
response corrected that harness without creating another draft.

Opening its short preview link exposed an nginx failure: the 23,834-character redirect Location
exceeded the default upstream header buffer and returned HTTP 502. The preview location now has a
32 KiB header buffer, covering DraftLink's bounded 24,000-character fragment. The production MCP
POST locations also now use the already-versioned 15 MiB request limit; they still had 32 KiB.
Only those three locations were updated, retaining unrelated live configuration and a backup.
`nginx -t` passed before reload. The same preview then returned HTTP 302; decoding its fragment
confirmed all 17 designs. No agreement or design was published by these checks.

Targeted headless unit tests: `npx vitest run test/mcp-deployment-config.test.js --maxWorkers=1`
passed all three tests in one file. No full unit or browser suite was run; no run was stopped.
