<!-- Free MCP directory listing metadata, publication evidence, and maintenance instructions. -->
# MCP directory submissions

Only free listings are authorized. Do not purchase publication, featured placement, or subscriptions.

## Shared listing copy

- Name: **Urban Game Theory — Consensus Builder**
- Homepage: https://urbangametheory.xyz
- Endpoint: https://urbangametheory.xyz/mcp
- Transport: Streamable HTTP
- Authentication: none for the hosted tools
- Registry identity: `xyz.urbangametheory/urban-game-theory`
- Categories: urban planning, geospatial, real estate, design

Short description (also in [`server.json`](../server.json)):

> Inspect real parcels, create and edit urban plans, compare alternatives, and share 2D/3D designs.

Long description for directories that accept it:

> Create and refine urban plans on real parcels with Consensus Builder. Inspect sites; draft buildings, roads, parks and parcel layouts; edit authored geometry and building heights; add or remove plan components; compare alternatives; and open private previews or share published designs in the browser. Public publishing requires explicit confirmation. The hosted MCP never signs wallet transactions or makes payments.

Example requests:

- “Create a regeneration concept for this site with housing, parks and walkable streets.”
- “Lower that tower to 18 storeys, rotate it 15 degrees, and remove the lake.”
- “Revise the parcels north of the road into three-storey row houses, then show the revised plan.”

These are requests for an agent to compose from granular tools, not promises of one tool per sentence.

## Official MCP Registry — published

Published **2026-10-24**, version **0.3.0**, status **active**. Independently read back through the Registry API and verified in the browser.

