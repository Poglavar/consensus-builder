// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').classList.remove('visible');
}

// Road drawing tool variables
let roadDrawingMode = false;
// Make roadDrawingMode globally accessible so other modules can check it
function updateGlobalRoadDrawingMode(value) {
    roadDrawingMode = value;
    if (typeof window !== 'undefined') {
        window.roadDrawingMode = value;
    }
}
let roadPoints = [];
// Default width in meters; overridden by picker. The mapping uses representative carriageway widths.
let roadWidth = 7.5;
let roadCenterline = null;
let roadPolygon = null;
let roadPreviewLine = null;
let roadPreviewPolygon = null;
let roadAffectedParcels = [];
let roadMouseMarker = null;
let roadHasStarted = false;
let roadPreviewPolygonLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let lastRoadMoveUpdate = 0;
let throttleDelay = 150; // milliseconds between updates
let roadPreviewAffectedParcels = []; // Stores parcels affected by the preview segment

// Define style for preview-affected parcels
const previewAffectedStyle = {
    fillColor: '#ff6600', // Orange
    fillOpacity: 0.4,
    color: '#ff6600',
    weight: 2
};

const ROAD_OWNERSHIP_TYPE_IDS = {
    individual: 'road-owned-individuals',
    company: 'road-owned-companies',
    government: 'road-owned-government',
    institution: 'road-owned-institution',
    mixed: 'road-owned-mixed'
};
let roadOwnershipStatsRequestId = 0;
const roadOwnershipTypeCache = new Map();

function setRoadParcelStats(countValue, areaText = '—') {
    const countEl = document.getElementById('road-parcels-count');
    const areaEl = document.getElementById('road-parcels-area');
    if (countEl) countEl.textContent = typeof countValue === 'number' ? countValue.toString() : (countValue || '—');
    if (areaEl) areaEl.textContent = areaText || '—';
}

function formatParcelArea(area) {
    if (!Number.isFinite(area) || area <= 0) return '—';
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}

function resetRoadMetricPlaceholders() {
    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) ownerCountEl.textContent = '—';
    setRoadParcelStats(0, '—');
    Object.values(ROAD_OWNERSHIP_TYPE_IDS).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '—';
    });
    const marketEl = document.getElementById('road-market-price');
    if (marketEl) marketEl.textContent = '—';
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (difficultyEl) difficultyEl.textContent = '—';
    // Reset acquiring difficulty calculation
    updateRoadAcquiringDifficulty([]);
}

function formatRoadText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateRoadText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatRoadText(fallback, params);
}

function showRoadAlert(key, fallback, params = {}) {
    const message = translateRoadText(`alerts.messages.${key}`, fallback, params);
    const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
        ? window.showStyledAlert
        : window.alert;
    if (typeof alertFn === 'function') {
        alertFn(message);
    }
    return message;
}

function normalizeParcelOwnershipType(type) {
    const value = (type || '').toString().toLowerCase();
    if (value === 'mixed') return 'mixed';
    if (value.includes('gov') || value.includes('state') || value.includes('city') || value.includes('municip')) return 'government';
    if (value.includes('institution') || value.includes('university') || value.includes('school') || value.includes('hospital') || value.includes('church')) return 'institution';
    if (value.includes('company') || value.includes('business') || value.includes('corp') || value.includes('llc') || value.includes('gmbh') || value.includes('d.o.o') || value.includes('d.o.o.') || value.includes('d.d') || value.includes('d.d.') || value.includes('inc') || value.includes('sa') || value.includes('spa')) {
        return 'company';
    }
    return 'individual';
}

function setRoadOwnershipCounts(counts) {
    Object.entries(ROAD_OWNERSHIP_TYPE_IDS).forEach(([type, elementId]) => {
        const el = document.getElementById(elementId);
        if (!el) return;
        if (!counts) {
            el.textContent = '—';
            return;
        }
        const value = Number.isFinite(counts[type]) ? counts[type] : 0;
        el.textContent = value.toString();
    });
}

function getMarketPrice(parcelId, currency) {
    // For now, ignore currency parameter
    // Find the parcel in roadAffectedParcels or roadPreviewAffectedParcels
    let parcel = roadAffectedParcels.find(p => p.id === parcelId);
    if (!parcel) {
        parcel = roadPreviewAffectedParcels.find(p => p.id === parcelId);
    }

    // Check for precalculated estimatedMarketPrice first
    if (parcel) {
        const estimatedPrice = parcel.estimatedMarketPrice ||
            parcel.properties?.estimatedMarketPrice ||
            parcel.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            return estimatedPrice;
        }
    }

    // Fallback: try to get from layer
    if (parcelLayer) {
        let foundLayer = null;
        parcelLayer.eachLayer(layer => {
            if (layer.feature.properties.CESTICA_ID === parcelId) {
                foundLayer = layer;
            }
        });

        if (foundLayer) {
            // Check for precalculated estimatedMarketPrice in layer properties
            const estimatedPrice = foundLayer.feature.properties.estimatedMarketPrice;
            if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
                return estimatedPrice;
            }

            // Fallback to area calculation
            const area = Number(foundLayer.feature.properties.calculatedArea) || 0;
            return area * 100;
        }
    }

    // If found in arrays but no estimatedMarketPrice, use stored area
    if (parcel && Number.isFinite(parcel.area)) {
        return parcel.area * 100;
    }

    return 0;
}

function updateRoadMarketPrice(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const marketEl = document.getElementById('road-market-price');
    if (!marketEl) return;

    if (parcelsList.length === 0) {
        marketEl.textContent = '—';
        return;
    }

    const totalPrice = parcelsList.reduce((sum, parcel) => {
        // Check for precalculated estimatedMarketPrice first
        const estimatedPrice = parcel?.estimatedMarketPrice ||
            parcel?.properties?.estimatedMarketPrice ||
            parcel?.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            return sum + estimatedPrice;
        }

        // Fallback: get parcel ID and use getMarketPrice
        const parcelId = parcel && (parcel.id || parcel.parcelId || parcel.CESTICA_ID || parcel.properties?.CESTICA_ID);
        if (!parcelId) return sum;
        const price = getMarketPrice(parcelId);
        return sum + (Number.isFinite(price) ? price : 0);
    }, 0);

    marketEl.textContent = totalPrice > 0 ? Math.round(totalPrice).toLocaleString('hr-HR') : '—';
}

async function updateRoadAcquiringDifficulty(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (!difficultyEl) return;

    if (parcelsList.length === 0) {
        difficultyEl.textContent = '—';
        return;
    }

    // Ownership type coefficients
    const OWNERSHIP_COEFFICIENTS = {
        government: 0,
        institution: 0,
        company: 1,
        individual: 2,
        mixed: 2 // Mixed ownership defaults to individual difficulty (highest)
    };

    const hasOwnershipFn = typeof getOwnershipType === 'function';

    let totalDifficulty = 0;

    // Process parcels
    const parcelDifficulties = parcelsList.map((parcel) => {
        const parcelId = parcel && (parcel.id || parcel.parcelId || parcel.CESTICA_ID || parcel.properties?.CESTICA_ID);
        if (!parcelId) return 0;

        // Get market price - check for precalculated estimatedMarketPrice first
        let marketPrice = 0;
        const estimatedPrice = parcel?.estimatedMarketPrice ||
            parcel?.properties?.estimatedMarketPrice ||
            parcel?.layer?.feature?.properties?.estimatedMarketPrice;
        if (Number.isFinite(estimatedPrice) && estimatedPrice > 0) {
            marketPrice = estimatedPrice;
        } else if (parcel && Number.isFinite(parcel.area)) {
            marketPrice = parcel.area * 100;
        } else {
            marketPrice = getMarketPrice(parcelId);
        }
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) return 0;

        // Get ownership type from parcel feature properties (from GET /parcels/)
        let ownershipType = 'individual'; // default
        const featureProps = parcel.layer?.feature?.properties || parcel.properties || {};
        const ownershipList = featureProps.ownershipList || [];
        const ownershipTypeFromProps = featureProps.ownershipType;

        if (ownershipTypeFromProps) {
            ownershipType = normalizeParcelOwnershipType(ownershipTypeFromProps);
        } else if (Array.isArray(ownershipList) && ownershipList.length > 0 && hasOwnershipFn) {
            // Determine type from ownershipList if ownershipType not available
            const ownerTypes = ownershipList.map(owner => {
                const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                return normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
            }).filter(Boolean);
            const uniqueTypes = Array.from(new Set(ownerTypes.length ? ownerTypes : ['individual']));
            ownershipType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
        } else {
            // Check cache as fallback
            const cachedType = roadOwnershipTypeCache.get(parcelId);
            if (cachedType) {
                ownershipType = normalizeParcelOwnershipType(cachedType);
            }
        }

        // Calculate difficulty: market_price * coefficient
        const coefficient = OWNERSHIP_COEFFICIENTS[ownershipType] || OWNERSHIP_COEFFICIENTS.individual;
        return marketPrice * coefficient;
    });

    totalDifficulty = parcelDifficulties.reduce((sum, diff) => sum + diff, 0);

    difficultyEl.textContent = totalDifficulty > 0 ? Math.round(totalDifficulty).toLocaleString('hr-HR') : '—';
}

// Collect ownership and acquisition stats from the road info panel
function collectOwnershipAndAcquisitionStats() {
    const stats = {
        individualOwners: null,
        ownershipCounts: {
            individual: null,
            company: null,
            government: null,
            institution: null,
            mixed: null
        },
        totalMarketPrice: null,
        totalAcquiringDifficulty: null
    };

    // Get individual owners count
    const individualOwnersEl = document.getElementById('road-individual-owners');
    if (individualOwnersEl && individualOwnersEl.textContent !== '—') {
        const value = parseInt(individualOwnersEl.textContent, 10);
        if (Number.isFinite(value)) {
            stats.individualOwners = value;
        }
    }

    // Get ownership type counts
    Object.entries(ROAD_OWNERSHIP_TYPE_IDS).forEach(([type, elementId]) => {
        const el = document.getElementById(elementId);
        if (el && el.textContent !== '—') {
            const value = parseInt(el.textContent, 10);
            if (Number.isFinite(value)) {
                stats.ownershipCounts[type] = value;
            }
        }
    });

    // Get total market price
    const marketPriceEl = document.getElementById('road-market-price');
    if (marketPriceEl && marketPriceEl.textContent !== '—') {
        // Remove all non-digit characters (handles Croatian locale: spaces, dots, commas as thousand separators)
        // Since these are rounded integers from Math.round(), we don't need to preserve decimals
        const cleaned = marketPriceEl.textContent.replace(/\D/g, '');
        if (cleaned.length > 0) {
            const value = parseInt(cleaned, 10);
            if (Number.isFinite(value) && value >= 0) {
                stats.totalMarketPrice = value;
            }
        }
    }

    // Get total acquiring difficulty
    const difficultyEl = document.getElementById('road-acquire-difficulty');
    if (difficultyEl && difficultyEl.textContent !== '—') {
        // Remove all non-digit characters (handles Croatian locale: spaces, dots, commas as thousand separators)
        const cleaned = difficultyEl.textContent.replace(/\D/g, '');
        if (cleaned.length > 0) {
            const value = parseInt(cleaned, 10);
            if (Number.isFinite(value) && value >= 0) {
                stats.totalAcquiringDifficulty = value;
            }
        }
    }

    // Return null if no stats were collected (all null)
    const hasAnyStats = stats.individualOwners !== null ||
        Object.values(stats.ownershipCounts).some(v => v !== null) ||
        stats.totalMarketPrice !== null ||
        stats.totalAcquiringDifficulty !== null;

    return hasAnyStats ? stats : null;
}

async function updateRoadOwnershipCounts(parcels) {
    const parcelsList = Array.isArray(parcels) ? parcels : [];
    const requestId = ++roadOwnershipStatsRequestId;

    if (parcelsList.length === 0) {
        setRoadOwnershipCounts(null);
        const ownerCountEl = document.getElementById('road-individual-owners');
        if (ownerCountEl) ownerCountEl.textContent = '—';
        return;
    }

    const hasOwnershipFn = typeof getOwnershipType === 'function';
    const typeCounts = { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 };
    let totalIndividualOwners = 0;

    const parcelData = parcelsList.map((parcel) => {
        const parcelId = parcel && (parcel.id || parcel.parcelId || parcel.CESTICA_ID || parcel.properties?.CESTICA_ID);
        if (!parcelId) return { type: null, individualOwnerCount: 0 };

        // Get ownership data from parcel feature properties (from GET /parcels/)
        const featureProps = parcel.layer?.feature?.properties || parcel.properties || {};
        const ownershipList = featureProps.ownershipList || [];
        const ownershipType = featureProps.ownershipType;

        let parcelType = null;
        let individualOwnerCount = 0;

        // Use ownershipType from feature properties if available
        if (ownershipType) {
            parcelType = normalizeParcelOwnershipType(ownershipType);
        }

        // Count individual owners from ownershipList
        if (Array.isArray(ownershipList) && ownershipList.length > 0) {
            if (hasOwnershipFn) {
                // Use getOwnershipType function to determine owner types
                ownershipList.forEach(owner => {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                    const ownerType = normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
                    if (ownerType === 'individual') {
                        individualOwnerCount++;
                    }
                });
            } else {
                // Fallback: if no getOwnershipType function, count all as individuals
                individualOwnerCount = ownershipList.length;
            }

            // If we don't have ownershipType but have ownershipList, determine type
            if (!parcelType && hasOwnershipFn) {
                const ownerTypes = ownershipList.map(owner => {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner || '';
                    return normalizeParcelOwnershipType(getOwnershipType(ownerLabel));
                }).filter(Boolean);
                const uniqueTypes = Array.from(new Set(ownerTypes.length ? ownerTypes : ['individual']));
                parcelType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
            } else if (!parcelType) {
                // Default to individual if we can't determine
                parcelType = 'individual';
            }
        } else {
            // No ownership data available, use default
            if (!parcelType) {
                parcelType = 'individual';
            }
            individualOwnerCount = 1; // Assume single owner
        }

        // Cache the type for future use
        if (parcelType) {
            roadOwnershipTypeCache.set(parcelId, parcelType);
        }

        return { type: parcelType, individualOwnerCount };
    });

    if (requestId !== roadOwnershipStatsRequestId) {
        return;
    }

    parcelData.forEach(({ type, individualOwnerCount }) => {
        if (type) {
            const normalized = normalizeParcelOwnershipType(type);
            if (!typeCounts[normalized]) {
                typeCounts[normalized] = 0;
            }
            typeCounts[normalized] += 1;
        }
        totalIndividualOwners += individualOwnerCount;
    });

    setRoadOwnershipCounts(typeCounts);

    const ownerCountEl = document.getElementById('road-individual-owners');
    if (ownerCountEl) {
        ownerCountEl.textContent = totalIndividualOwners > 0 ? totalIndividualOwners.toString() : '—';
    }
}

// Toggle road drawing tool
function toggleRoadDrawTool() {
    updateGlobalRoadDrawingMode(!roadDrawingMode);
    const roadDrawButton = document.getElementById('roadDrawButton');
    const roadWidthContainer = document.getElementById('roadWidthContainer');
    const roadWidthSelect = document.getElementById('roadWidthSelect');
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');

    if (roadDrawingMode) {
        // Activate road drawing mode
        console.log("Activating road drawing mode");
        roadDrawButton.classList.add('active');
        roadDrawButton.classList.add('active-black-border');

        // Show width container and drawing controls in the Road Info panel
        // Hide legacy dropdown UI while using the modal-based picker
        if (roadWidthContainer) roadWidthContainer.style.display = 'none';
        if (roadWidthSelect) roadWidthSelect.disabled = true;

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools and interactivity
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool(); // Add check for measureMode existence

        // --- Robustly disable parcel interaction --- 
        if (parcelLayer) {
            console.log("Disabling parcel click listeners");
            parcelLayer.eachLayer(layer => {
                layer.off('click'); // Remove all click listeners
            });
        }
        // --- End robust disable --- 

        // Hide block info and parcel info panels
        const blockInfoPanel = document.getElementById('block-info-panel');
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (blockInfoPanel) blockInfoPanel.classList.remove('visible');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');

        // Initialize road width via the new width picker modal; fallback to dropdown if modal is unavailable
        try {
            showRoadWidthPicker().then(width => {
                if (typeof width === 'number' && isFinite(width)) {
                    roadWidth = width;
                } else if (roadWidthSelect) {
                    roadWidth = parseFloat(roadWidthSelect.value);
                }
                // Show the road info panel and set status after width is chosen
                const roadInfoPanel = document.getElementById('road-info-panel');
                if (roadInfoPanel) {
                    roadInfoPanel.style.removeProperty('display');
                    roadInfoPanel.classList.add('visible');
                }
                const statusElement = document.getElementById('status');
                if (statusElement) updateStatus('Click on the map to start drawing a road');
                // Show drawing controls now that we're ready
                const roadDrawingControls = document.getElementById('road-drawing-controls');
                if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
                // Activate map and keyboard handlers now that width is set
                map.on('click', handleRoadClick);
                map.on('mousemove', handleRoadMouseMove);
                map.on('mouseout', handleRoadMouseOut);
                document.addEventListener('keydown', handleRoadKeydown);
            }).catch(() => {
                // If picker was cancelled, turn off drawing mode gracefully
                updateGlobalRoadDrawingMode(false);
                if (roadDrawButton) {
                    roadDrawButton.classList.remove('active');
                    roadDrawButton.classList.remove('active-black-border');
                }
                if (roadWidthContainer) roadWidthContainer.style.display = 'none';
                const roadDrawingControls = document.getElementById('road-drawing-controls');
                if (roadDrawingControls) roadDrawingControls.style.display = 'none';
                map.getContainer().style.cursor = '';
                map.getContainer().classList.remove('crosshairs-cursor');
                // Remove event handlers bound for drawing
                map.off('click', handleRoadClick);
                map.off('mousemove', handleRoadMouseMove);
                map.off('mouseout', handleRoadMouseOut);
                document.removeEventListener('keydown', handleRoadKeydown);

                // Clear the interval that disables parcel clicks
                // Re-enable parcel interaction
                if (parcelLayer) {
                    try {
                        parcelLayer.eachLayer(layer => {
                            layer.off('click');
                            if (typeof getCorrectClickHandler === 'function') {
                                layer.on('click', getCorrectClickHandler());
                            }
                        });
                    } catch (_) { }
                }
            });
        } catch (e) {
            console.warn('Road width picker unavailable, falling back to dropdown', e);
            if (roadWidthSelect) roadWidth = parseFloat(roadWidthSelect.value);
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) {
                roadInfoPanel.style.removeProperty('display');
                roadInfoPanel.classList.add('visible');
            }
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus('Click on the map to start drawing a road');
        }
        // Map and keyboard handlers will be attached after width is chosen

        // Note: Road info panel visibility and status are handled after width pick

    } else {
        // Deactivate road drawing mode
        console.log("Deactivating road drawing mode");
        if (roadDrawButton) {
            roadDrawButton.classList.remove('active');
            roadDrawButton.classList.remove('active-black-border');
        }
        if (roadWidthContainer) roadWidthContainer.style.display = 'none';

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'none';
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove road drawing event handlers from the map
        map.off('click', handleRoadClick);
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
        document.removeEventListener('keydown', handleRoadKeydown);

        // --- Robustly re-enable parcel interaction --- 
        if (parcelLayer) {
            console.log("Re-enabling parcel click listeners");
            parcelLayer.eachLayer(layer => {
                layer.off('click'); // Remove any lingering road-related handlers
                layer.on('click', getCorrectClickHandler()); // Use the authoritative handler
            });
        }
        // --- End robust re-enable ---

        // Reset road drawing variables
        resetRoadDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');
    }
}

