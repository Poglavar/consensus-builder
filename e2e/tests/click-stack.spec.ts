// The click stack (click-stack.md): a 2D map click shows everything under the point in one
// right-docked panel of sections, plans above designs above formed and cadastral parcels.
// Clicking the same spot again retains it, another spot switches it, Escape closes it, and the kind
// of the expanded section is remembered for the next click. Peer objects share a section with
// a selector; each plan links to its agreements in a separate dialog.
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
async function twoAgreementsOnPark(page: Page, titles = ['First agreement', 'Second agreement']): Promise<string> {
  await openCity(page);
  const first = await proposeOverPark(page, { title: titles[0] });
  // A second agreement over the same design, proposed later (agreements list newest first).
  await page.evaluate(({ id, title }) => {
    const w = window as any;
    const stored = JSON.parse(JSON.stringify(w.AgreementStore.get(id)));
    delete stored.published;
    w.AgreementStore.save({ ...stored, id: w.AgreementRecord.newId(), title,
      createdAt: new Date(Date.parse(stored.createdAt) + 60_000).toISOString() });
  }, { id: first.id, title: titles[1] });
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();
  await clickDesignOnMap(page, first.parkId);
  await expect(clickStack(page)).toBeVisible();
  return first.parkId;
}

const remembered = (page: Page) => page.evaluate(() => localStorage.getItem('cb.clickStack.expanded'));

