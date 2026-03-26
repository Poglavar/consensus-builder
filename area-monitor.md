# Parcel Alerts — Monitoring Projects

## Core Concept

Allow users to draw a closed polygon on the map. All parcels touched/intersected by the polygon border, plus all parcels fully inside it, become **"project parcels"** — together forming a **"monitoring project"** (e.g. "Slavonska extension").

The city has to buy up all properties for a project. The goal of this feature is to **track acquisition progress** and alert stakeholders to ownership changes.

## Phase 1 — Frontend

### Drawing & Project Creation
- User draws a closed polygon on the map (must be closed to submit)
- All intersected + contained parcels are selected as project parcels
- **Limit: 200 parcels** per project
- User names the project (e.g. "Slavonska extension")

### Key Design Decision
Should this be a **new entity** or an **enhancement of existing proposals**? The project is essentially similar to a proposal in the system. Consider:
- Making it a proposal type / subtype
- Reusing proposal sharing, deep links, and views
- Or keeping it separate if the data model diverges too much
- **TODO: Review existing proposal functionality and decide**

### Shareable Deep Link
- Need a shareable URL that takes people directly to the project/proposal on the map
- Check if proposals already have deep links we can reuse

### Map Visualization
- Show the project polygon on the map
- **Color-code parcels by ownership status:**
  - **Color A** — parcels already owned by the city (purchased)
  - **Color B** — parcels NOT yet owned by the city (remaining)
  - (Phase 3) **Color C** — parcels currently listed on the market (ad parcels)

### Parcel Details
- Show dates when ownership changed, OR
- Provide links to oss.uredjenazemlja or other land registry records for each parcel
- Users visiting the deep link see current acquisition status at a glance

### Subscribe for Updates
- Add a "Subscribe for updates" email input box
- **Grey it out for now** (not functional until Phase 2 backend is ready)

## Phase 2 — Backend Alerts

- Backend piece to trigger an **email alert** when ownership changes for any parcel in a project
- We already trace parcel ownership changes via bots in cadastre-data
- Currently only parcel ownership via GraphQL works (needs verification)
- The ownership change detection is already there; we need to wire it to email notifications

## Phase 3 — Market Listing Integration

- Combine with "ad parcels" tracking (parcels listed for sale)
- Alert users if a project parcel has been put on the market
- Show such parcels in the frontend in a **third color** on the map
- This enables proactive acquisition — the city/stakeholders can act on listings

## Phase 4 — Structured Project Data & External Links

- Create the project as a **proper data structure** with the official project name (e.g. the name used in city planning documents)
- Connect each project to **external data sources**:
  - **EOJN link** — link to the public procurement notice if one exists (elektronički oglasnik javne nabave)
  - **SkyscraperCity thread** — link to the forum thread where the project is tracked/discussed by the community
- This turns the monitoring project into a hub that aggregates all relevant info in one place

## Technical Notes

- **cadastre-data**: Verify current state of parcel ownership tracking via GraphQL — is it working end-to-end?
- **Existing bots**: Already tracing ownership changes; need to understand what data is available
- **Proposal system**: Review current proposal model, routes, sharing, and map rendering to determine integration approach