// Handle keyboard events during road drawing
function handleRoadKeydown(e) {
    // Prevent handling if we're in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // Check for F key (finish road)
    if ((e.key === 'f' || e.key === 'F') && roadHasStarted && roadPoints.length >= 2) {
        e.preventDefault(); // Prevent browser default behavior
        finishRoadDrawing();
    }

    // Check for Escape key (cancel road)
    if (e.key === 'Escape') {
        e.preventDefault(); // Prevent browser default behavior
        cancelRoadDrawing();
    }
}

// Handle road width selection change
const widthSelectEl = document.getElementById('roadWidthSelect');
if (widthSelectEl) {
    widthSelectEl.addEventListener('change', function () {
        roadWidth = parseFloat(this.value);
        if (roadHasStarted) {
            updateRoadPreview();
            updateRoadInfoPanel();
        }
    });
}

// Road Width Picker modal implementation
function showRoadWidthPicker() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('road-width-modal');
        const grid = document.getElementById('road-width-grid');
        const btnConfirm = document.getElementById('road-width-confirm-btn');
        const btnCancel = document.getElementById('road-width-cancel-btn');
        if (!modal || !grid || !btnConfirm || !btnCancel) {
            console.warn('Road width modal elements missing');
            resolve(7.5); // fallback silently
            return;
        }

        // Options: label -> width meters
        const options = [
            { id: 'roadwidth1', label: 'Boulevard ~80 m', width: 80 },
            { id: 'roadwidth2', label: 'Avenue ~40 m', width: 40 },
            { id: 'roadwidth3', label: 'Main street ~26 m', width: 26 },
            { id: 'roadwidth4', label: 'Collector ~18 m', width: 18 },
            { id: 'roadwidth5', label: 'Local ~10 m', width: 10 },
            { id: 'roadwidth6', label: 'Alley ~7.5 m', width: 7.5 },
        ];

        // Prefill grid
        grid.innerHTML = '';
        let selectedId = (PersistentStorage.getItem('lastRoadWidthId')) || 'roadwidth6';

        options.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.width = String(opt.width);
            const img = document.createElement('img');
            img.className = 'roadwidth-thumb';
            img.alt = opt.label;
            img.src = getRoadWidthThumbDataURI(opt.id);
            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label}`;
            card.appendChild(img);
            card.appendChild(lbl);
            card.addEventListener('click', () => {
                selectedId = opt.id;
                grid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                // Confirm immediately on click
                confirmSelection();
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    card.click();
                }
            });
            grid.appendChild(card);
        });

        function confirmSelection() {
            const opt = options.find(o => o.id === selectedId) || options[options.length - 1];
            PersistentStorage.setItem('lastRoadWidthId', opt.id);
            hide();
            // Collapse sidebar if open
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
            resolve(opt.width);
        }
        function cancelSelection() { hide(); reject(new Error('cancelled')); }
        function handleKey(ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); confirmSelection(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancelSelection(); }
        }
        function hide() {
            modal.style.display = 'none';
            document.removeEventListener('keydown', handleKey);
            btnConfirm.removeEventListener('click', confirmSelection);
            btnCancel.removeEventListener('click', cancelSelection);
        }

        btnConfirm.addEventListener('click', confirmSelection);
        btnCancel.addEventListener('click', cancelSelection);
        document.addEventListener('keydown', handleKey);
        // Use flex to center the modal content per CSS
        modal.style.display = 'flex';
    });
}

// Create a simple inline SVG thumb for each option id.
function getRoadWidthThumbDataURI(id) {
    // Map ID to an approximate lane/offset visualization by road band height
    const map = {
        roadwidth1: 80,
        roadwidth2: 40,
        roadwidth3: 26,
        roadwidth4: 18,
        roadwidth5: 10,
        roadwidth6: 7.5
    };
    const w = 200, h = 120;
    const bg = '#cfd8dc';
    const asphalt = '#616161';
    const line = '#ffffff';
    const label = map[id] ?? 7.5;
    // Convert "width meters" to a normalized band thickness between 20 and 100 px
    const minBand = 22, maxBand = 98;
    const minM = 7.5, maxM = 80;
    const t = Math.max(0, Math.min(1, (label - minM) / (maxM - minM)));
    const band = Math.round(minBand + t * (maxBand - minBand));
    const y = Math.round((h - band) / 2);
    const dashHeight = 4;
    const dashWidth = 8;
    // Build SVG
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>
    <defs>
        <pattern id='dash' width='${dashWidth * 2}' height='${dashHeight}' patternUnits='userSpaceOnUse'>
            <rect x='0' y='0' width='${dashWidth}' height='${dashHeight}' fill='${line}' />
        </pattern>
    </defs>
    <rect width='${w}' height='${h}' fill='${bg}'/>
    <rect x='20' y='${y}' width='${w - 40}' height='${band}' rx='6' fill='${asphalt}'/>
    <rect x='20' y='${Math.round(h / 2 - dashHeight / 2)}' width='${w - 40}' height='${dashHeight}' fill='url(#dash)'/>
</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// Handle road drawing clicks
function handleRoadClick(e) {
    console.log("handleRoadClick fired");
    // Stop event propagation to prevent parcel selection or other click handlers
    L.DomEvent.stopPropagation(e);

    const clickPoint = e.latlng;

    if (!roadHasStarted) {
        // First click - start the road
        roadPoints = [clickPoint];
        roadHasStarted = true;

        // Add marker for the starting point
        const startMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);
        roadMarkers.push(startMarker); // Store the marker

        // Initialize road centerline
        roadCenterline = L.polyline([clickPoint], {
            color: 'green',
            weight: 3,
            dashArray: '5, 5',
            opacity: 0.7
        }).addTo(map);

        // Show status for next point
        updateStatus('Click to add road points, "Finish" when done');
    } else {
        // Add another point to the road
        roadPoints.push(clickPoint);

        // Add marker for this point
        const pointMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);
        roadMarkers.push(pointMarker); // Store the marker

        // Update the centerline
        roadCenterline.addLatLng(clickPoint);

        // Wrap the entire segment processing in try...catch for robustness
        try {
            // Clear any existing *preview* highlighting and polygon layers
            // Do this *before* calculating the new committed polygon
            clearPreviewAffectedParcels();
            if (roadPreviewPolygonLayer) {
                roadPreviewPolygonLayer.removeFrom(map);
                roadPreviewPolygonLayer = null;
            }
            if (roadPreviewLine) {
                roadPreviewLine.removeFrom(map);
                roadPreviewLine = null;
            }

            // Calculate the new committed road polygon
            const newCommittedPolygon = calculateRoadPolygon(roadPoints, roadWidth);

            // Update the global roadPolygon variable
            roadPolygon = newCommittedPolygon;

            // Remove the *previous* committed polygon layer before adding the new one
            if (roadPolygonLayer) {
                map.removeLayer(roadPolygonLayer);
                roadPolygonLayer = null; // Ensure it's cleared
            }

            if (roadPolygon) {
                // Draw the new committed road polygon
                roadPolygonLayer = L.polygon(roadPolygon, {
                    color: 'green',
                    weight: 2,
                    fillColor: 'green',
                    fillOpacity: 0.3
                }).addTo(map);

                // Find and highlight parcels affected by the *newly committed* road
                findAffectedParcels(roadPolygon);
            } else {
                console.warn("Failed to calculate committed road polygon after click.");
                // Optionally, clear committed highlights if calculation fails?
                // clearAffectedParcels(); // Decided against this for now
            }

        } catch (error) {
            console.error('Error processing road segment after click:', error);
            // Consider what state to reset on error? Maybe cancel the drawing?
            // For now, just log the error.
        }
    }

    // Always update the info panel
    updateRoadInfoPanel();
}

// Handle road mouse movement for preview
function handleRoadMouseMove(e) {
    if (!roadHasStarted || !roadPoints || roadPoints.length === 0) return;

    // Get current mouse position
    const mouseLatLng = e.latlng;

    // Display temporary line from last point to current mouse position
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
    }

    // Create the latest centerline segment
    const latestRoadPoints = [...roadPoints, mouseLatLng];

    // Only try to calculate a road polygon if we have at least 2 points
    if (latestRoadPoints.length >= 2) {
        try {
            const tempRoadPolygon = calculateRoadPolygon(latestRoadPoints, roadWidth);

            // Only continue if we have a valid polygon
            if (tempRoadPolygon && tempRoadPolygon.length >= 3) {
                // Draw the new preview line
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);

                // Draw the new preview polygon
                if (roadPreviewPolygonLayer) {
                    roadPreviewPolygonLayer.removeFrom(map);
                }
                roadPreviewPolygonLayer = L.polygon(tempRoadPolygon, {
                    color: '#ff6600',
                    weight: 1,
                    fillColor: '#ff6600',
                    fillOpacity: 0.2
                }).addTo(map);

                // Find and highlight parcels affected *only* by the preview
                findPreviewAffectedParcels(tempRoadPolygon);

                lastRoadMoveUpdate = Date.now(); // Keep for potential throttling later

                // Update road info with preview metrics
                updateRoadInfoWithPreview(latestRoadPoints, tempRoadPolygon);
            } else {
                console.warn('Invalid road polygon for preview - cannot display polygon');
                // Clear only preview highlighting if polygon becomes invalid
                clearPreviewAffectedParcels();

                // Still show a simple preview line
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);
            }
        } catch (error) {
            console.error('Error in road preview calculation:', error);
            // Clear only preview highlighting on error
            clearPreviewAffectedParcels();

            // Still show a simple preview line
            roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                color: '#ff6600',
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);
        }
    } else {
        // If we only have one point, just show a line to the mouse cursor
        roadPreviewLine = L.polyline([roadPoints[0], mouseLatLng], {
            color: '#ff6600',
            dashArray: '5, 10',
            weight: 2
        }).addTo(map);
    }
}

// Handle road mouse movement out
function handleRoadMouseOut(e) {
    if (!roadDrawingMode) return; // Only act if in drawing mode

    // Clear preview line
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
        roadPreviewLine = null;
    }

    // Clear preview polygon
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Clear only the preview highlighting
    clearPreviewAffectedParcels();
}

// Stop following the cursor with a preview line/polygon (used when finishing)
function stopRoadPreviewTracking() {
    try {
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
    } catch (_) { }

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }
    clearPreviewAffectedParcels();
}

// Remove interactive handlers while finishing/cancelling
function suspendRoadDrawingInteractivity() {
    try { map.off('click', handleRoadClick); } catch (_) { }
    try { map.off('mousemove', handleRoadMouseMove); } catch (_) { }
    try { map.off('mouseout', handleRoadMouseOut); } catch (_) { }
    document.removeEventListener('keydown', handleRoadKeydown);
}

// Fully exit road drawing mode and clean up UI/handlers
function exitRoadDrawingMode() {
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    // Reset state and UI
    resetRoadDrawing();
    updateGlobalRoadDrawingMode(false);

    const roadDrawButton = document.getElementById('roadDrawButton');
    if (roadDrawButton) {
        roadDrawButton.classList.remove('active');
        roadDrawButton.classList.remove('active-black-border');
        roadDrawButton.removeAttribute('aria-pressed');
        roadDrawButton.blur();
    }

    const roadDrawingControls = document.getElementById('road-drawing-controls');
    if (roadDrawingControls) roadDrawingControls.style.display = 'none';

    const roadWidthContainer = document.getElementById('roadWidthContainer');
    if (roadWidthContainer) roadWidthContainer.style.display = 'none';

    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        roadInfoPanel.classList.remove('visible');
        roadInfoPanel.style.removeProperty('display');
    }

    if (map && map.getContainer) {
        try {
            map.getContainer().style.cursor = '';
            map.getContainer().classList.remove('crosshairs-cursor');
        } catch (_) { }
    }

    // Re-enable parcel interaction
    if (parcelLayer) {
        try {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
                if (typeof getCorrectClickHandler === 'function') {
                    layer.on('click', getCorrectClickHandler());
                }
            });
        } catch (_) { }
    }

    const statusElement = document.getElementById('status');
    if (statusElement) updateStatus('');
}

// Legacy road polygon builder using per-segment rectangles and wedges
function calculateRoadPolygonRectangular(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    // If we only have two points, just return a single rectangle
    if (points.length === 2) {
        return createRectangularRoadSegment(points[0], points[1], width);
    }

    // Create individual rectangular segments for each pair of points
    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        // For the first segment, initialize the combined polygon
        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            // Combine with existing polygon
            combinedPolygon = combineRoadPolygons(combinedPolygon, segment);
        }

        // If combining failed, use just this segment
        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }

        // At each interior joint, add a wedge to fill the outer gap between segments
        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

// Calculate road polygon from centerline using smoothed offsets
function calculateRoadPolygon(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    const smoothed = buildOffsetRoadPolygon(points, width);
    if (smoothed && smoothed.length >= 4) {
        return smoothed;
    }

    // Fallback to the legacy rectangle-based approach if smoothing fails
    return calculateRoadPolygonRectangular(points, width);
}

function buildOffsetRoadPolygon(points, width) {
    try {
        const halfWidth = width / 2;
        if (!isFinite(halfWidth) || halfWidth <= 0) {
            return null;
        }

        // Convert to metric coordinates and remove consecutive duplicates
        const rawHTRS = points
            .map(p => wgs84ToHTRS96(p.lat, p.lng))
            .filter(isValidPoint);

        if (rawHTRS.length < 2) return null;

        const cleanedHTRS = [];
        const minDistance = 0.05; // meters
        for (const pt of rawHTRS) {
            if (cleanedHTRS.length === 0) {
                cleanedHTRS.push(pt);
                continue;
            }
            const prev = cleanedHTRS[cleanedHTRS.length - 1];
            const dx = pt[0] - prev[0];
            const dy = pt[1] - prev[1];
            if (Math.hypot(dx, dy) >= minDistance) {
                cleanedHTRS.push(pt);
            }
        }

        if (cleanedHTRS.length < 2) return null;

        const directions = [];
        for (let i = 0; i < cleanedHTRS.length - 1; i++) {
            const dx = cleanedHTRS[i + 1][0] - cleanedHTRS[i][0];
            const dy = cleanedHTRS[i + 1][1] - cleanedHTRS[i][1];
            const len = Math.hypot(dx, dy);
            directions.push(len < 1e-6 ? null : [dx / len, dy / len]);
        }

        const resolvePrevDirection = (idx) => {
            for (let i = idx - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            for (let i = 0; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const resolveNextDirection = (idx) => {
            for (let i = idx; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            for (let i = directions.length - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const addVec = (a, b) => [a[0] + b[0], a[1] + b[1]];
        const scaleVec = (v, scalar) => [v[0] * scalar, v[1] * scalar];
        const vecLength = (v) => Math.hypot(v[0], v[1]);
        const leftNormal = (dir) => [-dir[1], dir[0]];
        const rightNormal = (dir) => [dir[1], -dir[0]];

        const computeOffsetPoint = (point, dirPrev, dirNext, side) => {
            const normalFromDir = side === 1 ? leftNormal : rightNormal;

            if (!dirPrev && dirNext) {
                const normal = normalFromDir(dirNext);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (dirPrev && !dirNext) {
                const normal = normalFromDir(dirPrev);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (!dirPrev && !dirNext) {
                return [point[0], point[1]];
            }

            const normalPrev = normalFromDir(dirPrev);
            const normalNext = normalFromDir(dirNext);
            const summed = addVec(normalPrev, normalNext);
            const sumLen = vecLength(summed);

            if (sumLen < 1e-6) {
                return addVec(point, scaleVec(normalNext, halfWidth));
            }

            const miter = [summed[0] / sumLen, summed[1] / sumLen];
            let dot = miter[0] * normalNext[0] + miter[1] * normalNext[1];
            if (Math.abs(dot) < 1e-6) {
                dot = 1e-6 * Math.sign(dot || 1);
            }

            let scaleFactor = halfWidth / dot;
            const miterLimit = 6;
            const maxScale = miterLimit * halfWidth;
            if (Math.abs(scaleFactor) > maxScale) {
                const fallbackNormal = dot > 0 ? normalNext : normalPrev;
                return addVec(point, scaleVec(fallbackNormal, halfWidth));
            }

            return addVec(point, scaleVec(miter, scaleFactor));
        };

        const leftPts = [];
        const rightPts = [];
        for (let i = 0; i < cleanedHTRS.length; i++) {
            const dirPrev = i > 0 ? resolvePrevDirection(i) : null;
            const dirNext = i < cleanedHTRS.length - 1 ? resolveNextDirection(i) : null;

            const leftPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, 1);
            const rightPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, -1);

            leftPts.push(leftPt);
            rightPts.push(rightPt);
        }

        const polygonHTRS = [...leftPts, ...rightPts.reverse()];
        if (polygonHTRS.length < 4) return null;

        const first = polygonHTRS[0];
        const last = polygonHTRS[polygonHTRS.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
            polygonHTRS.push([...first]);
        }

        return polygonHTRS.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return L.latLng(lat, lng);
        });
    } catch (error) {
        console.warn('Failed to build offset road polygon', error);
        return null;
    }
}

// Helper function to check if a point is valid
function isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

// Helper function to ensure a polygon is closed (first and last points match)
function ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords; // Can't close with fewer than 3 points

    const first = coords[0];
    const last = coords[coords.length - 1];

    // Check if first and last points are the same
    if (first[0] !== last[0] || first[1] !== last[1]) {
        // Make a deep copy to avoid modifying the original
        const newCoords = [...coords];
        // Add a copy of the first point at the end
        newCoords.push([...first]);
        return newCoords;
    }

    return coords; // Already closed
}

// Get parcel outer ring(s) in [lng, lat] arrays; handles Polygon and MultiPolygon, with fallback to layer.getLatLngs()
function getParcelOuterRingsLngLat(layer) {
    const rings = [];
    try {
        const geom = layer && layer.feature ? layer.feature.geometry : null;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        } else if (typeof layer.getLatLngs === 'function') {
            const latlngs = layer.getLatLngs();
            // MultiPolygon form: [ [ [LatLng...] (outer), [LatLng...] (holes) ], ... ]
            if (Array.isArray(latlngs) && Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0])) {
                latlngs.forEach(polyRings => {
                    if (Array.isArray(polyRings) && Array.isArray(polyRings[0])) {
                        const ring = polyRings[0].map(ll => [ll.lng, ll.lat]);
                        const closed = ensurePolygonIsClosed(ring);
                        if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
                    }
                });
            } else if (Array.isArray(latlngs) && Array.isArray(latlngs[0])) {
                // Polygon form: [ [LatLng...] (outer), [LatLng...] (hole1), ... ]
                const ring = latlngs[0].map(ll => [ll.lng, ll.lat]);
                const closed = ensurePolygonIsClosed(ring);
                if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
            }
        }
    } catch (_) { }
    return rings;
}

function convertRoadPolygonToLatLngPairs(polygon) {
    if (!Array.isArray(polygon)) return null;
    const pairs = [];
    polygon.forEach(entry => {
        if (!entry) return;
        if (typeof entry.lat === 'number' && typeof entry.lng === 'number') {
            pairs.push([entry.lat, entry.lng]);
        } else if (Array.isArray(entry) && entry.length >= 2) {
            let [a, b] = entry;
            if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                pairs.push([b, a]);
            } else if (Number.isFinite(a) && Number.isFinite(b)) {
                pairs.push([a, b]);
            }
        }
    });
    if (pairs.length >= 3) {
        const first = pairs[0];
        const last = pairs[pairs.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            pairs.push([...first]);
        }
        return pairs;
    }
    return null;
}

function buildParcelPolygonLatLngs(parcels) {
    const results = [];
    if (!Array.isArray(parcels)) return results;
    parcels.forEach(parcel => {
        const rings = getParcelOuterRingsLngLat(parcel.layer);
        if (Array.isArray(rings) && rings.length > 0) {
            rings.forEach(ring => {
                if (Array.isArray(ring) && ring.length >= 4) {
                    const latLngRing = ring
                        .map(([lng, lat]) => {
                            const latNum = Number(lat);
                            const lngNum = Number(lng);
                            if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
                                return null;
                            }
                            return [latNum, lngNum];
                        })
                        .filter(Boolean);
                    if (latLngRing.length >= 4) {
                        const closed = convertRoadPolygonToLatLngPairs(latLngRing);
                        if (closed && closed.length >= 4) {
                            results.push(closed);
                        }
                    }
                }
            });
        }
    });
    return results;
}

// Find parcels affected by the road
function findAffectedParcels(roadPolygon) {
    if (!roadPolygon || !parcelLayer) return;

    // Create a turf polygon from the road polygon
    const roadLatLngs = roadPolygon.map(p => [p.lng, p.lat]);

    // Check if we have enough points to form a valid polygon
    if (roadLatLngs.length < 4) {
        // If we don't have enough points, create a small square around the points
        const center = roadLatLngs[0];
        const offset = 0.0001; // Small offset in degrees
        roadLatLngs.length = 0; // Clear the array
        roadLatLngs.push(
            [center[0] - offset, center[1] - offset],
            [center[0] + offset, center[1] - offset],
            [center[0] + offset, center[1] + offset],
            [center[0] - offset, center[1] + offset],
            [center[0] - offset, center[1] - offset] // Close the polygon
        );
    } else {
        // Ensure the polygon is closed
        const closedRoadLatLngs = ensurePolygonIsClosed(roadLatLngs);
        if (closedRoadLatLngs.length !== roadLatLngs.length) {
            roadLatLngs.length = 0;
            roadLatLngs.push(...closedRoadLatLngs);
        }
    }

    let turfRoadPolygon;
    try {
        turfRoadPolygon = turf.polygon([roadLatLngs]);
    } catch (error) {
        // Silently return without showing error modal during mouse movement
        // Don't clear roadAffectedParcels if polygon creation fails - preserve existing data
        // But still update stats to ensure UI is consistent
        const totalArea = roadAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
        if (roadAffectedParcels.length > 0) {
            setRoadParcelStats(roadAffectedParcels.length, formatParcelArea(totalArea));
        } else {
            setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
        }
        try {
            updateRoadOwnershipCounts(roadAffectedParcels);
            updateRoadMarketPrice(roadAffectedParcels);
        } catch (err) {
            console.warn('road stats: failed to update after polygon creation error', err);
        }
        return;
    }

    // Clear previously affected parcels only after we have a valid polygon
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = PersistentStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }

    roadAffectedParcels = [];

    // Get current map bounds for filtering
    const mapBounds = map.getBounds();

    // Check each parcel for intersection, but only if visible in the current view
    parcelLayer.eachLayer(layer => {
        // Skip parcels outside the current map view for performance
        try {
            const layerBounds = layer.getBounds();
            if (!mapBounds.intersects(layerBounds)) {
                return; // Skip parcels outside view
            }
        } catch (e) {
            // Some layers might not have bounds, continue anyway
        }

        const parcelId = layer.feature.properties.CESTICA_ID;
        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfRoadPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;

                    roadAffectedParcels.push({
                        id: parcelId,
                        number: layer.feature.properties.BROJ_CESTICE,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice,
                        layer: layer
                    });

                    layer.setStyle({
                        fillColor: 'green',
                        fillOpacity: 0.6,
                        color: 'green',
                        weight: 3
                    });

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    // Always update UI with the parcels count/area
    const totalArea = roadAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    if (roadAffectedParcels.length > 0) {
        setRoadParcelStats(roadAffectedParcels.length, formatParcelArea(totalArea));
    } else {
        setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
    }
    try {
        updateRoadOwnershipCounts(roadAffectedParcels);
        updateRoadMarketPrice(roadAffectedParcels);
    } catch (err) {
        console.warn('road ownership: failed to update stats', err);
    }
}

// Update road info panel with current metrics (works for both roads and tracks)
function updateRoadInfoPanel() {
    // Check if road or track has started
    const isRoadMode = roadHasStarted && !trackDrawingMode;
    const isTrackMode = trackHasStarted && trackDrawingMode;

    if (!isRoadMode && !isTrackMode) return;

    // Make sure the road info panel exists
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (!roadInfoPanel) {
        console.error('Road info panel element not found');
        return; // Exit early if the panel doesn't exist
    }
    if (!roadInfoPanel.classList.contains('visible')) {
        roadInfoPanel.style.removeProperty('display');
        roadInfoPanel.classList.add('visible');
    }

    resetRoadMetricPlaceholders();

    // Determine which points and width to use
    const points = isTrackMode ? trackPoints : roadPoints;
    const width = isTrackMode ? trackWidth : roadWidth;
    const affectedParcels = isTrackMode ? trackAffectedParcels : roadAffectedParcels;

    // Only try to calculate metrics if we have at least 2 points
    if (points.length >= 2) {
        // Calculate metrics for the current road/track
        const polygon = calculateRoadPolygon(points, width);
        if (polygon) {
            updateRoadInfoWithPreview(points, polygon, affectedParcels);
        }
    } else {
        // For the initial point, just show basic info
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        setRoadParcelStats(0, '—');
    }
}

// Update road info with preview metrics (works for both roads and tracks)
function updateRoadInfoWithPreview(points, polygon, affectedParcelsToUse = null) {
    if (!points || points.length < 2) {
        // Basic initialization of the road info panel when not enough points
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        return;
    }

    try {
        // Calculate road length in meters
        let length = 0;
        const htrsPoints = [];

        // Convert and validate each point
        for (const p of points) {
            if (!p || !isFinite(p.lat) || !isFinite(p.lng)) {
                console.warn('Invalid point in updateRoadInfoWithPreview:', p);
                continue;
            }
            try {
                const htrsPoint = wgs84ToHTRS96(p.lat, p.lng);
                if (isValidPoint(htrsPoint)) {
                    htrsPoints.push(htrsPoint);
                }
            } catch (error) {
                console.error('Error converting point in updateRoadInfoWithPreview:', error);
            }
        }

        // Calculate length only if we have enough valid points
        if (htrsPoints.length >= 2) {
            for (let i = 0; i < htrsPoints.length - 1; i++) {
                const p1 = htrsPoints[i];
                const p2 = htrsPoints[i + 1];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                length += Math.sqrt(dx * dx + dy * dy);
            }
        } else {
            console.warn('Not enough valid points to calculate length');
            length = 0;
        }

        // Calculate road area
        let area = 0;
        if (polygon && polygon.length > 2) {
            try {
                // Convert polygon to turf polygon format
                const turfFormat = polygon.map(p => [p.lng, p.lat]);
                // Make sure it's a closed polygon
                const closedTurfFormat = ensurePolygonIsClosed(turfFormat);

                // Create the turf polygon
                const turfPolygon = turf.polygon([closedTurfFormat]);
                area = turf.area(turfPolygon);
            } catch (error) {
                console.error('Error calculating area in updateRoadInfoWithPreview:', error);
                area = 0;
            }
        }

        // Update info panel - safely access each element
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        // Only update elements if they exist
        if (roadLengthElement) {
            roadLengthElement.textContent = `${length.toFixed(1)} m`;
        }

        if (roadAreaElement) {
            roadAreaElement.textContent = `${area.toFixed(1)} m²`;
        }

        // Update parcel stats if affected parcels are provided
        if (affectedParcelsToUse && Array.isArray(affectedParcelsToUse)) {
            const totalArea = affectedParcelsToUse.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
            if (affectedParcelsToUse.length > 0) {
                setRoadParcelStats(affectedParcelsToUse.length, formatParcelArea(totalArea));
            } else {
                setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
            }
            try {
                updateRoadOwnershipCounts(affectedParcelsToUse);
                updateRoadMarketPrice(affectedParcelsToUse);
                updateRoadAcquiringDifficulty(affectedParcelsToUse);
            } catch (err) {
                console.warn('road/track stats: failed to update ownership/market price', err);
            }
        }
    } catch (error) {
        console.error('Error in updateRoadInfoWithPreview:', error);
    }
}

// Function to show polygon error details in a modal
function showPolygonErrorModal(error, polygon) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('polygon-error-modal');

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'polygon-error-modal';
        modal.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

        document.body.appendChild(modal);
    }

    // Format polygon points for display
    const pointsTable = polygon.map((p, i) =>
        `<tr>
                    <td>${i}</td>
                    <td>${p.lat.toFixed(6)}</td>
                    <td>${p.lng.toFixed(6)}</td>
                </tr>`
    ).join('');

    // Diagnose common polygon issues
    let diagnosticMessages = [];

    // Check if polygon is closed
    if (polygon.length > 1) {
        const firstPoint = polygon[0];
        const lastPoint = polygon[polygon.length - 1];

        if (firstPoint.lat !== lastPoint.lat || firstPoint.lng !== lastPoint.lng) {
            diagnosticMessages.push(`Polygon is not closed: first point [${firstPoint.lat.toFixed(6)}, ${firstPoint.lng.toFixed(6)}] 
                        is different from last point [${lastPoint.lat.toFixed(6)}, ${lastPoint.lng.toFixed(6)}]`);
        }
    }

    // Check for minimum points
    if (polygon.length < 4) {
        diagnosticMessages.push(`Polygon has only ${polygon.length} points, minimum 4 required.`);
    }

    // Look for duplicate consecutive points
    for (let i = 0; i < polygon.length - 1; i++) {
        const p1 = polygon[i];
        const p2 = polygon[i + 1];

        if (p1.lat === p2.lat && p1.lng === p2.lng) {
            diagnosticMessages.push(`Duplicate consecutive points found at index ${i} and ${i + 1}`);
        }
    }

    // Create content
    modal.innerHTML = `
                <div style="
                    background-color: white;
                    padding: 20px;
                    border-radius: 5px;
                    max-width: 80%;
                    max-height: 80%;
                    overflow: auto;
                ">
                    <h2 style="color: #d9534f;">Polygon Error</h2>
                    <p><strong>Error:</strong> ${error.message}</p>
                    <p><strong>Polygon Information:</strong></p>
                    <p>Number of points: ${polygon.length}</p>
                    
                    ${diagnosticMessages.length > 0 ? `
                        <div style="margin: 15px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                            <h4 style="margin-top: 0; color: #856404;">Diagnostic Information</h4>
                            <ul style="margin-bottom: 0;">
                                ${diagnosticMessages.map(msg => `<li>${msg}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 15px;">
                        <table style="border-collapse: collapse; width: 100%;">
                            <thead>
                                <tr style="background-color: #f8f9fa;">
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Point #</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Latitude</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Longitude</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pointsTable}
                            </tbody>
                        </table>
                    </div>
                    
                    <div style="margin-top: 20px; display: flex; justify-content: space-between;">
                        <button onclick="showPolygonOnMap(${JSON.stringify(polygon).replace(/"/g, '&quot;')});"
                                style="padding: 8px 16px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Show on Map
                        </button>
                        <button onclick="document.getElementById('polygon-error-modal').remove();"
                                style="padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Close
                        </button>
                    </div>
                </div>
            `;
}

// Function to visualize the problematic polygon on the map
function showPolygonOnMap(points) {
    // Clear any existing highlighted polygon
    if (window.errorPolygonLayer) {
        map.removeLayer(window.errorPolygonLayer);
    }

    if (window.errorPointsLayer) {
        map.removeLayer(window.errorPointsLayer);
    }

    // Create a polygon from the points
    window.errorPolygonLayer = L.polygon(points, {
        color: 'red',
        weight: 2,
        fillColor: 'red',
        fillOpacity: 0.2
    }).addTo(map);

    // Add markers for each point
    window.errorPointsLayer = L.featureGroup();

    points.forEach((point, index) => {
        const marker = L.circleMarker([point.lat, point.lng], {
            radius: 5,
            color: 'black',
            fillColor: index === 0 ? 'green' : (index === points.length - 1 ? 'red' : 'blue'),
            fillOpacity: 1,
            weight: 2
        }).bindTooltip(`Point ${index}: [${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}]`);

        window.errorPointsLayer.addLayer(marker);
    });

    window.errorPointsLayer.addTo(map);

    // Fit bounds to the polygon
    map.fitBounds(window.errorPolygonLayer.getBounds(), {
        padding: [50, 50]
    });

    // Close the modal
    document.getElementById('polygon-error-modal').remove();
}

// Update the road preview
function updateRoadPreview() {
    // Remove any existing preview
    if (roadPreviewPolygon) {
        map.removeLayer(roadPreviewPolygon);
        roadPreviewPolygon = null;
    }

    if (roadPoints.length < 2) return;

    // Calculate and draw road polygon
    const roadPolygonPoints = calculateRoadPolygon(roadPoints, roadWidth);
    if (roadPolygonPoints) {
        roadPreviewPolygon = L.polygon(roadPolygonPoints, {
            color: 'green',
            weight: 2,
            fillColor: 'green',
            fillOpacity: 0.3
        }).addTo(map);

        // Find affected parcels
        findAffectedParcels(roadPolygonPoints);
    }
}

// Unified finish function for road or track drawing
function finishRoadOrTrackDrawing() {
    if (trackDrawingMode) {
        finishTrackDrawing();
    } else if (roadDrawingMode) {
        finishRoadDrawing();
    }
}

// Unified cancel function for road or track drawing
function cancelRoadOrTrackDrawing() {
    if (trackDrawingMode) {
        cancelTrackDrawing();
    } else if (roadDrawingMode) {
        cancelRoadDrawing();
    }
}

// Function to finish road drawing
async function finishRoadDrawing() {
    if (!roadHasStarted || roadPoints.length < 2) return;

    // Immediately stop interactions and preview while finishing
    suspendRoadDrawingInteractivity();
    stopRoadPreviewTracking();

    const roadPolygon = calculateRoadPolygon(roadPoints, roadWidth);
    if (!roadPolygon) {
        showRoadAlert('invalid_road_shape_please_try_drawing_the_road_again', 'Invalid road shape. Please try drawing the road again.');
        exitRoadDrawingMode();
        return;
    }

    const affectedParcels = roadAffectedParcels;
    if (affectedParcels.length === 0) {
        showRoadAlert('no_parcels_affected_by_this_road_please_try_drawing_the_road_again', 'No parcels affected by this road. Please try drawing the road again.');
        exitRoadDrawingMode();
        return;
    }

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = generateRandomRoadName();
    const defaultOffer = generateRandomRoadOffer();

    let modalResult;
    try {
        modalResult = await showRoadProposalModal({
            defaultAuthor,
            defaultName,
            defaultOffer,
            affectedParcels,
            roadPolygon: roadPolygon
        });
    } catch (_) {
        // User cancelled the modal; keep drawing state intact
        exitRoadDrawingMode();
        return;
    }

    const roadNameInput = (modalResult?.roadName || '').trim();
    const authorInput = (modalResult?.author || '').trim();
    const descriptionInput = (modalResult?.description || '').trim();
    const offerInputValue = typeof modalResult?.offer === 'number' ? modalResult.offer : NaN;
    const formState = modalResult?.form || {};
    const ownershipAndAcquisitionStats = modalResult?.ownershipAndAcquisitionStats || null;

    const finalRoadName = roadNameInput || defaultName;
    const finalAuthor = authorInput || defaultAuthor || 'User';
    const finalOffer = Number.isFinite(offerInputValue) && offerInputValue > 0 ? offerInputValue : defaultOffer;
    const finalDescription = descriptionInput || finalRoadName;

    // --- Create a Proposal ---
    // 1. Get the full GeoJSON features of parent parcels
    const parentFeatures = affectedParcels.map(p => {
        // We need a deep copy so the original features in parcelLayer are not mutated
        return JSON.parse(JSON.stringify(p.layer.feature));
    });

    // 2. Create the proposal
    const proposalApi = (typeof Proposals !== 'undefined' && Proposals.manager) ? Proposals.manager : ProposalManager;
    const proposalMetadata = {
        author: finalAuthor,
        offer: finalOffer,
        description: finalDescription
    };
    if (ownershipAndAcquisitionStats) {
        proposalMetadata.ownershipAndAcquisitionStats = ownershipAndAcquisitionStats;
    }
    const proposal = proposalApi.createProposal({
        name: finalRoadName,
        type: 'road',
        definition: {
            points: roadPoints,
            width: roadWidth,
            metadata: proposalMetadata
        },
        parentFeatures: parentFeatures,
        author: finalAuthor,
        description: finalDescription,
        offer: finalOffer,
        budget: finalOffer
    });

    if (proposal && proposal.onchain) {
        parentFeatures.forEach(feature => {
            if (!feature || !feature.properties) return;
            feature.properties.onchainProposal = { ...proposal.onchain };
        });
    }

    // 3. Apply the proposal to the map
    if (!proposal || !proposal.proposalHash) {
        if (typeof showEphemeralMessage === 'function') {
            const message = translateRoadText(
                'ephemeral.messages.road_proposal_already_exists_or_could_not_be_saved_review_proposals_for_details',
                'Road proposal already exists or could not be saved. Review proposals for details.'
            );
            showEphemeralMessage(message, 6000, 'error');
        }
        if (typeof updateStatus === 'function') {
            updateStatus('Review proposal before applying.');
        }
        if (typeof enableShowProposalsMode === 'function') {
            enableShowProposalsMode();
        }
        if (typeof showAllProposalsModal === 'function') {
            setTimeout(() => {
                try { showAllProposalsModal(); } catch (err) { console.warn('Failed to open proposals modal', err); }
            }, 50);
        }
        exitRoadDrawingMode();
        return;
    }

    let onchainResult = null;
    const walletState = window.walletManager && typeof window.walletManager.getState === 'function'
        ? window.walletManager.getState()
        : null;
    const isWalletConnected = walletState && walletState.status === 'connected' && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
    const shouldMintOnchain = typeof window.ProposalChainBridge !== 'undefined'
        && window.ProposalChainBridge.isSupported()
        && isWalletConnected
        && proposal?.parentFeatures?.length;

    const screenshotPolygonForMint = convertRoadPolygonToLatLngPairs(roadPolygon);
    const parcelPolygonsForMint = buildParcelPolygonLatLngs(affectedParcels);

    if (shouldMintOnchain) {
        try {
            const ids = proposal.parentFeatures
                .map(feature => window.ProposalChainBridge.deriveParcelIdFromFeature(feature))
                .filter(Boolean);

            if (!ids.length) {
                console.warn('No parcel IDs could be derived for on-chain minting.');
            } else {
                if (!window.MapScreenshot || typeof window.MapScreenshot.capturePolygonImage !== 'function') {
                    throw new Error('Map screenshot capture is not available.');
                }
                if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                    throw new Error('Asset upload service is not available.');
                }
                if (!screenshotPolygonForMint || screenshotPolygonForMint.length < 3) {
                    throw new Error('Unable to derive proposal polygon for NFT metadata.');
                }

                let assetUploadResult = null;
                let metadataUri = '';

                try {
                    const screenshotDataUrl = await window.MapScreenshot.capturePolygonImage({
                        polygon: screenshotPolygonForMint,
                        parcelPolygons: parcelPolygonsForMint,
                        padding: 0.05,
                        size: 600
                    });

                    const ethAmountValue = formState.ethAmount !== undefined && formState.ethAmount !== null
                        ? Number(formState.ethAmount)
                        : null;

                    const metadataPayload = {
                        name: finalRoadName,
                        description: finalDescription,
                        image: '', // populated after image upload
                        attributes: [
                            {
                                trait_type: 'Proposal Type',
                                value: 'Road'
                            },
                            {
                                trait_type: 'Conditional',
                                value: Boolean(formState.isConditional) ? 'Yes' : 'No'
                            },
                            {
                                trait_type: 'Parcel Count',
                                value: ids.length
                            },
                            {
                                trait_type: 'Road Width (m)',
                                value: Number.isFinite(roadWidth) ? Number(roadWidth).toFixed(2) : 'N/A'
                            }
                        ],
                        properties: {
                            parcelIds: ids,
                            conditional: Boolean(formState.isConditional),
                            ethAmount: ethAmountValue,
                            createdAt: new Date().toISOString(),
                            proposalHash: proposal.proposalHash || null
                        }
                    };

                    const fileNameBase = proposal.proposalHash || proposal.id || `road-proposal-${Date.now()}`;
                    assetUploadResult = await window.AssetService.uploadProposalAssets({
                        imageData: screenshotDataUrl,
                        metadata: metadataPayload,
                        fileName: `${fileNameBase}.png`
                    });
                    metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
                    console.log('Asset upload result:', {
                        metadataUri,
                        metadataGatewayUrl: assetUploadResult?.metadataGatewayUrl,
                        imageUri: assetUploadResult?.imageUri,
                        imageGatewayUrl: assetUploadResult?.imageGatewayUrl
                    });
                    if (!metadataUri) {
                        throw new Error('Metadata URI missing from asset upload response.');
                    }
                } catch (assetError) {
                    console.error('Failed to prepare proposal assets for on-chain minting:', assetError);
                    throw assetError instanceof Error ? assetError : new Error('Failed to prepare assets for on-chain minting.');
                }

                const lensEntriesForMint = (typeof getProposalLensEntries === 'function')
                    ? getProposalLensEntries(proposal || {}, { fallbackToGlobal: true })
                    : (typeof getLensEntries === 'function' ? getLensEntries() : []);
                const lensAddressesForMint = (lensEntriesForMint || [])
                    .filter(entry => entry && entry.address && entry.address.trim())
                    .map(entry => entry.address.trim());
                if (!lensAddressesForMint.length) {
                    throw new Error('Cannot mint proposal: lens list is empty. Set your lens before minting.');
                }

                onchainResult = await window.ProposalChainBridge.mintRoadProposal({
                    parcelIds: ids,
                    isConditional: Boolean(formState.isConditional),
                    ethAmount: formState.ethAmount,
                    tokenAmount: 0n,
                    imageURI: metadataUri,
                    lens: lensAddressesForMint
                });

                proposal.onchain = {
                    transactionHash: onchainResult.transactionHash,
                    proposalId: onchainResult.proposalId,
                    chainId: onchainResult.chainId,
                    contractAddress: onchainResult.contractAddress,
                    metadataUri,
                    metadataUrl: assetUploadResult?.metadataGatewayUrl || null,
                    imageUri: assetUploadResult?.imageUri || null,
                    imageUrl: assetUploadResult?.imageGatewayUrl || null
                };

                if (proposal.proposalHash && typeof proposalStorage !== 'undefined') {
                    const stored = proposalStorage.getProposal(proposal.proposalHash);
                    if (stored) {
                        stored.onchain = { ...proposal.onchain };
                        stored.proposalId = stored.proposalId || stored.proposalHash;
                        if (typeof proposalStorage._indexProposal === 'function') {
                            proposalStorage._indexProposal(stored);
                        } else {
                            proposalStorage.proposals.set(stored.proposalId, stored);
                        }
                        if (typeof proposalStorage.save === 'function') {
                            proposalStorage.save();
                        }
                    }
                }
            }
        } catch (error) {
            console.error('On-chain mint failed:', error);
            if (typeof showEphemeralMessage === 'function') {
                const message = translateRoadText(
                    'ephemeral.messages.onchain_proposal_mint_failed_with_reason',
                    'On-chain proposal mint failed: {{error}}.',
                    { error: error?.message || translateRoadText('ephemeral.messages.onchain_proposal_mint_failed', 'On-chain proposal mint failed.') }
                );
                showEphemeralMessage(message, 6000, 'error');
            }
        }

        if (!onchainResult) {
            // Keep the locally created proposal when minting fails (e.g., wallet not connected)
            if (proposal.proposalHash && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const stored = proposalStorage.getProposal(proposal.proposalHash);
                if (stored) {
                    stored.isMinted = false;
                    stored.onchain = null;
                    if (typeof proposalStorage.save === 'function') {
                        try { proposalStorage.save(); } catch (err) { console.warn('Failed to persist local-only road proposal after mint failure', err); }
                    }
                }
            }
        }
    }

    // 3. Proposal is created but NOT auto-applied
    // Application will happen either through acceptance of all parcel owners or via "Apply to map" button
    // 4. Clean up the road drawing UI and exit drawing mode
    exitRoadDrawingMode();

    // 5. Show the newly created proposal details with full highlighting and focusing
    try {
        let hydratedProposal = proposal;
        if (proposal && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
            const lookupKey = proposal.proposalHash || proposal.proposalId || proposal.id;
            const stored = lookupKey ? proposalStorage.getProposal(lookupKey) : null;
            if (stored) {
                hydratedProposal = stored;
            } else if (!proposal.parcelIds && Array.isArray(proposal.parentFeatures)) {
                // Fallback: derive parcelIds from parent features if storage lookup failed
                hydratedProposal = { ...proposal, parcelIds: proposal.parentFeatures.map(f => f?.properties?.CESTICA_ID).filter(Boolean) };
            }
        }

        // Use selectAndHighlightProposal to get full highlighting and focusing behavior
        if (typeof selectAndHighlightProposal === 'function') {
            const proposalIdOrHash = hydratedProposal.proposalHash || hydratedProposal.proposalId || hydratedProposal.id;
            const parcelIds = Array.isArray(hydratedProposal.parcelIds) ? hydratedProposal.parcelIds : [];
            const focusParcelId = parcelIds.length > 0 ? parcelIds[0] : null;
            selectAndHighlightProposal(proposalIdOrHash, focusParcelId, true, true);
        } else if (typeof showProposalInfo === 'function') {
            // Fallback to showProposalInfo if selectAndHighlightProposal is not available
            showProposalInfo(hydratedProposal);
        }
    } catch (err) {
        console.warn('Unable to show proposal details after creation', err);
    }

    updateStatus(`Road proposal "${finalRoadName}" created and applied.`);
}

// Cancel road drawing
function cancelRoadDrawing() {
    // Re-enable buttons if they were disabled
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');
    if (finishRoadButton) finishRoadButton.disabled = false;
    if (cancelRoadButton) cancelRoadButton.disabled = false;

    // Clean up road name input and create button if they exist
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        const roadNameSection = document.getElementById('road-name-section');
        const createButtonSection = document.getElementById('road-create-button-section');

        if (roadNameSection) roadInfoPanel.removeChild(roadNameSection);
        if (createButtonSection) roadInfoPanel.removeChild(createButtonSection);
    }

    resetRoadDrawing();
    toggleRoadDrawTool();
}

// Reset road drawing variables and state
function resetRoadDrawing(hidePanel = true) {
    roadPoints = [];
    roadWidth = 2;
    roadHasStarted = false;
    // Clear affected parcels highlighting BEFORE clearing the array
    clearAffectedParcels();
    roadOwnershipTypeCache.clear();
    roadOwnershipStatsRequestId++;

    // Clear any existing road layers
    if (roadCenterline) {
        map.removeLayer(roadCenterline);
        roadCenterline = null;
    }

    // Correctly remove the committed road preview layer (roadPolygonLayer)
    // The global 'roadPolygon' variable stores geometry, not the layer itself.
    if (roadPolygonLayer && map.hasLayer(roadPolygonLayer)) {
        map.removeLayer(roadPolygonLayer);
        roadPolygonLayer = null;
    }
    roadPolygon = null; // Also clear the geometry variable

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }

    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Remove any road markers
    for (const marker of roadMarkers) {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    }
    roadMarkers = [];

    // Hide road info panel if requested
    if (hidePanel) {
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) {
            roadInfoPanel.classList.remove('visible');
            roadInfoPanel.style.removeProperty('display');
        }
    }

    // Affected parcels highlighting already cleared at the start of this function
    resetRoadMetricPlaceholders();
}

// Add a helper function to clear affected parcels
function clearAffectedParcels() {
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = PersistentStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }
    roadAffectedParcels = [];
}

// Helper function to clear highlighting for preview-affected parcels
function clearPreviewAffectedParcels() {
    if (roadPreviewAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            const parcelId = layer.feature.properties.CESTICA_ID;
            // Check if this layer was part of the last preview
            if (roadPreviewAffectedParcels.some(p => p.id === parcelId)) {
                // Check if it's also part of the *committed* affected parcels
                if (roadAffectedParcels.some(p => p.id === parcelId)) {
                    // It's committed, revert to committed style (green)
                    layer.setStyle({
                        fillColor: 'green',
                        fillOpacity: 0.6,
                        color: 'green',
                        weight: 3
                    });
                } else {
                    // Not committed, revert to its base style
                    const isMarkedAsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    layer.setStyle(isMarkedAsRoad ? roadStyle : normalStyle);
                }
            }
        });
    }
    roadPreviewAffectedParcels = []; // Clear the preview list
    // Update UI to reflect preview cleared; fall back to committed count if any
    try {
        if (roadAffectedParcels.length > 0) {
            const totalArea = roadAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
            setRoadParcelStats(roadAffectedParcels.length, formatParcelArea(totalArea));
        } else {
            setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
        }

        // Update ownership stats with committed parcels only (preview cleared)
        updateRoadOwnershipCounts(roadAffectedParcels).catch(err => {
            console.warn('road ownership: failed to update stats after preview clear', err);
        });

        // Update market price with committed parcels only (preview cleared)
        updateRoadMarketPrice(roadAffectedParcels);
    } catch (err) {
        console.warn('road stats: failed to update after preview clear', err);
    }
}

function generateRandomRoadName() {
    const prefixes = ['Liberty', 'Oak', 'Maple', 'Harbor', 'Sunset', 'Riverside', 'Heritage', 'Unity', 'Cedar', 'Willow', 'Silver', 'Golden', 'Evergreen', 'Aurora', 'Lakeside'];
    const suffixes = ['Avenue', 'Boulevard', 'Road', 'Way', 'Street', 'Drive', 'Lane', 'Terrace', 'Parkway', 'Trail', 'Route'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || 'New';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] || 'Road';
    return `${prefix} ${suffix}`;
}

function generateRandomTrackName() {
    const prefixes = ['Main', 'Central', 'Northern', 'Southern', 'Eastern', 'Western', 'Coastal', 'Mountain', 'Valley', 'Highland', 'Express', 'Regional', 'Local', 'Industrial', 'Freight'];
    const suffixes = ['Railway', 'Rail Line', 'Track', 'Railroad', 'Railway Line', 'Rail Corridor', 'Train Line', 'Rail Route'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || 'Main';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] || 'Railway';
    return `${prefix} ${suffix}`;
}

function generateRandomRoadOffer(min = 10000, max = 500000) {
    if (!isFinite(min) || !isFinite(max) || max <= min) {
        min = 10000;
        max = 500000;
    }
    const random = Math.random();
    const value = min + random * (max - min);
    // Round to nearest 1,000 for cleaner numbers
    return Math.round(value / 1000) * 1000;
}

function showRoadProposalModal({ defaultAuthor = '', defaultName = 'New Road', defaultOffer = 10000, affectedParcels = [], roadPolygon = null } = {}) {
    return new Promise((resolve, reject) => {
        try {
            if (typeof closeProposalDialog === 'function') {
                closeProposalDialog();
            }
        } catch (_) { }

        const existingModal = document.querySelector('.create-proposal-modal');
        if (existingModal) {
            try { existingModal.remove(); } catch (_) { }
        }

        const totalArea = affectedParcels.reduce((sum, parcel) => sum + (parcel?.area || 0), 0);

        const modal = document.createElement('div');
        modal.className = 'create-proposal-modal road-proposal-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const parcelItems = affectedParcels.map(parcel => {
            const parcelNumber = parcel?.number || parcel?.id || 'Unknown';
            const area = parcel?.area || 0;
            return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${parcelNumber}</span><span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span></div>`;
        }).join('');

        const screenshotPolygon = convertRoadPolygonToLatLngPairs(roadPolygon);

        // Fallback to the Leaflet polygon layer if needed
        if ((!screenshotPolygon || screenshotPolygon.length < 3) && roadPolygonLayer && typeof roadPolygonLayer.getLatLngs === 'function') {
            const latLngs = roadPolygonLayer.getLatLngs();
            const primaryRing = Array.isArray(latLngs) && latLngs.length > 0
                ? (Array.isArray(latLngs[0]) ? latLngs[0] : latLngs)
                : [];
            screenshotPolygon = primaryRing
                .map(latlng => {
                    if (latlng && typeof latlng.lat === 'number' && typeof latlng.lng === 'number') {
                        return [latlng.lat, latlng.lng];
                    }
                    return null;
                })
                .filter(Boolean);
        }

        // Derive bounds primarily for logging/fallback contexts
        let screenshotBounds = null;
        if (roadPolygonLayer && typeof roadPolygonLayer.getBounds === 'function') {
            screenshotBounds = roadPolygonLayer.getBounds();
        } else if (screenshotPolygon && screenshotPolygon.length >= 3 && typeof L !== 'undefined') {
            try {
                const latLngs = screenshotPolygon
                    .map(coord => Array.isArray(coord) && coord.length >= 2 ? L.latLng(coord[0], coord[1]) : null)
                    .filter(Boolean);
                if (latLngs.length) {
                    screenshotBounds = L.latLngBounds(latLngs);
                }
            } catch (error) {
                console.warn('Failed to calculate screenshot bounds from polygon:', error);
            }
        }

        if (screenshotBounds) {
            console.log('Screenshot bounds:', {
                source: roadPolygonLayer ? 'roadPolygonLayer' : 'roadPolygon',
                bounds: screenshotBounds.toBBoxString(),
                isValid: screenshotBounds.isValid()
            });
        }

        if (screenshotPolygon && screenshotPolygon.length >= 3) {
            const sample = screenshotPolygon.slice(0, Math.min(8, screenshotPolygon.length)).map(pt => {
                if (Array.isArray(pt) && pt.length >= 2) {
                    return `${pt[0].toFixed(8)}, ${pt[1].toFixed(8)}`;
                }
                if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number') {
                    return `${pt.lat.toFixed(8)}, ${pt.lng.toFixed(8)}`;
                }
                return pt;
            });
            console.log('Screenshot polygon sample (lat,lng):', sample);
        }

        const computedParcelPolygons = buildParcelPolygonLatLngs(affectedParcels);

        // Collect ownership and acquisition stats
        const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

        // Build stats HTML if stats exist
        let statsHtml = '';
        if (ownershipAndAcquisitionStats) {
            const stats = ownershipAndAcquisitionStats;
            const statsItems = [];

            if (stats.individualOwners !== null) {
                statsItems.push(`<p><strong>Individual Owners:</strong> ${stats.individualOwners}</p>`);
            }
            if (stats.ownershipCounts.individual !== null) {
                statsItems.push(`<p><strong>Owned by Individuals:</strong> ${stats.ownershipCounts.individual}</p>`);
            }
            if (stats.ownershipCounts.company !== null) {
                statsItems.push(`<p><strong>Owned by Companies:</strong> ${stats.ownershipCounts.company}</p>`);
            }
            if (stats.ownershipCounts.government !== null) {
                statsItems.push(`<p><strong>Owned by Government:</strong> ${stats.ownershipCounts.government}</p>`);
            }
            if (stats.ownershipCounts.institution !== null) {
                statsItems.push(`<p><strong>Owned by Institution:</strong> ${stats.ownershipCounts.institution}</p>`);
            }
            if (stats.ownershipCounts.mixed !== null) {
                statsItems.push(`<p><strong>Ownership Mixed:</strong> ${stats.ownershipCounts.mixed}</p>`);
            }
            if (stats.totalMarketPrice !== null) {
                statsItems.push(`<p><strong>Total Market Price:</strong> ${Math.round(stats.totalMarketPrice).toLocaleString('hr-HR')} EUR</p>`);
            }
            if (stats.totalAcquiringDifficulty !== null) {
                statsItems.push(`<p><strong>Total Acquiring Difficulty:</strong> ${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</p>`);
            }

            if (statsItems.length > 0) {
                statsHtml = `
                    <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
                    <div class="proposal-stats-section">
                        <h4 style="margin-bottom: 10px;">Ownership & Acquisition Stats</h4>
                        <div class="summary-stats">
                            ${statsItems.join('')}
                        </div>
                    </div>
                `;
            }
        }

        modal.innerHTML = `
            <div class="proposal-modal-content">
                <div class="proposal-modal-header">
                    <h2>Create Road Proposal</h2>
                    <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close">&times;</button>
                </div>
                <div class="proposal-modal-body">
                    ${(screenshotPolygon && screenshotPolygon.length >= 3) ? '<div class="form-group" id="roadProposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                    <div class="form-group">
                        <label for="roadProposalAuthor">Author:</label>
                        <input type="text" id="roadProposalAuthor" placeholder="Your name">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalName">Road Name:</label>
                        <input type="text" id="roadProposalName" placeholder="e.g. Sunset Boulevard">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalOffer">Offer (EUR):</label>
                        <input type="number" id="roadProposalOffer" min="0" step="1000" placeholder="0">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalDescription">Description:</label>
                        <textarea id="roadProposalDescription" rows="3" placeholder="Describe your road proposal..."></textarea>
                    </div>
                    <div class="proposal-summary">
                        <div class="summary-stats">
                            <p><strong>Parcels Affected:</strong> ${affectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Affected Parcels:</h4>
                            ${parcelItems || '<div class="proposal-parcel-item">No parcels detected.</div>'}
                        </div>
                    </div>
                    ${statsHtml}
                </div>
                <div class="proposal-modal-footer">
                    <button type="button" class="btn btn-proposal" id="roadProposalConfirmBtn">Create Proposal</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const authorInput = modal.querySelector('#roadProposalAuthor');
        const nameInput = modal.querySelector('#roadProposalName');
        const offerInput = modal.querySelector('#roadProposalOffer');
        const descriptionInput = modal.querySelector('#roadProposalDescription');
        const confirmButton = modal.querySelector('#roadProposalConfirmBtn');
        const closeButton = modal.querySelector('.proposal-modal-close');

        if (authorInput) authorInput.value = defaultAuthor || '';
        if (nameInput) nameInput.value = defaultName;
        if (offerInput) offerInput.value = Number.isFinite(defaultOffer) ? defaultOffer : '';

        const cleanup = () => {
            modal.removeEventListener('keydown', handleKeyDown, true);
            if (confirmButton) confirmButton.removeEventListener('click', handleSubmit);
            if (closeButton) closeButton.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        };

        const handleCancel = () => {
            cleanup();
            reject(new Error('cancelled'));
        };

        const handleSubmit = () => {
            const nameValue = (nameInput?.value || '').trim() || defaultName;
            const authorValue = (authorInput?.value || '').trim() || defaultAuthor || 'User';
            const descriptionValue = (descriptionInput?.value || '').trim();
            const offerValueRaw = offerInput ? parseFloat(offerInput.value) : NaN;
            const offerValue = Number.isFinite(offerValueRaw) && offerValueRaw > 0 ? offerValueRaw : defaultOffer;

            if (offerInput) offerInput.value = offerValue;
            if (nameInput) nameInput.value = nameValue;

            cleanup();
            resolve({
                roadName: nameValue,
                author: authorValue,
                description: descriptionValue,
                offer: offerValue,
                ownershipAndAcquisitionStats: ownershipAndAcquisitionStats,
                form: {
                    ethAmount: offerValue,
                    isConditional: true
                }
            });
        };

        const handleOverlayClick = (event) => {
            if (event.target === modal) {
                handleCancel();
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                handleSubmit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                handleCancel();
            }
        };

        modal.addEventListener('keydown', handleKeyDown, true);
        modal.addEventListener('click', handleOverlayClick);

        if (confirmButton) confirmButton.addEventListener('click', handleSubmit);
        if (closeButton) closeButton.addEventListener('click', handleCancel);

        // Capture and display screenshot if bounds are available
        if (screenshotPolygon && screenshotPolygon.length >= 3 && window.MapScreenshot) {
            const screenshotContainer = modal.querySelector('#roadProposalScreenshotContainer');
            if (screenshotContainer) {
                (async () => {
                    try {
                        const previewWrapper = document.createElement('div');
                        previewWrapper.className = 'map-screenshot-container';
                        previewWrapper.style.margin = '0 auto';
                        screenshotContainer.appendChild(previewWrapper);

                        window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                            polygon: screenshotPolygon,
                            bounds: screenshotBounds,
                            padding: 0.05,
                            parcelPolygons: computedParcelPolygons
                        });
                    } catch (error) {
                        console.warn('Failed to capture map screenshot:', error);
                        screenshotContainer.innerHTML = '';
                        const fallbackDiv = document.createElement('div');
                        fallbackDiv.className = 'map-screenshot-container';
                        fallbackDiv.style.color = '#999';
                        fallbackDiv.textContent = 'Preview unavailable';
                        screenshotContainer.appendChild(fallbackDiv);
                    }
                })();
            }
        }

        requestAnimationFrame(() => {
            if (nameInput) {
                nameInput.focus();
                nameInput.select();
            }
        });
    });
}

function showTrackProposalModal({ defaultAuthor = '', defaultName = 'New Track', defaultOffer = 10000, affectedParcels = [], trackPolygon = null, trackSpeed = 120, trackMinRadius = 1000, trackWidth = 3.0 } = {}) {
    return new Promise((resolve, reject) => {
        try {
            if (typeof closeProposalDialog === 'function') {
                closeProposalDialog();
            }
        } catch (_) { }

        const existingModal = document.querySelector('.create-proposal-modal');
        if (existingModal) {
            try { existingModal.remove(); } catch (_) { }
        }

        const totalArea = affectedParcels.reduce((sum, parcel) => sum + (parcel?.area || 0), 0);

        const modal = document.createElement('div');
        modal.className = 'create-proposal-modal track-proposal-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const parcelItems = affectedParcels.map(parcel => {
            const parcelNumber = parcel?.number || parcel?.id || 'Unknown';
            const area = parcel?.area || 0;
            return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${parcelNumber}</span><span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span></div>`;
        }).join('');

        const screenshotPolygon = convertRoadPolygonToLatLngPairs(trackPolygon);

        // Fallback to the Leaflet polygon layer if needed
        let screenshotBounds = null;
        if (trackPolygonLayer && typeof trackPolygonLayer.getBounds === 'function') {
            screenshotBounds = trackPolygonLayer.getBounds();
        } else if (screenshotPolygon && screenshotPolygon.length >= 3 && typeof L !== 'undefined') {
            try {
                const latLngs = screenshotPolygon
                    .map(coord => Array.isArray(coord) && coord.length >= 2 ? L.latLng(coord[0], coord[1]) : null)
                    .filter(Boolean);
                if (latLngs.length) {
                    screenshotBounds = L.latLngBounds(latLngs);
                }
            } catch (error) {
                console.warn('Failed to calculate screenshot bounds from polygon:', error);
            }
        }

        const computedParcelPolygons = buildParcelPolygonLatLngs(affectedParcels);

        // Collect ownership and acquisition stats
        const ownershipAndAcquisitionStats = collectOwnershipAndAcquisitionStats();

        // Build stats HTML if stats exist
        let statsHtml = '';
        if (ownershipAndAcquisitionStats) {
            const stats = ownershipAndAcquisitionStats;
            const statsItems = [];

            if (stats.individualOwners !== null) {
                statsItems.push(`<p><strong>Individual Owners:</strong> ${stats.individualOwners}</p>`);
            }
            if (stats.ownershipCounts.individual !== null) {
                statsItems.push(`<p><strong>Owned by Individuals:</strong> ${stats.ownershipCounts.individual}</p>`);
            }
            if (stats.ownershipCounts.company !== null) {
                statsItems.push(`<p><strong>Owned by Companies:</strong> ${stats.ownershipCounts.company}</p>`);
            }
            if (stats.ownershipCounts.government !== null) {
                statsItems.push(`<p><strong>Owned by Government:</strong> ${stats.ownershipCounts.government}</p>`);
            }
            if (stats.ownershipCounts.institution !== null) {
                statsItems.push(`<p><strong>Owned by Institution:</strong> ${stats.ownershipCounts.institution}</p>`);
            }
            if (stats.ownershipCounts.mixed !== null) {
                statsItems.push(`<p><strong>Ownership Mixed:</strong> ${stats.ownershipCounts.mixed}</p>`);
            }
            if (stats.totalMarketPrice !== null) {
                statsItems.push(`<p><strong>Total Market Price:</strong> ${Math.round(stats.totalMarketPrice).toLocaleString('hr-HR')} EUR</p>`);
            }
            if (stats.totalAcquiringDifficulty !== null) {
                statsItems.push(`<p><strong>Total Acquiring Difficulty:</strong> ${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</p>`);
            }

            if (statsItems.length > 0) {
                statsHtml = `
                    <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
                    <div class="proposal-stats-section">
                        <h4 style="margin-bottom: 10px;">Ownership & Acquisition Stats</h4>
                        <div class="summary-stats">
                            ${statsItems.join('')}
                        </div>
                    </div>
                `;
            }
        }

        modal.innerHTML = `
            <div class="proposal-modal-content">
                <div class="proposal-modal-header">
                    <h2>Create Track Proposal</h2>
                    <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close">&times;</button>
                </div>
                <div class="proposal-modal-body">
                    ${(screenshotPolygon && screenshotPolygon.length >= 3) ? '<div class="form-group" id="trackProposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                    <div class="form-group">
                        <label for="trackProposalAuthor">Author:</label>
                        <input type="text" id="trackProposalAuthor" placeholder="Your name">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalName">Track Name:</label>
                        <input type="text" id="trackProposalName" placeholder="e.g. Main Railway Line">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalOffer">Offer (EUR):</label>
                        <input type="number" id="trackProposalOffer" min="0" step="1000" placeholder="0">
                    </div>
                    <div class="form-group">
                        <label for="trackProposalDescription">Description:</label>
                        <textarea id="trackProposalDescription" rows="3" placeholder="Describe your track proposal..."></textarea>
                    </div>
                    <div class="proposal-summary">
                        <div class="summary-stats">
                            <p><strong>Parcels Affected:</strong> ${affectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong>Track Speed:</strong> ${trackSpeed} km/h</p>
                            <p><strong>Track Width:</strong> ${trackWidth.toFixed(1)} m</p>
                            <p><strong>Min. Curvature Radius:</strong> ${trackMinRadius} m</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Affected Parcels:</h4>
                            ${parcelItems || '<div class="proposal-parcel-item">No parcels detected.</div>'}
                        </div>
                    </div>
                    ${statsHtml}
                </div>
                <div class="proposal-modal-footer">
                    <button type="button" class="btn btn-proposal" id="trackProposalConfirmBtn">Create Proposal</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const authorInput = modal.querySelector('#trackProposalAuthor');
        const nameInput = modal.querySelector('#trackProposalName');
        const offerInput = modal.querySelector('#trackProposalOffer');
        const descriptionInput = modal.querySelector('#trackProposalDescription');
        const confirmButton = modal.querySelector('#trackProposalConfirmBtn');
        const closeButton = modal.querySelector('.proposal-modal-close');

        if (authorInput) authorInput.value = defaultAuthor || '';
        if (nameInput) nameInput.value = defaultName;
        if (offerInput) offerInput.value = Number.isFinite(defaultOffer) ? defaultOffer : '';

        const cleanup = () => {
            modal.removeEventListener('keydown', handleKeyDown, true);
            if (confirmButton) confirmButton.removeEventListener('click', handleSubmit);
            if (closeButton) closeButton.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        };

        const handleCancel = () => {
            cleanup();
            reject(new Error('cancelled'));
        };

        const handleSubmit = () => {
            const nameValue = (nameInput?.value || '').trim() || defaultName;
            const authorValue = (authorInput?.value || '').trim() || defaultAuthor || 'User';
            const descriptionValue = (descriptionInput?.value || '').trim();
            const offerValueRaw = offerInput ? parseFloat(offerInput.value) : NaN;
            const offerValue = Number.isFinite(offerValueRaw) && offerValueRaw > 0 ? offerValueRaw : defaultOffer;

            if (offerInput) offerInput.value = offerValue;
            if (nameInput) nameInput.value = nameValue;

            cleanup();
            resolve({
                trackName: nameValue,
                author: authorValue,
                description: descriptionValue,
                offer: offerValue,
                ownershipAndAcquisitionStats: ownershipAndAcquisitionStats,
                form: {
                    ethAmount: offerValue,
                    isConditional: true
                }
            });
        };

        const handleOverlayClick = (event) => {
            if (event.target === modal) {
                handleCancel();
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                handleSubmit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                handleCancel();
            }
        };

        modal.addEventListener('keydown', handleKeyDown, true);
        modal.addEventListener('click', handleOverlayClick);

        if (confirmButton) confirmButton.addEventListener('click', handleSubmit);
        if (closeButton) closeButton.addEventListener('click', handleCancel);

        // Capture and display screenshot if bounds are available
        if (screenshotPolygon && screenshotPolygon.length >= 3 && window.MapScreenshot) {
            const screenshotContainer = modal.querySelector('#trackProposalScreenshotContainer');
            if (screenshotContainer) {
                (async () => {
                    try {
                        const previewWrapper = document.createElement('div');
                        previewWrapper.className = 'map-screenshot-container';
                        previewWrapper.style.margin = '0 auto';
                        screenshotContainer.appendChild(previewWrapper);

                        window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                            polygon: screenshotPolygon,
                            bounds: screenshotBounds,
                            padding: 0.05,
                            parcelPolygons: computedParcelPolygons
                        });
                    } catch (error) {
                        console.warn('Failed to capture map screenshot:', error);
                        screenshotContainer.innerHTML = '';
                        const fallbackDiv = document.createElement('div');
                        fallbackDiv.className = 'map-screenshot-container';
                        fallbackDiv.style.color = '#999';
                        fallbackDiv.textContent = 'Preview unavailable';
                        screenshotContainer.appendChild(fallbackDiv);
                    }
                })();
            }
        }

        requestAnimationFrame(() => {
            if (nameInput) {
                nameInput.focus();
                nameInput.select();
            }
        });
    });
}

// Create a rectangular segment between two road points
function createRectangularRoadSegment(point1, point2, width) {
    // Validate input
    if (!point1 || !point2 || !isFinite(width) || width <= 0) {
        console.warn('Invalid inputs to createRectangularRoadSegment');
        return null;
    }

    if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
        !isFinite(point2.lat) || !isFinite(point2.lng)) {
        console.warn('Invalid coordinates in createRectangularRoadSegment');
        return null;
    }

    // Convert to HTRS96/TM for accurate distance calculations
    const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
    const htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);

    // Validate converted points
    if (!isValidPoint(htrsPoint1) || !isValidPoint(htrsPoint2)) {
        console.warn('Invalid HTRS points in createRectangularRoadSegment');
        return null;
    }

    // Calculate segment direction
    const dx = htrsPoint2[0] - htrsPoint1[0];
    const dy = htrsPoint2[1] - htrsPoint1[1];
    const length = Math.sqrt(dx * dx + dy * dy);

    // Skip if segment has near-zero length
    if (length < 0.001) {
        // Use a minimum segment length to avoid zero-length segments
        // Instead of just returning null, create a small circle around the point
        const minLength = 0.1; // 10cm minimum
        // Create a point offset in a random direction if points are too close
        const angle = Math.random() * Math.PI * 2; // Random angle
        const offsetX = Math.cos(angle) * minLength;
        const offsetY = Math.sin(angle) * minLength;

        // Create new point2 with the offset
        const newHtrsPoint2 = [htrsPoint1[0] + offsetX, htrsPoint1[1] + offsetY];

        // Recalculate direction with the new point
        const newDx = newHtrsPoint2[0] - htrsPoint1[0];
        const newDy = newHtrsPoint2[1] - htrsPoint1[1];
        const newLength = Math.sqrt(newDx * newDx + newDy * newDy);

        // Calculate normalized perpendicular vector
        const perpX = -newDy / newLength;
        const perpY = newDx / newLength;

        // Rest of the function is the same, just using the new values
        const halfWidth = width / 2;

        // Calculate the 4 corners of the rectangle
        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
            [newHtrsPoint2[0] + perpX * halfWidth, newHtrsPoint2[1] + perpY * halfWidth], // top-right
            [newHtrsPoint2[0] - perpX * halfWidth, newHtrsPoint2[1] - perpY * halfWidth], // bottom-right
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
        ];

        // Convert back to WGS84
        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(L.latLng(lat, lng));
            }
        }

        // Check if we have enough points for a valid polygon
        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }

        return wgsCorners;
    }

    // Calculate perpendicular vector (normalized)
    const perpX = -dy / length;
    const perpY = dx / length;

    // Calculate half-width
    const halfWidth = width / 2;

    // Calculate the 4 corners of the rectangle
    const corners = [
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
        [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth], // top-right
        [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth], // bottom-right
        [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
    ];

    // Convert back to WGS84
    const wgsCorners = [];
    for (const corner of corners) {
        const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
        if (isFinite(lat) && isFinite(lng)) {
            wgsCorners.push(L.latLng(lat, lng));
        } else {
            console.warn('Invalid conversion result:', lat, lng);
        }
    }

    // Check if we have enough points for a valid polygon
    if (wgsCorners.length < 4) {
        console.warn('Not enough valid corners for rectangle');
        return null;
    }

    return wgsCorners;
}

// Create a wedge polygon at a joint to fill the outer angle gap between two segments
function createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    // Validate inputs
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    if (!isFinite(prevPoint.lat) || !isFinite(prevPoint.lng) ||
        !isFinite(jointPoint.lat) || !isFinite(jointPoint.lng) ||
        !isFinite(nextPoint.lat) || !isFinite(nextPoint.lng)) {
        return null;
    }

    // Convert to HTRS96/TM meters
    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!isValidPoint(p0) || !isValidPoint(pj) || !isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]]; // incoming dir
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]]; // outgoing dir

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    // Left normals for each segment
    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    // Right normals are negatives
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    // Determine turn direction: positive => left turn
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0; // inner on left when turning left

    const halfWidth = width / 2;

    // Pick outer normals
    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    // Offset points at the joint on the outer side
    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    // Intersect offset edge lines: L1: pA + t * u1; L2: pB + s * u2
    const r = [pB[0] - pA[0], pB[1] - pA[1]];
    const denom = u1[0] * u2[1] - u1[1] * u2[0];

    let miterPoint = null;
    if (Math.abs(denom) > 1e-8) {
        const t = (r[0] * u2[1] - r[1] * u2[0]) / denom;
        miterPoint = [pA[0] + t * u1[0], pA[1] + t * u1[1]];
    }

    // Miter limit to avoid spikes for very acute angles
    const miterLimit = 4; // times halfWidth
    let wedgeHTRS;
    if (miterPoint) {
        const dx = miterPoint[0] - pj[0];
        const dy = miterPoint[1] - pj[1];
        const miterLen = Math.hypot(dx, dy);
        if (miterLen > miterLimit * halfWidth) {
            // Use bevel: connect with a triangle to a capped midpoint along outer bisector
            const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
            const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
            const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
            wedgeHTRS = [pA, cap, pB, pA];
        } else {
            // Miter triangle
            wedgeHTRS = [pA, miterPoint, pB, pA];
        }
    } else {
        // Nearly parallel; bevel join
        const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
        const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
        const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
        wedgeHTRS = [pA, cap, pB, pA];
    }

    // Convert back to WGS84 lat/lngs and return as Leaflet LatLng[]
    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

// Combine two road polygons using Turf's union operation
function combineRoadPolygons(polygon1, polygon2) {
    // Validate inputs
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

    try {
        // Convert Leaflet latLng objects to Turf format [lng, lat]
        const formatForTurf = (poly) => {
            return poly.map(p => [p.lng, p.lat]);
        };

        // Format and close both polygons
        const turfFormat1 = ensurePolygonIsClosed(formatForTurf(polygon1));
        const turfFormat2 = ensurePolygonIsClosed(formatForTurf(polygon2));

        // Create Turf polygons
        const turfPoly1 = turf.polygon([turfFormat1]);
        const turfPoly2 = turf.polygon([turfFormat2]);

        // Perform the union operation
        const combined = turf.union(turfPoly1, turfPoly2);

        // Extract coordinates from the result
        let resultCoords;
        if (combined.geometry.type === 'Polygon') {
            // Simple case - we got a single polygon back
            resultCoords = combined.geometry.coordinates[0];
        } else if (combined.geometry.type === 'MultiPolygon') {
            // We got multiple polygons - use the largest one
            let maxArea = 0;
            let largestPolygon = null;

            for (const polygon of combined.geometry.coordinates) {
                const poly = turf.polygon([polygon[0]]);
                const area = turf.area(poly);

                if (area > maxArea) {
                    maxArea = area;
                    largestPolygon = polygon[0];
                }
            }

            resultCoords = largestPolygon;
        } else {
            console.error('Unexpected geometry type from union:', combined.geometry.type);
            return null;
        }

        // Convert back to Leaflet format
        return resultCoords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.error('Error combining road polygons:', error);
        // Fall back to the most recent polygon if there's an error
        return polygon2 || polygon1;
    }
}

// Check if a parcel number exists
function parcelNumberExists(number) {
    // Check parcelLayer
    if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
        let exists = false;
        window.parcelLayer.eachLayer(layer => {
            if (layer && layer.feature && layer.feature.properties &&
                layer.feature.properties.BROJ_CESTICE === number) {
                exists = true;
            }
        });
        if (exists) return true;
    }

    // Check PersistentStorage
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key.startsWith('parcel_') && key.endsWith('_properties')) {
            try {
                const properties = JSON.parse(PersistentStorage.getItem(key));
                if (properties && properties.BROJ_CESTICE === number) {
                    return true;
                }
            } catch (e) {
                console.warn('Error parsing properties from PersistentStorage:', e);
            }
        }
    }
    return false;
}

// Find next available number
function findNextAvailableSubNumber(baseNumber, usedNumbers = new Set()) {
    let counter = 1;
    while (parcelNumberExists(`${baseNumber}/${counter}`) || usedNumbers.has(`${baseNumber}/${counter}`)) {
        counter++;
    }
    return counter;
}

// Helper function to hash geometry coordinates (rounded for robustness)
function geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}

// Function to update parcel numbers and split parcels
// MOVED to proposal-manager.js

// Helper function to calculate area from a Leaflet polygon
function calculateAreaFromLatLngPolygon(latLngPolygon) {
    // Convert to HTRS96/TM coordinates
    const htrsCoords = latLngPolygon.map(point => wgs84ToHTRS96(point.lat, point.lng));

    // Create closed polygon
    const closedCoords = [...htrsCoords];
    if (htrsCoords.length > 0 &&
        (htrsCoords[0][0] !== htrsCoords[htrsCoords.length - 1][0] ||
            htrsCoords[0][1] !== htrsCoords[htrsCoords.length - 1][1])) {
        closedCoords.push(htrsCoords[0]);
    }

    // Calculate area
    let area = 0;
    for (let i = 0; i < closedCoords.length - 1; i++) {
        area += closedCoords[i][0] * closedCoords[i + 1][1] - closedCoords[i + 1][0] * closedCoords[i][1];
    }

    return Math.abs(area / 2);
}

// New function to find and highlight preview-affected parcels
function findPreviewAffectedParcels(previewPolygon) {
    if (!previewPolygon || !parcelLayer) return;

    // Clear previous preview highlights
    clearPreviewAffectedParcels();

    const newPreviewAffected = [];
    const roadLatLngs = previewPolygon.map(p => [p.lng, p.lat]);
    const closedRoadLatLngs = ensurePolygonIsClosed(roadLatLngs);
    if (closedRoadLatLngs.length < 4) return; // Need at least 4 points for a valid polygon

    let turfRoadPolygon;
    try {
        turfRoadPolygon = turf.polygon([closedRoadLatLngs]);
    } catch (error) {
        return; // Silent error
    }

    const mapBounds = map.getBounds();

    parcelLayer.eachLayer(layer => {
        try {
            const layerBounds = layer.getBounds();
            if (!mapBounds.intersects(layerBounds)) return;

            const parcelId = layer.feature.properties.CESTICA_ID;
            const outerRings = getParcelOuterRingsLngLat(layer);
            if (!outerRings || outerRings.length === 0) return;

            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const closedRing = ensurePolygonIsClosed(ring);
                if (!closedRing || closedRing.length < 4) continue;
                const turfParcelPolygon = turf.polygon([closedRing]);

                if (turf.booleanIntersects(turfRoadPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;
                    newPreviewAffected.push({
                        id: parcelId,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice,
                        layer: layer
                    });

                    // Apply preview style only if not already committed (green)
                    if (!roadAffectedParcels.some(p => p.id === parcelId)) {
                        layer.setStyle(previewAffectedStyle);
                        if (typeof layer.bringToFront === 'function') {
                            layer.bringToFront();
                        }
                    }
                    break; // No need to check further rings
                }
            }
        } catch (error) {
            // Silent error handling for individual parcels
        }
    });

    roadPreviewAffectedParcels = newPreviewAffected; // Update the global state

    // Combine committed and preview parcels for stats
    const allAffectedParcels = [...roadAffectedParcels];
    const previewOnlyParcels = roadPreviewAffectedParcels.filter(p =>
        !roadAffectedParcels.some(committed => committed.id === p.id)
    );
    const combinedParcels = [...allAffectedParcels, ...previewOnlyParcels];

    // Update UI with PREVIEW count/area (takes precedence over committed during move)
    try {
        if (combinedParcels.length > 0) {
            const totalArea = combinedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
            setRoadParcelStats(combinedParcels.length, formatParcelArea(totalArea));
        } else {
            setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
        }

        // Update ownership stats with combined parcels
        updateRoadOwnershipCounts(combinedParcels).catch(err => {
            console.warn('road ownership: failed to update stats in preview', err);
        });

        // Update market price with combined parcels
        updateRoadMarketPrice(combinedParcels);

        // Update acquiring difficulty with combined parcels
        updateRoadAcquiringDifficulty(combinedParcels);
    } catch (err) {
        console.warn('road stats: failed to update in preview', err);
    }
}

// ============================================================================
// TRACK DRAWING FUNCTIONALITY
// ============================================================================

// Track drawing tool variables
let trackDrawingMode = false;
let trackPoints = [];
// Standard track width: 1.453m track + embankments = 3m total (default, can be changed via UI)
let trackWidth = 3.0;
const TRACK_WIDTH_DEFAULT = 3.0;
// Track speed in km/h, determines minimum curvature radius
let trackSpeed = 120; // Default speed
let trackMinCurvatureRadius = 1000; // Default minimum radius in meters
let trackCenterline = null;
let trackPolygon = null;
let trackPreviewLine = null;
let trackPreviewPolygon = null;
let trackAffectedParcels = [];
let trackMouseMarker = null;
let trackHasStarted = false;
let trackPreviewPolygonLayer = null;
let trackCenterlineLayer = null;
let trackPolygonLayer = null;
let trackMarkers = [];
let trackPreviewAffectedParcels = [];
let trackRailsLayer = null; // Layer group for track rails and sleepers
let trackPreviewRailsLayer = null; // Preview rails and sleepers
let lastTrackMoveUpdate = 0;
const trackThrottleDelay = 150; // milliseconds between updates (same as road)

// Track speed to minimum curvature radius mapping (in meters)
// Based on railway engineering standards
const TRACK_SPEED_TO_MIN_RADIUS = {
    50: 300,   // Low speed, yards/sidings
    80: 500,   // Local/regional
    120: 1000, // Regional/mainline
    160: 2000, // High-speed regional
    200: 3500, // High-speed
    250: 5000  // Very high-speed
};

// Calculate minimum curvature radius from speed
function getMinCurvatureRadius(speed) {
    return TRACK_SPEED_TO_MIN_RADIUS[speed] || 1000;
}

// Render a single track at a given offset from centerline
// Helper function for rendering tracks
function renderSingleTrack(htrsPoints, centerlineOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup) {
    const railOffset = 0.725; // Half of track gauge (1.453m / 2) in meters

    // Create left and right rail paths
    const leftRailPoints = [];
    const rightRailPoints = [];

    for (let i = 0; i < htrsPoints.length; i++) {
        const point = htrsPoints[i];
        let dir = null;

        if (i < htrsPoints.length - 1) {
            // Direction to next point
            const next = htrsPoints[i + 1];
            const dx = next[0] - point[0];
            const dy = next[1] - point[1];
            const len = Math.hypot(dx, dy);
            if (len > 0.01) {
                dir = [dx / len, dy / len];
            }
        } else if (i > 0) {
            // Direction from previous point
            const prev = htrsPoints[i - 1];
            const dx = point[0] - prev[0];
            const dy = point[1] - prev[1];
            const len = Math.hypot(dx, dy);
            if (len > 0.01) {
                dir = [dx / len, dy / len];
            }
        }

        if (dir) {
            // Perpendicular direction (rotate 90 degrees)
            const perp = [-dir[1], dir[0]];
            // Offset track centerline from original centerline
            const trackCenter = [
                point[0] + perp[0] * centerlineOffset,
                point[1] + perp[1] * centerlineOffset
            ];
            // Then offset rails from track centerline
            const leftPt = [trackCenter[0] + perp[0] * railOffset, trackCenter[1] + perp[1] * railOffset];
            const rightPt = [trackCenter[0] - perp[0] * railOffset, trackCenter[1] - perp[1] * railOffset];

            const [leftLat, leftLng] = htrs96ToWGS84(leftPt[0], leftPt[1]);
            const [rightLat, rightLng] = htrs96ToWGS84(rightPt[0], rightPt[1]);

            leftRailPoints.push(L.latLng(leftLat, leftLng));
            rightRailPoints.push(L.latLng(rightLat, rightLng));
        } else {
            // Fallback: use point directly if no direction (shouldn't happen often)
            const [lat, lng] = htrs96ToWGS84(point[0], point[1]);
            leftRailPoints.push(L.latLng(lat, lng));
            rightRailPoints.push(L.latLng(lat, lng));
        }
    }

    // Draw left rail
    const leftRail = L.polyline(leftRailPoints, {
        color: railColor,
        weight: 2,
        opacity: 0.9
    });
    layerGroup.addLayer(leftRail);

    // Draw right rail
    const rightRail = L.polyline(rightRailPoints, {
        color: railColor,
        weight: 2,
        opacity: 0.9
    });
    layerGroup.addLayer(rightRail);

    // Draw sleepers (ties) at regular intervals along the track
    for (let i = 0; i < htrsPoints.length - 1; i++) {
        const start = htrsPoints[i];
        const end = htrsPoints[i + 1];
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const segmentLength = Math.hypot(dx, dy);
        const segmentDir = segmentLength > 0.01 ? [dx / segmentLength, dy / segmentLength] : [1, 0];
        const perp = [-segmentDir[1], segmentDir[0]];

        // Calculate number of sleepers for this segment
        const numSleepers = Math.floor(segmentLength / sleeperSpacing);

        for (let j = 0; j <= numSleepers; j++) {
            const t = j / Math.max(numSleepers, 1);
            const sleeperCenterOnCenterline = [
                start[0] + dx * t,
                start[1] + dy * t
            ];
            // Offset sleeper center to track centerline
            const sleeperCenter = [
                sleeperCenterOnCenterline[0] + perp[0] * centerlineOffset,
                sleeperCenterOnCenterline[1] + perp[1] * centerlineOffset
            ];

            // Sleeper endpoints (perpendicular to track)
            const sleeperStart = [
                sleeperCenter[0] + perp[0] * sleeperLength / 2,
                sleeperCenter[1] + perp[1] * sleeperLength / 2
            ];
            const sleeperEnd = [
                sleeperCenter[0] - perp[0] * sleeperLength / 2,
                sleeperCenter[1] - perp[1] * sleeperLength / 2
            ];

            const [startLat, startLng] = htrs96ToWGS84(sleeperStart[0], sleeperStart[1]);
            const [endLat, endLng] = htrs96ToWGS84(sleeperEnd[0], sleeperEnd[1]);

            const sleeper = L.polyline([
                L.latLng(startLat, startLng),
                L.latLng(endLat, endLng)
            ], {
                color: sleeperColor,
                weight: 1,
                opacity: 0.7
            });
            layerGroup.addLayer(sleeper);
        }
    }
}

// Render track with rails and sleepers
// Returns a Leaflet layer group containing the track visualization
// Options: { isPreview, railColor, sleeperColor, trackWidth }
function renderTrackWithRails(points, isPreview = false, options = {}) {
    if (!points || points.length < 2) return null;

    const layerGroup = L.layerGroup();
    const sleeperSpacing = 0.6; // Sleepers every 0.6 meters
    const sleeperLength = 2.5; // Sleeper length in meters

    // Determine colors: use provided colors, or fall back to defaults
    const railColor = options.railColor !== undefined
        ? options.railColor
        : (isPreview ? '#ff6600' : '#333333');
    const sleeperColor = options.sleeperColor !== undefined
        ? options.sleeperColor
        : (isPreview ? '#cc6600' : '#8B4513');

    // Get track width from options, or use module-level trackWidth if available
    // trackWidth is declared at module level (line 2899)
    const trackWidthValue = options.trackWidth !== undefined
        ? parseFloat(options.trackWidth)
        : trackWidth; // Reference module-level variable

    // Convert points to HTRS96 for calculations
    const htrsPoints = points.map(p => wgs84ToHTRS96(p.lat, p.lng));

    // Check if we should draw two parallel tracks (when width is 10m or close)
    const isDoubleTrack = trackWidthValue >= 9.5; // Allow some tolerance for floating point

    if (isDoubleTrack) {
        // Draw two parallel tracks
        // Position them symmetrically within the width
        // Track 1: offset -2.5m from centerline
        // Track 2: offset +2.5m from centerline
        const trackOffset = 2.5; // Distance from centerline to each track center

        renderSingleTrack(htrsPoints, -trackOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup);
        renderSingleTrack(htrsPoints, trackOffset, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup);
    } else {
        // Draw single track at centerline
        renderSingleTrack(htrsPoints, 0, railColor, sleeperColor, sleeperSpacing, sleeperLength, layerGroup);
    }

    return layerGroup;
}

// Calculate the radius of a circle through three points
function calculateCurvatureRadius(p1, p2, p3) {
    // Convert lat/lng to meters for calculation
    const toMeters = (latLng) => {
        const [x, y] = wgs84ToHTRS96(latLng.lat, latLng.lng);
        return [x, y];
    };

    const a = toMeters(p1);
    const b = toMeters(p2);
    const c = toMeters(p3);

    // Calculate vectors
    const ab = [b[0] - a[0], b[1] - a[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const ac = [c[0] - a[0], c[1] - a[1]];

    // Calculate lengths
    const abLen = Math.hypot(ab[0], ab[1]);
    const bcLen = Math.hypot(bc[0], bc[1]);
    const acLen = Math.hypot(ac[0], ac[1]);

    if (abLen < 0.1 || bcLen < 0.1 || acLen < 0.1) {
        return Infinity; // Points too close, treat as straight
    }

    // Calculate area of triangle using cross product
    const area = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / 2;

    if (area < 0.1) {
        return Infinity; // Points are collinear, treat as straight
    }

    // Calculate radius using formula: R = (abc) / (4 * area)
    const radius = (abLen * bcLen * acLen) / (4 * area);

    return radius;
}

// Check if adding a new point would violate curvature constraints
// Returns: { valid: boolean, adjustedPoint: LatLng, violatesConstraint: boolean, wasAdjusted: boolean }
function checkCurvatureConstraint(points, newPoint, minRadius) {
    if (points.length < 2) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    const lastPoint = points[points.length - 1];
    const secondLastPoint = points.length >= 2 ? points[points.length - 2] : null;

    if (!secondLastPoint) {
        // Only one point, no curvature to check
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Convert to meters for calculation
    const [prevX, prevY] = wgs84ToHTRS96(secondLastPoint.lat, secondLastPoint.lng);
    const [lastX, lastY] = wgs84ToHTRS96(lastPoint.lat, lastPoint.lng);
    const [newX, newY] = wgs84ToHTRS96(newPoint.lat, newPoint.lng);

    // Calculate vectors
    const prevDx = lastX - prevX;
    const prevDy = lastY - prevY;
    const prevDist = Math.hypot(prevDx, prevDy);

    const dx = newX - lastX;
    const dy = newY - lastY;
    const dist = Math.hypot(dx, dy);

    // Check minimum distances
    if (prevDist < 0.1 || dist < 0.1) {
        // Points too close, can't check curvature meaningfully
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Calculate the turn angle
    const prevAngle = Math.atan2(prevDy, prevDx);
    const newAngle = Math.atan2(dy, dx);

    // Calculate the angle difference (turn angle)
    let angleDiff = newAngle - prevAngle;
    // Normalize to [-π, π]
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    const absAngleDiff = Math.abs(angleDiff);

    // For very small angles (nearly straight), accept immediately
    if (absAngleDiff < 0.01) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Calculate the actual radius of curvature from three points
    const radius = calculateCurvatureRadius(secondLastPoint, lastPoint, newPoint);

    // Primary check: if radius meets minimum, accept
    if (radius >= minRadius) {
        return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
    }

    // Radius is too small - calculate what's needed to fix it
    // For a circular arc: L = 2 * R * sin(θ/2), where L is chord length, R is radius, θ is turn angle
    // We need R >= minRadius, so: L >= 2 * minRadius * sin(θ/2)

    // The chord length is the straight-line distance from secondLastPoint to newPoint
    const chordDx = newX - prevX;
    const chordDy = newY - prevY;
    const chordLength = Math.hypot(chordDx, chordDy);

    // Calculate minimum required chord length for this turn angle
    const minRequiredChordLength = 2 * minRadius * Math.sin(absAngleDiff / 2);

    // If chord is already long enough but radius is still too small, 
    // this might be due to the geometry of the three points (not forming a proper arc)
    // In this case, we should still reject/adjust
    if (chordLength < minRequiredChordLength) {
        // Chord is too short - need to extend the new point to increase chord length
        // We'll extend along the current direction from lastPoint to newPoint

        // Calculate required distance from lastPoint to achieve minimum chord length
        // Using law of cosines: chordLength^2 = prevDist^2 + dist^2 - 2*prevDist*dist*cos(angleDiff)
        // Solving for dist: dist^2 - 2*prevDist*cos(angleDiff)*dist + (prevDist^2 - minRequiredChordLength^2) = 0
        const cosAngleDiff = Math.cos(absAngleDiff);
        const a = 1;
        const b = -2 * prevDist * cosAngleDiff;
        const c = prevDist * prevDist - minRequiredChordLength * minRequiredChordLength;
        const discriminant = b * b - 4 * a * c;

        if (discriminant < 0) {
            // No real solution - turn is too sharp even with infinite extension
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
        }

        const requiredDist = (-b + Math.sqrt(discriminant)) / (2 * a);

        // Only adjust if it's reasonable (not more than 2x the current distance)
        if (requiredDist > dist * 2 || requiredDist < dist * 0.5) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
        }

        // Extend the point along the current direction
        const scale = requiredDist / dist;
        const adjustedX = lastX + dx * scale;
        const adjustedY = lastY + dy * scale;

        const [adjustedLat, adjustedLng] = htrs96ToWGS84(adjustedX, adjustedY);
        const adjustedPoint = L.latLng(adjustedLat, adjustedLng);

        // Verify the adjusted point meets the constraint
        const adjustedRadius = calculateCurvatureRadius(secondLastPoint, lastPoint, adjustedPoint);
        if (adjustedRadius >= minRadius * 0.98) { // Allow 2% tolerance
            return { valid: true, adjustedPoint: adjustedPoint, violatesConstraint: false, wasAdjusted: true };
        }
    }

    // If we get here, the constraint is violated and we can't reasonably adjust
    return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
}

// Track Speed Picker modal implementation
function showTrackSpeedPicker() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('track-speed-modal');
        const grid = document.getElementById('track-speed-grid');
        const btnConfirm = document.getElementById('track-speed-confirm-btn');
        const btnCancel = document.getElementById('track-speed-cancel-btn');
        const widthSlider = document.getElementById('track-width-slider');
        const widthValue = document.getElementById('track-width-value');
        if (!modal || !grid || !btnConfirm || !btnCancel) {
            console.warn('Track speed modal elements missing');
            resolve({ speed: 120, minRadius: 1000, width: 3.0 }); // fallback to default values
            return;
        }

        // Initialize track width slider
        let currentWidth = parseFloat(PersistentStorage.getItem('lastTrackWidth')) || 3.0;
        if (widthSlider && widthValue) {
            widthSlider.value = currentWidth;
            widthValue.textContent = currentWidth.toFixed(1);
            widthSlider.addEventListener('input', (e) => {
                currentWidth = parseFloat(e.target.value);
                widthValue.textContent = currentWidth.toFixed(1);
            });
        }

        // Options: speed (km/h) -> min radius (m)
        const options = [
            { id: 'trackspeed1', speed: 50, label: '50 km/h', minRadius: 300 },
            { id: 'trackspeed2', speed: 80, label: '80 km/h', minRadius: 500 },
            { id: 'trackspeed3', speed: 120, label: '120 km/h', minRadius: 1000 },
            { id: 'trackspeed4', speed: 160, label: '160 km/h', minRadius: 2000 },
            { id: 'trackspeed5', speed: 200, label: '200 km/h', minRadius: 3500 },
            { id: 'trackspeed6', speed: 250, label: '250 km/h', minRadius: 5000 },
        ];

        // Prefill grid
        grid.innerHTML = '';
        let selectedId = (PersistentStorage.getItem('lastTrackSpeedId')) || 'trackspeed3';

        options.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.speed = String(opt.speed);
            card.dataset.minRadius = String(opt.minRadius);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label} (min radius: ${opt.minRadius}m)`;
            card.appendChild(lbl);

            card.addEventListener('click', () => {
                selectedId = opt.id;
                grid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    card.click();
                }
            });
            grid.appendChild(card);
        });

        const confirmSelection = () => {
            const selected = grid.querySelector('.roadwidth-card.selected');
            if (!selected) {
                reject(new Error('No selection'));
                return;
            }
            const speed = parseFloat(selected.dataset.speed);
            const minRadius = parseFloat(selected.dataset.minRadius);
            const width = widthSlider ? parseFloat(widthSlider.value) : currentWidth;
            PersistentStorage.setItem('lastTrackSpeedId', selected.dataset.id);
            if (widthSlider) {
                PersistentStorage.setItem('lastTrackWidth', String(width));
            }
            modal.style.display = 'none';
            // Collapse sidebar if open
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
            resolve({ speed, minRadius, width });
        };

        btnConfirm.addEventListener('click', confirmSelection);
        btnCancel.addEventListener('click', () => {
            modal.style.display = 'none';
            reject(new Error('Cancelled'));
        });

        // Handle Enter key on modal
        const handleKeydown = (ev) => {
            if (ev.key === 'Enter' && !ev.target.matches('input, textarea, select')) {
                ev.preventDefault();
                confirmSelection();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                btnCancel.click();
            }
        };
        modal.addEventListener('keydown', handleKeydown);

        modal.style.display = 'flex';
        grid.querySelector('.roadwidth-card.selected')?.focus();
    });
}

