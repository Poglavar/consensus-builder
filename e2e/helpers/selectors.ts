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

  // Sidebar
  sidebar: '#sidebar',
  sidebarToggle: '#toggle-sidebar-desktop, #toggle-sidebar-mobile',
  proposalsList: '#proposals-list, [data-testid="proposals-list"]',

  // Panels
  parcelInfoPanel: '#parcel-info-panel',
  proposalPanel: '#proposal-panel, [data-testid="proposal-panel"]',

  // City switcher
  citySwitcher: '#city-switcher, [data-testid="city-switcher"], select[name="city"]',

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
