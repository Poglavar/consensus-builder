// Upgrade local corridor centerlines from traversal arrays to real graph topology.
//
// Older drawings can contain a self-crossing route in one polyline (for example, a closed star).
// The physical footprint is already correct, but that representation has no editable crossing nodes
// and cannot be triangulated as one 3D lane strip. The pure geometry normalizer splits it into simple
// stretches at each crossing. This migration is intentionally local-only: minted/shared definitions
// are immutable consensus inputs and are never rewritten in place.
(function migrateLocalCorridorTopology(global) {
    'use strict';

    const storage = global.proposalStorage;
    if (!storage || typeof storage.getAllProposals !== 'function'
        || typeof global.normalizeCorridorDefinitionTopology !== 'function') return;

    let changed = 0;
    storage.getAllProposals().forEach(proposal => {
        if (!proposal || proposal.isMinted === true || proposal.onchain?.transactionHash) return;
        const definition = proposal.roadProposal?.definition || proposal.definition || null;
        if (!definition || !global.normalizeCorridorDefinitionTopology(definition)) return;

        changed += 1;
        if (proposal.roadProposal) proposal.roadProposal.definition = definition;
        if (proposal.definition) proposal.definition = JSON.parse(JSON.stringify(definition));
        if (proposal.geometry?.roadPlan) proposal.geometry.roadPlan = JSON.parse(JSON.stringify(definition));
    });

    if (!changed) return;
    try { storage.save(); } catch (error) {
        console.warn('[corridor-topology] Could not persist normalized local corridors', error);
    }
    console.info(`[corridor-topology] Normalized ${changed} local corridor${changed === 1 ? '' : 's'} into graph topology.`);
})(typeof window !== 'undefined' ? window : globalThis);