// Toggle track drawing tool
function toggleTrackDrawTool() {
    trackDrawingMode = !trackDrawingMode;
    const trackDrawButton = document.getElementById('trackDrawButton');

    if (trackDrawingMode) {
        // Deactivate road drawing if active
        if (roadDrawingMode) {
            toggleRoadDrawTool();
        }

        // Activate track drawing mode
        console.log("Activating track drawing mode");
        trackDrawButton.classList.add('active');
        trackDrawButton.classList.add('active-black-border');

        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool();

        // Disable parcel interaction
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
            });
        }

        // Hide other panels
        const blockInfoPanel = document.getElementById('block-info-panel');
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (blockInfoPanel) blockInfoPanel.classList.remove('visible');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');

        // Initialize track speed via picker modal
        try {
            showTrackSpeedPicker().then(({ speed, minRadius, width }) => {
                trackSpeed = speed;
                trackMinCurvatureRadius = minRadius;
                if (width !== undefined) {
                    trackWidth = width;
                }

                // Show the road info panel (reuse for tracks)
                const roadInfoPanel = document.getElementById('road-info-panel');
                if (roadInfoPanel) {
                    roadInfoPanel.style.removeProperty('display');
                    roadInfoPanel.classList.add('visible');
                }
                const statusElement = document.getElementById('status');
                if (statusElement) updateStatus('Click on the map to start drawing a track');

                // Show drawing controls
                const roadDrawingControls = document.getElementById('road-drawing-controls');
                if (roadDrawingControls) roadDrawingControls.style.display = 'grid';

                // Activate map and keyboard handlers
                map.on('click', handleTrackClick);
                map.on('mousemove', handleTrackMouseMove);
                map.on('mouseout', handleTrackMouseOut);
                document.addEventListener('keydown', handleTrackKeydown);

                // Initialize Set for fast O(1) lookups in resetHighlight
                if (typeof window !== 'undefined') {
                    window.trackPreviewAffectedParcelIds = new Set();
                }
            }).catch(() => {
                // If picker was cancelled, turn off drawing mode
                trackDrawingMode = false;
                if (trackDrawButton) {
                    trackDrawButton.classList.remove('active');
                    trackDrawButton.classList.remove('active-black-border');
                }
                map.getContainer().style.cursor = '';
                map.getContainer().classList.remove('crosshairs-cursor');
                map.off('click', handleTrackClick);
                map.off('mousemove', handleTrackMouseMove);
                map.off('mouseout', handleTrackMouseOut);
                document.removeEventListener('keydown', handleTrackKeydown);
                if (parcelLayer) {
                    try {
                        parcelLayer.eachLayer(layer => {
                            layer.off('click');
                            if (typeof getCorrectClickHandler === 'function') {
                                layer.on('click', getCorrectClickHandler());
                            }
                        });
                    } catch (_) { }
                }
            });
        } catch (e) {
            console.warn('Track speed picker unavailable', e);
            trackSpeed = 120;
            trackMinCurvatureRadius = 1000;
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) {
                roadInfoPanel.style.removeProperty('display');
                roadInfoPanel.classList.add('visible');
            }
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus('Click on the map to start drawing a track');
        }
    } else {
        // Deactivate track drawing mode
        console.log("Deactivating track drawing mode");
        if (trackDrawButton) {
            trackDrawButton.classList.remove('active');
            trackDrawButton.classList.remove('active-black-border');
        }

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'none';
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove track drawing event handlers
        map.off('click', handleTrackClick);
        map.off('mousemove', handleTrackMouseMove);
        map.off('mouseout', handleTrackMouseOut);
        document.removeEventListener('keydown', handleTrackKeydown);

        // Re-enable parcel interaction
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
                layer.on('click', getCorrectClickHandler());
            });
        }

        // Reset track drawing variables
        resetTrackDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');
    }
}

