// UI boundaries: identities remain local; shared ballots expose revision and private history.
import fs from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, editorClosed, storedAgreements, proposeOverPark, openAgreementDecision, agreementPanel } from '../helpers/agreements';
import { fileAgreement, pageIndex } from '../helpers/mocks/shared-server';

test('organiser generates and restores local assignments while the agreement stores only verifiers', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);
  const { layoutId } = await applyLayout(page);
  await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Community plan', [w.proposalStorage.getProposal(id)], w.MapShare.capture(w));
    w.PlanWorkspace.save(plan); w.PlanDialog.details(plan);
  }, layoutId);
  await page.getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page), roster=editor.locator('[data-voting-roster]');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-electorate][value="community"]').check();
  await expect(roster).toBeVisible();
  await editor.locator('[data-agreement-title]').fill('Residents vote');
  const traffic:string[]=[];
  page.on('request',request=>traffic.push(request.url()+' '+(request.postData()||'')));
  await roster.locator('[data-roster-count]').fill('3');
  await roster.locator('[data-roster-action="generate"]').click();
  await expect(roster).toContainText('3 eligible codes prepared');
  page.once('dialog',dialog=>dialog.accept());
  await roster.locator('[data-roster-action="remove"]').click();
  await expect(roster).toContainText('0 eligible codes prepared');
  await expect(roster.locator('[data-roster-action="remove"]')).toHaveCount(0);
  await expect(editorSave(editor)).toBeEnabled();
  await roster.locator('[data-roster-labels]').fill('local-only-resident@example.test\nLocal resident B');
  await roster.getByLabel('Household for these people (optional)').fill('12 Acacia Avenue');
  await roster.locator('[data-roster-action="generate"]').click();
  await roster.getByLabel('Ballot rule').selectOption({label:'Street vote — Strong Suburbs'});
  await expect(roster.locator('[data-roster-rule-source]')).toContainText('at least 60% of votes cast');
  await expect(roster).toContainText('2 eligible codes prepared');
  await expect(editorSave(editor)).toBeDisabled();
  const downloaded=page.waitForEvent('download');
  await roster.locator('[data-roster-action="save"]').click();
  const file=await downloaded;
  const local=JSON.parse(fs.readFileSync((await file.path())!, 'utf8'));
  expect(local.entries).toHaveLength(2);
  expect(local.entries[0].label).toBe('local-only-resident@example.test');
  await expect(editorSave(editor)).toBeEnabled();
  const csvDownload=page.waitForEvent('download');
  await roster.locator('[data-roster-action="csv"]').click();
  const csvFile=await csvDownload;
  const csv=fs.readFileSync((await csvFile.path())!, 'utf8');
  expect(csvFile.suggestedFilename()).toBe('voting-codes.csv');
  expect(csv).toContain('Person,Household,Code\r\n');
  expect(csv).toContain(`"${local.entries[0].label}","12 Acacia Avenue","${local.entries[0].code}"`);
  await roster.locator('[data-roster-import]').setInputFiles({name:'voter-list.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(local))});
  page.once('dialog',dialog=>dialog.accept());
  await expect(roster.locator('[data-roster-progress]')).toHaveText('');
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await editorClosed(page);
  const [saved]=await storedAgreements(page);
  expect(saved.consultation.voting.codeHashes).toHaveLength(2);
  // One household of two residents and the pinned rule; the household label itself stays local.
  expect(saved.consultation.voting).toMatchObject({schema:'community-voting/v2',households:[saved.consultation.voting.codeHashes],
    rule:{id:'gb-street-vote-strong-suburbs',version:'2026-11-25'}});
  expect(JSON.stringify(saved)).not.toContain('Acacia');
  expect(JSON.stringify(saved)).not.toContain(local.entries[0].code);
  expect(JSON.stringify(saved)).not.toContain(local.entries[0].label);
  expect(traffic.join('\n')).not.toContain(local.entries[0].label);
  expect(traffic.join('\n')).not.toContain(local.entries[0].code);
});

