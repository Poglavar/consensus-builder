// Verify shared dynamic dialogs and controls produce the expected corridor, plan, and claim effects.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, createBuilding, createSpace, drawCorridor, openCity, openParcel } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';

const BET_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const BET_WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function settledMarkets(outcome: 'yes' | 'no' = 'no') {
  const market = {
    address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000',
    poolAtomic: '300000', resolved: true, outcome,
  };
  const proposal = {
    id: 789, proposalId: 'minted-one', title: 'Plan-led infill', goal: 'single', lifecycleStatus: 'Executed',
    createdAt: '2026-10-01T09:30:00Z', expiresAt: null, author: 'densifier-01', agent: true,
    proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'], proposalAccount: BET_ACCOUNT,
    bettable: false, canOpenMarket: false, market,
  };
  return {
    city: 'zagreb', generatedAt: '2026-10-09T07:00:00.000Z', cluster: 'devnet', stakeDecimals: 6,
    marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    summary: { contests: 1, proposals: 1, markets: 1, openMarkets: 0, poolAtomic: '300000' },
    contests: [{ id: 'c-settled', parcelIds: proposal.parcelIds, proposalCount: 1, mintedCount: 1,
      marketCount: 1, openMarketCount: 0, poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z', proposals: [proposal] }],
  };
}

async function prepareWinningsPage(page: import('@playwright/test').Page, side: 'yes' | 'no' = 'no'): Promise<void> {
  await page.route('**/markets?*', route => route.fulfill({ json: settledMarkets(side) }));
  await injectMockSolanaWallet(page, { publicKey: BET_WALLET, providerName: 'phantom' });
  await openCity(page);
  await connectWalletByConnectorId(page, 'solana-phantom');
  await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
  await page.evaluate(({ account, wallet, side }) => {
    const w = window as any;
    const client = w.SolanaMarketClient;
    const web3 = w.solanaWeb3;
    const proposalKey = new web3.PublicKey(account);
    const walletKey = new web3.PublicKey(wallet);
    const mintKey = new web3.PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const [marketPda] = client.getMarketPda(proposalKey);
    const sideValue = side === 'yes' ? client.constants.SIDE_YES : client.constants.SIDE_NO;
    const [position] = client.getPositionPda(marketPda, walletKey, sideValue);
    const marketBytes = new Uint8Array(client.MARKET_SIZE);
    let offset = 0;
    const put = (bytes: Uint8Array) => { marketBytes.set(bytes, offset); offset += bytes.length; };
    const writeU64 = (value: bigint) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, value, true);
      put(bytes);
    };
    put(Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.Market));
    put(proposalKey.toBytes()); put(mintKey.toBytes()); put(new Uint8Array(32));
    writeU64(250_000n); writeU64(50_000n);
    put(Uint8Array.of(1, side === 'yes' ? 1 : 0, 1)); // resolved, outcome, bump

    const positionBytes = new Uint8Array(client.POSITION_SIZE);
    offset = 0;
    const writePosition = (bytes: Uint8Array) => { positionBytes.set(bytes, offset); offset += bytes.length; };
    writePosition(Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.Position));
    writePosition(marketPda.toBytes()); writePosition(walletKey.toBytes());
    writePosition(Uint8Array.of(sideValue));
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, 100_000n, true);
    writePosition(amount); writePosition(Uint8Array.of(0, 1)); // unclaimed, bump

    const accounts = new Map<string, Uint8Array>([
      [marketPda.toBase58(), marketBytes],
      [position.toBase58(), positionBytes],
    ]);
    const events: string[] = [];
    const connection = {
      getAccountInfo: async (key: any) => {
        const data = accounts.get(key.toBase58());
        return data ? { data, owner: new web3.PublicKey(client.constants.PROGRAM_ID) } : null;
      },
      getMultipleAccountsInfo: async (keys: any[]) => keys.map(key => {
        const data = accounts.get(key.toBase58());
        return data ? { data, owner: new web3.PublicKey(client.constants.PROGRAM_ID) } : null;
      }),
      getBalance: async () => 2_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
      simulateTransaction: async (_tx: unknown, config?: unknown) => {
        if (config !== undefined && !Array.isArray(config)) throw new Error('Invalid arguments');
        return { value: { err: null, logs: [] } };
      },
      sendRawTransaction: async () => { events.push('send'); return '5N2o4X1mockSignature'; },
      confirmTransaction: async () => { events.push('confirm'); return { value: { err: null } }; },
    };
    const provider = w.solanaWalletManager?.getProvider?.();
    if (!provider) throw new Error('Connected Solana provider is unavailable');
    provider.signTransaction = async (transaction: any) => {
      w.__betClaimInstructions = (transaction.instructions || []).map((instruction: any) => ({
        data: Array.from(instruction.data || []),
        keys: (instruction.keys || []).map((key: any) => key.pubkey.toBase58()),
      }));
      transaction.serialize = () => new Uint8Array([1, 2, 3]);
      return transaction;
    };
    w.__betClaimRpcEvents = events;
    w.__betClaimExpectedPosition = position.toBase58();
    w.SolanaChainDataLoader.getConnection = () => connection;
  }, { account: BET_ACCOUNT, wallet: BET_WALLET, side });
}

