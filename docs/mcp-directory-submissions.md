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

## Glama — public, ownership verified, healthy

- [Public connector listing](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory)
- [Public badge](https://glama.ai/mcp/connectors/xyz.urbangametheory/urban-game-theory/badges/score.svg)
- [Submission and ownership requirements](https://glama.ai/mcp/faq)

Verified in the user's existing signed-in Chrome profile on **2026-10-24**. Glama automatically imported the official Registry entry with the correct title, description, Streamable HTTP transport and endpoint; no duplicate submission was made. The connector is public and its badge returns valid SVG. The listing now displays **Ownership verified**, **Healthy**, **MCP 2025-11-25**, and **30 available tools**. Its displayed last-tested time is **2026-10-24 18:46**; the tool-definition score is still being calculated.

The signed-in account's public ownership proof is [`frontend/.well-known/glama.json`](../frontend/.well-known/glama.json), already served at `https://urbangametheory.xyz/.well-known/glama.json` and byte-verified against the file. It is a public claim token, not an account/session credential. Keep it published for verification to remain valid.

After the user's explicit approval, **Check HTTP file** completed and the public UI confirmed ownership. The earlier automatic approval rejection is resolved. No private credential, payment, new sign-in, or additional permission change was required. Keep the public claim file published to retain verification.

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

## Docker MCP Catalog — submitted for review

Submitted on **2026-10-25** as [PR #6080](https://github.com/docker/mcp-registry/pull/6080). The dedicated fork branch `add-urban-game-theory-mcp` adds only `servers/urban-game-theory/server.yaml`, `tools.json` and `readme.md`; its contribution commit is `658b9ffb8ee2c178d8f6e4c0eb158321c4bb79d0`. It uses the documented remote-server contract: Streamable HTTP, no OAuth, and no container build. The local source files are in [`directory-submissions/docker/urban-game-theory`](../directory-submissions/docker/urban-game-theory).

The PR is open, not approved or published. At the last check no CI results were attached. A stock MCP client discovered all 30 tools and successfully called `ugt_explain`. The public documentation and actual PNG icon were fetched successfully. The repository Go validator and a Docker gateway import were not run locally; the PR states that limitation rather than claiming they passed.

## Public plugin source — published

[Urban Game Theory plugin repository](https://github.com/Poglavar/urban-game-theory-plugin), latest prepared commit `1a9056246092b9a74c10f5550499774b51043dfd`, including the published privacy-policy link.

The package in [`plugins/urban-game-theory`](../plugins/urban-game-theory) is a public copy of the existing private planning plugin, with brand-only authorship, the same hosted endpoint, one planning skill and its references, the existing logo, and the project's Apache-2.0 license. The original private installation was not modified. Portable Agent Plugins clients use `mcp.json`; Open Plugins clients use `.mcp.json`. Both configurations identify exactly the same endpoint. No private app bindings, personal contact details, credentials, telemetry or executable hooks are included.

The GitHub file inventory was read back after publication. JSON, relative skill links, the square PNG and the identity scan passed. Marketplace installation and acceptance are separate from publishing this source; no Cursor IDE installation is claimed.

## Claude Connectors Directory — prepared, not submitted

The user's existing signed-in account successfully connected to `https://urbangametheory.xyz/mcp` without authentication and discovered **30 tools, 12 resources and five prompts**. The ten-step form is prepared through **Review and submit**, with the listing, categories, three use cases, business contact, authentication, data handling and Inspector evidence entered. The draft is saved in the existing browser tab, not a verified server-side submission. Keep the tab open until submission. Reusable public values are in [`directory-submissions/claude/listing.json`](../directory-submissions/claude/listing.json); account/contact details remain outside this repository.

The published [MCP privacy policy](https://urbangametheory.xyz/mcp-privacy.html) has been added to the form and the listing step now passes validation. The notice describes actual tool inputs, temporary bearer references, public publication, the private feedback inbox and Telegram notifications, infrastructure processing, retention limits and privacy requests. It does not invent a fixed retention period for operational logs or feedback. It is available in English, Spanish, Croatian and Serbian.

At the user's request, the existing [submission tab](https://claude.ai/directory/manage/new/connector) is left open at **step 9, Compliance** for the maintainer's seven policy acknowledgements. These remain unchecked. The draft is saved in that tab; use the existing prepared tab rather than assuming the URL alone transfers its state to another browser or a fresh tab. Submission remains pending the maintainer's acknowledgements and final review.

The portal flags `annotations.title` as missing on every hosted tool. A local server change now supplies matching top-level and annotation titles, including names generated for companion tools. Targeted headless unit tests (`test/mcp-server.test.js` and `test/mcp-http.test.js`) passed: **2 files / 18 tests**. This server metadata change has **not been deployed**, so the saved live scan still contains its original suggestions.

## Cursor Marketplace — submitted for review

Submitted on **2026-10-25** through the official [publisher application](https://cursor.com/marketplace/publish), after the user explicitly accepted the [Publisher Terms](https://cursor.com/marketplace-publisher-terms) and authorized the final click. The form used Urban Game Theory, the dedicated public plugin repository, the existing public logo, homepage and the business contact supplied by the user. Reusable listing values are in [`directory-submissions/cursor/listing.json`](../directory-submissions/cursor/listing.json); account/contact details remain outside this repository.

The browser displayed **“Thanks for applying”** and **“We've received your submission.”** This confirms receipt, not marketplace approval. The earlier form became responsive again without reloading; the automatic-review rejection of a reload was not bypassed. Do not submit a duplicate while review is pending.

## Cursor Directory community listing — submitted, security scan pending

Submitted on **2026-10-25** through the [community form](https://cursor.directory/plugins/new). The user granted the requested GitHub read-only email access. The expired initial sign-in was restarted through the ordinary sign-in flow; no extra grant was accepted by the agent. The importer detected exactly **one MCP server and one planning skill** from the public plugin repository. The submitted name and description match the shared listing copy.

The resulting [listing](https://cursor.directory/plugins/urban-game-theory-consensus-builder) currently says **“Scanning your plugin… it will appear publicly once the security agent finishes”** and **“This plugin is unpublished and hidden from the directory.”** Treat it as submitted, not publicly published. Optional logo upload was omitted because the Chrome extension requires an additional file-URL access setting; no browser permission setting was changed. Do not submit a duplicate while scanning is pending.

## Privacy-page publication on 2026-10-25

The user authorized creating a policy and adding its live URL to Claude. The three new static files from commit `4cba22ef3` were published to the existing website independently of the application release. The production vhost and served destination were verified first; the live MCP still used temporary server-side previews with the default 24-hour expiry when the notice was prepared. No private draft content or feedback rows were inspected.

Public HTML, CSS and translation JavaScript were read back and matched the committed bytes exactly, with the expected content types. The published page and all four language selections were verified in Chrome. Static checks confirmed translation-key parity, resolved page strings and no inline styles or scripts. This low-impact content change did not add or run a full test suite. The plugin README now links the live notice for reviewers and users.

## Grok — direct installation documented, catalogue submission unconfirmed

The official [connector documentation](https://docs.x.ai/grok/connectors) allows users to add a custom public MCP URL at `grok.com/connectors` → New Connector → Custom. No public catalogue-submission route was verified, so no listing or application was submitted. Do not describe a custom personal connection as a public directory listing.

## Verification on 2026-10-25

- Targeted headless MCP Inspector checks exercised all **30 hosted tools** against the public endpoint. **27 read/draft checks succeeded** and the **three external-write tools refused `confirm:false`**. No public content or feedback report was created.
- The first verified-fact check used an active agreement and correctly returned that no terminal fact existed. Retesting with an executed agreement returned the x402 challenge successfully, without paying it. This makes 31 Inspector invocations, not 31 distinct tools.
- No LLM API calls, payments, paid listings or full test suites ran. There was no application push or application release; only the requested privacy-page files were published to the website. Docker and plugin-source publication used GitHub API operations containing only the prepared public files.
- OpenAI and all Chinese directory submissions are explicitly deferred at the user's request.

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
- Glama's public listing confirms ownership verified and Healthy, with all 30 hosted tools indexed; the tool-definition score remains pending calculation.
- Community directory PR #2810 adds exactly one three-line entry; its automated submission check passed.
- No paid evaluation, paid listing, application release, or full test suite was run for this metadata-only change.
