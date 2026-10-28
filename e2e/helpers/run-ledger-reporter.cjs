'use strict';

// Playwright reporter for named test runs: under TEST_RUN=<name> it records every test that reached
// a final result in e2e/test-runs/<name>/<config>.jsonl. scripts/run-resumable.mjs passes those
// tests back as --test-list-invert, so a rerun under the same name continues where the last stopped.

const path = require('node:path');
const ledger = require('../../scripts/lib/test-run-ledger.cjs');

const E2E_DIR = path.resolve(__dirname, '..');

// Where a test sits: file relative to its project's testDir, and its describe titles then its own title.
function testPlace(test) {
  const project = test.parent.project();
  return {
    project: project.name,
    file: path.relative(project.testDir, test.location.file).split(path.sep).join('/'),
    line: test.location.line,
    column: test.location.column,
    // titlePath() is ['', project, file, ...describes, title].
    titles: test.titlePath().slice(3),
  };
}

// The controls run attaches the controls each test touched; keep them so its report can be built from the ledger.
function controlEvents(result) {
  const attachment = result.attachments.find((item) => item.name === 'ui-control-coverage' && item.body);
  return attachment ? JSON.parse(attachment.body.toString('utf8')) : undefined;
}

class RunLedgerReporter {
  constructor() {
    this.name = ledger.runName();
  }

  onBegin(config) {
    if (this.name) this.file = ledger.ledgerFile(E2E_DIR, this.name, ledger.playwrightSuite(config.configFile));
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    if (!this.name) return;
    const last = result.status === 'passed' || result.status === 'skipped' || result.retry >= test.retries;
    if (!last || result.status === 'interrupted') return;
    const place = testPlace(test);
    ledger.appendEntry(this.file, {
      id: ledger.playwrightTestListLine(place),
      status: result.status,
      outcome: test.outcome(),
      durationMs: result.duration,
      ...place,
      expectedStatus: test.expectedStatus,
      annotations: [...test.annotations, ...result.annotations],
      controlEvents: controlEvents(result),
    });
  }

  onEnd() {
    if (!this.name) return;
    console.log(ledger.formatSummary(this.name, 'tests', ledger.readLedger(this.file)));
  }
}

module.exports = RunLedgerReporter;