// Handle keyboard events during track drawing
function handleTrackKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    if ((e.key === 'f' || e.key === 'F') && trackHasStarted && trackPoints.length >= 2) {
        e.preventDefault();
        finishTrackDrawing();
    }

    if (e.key === 'Escape') {
        e.preventDefault();
        cancelTrackDrawing();
    }
}

// Handle track drawing clicks
function handleTrackClick(e) {
    L.DomEvent.stopPropagation(e);

    const clickPoint = e.latlng;

    if (!trackHasStarted) {
        // First click - start the track
        trackPoints = [clickPoint];
        trackHasStarted = true;

        // Add marker for the starting point
        const startMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: '#0066cc',
            fillColor: '#0066cc',
            fillOpacity: 1
        }).addTo(map);
        trackMarkers.push(startMarker);

        // Initialize track centerline - will be replaced with rails rendering
        trackCenterline = L.polyline([clickPoint], {
            color: 'transparent',
            weight: 0,
            opacity: 0
        }).addTo(map);

        // Create rails layer for committed track
        trackRailsLayer = L.layerGroup().addTo(map);

        updateStatus('Click to add track points, "Finish" when done');
    } else {
        // Check curvature constraint - only adjust if violation is severe and adjustment is reasonable
        const constraintCheck = checkCurvatureConstraint(trackPoints, clickPoint, trackMinCurvatureRadius);

        // Only use adjusted point if it was actually adjusted AND the adjustment is reasonable
        // Otherwise use the clicked point to avoid overshoot
        let pointToAdd = clickPoint;

        // Only show warnings if the constraint is actually violated (consistent with preview)
        if (constraintCheck.violatesConstraint) {
            // Constraint is violated - show warning
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Warning: Curvature exceeds minimum radius for selected speed.', 3000, 'warning');
            }
        } else if (constraintCheck.wasAdjusted) {
            // Constraint was met by adjusting - check if adjustment is reasonable
            const [clickX, clickY] = wgs84ToHTRS96(clickPoint.lat, clickPoint.lng);
            const [adjX, adjY] = wgs84ToHTRS96(constraintCheck.adjustedPoint.lat, constraintCheck.adjustedPoint.lng);
            const [lastX, lastY] = wgs84ToHTRS96(trackPoints[trackPoints.length - 1].lat, trackPoints[trackPoints.length - 1].lng);
            const clickDist = Math.hypot(clickX - lastX, clickY - lastY);
            const adjDist = Math.hypot(adjX - lastX, adjY - lastY);
            const adjustmentRatio = Math.abs(adjDist - clickDist) / Math.max(clickDist, 0.1);

            // Only use adjusted point if adjustment is less than 20% of the segment length
            if (adjustmentRatio < 0.2) {
                pointToAdd = constraintCheck.adjustedPoint;
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Point adjusted to meet minimum curvature radius.', 2000, 'info');
                }
            }
            // If adjustment is too large, just use clicked point (no warning since constraint is met)
        }

        // Add point to track
        trackPoints.push(pointToAdd);

        // Add marker for this point
        const pointMarker = L.circleMarker(pointToAdd, {
            radius: 5,
            color: '#0066cc',
            fillColor: '#0066cc',
            fillOpacity: 1
        }).addTo(map);
        trackMarkers.push(pointMarker);

        // Update the centerline
        trackCenterline.addLatLng(pointToAdd);

        // Update track rails visualization
        if (trackRailsLayer) {
            map.removeLayer(trackRailsLayer);
        }
        trackRailsLayer = renderTrackWithRails(trackPoints, false, { trackWidth: trackWidth });
        if (trackRailsLayer) {
            trackRailsLayer.addTo(map);
        }

        // Clear preview layers (but keep parcel highlighting - it will update on next mouse move)
        if (trackPreviewPolygonLayer) {
            trackPreviewPolygonLayer.removeFrom(map);
            trackPreviewPolygonLayer = null;
        }
        if (trackPreviewRailsLayer) {
            map.removeLayer(trackPreviewRailsLayer);
            trackPreviewRailsLayer = null;
        }
        if (trackPreviewLine) {
            trackPreviewLine.removeFrom(map);
            trackPreviewLine = null;
        }

        // Calculate the committed track polygon
        const newCommittedPolygon = calculateRoadPolygon(trackPoints, trackWidth);
        trackPolygon = newCommittedPolygon;

        // No need to re-apply highlighting here - it's already applied and resetHighlight will preserve it

        // Remove previous committed polygon layer
        if (trackPolygonLayer) {
            map.removeLayer(trackPolygonLayer);
            trackPolygonLayer = null;
        }

        if (trackPolygon) {
            // Draw the committed track polygon with track styling (light background)
            trackPolygonLayer = L.polygon(trackPolygon, {
                color: '#0066cc',
                weight: 1,
                fillColor: '#e6f2ff',
                fillOpacity: 0.2
            }).addTo(map);

            // Render rails for the committed track (only on click, not during mouse move for performance)
            const committedRails = renderTrackWithRails(trackPoints, false, { trackWidth: trackWidth });
            if (committedRails && trackRailsLayer) {
                // Update the rails layer
                map.removeLayer(trackRailsLayer);
                trackRailsLayer = committedRails;
                trackRailsLayer.addTo(map);
            }

            // Note: We don't highlight parcels on click anymore - only during preview
            // Parcels will be collected for stats when finishing the track
        }
    }

    updateRoadInfoPanel();
}

