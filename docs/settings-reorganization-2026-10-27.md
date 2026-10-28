# Settings organization

The logo, application name and AI-friendly badge share one row in the fixed panel header.
The Settings dialog retains its accessible name. The middle content scrolls independently of
that header and the persistent build/update footer.

Appearance exposes theme choices directly. Data & assumptions offers Sources & adapters,
Valuation & costs and Parcel source information. Help & about offers How it works, User guide,
Sources & software, Contact, About and the existing feedback link. Credits, Contact and About
open shared large dialogs. Each dialog temporarily hosts the original reference node and restores
it on close, retaining the live source-credit renderer and unique element identities.

Advanced is the only accordion and resets to collapsed when Settings opens. It contains flat
Local browser data, Simulation and Diagnostics groups. Reset browser data sits last, separated
from those tools, with its existing confirmation/erase operation and a description of the local
records it deletes. Simulation gating now belongs to its own section: its switch cannot disable
the surrounding Diagnostics or Reset controls.

The redundant Navigation group is removed. The city chip still opens the globe, and the World view
palette command uses that same control and busy state. The keyboard shortcut and map search still
open the command palette. The retired Settings-only palette launcher and world-button handler are
removed. Help dialogs and valuation controls have current command entries; affected browser journeys
and source-control inventory entries use the new destinations.

MCP parity: no domain record, editable field, unit, validation or authoring operation changes.
Sources, economic settings, theme, simulation and ownership retain their existing editing paths.
Reference inspection is available through `SettingsPanel.openReference` and the command registry;
existing MCP authoring tools remain unchanged. The domain vocabulary requires no change.

Targeted verification:

| Type and scope | Result |
| --- | --- |
| Headless unit, maintenance, world entry, update wiring and locale coverage | 82 passed in four files |
| Headed Playwright, Settings at three widths, update flow and theme persistence | Five passed; two phone fixtures attempted the intentionally hidden dialog close button |
| Headed Playwright, corrected phone dismissal at 390px and 320px | Two passed |
| Headless unit, palette and command contracts | 52 passed; three stale assertions concerned the retired launcher, contextual Reload and class ordering |
| Headless unit, six targeted Settings/command/locale files | 134 passed; the new two-case file had an object-literal syntax error |
| Final headless unit, corrected reference/gating fixture | Two passed; 136 passing cases across the six files |
| Final headed Playwright, three-width Settings, keyboard palette and city-control recovery | Five passed |
| Manual headed Chrome, real local API | Brand/sections and 400px width confirmed; live credits retained one identity; seven parcel features and five building footprints returned |

No full suite ran and no run was stopped. Desktop, 390px and 320px screenshots were visually
reviewed. Browser checks cover a single brand row, no horizontal overflow, a stationary footer
during Advanced scrolling, modal return, live credits, economic settings and independent simulation
controls. The earlier passing update/theme cases verify the moved footer and directly visible themes.
Other affected browser journeys were updated mechanically but their whole files were not rerun.

Settings-specific controls and commands are registered. The global inventories still report
unrelated existing drift in other map/agreement controls and proposal command mappings; this
change does not repair those entries. Mixed HTML, locale and map files remain local where they
contain concurrent edits. No push or deployment was performed.
