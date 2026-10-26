Unless overriden here, follow instructions from ../AGENTS.md (the workspace-wide file one level up)

Domain terminology is maintained in [vocabulary.md](vocabulary.md). Read it when changing domain
records or behavior, and update it in the same change when a definition, relationship, identity,
state, unit, or source of truth changes. Keep it a glossary of current definitions and essential
relationships. Implementation notes, roadmaps, test results and change history belong in separate
documents. Keep observed behavior separate from proposed terminology; preserve unresolved findings
in the linked audit record until an explicit decision and implementation resolve them.

This project is experimental. Prefer one coherent current contract over preserving existing data.
Make changes in small, verified steps; do not add legacy/new flow branches, compatibility readers,
or migrations solely to retain old experimental records. Record intentional contract breaks and
recreate affected records when needed instead of maintaining parallel implementations.

## Authored copy

Authored plans and UI copy use plain names and descriptions. Do not add study/concept,
illustrative, not-adopted or planning-permission disclaimers: the tool is already for studies
and concepts, as the user explicitly requested.

## Local preview links — required

Every Consensus Builder localhost link given to the user MUST explicitly include the verified
`backend` query parameter, even when a local API is running or the browser has a saved override.
Include `city` and the intended location (`at`, plus camera/selection when relevant). Never rely on
port 3000 defaults, a saved city, or `cb_dev_backend_base` from a previous browser session.

Before sharing, verify the listening checkout, the browser's resolved `getBackendBase()`, and real
source-data responses for the intended flow, including required write capabilities. A frontend
HTTP 200 or backend health check alone is insufficient. Use the local API for flows needing local
backend changes or uploads; a verified production API may serve read-only source data.

Copy the complete tested URL into the final response. Do not shorten it by dropping `backend`,
`city`, or other required query parameters. Check the final link itself, not just the browser URL
used during testing. See [docs/development.md](docs/development.md#verified-local-preview-links).
