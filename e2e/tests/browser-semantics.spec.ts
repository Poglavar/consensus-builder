import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace } from '../helpers/runtime';

async function dialogs(page: any) {
  await page.setContent('<button id="opener">Open editor</button><section id="already-inert" inert><button>Unavailable</button></section>');
  await page.addScriptTag({ path: path.resolve('../frontend/js/ui/modal-escape.js') });
  await page.addScriptTag({ path: path.resolve('../frontend/js/ui/dialogs.js') });
  await page.getByRole('button', { name: 'Open editor' }).focus();
}

// Role locators in the installed Playwright version include inert nodes. Check the browser's
// accessibility tree itself for isolation, alongside native focus/activation assertions.
async function accessibleNames(page: any) {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    return nodes.filter((node: any) => !node.ignored).map((node: any) => node.name?.value);
  } finally { await session.detach(); }
}

test.describe('Browser-readable controls', () => {
  test('modal isolation follows nested dialogs, late background content and focus restoration', async ({ page }) => {
    await dialogs(page);
    await page.evaluate(() => {
      const w = window as any;
      w.parentDialog = w.CbDialog.open({ title: 'Edit garden', body: '<button id="nested-opener">Open details</button>' });
    });
    await expect(page.getByRole('dialog', { name: 'Edit garden' })).toBeVisible();
    await expect.poll(() => accessibleNames(page)).not.toContain('Open editor');
    await page.getByRole('button', { name: 'Open details' }).focus();
    await page.evaluate(() => {
      const w = window as any;
      w.childDialog = w.CbDialog.open({ title: 'Object details', parent: w.parentDialog.body, body: '<input aria-label="Object name">' });
      const background = document.createElement('button'); background.textContent = 'Late background'; document.body.append(background);
    });
    await expect(page.getByRole('dialog', { name: 'Object details' })).toBeVisible();
    await expect.poll(() => accessibleNames(page)).not.toContain('Open details');
    await expect.poll(() => accessibleNames(page)).not.toContain('Late background');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open details' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open editor' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Late background' })).toBeVisible();
    await expect(page.locator('#already-inert')).toHaveAttribute('inert', '');
  });

  test('a registered hidden dialog leaves the page usable and becomes modal only while shown', async ({ page }) => {
    await dialogs(page);
    await page.evaluate(() => {
      const w = window as any, overlay = document.createElement('section');
      overlay.id = 'static-overlay'; overlay.hidden = true;
      overlay.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Later"><button>Later action</button></div>';
      document.body.append(overlay); w.ModalEscape.register(overlay, () => { overlay.hidden = true; });
    });
    await expect.poll(() => accessibleNames(page)).toContain('Open editor');
    await page.evaluate(() => { document.getElementById('static-overlay')!.hidden = false; });
    await expect.poll(() => accessibleNames(page)).not.toContain('Open editor');
    await expect.poll(() => accessibleNames(page)).toContain('Later action');
    await page.keyboard.press('Escape');
    await expect.poll(() => accessibleNames(page)).toContain('Open editor');
  });

  test('a static registered modal can open over a shared dialog and release its background', async ({ page }) => {
    await dialogs(page);
    await page.evaluate(() => {
      const w = window as any;
      w.parentDialog = w.CbDialog.open({ title: 'Parent editor', body: '<button>Parent action</button>' });
      const overlay = document.createElement('section');
      overlay.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Static dialog"><button>Static action</button></div>';
      document.body.append(overlay);
      const release = w.ModalEscape.register(overlay, () => { release(); overlay.remove(); });
    });
    await expect.poll(() => accessibleNames(page)).toContain('Static action');
    await expect.poll(() => accessibleNames(page)).not.toContain('Parent action');
    await page.getByRole('button', { name: 'Static action' }).focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => accessibleNames(page)).toContain('Parent action');
    await page.keyboard.press('Escape');
    await expect.poll(() => accessibleNames(page)).toContain('Open editor');
  });

  test('message dialogs have names and keyboard choices do not leak to the page', async ({ page }) => {
    await dialogs(page);
    await page.evaluate(() => {
      const w = window as any; w.leakedKeys = 0;
      document.addEventListener('keydown', () => w.leakedKeys++);
      void w.CbDialog.choice('Select an object', [{ value: 'tree', label: 'Tree', primary: true }, { value: 'bench', label: 'Bench' }]).then((value: string) => w.answer = value);
    });
    await expect(page.getByRole('alertdialog', { name: 'Select an object' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tree', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Bench', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Tree', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => [(window as any).answer, (window as any).leakedKeys])).toEqual(['tree', 0]);
  });

  test('prompt fields accept Enter and restore their opener', async ({ page }) => {
    await dialogs(page);
    await page.evaluate(() => { void (window as any).CbDialog.prompt('Name the garden').then((value: string) => (window as any).answer = value); });
    await page.getByRole('textbox', { name: 'Name the garden' }).fill('Pocket garden');
    await page.getByRole('textbox', { name: 'Name the garden' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Open editor' })).toBeFocused();
    expect(await page.evaluate(() => (window as any).answer)).toBe('Pocket garden');
  });

  test('account and avatar controls expose their purpose and support native keyboard activation', async ({ mockApi: page }) => {
    await openCity(page);
    const account = page.getByRole('button', { name: /^Your agent:/ });
    await expect(account).toHaveJSProperty('tagName', 'BUTTON');
    await account.press('Space');
    const welcome = page.locator('#welcome-modal');
    await expect(welcome).toBeVisible();
    await expect.poll(() => accessibleNames(page)).not.toContain('Settings');
    const avatar = welcome.getByRole('button', { name: /^Choose your avatar/ });
    await avatar.press('Enter');
    await expect(avatar).toHaveAttribute('aria-expanded', 'true');
    await welcome.locator('.avatar-option').nth(1).press('Enter');
    await expect(avatar).toHaveAccessibleName(/Choose your avatar Avatar 1 selected/);
    await expect(avatar).toBeFocused();
    await welcome.getByRole('button', { name: 'Switch to French', exact: true }).click();
    await expect(welcome.getByRole('button', { name: 'Choisissez votre avatar Avatar 1 sélectionné', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Votre agent:/ })).toBeFocused();
  });

  test('parcel tabs navigate only visible tabs and expose their associated panels', async ({ mockApi: page }) => {
    await openCity(page); await openParcel(page);
    const panel = page.locator('#parcel-info-panel');
    const info = panel.getByRole('tab', { name: 'Info', exact: true });
    await info.focus(); await page.keyboard.press('ArrowRight');
    const selected = panel.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toBeFocused();
    const controls = await selected.getAttribute('aria-controls');
    await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
    await page.keyboard.press('End');
    await expect(panel.locator('[role="tab"][aria-selected="true"]')).toBeFocused();
    await page.keyboard.press('Home');
    const first = panel.getByRole('tab', { name: 'Design', exact: true });
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute('tabindex', '0');
    await expect(panel.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  });

  test('road acquisition help is a named native button with keyboard activation', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => document.getElementById('road-info-panel')!.classList.add('visible'));
    const help = page.getByRole('button', { name: 'Modeled acquisition score', exact: true });
    await expect(help).toHaveJSProperty('tagName', 'BUTTON');
    await help.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Modeled acquisition score', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(help).toBeFocused();
  });

  test('plan membership controls can be found and edited by their design names', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    const title = await page.evaluate(id => {
      const w = window as any, record = w.proposalStorage.getProposal(id);
      void w.PlanDialog.create({ members: [record] }); return record.title;
    }, id);
    const dialog = page.getByRole('dialog', { name: 'Create plan', exact: true });
    const member = dialog.getByRole('checkbox', { name: new RegExp(title) });
    await expect(member).toBeChecked(); await member.uncheck(); await expect(member).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Create plan', exact: true })).toBeDisabled();
  });
});
