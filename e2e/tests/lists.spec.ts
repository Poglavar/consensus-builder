import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';

for (const width of [1280, 390]) {
  test(`Lists shares filters, composes and inspects plans, and removes only browser copies at ${width}px`, async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 844 }); await stubBasemapTiles(page); await openCity(page);
    const agreement = await proposeOverPark(page, { title: 'Residents agreement' });
    await page.locator('#proposals-button').click();
    const sheet = page.locator('#proposals-sheet');
    await expect(page.locator('#proposals-button')).toHaveAccessibleName('Lists');
    await expect(sheet.getByRole('tab')).toHaveCount(3);
    await expect(sheet.locator('#lists-controls')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'Import plan file', exact: true })).toBeHidden();
    await expect(sheet.locator('#proposal-list-host .fa-tree')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-share-nodes')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-trash-can')).toBeVisible();
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
    await page.locator('#proposals-button').click(); await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
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
    expect((await planDownload).suggestedFilename()).toBe('residents-plan.ugt.json');
    await page.keyboard.press('Escape'); await expect(downloadDialog).toBeHidden();
    await expectInsets();
    await expect(planRow).toContainText('Draft'); await expect(planRow).toContainText('This browser');
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
    // The shown designs are marked in the selection colour; any selection behind the list dims.
    await expect(page.locator('.leaflet-container.is-list-previewing .list-preview-focus').first()).toBeAttached();
    await expect(sheet).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeHidden();
    await planRow.getByRole('button', { name: 'Open Residents plan', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeVisible();
    await expect(page.locator('.leaflet-container.is-list-previewing')).toHaveCount(0);
    await expect(page.locator('#click-stack')).toContainText('Residents plan');
    await expect(page.locator('#click-stack').getByRole('button', { name: 'Remove from browser', exact: true })).toHaveCount(0);
    await page.locator('#proposals-button').click();
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
    await page.locator('#proposals-button').click();
    await sheet.locator('[data-list-source="published"]').click(); await expect(agreementRow).toBeVisible();
    // Download: the agreement with its plan's file, which Import agreement file reads back below.
    const agreementDownload = page.waitForEvent('download');
    await agreementRow.getByRole('button', { name: 'Download', exact: true }).click();
    const agreementFile = await agreementDownload;
    expect(agreementFile.suggestedFilename()).toBe('residents-agreement.ugt-agreement.json');
    const agreementChunks: Buffer[] = [];
    for await (const chunk of (await agreementFile.createReadStream())!) agreementChunks.push(Buffer.from(chunk));
    await agreementRow.getByRole('button', { name: 'Share', exact: true }).click();
    await agreementRow.getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect(agreementRow).toBeVisible(); // publication remains; local-copy action disappears
    await expect(agreementRow.getByRole('button', { name: 'Remove from browser', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => (window as any).AgreementStore.get(id), agreement.id)).toBeNull();
    await sheet.locator('[data-list-source="local"]').click(); await expect(sheet.locator('#designs-agreements .lists-item')).toHaveCount(0);
    // Import agreement file brings it back as a local draft under a new id, not as the published one.
    await expect(sheet.locator('#lists-actions .lists-actions__grid > button')).toHaveText(['Create agreement', 'Compare agreements', 'Import agreement file', 'Imported agreements']);
    await sheet.locator('#lists-actions input[data-lists-import-input="agreements"]').setInputFiles({ name: 'residents-agreement.ugt-agreement.json', mimeType: 'application/json', buffer: Buffer.concat(agreementChunks) });
    await page.locator('.cb-dialog').filter({ hasText: 'Review agreement file' }).getByRole('button', { name: 'Import as drafts', exact: true }).click();
    const importedDialog = page.locator('.cb-dialog').filter({ hasText: 'Agreement imported' });
    await expect(importedDialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(importedDialog).toBeHidden();
    const importedRow = sheet.locator('#designs-agreements .lists-item').filter({ hasText: 'Residents agreement' });
    await expect(importedRow).toHaveCount(1); await expect(importedRow).toContainText('Draft');
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Imported agreements', exact: true }).click();
    const importedList = page.locator('.cb-dialog').filter({ hasText: 'Imported agreements' });
    await expect(importedList.getByRole('button', { name: 'Residents agreement', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(importedList).toBeHidden();
    expect(await page.evaluate(id => { const list = (window as any).AgreementStore.list(); return list.length === 1 && list[0].id !== id && !list[0].published; }, agreement.id)).toBe(true);
    await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await planRow.getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
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
    expect((await designDownload).suggestedFilename()).toMatch(/^park.*\.geojson$/);
    await page.keyboard.press('Escape'); await expect(designDialog).toBeHidden();
    await sheet.locator('#proposal-list-host .lists-item').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect(sheet.locator('#proposal-list-host .lists-item')).toHaveCount(0);
  });
}
