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

## Glama — sign-in required

- [Connector catalogue and Add Server](https://glama.ai/mcp/connectors)
- [Submission and ownership requirements](https://glama.ai/mcp/faq)

The browser's Add Server action currently requires sign-in. Submit the endpoint as a **Connector**, using the copy above and No Auth. Check for an imported Registry listing before submitting a duplicate. Verify the endpoint passes Glama's health check, then record its actual listing URL here.

For ownership, use the exact token issued by the signed-in Glama account. Put only its public claim JSON in `frontend/.well-known/glama.json` and serve it at `https://urbangametheory.xyz/.well-known/glama.json`; the exact route is already installed. Do not invent a claim token or use an account/session credential as proof.

## Awesome Remote MCP Servers — depends on Glama

- [Contribution requirements](https://github.com/punkpeye/awesome-remote-mcp-servers/blob/main/CONTRIBUTING.md)
- Suggested category: **Real Estate**, alphabetically under Urban Game Theory.

Prepare the following entry only after the actual Glama connector URL exists. Replace `ACTUAL_CONNECTOR_PATH` with its real namespace/name before submission; the list checks that the badge resolves.

```md
- [Urban Game Theory — Consensus Builder](https://urbangametheory.xyz) `https://urbangametheory.xyz/mcp`
  [![Urban Game Theory MCP connector](https://glama.ai/mcp/connectors/ACTUAL_CONNECTOR_PATH/badges/score.svg)](https://glama.ai/mcp/connectors/ACTUAL_CONNECTOR_PATH)
  🔓 - Inspect real parcels, draft and edit urban plans, compare alternatives, and share 2D/3D designs.
```

The submitting GitHub account must star the upstream repository. Fork it, add one entry, open the pull request, and verify its handshake and badge checks. Record the pull request URL and distinguish submitted from merged.

## mcpservers.org — prepared, contact email required

The [submission form](https://mcpservers.org/submit) offers an explicit **Free / $0** review option. The browser form was prepared with the shared name and description, Design category, homepage, official Registry name, remote endpoint, and No authentication. Free remains selected. Submission requires a contact email, which must be supplied by the user rather than guessed or extracted from an unrelated account. Keep that address out of this repository.

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
- No paid evaluation, paid listing, application release, or full test suite was run for this metadata-only change.
