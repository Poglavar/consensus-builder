// Carry private draft content to the hosted object store. Geometry never travels in a URL.
// Local stdio clients retain the artifact itself; publication is a separate user-authorized action.
// when: a month (YYYY-MM) the preview opens the plan's build-out time control at; buildout: the seed
// of a simulated build-out of the plan's undated members.
export async function previewArtifact({ design = null, agreement = null, plan = null, designs = [], parcelSourceId = null, when = null, buildout = null }) {
    return { previewUrl: null, previewStatus: 'private-artifact',
        draftArtifact: { design, agreement, plan: plan?.content || plan, designs, parcelSourceId, ...(when ? { when } : {}), ...(buildout ? { buildout } : {}) } };
}
