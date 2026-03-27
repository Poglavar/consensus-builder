# Memory

- 2026-03-26: Area monitor drawing now sets its own global drawing-mode flag and temporarily removes parcel click handlers while active. Rationale: parcel layers were intercepting clicks that needed to reach the map, so matching the existing road/track interaction model was the least risky fix.
- 2026-03-26: Area monitor rendering now separates “reapply styles” from “fly to monitor”, and monitor open/close flows go through explicit routing helpers plus a list endpoint/modal. Rationale: parcel refreshes were causing unintended camera jumps and monitor cleanup needed one reliable path that resets overlay and parcel highlighting together.
