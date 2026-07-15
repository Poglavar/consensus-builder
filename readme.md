Urban Game Theory -- Toolkit for Collaborative Urban Planning
https://urbangametheory.xyz

This is a toolkit for collaborative urban planning.

Experimental satellite-image parcel recognition lives in
[`parcel_recognition/`](parcel_recognition/README.md): a vision LLM proposes
parcel seeds, SAM 3 extracts pixel masks, and the CLI writes an image with the
inferred boundaries overlaid.

The UI also has an **Anywhere (AI parcels)** city mode. Enter WGS84 coordinates
or use geolocation; at zoom 16+ the normal parcel grid requests provisional
boundaries from `GET /parcels/inferred`. Configure the backend with
`PARCEL_INFERENCE_URL` to connect the viewport to an imagery/model service.

The design goal is to use crypto tools and learnings to create a tool that allows users to collaboratively plan and design their urban spaces.

The application is a very light web application with optional and minimal use of its own backend server.

Terminology notes:

- A key concept is a Proposal
- Plans are (unordered) collections of proposals
- Parcel is a geographically bounded piece of land
  - all land is covered in parcels
  - parcels never overlap
  - parcels have owners
- A Block is a group of parcels fully enclosed by public-access roads or track (corridor) with vehicular access. Within the block exist only footpaths (bicycles too?). A very large block will have various internal crosspaths, but if these are not through-traffic it is still a block. If you can pass through a block on a public access road it is actually two blocks, not one, even if from the air it looks like a block otherwise.
- Parcels do not (directly) descend from parcels, but from proposals. Proposals do not (directly) descend from proposals, but from parcels.
- Parcels have ancestor/descendant proposals
- Proposals have parent/child parcels

List of UI objects.

- modal: takes over the input, is large (most of screen), lots of functionality
- dialog: takes over the input, is small, little functionality, can be alert only
- panel: a UI element that takes only a part of the screen and doesn't take over the input

Modals:

- Agent Details
- Proposal List

Panels:

- Parcel Info
- Proposal Details
- Block Info
- Sidebar

Dialogs:

- Share proposal dialog
- Mint parcels as NFTs dialog

Object lifecycle (the SimCity model):

- Drawing or clicking a Build tool creates an APPLIED object on the map immediately — auto-named, no dialogs. What is on the map IS the draft: it stays editable (geometry, cross-section, width) until it is proposed.
- Objects can be Unapplied (kept in the proposals list, removed from the map), edited in place, or deleted. Unapplied proposals render nowhere except as a preview when selected.
- Entry points: the Build palette on the parcel info panel (Block, Row houses, Freeform, Detached, Reparcel, Park, Square, Lake, Offer) for parcel-scoped types; R for roads, T for tracks. Park/square/lake are one click — their geometry is the selection's union.
- "Create proposal" on an object opens the terms dialog (offer, expiry, minting). Submitting absorbs the unminted source object so exactly one thing remains; minted proposals are immutable and stay behind as superseded.
- Roads: one connected piece = one road proposal. Touching roads merge (the oldest body keeps name and cross-section); disconnecting an edit splits bodies into separate proposals. Tunnels through buildings render over the whole tunnel length but acquire nothing — parcels under a tunnel stay whole.
- Roads built through applied parks/squares/lakes cut them at render time only: the structure remains ONE proposal and heals if the road moves or is removed.
