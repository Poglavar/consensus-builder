import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, injectMockEvmWallet } from '../helpers/blockchain';

const WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const MEMBER = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const PASTED_MEMBER = '11111111111111111111111111111111';

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Parcel Lens Owner');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('Proposal Lens picker @features', () => {
  test('the EVM lens adds and removes trusted addresses, opens both address links, and profile language buttons change app language', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { chainIdHex: '0xaa36a7' });
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'metamask');
    await page.locator('#username-display').click();
    const profile = page.locator('.agent-dialog-modal');
    await expect(profile).toBeVisible();
    // The profile's language row is one cb-segmented picker (no toggle): exactly the chosen one is pressed.
    for (const language of ['es', 'sr', 'hr', 'en']) {
      await profile.locator(`[data-language="${language}"]`).click();
      await expect.poll(() => page.evaluate(() => (window as any).i18n.getLanguage())).toBe(language);
      await expect(profile.locator('[data-language][aria-pressed="true"]')).toHaveAttribute('data-language', language);
    }
    await profile.locator('[data-lens-pattern]').click();
    const lens = page.locator('.lens-modal-overlay');
    await expect(lens).toBeVisible();
    const initialRows = await lens.locator('.lens-address-input').count();
    await lens.locator('#lens-add-btn').click();
    await expect(lens.locator('.lens-address-input')).toHaveCount(initialRows + 1);
    const address = '0x1111111111111111111111111111111111111111';
    await lens.locator('.lens-address-input').last().fill(address);
    await lens.locator('.lens-name-input').last().fill('Test lens member');
    await expect.poll(() => page.evaluate(() => (window as any).getLensEntries().at(-1))).toMatchObject({ address, name: 'Test lens member' });

    const etherscanUrl = `https://sepolia.etherscan.io/address/${address}`;
    const attestifyUrl = `http://localhost:3000/address/${address}`;
    const newEntry = lens.locator('.lens-row').nth(initialRows);
    const etherscan = newEntry.locator('.lens-link-btn').nth(0);
    const attestify = newEntry.locator('.lens-link-btn').nth(1);
    await expect(etherscan).toHaveAttribute('href', etherscanUrl);
    await expect(attestify).toHaveAttribute('href', attestifyUrl);
    await page.context().route('https://sepolia.etherscan.io/address/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<title>Etherscan navigation boundary</title>',
    }));
    await page.context().route('http://localhost:3000/address/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<title>Attestify navigation boundary</title>',
    }));

    const etherscanPopup = page.waitForEvent('popup').then(async popup => {
      await expect(popup).toHaveURL(etherscanUrl);
      expect(new URL(popup.url()).hostname).toBe('sepolia.etherscan.io');
      expect(new URL(popup.url()).pathname).toBe(`/address/${address}`);
      await popup.close();
    });
    await Promise.all([etherscanPopup, etherscan.click()]);
    const attestifyPopup = page.waitForEvent('popup').then(async popup => {
      await expect(popup).toHaveURL(attestifyUrl);
      expect(new URL(popup.url()).hostname).toBe('localhost');
      expect(new URL(popup.url()).pathname).toBe(`/address/${address}`);
      await popup.close();
    });
    await Promise.all([attestifyPopup, attestify.click()]);

    await lens.locator('.lens-remove-btn').last().click();
    await expect(lens.locator('.lens-address-input')).toHaveCount(initialRows);
    await expect.poll(() => page.evaluate(key => (window as any).getLensEntries().some((entry: any) => entry.address === key), address)).toBe(false);
    await lens.locator('.lens-close-btn').click();
    await expect(lens).toHaveCount(0);
    await expect(profile).toBeVisible();
  });

  test('selects directory members, adds and removes a pasted key, filters parcel coverage, and blocks an unattested owner offer', async ({ mockApi: page }) => {
    await page.route('**/lenses/members', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ members: [{ key: MEMBER, name: 'Parcel Lens', serviceUrl: 'https://lens-picker-e2e.invalid' }] }),
    }));
    let proofAvailable = true;
    await page.route('**/parcels/*/ownership', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ owners: [{ name: 'Fixture private owner', ownership: '1/1', address: WALLET }] }),
    }));
    await page.route('https://lens-picker-e2e.invalid/lens/attestations**', async route => {
      const url = new URL(route.request().url());
      const attestations = proofAvailable ? [{
        address: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh',
        kind: 'ownership', authority: MEMBER,
        parcelUid: url.searchParams.get('parcelUid'), owner: url.searchParams.get('owner'), expiry: 0,
      }] : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attestations }) });
    });

    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await openParcel(page, 'info');
    await page.locator('#username-display').click();
    const agent = page.locator('.agent-dialog-modal');
    await expect(agent).toBeVisible();
    await agent.locator('[data-lens-pattern]').click();
    const lens = page.locator('.lens-modal-overlay');
    await expect(lens).toBeVisible();
    const member = lens.locator(`[data-lens-member="${MEMBER}"]`);
    await expect(member).toBeVisible();
    await member.check();
    await expect.poll(() => page.evaluate(() => (window as any).LensPicker.getEntries().map((entry: any) => entry.address)))
      .toEqual([MEMBER]);

    await lens.locator('#lens-picker-paste-input').fill(PASTED_MEMBER);
    await lens.locator('[data-lens-paste-add]').click();
    await expect(lens.locator(`[data-lens-remove="${PASTED_MEMBER}"]`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).LensPicker.getEntries().map((entry: any) => entry.address)))
      .toEqual([MEMBER, PASTED_MEMBER]);
    await lens.locator(`[data-lens-remove="${PASTED_MEMBER}"]`).click();
    await expect.poll(() => page.evaluate(() => (window as any).LensPicker.getEntries().map((entry: any) => entry.address)))
      .toEqual([MEMBER]);

    const coverageFilter = lens.locator('[data-lens-only-covered]');
    await expect(coverageFilter).toBeVisible();
    await expect(lens.locator('.lens-picker-parcels')).toContainText(PARCEL_ID);
    await expect(lens.locator('.lens-picker-parcels')).toContainText('attested by Parcel Lens');
    await coverageFilter.check();
    await expect(lens.locator('.lens-picker-parcels')).toContainText(PARCEL_ID);
    await lens.locator('[data-lens-picker-done]').click();

    const drill = page.locator('#drill-stack-panel');
    if (await drill.isVisible()) await drill.getByRole('button', { name: 'Close', exact: true }).click();
    await agent.locator('.agent-dialog-modal-close').click();
    await page.locator('#parcel-info-panel .close-button').click();
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--offer').click();
    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#proposalOwnerOfferCheckbox')).toBeEnabled();
    // Recheck the selected member after its service stops supplying the owner's proof.
    proofAvailable = false;
    await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(dialog.locator('#proposalOwnerOfferStatus')).toContainText('No lens member in your lens has attested', { timeout: 10000 });
    await expect(dialog.locator('#proposalOwnerOfferCheckbox')).toBeDisabled();
  });
});
