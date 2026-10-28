// Carry private draft content to the hosted object store. Geometry never travels in a URL.
// Local stdio clients retain the artifact itself; publication is a separate user-authorized action.
export async function previewArtifact({ design = null, agreement = null, plan = null, designs = [], parcelSourceId = null }) {
    return { previewUrl: null, previewStatus: 'private-artifact',
        draftArtifact: { design, agreement, plan: plan?.content || plan, designs, parcelSourceId } };
}
