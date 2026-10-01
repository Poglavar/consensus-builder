/**
 * Centralized CSS selectors for UI elements.
 * Update these when data-testid attributes are added to the frontend.
 */
export const selectors = {
  // Map
  mapContainer: '#map',
  leafletContainer: '.leaflet-container',
  leafletTileLayer: '.leaflet-tile-pane .leaflet-tile-container',
  leafletZoomIn: '.leaflet-control-zoom-in', // Note: may be disabled (zoomControl: false)
  leafletZoomOut: '.leaflet-control-zoom-out', // Note: may be disabled (zoomControl: false)
  parcelLayer: '.leaflet-overlay-pane svg, .leaflet-overlay-pane canvas',

  // Map shell (replaced the left sidebar; see UI-REWORK.md). Each button toggles the sheet named in
  // its data-sheet-target; the controls inside the sheets kept their old sidebar ids.
  mapShellButton: '[data-sheet-target]',
  openSheet: '.map-sheet:not([hidden])',
  sheetClose: '[data-sheet-close]',
  layersButton: '#layers-button',
  layersSheet: '#layers-sheet',
  settingsButton: '#settings-button',
  settingsSheet: '#settings-sheet',
  proposalsButton: '#proposals-button',
  proposalsSheet: '#proposals-sheet',
  toolsButton: '#tools-button',
  toolsSheet: '#tools-sheet',
  activityButton: '#activity-button',
  activitySheet: '#activity-sheet',
  gamePillToggle: '#game-pill-toggle',
  gameSheet: '#game-sheet',
  proposalsList: '#proposals-list, [data-testid="proposals-list"]',

  // Search box (top-left, #map-search-slot) with the city chip — replaced the city select and the
  // Locate-parcel row.
  searchSlot: '#map-search-slot',
  searchInput: '#map-search-input',
  searchResults: '#map-search-results',
  searchCityChip: '#map-search-slot .map-search__chip',
  searchCityResult: '#map-search-results .map-search__item--city',

  // Panels
  parcelInfoPanel: '#parcel-info-panel',
  proposalPanel: '#proposal-panel, [data-testid="proposal-panel"]',

  // Language switcher
  languageSwitcher: '#language-switcher, [data-testid="language-switcher"]',

  // Wallet
  walletButton: '.wallet-connect-button, #wallet-connect, [data-testid="wallet-connect"]',
  walletAddress: '#wallet-address, [data-testid="wallet-address"]',
  walletModalOverlay: '.wallet-modal-overlay',
  walletModalOptions: '[data-wallet-options]',
  walletModalError: '[data-wallet-modal-error]',
  walletConnectorButton: '[data-wallet-connector]',

  // Data source
  dataSourceSelect: '#data-source, [data-testid="data-source"]',

  // 3D mode
  threeDToggle: '#toggle-3d, [data-testid="toggle-3d"]',
  threeCanvas: 'canvas',

  // Road tools
  roadDrawButton: '#road-draw, [data-testid="road-draw"]',

  // Proposals
  createProposalButton: '#create-proposal, [data-testid="create-proposal"]',
  shareButton: '#share-proposal, [data-testid="share-proposal"]',
} as const;