// Handle track mouse movement for preview
function handleTrackMouseMove(e) {
    if (!trackHasStarted || !trackPoints || trackPoints.length === 0) return;

    // Throttle updates for better performance (same as road drawing)
    const now = Date.now();
    if (now - lastTrackMoveUpdate < trackThrottleDelay) {
        return;
    }
    lastTrackMoveUpdate = now;

    const mouseLatLng = e.latlng;

    // Check curvature constraint - use actual mouse position for preview, but check constraint for color
    const constraintCheck = checkCurvatureConstraint(trackPoints, mouseLatLng, trackMinCurvatureRadius);
    const isConstraintViolated = constraintCheck.violatesConstraint || false;

    // Always use actual mouse position for preview (no overshoot)
    const previewPoint = mouseLatLng;

    // Remove old preview line
    if (trackPreviewLine) {
        trackPreviewLine.removeFrom(map);
        trackPreviewLine = null;
    }

    const latestTrackPoints = [...trackPoints, previewPoint];

    // Remove old preview rails
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    // Remove old preview line and polygon (no longer needed - we use rails)
    if (trackPreviewLine) {
        trackPreviewLine.removeFrom(map);
        trackPreviewLine = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    if (latestTrackPoints.length >= 2) {
        try {
            const tempTrackPolygon = calculateRoadPolygon(latestTrackPoints, trackWidth);

            if (tempTrackPolygon && tempTrackPolygon.length >= 3) {
                // Render rails for the preview segment (last point to preview point)
                const previewSegmentPoints = [trackPoints[trackPoints.length - 1], previewPoint];
                const previewRails = renderTrackWithRails(previewSegmentPoints, true, {
                    trackWidth: trackWidth,
                    railColor: isConstraintViolated ? '#ff0000' : '#ff6600',
                    sleeperColor: isConstraintViolated ? '#cc0000' : '#cc6600'
                });
                if (previewRails) {
                    trackPreviewRailsLayer = previewRails;
                    trackPreviewRailsLayer.addTo(map);
                }

                // Find and highlight parcels affected by preview (also updates stats)
                findTrackPreviewAffectedParcels(tempTrackPolygon);

                // Update road info with preview metrics (length and area only, stats already updated above)
                updateRoadInfoWithPreview(latestTrackPoints, tempTrackPolygon);
            } else {
                clearTrackPreviewAffectedParcels();
            }
        } catch (error) {
            console.error('Error in track preview calculation:', error);
            clearTrackPreviewAffectedParcels();
        }
    }
}

// Handle track mouse movement out
function handleTrackMouseOut(e) {
    if (!trackDrawingMode) return;

    if (trackPreviewLine) {
        trackPreviewLine.removeFrom(map);
        trackPreviewLine = null;
    }

    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    clearTrackPreviewAffectedParcels();
}

// Find parcels affected by track
function findTrackAffectedParcels(trackPolygon) {
    if (!trackPolygon || !parcelLayer) return;

    // Create a turf polygon from the track polygon (same approach as roads)
    const trackLatLngs = trackPolygon.map(p => [p.lng, p.lat]);

    // Check if we have enough points to form a valid polygon
    if (trackLatLngs.length < 4) {
        // If we don't have enough points, create a small square around the points
        const center = trackLatLngs[0];
        const offset = 0.0001; // Small offset in degrees
        trackLatLngs.length = 0; // Clear the array
        trackLatLngs.push(
            [center[0] - offset, center[1] - offset],
            [center[0] + offset, center[1] - offset],
            [center[0] + offset, center[1] + offset],
            [center[0] - offset, center[1] + offset],
            [center[0] - offset, center[1] - offset] // Close the polygon
        );
    } else {
        // Ensure the polygon is closed
        const closedTrackLatLngs = ensurePolygonIsClosed(trackLatLngs);
        if (closedTrackLatLngs.length !== trackLatLngs.length) {
            trackLatLngs.length = 0;
            trackLatLngs.push(...closedTrackLatLngs);
        }
    }

    let turfTrackPolygon;
    try {
        turfTrackPolygon = turf.polygon([trackLatLngs]);
    } catch (error) {
        console.warn('findTrackAffectedParcels: failed to create turf polygon', error, { trackLatLngs });
        // Don't clear trackAffectedParcels if polygon creation fails - preserve existing data
        // But still update stats to ensure UI is consistent
        const totalArea = trackAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
        if (trackAffectedParcels.length > 0) {
            setRoadParcelStats(trackAffectedParcels.length, formatParcelArea(totalArea));
        } else {
            setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
        }
        try {
            updateRoadOwnershipCounts(trackAffectedParcels);
            updateRoadMarketPrice(trackAffectedParcels);
        } catch (err) {
            console.warn('track stats: failed to update after polygon creation error', err);
        }
        return;
    }

    if (!turfTrackPolygon) {
        console.warn('findTrackAffectedParcels: turf polygon is null');
        return;
    }

    // Clear previously affected parcels (no style reset needed since we don't highlight)
    trackAffectedParcels = [];

    // Get current map bounds for filtering (but don't fail if unavailable)
    let mapBounds = null;
    try {
        mapBounds = map.getBounds();
    } catch (e) {
        console.warn('findTrackAffectedParcels: could not get map bounds', e);
    }

    // Check each parcel for intersection
    parcelLayer.eachLayer(layer => {
        // Skip parcels outside the current map view for performance (if bounds available)
        if (mapBounds) {
            try {
                const layerBounds = layer.getBounds();
                if (!mapBounds.intersects(layerBounds)) {
                    return; // Skip parcels outside view
                }
            } catch (e) {
                // Some layers might not have bounds, continue anyway
            }
        }

        const parcelId = layer.feature.properties.CESTICA_ID;
        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfTrackPolygon, turfParcelPolygon)) {
                    const parcelArea = Number(layer.feature.properties.calculatedArea) || 0;

                    trackAffectedParcels.push({
                        id: parcelId,
                        layer: layer,
                        area: parcelArea,
                        estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice
                    });

                    // No highlighting - we only collect parcels for stats
                    break;
                }
            }
        } catch (error) { }
    });

    // Update parcel stats
    const totalArea = trackAffectedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
    if (trackAffectedParcels.length > 0) {
        setRoadParcelStats(trackAffectedParcels.length, formatParcelArea(totalArea));
    } else {
        setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
    }
    try {
        updateRoadOwnershipCounts(trackAffectedParcels);
        updateRoadMarketPrice(trackAffectedParcels);
        updateRoadAcquiringDifficulty(trackAffectedParcels);
    } catch (err) {
        console.warn('track stats: failed to update ownership/market price', err);
    }

    updateRoadInfoPanel();
}

