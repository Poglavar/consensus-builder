# Click-stack membership navigation validation

This change makes plans and agreements independent stack sections above Design in both map
views. Relationship links live inside their section, wrap, and omit a redundant singleton link
when its target is already the sole item in another visible section. Multiple peers use a native
selector. Section icons and connectors share an axis and use theme tokens.

The records are unchanged: plans and agreements independently reference designs. Inspection reads
exact published revisions and highlights their combined geometry without importing or applying
members. An explicit member link can import a parked design for inspection; Open plan remains the
action that loads its saved composition. Publishing an agreement does not establish consent.

## Browser checks

A dedicated background, headed Chrome session exercised the local frontend and a read-only local
review API using real saved plan and agreement records:

- A 17-design plan highlighted 51 primary features in 2D; its full authored extent also appeared in
  3D. Expansion and collapse retained the selection. Inspecting it left the local design count at one.
- Clicking a previously unloaded lake member opened its Design section and left Apply to map
  available. Peer selection appeared inside the section.
- At 390 px width, the document and relationship groups had no horizontal overflow. Other section
  headers remained reachable while the expanded body scrolled. Desktop checks used 1180 px width.
- A published community agreement displayed its name, meaning, details link and both member
  geometry features in 2D and 3D. A singleton member link was omitted because Design already
  represented it, including when raw 3D hits reported the same design twice.
- Parent links retained the configured backend override.

The existing-building source failed in the plan scene. These checks establish authored-plan and
stack behavior; they do not establish readiness of surrounding existing-building data.

Real agreement responses exposed a field collision absent from simplified fixtures: lifecycle
`status: "active"` was mistaken for an empty-state marker. The marker is now
`membershipPlaceholder`, with active/expired/cancelled response-shape regressions.

## Targeted headless unit runs

All runs named exact test files, used at most two workers, and completed. No full unit or browser
suite was run. Routine test work used a `gpt-6-luna` worker with low reasoning; Git remained with
the primary agent.

| Files (under `backend/test`) | Result |
|---|---|
| `design-memberships`, `click-stack-model`, `click-stack-relations`, `optional-tools-loader` | Initial 43 tests: three fixture expectations corrected; rerun 43 passed. |
| `click-stack-panel`, `three-click-stack` | 45 passed; after adding revision and late-focus regressions, 47 passed. |
| `design-memberships`, `click-stack-model`, `click-stack-hits` | 45 passed, including exact identity, verified geometry and detached-host completion checks. |
| `click-stack-relations`, `optional-tools-loader`, `named-plans`, `proposal-details-readonly`, `design-tokens` | 285 tests: 265 passed, 15 API cases blocked by sandbox socket permissions, five stylesheet audit failures. |
| `named-plans` with temporary local-listener permission | 21 passed. |
| `design-tokens`, after removing the stack's remaining palette and layering literals | 238 passed, three pre-existing failures in unchanged `activity-feed.css` and `mobile-sheets.css`. Confirmed those violations in HEAD. |
| `design-memberships`, with real lifecycle-status fixtures | Initial wording assertions corrected to the configured copy; rerun 23 passed. |
| `design-memberships`, with duplicate raw 3D-hit coverage | 24 passed. |

The final targeted behavioral coverage totals 140 passing tests across nine files. The separate
stylesheet audit still reports the three unrelated baseline violations above.
