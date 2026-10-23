Unless overriden here, follow instructions from ../AGENTS.md (the workspace-wide file one level up)

Domain terminology is maintained in [vocabulary.md](vocabulary.md). Read it when changing domain
records or behavior, and update it in the same change when a definition, relationship, identity,
state, unit, or source of truth changes. Keep observed behavior separate from proposed terminology;
preserve unresolved audit findings until an explicit decision and implementation resolve them.

This project is experimental. Prefer one coherent current contract over preserving existing data.
Make changes in small, verified steps; do not add legacy/new flow branches, compatibility readers,
or migrations solely to retain old experimental records. Record intentional contract breaks and
recreate affected records when needed instead of maintaining parallel implementations.

Before sharing a local preview URL, verify the listening checkout, the browser's resolved backend,
and real source-data responses for the intended flow, including its required capabilities. A frontend
HTTP 200 alone is insufficient. If no local API is running, include the supported `backend` URL override explicitly and verify it in the browser.
