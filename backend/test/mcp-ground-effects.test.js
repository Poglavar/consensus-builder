import { describe, expect, it } from 'vitest';
import { describeRoadCuts } from '../agents/mcp-ground-effects.js';
import { toolError } from '../agents/mcp-results.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';

const box = (west, south, east, north) => ({
    type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const design = (cid, authoredAt, content) => ({ cid, content: { authoredAt, ...content } });

describe('MCP road cut effects', () => {
    it('reports all road cuts to a ground surface and gives every notice the final area without mutation', () => {
        const building = design('building-cid', '2026-01-01T00:00:00Z', {
            title: 'Building', geometry: { groundSurface: { polygon: box(0, 0, 0.002, 0.001) } }
        });
        const sourceGeometry = structuredClone(building.content.geometry.groundSurface.polygon);
        const earlierRoad = design('road-early', '2025-12-31T00:00:00Z', {
            title: 'Earlier road', roadProposal: { definition: { polygon: box(0.0004, -0.001, 0.0006, 0.002) } }
        });
        const road = design('road-late', '2026-01-02T00:00:00Z', {
            title: 'Road', roadProposal: { definition: { polygon: box(0.0014, -0.001, 0.0016, 0.002) } }
        });
        const effects = describeRoadCuts([building, road, earlierRoad]);
        expect(effects).toHaveLength(2);
        expect(effects[0]).toMatchObject({
            designRef: 'design:building-cid', surfaceKind: 'ground-surface',
            behavior: 'effective-ground-carved; authored-geometry-unchanged'
        });
        expect(effects.map(effect => effect.roadCid)).toEqual(['road-early', 'road-late']);
        expect(effects.every(effect => effect.overlapM2 > 0.25)).toBe(true);
        expect(effects[0].remainingAreaM2AfterAllRoadCuts).toBeLessThan(effects[0].authoredAreaM2);
        expect(effects[1].remainingAreaM2AfterAllRoadCuts).toBe(effects[0].remainingAreaM2AfterAllRoadCuts);
        expect(building.content.geometry.groundSurface.polygon).toEqual(sourceGeometry);
    });

    it('keeps formation cuts limited to later roads and ignores non-overlap', () => {
        const surface = design('surface', '2026-01-02T00:00:00Z', {
            title: 'Building', geometry: { buildings: [{ geometry: box(0, 0, 0.002, 0.001) }] }
        });
        const earlierRoad = design('earlier-road', '2026-01-01T00:00:00Z', {
            title: 'Earlier', roadProposal: { definition: { polygon: box(0.0009, -0.001, 0.0011, 0.002) } }
        });
        const laterFarRoad = design('far-road', '2026-01-03T00:00:00Z', {
            title: 'Far', roadProposal: { definition: { polygon: box(0.01, 0, 0.011, 0.001) } }
        });
        expect(describeRoadCuts([surface, earlierRoad, laterFarRoad])).toEqual([]);
    });

    it('includes cut notices in agreement drafts and plan revisions', async () => {
        const site = box(-0.1, 51.5, -0.098, 51.502);
        const store = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: { UGT_APP_ORIGIN: 'https://app.example' },
            resolveDraftReference: store.resolve, fetchImpl: async url => {
                const path = new URL(url).pathname;
                if (path === '/designs/binding') return Response.json({ parcelSourceId: 'test-source', binding: {
                    coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0
                } });
                if (path === '/parcel-sources/test-source') return Response.json({ complete: true, features: [
                    { type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }
                ] });
                throw new Error(`Unexpected request: ${path}`);
            } });
        const common = { city: 'london', parcelSourceId: 'test-source' };
        const building = await tools.draftBuilding({ ...common, title: 'Earlier building', outline: box(-0.0995, 51.5007, -0.0985, 51.5013), floors: 2, authoredAt: '2020-01-01T00:00:00.000Z' });
        const road = await tools.draftRoad({ ...common, title: 'Later road', points: [[-0.0999, 51.501], [-0.0981, 51.501]], preset: '1+1', authoredAt: '2021-01-01T00:00:00.000Z' });
        const drafted = await tools.draftAgreement({ currency: 'GBP', designs: [building.design, road.design], title: 'Road cut', ...common });
        expect(drafted.groundEffects).toEqual([expect.objectContaining({
            designCid: building.cid, roadTitle: 'Later road', surfaceKind: 'building',
            behavior: 'effective-ground-carved; authored-geometry-unchanged'
        })]);
        expect(drafted.groundEffects[0].remainingAreaM2AfterAllRoadCuts).toBeLessThan(drafted.groundEffects[0].authoredAreaM2);
        expect(drafted.warnings.join(' ')).toMatch(/map views/);
        const revised = await tools.editPlan({ plan: drafted, expectedCid: drafted.cid, terms: { title: 'Revised road cut' } });
        expect(revised.groundEffects).toEqual(drafted.groundEffects);
        expect(revised.warnings.join(' ')).toMatch(/map views/);
    });

    it('keeps structure-over-road details and gives an actionable recovery', () => {
        expect(toolError(Object.assign(new Error('Structure overlaps road.'), {
            code: 'structure-over-road', roadProposalId: 'road-cid', overlapM2: 12.5
        }))).toMatchObject({
            code: 'structure-over-road', roadId: 'road-cid', overlapM2: 12.5,
            next: { action: expect.stringMatching(/Move or resize the structure/) }
        });
    });
});
