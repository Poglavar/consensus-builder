import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';
import { selectNativeOption } from '../helpers/controls';

for (const width of [1280, 390]) {
  test(`Lists shares filters, composes and inspects plans, and deletes only drafts at ${width}px`, async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 844 }); await stubBasemapTiles(page); await openCity(page);
    const agreement = await proposeOverPark(page, { title: 'Residents agreement' });
    const openLists = async () => {
      // On phones the contextual stack owns the screen while a selection is open.
      // Dismiss it before moving to the bottom-navigation Lists surface.
      if (width < 768 && await page.locator('#click-stack').isVisible()) {
        await page.keyboard.press('Escape');
        await expect(page.locator('#click-stack')).toBeHidden();
      }
      await page.locator('#proposals-button').click();
    };
    await openLists();
    const sheet = page.locator('#proposals-sheet');
    await expect(page.locator('#proposals-button')).toHaveAccessibleName('Lists');
    await expect(sheet.getByRole('tab')).toHaveCount(3);
    await expect(sheet.locator('#lists-controls')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'Import plan file', exact: true })).toBeHidden();
    await expect(sheet.locator('#proposal-list-host .fa-tree')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-share-nodes')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-trash-can')).toHaveCount(0); // a published design has no delete
    const expectInsets = async () => {
      const insets = await sheet.evaluate(el => {
        const body = el.querySelector('.lists-body')!.getBoundingClientRect();
        return ['#lists-controls', '#lists-actions', '#lists-status', '[role="tabpanel"]:not([hidden])']
          .map(selector => { const rect = el.querySelector(selector)!.getBoundingClientRect();
            return { left: rect.left - body.left, right: body.right - rect.right }; });
      });
      for (const inset of insets) { expect(inset.left).toBeGreaterThanOrEqual(10); expect(inset.right).toBeGreaterThanOrEqual(10); }
    };
    await expectInsets();
    await expect(sheet.locator('input[type=checkbox]')).toHaveCount(0);
    // Every tab: Create, Compare, Import and Imported two to a row, the file formats below; one count.
    await expect(sheet.locator('#lists-actions .lists-actions__grid > button')).toHaveText(['Create plan', 'Compare designs', 'Import design file', 'Imported designs']);
    await expect(sheet.locator('#lists-actions .lists-actions__help')).toHaveText('File formats and limits');
    const sizes = await sheet.locator('#lists-actions .lists-actions__grid > button').evaluateAll(buttons => buttons.map(b => Math.round(b.getBoundingClientRect().width)));
    expect(new Set(sizes).size).toBe(1);
    await expect(sheet.locator('#lists-status')).toHaveText('Shown: 1');
    await expect(sheet.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search…');
    // A plan's designs are ticked here, from Plans → Create plan as from Designs, and shown on the map together.
    await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await expect(sheet.locator('#lists-actions .lists-actions__grid > button')).toHaveText(['Create plan', 'Compare plans', 'Import plan file', 'Imported plans']);
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Compare plans', exact: true }).click();
    await expect(sheet.locator('#lists-actions .lists-actions__selecting')).toBeVisible();
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sheet.locator('#lists-actions .lists-actions__selecting')).toHaveCount(0);
    await expect(sheet.locator('#lists-actions .lists-actions__grid')).toBeVisible();
    await expect(sheet.locator('#plan-list-host input[type=checkbox]')).toHaveCount(0);
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Create plan', exact: true }).click();
    await expect(sheet.getByRole('tab', { name: 'Designs', exact: true })).toHaveAttribute('aria-selected', 'true');
    const next = sheet.getByRole('button', { name: 'Continue', exact: true }); await expect(next).toBeDisabled();
    await sheet.locator('#proposal-list-host input[type=checkbox]').check(); await expect(next).toBeEnabled();
    await expect(page.locator('.leaflet-container.is-list-previewing')).toHaveCount(1);
    await next.click();
    const form = page.locator('.plan-composer'); await expect(form.locator('input[type=checkbox]')).toHaveCount(0);
    await expect(form.locator('.plan-dialog__members li')).toHaveCount(1);
    // Change designs goes back to the list with the chosen designs still ticked.
    await form.getByRole('button', { name: 'Change designs', exact: true }).click();
    await expect(sheet.locator('#proposal-list-host input[type=checkbox]')).toBeChecked();
    await next.click();
    await form.getByLabel('Plan name', { exact: true }).fill('Residents plan');
    await form.getByRole('button', { name: 'Create plan', exact: true }).click();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"] .click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await openLists(); await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await expect(sheet.locator('#designs-browse')).toBeHidden();
    const planRow = sheet.locator('#designs-plans .lists-item').filter({ hasText: 'Residents plan' });
    await expect(sheet.locator('#lists-actions').getByRole('button', { name: 'Import plan file', exact: true })).toBeVisible();
    await expect(sheet.locator('#lists-actions [data-lists-import="plans"] .fa-file-import')).toBeVisible();
    await expect(planRow.locator('.lists-item__icon .cb-icon-plan')).toBeVisible();
    await expect(planRow.getByRole('button', { name: 'Plan stats', exact: true })).toBeVisible();
    const rooster = planRow.getByRole('button', { name: 'Urban rooster', exact: true });
    await expect(rooster.locator('img')).toBeVisible();
    expect(await rooster.locator('img').evaluate(img => getComputedStyle(img).filter)).toBe('none');
    await planRow.getByRole('button', { name: 'Plan stats', exact: true }).click();
    await expect(page.locator('#plan-stats-modal [data-plan-stat="scope"]')).toContainText('Residents plan');
    await page.keyboard.press('Escape');
    await expect(page.locator('#plan-stats-modal')).toBeHidden();
    // Download: the plan as an editable plan file, named after its title; no import in that dialog.
    await planRow.getByRole('button', { name: 'Download', exact: true }).click();
    const downloadDialog = page.locator('.cb-dialog').filter({ hasText: 'Download plan' });
    await expect(downloadDialog.locator('[data-plan-file-action="import"]')).toHaveCount(0);
    const planDownload = page.waitForEvent('download');
    await downloadDialog.getByRole('button', { name: 'Download editable plan', exact: true }).click();
    const downloadedPlan = await planDownload;
    expect(downloadedPlan.suggestedFilename()).toBe('residents-plan.ugt.json');
    const planChunks: Buffer[] = [];
    for await (const chunk of (await downloadedPlan.createReadStream())!) planChunks.push(Buffer.from(chunk));
    await page.keyboard.press('Escape'); await expect(downloadDialog).toBeHidden();
    const planPicker = page.waitForEvent('filechooser');
    await sheet.locator('[data-lists-import="plans"]').click();
    await (await planPicker).setFiles({ name: downloadedPlan.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.concat(planChunks) });
    await expect(page.getByRole('heading', { name: 'Review plan file', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Import as drafts', exact: true }).click();
    const planImported = page.locator('.cb-dialog').filter({ hasText: 'Plan imported' });
    await expect(planImported).toBeVisible(); await page.keyboard.press('Escape'); await expect(planImported).toBeHidden();
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Imported plans', exact: true }).click();
    const importedPlans = page.locator('.cb-dialog').filter({ hasText: 'Imported plans' });
    const importedPlanButton = importedPlans.getByRole('button', { name: /Residents plan/ });
    await expect(importedPlanButton).toBeVisible();
    const importedPlanBox = (await importedPlans.boundingBox())!;
    expect(importedPlanBox.x).toBeGreaterThanOrEqual(0);
    expect(importedPlanBox.x + importedPlanBox.width).toBeLessThanOrEqual(width);
    expect(await importedPlans.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(importedPlans).toBeHidden();
    const savedPlanCids = await page.evaluate(() => (window as any).PlanWorkspace.list().map((row:any) => row.cid));
    await planRow.getByRole('button', { name: 'Construction schedule', exact: true }).click();
    const scheduleEditor = page.locator('.plan-schedule');
    await expect(scheduleEditor.locator('.plan-schedule__rows li')).toHaveCount(1);
    const scheduleBox = (await page.locator('.cb-dialog').filter({ has: scheduleEditor }).boundingBox())!;
    expect(scheduleBox.x).toBeGreaterThanOrEqual(0);
    expect(scheduleBox.x + scheduleBox.width).toBeLessThanOrEqual(width);
    await scheduleEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(scheduleEditor).toBeHidden();
    expect(await page.evaluate(() => (window as any).PlanWorkspace.list().map((row:any) => row.cid))).toEqual(savedPlanCids);
    await openLists(); await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await expectInsets();
    await expect(planRow).toContainText('Draft');
    // The title shows the plan on the map and keeps the list open; Open selects it.
    const parkInView = () => page.evaluate(id => {
      const w = window as any;
      const [west, south, east, north] = w.__proposalCounts.proposalBounds(w.proposalStorage.getProposal(id));
      return w.map.getBounds().contains([[south, west], [north, east]]);
    }, agreement.parkId);
    await page.evaluate(() => (window as any).map.setView([45.70, 15.80], 17, { animate: false }));
    expect(await parkInView()).toBe(false);
    await expect(planRow.getByRole('heading', { name: 'Residents plan', exact: true })).toBeVisible();
    await planRow.getByRole('heading', { name: 'Residents plan', exact: true }).click();
    await expect.poll(parkInView).toBe(true);
    await expect(planRow).toHaveClass(/is-selected/);
    // The map moves over at the same zoom (instantly: the specs reduce motion), and stays put for a
    // plan already in view.
    const view = () => page.evaluate(() => { const m = (window as any).map; return { zoom: m.getZoom(), center: m.getCenter() }; });
    const shown = await view();
    expect(shown.zoom).toBe(17);
    await planRow.getByRole('heading', { name: 'Residents plan', exact: true }).click();
    expect(await view()).toEqual(shown);
    // The shown designs are marked in the selection colour; any selection behind the list dims.
    await expect(page.locator('.leaflet-container.is-list-previewing .list-preview-focus').first()).toBeAttached();
    await expect(sheet).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeHidden();
    const planIdBadge = planRow.locator('.record-id');
    await expect(planIdBadge).toHaveAttribute('title', await planRow.getAttribute('data-list-id'));
    const planShortId = await planIdBadge.textContent();
    await planRow.getByRole('button', { name: `Open Residents plan · ${planShortId}`, exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeVisible();
    await expect(page.locator('.leaflet-container.is-list-previewing')).toHaveCount(0);
    await expect(page.locator('#click-stack')).toContainText('Residents plan');
    await expect(page.locator('#click-stack').getByRole('button', { name: 'Delete draft', exact: true })).toHaveCount(0);
    await openLists();
    await sheet.getByRole('searchbox').fill('Residents');
    await sheet.getByRole('tab', { name: 'Agreements', exact: true }).click();
    await expect(sheet.getByRole('searchbox')).toHaveValue('Residents');
    await expect(sheet.locator('#designs-browse')).toBeHidden();
    await expect(sheet.locator('#designs-plans')).toBeHidden();
    const agreementRow = sheet.locator('#designs-agreements .lists-item').filter({ hasText: 'Residents agreement' });
    await expect(sheet.getByRole('button', { name: 'Import plan file', exact: true })).toBeHidden();
    await expect(agreementRow.locator('.lists-item__icon .cb-icon-agreement')).toBeVisible();
    await expectInsets();
    await page.evaluate(() => (window as any).map.setView([45.70, 15.80], 17, { animate: false }));
    // Anywhere on the row shows the agreement's plan; closing the list by hand selects it, as Open does.
    await agreementRow.locator('.lists-item__badges').click();
    await expect.poll(parkInView).toBe(true);
    await expect(agreementRow).toHaveClass(/is-selected/);
    await expect(sheet).toBeVisible();
    await page.locator('#proposals-button').click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#click-stack')).toContainText('Residents agreement');
    await expect(page.locator('[data-agreement-action="delete"]')).toHaveCount(0);
    await openLists();
    await expect(agreementRow).toBeVisible();
    // Download: the agreement with its plan's file, which Import agreement file reads back below.
    const agreementDownload = page.waitForEvent('download');
    await agreementRow.getByRole('button', { name: 'Download', exact: true }).click();
    const agreementFile = await agreementDownload;
    expect(agreementFile.suggestedFilename()).toBe('residents-agreement.ugt-agreement.json');
    const agreementChunks: Buffer[] = [];
    for await (const chunk of (await agreementFile.createReadStream())!) agreementChunks.push(Buffer.from(chunk));
    await agreementRow.getByRole('button', { name: 'Share', exact: true }).click();
    // A published agreement has no delete: this browser's copy is its cache.
    await expect(agreementRow).toContainText('Published');
    await expect(agreementRow.getByRole('button', { name: 'Delete draft', exact: true })).toHaveCount(0);
    // Import agreement file adds a local draft under a new id beside the published one.
    await expect(sheet.locator('#lists-actions .lists-actions__grid > button')).toHaveText(['Create agreement', 'Compare agreements', 'Import agreement file', 'Imported agreements']);
    const agreementPicker = page.waitForEvent('filechooser');
    await sheet.locator('[data-lists-import="agreements"]').click();
    await (await agreementPicker).setFiles({ name: 'residents-agreement.ugt-agreement.json', mimeType: 'application/json', buffer: Buffer.concat(agreementChunks) });
    await page.locator('.cb-dialog').filter({ hasText: 'Review agreement file' }).getByRole('button', { name: 'Import as drafts', exact: true }).click();
    const importedDialog = page.locator('.cb-dialog').filter({ hasText: 'Agreement imported' });
    await expect(importedDialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(importedDialog).toBeHidden();
    const importedRow = sheet.locator(`#designs-agreements .lists-item:not([data-list-id="${agreement.id}"])`).filter({ hasText: 'Residents agreement' });
    await expect(importedRow).toHaveCount(1); await expect(importedRow).toContainText('Draft');
    await sheet.locator('.lists-filter-toggle').click();
    const publication = sheet.locator('[data-list-filter="publication"]');
    await selectNativeOption(publication, 'published');
    await expect(sheet.locator(`#designs-agreements .lists-item[data-list-id="${agreement.id}"]`)).toBeVisible();
    await expect(importedRow).toHaveCount(0);
    await sheet.getByRole('searchbox').fill('no agreement with this title');
    await selectNativeOption(sheet.locator('[data-list-filter="sort"]'), 'newest');
    await sheet.locator('#lists-filter-panel').getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(sheet.getByRole('searchbox')).toHaveValue('');
    await expect(sheet.locator('[data-list-filter="publication"]')).toHaveValue('all');
    await expect(sheet.locator('[data-list-filter="sort"]')).toHaveValue('title');
    await expect(importedRow).toHaveCount(1);
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Imported agreements', exact: true }).click();
    const importedList = page.locator('.cb-dialog').filter({ hasText: 'Imported agreements' });
    await expect(importedList.locator('.record-id')).toBeVisible();
    await expect(importedList.getByRole('button', { name: /^Residents agreement …/ })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(importedList).toBeHidden();
    expect(await page.evaluate(id => (window as any).AgreementStore.list().map((row: any) => row.id === id || !row.published), agreement.id)).toEqual([true, true]);
    await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await planRow.getByRole('button', { name: 'Delete draft', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Delete draft', exact: true }).click();
    await expect(planRow).toHaveCount(0);
    expect(await page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), agreement.parkId)).toBe(true);
    expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await sheet.getByRole('searchbox').fill('');
    await sheet.getByRole('tab', { name: 'Designs', exact: true }).click();
    // A design downloads as a one-design GeoJSON too.
    await sheet.locator('#proposal-list-host .lists-item').getByRole('button', { name: 'Download', exact: true }).click();
    const designDialog = page.locator('.cb-dialog').filter({ hasText: 'Download design' });
    const designDownload = page.waitForEvent('download');
    await designDialog.getByRole('button', { name: 'Download GeoJSON', exact: true }).click();
    const downloadedDesign = await designDownload;
    expect(downloadedDesign.suggestedFilename()).toMatch(/^park.*\.geojson$/);
    await page.keyboard.press('Escape'); await expect(designDialog).toBeHidden();
    const designFile = await page.evaluate(async id => {
      const w = window as any;
      const record = structuredClone(w.proposalStorage.getProposal(id));
      record.title = 'Residents design import'; record.name = record.title;
      return w.PlanFile.stringify(await w.PlanFile.create([record], {
        title: record.title, view: w.MapShare.capture(w)
      }));
    }, agreement.parkId);
    const designPicker = page.waitForEvent('filechooser');
    await sheet.locator('[data-lists-import="designs"]').click();
    await (await designPicker).setFiles({ name: 'residents-design.ugt.json', mimeType: 'application/json', buffer: Buffer.from(designFile) });
    await expect(page.getByRole('heading', { name: 'Review design file', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Import as drafts', exact: true }).click();
    await expect(page.locator('.ephemeral-message[role="status"]').filter({ hasText: 'Designs imported as local drafts: 1' })).toBeVisible();
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Imported designs', exact: true }).click();
    const importedDesigns = page.locator('.cb-dialog').filter({ hasText: 'Imported designs' });
    const importedDesignButton = importedDesigns.getByRole('button', { name: /Residents design import/ });
    await expect(importedDesignButton).toBeVisible();
    await expect(importedDesignButton.locator('.record-id')).toBeVisible();
    const importedDesignBox = (await importedDesigns.boundingBox())!;
    expect(importedDesignBox.x).toBeGreaterThanOrEqual(0);
    expect(importedDesignBox.x + importedDesignBox.width).toBeLessThanOrEqual(width);
    expect(await importedDesigns.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(importedDesigns).toBeHidden();
    // The design is published, so it has no delete either.
    const originalDesign = sheet.locator(`#proposal-list-host .lists-item[data-list-id="${agreement.parkId}"]`);
    await expect(originalDesign).toContainText('Published');
    await expect(originalDesign.getByRole('button', { name: 'Delete draft', exact: true })).toHaveCount(0);
    const importedDesign = sheet.locator('#proposal-list-host .lists-item').filter({ hasText: 'Residents design import' });
    await expect(importedDesign).toContainText('Draft');
    await expect(importedDesign.getByRole('button', { name: 'Delete draft', exact: true })).toBeVisible();
  });
}

test('Load more appends the next page of saved plans', async ({ mockApi: page }) => {
  const offsets: number[] = [];
  await page.route('**/plans?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0);
    offsets.push(offset);
    const cid = `fixture-plan-${offset}`;
    const plan = { cid, title: offset ? 'Second page plan' : 'First page plan', author: 'Fixture', createdAt: '2026-10-01T00:00:00.000Z',
      content: { title: offset ? 'Second page plan' : 'First page plan', designCids: [] } };
    return route.fulfill({ json: { plans: [plan], hasMore: offset === 0, nextOffset: 1 } });
  });
  await openCity(page);
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
  const rows = sheet.locator('#plan-list-host .lists-item');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('First page plan');
  await sheet.locator('#plan-list-host').getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Second page plan');
  await expect(sheet.locator('#lists-status')).toHaveText('Shown: 2');
  expect(offsets).toEqual([0, 1]);
});
