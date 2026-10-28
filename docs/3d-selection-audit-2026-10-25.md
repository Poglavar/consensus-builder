# Model 3D selection

The first design pick previously isolated the design, framed its parcel or site, and recolored
the underlying parcel cyan. The click-stack focus also drew every object as a thin blue ground
boundary, including buildings. These effects made the selected object ambiguous.

Scene picks, section changes and design-list selections now preserve the camera and composition.
Explicit shared-link navigation still restores or frames the destination view. Selected buildings
and permitted massing use edges from their visible drawn volumes, with world transforms applied;
parcels and ground-only designs use their authored ground boundary. A yellow screen-space stroke
with a dark halo stays legible across zoom levels. It pulses unless reduced motion is enabled.
Parcel materials remain unchanged. Collapsing retains the current outline; Escape clears it.

The line addons load with the model capability. Unrelated concurrent edits to the HTML loader and
agreement flows were left untouched. The vocabulary selection definition was updated locally;
that mixed file is left uncommitted because it also contains another session's consultation terms.

## Verification

Every run below was targeted; no full suite was run.

| Run | Scope | Result |
| --- | --- | --- |
| Headless Vitest 1 | Click plan, click stack and parcel emphasis: 3 files | 20 passed |
| Headed Playwright 1 | 6 selection cases | Stopped after 2 failures; 4 did not run. One navigation timeout and one assertion on approximately 1e-13 camera rounding. Camera comparisons now use 1e-6 scene-unit precision. |
| Headed Playwright 2 | Same 6 cases | 5 passed; desktop building case exhausted its 30-second overall test budget during the selection check. Its edit/setup and interaction case now has a 60-second budget. |
| Headless Vitest 2 | Click plan, click stack, parcel emphasis, keyboard context, building display, road mode guard and 3D lifecycle: 7 files | 59 passed |
| Headed Playwright 3 | First building picks at 1280/390 pixels, repeated picks, parcel boundary/materials, collapsed section selection, near and distant design-list selection: 7 cases | 7 passed |

Manual headed Chrome verification opened the supplied Learning courtyard plan through the local
checkout against the production API: plan response HTTP 200, eight designs loaded, model scene
centered on the authored site. A garden click produced a ground outline with zero camera delta,
no isolation and no cyan fill. The animated yellow stroke changed width across live frames.
Desktop and mobile building screenshots showed volume edges rather than a parcel footprint.
The dedicated browser was closed after verification. No deployment was performed.

## Ground design versus parcel

Ground-only Design selections now add fine diagonal yellow hatching inside their authored
polygon, with transparent gaps and a dark edge on each stripe. The pattern is clipped to the
polygon (including holes), remains legible at different zoom levels and pixel densities, and
never replaces the surface material. Selecting the coincident formed or cadastral parcel removes
the hatching and retains only its boundary. Collapsing the selected Design retains the hatching;
volume designs keep their volume outline without a hatch.

Follow-up verification: 20 targeted headless Vitest tests passed across the click plan, click
stack and parcel-emphasis files. Four targeted headed Playwright cases passed: first building
picks at 1280/390 pixels, a mobile park-design/coincident-parcel switch, and ground-design
collapse/parcel-switch/Escape behavior. Mobile screenshots were visually inspected: the park
surface stays visible between the stripes and has no interior pattern when Parcel is selected.