// Find parcels affected by track preview
function findTrackPreviewAffectedParcels(trackPolygon) {
    if (!trackPolygon || !parcelLayer) return;

    // Create a turf polygon from the track polygon (same approach as roads)
    const trackLatLngs = trackPolygon.map(p => [p.lng, p.lat]);

    // Check if we have enough points to form a valid polygon
    if (trackLatLngs.length < 4) {
        // If we don't have enough points, create a small square around the points
        const center = trackLatLngs[0];
        const offset = 0.0001; // Small offset in degrees
        trackLatLngs.length = 0; // Clear the array
        trackLatLngs.push(
            [center[0] - offset, center[1] - offset],
            [center[0] + offset, center[1] - offset],
            [center[0] + offset, center[1] + offset],
            [center[0] - offset, center[1] + offset],
            [center[0] - offset, center[1] - offset] // Close the polygon
        );
    } else {
        // Ensure the polygon is closed
        const closedTrackLatLngs = ensurePolygonIsClosed(trackLatLngs);
        if (closedTrackLatLngs.length !== trackLatLngs.length) {
            trackLatLngs.length = 0;
            trackLatLngs.push(...closedTrackLatLngs);
        }
    }

    let turfTrackPolygon;
    try {
        turfTrackPolygon = turf.polygon([trackLatLngs]);
    } catch (error) {
        // Silently return if polygon creation fails
        return;
    }

    // Track previously highlighted parcels to avoid unnecessary style changes
    // Store a map of parcel ID to parcel object for efficient lookup
    const previousPreviewParcelsMap = new Map(trackPreviewAffectedParcels.map(p => [p.id, p]));
    const newPreviewAffectedParcels = [];

    // Get current map bounds for filtering
    const mapBounds = map.getBounds();

    parcelLayer.eachLayer(layer => {
        // Skip parcels outside the current map view for performance
        try {
            const layerBounds = layer.getBounds();
            if (!mapBounds.intersects(layerBounds)) {
                return; // Skip parcels outside view
            }
        } catch (e) {
            // Some layers might not have bounds, continue anyway
        }

        const parcelId = layer.feature.properties.CESTICA_ID;
        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfTrackPolygon, turfParcelPolygon)) {
                    const area = layer.feature.properties.calculatedArea || 0;

                    // Only highlight if not already in committed list
                    if (!trackAffectedParcels.some(p => p.id === parcelId)) {
                        newPreviewAffectedParcels.push({
                            id: parcelId,
                            layer: layer,
                            area: area,
                            estimatedMarketPrice: layer.feature.properties.estimatedMarketPrice
                        });

                        // Always apply style - if already highlighted, setStyle is idempotent and won't cause flickering
                        layer.setStyle(previewAffectedStyle);
                        if (typeof layer.bringToFront === 'function') {
                            layer.bringToFront();
                        }
                    }
                    break;
                }
            }
        } catch (error) { }
    });

    // Clear highlighting for parcels that are no longer in preview
    const newPreviewParcelIds = new Set(newPreviewAffectedParcels.map(p => p.id));
    previousPreviewParcelsMap.forEach((previousParcel, parcelId) => {
        if (!newPreviewParcelIds.has(parcelId)) {
            // This parcel is no longer in preview, reset its style
            // But don't clear if it's in the committed list (though it shouldn't be)
            if (!trackAffectedParcels.some(p => p.id === parcelId)) {
                // Use the stored layer reference for efficiency
                const layer = previousParcel.layer;
                if (layer) {
                    const isMarkedAsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    layer.setStyle(isMarkedAsRoad ? roadStyle : normalStyle);
                }
            }
        }
    });

    // Update the preview affected parcels list
    trackPreviewAffectedParcels = newPreviewAffectedParcels;

    // Update the Set for fast O(1) lookups in resetHighlight
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set(newPreviewAffectedParcels.map(p => String(p.id)));
    }

    // Combine committed and preview parcels for stats
    const allAffectedParcels = [...trackAffectedParcels];
    const previewOnlyParcels = trackPreviewAffectedParcels.filter(p =>
        !trackAffectedParcels.some(committed => committed.id === p.id)
    );
    const combinedParcels = [...allAffectedParcels, ...previewOnlyParcels];

    // Update UI with PREVIEW count/area (takes precedence over committed during move)
    try {
        if (combinedParcels.length > 0) {
            const totalArea = combinedParcels.reduce((sum, p) => sum + (Number(p.area) || 0), 0);
            setRoadParcelStats(combinedParcels.length, formatParcelArea(totalArea));
        } else {
            setRoadParcelStats(0, translateRoadText('panel.road.parcelsNone', 'None'));
        }

        // Update ownership stats with combined parcels
        updateRoadOwnershipCounts(combinedParcels).catch(err => {
            console.warn('track ownership: failed to update stats in preview', err);
        });

        // Update market price with combined parcels
        updateRoadMarketPrice(combinedParcels);

        // Update acquiring difficulty with combined parcels
        updateRoadAcquiringDifficulty(combinedParcels);
    } catch (err) {
        console.warn('track stats: failed to update in preview', err);
    }
}

