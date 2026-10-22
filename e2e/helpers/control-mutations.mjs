// Deliberate, test-server-only regressions. Product files are never rewritten by a proof run.
export const controlMutations = {
  'hide-compact-edit': {
    file: 'proposal-compact-actions.spec.ts', grep: 'the real list opens a compact card',
    error: /btn-edit-geometry/,
    css: '#proposal-details-panel.is-minimized #proposal-details-footer .btn-edit-geometry { display: none !important; }',
  },
  'hide-actors': {
    file: 'activity-controls.spec.ts', grep: 'the Activity sheet Actors action opens',
    error: /activity-agents-button/,
    css: '#activity-agents-button { display: none !important; }',
  },
  'cover-road-actions': {
    file: 'mobile-road-reachability.spec.ts', grep: 'road header and cross-section actions stay reachable at 320px',
    error: /road-panel-minimize|receives/,
    css: '@media (max-width: 767.98px) { #road-info-panel::after { content: ""; position: absolute; inset: 0; z-index: 999; pointer-events: auto; } }',
  },
  'bets-late-load': {
    file: 'bets-sheet.spec.ts', grep: 'finishing the initial page load preserves a stake form',
    error: /data-market-amount|Bet no|bet-dialog|visible/i,
  },
};

export function mutateControlResponse(code, filename, name) {
  if (!name) return code;
  const mutation = controlMutations[name];
  if (!mutation) throw new Error(`Unknown UI control mutation: ${name}`);
  if (filename === 'index.html' && mutation.css) {
    return code.replace('</head>', `<style data-ui-control-mutation="${name}">${mutation.css}</style></head>`);
  }
  if (name === 'bets-late-load' && filename === 'js/bets/bets-sheet.js') {
    const needle = 'const link = initialBetLink;';
    if (!code.includes(needle)) throw new Error('The betting load-race mutation no longer matches the implementation.');
    return code.replace(needle, "const link = root.BetsLink && typeof root.BetsLink.parse === 'function' ? root.BetsLink.parse(root.location) : null;");
  }
  return code;
}
