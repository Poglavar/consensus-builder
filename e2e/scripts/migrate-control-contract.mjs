// Carry the control contract across a markup change. A rule's id is a hash of its source markup, so
// renaming a button's classes (the one-vocabulary migration) changes every id; the rules' meaning
// (variants, exemptions, guards) must follow the button, not the hash. For each rule whose id is
// gone, the button is found again in the same source file by its semantic key (id, onclick,
// data-i18n-key, data-sheet-target, data-action, aria-label, title, or the markup with its class
// attribute removed), the rule takes the new id and markup, and exemption guards are regenerated
// from the new markup. Rules whose button is really gone are dropped and listed; buttons with no
// rule get a bare rule. Prints what it did; --check only reports, --write rewrites the file.
//
//   node e2e/scripts/migrate-control-contract.mjs --check
//   node e2e/scripts/migrate-control-contract.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceInventory, sourceFiles, frontendRoot } from '../helpers/control-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractPath = path.join(root, 'control-contract.json');
const write = process.argv.includes('--write');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const sites = sourceInventory();
const sources = new Map(sourceFiles().map(file => [path.relative(frontendRoot, file), fs.readFileSync(file, 'utf8')]));

const KEY_ATTRS = ['id', 'onclick', 'data-i18n-key', 'data-sheet-target', 'data-action', 'data-command', 'aria-label', 'title'];
function attr(markup, name) {
  const m = markup.match(new RegExp(`\\b${name}\\s*=\\s*\\\\?["']([^"']*?)\\\\?["']`));
  return m ? m[1] : null;
}
function withoutClass(markup) {
  return markup.replace(/\s*\bclass\s*=\s*\\?["'][^"']*\\?["']/g, '').replace(/\s+/g, ' ').trim();
}
/** Semantic keys for a site, strongest first. */
function keysOf(markup) {
  const keys = [];
  if (/^<\w/.test(markup)) {
    for (const name of KEY_ATTRS) {
      const value = attr(markup, name);
      if (value) keys.push(`${name}=${value}`);
    }
  }
  keys.push(`markup=${withoutClass(markup)}`);
  return keys;
}
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function guardFor(source, markup) {
  const pattern = escapeRegex(markup).replace(/\s+/g, '\\s+');
  const occurrences = (sources.get(source)?.match(new RegExp(pattern, 'g')) || []).length;
  return { source, pattern, occurrences };
}

const currentById = new Map(sites.map(site => [site.id, site]));
const claimed = new Set();
const report = { kept: 0, remapped: [], dropped: [], added: [] };
const rules = [];

// Index the current sites by (source, key) for the remap.
const byKey = new Map();
sites.forEach(site => {
  keysOf(site.markup).forEach(key => {
    const index = `${site.source}|${key}`;
    if (!byKey.has(index)) byKey.set(index, []);
    byKey.get(index).push(site);
  });
});

for (const rule of contract.controls) {
  if (currentById.has(rule.id) && !claimed.has(rule.id)) {
    claimed.add(rule.id);
    rules.push(rule);
    report.kept++;
    continue;
  }
  let match = null;
  for (const key of keysOf(rule.markup)) {
    const candidates = (byKey.get(`${rule.source}|${key}`) || []).filter(site => !claimed.has(site.id));
    if (candidates.length === 1) { match = candidates[0]; break; }
    if (candidates.length > 1) {
      // Several buttons share the key (a repeated template): take the one whose class-free markup
      // is the same, else the first in source order.
      match = candidates.find(site => withoutClass(site.markup) === withoutClass(rule.markup)) || candidates[0];
      break;
    }
  }
  if (!match) { report.dropped.push(`${rule.source} ${rule.id} ${rule.markup.slice(0, 90)}`); continue; }
  claimed.add(match.id);
  const next = { ...rule, id: match.id, markup: match.markup };
  if (Array.isArray(rule.guards)) {
    next.guards = rule.guards.map(guard => {
      const stillMatches = (sources.get(guard.source)?.match(new RegExp(guard.pattern, 'g')) || []).length === guard.occurrences;
      return stillMatches ? guard : guardFor(match.source, match.markup);
    });
  }
  rules.push(next);
  report.remapped.push(`${rule.source}: ${rule.markup.slice(0, 60)} → ${match.markup.slice(0, 60)}`);
}

for (const site of sites) {
  if (claimed.has(site.id)) continue;
  rules.push({ id: site.id, source: site.source, markup: site.markup });
  report.added.push(`${site.source}:${site.line} ${site.markup.slice(0, 90)}`);
}

rules.sort((a, b) => a.source.localeCompare(b.source) || sites.findIndex(s => s.id === a.id) - sites.findIndex(s => s.id === b.id));
const next = { ...contract, controls: rules };

console.log(`kept ${report.kept}, remapped ${report.remapped.length}, added ${report.added.length}, dropped ${report.dropped.length}`);
if (report.dropped.length) { console.log('\nDropped (button no longer in the source):'); report.dropped.forEach(line => console.log('  ' + line)); }
if (report.added.length) { console.log('\nAdded bare rules (new buttons; give them variants when the behaviour tests exist):'); report.added.slice(0, 60).forEach(line => console.log('  ' + line)); if (report.added.length > 60) console.log(`  … ${report.added.length - 60} more`); }
if (write) {
  fs.writeFileSync(contractPath, JSON.stringify(next, null, 2) + '\n');
  console.log('\ncontrol-contract.json rewritten');
}
