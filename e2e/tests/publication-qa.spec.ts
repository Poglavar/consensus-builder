import { test, expect } from '../helpers/fixtures';
import { createSpace, drawCorridor, openCity, chooseProfileName, showProposal, stubBasemapTiles } from '../helpers/runtime';
import { canonicalJson, cidOfBytes, cidOfObject, pageIndex } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const postsOf = (page: import('@playwright/test').Page) => pageIndex(page).requests.filter(request => request.method === 'POST');

async function publishBuildingCollection(page: import('@playwright/test').Page, options: {
  title: string;
  design: any;
  expectedBuildings: any[];
  size: 'compact' | 'multi-chunk';
}) {
  test.setTimeout(120_000);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const proposalId = await createSpace(page, 'park');
  const index = pageIndex(page);

  const prepared = await page.evaluate(({ id, design }) => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    if (!proposal) throw new Error('The local applied design was not found.');
    proposal.goal = 'buildings';
    proposal.city = w.CityConfigManager.getCurrentCityId();
    proposal.site = null;
    proposal.geometry = structuredClone(design.geometry);
    proposal.buildingProposal = structuredClone(design.buildingProposal);
    proposal.typologyType = 'block';
    proposal.primaryType = 'Urban Rule';
    delete proposal.structureProposal;
    w.proposalStorage._indexProposal(proposal);
    w.proposalStorage.save();
    const content = w.DesignRecord.published(proposal);
    return {
      bytes: w.Cid.canonicalBytes(content).byteLength,
      maxBytes: w.DesignRecord.MAX_PUBLISHED_OBJECT_BYTES,
      validation: w.DesignRecord.validate(content),
      city: proposal.city
    };
  }, { id: proposalId, design: options.design });
  if (options.size === 'compact') {
    expect(prepared.bytes).toBeLessThan(64 * 1024);
  } else {
    expect(prepared.bytes).toBeGreaterThan(256 * 1024);
  }
  expect(prepared.bytes).toBeLessThanOrEqual(prepared.maxBytes);
  expect(prepared.validation).toEqual({ valid: true, errors: [] });

  await showProposal(page, proposalId);
  const details = page.locator('#proposal-details-panel');
  await details.locator('.btn-share-proposal').click();
  await chooseProfileName(page, `${options.title} author`);
  expect(postsOf(page)).toEqual([]);
  const readyToShare = await page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    return {
      bytes: w.DesignRecord.publicationSize(proposal),
      validation: w.DesignRecord.validate(w.DesignRecord.published(proposal))
    };
  }, proposalId);
  if (options.size === 'compact') {
    expect(readyToShare.bytes).toBeLessThan(64 * 1024);
  } else {
    expect(readyToShare.bytes).toBeGreaterThan(256 * 1024);
  }
  expect(readyToShare.bytes).toBeLessThanOrEqual(prepared.maxBytes);
  expect(readyToShare.validation).toEqual({ valid: true, errors: [] });

  await showProposal(page, proposalId);
  await details.locator('.btn-share-proposal').click();
  await expect(details.locator('.cb-badge--published')).toBeVisible({ timeout: 30_000 });

  const posts = postsOf(page);
  expect(posts.map(request => request.path)).toEqual(['/designs']);
  const [indexed] = posts;
  const content = indexed.body.content;
  const bytes = Buffer.from(canonicalJson(content), 'utf8');
  if (options.size === 'compact') {
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    expect(indexed.body.cid).toMatch(/^bafkrei/); // Single-chunk UnixFS file: raw root.
  } else {
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    expect(indexed.body.cid).toMatch(/^bafybei/); // Multi-chunk UnixFS file: dag-pb root.
  }
  expect(bytes.byteLength).toBeLessThanOrEqual(prepared.maxBytes);
  expect(cidOfBytes(bytes)).toBe(indexed.body.cid);
  expect(cidOfObject(content)).toBe(indexed.body.cid);
  expect(content).toMatchObject({ schema: 'design/v1', goal: 'buildings', site: null, city: prepared.city });
  expect(content.buildingProposal.typologyType).toBe('block');
  expect(content.geometry.buildings).toEqual(options.expectedBuildings);
  expect(content.geometry.buildings.every((building: any) => building.geometry.coordinates.length === 2)).toBe(true);
  const positions = content.geometry.buildings.reduce((count: number, building: any) =>
    count + building.geometry.coordinates.reduce((ringCount: number, ring: any[]) => ringCount + ring.length, 0), 0);
  if (options.size === 'compact') expect(positions).toBeLessThan(1_000);
  else expect(positions).toBeGreaterThan(10_000);
  expect(content.geometry).not.toHaveProperty('ruleMassing');
  expect(await page.evaluate(content => (window as any).DesignRecord.validate(content), content)).toEqual({ valid: true, errors: [] });

  const saved = await page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    return { published: proposal.published, cid: w.DesignSync.publishedCid(proposal) };
  }, proposalId);
  expect(saved).toMatchObject({ published: { cid: indexed.body.cid }, cid: indexed.body.cid });
  expect(index.designs.get(indexed.body.cid)?.content).toEqual(content);
}

