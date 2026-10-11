// A green regression test is credible only if it rejects the defect it protects against.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controlMutations } from '../helpers/control-mutations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.slice(2);
if (requested.some(name => !controlMutations[name])) throw new Error(`Choose mutations from: ${Object.keys(controlMutations).join(', ')}`);
const names = requested.length ? requested : Object.keys(controlMutations);
const proofs = [];
for (const name of names) {
  const mutation = controlMutations[name];
  const directory = path.join(root, 'test-results', 'mutation-proofs', name);
  const report = `${directory}.json`;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.rmSync(report, { force: true });
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.controls.config.ts',
      mutation.file, '--grep', mutation.grep], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, UI_CONTROL_MUTATION: name, UI_CONTROL_OUTPUT: directory, UI_CONTROL_RESULTS: report },
    });
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', status => resolve(status ?? 1));
  });
  const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
  const tests = [];
  const walk = suite => {
    for (const spec of suite.specs || []) for (const test of spec.tests || []) tests.push({ title: spec.title, ...test.results.at(-1) });
    for (const child of suite.suites || []) walk(child);
  };
  if (result) for (const suite of result.suites || []) walk(suite);
  const failure = tests[0]?.error?.message || '';
  const caught = code !== 0 && tests.length === 1 && tests[0]?.status === 'failed' && mutation.error.test(failure)
    && !/browserType\.launch|Uncaught page error|webServer.*failed/.test(failure);
  proofs.push({ mutation: name, caught, test: tests[0]?.title || null, failure, report });
  console.log(`${caught ? 'PROVED' : 'NOT PROVED'}: ${name}`);
}
const output = path.join(root, 'test-results/mutation-proofs.json');
fs.writeFileSync(output, JSON.stringify(proofs, null, 2) + '\n');
console.log(`Regression proofs: ${output}`);
if (proofs.some(proof => !proof.caught)) process.exitCode = 1;
