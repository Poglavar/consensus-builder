// The real 2D and 3D click-stack providers keep semantic markup and follow late theme tokens.
// Backend data is fixture-backed; the app renderers, hosted panels, tabs, and controls are real.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { createSpace, expandStackSection, PARCEL_ID, openParcel, showProposal } from '../helpers/runtime';

async function openLocalCity(page: import('@playwright/test').Page) {
  await page.goto('/?city=zg&backend=http%3A%2F%2Flocalhost%3A4092&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => {
    const w = window as any;
    return !!w.proposalStorage && !!w.CadastralParcelRepository && !!w.ParcelPresenter;
  });
  expect(await page.evaluate(() => (window as any).getBackendBase())).toBe('http://localhost:4092');
  await page.evaluate(async id => {
    const w = window as any;
    w.map.setView([45.80025, 15.9822], 18, { animate: false });
    await w.CadastralParcelRepository.ensureIds([id]);
  }, PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
}

for (const width of [1280, 390]) {
  test(`2D and 3D click-stack semantics at ${width}px`, async ({ mockApi: page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 844 });
    await mockBuildingScene(page);
    await openLocalCity(page);

    // A real map selection opens the 2D provider and its selected-parcel tabs.
    await openParcel(page, 'info');
    const stack2d = page.locator('#click-stack');
    const parcels2d = stack2d.locator('.click-stack__section[data-kind="parcels"]');
    await expect(parcels2d).toBeVisible();
    await expect(parcels2d.locator('#parcel-info-panel')).toBeVisible();
    await expect(page.locator('#parcel-info-panel [data-parcel-tab-id="info-tab"]')).toBeVisible();
    const row2d = parcels2d.locator('.click-stack__row');
    await expect(row2d).toHaveAttribute('aria-expanded', 'true');
    await expect(parcels2d.locator('.click-stack__heading')).toHaveJSProperty('tagName', 'H2');
    await expect(page.locator('#click-stack-parcels-content')).toHaveAttribute('role', 'region');
    await expect(parcels2d.locator('[style]')).toHaveCount(0);
    const parcelShot = testInfo.outputPath(`parcel-info-${width}.png`);
    await page.screenshot({ path: parcelShot });
    await testInfo.attach(`Parcel info ${width}px`, { path: parcelShot, contentType: 'image/png' });
    const baseFamily = await row2d.evaluate(element => getComputedStyle(element).fontFamily);
    expect(await row2d.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');

    // Render an applied design with its actual hosted details panel and buttons.
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    const design = stack2d.locator('.click-stack__section[data-kind="designs"]');
    await expect(design).toBeVisible();
    await expandStackSection(page, 'designs');
    const detailsPanel = design.locator('#proposal-details-panel');
    await expect(detailsPanel).toBeVisible();
    await expect(detailsPanel.locator('[style]')).toHaveCount(0);
    // Add to plan heads the card, above the hosted panel, and the panel's footer does not repeat it.
    const addToPlan = design.locator('.click-stack__actions--design [data-design-action="add-to-plan"]');
    await expect(addToPlan).toBeVisible();
    await expect(addToPlan).toHaveText('Add to plan');
    expect(await addToPlan.evaluate((button, panel) => !!(button.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING), await detailsPanel.elementHandle())).toBe(true);
    await expect(detailsPanel.locator('.proposal-primary-actions > .btn-add-to-plan')).toBeHidden();
    const designActions = detailsPanel.locator('.proposal-primary-actions > button');
    await expect(designActions.first()).toBeVisible();
    const designShot = testInfo.outputPath(`design-details-${width}.png`);
    await page.screenshot({ path: designShot });
    await testInfo.attach(`Design details ${width}px`, { path: designShot, contentType: 'image/png' });
    expect(await designActions.first().evaluate(button => getComputedStyle(button).fontSize)).toBe('14px');

    // A late stylesheet theme changes shared typography tokens; rendered provider content follows.
    await page.addStyleTag({ content: ':root { --cb-text-base: 15px; --cb-text-lg: 17px; --cb-text-sm: 13px; }' });
    const designRow = design.locator('.click-stack__row');
    expect(await designRow.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px');
    expect(await designRow.evaluate(element => getComputedStyle(element).fontFamily)).toBe(baseFamily);
    expect(await designActions.first().evaluate(button => getComputedStyle(button).fontSize)).toBe('15px');

    // Show a real plan through ClickStack.showPlan and the app's DesignMemberships renderer.
    await page.evaluate(async id => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      const plan = w.PlanComposition.create('Click stack semantic plan', [proposal], w.MapShare.capture(w));
      w.PlanWorkspace.save(plan);
      await w.ClickStack.showPlan({ cid: plan.cid, content: plan.content }, { designs: [proposal] });
    }, proposalId);
    const planSection = stack2d.locator('.click-stack__section[data-kind="plans"]');
    await expect(planSection).toBeVisible();
    await expect(planSection).toHaveClass(/is-expanded/);
    const planActions = planSection.locator('.click-stack__actions > button');
    await expect(planActions).toHaveCount(2);
    const planActionSizes = await planActions.evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      return { fontSize: style.fontSize, height: button.getBoundingClientRect().height };
    }));
    expect(planActionSizes.every(action => action.fontSize === '15px' && action.height > 0)).toBe(true);
    expect(Math.abs(planActionSizes[0].height - planActionSizes[1].height)).toBeLessThan(1);
    await expect(planSection.locator('[style]')).toHaveCount(0);

    // Restore the source parcel before showing its 3D value panel; the park design clears its
    // source parcel while applied, so this keeps the fixture's Built/Planned/Proposed figures real.
    await showProposal(page, proposalId);
    const unapply = page.locator(`#proposal-details-panel #proposal-action-btn-${proposalId}`);
    await expect(unapply).toBeVisible();
    await unapply.click();
    await expect.poll(() => page.evaluate(id => !(window as any).proposalStorage.getProposal(id)?.applied, proposalId)).toBe(true);

    // Enter model mode and use the actual app entry point for its parcel provider.
    await page.locator('#mode-3d-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 60000 });
    await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
    await page.evaluate(id => (window as any).showThreeModeParcel(id), PARCEL_ID);
    const stack3d = page.locator('#three-click-stack');
    const parcels3d = stack3d.locator('.click-stack__section[data-kind="parcels"]');
    await expect(parcels3d).toBeVisible();
    await expect(parcels3d).toHaveClass(/is-expanded/);
    await expect(stack3d.locator('#three-click-stack-parcels-content')).toHaveAttribute('role', 'region');
    const headings3d = await stack3d.locator('.click-stack__heading').evaluateAll(headings => headings.map(heading => heading.tagName));
    expect(headings3d.length).toBeGreaterThan(0);
    expect(headings3d.every(tag => tag === 'H2')).toBe(true);
    const row3d = parcels3d.locator('.click-stack__row');
    const row3dStyle = await row3d.evaluate(element => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize, minHeight: style.minHeight };
    });
    expect(row3dStyle.family).toBe(baseFamily);
    expect(row3dStyle.size).toBe('15px');
    expect(parseFloat(row3dStyle.minHeight)).toBeGreaterThanOrEqual(36);

    const parcelPanel = parcels3d.locator('.three-mode-parcel-panel');
    await expect(parcelPanel).toBeVisible();
    const tableSemantics = await parcelPanel.evaluate(panel => {
      const table = panel.querySelector('table')!;
      const sliders = [...panel.querySelectorAll<HTMLInputElement>('input[type="range"]')];
      const cells = [...table.querySelectorAll('th, td')];
      return {
        headRows: table.querySelectorAll('thead tr').length,
        bodyRows: table.querySelectorAll('tbody tr').length,
        columnScopes: [...table.querySelectorAll('thead th')].map(cell => cell.scope),
        rowScopes: [...table.querySelectorAll('tbody th')].map(cell => cell.scope),
        slidersLabelled: sliders.every(slider => !!slider.id && !!panel.querySelector(`label[for="${slider.id}"]`)),
        notesAreParagraphs: [...panel.querySelectorAll('.parcel-panel-note, .parcel-panel-subnote')].every(note => note.tagName === 'P'),
        inlineStyles: panel.querySelectorAll('[style]').length,
        tableSize: getComputedStyle(table).fontSize,
        largestFigure: Math.max(...cells.map(cell => parseFloat(getComputedStyle(cell).fontSize))),
      };
    });
    expect(tableSemantics).toMatchObject({ headRows: 1, columnScopes: ['col', 'col', 'col', 'col'],
      slidersLabelled: true, notesAreParagraphs: true, inlineStyles: 0, tableSize: '15px' });
    expect(tableSemantics.bodyRows).toBeGreaterThan(0);
    expect(tableSemantics.rowScopes.every(scope => scope === 'row')).toBe(true);
    expect(tableSemantics.largestFigure).toBeLessThanOrEqual(15);

    const screenshot = testInfo.outputPath(`click-stack-semantics-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`Click stack semantics ${width}px`, { path: screenshot, contentType: 'image/png' });
  });
}