for (const kind of ['road', 'track'] as const) {
  test(`sharing a drawn ${kind} publishes its nested corridor polygon as a valid design`, async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const proposalId = await drawCorridor(page, kind);
    const index = pageIndex(page);

    await showProposal(page, proposalId);
    const details = page.locator('#proposal-details-panel');
    await details.locator('.btn-share-proposal').click();
    await chooseProfileName(page, `${kind} author`);
    expect(postsOf(page)).toEqual([]);

    await showProposal(page, proposalId);
    await details.locator('.btn-share-proposal').click();
    await expect(details.locator('.cb-badge--published')).toBeVisible({ timeout: 30_000 });

    const posts = postsOf(page);
    expect(posts.map(request => request.path)).toEqual(['/designs']);
    const [indexed] = posts;
    const content = indexed.body.content;
    expect(cidOfBytes(Buffer.from(canonicalJson(content), 'utf8'))).toBe(indexed.body.cid);
    expect(cidOfObject(content)).toBe(indexed.body.cid);
    // The corridor polygon is the authored road land. It is stored as the design site as well as
    // in the road payload, so later footprint edits have one durable land boundary to update.
    expect(content).toMatchObject({ schema: 'design/v1', goal: 'road-track', geometry: null });
    expect(content.roadProposal.definition.polygon).toMatchObject({ type: 'Polygon' });
    expect(content.site).toEqual(content.roadProposal.definition.polygon);
    expect(content.roadProposal.definition.metadata.isTrack).toBe(kind === 'track');
    expect(await page.evaluate(content => (window as any).DesignRecord.validate(content), content)).toEqual({ valid: true, errors: [] });

    const saved = await page.evaluate(id => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      return { published: proposal.published, cid: w.DesignSync.publishedCid(proposal) };
    }, proposalId);
    expect(saved).toMatchObject({ published: { cid: indexed.body.cid }, cid: indexed.body.cid });
    expect(index.designs.get(indexed.body.cid)?.content).toEqual(content);
  });
}

for (const kind of ['real generated Block', 'synthetic multi-building fixture'] as const) {
  test(`${kind} publishes exact canonical geometry with a CID matching its chunk profile`, async ({ mockApi: page }) => {
    const { generateLargeBlockFixture } = await import('../../backend/test/helpers/large-block-fixture.js');
    const fixture = generateLargeBlockFixture();
    let design = fixture.design;
    let expectedBuildings = [fixture.massing];
    let size: 'compact' | 'multi-chunk' = 'compact';

    if (kind === 'synthetic multi-building fixture') {
      // Translate 16 copies onto a separated grid. Each polygon is genuine generated geometry;
      // the collection itself is synthetic stress data, not an observed Block.
      const bounds = (building: any) => {
        const points = building.geometry.coordinates.flat();
        return points.reduce((b: any, [x, y]: number[]) => ({
          minX: Math.min(b.minX, x), minY: Math.min(b.minY, y),
          maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y)
        }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      };
      const baseBounds = bounds(fixture.massing);
      const spacing = 0.01;
      expect(baseBounds.maxX - baseBounds.minX).toBeLessThan(spacing);
      expect(baseBounds.maxY - baseBounds.minY).toBeLessThan(spacing);
      expectedBuildings = Array.from({ length: 16 }, (_, index) => {
        const copy = JSON.parse(JSON.stringify(fixture.massing));
        const dx = index % 4 * spacing;
        const dy = Math.floor(index / 4) * spacing;
        copy.geometry.coordinates = copy.geometry.coordinates.map((ring: number[][]) =>
          ring.map(([x, y]) => [x + dx, y + dy]));
        copy.properties.block = `Synthetic block ${index + 1}`;
        return copy;
      });
      expectedBuildings.forEach((building, index) => {
        const a = bounds(building);
        for (let other = index + 1; other < expectedBuildings.length; other += 1) {
          const b = bounds(expectedBuildings[other]);
          expect(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY).toBe(true);
        }
      });
      design = {
        ...fixture.design,
        title: 'Synthetic multi-building fixture',
        geometry: { buildings: expectedBuildings },
        buildingProposal: { ...fixture.design.buildingProposal, blockName: 'Synthetic multi-building fixture' }
      };
      size = 'multi-chunk';
    }

    await publishBuildingCollection(page, { title: kind, design, expectedBuildings, size });
  });
}
