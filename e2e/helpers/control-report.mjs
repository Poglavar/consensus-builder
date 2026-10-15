// Attribute coverage only to trusted clicks in passing browser tests; retain failures and gaps.
import fs from 'node:fs';

export function readControlResults(paths) {
  const tests = new Map();
  for (const filename of paths) {
    const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const walk = (suite, parents = []) => {
      const trail = [...parents, suite.title].filter(Boolean);
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const result = test.results.at(-1);
          const attachment = result?.attachments?.find(item => item.name === 'ui-control-coverage');
          const events = attachment ? JSON.parse(attachment.body
            ? Buffer.from(attachment.body, 'base64').toString('utf8')
            : fs.readFileSync(attachment.path, 'utf8')) : [];
          const key = [spec.file, test.projectName, ...trail, spec.title].join(' › ');
          tests.set(key, {
            key, title: spec.title, file: spec.file, line: spec.line,
            status: result?.status || 'not-run', duration: result?.duration || 0, events,
            projectName: test.projectName, expectedStatus: test.expectedStatus, outcome: test.status,
            annotations: [...(test.annotations || []), ...(result?.annotations || [])],
          });
        }
      }
      for (const child of suite.suites || []) walk(child, trail);
    };
    for (const suite of report.suites || []) walk(suite);
  }
  return [...tests.values()];
}

export function summarizeControlCoverage(sites, tests) {
  const byId = new Map(sites.map(site => [site.id, { ...site, observed: false, clicks: [], variants: [] }]));
  const unattributed = new Map();
  for (const test of tests) {
    for (const event of test.events) for (const id of event.sourceIds?.length ? event.sourceIds : [event.sourceId]) {
      const source = id && byId.get(id);
      if (!source) {
        const key = JSON.stringify(event.attrs);
        const entry = unattributed.get(key) || { label: event.label, attrs: event.attrs, clicked: false, tests: [] };
        if (event.kind === 'clicked' && test.status === 'passed') {
          entry.clicked = true;
          if (!entry.tests.includes(test.key)) entry.tests.push(test.key);
        }
        unattributed.set(key, entry);
        continue;
      }
      source.observed = true;
      // Keep every observed variation and its own passing clicks. A shared button factory is not
      // fully exercised just because one of the actions it creates happened to receive a click.
      const variantKey = JSON.stringify([event.label, event.attrs]);
      let variant = source.variants.find(variant => variant.key === variantKey);
      if (!variant) {
        variant = { key: variantKey, label: event.label, attrs: event.attrs, clicks: [] };
        source.variants.push(variant);
      }
      if (event.kind === 'clicked' && test.status === 'passed' && !variant.clicks.includes(test.key)) variant.clicks.push(test.key);
      if (event.kind === 'clicked' && test.status === 'passed' && !source.clicks.includes(test.key)) source.clicks.push(test.key);
    }
  }
  const controls = [...byId.values()];
  return {
    tests: tests.map(({ events, ...test }) => test),
    counts: {
      tests: tests.length,
      passed: tests.filter(test => test.status === 'passed').length,
      skipped: tests.filter(test => test.status === 'skipped').length,
      controls: controls.length,
      clicked: controls.filter(control => control.clicks.length).length,
      observed: controls.filter(control => control.observed).length,
    },
    controls,
    uncovered: controls.filter(control => !control.clicks.length),
    unattributed: [...unattributed.values()],
  };
}

function matchesVariant(variant, expected) {
  if (expected.label !== undefined && variant.label !== expected.label) return false;
  if (expected.labelPattern && !new RegExp(expected.labelPattern).test(variant.label)) return false;
  for (const name of expected.classes || []) if (!(variant.attrs.class || '').split(/\s+/).includes(name)) return false;
  return Object.entries(expected.attrs || {}).every(([key, value]) => variant.attrs[key] === value);
}

