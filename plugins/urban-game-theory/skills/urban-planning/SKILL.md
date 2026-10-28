---
name: urban-planning
description: "Use when the user wants to create, develop, compare, or refine an urban plan, site plan, or master plan with Urban Game Theory. Supports planning briefs, spatial options, scenario assessment, and explanations for planners, academics, NGOs, neighbourhood organizations, city councils, and real estate developers."
---

# Urban planning with Urban Game Theory

Help the user turn a place and a set of priorities into a concrete, reviewable plan. Use the connected Urban Game Theory MCP server at `https://urbangametheory.xyz/mcp` for the planning operations it actually exposes. Match the depth of work to the site, the decision, the evidence, and the user's intended audience.

## Establish the available tools

Discover the server's current tools and read their actual descriptions, input schemas, and outputs before choosing an operation. Use the host's tool discovery facilities; do not guess function names, argument names, data coverage, export formats, or resource IDs. A website feature is not evidence that an equivalent MCP tool exists.

Identify which available tools can retrieve site context, inspect plans, construct or edit geometry, evaluate alternatives, display results, and export deliverables. Skip capabilities that are not exposed. Resolve existing project, plan, and scenario identifiers from returned records rather than inventing them. When possible, inspect an existing plan before changing it.

The configured transport is Streamable HTTP and the creator confirmed that no sign-in is required. If connection or authentication fails, report the actual failure and use the host's connection flow where applicable. Do not ask for secrets in chat or silently switch endpoints. Continue useful briefing or drafting work, while clearly identifying any spatial work that remains unverified.

## 1. Frame the brief

Start from context already supplied. Ask only for information that materially affects the next step, and continue independent work while waiting. Use [the brief guide](references/planning-brief.md) as needed.

Establish the location and jurisdiction, site or study boundary, plan scale, intended decision, key programme requirements, and main constraints. Do not assume that a place name identifies a precise boundary. Resolve ambiguous places before retrieving or editing spatial data. When no exact boundary is available, use a clearly labelled provisional study area only when appropriate to the task.

Use sensible, explicit assumptions for reversible design choices. A general plan request normally calls for a draft that can be refined, not a long questionnaire. Adapt terminology and deliverables using [the audience guide](references/audiences.md); stakeholder type is not evidence of that stakeholder's preferences.

## 2. Assemble a baseline

Retrieve the available site, parcel, building, street, land-use, environmental, and infrastructure context through the discovered tools. Request only the extent and detail needed. If data is absent or incomplete, say so; missing features are not evidence of vacant land or absent constraints.

Track source, date, coverage, coordinate reference system, units, and known limitations for material inputs. Distinguish surveyed or authoritative boundaries, mapped records, inferred boundaries, and user sketches. Do not describe inferred geometry as a legal parcel boundary. Verify the jurisdiction and source before describing a planning control as applicable; do not infer compliance from geometry alone.

Keep existing conditions distinct from proposals. Use the tool's required CRS and coordinate order. For standard GeoJSON, use longitude/latitude in WGS84 unless the tool explicitly specifies another convention. Use a suitable projected CRS or geodesic method for measurements; never measure metres or hectares directly from angular degrees.

## 3. Develop the plan

Use the tools to create or refine the plan where supported. Reuse the user's existing project and preserve a recoverable baseline when scenario/version features are available. Perform requested draft work without repeatedly asking for approval of routine reversible steps.

For a site plan, address access, pedestrian connections, building arrangement and massing, use mix, open space, servicing, landscape, and relevant site constraints at the appropriate level of detail. For a master plan, also address street and block structure, centres, density distribution, public facilities, blue-green infrastructure, connections beyond the boundary, and implementation phases.

When alternatives would help the decision, develop a small set of meaningfully different options and explain the design choices. Follow an explicitly requested single scheme instead of forcing alternatives. Do not present generated geometry, renderings, or numbers as tool outputs unless those outputs were actually returned or saved.

Inspect the result of each material edit. Use available geometry validation and previews to check boundary containment, intersections, disconnected access, missing geometry, and unintended overlaps. Show the actual map or plan when the server provides one; preserve exact returned URLs and identifiers. If a map cannot be generated, provide a clearly labelled conceptual diagram or written spatial brief rather than implying a map was produced.

## 4. Compare outcomes

Use [the assessment guide](references/assessment.md) for consistent units, definitions, and comparison structure. Evaluate the priorities the user actually set. Where evidence supports them, compare capacity, built form, movement, public space, environmental performance, infrastructure, delivery, and distribution of benefits and burdens.

Separate calculated results, estimates, assumptions, and unknowns. Explain the basis of estimates. Do not fabricate travel times, yields, costs, regulatory limits, environmental effects, community support, or simulation results. Use the same boundary, denominators, and methods across alternatives, and explain unavoidable differences.

Make trade-offs visible. Do not assign a single score or recommend a winner using hidden criteria or weights. Include the existing or reference condition where available. Stakeholder interests can conflict; represent their stated positions accurately and record unresolved issues.

## 5. Deliver something usable

Provide a concise planning package appropriate to the request:

- The site and brief, including material assumptions.
- The resulting plan or options, with actual map, view, or file links where available.
- A comparison of relevant indicators, with definitions and source notes.
- The spatial rationale, principal trade-offs, and unresolved decisions.
- Phasing or next steps needed to develop the chosen direction.

Export requested formats only when the available tools support them. Verify that an export or saved artifact exists before describing it as delivered. For drawings, include scale or scale limitations, orientation, legend, and boundary information when supported. Retain the plan/scenario IDs needed to resume work.

Distinguish a concept or draft from an adopted, approved, or construction-ready plan. Keep this distinction proportionate to the work; do not replace useful planning with generic disclaimers. A request to draft a plan does not itself authorize public publication, official submission, stakeholder messaging, financial transactions, or changes to third-party records. Follow the user's actual authorization and the host's permissions for those separate actions, preparing a concrete reviewable result first when approval is needed.
