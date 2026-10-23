# Mobile site audit

## Agreed interaction

The user chose the same top-handle resize pattern throughout mobile sheets. Map context opens at half-height; navigation lists, Settings and long forms open expanded. Drag up for more space, down for less, and below the compact limit to close. Tapping alternates half and expanded height. Arrow keys resize, Home/End choose compact/expanded, and Escape closes.

The handle uses the surface's original close/cancel handler. It does not remove a record, apply a draft, save a form, connect a wallet or submit a transaction. Hosted cards share the outer sheet's handle. A second visible X is omitted, while its keyboard/assistive close action remains available. Short confirmations keep their direct action buttons and do not get a handle.

Current conventions are maintained in [design-language.md](design-language.md#phone-layout).

## Findings and changes

| Finding | Result |
| --- | --- |
| Dock panels mixed 50%, 66% and fixed heights; dialog forms used a separate mobile convention. | Existing `MobileDockSheet` now owns the common resize/dismiss interaction for map panels, navigation, forms and supporting-page dialogs. Shared mobile CSS owns their geometry. |
| Agreement had a close-only handle while other panels had resize-only handles. | The same gesture, tap and keyboard behavior now applies across surfaces. |
| Headers carried close, minimize and editor-fold controls alongside short titles. | Handle-enabled headers omit the second visible X. Geometry editors use the handle rather than another mobile fold button or title-tap behavior. |
| Settings scrolled more than 2,100 px of content through a roughly 528 px body. | Settings opens expanded, retains internal scrolling, and can be resized when map context is wanted. |
| Designs, Bets and Activity had 28 px buttons, and some compact confirmations remained 40 px because of CSS specificity. | Shared mobile buttons and compact controls have 44 px minimum touch areas. Form text is at least 16 px. Supporting-page back navigation has a larger tap area. |
| Larger touch controls and the handle reduced the previously repaired Designs list. | Trimmed source/action padding without shrinking controls. The previous full-card and list-space regression check is retained. |
| A dock-class check assumed the map was covered even after resizing a sheet down. | MapShell uses the actual sheet position to decide whether the map is covered and where credits belong. |
| Keyboard/visual-viewport changes could leave a resized form or its footer behind the keyboard. | Height and bottom offset follow the visual viewport. Keyboard space is not subtracted twice when re-clamping. |
| Dynamically removed dialogs could retain observers. | Removed surface observers disconnect; moving a hosted card between connected containers does not dispose it. |
| Parcel coverage and status log had a header X and footer Close. | Mobile surfaces use the shared handle and keep useful footer actions, omitting duplicate Close buttons. |

## Surface coverage

| Family | Coverage |
| --- | --- |
| Main map navigation | Opened and measured Layers, Buildings and massing, Measure, Designs, Bets, Activity and Settings. Verified resizing, internal content space, dismissal and trigger state at 320 and 390 px. |
| Map context | Parcel/design click stack, agreement panel/editor, watched-area detail and temporary site panel. Verified that dismissing preserves saved agreements/applied designs and discards only temporary site state. |
| Road and shape editors | Road panel and nested cross-section editor at 320 px. Verified handle access, visible footer, cancellation and restoration of draft profile state. |
| Model 3D | Resized and closed Layers while the actual model scene remained active. The same map-sheet controller also governs Sun and realistic-view layers. |
| Long forms | Real source-settings UI and approval setup. Verified expanded layout, reachable actions, cancellation, short landscape, and a simulated software-keyboard visual viewport after explicit resizing. |
| Identity and wallet choices | Opened and dismissed profile and wallet picker. No identity change or wallet connection. Confirmed short confirmations retain direct, equal-width touch actions. |
| Supporting-page dialogs | Shared styles/controller loaded alongside the existing primitives, including coverage integration, standalone lens and explorer pages. |
| Static/reference/presentation pages | All 27 supporting HTML pages checked for a visible main heading and document-width containment at 360 px. Tables retain local scrolling rather than forcing whole-page horizontal scrolling. |
| Source-reviewed surfaces | Generated block browser, critique, mint/funding forms and other CbDialog consumers use the same controller/style family. Their external operations were not executed by this layout audit. |

The supporting-page containment check includes actor and transaction explorers, lens, feedback, coverage, source formats, urban planning, roadmap, hackathon demo, three decks, twelve English/Croatian guidance pages, two vocabulary pages and 404.

## Visual and functional evidence

Dedicated headed Chrome, opened in the background, was used for the map and representative source-form and Actor explorer screenshots. The main preview resolved the explicit production backend override and real Birmingham data. Initial measurements included:

- Settings: 590.8 px sheet, 528 px body, 2,126 px scroll content in an 844 px viewport.
- Designs source/filter actions, Bets filters and Activity tabs: 28 px high.
- Buildings and massing reroll control: 36 × 36 px.

Afterward, map tools opened near half-height and navigation/Settings near full available height. A real pointer drag dismissed Settings, reset its trigger to `aria-expanded="false"` and removed the open-sheet state. The source form filled the available height, with a scrolling body and reachable action footer. Actor explorer remained readable and contained at phone width.

Browser checks used Chromium phone viewports, including 320 × 640, 360 × 640, 375 × 812, 390 × 844 and 640 × 360. Software-keyboard behavior was simulated through the visual viewport; this is not a claim of physical-device keyboard testing. The previously deferred Brave-only thin line was not reproduced or changed.

## Test record

All executions were targeted headless Vitest or targeted headless Playwright. No full suite was run and no test run was stopped.

| Run | Result |
| --- | --- |
| Controller unit worker | Initial 16-test run had four fake-DOM gaps; corrected and passed. Later contract update had one stale exclusion assertion; corrected and passed. |
| Initial shared units | Five files, 73 tests: 71 passed; two old layout/coverage assertions failed. Updated for actual sheet position and shared outer-card sizing. The two-file recheck passed all 32 tests. |
| Viewport/observer units | Six files, 75 tests: one classic-script fake panel lacked `style`. Corrected fake DOM and added viewport initialization/observer cleanup coverage; controller file passed 17 tests. |
| Final shared units | Six files, 76 tests passed, including dialogs, fixed-height behavior, layout contract, MapShell and on-map editor. |
| Initial browser audit | Five scenarios passed, including all 27 supporting pages. |
| Road/model browser checks | Two scenarios passed. |
| Desktop/mobile dock recheck | Ten scenarios: nine passed; one old test searched for the retired planning-source inspector instead of the current design click stack. Corrected selector; recheck passed. |
| Context/landscape checks | Three scenarios passed: design context, watched-area/site cleanup and short landscape form. |
| Profile/wallet/confirm | First run exposed an actual 40 px confirmation-button override. Corrected; profile/wallet and source/approval form checks both passed. |
| Keyboard viewport | Source/approval form passed before and after explicitly resizing prior to simulated keyboard appearance. |
| Previous Designs-space regression | Initial check was 2 px below the established list-space threshold after larger controls. Trimmed surrounding padding and rechecked, preserving full-card visibility and always-visible actions. |
| Source contract | Matches 864 control sites. Syntax and diff-whitespace checks pass. |

The bounded source inventory and unit-fixture work used two `gpt-6-luna` workers; implementation, browser checks and Git ownership stayed with the primary agent.

## Limits and follow-up

- Layout containment across supporting pages does not validate every backend, chain or external-service operation.
- Minting, funding, trading, real wallet connections, AI generation and feedback submission were not performed. Their shared mobile frame was source-reviewed; operation-specific usability still warrants physical-device sessions.
- Browser-level back gestures, device safe areas and software keyboards should be exercised on real Android Brave/Chrome and iOS Safari. The layout contract, touch targets and simulated viewport behavior are covered here.
- Desktop layout is preserved; its existing dock-frame regression checks passed. Supporting pages keep their existing information structure.
