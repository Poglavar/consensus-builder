import { describe, expect, it } from 'vitest';
import { previewArtifact } from '../agents/mcp-preview.js';
// Deterministic non-repeating content is intentionally difficult to compress. The helper does not
// validate the artifact schema; the tool validates content before reaching this URL-size boundary.
function largeContent(schema) {
    let state = 42, data = '';
    for (let i = 0; i < 60000; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; data += String.fromCharCode(33 + state % 90); }
    return { schema, description: data };
}
describe('oversized MCP draft previews', () => {
    it('retains the artifact even when the uncompressed envelope exceeds the decoder limit', async () => {
        const design = { schema: 'design/v1', description: 'x'.repeat(1_000_001) };
        const result = await previewArtifact({ origin: 'https://app.example', design });
        expect(result.previewStatus).toBe('publication-required');
        expect(result.next.arguments).toMatchObject({ design, confirm: false });
    });
    for (const kind of ['design', 'agreement']) it(`returns a refused publication recovery for ${kind}, never confirmation or loss of the artifact`, async () => {
        const content = largeContent(`${kind}/v1`), artifact = { origin: 'https://app.example', [kind]: content, designs: [] };
        const result = await previewArtifact(artifact);
        expect(result.previewUrl).toBeNull();
        expect(result.previewStatus).toBe('publication-required');
        expect(result.next.tool).toBe(kind === 'design' ? 'ugt_publish_design' : 'ugt_propose_agreement');
        expect(result.next.arguments.confirm).toBe(false);
        expect(result.next.arguments[kind]).toBe(content);
    });
});
