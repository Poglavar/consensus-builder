// UI boundaries: identities remain local; shared ballots expose revision and private history.
import fs from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, editorClosed, storedAgreements, proposeOverPark, openAgreementDecision } from '../helpers/agreements';
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
  await roster.locator('[data-roster-labels]').fill('local-only-resident@example.test\nLocal resident B');
  await roster.locator('[data-roster-action="generate"]').click();
  await expect(roster).toContainText('2 eligible codes prepared');
  await expect(editorSave(editor)).toBeDisabled();
  const downloaded=page.waitForEvent('download');
  await roster.locator('[data-roster-action="save"]').click();
  const file=await downloaded;
  const local=JSON.parse(fs.readFileSync((await file.path())!, 'utf8'));
  expect(local.entries).toHaveLength(2);
  expect(local.entries[0].label).toBe('local-only-resident@example.test');
  await expect(editorSave(editor)).toBeEnabled();
  await roster.locator('[data-roster-import]').setInputFiles({name:'voter-list.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(local))});
  page.once('dialog',dialog=>dialog.accept());
  await expect(roster.locator('[data-roster-progress]')).toHaveText('');
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await editorClosed(page);
  const [saved]=await storedAgreements(page);
  expect(saved.consultation.voting.codeHashes).toHaveLength(2);
  expect(JSON.stringify(saved)).not.toContain(local.entries[0].code);
  expect(JSON.stringify(saved)).not.toContain(local.entries[0].label);
  expect(traffic.join('\n')).not.toContain(local.entries[0].label);
  expect(traffic.join('\n')).not.toContain(local.entries[0].code);
});

test('a voter checks, changes and reviews one ballot without a wallet', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);await openCity(page);
  const initial=await proposeOverPark(page,{title:'Community vote'}),index=pageIndex(page);
  const code='KRM-TAV-DBN-WEX-HPS';
  const voting=await page.evaluate(async code=>{const w=window as any,id=crypto.randomUUID();return w.CommunityVoting.configuration({schema:'community-voting/v1',id,codeHashes:[await w.CommunityVoting.codeHash(id,code),await w.CommunityVoting.codeHash(id,'ABC-DEF-GHJ-KMN-PQR')]});},code);
  const content={...index.agreements.get(initial.cid)!.content,consultation:{organiser:null,participationUrl:null,voting}};
  const cid=fileAgreement(index,content);let version=0,publicReads=0,choice:string|null=null;const history:any[]=[];
  await page.route(`**/agreements/${cid}/voting**`,async route=>{
    const request=route.request(),body=request.method()==='POST'?request.postDataJSON():null;
    if(!body)publicReads++;
    if(body){expect(body.code.replace(/[ -]/g,'').toUpperCase()).toBe(code.replace(/-/g,''));}
    if(request.url().endsWith('/ballot')){
      expect(body.expectedVersion).toBe(version);expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      choice=body.choice;version++;history.push({version,choice,occurredAt:new Date().toISOString()});
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({agreementCid:cid,enabled:true,eligible:2,votes:version?1:0,closed:false,
      counts:{support:choice==='support'?1:0,oppose:choice==='oppose'?1:0,abstain:choice==='abstain'?1:0},...(body?{entry:{version,choice,history}}:{})})});
  });
  await page.goto(`/agreements/${cid}?city=zg`);
  await openAgreementDecision(page);
  const panel=page.locator('[data-community-voting]');await expect(panel).toBeVisible({timeout:45_000});
  const turnout=panel.locator('[data-voting-meter="turnout"]');
  await expect(turnout).toHaveAttribute('value','0');
  await expect(turnout).toHaveAttribute('max','2');
  await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('value','0');
  await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('max','1');
  await expect(panel).toContainText('Not yet voted: 2');
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
  await panel.getByRole('radio',{name:'Oppose',exact:true}).check();await panel.getByRole('button',{name:'Save my vote'}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(2);await expect(panel.locator('[data-voting-meter="support"]')).toHaveAttribute('value','0');
  await expect(panel.locator('[data-voting-result="oppose"]')).toContainText('1 · 100%');
  await expect(turnout).toHaveAttribute('value','1');
  await panel.getByRole('button',{name:'Refresh history'}).click();await expect(panel.locator('tbody tr')).toHaveCount(2);
  await panel.getByRole('button',{name:'Use another code'}).click();await expect(panel.locator('[data-voting-code]')).toHaveValue('');
});
