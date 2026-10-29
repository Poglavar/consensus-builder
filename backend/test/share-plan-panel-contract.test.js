// The plan dialog composes and publishes immutable snapshots; inspect the real service contract.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const read=rel=>readFileSync(new URL(rel,import.meta.url),'utf8');
const dialog=read('../../frontend/js/plan-dialog.js'),workspace=read('../../frontend/js/plan-workspace.js');
describe('plan dialog and workspace contract',()=>{
 it('creates local snapshots separately from publication and agreement creation',()=>{
  expect(dialog).toContain('win.PlanComposition.create(');expect(dialog).toContain('win.PlanWorkspace.save(row)');
  expect(dialog).not.toContain('DesignSync.publishDesign');expect(dialog).toContain('win.AgreementDialog.open({plan:row})');
 });
 it('shares the fixed saved plan and leaves design membership edits to a new revision',()=>{
  expect(dialog).toContain("t('shareFixed')");expect(dialog).toContain("t('revisionHint')");
  expect(workspace).toContain('const row = await resolve(plan);');expect(workspace).toContain('win.NamedPlans.save(row.content)');
 });
 it('resolves exact carried members before publishing and checks missing members first',()=>{
  const fetch=workspace.indexOf('const known = await win.DesignSync.fetchDesigns');
  const publish=workspace.indexOf("win.fetch(backend() + '/designs'");
  const planSave=workspace.indexOf('await win.NamedPlans.save(row.content)');
  expect(fetch).toBeGreaterThan(-1);expect(publish).toBeGreaterThan(fetch);expect(planSave).toBeGreaterThan(publish);
  expect(workspace).toContain('PlanComposition.localRecords(row');
 });
 it('keeps original carried snapshots available for local reuse after publication',()=>{
  expect(workspace).toContain("save({ ...copy(row), published:true });");
  expect(workspace).toContain('function publication(plan)');
 });
});
