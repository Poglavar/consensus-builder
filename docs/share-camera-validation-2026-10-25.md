# Camera options for map sharing

Branch: `colosseum-worlds-fair`.

The Designs sharing panel still requires publication of every included design.
The separate MCP `draft` parameter resolves a temporary server-stored review
artifact, accessible to a holder of its opaque URL. That mechanism is unchanged;
ordinary generated share URLs now explicitly remove any private draft reference.

In either 3D view, sharing exposes independent camera and arrival-rotation choices.
The camera is captured when the panel opens, before selection can affect the view.
Rotation defaults off and uses the existing orbit focal point. A saved camera no
longer prevents an explicitly requested orbit. Pointer/touch, wheel and keyboard
input stop it; input during scene construction or Google terrain loading cancels
the pending orbit. Reduced motion remains still. The first canvas press stopping
an active orbit does not also select a map object.

Google rotation begins only after the mesh is seated. Rotating during tile
refinement continually changes the requested content and can prevent the stable
load needed for alignment. A real-source inspection exposed this during testing.

`plan/v1` gains the optional boolean `view.rotate`; its creator writes the chosen
value and its schema and MCP input agree. It is part of snapshot identity, while
unnamed links use `rotate=1` or `rotate=0`. No flag means no arrival rotation.
The frontend and backend need deployment together for the new named-plan field.

## Verification

No full suites ran and no test runs were stopped.

- Headless unit tests: four explicit files (`map-share`, `named-plans`,
  `plan-record-schema`, `mcp-named-plans`) passed 46 tests. The schema file was
  rerun after adding boolean/null parity cases: all 6 passed.
- Initial headless Playwright run of the eight new sharing/arrival checks:
  2 passed, 6 failed. One startup failure coincided with an unrelated shared-file
  syntax edit; the other failures exposed overstrict camera precision assertions
  and the window keyboard handler consuming input before a document listener.
  After corrections, all 8 passed.
- Targeted headed Playwright: both sharing panels and Google key cancellation
  passed, 3 checks. These exercise the actual tiles renderer with controlled tiles.
- After the Google seating fix, four targeted headless Playwright arrival checks
  passed, including a held tile response proving rotation waits for alignment and
  an input during that hold preventing a later start.
- A dedicated background headed browser loaded real Hyderabad Google imagery via
  the public backend. Source metadata returned HTTP 200; Google terrain seated,
  reached complete load with no failed requests, and the camera then rotated.
  Keyboard input stopped it. The actual Share panel and its two checkboxes were
  inspected over the imagery; its generated map link contained no `draft` token.
  The inspection browser was closed.

No deployment or publication was performed.
