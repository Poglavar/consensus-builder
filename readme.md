Urban Game Theory -- Toolkit for Collaborative Urban Planning
https://urbangametheory.xyz

This is a toolkit for collaborative urban planning.

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
