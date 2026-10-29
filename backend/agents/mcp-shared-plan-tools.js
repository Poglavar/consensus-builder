// MCP is deliberately a participant, not an owner: a browser creates the session and hands an
// invitation capability to an agent. The owner alone changes whose turn it is through the UI/API.
function artifactOf(result) {
    return { cid: result.cid, plan: result.plan, designs: result.designs.map(row => ({
        cid: row.cid, content: row.content, parcelSourceId: row.parcelSourceId || null
    })) };
}

export function createSharedPlanMcpTools({ actions, sharedPlans }) {
    if (!sharedPlans) return {};
    return {
        inspectSharedPlan({ sessionId, capability }) {
            return sharedPlans.inspect(sessionId, capability);
        },
        async editSharedPlan({ sessionId, capability, expectedVersion, expectedCid, operations, title, view, schedule, when, buildout, undoLastAgentChange }) {
            const current = sharedPlans.assertEditable(sessionId, capability, expectedVersion);
            // Check before the expensive immutable revision work, then check again in replace(). An
            // owner taking control during this calculation safely rejects the late agent result.
            if (expectedCid !== current.cid) {
                throw Object.assign(new Error('Inspect the shared plan and use its current CID before editing.'), {
                    code: 'shared-plan-revision-mismatch', currentCid: current.cid, expectedCid
                });
            }
            if (undoLastAgentChange) {
                if (operations?.length || [title, view, schedule, when, buildout].some(value => value !== undefined)) throw Object.assign(new Error('Undo cannot be combined with content edits.'), { code: 'shared-plan-undo-conflict' });
                return sharedPlans.undo(sessionId, capability, { expectedVersion });
            }
            const endActivity = sharedPlans.beginActivity(sessionId, capability, expectedVersion);
            try {
                const revised = await actions.editPlan({ plan: current.artifact, expectedCid, operations, title, view, schedule, when, buildout });
                const committed = sharedPlans.replace(sessionId, capability, { expectedVersion, artifact: artifactOf(revised), changes: revised.changes, consequences: revised.consequences });
                return { ...committed, changes: revised.changes, consequences: revised.consequences };
            } finally { endActivity(); }
        }
    };
}