test('organiser can remove code voting from a draft before saving the agreement', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);
  const { layoutId } = await applyLayout(page);
  await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Community plan without codes', [w.proposalStorage.getProposal(id)], w.MapShare.capture(w));
    w.PlanWorkspace.save(plan); w.PlanDialog.details(plan);
  }, layoutId);
  await page.getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page), roster=editor.locator('[data-voting-roster]');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-electorate][value="community"]').check();
  await editor.locator('[data-agreement-title]').fill('Residents vote without codes');
  await roster.locator('[data-roster-count]').fill('1');
  await roster.locator('[data-roster-action="generate"]').click();
  await expect(roster).toContainText('1 eligible codes prepared');
  page.once('dialog',dialog=>dialog.accept());
  await roster.locator('[data-roster-action="remove"]').click();
  await expect(roster).toContainText('0 eligible codes prepared');
  await expect(roster.locator('[data-roster-action="remove"]')).toHaveCount(0);
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await editorClosed(page);
  const [saved]=await storedAgreements(page);
  expect(saved.rule.electorate).toBe('community');
  expect(saved.consultation).not.toHaveProperty('voting');
});

test('organiser generates codes from a resident CSV, regroups a household and keeps the groups in the agreement', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);
  const { layoutId } = await applyLayout(page);
  await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Street vote plan', [w.proposalStorage.getProposal(id)], w.MapShare.capture(w));
    w.PlanWorkspace.save(plan); w.PlanDialog.details(plan);
  }, layoutId);
  await page.getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page), roster=editor.locator('[data-voting-roster]');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-electorate][value="community"]').check();
  await editor.locator('[data-agreement-title]').fill('Street vote');
  // The import is a native button, so the keyboard opens the file picker.
  const chooser=page.waitForEvent('filechooser');
  await roster.getByRole('button',{name:'Generate codes from a resident CSV'}).press('Enter');
  await (await chooser).setFiles({name:'residents.csv',mimeType:'text/csv',
    buffer:Buffer.from('Person,Household\r\nResident A,No. 1\r\nResident B,No. 1\r\nResident C,No. 3\r\n')});
  await expect(roster).toContainText('3 eligible codes prepared');
  await roster.getByText('Show local code assignments').click();
  await roster.getByLabel('Household of Resident C').fill('No. 1');
  await roster.getByLabel('Household of Resident C').press('Tab');
  await roster.getByLabel('Ballot rule').selectOption({label:'Street vote — 2023 government consultation'});
  await expect(editorSave(editor)).toBeDisabled();
  const downloaded=page.waitForEvent('download');
  await roster.locator('[data-roster-action="save"]').click();
  const local=JSON.parse(fs.readFileSync((await (await downloaded).path())!, 'utf8'));
  expect(local.entries.map((row:any)=>row.household)).toEqual(['No. 1','No. 1','No. 1']);
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await editorClosed(page);
  const [saved]=await storedAgreements(page);
  expect(saved.consultation.voting.households).toEqual([saved.consultation.voting.codeHashes]);
  expect(saved.consultation.voting.rule).toEqual({id:'gb-street-vote-consultation-2023',version:'2026-11-25'});
  expect(JSON.stringify(saved)).not.toContain('Resident');
});

