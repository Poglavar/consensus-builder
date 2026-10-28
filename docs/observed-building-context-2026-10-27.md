# Observed building context

Inspecting a source building shows Building and its cadastral parcel in both click stacks.
Nearby authored designs and their Plans remain in the hit inventory but do not imply membership
of that source building. Explicit demolition metadata supplies an Affected by design link; choosing
it opens the design's authored context. Mere overlap supplies no such relationship.

Changing from a design to an observed building disposes the previous membership session and
invalidates pending callbacks. A subsequent source refresh cannot restore that design's Plans.
The 3D hit adapter retains the existing demolition metadata for the shared relationship model.

MCP parity: this changes read-only inspection and navigation. PlanRecord still contains design
CIDs, and no source building becomes an authored plan member. No editable field, allocation,
ownership operation, record format, validator or MCP authoring primitive changes.

Targeted verification:

| Type and scope | Result |
| --- | --- |
| Headless unit, four stack files, initial run | 89 passed; one new fake-DOM assertion included an obsolete detached stack root |
| Headless unit, four stack files, corrected assertion | Completion output was lost; superseded by the final six-file run |
| Final headless unit, model, panel, 3D stack, relations, hits and locale coverage | 128 passed in six files |
| Headed Playwright, observed-building-context.spec.ts | Three cases passed: real 2D selection, desktop and phone 3D-stack DOM wiring |
| Manual headed Chrome, real local API | Source building opened as Building → Cadastral parcel; seven cadastral features and five building footprints returned for the review area |

No full suite ran and no run was stopped. Screenshots were visually reviewed on desktop and phone.
The 2D browser case uses the real app with mocked source responses and verifies that inspecting the
building does not mutate designs or agreements. The 3D cases exercise the real stack DOM and CSS,
including navigation through the impact link; they do not boot or validate the 3D renderer.

Concurrent work also edits the panel, 3D scene adapter, asset entrypoints, vocabulary and locale
dictionaries. Those mixed files remain uncommitted rather than including another session's edits.
