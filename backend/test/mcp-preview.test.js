// Draft transport retains canonical content regardless of whether a preview host is available.
import { describe, expect, it } from 'vitest';
import { previewArtifact } from '../agents/mcp-preview.js';

describe('private draft artifacts', () => {
    for (const kind of ['design', 'agreement', 'plan']) it(`carries ${kind} as data, never in a URL or an implicit publication`, async () => {
        const content = { schema: `${kind}/v1`, description: 'x'.repeat(1_000_001) };
        const result = await previewArtifact({ origin: 'https://app.example', [kind]: content });
        expect(result.previewUrl).toBeNull();
        expect(result.previewStatus).toBe('private-artifact');
        expect(result.draftArtifact[kind]).toBe(content);
        expect(result.next).toBeUndefined();
    });
});