test('a voter checks, changes and reviews one ballot without a wallet', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);await openCity(page);
  const initial=await proposeOverPark(page,{title:'Community vote'}),index=pageIndex(page);
  const code='KRM-TAV-DBN-WEX-HPS';
  const voting=await page.evaluate(async code=>{const w=window as any,id=crypto.randomUUID();return w.CommunityVoting.configuration({schema:'community-voting/v2',id,codeHashes:[await w.CommunityVoting.codeHash(id,code),await w.CommunityVoting.codeHash(id,'ABC-DEF-GHJ-KMN-PQR')],rule:{id:'gb-street-vote-strong-suburbs',version:'2026-11-25'}});},code);
  const base=index.agreements.get(initial.cid)!.content;
  const content={...base,consultation:{organiser:null,participationUrl:null,voting}};
  // Owner sign-off is a separate owners' agreement on the same plan, listed beside the resident result.
  fileAgreement(index,{...base,title:'Owners sign off',rule:{...base.rule,electorate:'owners'}});
  const cid=fileAgreement(index,content);let version=0,publicReads=0,choice:string|null=null;const history:any[]=[];
  await page.route(`**/agreements/${cid}/voting**`,async route=>{
    const request=route.request(),body=request.method()==='POST'?request.postDataJSON():null;
    if(!body)publicReads++;
    if(body){expect(body.code.replace(/[ -]/g,'').toUpperCase()).toBe(code.replace(/-/g,''));}
    if(request.url().endsWith('/ballot')){
      expect(body.expectedVersion).toBe(version);expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      choice=body.choice;version++;history.push({version,choice,occurredAt:new Date().toISOString()});
    }
    // The API evaluates the rule; this mock answers what it would for two one-person households.
    const support=choice==='support'?1:0,voted=version?1:0;
    const tests=[{measure:'cast-support',count:support,total:voted,needed:voted?1:0,met:support>0},
      {measure:'household-turnout',count:voted,total:2,needed:1,met:voted>0},{measure:'household-support',count:support,total:voted,needed:voted?1:0,met:support>0}]
      .map(test=>({...test,numerator:test.measure==='cast-support'?3:1,denominator:test.measure==='cast-support'?5:2,strict:false}));
    await route.fulfill({contentType:'application/json',body:JSON.stringify({agreementCid:cid,enabled:true,eligible:2,votes:voted,closed:false,
      counts:{support,oppose:choice==='oppose'?1:0,abstain:choice==='abstain'?1:0},households:{eligible:2,voted,supporting:support},
      rule:{id:'gb-street-vote-strong-suburbs',version:'2026-11-25',tests,passed:tests.every(test=>test.met),final:false},
      ...(body?{entry:{version,choice,history}}:{})})});
  });
  await page.goto(`/agreements/${cid}?city=zg`);
  // The link reloads at its plan's saved view before the agreement opens; wait for it before picking a tab.
  await expect(agreementPanel(page)).toBeVisible({ timeout: 45_000 });
  await openAgreementDecision(page);
  const panel=page.locator('[data-community-voting]');await expect(panel).toBeVisible({timeout:45_000});
  const turnout=panel.locator('[data-voting-meter="turnout"]');
  await expect(turnout).toHaveAttribute('value','0');
  await expect(turnout).toHaveAttribute('max','2');
  await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('value','0');
  await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('max','1');
  await expect(panel).toContainText('Not yet voted: 2');
  await expect(panel.locator('[data-voting-rule]')).toHaveAttribute('data-voting-rule','not-passing');
  await expect(panel.locator('[data-voting-rule]')).toContainText('Not passing');
  await expect(panel.locator('[data-voting-test="household-turnout"]')).toContainText('0 of 2 · needs 1 (at least 50%)');
  await expect(panel.locator('.voting-owners')).toContainText('Owners sign off');
  const before=publicReads;
  await panel.getByRole('button',{name:'Refresh results'}).click();
  await expect.poll(()=>publicReads).toBe(before+1);
  await expect(panel.getByRole('button',{name:'Refresh results'})).not.toHaveAttribute('aria-busy','true');
  await panel.locator('[data-voting-code]').fill(code.toLowerCase().replace(/-/g,' '));
  await panel.getByRole('button',{name:'Check my vote'}).click();await expect(panel).toContainText('No vote yet');
  await panel.getByRole('radio',{name:'Support',exact:true}).check();await panel.getByRole('button',{name:'Save my vote'}).click();
  await expect(panel).toContainText('Your vote was saved and read back.');await expect(panel.locator('tbody tr')).toHaveCount(1);
  await expect(turnout).toHaveAttribute('value','1');
  await expect(turnout).toHaveAttribute('aria-valuetext','1 of 2 voted · 50%');
  await expect(panel.locator('[data-voting-result="support"]')).toContainText('1 · 100%');
  await expect(panel.locator('[data-voting-rule]')).toHaveAttribute('data-voting-rule','passing');
  await expect(panel).toContainText('Households voted: 1 of 2');
  await panel.getByRole('radio',{name:'Oppose',exact:true}).check();await panel.getByRole('button',{name:'Save my vote'}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(2);await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('value','0');
  await expect(panel.locator('[data-voting-result="oppose"]')).toContainText('1 · 100%');
  await expect(turnout).toHaveAttribute('value','1');
  await panel.getByRole('button',{name:'Refresh history'}).click();await expect(panel.locator('tbody tr')).toHaveCount(2);
  await panel.getByRole('button',{name:'Use another code'}).click();await expect(panel.locator('[data-voting-code]')).toHaveValue('');
  await panel.locator('.voting-owners').getByRole('button',{name:'Open'}).click();
  await expect(page.locator('#agreement-panel-title')).toHaveText('Owners sign off',{timeout:45_000});
});

