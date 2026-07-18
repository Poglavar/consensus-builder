// Retired migration entry point. Server-side `applied` state is no longer part of the proposal
// schema; keeping this tombstone prevents an old runbook command from recreating that column.

export const RETIREMENT_MESSAGE = [
    'split-status-applied.js is retired because proposal.applied is browser-local state.',
    'Use scripts/remove-server-applied.js (dry-run first) to migrate an existing database.'
].join(' ');

function printRetirementNotice() {
    console.error(RETIREMENT_MESSAGE);
    process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    printRetirementNotice();
}