// Optional external transactions are listed individually; no skipped test earns click coverage.
export function isAllowedSkip(test, contract) {
  return test.status === 'skipped' && test.expectedStatus === 'skipped' && test.outcome === 'skipped'
    && (contract.allowedSkips || []).some(rule => rule.file === test.file
      && rule.title === test.title && rule.projectName === test.projectName
      && rule.skipReason && test.annotations?.some(annotation => annotation.type === 'skip'
        && annotation.description === rule.skipReason));
}

// The checked-in contract makes removals visible too. Scanning only today's source would turn a
// deleted button into a smaller denominator and could wrongly report complete coverage.
export function checkControlCoverage(summary, contract) {
  const errors = [];
  const expected = new Map(contract.controls.map(control => [control.id, control]));
  const current = new Map(summary.controls.map(control => [control.id, control]));
  for (const test of summary.tests) {
    if (test.status !== 'passed' && !isAllowedSkip(test, contract)) errors.push(`Test ${test.status}: ${test.key}`);
  }
  for (const control of summary.controls) {
    const rule = expected.get(control.id);
    if (!rule) errors.push(`New button needs a contract: ${control.source}:${control.line} ${control.id}`);
    if (rule?.exempt) {
      if (rule.mustRemainInactive && control.observed) errors.push(`Exempt button became reachable; add a behavior test: ${control.source}:${control.line} ${control.id}`);
      continue;
    }
    if (!control.clicks.length) errors.push(`No passing click: ${control.source}:${control.line} ${control.id}`);
    for (const variant of rule?.variants || []) {
      if (!control.variants.some(actual => actual.clicks.length && matchesVariant(actual, variant))) {
        errors.push(`No passing click for ${variant.name}: ${control.source}:${control.line} ${control.id}`);
      }
    }
    if (rule?.exhaustiveVariants) {
      for (const variant of control.variants) {
        if (!(rule.variants || []).some(expected => matchesVariant(variant, expected))) {
          errors.push(`Unreviewed action variant: ${control.source}:${control.line} ${control.id} ${variant.label}`);
        }
      }
    }
  }
  for (const rule of contract.controls) {
    if (!current.has(rule.id)) errors.push(`Button removed or changed; review its contract: ${rule.source} ${rule.id}`);
    if ('exempt' in rule && !String(rule.exempt).trim()) errors.push(`Missing exemption reason: ${rule.id}`);
  }
  for (const rule of contract.runtimeControls || []) {
    if (!rule.exempt && !summary.unattributed.some(actual => actual.clicked && matchesVariant(actual, rule))) {
      errors.push(`No passing click for runtime button: ${rule.name}`);
    }
  }
  if (contract.checkRuntimeControls) {
    for (const control of summary.unattributed) {
      if (!(contract.runtimeControls || []).some(rule => matchesVariant(control, rule))) {
        errors.push(`Unattributed button needs a contract: ${control.label} ${control.attrs.class || ''}`);
      }
    }
  }
  return errors;
}

// Dead-code exclusions are reviewed source facts, not permanent holes in the gate. Wiring an
// excluded modal back into the app, or enabling its feature flag, requires restoring its tests.
export function checkExemptionGuards(contract, sources) {
  const errors = [];
  for (const rule of [
    ...[...contract.controls, ...(contract.runtimeControls || [])].filter(rule => rule.exempt),
    ...(contract.variantExclusions || []),
  ]) {
    if (!rule.guards?.length) errors.push(`Missing source guard for exemption: ${rule.id || rule.name}`);
    for (const guard of rule.guards || []) {
      const selected = guard.source ? [[guard.source, sources.get(guard.source) || '']] : [...sources.entries()];
      if (guard.includes !== undefined && !selected.some(([, text]) => text.includes(guard.includes))) {
        errors.push(`Exemption condition changed for ${rule.id || rule.name}: ${guard.includes}`);
      }
      if (guard.pattern) {
        const matches = selected.reduce((count, [, text]) => count + [...text.matchAll(new RegExp(guard.pattern, 'g'))].length, 0);
        if (matches !== guard.occurrences) errors.push(`Exempt entry point references changed for ${rule.id || rule.name}: ${guard.pattern} (${matches}, expected ${guard.occurrences})`);
      }
    }
  }
  return errors;
}