- [Public listing search](https://registry.modelcontextprotocol.io/?q=urbangametheory)
- [Published metadata](https://registry.modelcontextprotocol.io/v0.1/servers/xyz.urbangametheory%2Furban-game-theory/versions/0.3.0)
- [Remote publishing requirements](https://modelcontextprotocol.io/registry/remote-servers)
- [Domain authentication](https://modelcontextprotocol.io/registry/authentication)

The manifest describes the existing hosted endpoint, so no npm package is required. Keep its name and version aligned with the deployed server. Registry versions are immutable; update the version for a subsequent manifest change.

The public ownership proof is [`frontend/.well-known/mcp-registry-auth`](../frontend/.well-known/mcp-registry-auth). Its private signing seed is in the ignored, mode-600 `backend/.env.mcp-registry` under `MCP_REGISTRY_PRIVATE_KEY`. Never commit, print, copy into a public listing, or serve that file. Preserve it for future listing updates; the public proof alone cannot sign registry requests.

The exact-path nginx routes are in [`ugt-mcp-directory-verification.conf`](../backend/nginx/ugt-mcp-directory-verification.conf), included as `snippets/ugt-mcp-directory-verification.conf` inside the main HTTPS vhost. The snippet and Registry proof were installed independently of the application release. Other dotfiles remain denied. The Glama route returns 404 until a real ownership token is provided.

For a later update, use the official `mcp-publisher`, authenticate using the retained private credential without echoing it, then:

```sh
mcp-publisher validate server.json
mcp-publisher publish server.json
```

Read the published version back and compare its endpoint, description, version and identity. Publication receipts alone are insufficient.

## Glama — public listing, ownership verification pending

- [Public connector listing](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory)
- [Public badge](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory/badges/score.svg)
- [Submission and ownership requirements](https://glama.ai/mcp/faq)

Verified in the user's existing signed-in Chrome profile on **2026-10-24**. Glama automatically imported the official Registry entry with the correct title, description, Streamable HTTP transport and endpoint; no duplicate submission was made. The connector is public and its badge returns valid SVG. Glama currently reports **Not tested**, so this is not a Glama health-check success claim.

The signed-in account's public ownership proof is [`frontend/.well-known/glama.json`](../frontend/.well-known/glama.json), already served at `https://urbangametheory.xyz/.well-known/glama.json` and byte-verified against the file. It is a public claim token, not an account/session credential. Keep it published for verification to remain valid.

The final **Check HTTP file** action has not completed. Automatic approval review rejected it because it grants listing-management access and requires confirmation at action time; an explicit confirmation is pending. After approval, verify the claim in Glama, then configure No Auth and run the connector health check if available. Do not present ownership as claimed until the UI confirms it.

## Awesome Remote MCP Servers — submitted for review

- [Contribution requirements](https://github.com/punkpeye/awesome-remote-mcp-servers/blob/main/CONTRIBUTING.md)
- [Submission PR #2810](https://github.com/punkpeye/awesome-remote-mcp-servers/pull/2810)
- Category: **Real Estate**, alphabetically under Urban Game Theory.

Submitted on **2026-10-24**. The pull request adds exactly three lines to `README.md`, with no deletions. Its automated **check-submission** check passed and applied **endpoint-ok** and **has-connector** labels. The submitting account starred the repository as required. The PR is open, not merged.

```md
- [Urban Game Theory — Consensus Builder](https://urbangametheory.xyz) `https://urbangametheory.xyz/mcp`
  [![Urban Game Theory MCP connector](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory/badges/score.svg)](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory)
  🔓 - Inspect real parcels, draft and edit urban plans, compare alternatives, and share 2D/3D designs.
```

The contribution commit is `c379ca81396aa9e29c7d059425850dfa31e782f1` on the dedicated `add-urban-game-theory-mcp` branch of the directory fork. Do not create a duplicate PR while review is pending.

## mcpservers.org — submitted for review

Submitted through the [browser form](https://mcpservers.org/submit) on **2026-10-24** using the explicit **Free / $0** option. The form included the shared name and description, Design category, homepage, official Registry name, remote endpoint, No authentication, and the contact email supplied by the user for this submission. The address remains outside this repository.

The browser displayed **“Submission Successful!”**, identified Urban Game Theory — Consensus Builder, and stated review within two weeks with an email notification on approval. This confirms receipt; the listing is not yet verified as published. Do not submit a duplicate while review is pending.

## MCP.Directory — submitted for review

Submitted through the [browser form](https://mcp.directory/submit) on **2026-10-24**. The form displayed **“Server Submitted!”** and said it would review the server before publication. This is a submission receipt, not evidence of a live listing.

- Source supplied: https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair
- Description supplied: “Inspect parcels and edit urban plans. Remote MCP: https://urbangametheory.xyz/mcp”
- Optional email and package fields: blank; no npm package has been published.

The source branch is intentional: the public MCP implementation is on `colosseum-worlds-fair`, rather than `main`. The service also describes auto-discovery from the official Registry. Do not submit a duplicate while this review is pending.

## Other directory checks

- The `wong2/awesome-mcp-servers` README directs submissions to mcpservers.org and explicitly declines pull requests. Use the website form above.

## Excluded

- MCP.so: its submission form currently requires payment; do not submit.
- Smithery: connection services are being retired on 2026-10-31; defer until the replacement directory's submission path is clear.

## Verification on 2026-10-24

- Official publisher manifest validation passed.
- Public domain proof matched the tracked proof bytes; nginx configuration validation and reload passed.
- Live MCP initialize succeeded over Streamable HTTP; discovery returned 30 tools, 12 resources and 5 prompts.
- Official Registry API returned the exact manifest as active, latest version 0.3.0; browser search displayed the published entry.
- MCP.Directory's browser form confirmed receipt of the submission; publication remains pending review.
- mcpservers.org's browser form confirmed successful submission on the Free plan; publication remains pending review.
- Glama's imported public listing was verified in the user's Chrome profile; ownership remains pending explicit confirmation and Glama health remains Not tested.
- Community directory PR #2810 adds exactly one three-line entry; its automated submission check passed.
- No paid evaluation, paid listing, application release, or full test suite was run for this metadata-only change.