// Living Tradition's street vote covers only eligible houses: the editor reads the plan's raised
// houses from the shared API's building facts, lists them, and holds the agreement until each one
// passes; the stored record keeps that check.
test('a Living Tradition street vote waits until every covered house is eligible and records the check', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);
  const fact = (value: unknown) => ({ value, source: 'osm', key: 'k', raw: String(value) });
  const georgian = { storeys: fact(3), built: fact({ from: 1828, to: 1830 }), roof_shape: fact('flat'), parapet: fact(true), height_m: null, footprint_m2: fact(45.6), row_size: fact(20) };
  const parapetTagged = new Set(['osm:way/101']);
  const reads: string[] = [];
  await page.route('https://zagreb.lol/api/building-facts*', route => {
    const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',');
    reads.push(ids.join(','));
    route.fulfill({ json: { fields: [], sources: [], buildings: ids.map(id => ({ id, found: true,
      facts: { ...georgian, parapet: parapetTagged.has(id) ? fact(true) : null },
      edit: { url: `https://www.openstreetmap.org/edit?editor=id&way=${id.split('/')[1]}`, source: 'OpenStreetMap', keys: { parapet: 'building:parapet' } },
      source_version: { version: 2, changed: '2026-11-27T15:00:00Z' } })) } });
  });
  const { layoutId } = await applyLayout(page);
  await page.evaluate(id => {
    const w = window as any;
    // The plan raises two existing houses with a mansard (Based on existing buildings).
    const design = w.proposalStorage.getProposal(id);
    const raised = (source: string) => ({ type: 'Feature', geometry: null, properties: { type: 'proposedBuilding', basedOnExisting: true, sourceBuildingId: source, roof: 'mansard' } });
    design.geometry = { ...(design.geometry || {}), buildings: [raised('w101'), raised('w102')] };
    const plan = w.PlanComposition.create('Mansard street', [design], w.MapShare.capture(w));
    w.PlanWorkspace.save(plan); w.PlanDialog.details(plan);
  }, layoutId);
  await page.getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page), roster = editor.locator('[data-voting-roster]'), covered = editor.locator('.voting-eligibility');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-electorate][value="community"]').check();
  await roster.locator('[data-roster-count]').fill('2');
  await roster.locator('[data-roster-action="generate"]').click();
  await roster.getByLabel('Ballot rule').selectOption({ label: 'Street vote — Living Tradition mansards' });
  await expect(covered).toContainText('1 of 2 covered houses eligible');
  await expect(covered.locator('li[data-verdict="unknown"]')).toContainText('unknown 17.2');
  await expect(covered.locator('li[data-verdict="unknown"] a')).toHaveAttribute('href', 'https://www.openstreetmap.org/edit?editor=id&way=102');
  const downloaded = page.waitForEvent('download');
  await roster.locator('[data-roster-action="save"]').click();
  await downloaded;
  await expect(editorSave(editor)).toBeDisabled();
  await expect(editor.locator('[data-agreement-waiting]')).toContainText('Not every covered house is known to be eligible yet');
  // The author tags No. 102's parapet in OpenStreetMap and checks again.
  parapetTagged.add('osm:way/102');
  await covered.getByRole('button', { name: 'Check again' }).click();
  await expect(covered).toContainText('2 of 2 covered houses eligible');
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await editorClosed(page);
  const [saved] = await storedAgreements(page);
  expect(saved.consultation.voting.rule).toEqual({ id: 'gb-street-vote-living-tradition', version: '2026-11-27' });
  expect(saved.consultation.voting.eligibility.houses.map((house: any) => [house.id, house.verdict])).toEqual([['osm:way/101', 'eligible'], ['osm:way/102', 'eligible']]);
  expect(reads.at(-1)).toBe('osm:way/101,osm:way/102');
});
