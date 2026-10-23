import { test, expect } from '../helpers/fixtures';
import { createSpace, drawCorridor, openCity, chooseProfileName, showProposal, stubBasemapTiles } from '../helpers/runtime';
import { canonicalJson, cidOfBytes, cidOfObject, pageIndex } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const postsOf = (page: import('@playwright/test').Page) => pageIndex(page).requests.filter(request => request.method === 'POST');

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
    expect(posts.map(request => request.path)).toEqual(['/pins', '/designs']);
    const [pin, indexed] = posts;
    const bytes = Buffer.from(pin.body.bytes, 'base64');
    const content = indexed.body.content;
    expect(pin.body.kind).toBe('design');
    expect(cidOfBytes(bytes)).toBe(pin.body.cid);
    expect(bytes.toString('utf8')).toBe(canonicalJson(content));
    expect(indexed.body.cid).toBe(pin.body.cid);
    expect(cidOfObject(content)).toBe(indexed.body.cid);
    expect(content).toMatchObject({ schema: 'design/v1', goal: 'road-track', site: null, geometry: null });
    expect(content.roadProposal.definition.polygon).toMatchObject({ type: 'Polygon' });
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

test('a large Block publishes its compacted geometry as a multichunk design and keeps the same CID', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const proposalId = await createSpace(page, 'park');
  const index = pageIndex(page);
  // The CPU helper tests the editor's real block generator; inject its resulting authored shape
  // into this applied local record to exercise the publication path without a second UI setup.
  const { generateLargeBlockFixture } = await import('../../backend/test/helpers/large-block-fixture.js');
  const fixture = generateLargeBlockFixture();

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
  }, { id: proposalId, design: fixture.design });
  expect(prepared.bytes).toBeGreaterThan(256 * 1024);
  expect(prepared.bytes).toBeLessThanOrEqual(prepared.maxBytes);
  expect(prepared.validation).toEqual({ valid: true, errors: [] });

  await showProposal(page, proposalId);
  const details = page.locator('#proposal-details-panel');
  await details.locator('.btn-share-proposal').click();
  await chooseProfileName(page, 'Large Block author');
  expect(postsOf(page)).toEqual([]);
  const readyToShare = await page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    return {
      bytes: w.DesignRecord.publicationSize(proposal),
      validation: w.DesignRecord.validate(w.DesignRecord.published(proposal))
    };
  }, proposalId);
  expect(readyToShare.bytes).toBeGreaterThan(256 * 1024);
  expect(readyToShare.bytes).toBeLessThanOrEqual(prepared.maxBytes);
  expect(readyToShare.validation).toEqual({ valid: true, errors: [] });

  await showProposal(page, proposalId);
  await details.locator('.btn-share-proposal').click();
  await expect(details.locator('.cb-badge--published')).toBeVisible({ timeout: 30_000 });

  const posts = postsOf(page);
  expect(posts.map(request => request.path)).toEqual(['/pins', '/designs']);
  const [pin, indexed] = posts;
  const bytes = Buffer.from(pin.body.bytes, 'base64');
  const content = indexed.body.content;
  expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
  expect(bytes.byteLength).toBeLessThanOrEqual(prepared.maxBytes);
  expect(pin.body.kind).toBe('design');
  expect(cidOfBytes(bytes)).toBe(pin.body.cid);
  expect(pin.body.cid).toMatch(/^bafybei/); // UnixFS root for a canonical object spanning multiple raw chunks.
  expect(bytes.toString('utf8')).toBe(canonicalJson(content));
  expect(bytes.byteLength).toBe(Buffer.byteLength(canonicalJson(content), 'utf8'));
  expect(indexed.body.cid).toBe(pin.body.cid);
  expect(cidOfObject(content)).toBe(indexed.body.cid);
  expect(content).toMatchObject({ schema: 'design/v1', goal: 'buildings', site: null, city: prepared.city });
  expect(content.buildingProposal.typologyType).toBe('block');
  expect(content.geometry.buildings).toEqual([fixture.massing]);
  expect(content.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
  expect(content.geometry.buildings[0].geometry.coordinates.reduce((n: number, ring: unknown[]) => n + ring.length, 0)).toBeGreaterThan(20_000);
  expect(content.geometry).not.toHaveProperty('blockMassing');
  expect(await page.evaluate(content => (window as any).DesignRecord.validate(content), content)).toEqual({ valid: true, errors: [] });

  const saved = await page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    return { published: proposal.published, cid: w.DesignSync.publishedCid(proposal) };
  }, proposalId);
  expect(saved).toMatchObject({ published: { cid: indexed.body.cid }, cid: indexed.body.cid });
  expect(index.designs.get(indexed.body.cid)?.content).toEqual(content);
});