// Clear track affected parcels highlighting
function clearTrackAffectedParcels() {
    if (trackAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            if (trackAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = PersistentStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }
    trackAffectedParcels = [];
}

// Clear track preview affected parcels highlighting
function clearTrackPreviewAffectedParcels() {
    if (trackPreviewAffectedParcels.length > 0) {
        // Use Set for faster lookup
        const parcelIdsSet = new Set(trackPreviewAffectedParcels.map(p => String(p.id)));
        parcelLayer.eachLayer(layer => {
            const parcelId = String(layer.feature.properties.CESTICA_ID);
            if (parcelIdsSet.has(parcelId)) {
                // Reset to normal style (no blue highlighting since we removed it)
                const isMarkedAsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                layer.setStyle(isMarkedAsRoad ? roadStyle : normalStyle);
            }
        });
    }
    trackPreviewAffectedParcels = [];
    // Clear the Set for fast lookups
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set();
    }
}

// Finish track drawing
async function finishTrackDrawing() {
    if (!trackHasStarted || trackPoints.length < 2) return;

    // Immediately stop interactions and preview while finishing
    map.off('click', handleTrackClick);
    map.off('mousemove', handleTrackMouseMove);
    map.off('mouseout', handleTrackMouseOut);
    document.removeEventListener('keydown', handleTrackKeydown);

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    const trackPolygon = calculateRoadPolygon(trackPoints, trackWidth);
    if (!trackPolygon || trackPolygon.length < 3) {
        console.warn('finishTrackDrawing: invalid track polygon', { trackPolygon, trackPoints, trackWidth });
        showRoadAlert('invalid_track_shape_please_try_drawing_the_track_again', 'Invalid track shape. Please try drawing the track again.');
        exitTrackDrawingMode();
        return;
    }

    // Find affected parcels with the final track polygon
    // We need to check all parcels, not just those in view, so temporarily disable bounds filtering
    try {
        // Store original function if needed, but for now just call it
        // The function will check all parcels if map bounds are unavailable
        findTrackAffectedParcels(trackPolygon);

        // If still no parcels found, try without bounds filtering by ensuring map bounds check doesn't skip parcels
        if (trackAffectedParcels.length === 0) {
            console.warn('finishTrackDrawing: no parcels found with bounds filtering, retrying without bounds check');
            // Force re-check by temporarily making map bounds unavailable
            const originalGetBounds = map.getBounds;
            try {
                map.getBounds = () => { throw new Error('Temporarily disabled'); };
                findTrackAffectedParcels(trackPolygon);
            } finally {
                map.getBounds = originalGetBounds;
            }
        }
    } catch (error) {
        console.error('finishTrackDrawing: error finding affected parcels', error);
        showRoadAlert('error_finding_affected_parcels', 'Error finding affected parcels. Please try again.');
        exitTrackDrawingMode();
        return;
    }

    const affectedParcels = trackAffectedParcels;
    console.log('finishTrackDrawing: affected parcels count', affectedParcels.length);
    if (affectedParcels.length === 0) {
        console.warn('finishTrackDrawing: no affected parcels found', { trackPolygon, trackPoints });
        showRoadAlert('no_parcels_affected_by_this_track_please_try_drawing_the_track_again', 'No parcels affected by this track. Please try drawing the track again.');
        exitTrackDrawingMode();
        return;
    }

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = generateRandomTrackName();
    const defaultOffer = generateRandomRoadOffer(5000, 200000); // Tracks might have different price range

    let modalResult;
    try {
        modalResult = await showTrackProposalModal({
            defaultAuthor,
            defaultName,
            defaultOffer,
            affectedParcels,
            trackPolygon: trackPolygon,
            trackSpeed: trackSpeed,
            trackMinRadius: trackMinCurvatureRadius,
            trackWidth: trackWidth
        });
    } catch (_) {
        // User cancelled the modal; keep drawing state intact
        exitTrackDrawingMode();
        return;
    }

    const trackNameInput = (modalResult?.trackName || '').trim();
    const authorInput = (modalResult?.author || '').trim();
    const descriptionInput = (modalResult?.description || '').trim();
    const offerInputValue = typeof modalResult?.offer === 'number' ? modalResult.offer : NaN;
    const formState = modalResult?.form || {};
    const ownershipAndAcquisitionStats = modalResult?.ownershipAndAcquisitionStats || null;

    const finalTrackName = trackNameInput || defaultName;
    const finalAuthor = authorInput || defaultAuthor || 'User';
    const finalOffer = Number.isFinite(offerInputValue) && offerInputValue > 0 ? offerInputValue : defaultOffer;
    const finalDescription = descriptionInput || `Track proposal (speed: ${trackSpeed} km/h, min radius: ${trackMinCurvatureRadius}m)`;

    // --- Create a Proposal ---
    // 1. Get the full GeoJSON features of parent parcels
    const parentFeatures = affectedParcels.map(p => {
        // We need a deep copy so the original features in parcelLayer are not mutated
        // Use safe cloning to avoid circular reference errors
        const feature = p.layer.feature;
        if (!feature) return null;

        // Clone the feature safely by extracting only GeoJSON properties
        try {
            return {
                type: feature.type || 'Feature',
                properties: feature.properties ? { ...feature.properties } : {},
                geometry: feature.geometry ? {
                    type: feature.geometry.type,
                    coordinates: JSON.parse(JSON.stringify(feature.geometry.coordinates))
                } : null
            };
        } catch (error) {
            console.warn('finishTrackDrawing: failed to clone feature', error, p);
            return null;
        }
    }).filter(f => f !== null);

    // 2. Create the proposal
    const proposalApi = (typeof Proposals !== 'undefined' && Proposals.manager) ? Proposals.manager : ProposalManager;
    const proposalMetadata = {
        author: finalAuthor,
        offer: finalOffer,
        description: finalDescription,
        isTrack: true,
        trackSpeed: trackSpeed,
        trackMinRadius: trackMinCurvatureRadius
    };
    if (ownershipAndAcquisitionStats) {
        proposalMetadata.ownershipAndAcquisitionStats = ownershipAndAcquisitionStats;
    }
    const proposal = proposalApi.createProposal({
        name: finalTrackName,
        type: 'road', // Using road type for now
        definition: {
            points: trackPoints,
            width: trackWidth,
            metadata: proposalMetadata
        },
        parentFeatures: parentFeatures,
        author: finalAuthor,
        description: finalDescription,
        offer: finalOffer,
        budget: finalOffer
    });

    // 3. Do NOT apply the proposal automatically - user must use the apply button
    if (!proposal || !proposal.proposalHash) {
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to create track proposal. Please try again.', 5000, 'error');
        }
        exitTrackDrawingMode();
        return;
    }

    // Ensure proposal is saved to storage
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') {
        try {
            proposalStorage.save();
        } catch (err) {
            console.warn('Failed to save track proposal to storage', err);
        }
    }

    // Update show proposals button
    if (typeof updateShowProposalsButton === 'function') {
        updateShowProposalsButton();
    }

    // 4. Clean up the track drawing UI and exit drawing mode
    exitTrackDrawingMode();

    // 5. Show the newly created proposal details with full highlighting and focusing
    // Use a small delay to ensure proposal is fully stored and indexed
    setTimeout(() => {
        // Clear any remaining track highlighting before showing proposal details
        // This prevents duplicate highlighting when the proposal details modal opens
        clearTrackPreviewAffectedParcels();
        if (trackAffectedParcels.length > 0 && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const parcelId = layer.feature.properties.CESTICA_ID;
                if (trackAffectedParcels.some(p => p.id === parcelId)) {
                    // Reset to normal style - proposal highlighting will be applied by selectAndHighlightProposal
                    const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    layer.setStyle(isRoad ? roadStyle : normalStyle);
                }
            });
            trackAffectedParcels = [];
        }

        try {
            let hydratedProposal = proposal;
            if (proposal && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const lookupKey = proposal.proposalHash || proposal.proposalId || proposal.id;
                const stored = lookupKey ? proposalStorage.getProposal(lookupKey) : null;
                if (stored) {
                    hydratedProposal = stored;
                } else if (!proposal.parcelIds && Array.isArray(proposal.parentFeatures)) {
                    // Fallback: derive parcelIds from parent features if storage lookup failed
                    hydratedProposal = { ...proposal, parcelIds: proposal.parentFeatures.map(f => f?.properties?.CESTICA_ID).filter(Boolean) };
                }
            }

            // Use selectAndHighlightProposal to get full highlighting and focusing behavior
            // This will clear any existing highlights and apply the proposal highlighting
            if (typeof selectAndHighlightProposal === 'function') {
                const proposalIdOrHash = hydratedProposal.proposalHash || hydratedProposal.proposalId || hydratedProposal.id;
                const parcelIds = Array.isArray(hydratedProposal.parcelIds) ? hydratedProposal.parcelIds : [];
                const focusParcelId = parcelIds.length > 0 ? parcelIds[0] : null;
                selectAndHighlightProposal(proposalIdOrHash, focusParcelId, true, true);
            } else if (typeof showProposalInfo === 'function') {
                // Fallback to showProposalInfo if selectAndHighlightProposal is not available
                showProposalInfo(hydratedProposal);
            }
        } catch (err) {
            console.warn('Unable to show proposal details after creation', err);
        }
    }, 100);

    if (typeof updateStatus === 'function') {
        updateStatus(`Track proposal "${finalTrackName}" created. Use the Apply button to apply it to the map.`);
    }
    if (typeof showEphemeralMessage === 'function') {
        showEphemeralMessage(`Track proposal "${finalTrackName}" created successfully.`, 3000, 'success');
    }
}

