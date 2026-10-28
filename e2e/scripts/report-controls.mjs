// Produce a source-linked interaction inventory from one browser run or ordered focused rechecks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceInventory, sourceFiles, frontendRoot } from '../helpers/control-source.mjs';
import { readControlResults, summarizeControlCoverage, checkControlCoverage, checkExemptionGuards, isAllowedSkip } from '../helpers/control-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const reports = process.argv.slice(2).filter(argument => argument !== '--check');
const inputReports = reports.length ? reports.map(filename => path.resolve(filename)) : [path.join(root, 'test-results/control-results.json')];
const contract = JSON.parse(fs.readFileSync(path.join(root, 'control-contract.json'), 'utf8'));
const rules = new Map(contract.controls.map(control => [control.id, control]));
const summary = summarizeControlCoverage(sourceInventory(), readControlResults(inputReports));
for (const control of summary.controls) {
  const exemption = rules.get(control.id)?.exempt;
  control.required = !exemption;
  if (exemption) control.exclusionReason = exemption;
}
const required = summary.controls.filter(control => control.required);
summary.counts.required = required.length;
summary.counts.requiredInteracted = required.filter(control => control.interactions.length).length;
summary.counts.requiredButtons = required.filter(control => control.interaction === 'click').length;
summary.counts.requiredClicked = required.filter(control => control.interaction === 'click' && control.clicks.length).length;
summary.counts.requiredFields = required.filter(control => control.interaction === 'change').length;
summary.counts.requiredChanged = required.filter(control => control.interaction === 'change' && control.changes.length).length;
summary.counts.requiredFactories = required.filter(control => control.interaction === 'auto').length;
summary.counts.requiredFactoriesInteracted = required.filter(control => control.interaction === 'auto' && control.interactions.length).length;
summary.counts.excluded = summary.controls.length - required.length;
summary.counts.allowedSkips = summary.tests.filter(test => isAllowedSkip(test, contract)).length;
// Preserve the evidence trail when a complete run is followed by focused rechecks.
summary.inputReports = inputReports.map(filename => path.relative(root, filename));
const output = path.join(root, 'test-results/control-coverage.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(`${summary.counts.passed}/${summary.counts.tests} tests passed, ${summary.counts.allowedSkips} declared opt-in skips; ${summary.counts.requiredClicked}/${summary.counts.requiredButtons} required button sites clicked, ${summary.counts.requiredChanged}/${summary.counts.requiredFields} form-control sites changed, and ${summary.counts.requiredFactoriesInteracted}/${summary.counts.requiredFactories} shared control factories exercised in passing tests (${summary.counts.excluded} source exclusions).`);
for (const test of summary.tests.filter(test => isAllowedSkip(test, contract))) console.log(`Opt-in test skipped: ${test.file} › ${test.title}`);
console.log(`Coverage details: ${path.relative(process.cwd(), output)}`);
const bySource = new Map();
for (const control of summary.uncovered.filter(control => control.required)) bySource.set(control.source, (bySource.get(control.source) || 0) + 1);
console.log(`Unexercised required source sites:${bySource.size ? '' : ' none.'}`);
for (const [source, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)} ${source}`);
if (check) {
  const sources = new Map(sourceFiles(frontendRoot, { includeStyles: true }).map(filename => [path.relative(frontendRoot, filename), fs.readFileSync(filename, 'utf8')]));
  const errors = [...checkControlCoverage(summary, contract), ...checkExemptionGuards(contract, sources)];
  if (errors.length) {
    console.error(`Control coverage failed with ${errors.length} gaps. First 20:`);
    for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
    process.exitCode = 1;
  } else console.log('Every required source control and declared action variant has a passing browser interaction.');
}
