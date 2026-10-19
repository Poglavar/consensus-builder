// Browser-bound checks: editing a scenario, recovering a draft and entering the real proposal editor.
import { test, expect } from '../helpers/fixtures';
import { readFile } from 'node:fs/promises';

const ground={type:'Polygon',coordinates:[[[15.95,45.79],[15.951,45.79],[15.951,45.791],[15.95,45.791],[15.95,45.79]]]};
const building={type:'Feature',properties:{floors:6,height:18},geometry:{type:'Polygon',coordinates:[[[15.9501,45.7901],[15.9509,45.7901],[15.9509,45.7909],[15.9501,45.7909],[15.9501,45.7901]],[[15.9503,45.7903],[15.9503,45.7907],[15.9507,45.7907],[15.9507,45.7903],[15.9503,45.7903]]]}};
function report(){
    const variant={id:'reform-courtyard',scenario:'reform',form:'courtyard',floors:6,gfaM2:4000,footprintM2:4000/6,massing:building,changes:[{field:'floors',from:3,to:6}]};
    const site={parcelId:'HR-1-2',koName:'Pilot site',areaM2:3000,geometry:ground,bounds:[15.95,45.79,15.951,45.791],buildingCount:0,
        planning:{vintage:'2025',housingUse:true,landUse:{mark:'M1'},rule:{shortName:'2.7',url:'https://zagreb.lol/urbana-pravila/?gup=2025&zone=2.7'}},
        accessibility:{method:'straight-line-stop-proximity',feedId:1,feedFetchedAt:'2026-10-18T00:00:00Z',nearestStop:{name:'Pilot stop',distanceM:150,lng:15.951,lat:45.791}},
        variants:[variant,{...variant,id:'reform-compact',form:'compact',gfaM2:3000}],recommendedVariantId:variant.id,currentHomes:null,changes:variant.changes,evidenceGaps:['ownership','current-capacity'],source:{planning:'2025-plan-extract'}};
    return {version:1,scanned:100,candidates:[site],excluded:[],failures:[],status:'complete',generatedAt:'2026-10-19T00:00:00Z',search:{},sampleCapped:true,
        assumptions:{unitM2:50,netRatio:.8,constructionEurM2:1600,landEurM2:250,softCostPct:20,contingencyPct:15,parkingPerHome:0,parkingEur:25000,grantPerHome:0,annualInterestPct:3.5,loanYears:40,operatingEurM2Month:2,vacancyPct:5,householdIncomeMonth:1600,incomeSharePct:30,utilitiesMonth:100,costSensitivityPct:20}};
}
async function openDesk(page:any){
    await page.route('**/affordabot/config',route=>route.fulfill({json:{}}));
    await page.route('**/affordabot/scan',route=>route.fulfill({json:report()}));
    await page.goto('/affordabot.html?lang=en');
    await page.getByRole('button',{name:'Find opportunities →',exact:true}).click();
    await expect(page.locator('#site-detail')).toBeVisible();
}

test('scenario edits preserve unknown costs and saved evidence survives reload',async({mockApi:page})=>{
    await openDesk(page);
    const before=await page.locator('#finance-summary').innerText();
    await page.getByLabel('Land (€/site m²)',{exact:true}).fill('0');
    await expect(page.locator('#finance-summary')).not.toHaveText(before);
    const exported=page.waitForEvent('download');
    await page.getByRole('button',{name:'Export research package',exact:true}).click();
    const artifactPath=await (await exported).path();
    const artifact=JSON.parse(await readFile(artifactPath!,'utf8'));
    expect(artifact.proposal.affordabilityResearch.feasibility.cost.land).toBe(0);
    expect(artifact.site.variants.every((v:any)=>v.finance.cost.land===0)).toBe(true);
    await page.getByLabel('Land (€/site m²)',{exact:true}).fill('');
    await expect(page.locator('#finance-summary')).toContainText('Rent cannot be estimated');
    await expect(page.locator('#target-count')).toHaveText('0');
    await page.getByLabel('Research notes / required checks',{exact:true}).fill('Verify owner and lease costs.');
    await page.getByRole('button',{name:'Save research draft',exact:true}).click();
    await expect(page.locator('#saved-count')).toHaveText('1');
    await page.reload();await page.locator('.saved-panel summary').click();
    await page.getByRole('button',{name:/Pilot site ·/}).click();
    await expect(page.locator('#review-note')).toHaveValue('Verify owner and lease costs.');
    await expect(page.locator('#finance-summary')).toContainText('Rent cannot be estimated');
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('consensus-builder.affordabot.research.v1')||'[]')[0].assumptions.landEurM2)).toBeNull();
});

test('mobile research opens a new local design with the real editor and preserves its courtyard',async({mockApi:page})=>{
    await page.setViewportSize({width:375,height:812});await openDesk(page);
    const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].map(el=>({tag:el.tagName,id:el.id,class:typeof el.className==='string'?el.className:'svg',right:el.getBoundingClientRect().right})).filter(el=>el.right>376).slice(0,15)}));
    expect(layout.width,JSON.stringify(layout.overflow)).toBeLessThanOrEqual(375);
    await page.getByRole('button',{name:'Open design in Consensus Builder ↗',exact:true}).click();
    await expect(page.locator('#proposal-editor-shell.is-open')).toBeVisible({timeout:45000});
    const draft=await page.evaluate(()=>{
        const value=(window as any).proposalDraftStore.getActiveDraft();
        return {source:value.sourceProposalId,goal:value.goal,city:value.cityId,rings:value.editorPayload.context.buildings[0].geometry.coordinates.length,research:value.sourceSnapshot.affordabilityResearch.status,ownership:value.fields.ownership};
    });
    expect(draft).toEqual({source:null,goal:'single',city:'zagreb',rings:2,research:'research-draft',ownership:'no-change'});
    expect(new URL(page.url()).searchParams.has('affordabotDraft')).toBe(false);
});