// Cancel track drawing
function cancelTrackDrawing() {
    resetTrackDrawing();
    toggleTrackDrawTool();
}

// Exit track drawing mode
function exitTrackDrawingMode() {
    map.off('click', handleTrackClick);
    map.off('mousemove', handleTrackMouseMove);
    map.off('mouseout', handleTrackMouseOut);
    document.removeEventListener('keydown', handleTrackKeydown);

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }
    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }
    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    resetTrackDrawing();
    trackDrawingMode = false;

    const trackDrawButton = document.getElementById('trackDrawButton');
    if (trackDrawButton) {
        trackDrawButton.classList.remove('active');
        trackDrawButton.classList.remove('active-black-border');
    }

    const roadDrawingControls = document.getElementById('road-drawing-controls');
    if (roadDrawingControls) roadDrawingControls.style.display = 'none';

    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        roadInfoPanel.classList.remove('visible');
    }

    map.getContainer().style.cursor = '';
    map.getContainer().classList.remove('crosshairs-cursor');

    if (parcelLayer) {
        try {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
                if (typeof getCorrectClickHandler === 'function') {
                    layer.on('click', getCorrectClickHandler());
                }
            });
        } catch (_) { }
    }

    const statusElement = document.getElementById('status');
    if (statusElement) updateStatus('');
}

// Reset track drawing variables
function resetTrackDrawing(hidePanel = true) {
    trackPoints = [];
    trackHasStarted = false;
    trackAffectedParcels = [];

    if (trackCenterline) {
        map.removeLayer(trackCenterline);
        trackCenterline = null;
    }

    if (trackRailsLayer) {
        map.removeLayer(trackRailsLayer);
        trackRailsLayer = null;
    }

    if (trackPolygonLayer && map.hasLayer(trackPolygonLayer)) {
        map.removeLayer(trackPolygonLayer);
        trackPolygonLayer = null;
    }
    trackPolygon = null;

    if (trackPreviewLine) {
        map.removeLayer(trackPreviewLine);
        trackPreviewLine = null;
    }

    if (trackPreviewRailsLayer) {
        map.removeLayer(trackPreviewRailsLayer);
        trackPreviewRailsLayer = null;
    }

    if (trackPreviewPolygonLayer) {
        trackPreviewPolygonLayer.removeFrom(map);
        trackPreviewPolygonLayer = null;
    }

    for (const marker of trackMarkers) {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    }
    trackMarkers = [];

    if (hidePanel) {
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) {
            roadInfoPanel.classList.remove('visible');
        }
    }

    clearTrackAffectedParcels();
    clearTrackPreviewAffectedParcels();

    // Initialize Set for fast lookups
    if (typeof window !== 'undefined') {
        window.trackPreviewAffectedParcelIds = new Set();
    }
}

// Expose renderTrackWithRails globally for use in other modules
if (typeof window !== 'undefined') {
    window.renderTrackWithRails = renderTrackWithRails;
    // Expose trackPreviewAffectedParcels so other modules can check if a parcel is in track preview
    Object.defineProperty(window, 'trackPreviewAffectedParcels', {
        get: function () { return trackPreviewAffectedParcels; }
    });
}

// Show dialog with acquiring difficulty explanation
function showAcquiringDifficultyDialog() {
    if (typeof document === 'undefined') return;

    const t = translateRoadText;
    const title = t('panel.road.acquiringDifficultyLabel', 'TEAD:');
    const explanation = t('panel.road.acquiringDifficultyTooltip', 'Smaller is better. The acquiring difficulty is calculated based on ownership type of properties involved, with these coefficients:\nGovernment: 0\nInstitution: 0\nCompany: 1\nIndividual: 2\nThe market value of each parcel is multiplied by its ownership type and all these are summed.');
    const okLabel = t('panel.road.acquiringDifficultyDialogOk', 'OK');

    // Format explanation: split by newlines and format as paragraphs/list
    const parts = explanation.split('\n');
    const intro = parts[0] || '';
    const coefficients = parts.slice(1).filter(line => line.trim());

    let formattedExplanation = `<p>${intro}</p>`;
    if (coefficients.length > 0) {
        formattedExplanation += '<ul>';
        coefficients.forEach(coeff => {
            formattedExplanation += `<li>${coeff}</li>`;
        });
        formattedExplanation += '</ul>';
    }

    const overlay = document.createElement('div');
    overlay.className = 'info-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'info-modal';

    const header = document.createElement('div');
    header.className = 'info-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'info-modal-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'info-modal-close';
    closeBtn.setAttribute('aria-label', okLabel);
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'info-modal-body';
    bodyContainer.innerHTML = formattedExplanation;
    modal.appendChild(bodyContainer);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'info-modal-actions';

    const okButton = document.createElement('button');
    okButton.type = 'button';
    okButton.className = 'btn info-modal-primary';
    okButton.textContent = okLabel;
    okButton.addEventListener('click', closeModal);
    actionsContainer.appendChild(okButton);

    modal.appendChild(actionsContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onOverlayClick(event) {
        if (event.target === overlay) {
            closeModal();
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            closeModal();
        }
    }

    function closeModal() {
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);
}

// Expose function globally
if (typeof window !== 'undefined') {
    window.showAcquiringDifficultyDialog = showAcquiringDifficultyDialog;
}

