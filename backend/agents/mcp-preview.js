// A URL-size limit limits the preview, not the artifact. Never turn an oversized private draft
// into an automatic permanent publication, or discard its canonical content and CID.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/draft-link.js');
export async function previewArtifact(artifact) {
    try { return { previewUrl: await links.build(artifact), previewStatus: 'private-fragment' }; }
    catch (error) {
        if (error.code !== 'preview-too-large') throw error;
        return { previewUrl: null, previewStatus: 'publication-required', next: {
            action: 'This artifact exceeds the private preview URL limit. Ask the person before publishing this permanent public record, then use its published map link.',
            tool: artifact.agreement ? 'ugt_propose_agreement' : 'ugt_publish_design',
            arguments: artifact.agreement ? { agreement: artifact.agreement, designs: artifact.designs.map(content => ({ content })), parcelSourceId: artifact.parcelSourceId, confirm: false }
                : { design: artifact.design, parcelSourceId: artifact.parcelSourceId, confirm: false }
        } };
    }
}
