// The click stack (click-stack.md): a 2D map click shows everything under the point in one
// right-docked panel of sections, agreements above designs above formed and cadastral parcels.
// Clicking the same spot again closes it, another spot switches it, Escape closes it, and the kind
// of the expanded section is remembered for the next click. Several agreements (or designs, or
// cadastral parcels) at one spot share one row with a strip of chips.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { clickDesignOnMap, clickMapPoint, clickStack, createSpace, drawCorridor, expandStackSection, openCity, stackSection, PARCEL_ID } from '../helpers/runtime';
import { agreementPanel, proposeOverPark } from '../helpers/agreements';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function loadSecondParcel(page: Page): Promise<void> {
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), SECOND_PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), SECOND_PARCEL_ID)).toBe(true);
}

const sectionKinds = (page: Page) => clickStack(page).locator('.click-stack__section')
  .evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.kind));

// An agreement over a park applied here and a second, later one over the same design; the stack
// opened on the park. Returns the park's id.
async function twoAgreementsOnPark(page: Page): Promise<string> {
  await openCity(page);
  const first = await proposeOverPark(page, { title: 'First agreement' });
  // A second agreement over the same design, proposed later (agreements list newest first).
  await page.evaluate(id => {
    const w = window as any;
    const stored = JSON.parse(JSON.stringify(w.AgreementStore.get(id)));
    delete stored.published;
    w.AgreementStore.save({ ...stored, id: w.AgreementRecord.newId(), title: 'Second agreement',
      createdAt: new Date(Date.parse(stored.createdAt) + 60_000).toISOString() });
  }, first.id);
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();
  await clickDesignOnMap(page, first.parkId);
  await expect(clickStack(page)).toBeVisible();
  return first.parkId;
}

const remembered = (page: Page) => page.evaluate(() => localStorage.getItem('cb.clickStack.expanded'));

