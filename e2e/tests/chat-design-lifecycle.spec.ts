import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { showProposal } from '../helpers/runtime';
import { stubBasemapTiles } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { fixtureSiteBinding } from '../helpers/mocks/site-binding';
import { privatePreview } from '../helpers/private-preview';
import type { Page } from '@playwright/test';

const cid = require('../../frontend/js/cid.js');
const turf = require('../../backend/node_modules/@turf/turf');
const sampleParcel = sampleParcels.features[4];
const backend = 'http://localhost:3196';
const externalArtifactsPath = process.env.CHAT_LIFECYCLE_ARTIFACTS;

function lifecycleFixtures(): Record<string, any> {
  const rows = externalArtifactsPath
    ? JSON.parse(readFileSync(path.resolve(externalArtifactsPath), 'utf8'))
    : JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { buildDesignFixtures } from ${JSON.stringify(new URL('../../backend/scripts/chat-eval-lifecycle-cases.js', `file://${__filename}`).href)};
      const args = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(buildDesignFixtures(args)));
    `], {
      input: JSON.stringify({ site: sampleParcel.geometry, city: 'zagreb', sourceParcel: { id: sampleParcel.properties.parcelId, feature: sampleParcel } }),
      encoding: 'utf8'
    }));
  const source = rows.designs || rows.artifacts || rows;
  const entries = Array.isArray(source)
    ? source.map((row: any) => [String(row.id || row.caseId || row.design?.title), row])
    : Object.entries(source);
  return Object.fromEntries(entries.flatMap(([key, value]: [string, any]) => {
    const artifact = value?.design ? value : value?.artifact?.design ? value.artifact : { design: value };
    return artifact.design?.schema === 'design/v1' ? [[key, artifact]] : [];
  }));
}

const fixtures = lifecycleFixtures();
if (!Object.keys(fixtures).length) throw new Error('No canonical design lifecycle fixtures were found.');

function localUrl(url: string, city = 'zg', at = '45.8009,15.9833,18'): string {
  const result = new URL(url);
  result.searchParams.set('backend', backend);
  result.searchParams.set('city', city);
  result.searchParams.set('at', at);
  result.searchParams.set('reduceMotion', '1');
  return result.toString();
}

function controlGroundFeatures(fixture: any): any[] {
  const ground = fixture.controlGround;
  if (externalArtifactsPath && (ground?.type !== 'FeatureCollection' || !Array.isArray(ground.features))) {
    throw new Error('External lifecycle artifacts need a FeatureCollection controlGround.');
  }
  if (ground?.type !== 'FeatureCollection' || !Array.isArray(ground.features)) return [sampleParcel];
  return ground.features;
}

function parcelIdsFrom(features: any[]): string[] {
  return [...new Set(features.map(feature => String(feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.id || ''))
    .filter(Boolean))].sort();
}

function locationFor(fixture: any): string {
  const at = fixture.plan?.view?.at;
  if (typeof at === 'string') return at;
  const positions: number[][] = [];
  const visit = (value: any): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') positions.push(value);
    else value.forEach(visit);
  };
  visit(fixture.design?.site?.coordinates || fixture.design?.geometry?.site?.coordinates);
  if (!positions.length) return '45.8009,15.9833,18';
  const lons = positions.map(point => point[0]), lats = positions.map(point => point[1]);
  return `${(Math.min(...lats) + Math.max(...lats)) / 2},${(Math.min(...lons) + Math.max(...lons)) / 2},18`;
}

async function installExternalGround(page: Page, fixture: any): Promise<void> {
  if (!externalArtifactsPath) return;
  if (!fixture.parcelSourceId || !fixture.controlGround || !fixture.controlGroundBasis) {
    throw new Error('External lifecycle artifacts must declare parcelSourceId, controlGround, and controlGroundBasis.');
  }
  const features = controlGroundFeatures(fixture);
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/parcels') && !url.pathname.includes('/parcels/')) return route.continue();
    return route.fulfill({ status: 500, json: { error: 'External lifecycle fixture requires its source-qualified parcel endpoint.' } });
  });
  const sourcePath = `/parcel-sources/${encodeURIComponent(fixture.parcelSourceId)}`;
  await page.route(url => url.pathname === sourcePath || url.pathname === `${sourcePath}/under`, route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `${sourcePath}/under` && request.method() === 'POST') {
      const body = request.postDataJSON();
      const query = turf.feature(body?.geometry);
      const selected = features.filter(feature => turf.booleanIntersects(feature, query));
      return route.fulfill({ json: { complete: true, sourceId: fixture.parcelSourceId, snapshotId: null,
        sourceSrid: 'EPSG:4326', returnsWGS84: true, features: selected } });
    }
    if (request.method() !== 'GET' || url.pathname !== sourcePath) {
      return route.fulfill({ status: 405, json: { error: 'Unsupported external fixture parcel request.' } });
    }
    const ids = url.searchParams.get('ids');
    if (ids) {
      const wanted = new Set(ids.split(',').map(String));
      const selected = features.filter(feature => wanted.has(String(feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.id || '')));
      const found = new Set(selected.map(feature => String(feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.id || '')));
      return route.fulfill({ json: { complete: true, sourceId: fixture.parcelSourceId, snapshotId: null,
        sourceSrid: 'EPSG:4326', returnsWGS84: true, features: selected, absentIds: [...wanted].filter(id => !found.has(id)) } });
    }
    const bbox = url.searchParams.get('bbox')?.split(',').map(Number) || [];
    if (bbox.length === 4 && bbox.every(Number.isFinite)) {
      const selected = features.filter(feature => {
        const box = turf.bbox(feature);
        return box[0] <= bbox[2] && box[2] >= bbox[0] && box[1] <= bbox[3] && box[3] >= bbox[1];
      });
      return route.fulfill({ json: { complete: true, sourceId: fixture.parcelSourceId, snapshotId: null,
        sourceSrid: 'EPSG:4326', returnsWGS84: true, features: selected } });
    }
    return route.fulfill({ status: 400, json: { error: 'External fixture parcel request needs ids or bbox.' } });
  });
  await page.route('**/designs/binding', route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    const binding = fixtureSiteBinding(body.site, Number(body.toleranceM) || 0, features);
    return route.fulfill({ json: { city: null, parcelSourceId: fixture.parcelSourceId,
      binding: { ...binding, parcelSource: { sourceId: fixture.parcelSourceId, snapshotId: null } } } });
  });
}

async function openFixture(page: Page, baseURL: string, fixture: any): Promise<void> {
  const parcelSourceId = fixture.parcelSourceId || 'oss-wfs';
  const preview = fixture.plan && Array.isArray(fixture.designs)
    ? { plan: fixture.plan, designs: fixture.designs.map((row: any) => row.design || row), parcelSourceId }
    : { design: fixture.design, parcelSourceId };
  const url = await privatePreview(page, baseURL, preview);
  await page.goto(localUrl(url, fixture.design.city || 'zg', locationFor(fixture)), { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
}

async function storedDesign(page: Page, designCid: string, cadastreIds: string[]): Promise<any> {
  return page.evaluate(({ expectedCid, cadastreIds }: { expectedCid: string; cadastreIds: string[] }) => {
    const w = window as any;
    const record = (w.proposalStorage?.getAllProposals?.() || []).find((row: any) => {
      try { return w.DesignRecord.cidOf(row) === expectedCid; } catch (_) { return false; }
    });
    if (!record) return null;
    const features = w.LiveParcelFabric.entriesForCadastre(cadastreIds) || [];
    const ground = features.map((feature: any) => ({
      id: w.LiveParcelFabric.featureId(feature), geometry: feature.geometry,
      producer: feature.properties?.producedByProposalId || null,
      cadastreParcelIds: feature.properties?.cadastreParcelIds || []
    })).sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    const outputs = w.LiveParcelFabric.producedBy(String(record.proposalId)) || [];
    const outputRows = outputs.map((feature: any) => ({ id: w.LiveParcelFabric.featureId(feature), geometry: feature.geometry }))
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    const visual = w.ClickStackHits.featuresFor('designs', { id: String(record.proposalId), proposal: record })
      .map((feature: any) => feature.geometry);
    return { id: String(record.proposalId), applied: w.isApplied(record), cid: w.DesignRecord.cidOf(record), ground, outputs: outputRows, visual };
  }, { expectedCid: designCid, cadastreIds });
}

async function expectButtonAction(page: Page, id: string, label: RegExp): Promise<void> {
  await showProposal(page, id);
  const button = page.locator(`[id="proposal-action-btn-${id}"]`);
  await expect(button).toContainText(label);
  await button.focus();
  await button.press('Enter');
}

test.describe('Private authored design apply and unapply lifecycle @core', () => {
  for (const [caseId, fixture] of Object.entries(fixtures)) {
    const design = fixture.design;
    const designCid = fixture.cid || cid.cidOfObject(design);
    const cadastreIds = parcelIdsFrom(controlGroundFeatures(fixture));
    const city = design.city || 'zg';
    const at = locationFor(fixture);
    const groundLabel = fixture.controlGroundBasis ? ` [${fixture.controlGroundBasis}]` : '';
    const noOp = ['as-is', 'ownership-transfer'].includes(design.goal);
    const unsupported = design.goal === 'urban-rule';

    test(`${caseId}: ${design.goal} preserves canonical geometry through map lifecycle${groundLabel}`, async ({ mockApi: page, baseURL }) => {
      test.setTimeout(120_000);
      const browserFailures: string[] = [];
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') browserFailures.push(message.text());
      });
      await stubBasemapTiles(page);
      await installExternalGround(page, fixture);
      await page.goto(localUrl(`${baseURL}/`, city, at), { waitUntil: 'domcontentloaded' });
      await waitForMapReady(page);
      await page.evaluate(async (parcelIds: string[]) => {
        const w = window as any;
        await w.CadastralParcelRepository.ensureIds(parcelIds);
      }, cadastreIds);
      let groundBefore = await page.evaluate((parcelIds: string[]) => {
        const w = window as any;
        return (w.LiveParcelFabric.entriesForCadastre(parcelIds) || []).map((feature: any) => ({
          id: w.LiveParcelFabric.featureId(feature), geometry: feature.geometry,
          producer: feature.properties?.producedByProposalId || null,
          cadastreParcelIds: feature.properties?.cadastreParcelIds || []
        })).sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
      }, cadastreIds);
      const siblingRows = (fixture.designs || []).filter((row: any) =>
        String(row.cid || cid.cidOfObject(row.design || row)) !== designCid);
      const siblingCids = siblingRows.map((row: any) => String(row.cid || cid.cidOfObject(row.design || row)));
      const retainedMemberBaselines: Array<{ cid: string; id: string; outputs: any[]; visual: any[] }> = [];
      if (siblingRows.length) {
        // Stage the exact saved sibling design alone, establishing the plan's pre-target ground from
        // an independent import rather than deriving it by undoing the target member.
        for (const row of siblingRows) {
          const memberDesign = row.design || row;
          const memberCid = String(row.cid || cid.cidOfObject(memberDesign));
          const siblingUrl = await privatePreview(page, baseURL!, {
            design: memberDesign, parcelSourceId: fixture.parcelSourceId || 'oss-wfs'
          });
          await page.goto(localUrl(siblingUrl, memberDesign.city || city, locationFor({ ...fixture, design: memberDesign })),
            { waitUntil: 'domcontentloaded' });
          await waitForMapReady(page);
          await expect.poll(() => storedDesign(page, memberCid, cadastreIds), { timeout: 30_000 }).not.toBeNull();
          await expect.poll(async () => (await storedDesign(page, memberCid, cadastreIds))?.applied, { timeout: 30_000 })
            .toBe(true);
        }
        await page.evaluate(async (parcelIds: string[]) => {
          await (window as any).CadastralParcelRepository.ensureIds(parcelIds);
        }, cadastreIds);
        for (const memberCid of siblingCids) {
          const member = await storedDesign(page, memberCid, cadastreIds);
          expect(member.applied).toBe(true);
          retainedMemberBaselines.push({ cid: memberCid, id: member.id, outputs: member.outputs, visual: member.visual });
        }
        groundBefore = (await storedDesign(page, siblingCids[0], cadastreIds)).ground;
      }

      await openFixture(page, baseURL!, fixture);
      try {
        await expect.poll(() => storedDesign(page, designCid, cadastreIds), { timeout: 20_000 }).not.toBeNull();
      } catch (error) {
        const diagnostics = await page.evaluate(() => {
          const w = window as any;
          return {
            records: (w.proposalStorage?.getAllProposals?.() || []).map((row: any) => ({
              cid: w.DesignRecord.cidOf(row), goal: row.goal, title: row.title,
              publishedCid: w.Cid.cidOfObject(w.DesignRecord.published(row)),
              published: w.DesignRecord.published(row),
              applied: w.isApplied(row), id: row.proposalId
            })),
            applyFailure: w.ProposalManager?.getLastApplyFailureInfo?.() || null,
            importResult: w.__lastSharedDesignRouteResult || null
          };
        });
        throw new Error(`${String(error)}\nLifecycle import diagnostics: ${JSON.stringify({ expectedCid: designCid, expectedDesign: design, groundBasis: fixture.controlGroundBasis || 'Zagreb test fixture', diagnostics, browserFailures })}`);
      }
      let state = await storedDesign(page, designCid, cadastreIds);
      expect(state.cid).toBe(designCid);
      expect(await page.evaluate(() => (window as any).getBackendBase())).toBe(backend);

      if (!noOp && !unsupported) {
        try {
          await expect.poll(async () => (await storedDesign(page, designCid, cadastreIds))?.applied, { timeout: 30_000 })
            .toBe(true);
        } catch (error) {
          const diagnostics = await page.evaluate((expectedCid: string) => {
            const w = window as any;
            const record = (w.proposalStorage?.getAllProposals?.() || []).find((row: any) => {
              try { return w.DesignRecord.cidOf(row) === expectedCid; } catch (_) { return false; }
            });
            return {
              record: record ? { id: String(record.proposalId), cid: w.DesignRecord.cidOf(record),
                publishedCid: w.Cid.cidOfObject(w.DesignRecord.published(record)), applied: w.isApplied(record) } : null,
              applyFailure: record ? (w.ProposalManager?.getLastApplyFailureInfo?.(String(record.proposalId))
                || w.ProposalManager?.getLastApplyFailure?.(String(record.proposalId)) || null) : null,
              importResult: w.__lastSharedDesignRouteResult || null
            };
          }, designCid);
          throw new Error(`${String(error)}\nAutoapply diagnostics: ${JSON.stringify({ expectedCid: designCid, diagnostics, browserFailures })}`);
        }
        state = await storedDesign(page, designCid, cadastreIds);
        expect(state.applied).toBe(true);
      }
      // openFixture navigates to a new document, so load every control-ground source ID there
      // before measuring unapply restoration against the exact source-only baseline captured above.
      await page.evaluate(async (parcelIds: string[]) => {
        await (window as any).CadastralParcelRepository.ensureIds(parcelIds);
      }, cadastreIds);
      state = await storedDesign(page, designCid, cadastreIds);
      if (siblingCids.length) {
        for (const member of retainedMemberBaselines) {
          await expect.poll(async () => (await storedDesign(page, member.cid, cadastreIds))?.applied, { timeout: 30_000 })
            .toBe(true);
          const retained = await storedDesign(page, member.cid, cadastreIds);
          expect(retained.id).toBe(member.id);
          expect(retained.outputs).toEqual(member.outputs);
          expect(retained.visual).toEqual(member.visual);
        }
      }

      if (unsupported) {
        const result = await page.evaluate(async ({ id, designCid }) => {
          const w = window as any;
          const record = w.proposalStorage.getAllProposals().find((row: any) => w.DesignRecord.cidOf(row) === designCid);
          return { route: w.__applyRoute.classifyApplyRoute(record).route,
            applied: await w.ProposalManager.applyProposal(id),
            failure: w.ProposalManager.getLastApplyFailure?.(id) || w.ProposalManager.getLastApplyFailureInfo?.(id)?.message || null };
        }, { id: state.id, designCid });
        expect(result.route).toBe('unsupported');
        expect(result.applied).toBe(false);
        expect(String(result.failure)).toMatch(/Unsupported proposal goal/);
        expect((await storedDesign(page, designCid, cadastreIds)).ground).toEqual(groundBefore);
        expect((await storedDesign(page, designCid, cadastreIds)).outputs).toEqual([]);
        return;
      }

      if (noOp) {
        const results = await page.evaluate(async id => {
          const w = window as any;
          const first = await w.ProposalManager.applyProposal(id);
          const firstRemoved = await w.ProposalManager.unapplyProposal(id);
          const second = await w.ProposalManager.applyProposal(id);
          const secondRemoved = await w.ProposalManager.unapplyProposal(id);
          return { first, firstRemoved, second, secondRemoved, applied: w.isApplied(w.proposalStorage.getProposal(id)) };
        }, state.id);
        expect(results).toEqual({ first: true, firstRemoved: true, second: true, secondRemoved: true, applied: false });
        const after = await storedDesign(page, designCid, cadastreIds);
        expect(after.cid).toBe(designCid);
        expect(after.ground).toEqual(groundBefore);
        expect(after.outputs).toEqual([]);
        return;
      }

      const initialVisual = state.visual;
      await expectButtonAction(page, state.id, /Unapply/);
      try {
        await expect.poll(async () => {
          const current = await storedDesign(page, designCid, cadastreIds);
          return !!current && !current.applied && current.outputs.length === 0
            && JSON.stringify(current.ground) === JSON.stringify(groundBefore);
        }, { timeout: 30_000 }).toBe(true);
      } catch (error) {
        const diagnostics = await page.evaluate((ids: string[]) => {
          const w = window as any;
          const rows = w.CadastralParcelRepository?.peekMany?.(ids) || [];
          const live = w.LiveParcelFabric.entriesForCadastre(ids) || [];
          return {
            liveIds: live.map((feature: any) => w.LiveParcelFabric.featureId(feature)).sort(),
            cached: rows.map((feature: any) => ({
              id: w.LiveParcelFabric.featureId(feature),
              sourceId: feature.properties?.parcelSource?.sourceId || null,
              snapshotId: feature.properties?.parcelSource?.snapshotId || null,
              geometryType: feature.geometry?.type || null
            })).sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))),
            cache: w.CadastralParcelRepository?.snapshot?.() || null
          };
        }, cadastreIds);
        throw new Error(`${String(error)}\nGround restoration diagnostics: ${JSON.stringify({
          expectedIds: groundBefore.map((feature: any) => feature.id), cadastreIds,
          parcelSourceId: fixture.parcelSourceId || 'oss-wfs', diagnostics, browserFailures
        })}`);
      }
      state = await storedDesign(page, designCid, cadastreIds);
      expect(state.ground).toEqual(groundBefore);
      expect(state.outputs).toEqual([]);
      expect(state.visual).toEqual(initialVisual);
      for (const member of retainedMemberBaselines) {
        const retained = await storedDesign(page, member.cid, cadastreIds);
        expect(retained.applied).toBe(true);
        expect(retained.outputs).toEqual(member.outputs);
        expect(retained.visual).toEqual(member.visual);
      }

      // Reload once after an unapply to prove the false state and restored ground were saved.
      await page.goto(localUrl(`${baseURL}/`, city, at), { waitUntil: 'domcontentloaded' });
      await waitForMapReady(page);
      await page.evaluate(async (parcelIds: string[]) => {
        await (window as any).CadastralParcelRepository.ensureIds(parcelIds);
      }, cadastreIds);
      await expect.poll(() => storedDesign(page, designCid, cadastreIds), { timeout: 60_000 }).toMatchObject({ applied: false, cid: designCid, ground: groundBefore });
      for (const member of retainedMemberBaselines) {
        await expect.poll(async () => (await storedDesign(page, member.cid, cadastreIds))?.applied, { timeout: 30_000 })
          .toBe(true);
        const retained = await storedDesign(page, member.cid, cadastreIds);
        expect(retained.id).toBe(member.id);
        expect(retained.outputs).toEqual(member.outputs);
        expect(retained.visual).toEqual(member.visual);
      }

      await expectButtonAction(page, state.id, /Apply to map/);
      await expect.poll(() => page.evaluate((id: string) => (window as any).isApplied((window as any).proposalStorage.getProposal(id)), state.id)).toBe(true);
      const firstApply = await storedDesign(page, designCid, cadastreIds);
      expect(new Set(firstApply.outputs.map((feature: any) => feature.id)).size).toBe(firstApply.outputs.length);
      expect(firstApply.visual).toEqual(initialVisual);
      expect(firstApply.cid).toBe(designCid);
      for (const member of retainedMemberBaselines) {
        const retained = await storedDesign(page, member.cid, cadastreIds);
        expect(retained.id).toBe(member.id);
        const identityDiagnostics = await page.evaluate(({ stationCid, corridorCid }: { stationCid: string; corridorCid: string }) => {
          const w = window as any;
          const records = w.proposalStorage?.getAllProposals?.() || [];
          const byCid = (value: string) => records.find((row: any) => {
            try { return w.DesignRecord.cidOf(row) === value; } catch (_) { return false; }
          });
          const station = byCid(stationCid), corridor = byCid(corridorCid);
          const sourceId = station?.structureProposal?.attachment?.sourceId || null;
          const rivals = w.__claims?.appliedRivals?.(station, [corridor], {
            isApplied: () => true, replaceOccupiedGround: true
          }) || [];
          return {
            station: station ? { proposalId: String(station.proposalId), cid: w.DesignRecord.cidOf(station),
              publishedCid: station.published?.cid || null, published: w.DesignRecord.published(station), sourceId } : null,
            corridor: corridor ? { proposalId: String(corridor.proposalId), cid: w.DesignRecord.cidOf(corridor),
              publishedCid: corridor.published?.cid || null, published: w.DesignRecord.published(corridor),
              applied: w.isApplied(corridor) } : null,
            forcedAppliedRivals: rivals.map((row: any) => ({ proposalId: String(row.proposalId),
              cid: w.DesignRecord.cidOf(row), publishedCid: row.published?.cid || null }))
          };
        }, { stationCid: designCid, corridorCid: member.cid });
        expect(retained.applied, `Corridor state after station apply: ${JSON.stringify({
          expectedProposalId: member.id, actualProposalId: retained.id, actualCid: retained.cid,
          applied: retained.applied, expectedOutputIds: member.outputs.map((feature: any) => feature.id),
          actualOutputIds: retained.outputs.map((feature: any) => feature.id),
          groundIds: retained.ground.map((feature: any) => feature.id), identityDiagnostics
        })}`).toBe(true);
        expect(retained.outputs).toEqual(member.outputs);
      }

      await page.evaluate(async (id: string) => { await (window as any).ProposalManager.unapplyProposal(id); }, state.id);
      try {
        await expect.poll(() => storedDesign(page, designCid, cadastreIds), { timeout: 30_000 })
          .toMatchObject({ applied: false, ground: groundBefore, outputs: [] });
      } catch (error) {
        const siblings = await Promise.all(retainedMemberBaselines.map(async member => {
          const current = await storedDesign(page, member.cid, cadastreIds);
          return { cid: member.cid, proposalId: current?.id ?? null, currentCid: current?.cid ?? null,
            expectedProposalId: member.id, applied: current?.applied ?? null,
            outputsMatch: JSON.stringify(current?.outputs || []) === JSON.stringify(member.outputs),
            outputIds: (current?.outputs || []).map((feature: any) => feature.id),
            groundIds: (current?.ground || []).map((feature: any) => feature.id) };
        }));
        const current = await storedDesign(page, designCid, cadastreIds);
        throw new Error(`${String(error)}\nPost-reload-unapply diagnostics: ${JSON.stringify({
          expectedGroundIds: groundBefore.map((feature: any) => feature.id),
          actualGroundIds: current?.ground.map((feature: any) => feature.id),
          targetApplied: current?.applied, targetOutputIds: current?.outputs.map((feature: any) => feature.id), siblings
        })}`);
      }
      const secondApplyResult = await page.evaluate(async (id: string) => (window as any).applyProposalToMap(id), state.id);
      expect(secondApplyResult).toBe(true);
      await expect.poll(() => storedDesign(page, designCid, cadastreIds), { timeout: 30_000 }).toMatchObject({ applied: true, cid: designCid, outputs: firstApply.outputs, visual: initialVisual });
      await page.evaluate(async (id: string) => { await (window as any).ProposalManager.unapplyProposal(id); }, state.id);
      try {
        await expect.poll(() => storedDesign(page, designCid, cadastreIds), { timeout: 30_000 })
          .toMatchObject({ applied: false, cid: designCid, ground: groundBefore, outputs: [] });
      } catch (error) {
        const siblings = await Promise.all(retainedMemberBaselines.map(async member => {
          const current = await storedDesign(page, member.cid, cadastreIds);
          return { cid: member.cid, proposalId: current?.id ?? null, currentCid: current?.cid ?? null,
            expectedProposalId: member.id, applied: current?.applied ?? null,
            outputsMatch: JSON.stringify(current?.outputs || []) === JSON.stringify(member.outputs),
            outputIds: (current?.outputs || []).map((feature: any) => feature.id),
            groundIds: (current?.ground || []).map((feature: any) => feature.id) };
        }));
        const current = await storedDesign(page, designCid, cadastreIds);
        throw new Error(`${String(error)}\nSecond-cycle diagnostics: ${JSON.stringify({
          expectedGroundIds: groundBefore.map((feature: any) => feature.id),
          actualGroundIds: current?.ground.map((feature: any) => feature.id),
          targetApplied: current?.applied, targetOutputIds: current?.outputs.map((feature: any) => feature.id), siblings
        })}`);
      }
    });
  }
});
