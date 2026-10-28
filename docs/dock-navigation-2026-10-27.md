# Desktop navigation and inspection clearance

Lists, Activity, Bets and map feedback retain their viewport-centred anchors when the inspection
column opens. The column reaches the bottom margin when it clears these controls horizontally.
Where they meet, it stops eight pixels above the highest visible control instead of shifting
navigation. Clearance follows actual bounds, including translated labels, wrapped messages,
idle status, view changes and resize. Phone sheets keep their existing navigation clearance.

The shared DockClearance controller computes the bottom inset from obstacle bounds. It observes
control sizing, status content and visibility, view classes, and the map's completed viewport resize.
Both click-stack frames and the other right-docked panels use that inset through the existing
shared CSS variable. The previous conditional horizontal recentering rule is removed.

MCP parity: this changes presentation and available panel height only. No authored record, field,
editing operation or validation changes; existing granular MCP editing operations remain sufficient.
No MCP schema or tool changes are needed.

Verification:

- Targeted headless unit tests: `dock-clearance.test.js`, five passed.
- Initial targeted headed Playwright run: two cases passed for both stack frames.
- The actual application exposed an extra-clearance timing issue after viewport resize; observing
  the map container fixes the delayed position update.
- Final targeted headed Playwright run: two cases passed, checking exact gaps, wide/narrow
  desktop resizing, delayed container-height updates, status removal and phone reset. Screenshots
  were visually inspected. These cases exercise real CSS and controller code without a map renderer.
- Dedicated headed Chrome also opened a real cadastral parcel in the actual 2D stack: navigation
  bounds stayed identical before and after opening. Wide desktop used the bottom margin; narrow
  desktop retained an eight-pixel gap above navigation when status was idle and an 8.8-pixel
  gap above a visible status message (fractional bounds round the inset up to whole pixels).
- The frontend and API listeners belong to this checkout. The explicit local backend resolved
  correctly in the browser; real parcel lookup returned one feature and design binding reported
  complete coverage, both HTTP 200.

No full suites were run and no runs were stopped. The entry-point registration and cache-version
edits in index.html share a file with concurrent work and remain uncommitted; other sessions'
changes are preserved.
