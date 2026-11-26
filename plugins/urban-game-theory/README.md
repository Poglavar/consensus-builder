<!-- Public plugin connecting compatible agents to the existing Urban Game Theory MCP endpoint. -->
# Urban Game Theory — Consensus Builder

Inspect real parcels, draft and edit urban plans, compare alternatives, and share 2D/3D designs.

This free, open-source Agent Plugins package contains one urban-planning skill and a connection to the existing hosted MCP server. It runs no local service and requires no API key, wallet or paid subscription to Urban Game Theory. Your agent client may have its own subscription requirements.

## Connect

Endpoint: **https://urbangametheory.xyz/mcp** · Transport: **Streamable HTTP** · Authentication: **none**.

Clients supporting Agent Plugins discover `plugin.json`, `mcp.json` and `skills/`. Open Plugins clients can use `.mcp.json`, which points to the same hosted endpoint. Cursor supports this format; see its [plugin documentation](https://cursor.com/docs/reference/plugins). Install this repository using your client's plugin installation flow. Directory review and marketplace approval are separate from publishing this source.

For a client that accepts a custom MCP server instead, add the endpoint above. A typical MCP configuration is:

```json
{
  "mcpServers": {
    "urban-game-theory": {
      "url": "https://urbangametheory.xyz/mcp"
    }
  }
}
```

Discover the live tools and inspect capabilities before planning. Available data and coverage depend on the site.

## Try it

- “Inspect this site and draft a housing concept with walkable streets and a park.”
- “Take this plan, lower the tower to 18 storeys, rotate it 15 degrees, and remove the lake.”
- “Add more trees to the park and revise the parcels north of the road into three-storey row houses.”

The agent composes granular inspection and editing tools to perform these requests. It should resolve ambiguous selections with you and show a revised preview before publication.

## Data and actions

Draft edits create private revisions; they do not change the original published design. Hosted draft references are temporary bearer links: keep them private. Public publication requires an explicit confirmation and can be permanent. The hosted MCP never signs wallet transactions or makes payments. Concepts do not establish planning permission or ownership.

The plugin reuses the hosted server and supplies no authentication credentials. It contains no telemetry or executable hooks of its own. Requests sent through the MCP connection are processed by Urban Game Theory; the host agent's own data policies also apply.

## Help and source

- [Website](https://urbangametheory.xyz)
- [Feedback and bug reports](https://urbangametheory.xyz/feedback.html)
- [MCP privacy policy](https://urbangametheory.xyz/mcp-privacy.html)
- [MCP editing guide](https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/docs/mcp-editing.md)
- [Server source](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair/backend/agents)

Version 0.1.0 · Apache-2.0; see [LICENSE](LICENSE).