const ADJACENT_PARCEL_ID = 'HR-335754-1235';

async function startRoadFromAdjacentParcel(page: import('@playwright/test').Page): Promise<void> {
  await openParcel(page, 'proposals', ADJACENT_PARCEL_ID);
  await page.locator('.parcel-transport-btn--road').click();
  await expect(page.locator('#road-drawing-controls')).toBeVisible();
}

async function draftRoadAcrossStructure(page: import('@playwright/test').Page): Promise<void> {
  await clickMapPoint(page, 15.9817, 45.80025);
  await clickMapPoint(page, 15.9827, 45.80025);
  const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
  await expect(choice).toBeVisible();
  await expect(choice).toContainText(/park/i);
}

test.describe('shared dynamic button factories @features', () => {
  test('road close choices can keep the active draft or build it', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
    await clickMapPoint(page, 15.98195, 45.8001);
    await clickMapPoint(page, 15.98215, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    const length = page.locator('#road-length');
    await expect.poll(() => length.innerText()).not.toBe('0 m');
    const drawnLength = await length.innerText();

    const controls = page.locator('#road-drawing-controls');
    await controls.getByRole('button', { name: 'Cancel', exact: true }).click();
    const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
    await expect(choice).toBeVisible();
    await choice.getByRole('button', { name: 'Keep drawing', exact: true }).click();
    await expect(choice).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
    await expect(length).toHaveText(drawnLength);

    await controls.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(choice).toBeVisible();
    await choice.getByRole('button', { name: 'Build it', exact: true }).click();
    await expect(choice).toBeHidden();
    await expect(controls).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .filter((proposal: any) => proposal.applied && proposal.roadProposal).length)).toBe(1);
  });

  test('Discard the drawing closes an unfinished road without creating a proposal', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await clickMapPoint(page, 15.98195, 45.8001);
    await clickMapPoint(page, 15.98215, 45.8001);
    await expect(page.locator('#road-length')).not.toHaveText('0 m');
    const controls = page.locator('#road-drawing-controls');
    await controls.getByRole('button', { name: 'Cancel', exact: true }).click();
    const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
    await expect(choice).toBeVisible();
    await choice.getByRole('button', { name: 'Discard the drawing', exact: true }).click();
    await expect(choice).toBeHidden();
    await expect(controls).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .filter((proposal: any) => proposal.applied && proposal.roadProposal).length)).toBe(0);
  });

  test('Dismiss source warning removes the real failed-building banner', async ({ mockApi: page }) => {
    await page.route('**/buildings/osm?*', route => route.fulfill({
      status: 503, json: { error: 'Reference temporarily unavailable', retryAfterSeconds: 0 },
    }));
    await openCity(page);
    await page.evaluate(() => {
      (document.getElementById('showBuildingsOsm') as HTMLInputElement).checked = true;
      const map = (window as any).map;
      for (let i = 0; i < 5; i += 1) map.panBy([40, 0], { animate: false });
    });

    const banner = page.locator('#building-source-status');
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Dismiss source warning', exact: true }).click();
    await expect(banner).toHaveCount(0);
  });

  test('plan stats Added and Standing change the per-period proposal totals', async ({ mockApi: page }) => {
    await openCity(page);
    const firstId = await createBuilding(page);
    await page.evaluate(id => {
      const store = (window as any).proposalStorage;
      const first = store.getProposal(id);
      if (!first || !store.setProposalEpochYear(id, 2035)) throw new Error('Applied fixture building was not stored');
      const second = JSON.parse(JSON.stringify(first));
      second.proposalId = undefined;
      second.title = 'Second epoch building';
      second.name = second.title;
      second.epochYear = 2040;
      second.createdAt = '2026-10-02T00:00:00.000Z';
      store.addProposal(second);
    }, firstId);

    await page.locator('#proposals-button').click();
    await page.locator('#proposal-list-actions > summary').click();
    await page.locator('#planStatsButton').click();
    const modal = page.locator('#plan-stats-modal');
    await expect(modal).toBeVisible();
    const section = modal.locator('[data-plan-stat="epoch-section"]');
    await expect(section).toBeVisible();
    const table = section.locator('[data-plan-stat="epoch-table"] table');
    const secondYearProposals = table.locator('tr').nth(2).locator('td').nth(1);
    await expect(table.locator('tr').nth(1).locator('td').first()).toHaveText('2035');
    await expect(table.locator('tr').nth(2).locator('td').first()).toHaveText('2040');
    const addedCount = await secondYearProposals.innerText();
    await section.locator('[data-epoch-view="cumulative"]').click();
    await expect.poll(() => secondYearProposals.innerText()).not.toBe(addedCount);
    expect(await secondYearProposals.innerText()).toBe('2');
    await section.locator('[data-epoch-view="added"]').click();
    await expect.poll(() => secondYearProposals.innerText()).toBe(addedCount);
    await modal.getByRole('button', { name: 'Close plan stats' }).click();
    await expect(modal).toBeHidden();
  });

  test('Collect no winnings uses the no side from the Bets row', async ({ mockApi: page }) => {
    await prepareWinningsPage(page);
    await page.locator('#bets-button').click();
    const row = page.locator('#bets-sheet .bets-row').first();
    const collect = row.locator('.bets-row__collect .btn');
    await expect(collect).toHaveText('Collect no winnings');
    await collect.click();
    await expect.poll(() => page.evaluate(() => (window as any).__betClaimRpcEvents)).toEqual(['send', 'confirm']);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const instruction = w.__betClaimInstructions.find((item: any) =>
        w.SolanaMarketClient.IX_DISCRIMINATORS.claim.every((byte: number, index: number) => item.data[index] === byte));
      return instruction?.keys[1];
    })).toBe(await page.evaluate(() => (window as any).__betClaimExpectedPosition));
  });

  test('Collect no winnings uses the no side from the bet dialog', async ({ mockApi: page }) => {
    await prepareWinningsPage(page);
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    const collect = dialog.locator('.bets-dialog__collect .btn');
    await expect(collect).toHaveText('Collect no winnings');
    await collect.click();
    await expect.poll(() => page.evaluate(() => (window as any).__betClaimRpcEvents)).toEqual(['send', 'confirm']);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const instruction = w.__betClaimInstructions.find((item: any) =>
        w.SolanaMarketClient.IX_DISCRIMINATORS.claim.every((byte: number, index: number) => item.data[index] === byte));
      return instruction?.keys[1];
    })).toBe(await page.evaluate(() => (window as any).__betClaimExpectedPosition));
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Collected no winnings.');
  });

  test('Collect yes winnings uses the yes side from the Bets row', async ({ mockApi: page }) => {
    await prepareWinningsPage(page, 'yes');
    await page.locator('#bets-button').click();
    const collect = page.locator('#bets-sheet .bets-row').first().locator('.bets-row__collect .btn');
    await expect(collect).toHaveText('Collect yes winnings');
    await collect.click();
    await expect.poll(() => page.evaluate(() => (window as any).__betClaimRpcEvents)).toEqual(['send', 'confirm']);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const instruction = w.__betClaimInstructions.find((item: any) =>
        w.SolanaMarketClient.IX_DISCRIMINATORS.claim.every((byte: number, index: number) => item.data[index] === byte));
      return instruction?.keys[1];
    })).toBe(await page.evaluate(() => (window as any).__betClaimExpectedPosition));
  });

  test('Collect yes winnings uses the yes side from the bet dialog', async ({ mockApi: page }) => {
    await prepareWinningsPage(page, 'yes');
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    const collect = dialog.locator('.bets-dialog__collect .btn');
    await expect(collect).toHaveText('Collect yes winnings');
    await collect.click();
    await expect.poll(() => page.evaluate(() => (window as any).__betClaimRpcEvents)).toEqual(['send', 'confirm']);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const instruction = w.__betClaimInstructions.find((item: any) =>
        w.SolanaMarketClient.IX_DISCRIMINATORS.claim.every((byte: number, index: number) => item.data[index] === byte));
      return instruction?.keys[1];
    })).toBe(await page.evaluate(() => (window as any).__betClaimExpectedPosition));
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Collected yes winnings.');
  });

  for (const decision of [
    { choice: 'Build through', accepted: true },
    { choice: 'Choose another route', accepted: false },
  ]) {
    test(`road structure-crossing choice ${decision.choice} has its expected drawing effect`, async ({ mockApi: page }) => {
      await openCity(page);
      await createSpace(page, 'park');
      await startRoadFromAdjacentParcel(page);
      await draftRoadAcrossStructure(page);
      const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
      const routeLengthBeforeChoice = await page.locator('#road-length').innerText();
      await choice.getByRole('button', { name: decision.choice, exact: true }).click();
      await expect(choice).toBeHidden();
      if (decision.accepted) {
        await expect.poll(() => page.locator('#road-length').innerText()).not.toBe('0 m');
      } else {
        // Rejecting the crossing keeps the valid route prefix drawn before the obstacle.
        await expect(page.locator('#road-length')).toHaveText(routeLengthBeforeChoice);
        await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
      }
    });
  }

  for (const decision of [
    { choice: 'At-grade crossing', mode: 'at-grade' },
    { choice: 'Underpass', mode: 'underpass' },
    { choice: 'Overpass', mode: 'overpass' },
    { choice: 'Choose another route', mode: 'cancel' },
  ]) {
    test(`pedestrian route crossing choice ${decision.choice} updates the real corridor`, async ({ mockApi: page }) => {
      await openCity(page);
      await drawCorridor(page, 'road');
      await startRoadFromAdjacentParcel(page);
      await page.locator('#editRoadCrossSectionButton').click();
      const editor = page.locator('#corridor-editor-overlay');
      await expect(editor).toBeVisible();
      const laneTypes = editor.locator('.corridor-lane-type');
      for (let index = 0; index < await laneTypes.count(); index += 1) {
        if (await laneTypes.nth(index).inputValue() !== 'sidewalk') await laneTypes.nth(index).selectOption('sidewalk');
      }
      await editor.locator('.corridor-editor-save').click();
      await expect(editor).toBeHidden();
      await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.every((strip: any) => strip.type === 'sidewalk'))).toBe(true);

      await clickMapPoint(page, 15.9822, 45.7998);
      await clickMapPoint(page, 15.9822, 45.8007);
      const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
      await expect(choice).toBeVisible();
      await expect(choice).toContainText('pedestrian route crosses');
      const routeLengthBeforeChoice = await page.locator('#road-length').innerText();
      await choice.getByRole('button', { name: decision.choice, exact: true }).click();
      await expect(choice).toBeHidden();

      if (decision.mode === 'cancel') {
        // Cancel rejects this segment while preserving the route already drawn up to the obstacle.
        await expect(page.locator('#road-length')).toHaveText(routeLengthBeforeChoice);
        await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
        return;
      }

      await expect.poll(() => page.locator('#road-length').innerText()).not.toBe('0 m');
      await page.locator('#finishRoadButton').click();
      await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
        .filter((proposal: any) => proposal.applied && proposal.roadProposal).length)).toBe(2);
      const gradeSeparations = await page.evaluate(() => {
        const roads = (window as any).proposalStorage.getAllProposals().filter((proposal: any) => proposal.roadProposal);
        return roads[roads.length - 1].roadProposal.definition.gradeSeparations || [];
      });
      if (decision.mode === 'at-grade') expect(gradeSeparations).toHaveLength(0);
      else expect(gradeSeparations.map((record: any) => record.mode)).toContain(decision.mode);
    });
  }

  for (const decision of [
    { choice: 'Continue at surface level', action: 'surface' },
    { choice: 'Tunnel through', action: 'tunnel' },
    { choice: 'Choose another route', action: 'cancel' },
  ]) {
    test(`building obstacle choice ${decision.choice} ${decision.action === 'cancel' ? 'keeps the route open' : 'changes the corridor decision'}`, async ({ mockApi: page }) => {
      await openCity(page);
      // These prompts apply to an existing surveyed building. A new proposal building is
      // deliberately forbidden as a crossing and only offers "Choose another route".
      await page.route('**/buildings?*', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [{
          type: 'Feature',
          properties: { id: 'e2e-existing-obstacle', height_m: 12, floors: 4 },
          geometry: { type: 'Polygon', coordinates: [[[15.98205, 45.8002], [15.98235, 45.8002], [15.98235, 45.8003], [15.98205, 45.8003], [15.98205, 45.8002]]] },
        }] }),
      }));
      await startRoadFromAdjacentParcel(page);
      await clickMapPoint(page, 15.9819, 45.80025);
      await clickMapPoint(page, 15.9825, 45.80025);
      const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
      await expect(choice).toBeVisible();
      await expect(choice).toContainText(/building/i);
      const routeLengthBeforeChoice = await page.locator('#road-length').innerText();
      await choice.getByRole('button', { name: decision.choice, exact: true }).click();
      await expect(choice).toBeHidden();
      if (decision.action === 'cancel') {
        // Reject only the segment through the building; retain the valid route prefix.
        await expect(page.locator('#road-length')).toHaveText(routeLengthBeforeChoice);
        await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
        return;
      }
      await expect.poll(() => page.locator('#road-length').innerText()).not.toBe('0 m');
      await page.locator('#finishRoadButton').click();
      await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
        .filter((proposal: any) => proposal.applied && proposal.roadProposal).length)).toBe(1);
      const road = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
        .find((proposal: any) => proposal.applied && proposal.roadProposal));
      const tunnels = road.roadProposal.definition.tunnels || [];
      if (decision.action === 'tunnel') expect(tunnels.length).toBeGreaterThan(0);
      else expect(tunnels).toHaveLength(0);
    });
  }
});