test.describe('Click stack @core', () => {
  test('a parcel click opens the stack on the parcel section, a second click closes it, another parcel switches it', async ({ mockApi: page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCity(page);
    await loadSecondParcel(page);
    const stack = clickStack(page);
    await expect(stack).toBeHidden();

    await clickMapPoint(page, 15.9822, 45.80025);
    await expect(stack).toBeVisible();
    expect(await sectionKinds(page)).toEqual(['parcels']);
    const parcels = stackSection(page, 'parcels');
    await expect(parcels.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    // The existing parcel panel is moved into the expanded section. Its tabs carry Propose, Proposals
    // and Tools, so the section adds no buttons that repeat them.
    const panel = parcels.locator('.click-stack__body #parcel-info-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-hosted/);
    await expect(parcels.locator('.click-stack__row-title')).toHaveText(`Cadastral parcel ${PARCEL_ID}`);
    await expect(parcels.locator('.click-stack__row-detail')).toBeEmpty();
    await expect(stack.locator('.click-stack__head')).toHaveCount(0);
    await expect(panel.locator('.panel-header')).toBeHidden();
    const designTab = panel.getByRole('tab', { name: 'Design', exact: true });
    await expect(designTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tab').first()).toHaveText('Design');
    const selection = panel.locator('.multi-select-group');
    const customSite = panel.getByRole('button', { name: 'Custom site', exact: true });
    await expect(selection).toBeVisible();
    await expect(customSite).toBeVisible();
    const selectionBox = await selection.boundingBox();
    const customBox = await customSite.boundingBox();
    const tabsBox = await panel.locator('.parcel-tabs').boundingBox();
    expect(selectionBox && customBox && tabsBox).toBeTruthy();
    expect(selectionBox!.x).toBeLessThan(customBox!.x);
    expect(selectionBox!.y + selectionBox!.height).toBeLessThanOrEqual(tabsBox!.y);
    // The tab choice survives a different parcel and section collapse/reopen.
    await panel.getByRole('tab', { name: 'Info', exact: true }).click();
    await expect(page.locator('#parcel-info-title')).toContainText(PARCEL_ID);
    await expect(panel.locator('[data-parcel-tab-id="propose-tab"]')).toBeVisible();
    for (const id of ['parcel.propose', 'parcel.details', 'parcel.proposals', 'parcel.tools', 'parcel.history', 'parcel.selectMore', 'parcel.detectBlock']) {
      await expect(parcels.locator(`[data-command="${id}"]`)).toHaveCount(0);
    }
    // The footer copies the clicked point's coordinates.
    const coords = stack.locator('.click-stack__coords');
    await expect(coords).toHaveText(/^45\.80\d+, 15\.98\d+$/);
    await coords.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await coords.textContent());
    expect(await page.evaluate(() => (window as any).currentParcel?.id)).toBe(PARCEL_ID);

    // The same parcel again (elsewhere on it): the stack closes, and the panel with it.
    await clickMapPoint(page, 15.9821, 45.8002);
    await expect(stack).toBeHidden();
    await expect(page.locator('#parcel-info-panel')).toBeHidden();

    // Another parcel while the stack is open: it shows that parcel instead.
    await clickMapPoint(page, 15.9822, 45.80025);
    await expect(stack).toBeVisible();
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(stack).toBeVisible();
    await expect(page.locator('#parcel-info-title')).toContainText(SECOND_PARCEL_ID);
    await expect(stackSection(page, 'parcels').getByRole('tab', { name: 'Info', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(stackSection(page, 'parcels').locator('#parcel-info-panel')).toBeVisible();

    // Escape closes it, and the hosted panel with it.
    await page.keyboard.press('Escape');
    await expect(stack).toBeHidden();
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
  });

  test('a design orders above its formed and cadastral parcels, and the expanded kind is remembered', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    await page.keyboard.press('Escape');
    await expect(clickStack(page)).toBeHidden();

    await clickDesignOnMap(page, parkId);
    await expect(clickStack(page)).toBeVisible();
    const kinds = await sectionKinds(page);
    expect(kinds[0]).toBe('designs');
    expect(kinds).toContain('formed');
    expect(kinds).toContain('parcels');
    expect(kinds.indexOf('formed')).toBeLessThan(kinds.indexOf('parcels'));
    // The topmost section opens first: the design's summary in the planning inspector.
    const designs = stackSection(page, 'designs');
    await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(designs.locator('.click-stack__body #planning-inspector, .click-stack__body #proposal-details-panel')).toBeVisible();
    // The formed parcel is live ground the design made: it opens like a parcel, and a new design
    // can start on it.
    const formed = stackSection(page, 'formed');
    await expect(formed.locator('.click-stack__row')).toContainText('Formed by');
    await expandStackSection(page, 'formed');
    await expect(formed.locator('#parcel-info-panel')).toBeVisible();
    await expect(formed.locator('[data-command="parcel.useAsSite"]')).toBeVisible();

    // Expanding the cadastral parcel collapses the others; the choice is remembered. The original
    // was consumed by the park: it shows its record, with no actions that build on it.
    await expandStackSection(page, 'parcels');
    await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await expect(designs.locator('.click-stack__body')).toHaveCount(0);
    await expect(formed.locator('.click-stack__body')).toHaveCount(0);
    await expect(stackSection(page, 'parcels').locator('#parcel-info-panel')).toBeVisible();
    await expect(stackSection(page, 'parcels').locator('[data-command="parcel.useAsSite"]')).toHaveCount(0);
    expect(await remembered(page)).toBe('parcels');

    // The next click on the spot opens with the remembered kind, also after a reload.
    await page.keyboard.press('Escape');
    await expect(clickStack(page)).toBeHidden();
    await clickDesignOnMap(page, parkId);
    await expect(stackSection(page, 'parcels').locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
    expect(await remembered(page)).toBe('parcels');
    await clickDesignOnMap(page, parkId);
    await expect(stackSection(page, 'parcels').locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
  });

  test('two agreements holding the design show as one row with a strip of chips that switch the agreement', async ({ mockApi: page }) => {
    await twoAgreementsOnPark(page);
    const kinds = await sectionKinds(page);
    expect(kinds.slice(0, 2)).toEqual(['agreements', 'designs']);
    const agreements = stackSection(page, 'agreements');
    await expect(agreements.locator('.click-stack__row-title')).toHaveText('Agreements (2)');
    const chips = agreements.locator('.click-stack__strip .click-stack__chip');
    await expect(chips).toHaveText(['Second agreement', 'First agreement']);
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(agreements.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(agreements.locator('.click-stack__summary strong')).toHaveText('Second agreement');

    await chips.nth(1).click();
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(agreements.locator('.click-stack__summary strong')).toHaveText('First agreement');
    expect(await page.evaluate(() => (window as any).ClickStack.current().sections[0].selectedIndex)).toBe(1);

    // Show its designs outlines them on the map; Details hands the dock to the agreement panel.
    await agreements.getByRole('button', { name: 'Show its designs', exact: true }).click();
    await expect.poll(() => page.locator('path.proposal-hover-outline').count()).toBeGreaterThan(0);
    await agreements.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(agreementPanel(page)).toBeVisible();
    await expect(agreementPanel(page)).toContainText('First agreement');
    await expect(clickStack(page)).toBeHidden();
  });

  test('a design\'s In agreements chip opens that agreement in its section', async ({ mockApi: page }) => {
    await twoAgreementsOnPark(page);
    const agreements = stackSection(page, 'agreements');
    const chips = agreements.locator('.click-stack__strip .click-stack__chip');
    // The design's section lists the agreements it belongs to; one of them opens in its section.
    await expandStackSection(page, 'designs');
    const inAgreements = stackSection(page, 'designs').locator('.click-stack__strip--inline .click-stack__chip');
    await expect(inAgreements).toHaveText(['Second agreement', 'First agreement']);
    await inAgreements.filter({ hasText: 'First agreement' }).click();
    await expect(clickStack(page)).toBeVisible();
    await expect(agreements.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(agreements.locator('.click-stack__summary strong')).toHaveText('First agreement');
  });
  test('the pieces a road leaves of a parcel open as formed ground that a new design can start on', async ({ mockApi: page }) => {
    await openCity(page);
    const roadId = await drawCorridor(page, 'road');
    await page.keyboard.press('Escape');
    // A live piece the road cut from a cadastral parcel (its id is not its cadastral parcel's) that
    // the road itself does not cover, and a point inside it.
    const piece = await page.evaluate(roadId => {
      const w = window as any;
      const road = w.proposalStorage.getProposal(roadId);
      const footprint = w.__planOrder.footprintOf(road);
      const pieces = w.LiveParcelFabric.queryBounds(w.turf.bbox(footprint).map((v: number, i: number) => v + (i < 2 ? -0.001 : 0.001)), {})
        .filter((f: any) => {
          const ids = (f.properties?.cadastreParcelIds || []).map(String);
          return ids.length > 0 && !ids.includes(String(w.LiveParcelFabric.featureId(f)));
        });
      // A point well inside the piece: on a grid over it, inside it, outside the road and every other
      // live piece, and as far from its edge as the grid allows (a click lands within a pixel of it).
      for (const feature of pieces) {
        const id = w.LiveParcelFabric.featureId(feature);
        const [west, south, east, north] = w.turf.bbox(feature);
        const edge = w.turf.polygonToLine(feature);
        let best: any = null;
        for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
          const pt = [west + (east - west) * i / 20, south + (north - south) * j / 20];
          if (!w.turf.booleanPointInPolygon(pt, feature) || w.turf.booleanPointInPolygon(pt, footprint)) continue;
          const others = w.LiveParcelFabric.queryBounds([pt[0], pt[1], pt[0], pt[1]], { includeCorridors: true })
            .filter((other: any) => w.LiveParcelFabric.featureId(other) !== id && w.turf.booleanPointInPolygon(pt, other));
          if (others.length) continue;
          // The piece's rings as separate lines (a piece with holes or parts gives a multi-line).
          const lines = (edge.type === 'FeatureCollection' ? edge.features : [edge]).flatMap((line: any) => line.geometry.type === 'MultiLineString'
            ? line.geometry.coordinates.map((coords: any) => w.turf.lineString(coords)) : [line]);
          const distance = Math.min(...lines.map((line: any) => w.turf.pointToLineDistance(pt, line, { units: 'meters' })));
          if (!best || distance > best.distance) best = { id, lng: pt[0], lat: pt[1], distance };
        }
        if (best && best.distance > 2) return best;
      }
      return null;
    }, roadId);
    expect(piece, 'the road left at least one live piece beside it').not.toBeNull();
    await clickMapPoint(page, piece!.lng, piece!.lat);
    await expect(clickStack(page)).toBeVisible();
    const kinds = await sectionKinds(page);
    // No design is under the point: the road is listed above as a proposal on this ground, folded,
    // and the formed piece is what opens.
    expect(kinds).toEqual(['designs', 'formed', 'parcels']);
    await expect(stackSection(page, 'designs').locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    // The cadastral parcel it was cut from is listed below it, as a record.
    const formed = stackSection(page, 'formed');
    await expect(formed.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(formed.locator('#parcel-info-panel')).toBeVisible();
    await formed.locator('#parcel-info-panel [data-parcel-tab-id="propose-tab"]').click();
    await expect(formed.locator('.parcel-build-btn--park')).toBeVisible();
  });
});