test.describe('Click stack @core', () => {
  test('a plan links to agreement details without making agreements spatial sections', async ({ mockApi: page }) => {
    await twoAgreementsOnPark(page, ['Agreement action coverage']);
    await expect(stackSection(page, 'agreements')).toHaveCount(0);
    await expandStackSection(page, 'plans');
    const plan = stackSection(page, 'plans');
    await expect(plan.locator('.click-stack__body')).toBeVisible();
    await expect(page.locator('path.click-stack-map-focus').first()).toBeVisible();
    await plan.locator('.click-stack__choices[data-kind="agreements"] .click-stack__chip')
      .filter({ hasText: 'Agreement action coverage' }).click();
    await expect(page.locator('section#agreement-panel')).toBeVisible();
    await expect(page.locator('#agreement-panel-title')).toHaveText('Agreement action coverage');
    await expect(clickStack(page)).toBeHidden();
  });

  test('expanding sections retains map focus and collapsed headers keep their identity visible', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCity(page);
    await createSpace(page, 'park');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const focus = page.locator('path.click-stack-map-focus');
    for (const kind of ['designs', 'formed', 'parcels']) {
      await expandStackSection(page, kind);
      await expect(focus.first()).toBeVisible();
      const selected = await page.evaluate(() => (window as any).currentlyHighlightedProposalId);
      if (kind === 'designs') {
        expect(selected).toBeTruthy();
        await expect(stackSection(page, kind).locator('.click-stack__body .proposal-type-badge')).toBeVisible();
        await stackSection(page, kind).locator('.click-stack__row').click();
        expect(await page.evaluate(() => (window as any).isProposalUIActive())).toBe(true);
        await expect(focus.first()).toBeVisible();
        await expandStackSection(page, kind);
      }
      else expect(selected).toBeNull();
      const paths = await focus.evaluateAll(paths => paths.map(path => path.getAttribute('d')));
      await page.evaluate(() => (window as any).map.fire('mouseout'));
      expect(await focus.evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(paths);
    }
    const connector = await stackSection(page, 'formed').evaluate(el => {
      const style = getComputedStyle(el, '::before');
      const icon = el.querySelector('.click-stack__row > i')!.getBoundingClientRect();
      return { left: el.getBoundingClientRect().left + parseFloat(style.left) + parseFloat(style.borderLeftWidth) / 2,
        axis: icon.x + icon.width / 2, width: style.borderLeftWidth, z: style.zIndex };
    });
    expect(Math.abs(connector.left - connector.axis)).toBeLessThanOrEqual(1);
    expect(connector).toMatchObject({ width: '4px', z: '-1' });
    await expect(focus.first()).toHaveCSS('animation-name', 'click-stack-focus-pulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(focus.first()).toHaveCSS('animation-name', 'none');
    await expect(focus.first()).toBeVisible();
    await stackSection(page, 'parcels').locator('.click-stack__row').click();
    await expect(focus.first()).toBeVisible();
    await expect(stackSection(page, 'parcels')).toHaveClass(/is-selected/);
    const stack = clickStack(page);
    await expect(stack.locator('.click-stack__choices')).toHaveCount(0);
    await expect(stack.locator('.click-stack__copy-reference')).toHaveCount(0);
    for (const kind of ['designs', 'formed', 'parcels']) {
      const row = stackSection(page, kind).locator('.click-stack__row');
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48);
      if (kind === 'designs') await expect(row.locator('.proposal-type-badge')).toHaveCount(0);
      await expect(row.locator('.click-stack__row-title')).toHaveCSS('white-space', 'nowrap');
      await expect(row.locator('.click-stack__row-detail')).toHaveCSS('text-overflow', 'ellipsis');
    }
    await page.keyboard.press('Escape');
    await expect(stack).toBeHidden();
    await expect(focus).toHaveCount(0);
  });

  test('a parcel click opens the stack on the parcel section, a repeat click retains it, another parcel switches it', async ({ mockApi: page, context }) => {
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
    await expect(parcels.locator('.click-stack__row-title')).toHaveText('Cadastral parcel');
    await expect(parcels.locator('.click-stack__row-detail')).toHaveText(PARCEL_ID);
    await expect(parcels.locator('.click-stack__copy-reference')).toHaveCount(0);
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
    // The fuller selection guidance wraps below a narrow dock, while a wider dock can keep the
    // two controls beside each other. In either layout they do not overlap, keep source order,
    // and both finish before the parcel tabs.
    const selectionEnds = {
      right: selectionBox!.x + selectionBox!.width,
      bottom: selectionBox!.y + selectionBox!.height,
    };
    const customEnds = {
      right: customBox!.x + customBox!.width,
      bottom: customBox!.y + customBox!.height,
    };
    expect(selectionEnds.right <= customBox!.x || selectionEnds.bottom <= customBox!.y).toBe(true);
    expect(selectionBox!.x <= customBox!.x || selectionBox!.y <= customBox!.y).toBe(true);
    expect(Math.max(selectionEnds.bottom, customEnds.bottom)).toBeLessThanOrEqual(tabsBox!.y);
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

    // A repeat click retains the selection.
    await clickMapPoint(page, 15.9821, 45.8002);
    await expect(stack).toBeVisible();
    await expect(page.locator('#parcel-info-panel')).toBeVisible();

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

  // Corridors save through their own atomic transaction (createCorridorProposalAtomically), not
  // the building/park apply, and still open in the stack's Design section on Finish.
  for (const kind of ['road', 'track'] as const) {
    test(`a finished ${kind} opens in the stack's Design section`, async ({ mockApi: page }) => {
      await openCity(page);
      const id = await drawCorridor(page, kind);
      const designs = stackSection(page, 'designs');
      await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
      await expect(designs.locator('#proposal-details-panel')).toBeVisible();
      await expect(designs.locator('#proposal-details-panel [data-proposal-tab="overview"]')).toBeVisible();
      const key = await page.evaluate(proposalId => String((window as any).getProposalKey(
        (window as any).proposalStorage.getProposal(proposalId))), id);
      await expect(designs.locator('#proposal-details-content')).toHaveAttribute('data-proposal-id', key);
    });
  }

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
    await expect(formed.locator('.click-stack__row')).toContainText('Formed parcel');
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

  test('a plan lists its independent agreements without horizontal overflow on mobile', async ({ mockApi: page }) => {
    const titles = ['Garden neighbourhood — shared streets and public gardens', 'Garden neighbourhood — alternative housing and open spaces'];
    await twoAgreementsOnPark(page, titles);
    await page.setViewportSize({ width: 390, height: 844 });
    await expandStackSection(page, 'plans');
    const plans = stackSection(page, 'plans');
    const agreements = plans.locator('.click-stack__choices[data-kind="agreements"]');
    await expect(agreements.locator('.click-stack__chip')).toHaveCount(2);
    await expect(stackSection(page, 'agreements')).toHaveCount(0);
    const size = await clickStack(page).evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await agreements.getByRole('button', { name: titles[1], exact: true }).click();
    await expect(page.locator('section#agreement-panel')).toBeVisible();
    await expect(page.locator('#agreement-panel-title')).toHaveText(titles[1]);
    await expect(clickStack(page)).toBeHidden();
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
