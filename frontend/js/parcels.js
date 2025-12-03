/*
    This file contains various parcel-related functionality.
    It is used to locate parcels, show parcel info, toggle parcel numbers
    and other related functionality.
*/

// --- Parcel Layer Styles ---
const ParcelCityConfigManager = window.CityConfigManager || null;
function getCurrentCityId() {
    if (!ParcelCityConfigManager || typeof ParcelCityConfigManager.getCurrentCityId !== 'function') {
        return 'zagreb';
    }
    return ParcelCityConfigManager.getCurrentCityId();
}

let CURRENT_CITY_ID = getCurrentCityId();
if (typeof window !== 'undefined') {
    window.addEventListener('cityChanged', () => {
        CURRENT_CITY_ID = getCurrentCityId();
    });
}
const PARCELS_LATLNG_PADDING = ParcelCityConfigManager ? ParcelCityConfigManager.getLatLngPadding() : 0.12;
const PARCELS_GRID_SIZE = ParcelCityConfigManager ? ParcelCityConfigManager.getParcelGridSize() : 500;
function supportsOssOwnership() {
    return getCurrentCityId() === 'zagreb';
}

const roadStyle = {
    fillColor: '#00ff00',
    fillOpacity: 0.2,
    color: '#00ff00',
    weight: 1
};
const normalStyle = {
    fillColor: 'red',
    fillOpacity: 0.2,
    color: 'red',
    weight: 1
};
const selectedParcelStyle = {
    fillColor: '#ff3300',
    fillOpacity: 0.4,
    color: '#ff3300',
    weight: 4,
    opacity: 1,
    dashArray: ''
};

const appliedProposalStyleTemplate = {
    color: normalStyle.color,
    weight: normalStyle.weight,
    opacity: normalStyle.opacity !== undefined ? normalStyle.opacity : 1,
    dashArray: normalStyle.dashArray || '',
    fillColor: normalStyle.fillColor,
    fillOpacity: 0
};

let parcelsWithAppliedSpatialProposals = new Set();

function createAppliedProposalStyle() {
    return { ...appliedProposalStyleTemplate };
}

function parcelHasAppliedSpatialProposal(parcelId) {
    if (parcelId === undefined || parcelId === null) return false;
    return parcelsWithAppliedSpatialProposals.has(parcelId.toString());
}

function getParcelBaseStyle(parcelId, options = {}) {
    const { isRoad: isRoadOverride } = options || {};
    const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
    const roadFlag = typeof isRoadOverride === 'boolean'
        ? isRoadOverride
        : (idStr ? isRoad(idStr) : false);
    if (roadFlag) {
        return { ...roadStyle };
    }
    if (idStr && parcelHasAppliedSpatialProposal(idStr)) {
        return createAppliedProposalStyle();
    }
    return { ...normalStyle };
}

function recomputeParcelsWithAppliedSpatialProposals() {
    const result = new Set();
    if (typeof proposalStorage !== 'undefined' && proposalStorage && typeof proposalStorage.getAllProposals === 'function') {
        try {
            const proposals = proposalStorage.getAllProposals();
            proposals.forEach(proposal => {
                if (!proposal) return;
                const status = (proposal.status || '').toLowerCase();
                const parcelIds = [];
                const buildingProposal = proposal.buildingProposal || null;
                if (buildingProposal) {
                    const buildingStatus = (buildingProposal.status || status).toLowerCase();
                    if (buildingStatus === 'applied' || buildingStatus === 'executed') {
                        const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
                            ? buildingProposal.parentParcelIds
                            : proposal.parcelIds;
                        if (Array.isArray(ids)) parcelIds.push(...ids);
                    }
                } else if ((proposal.type === 'building' || proposal.buildingGeometry) && (status === 'applied' || status === 'executed')) {
                    if (Array.isArray(proposal.parcelIds)) parcelIds.push(...proposal.parcelIds);
                }

                const structureProposal = proposal.structureProposal || null;
                if (structureProposal) {
                    const kind = (structureProposal.kind || '').toLowerCase();
                    const structureStatus = (structureProposal.status || status).toLowerCase();
                    if ((kind === 'park' || kind === 'square') && (structureStatus === 'applied' || structureStatus === 'executed')) {
                        const ids = Array.isArray(structureProposal.parentParcelIds) && structureProposal.parentParcelIds.length > 0
                            ? structureProposal.parentParcelIds
                            : proposal.parcelIds;
                        if (Array.isArray(ids)) parcelIds.push(...ids);
                    }
                }

                parcelIds
                    .filter(id => id !== undefined && id !== null)
                    .forEach(id => result.add(id.toString()));
            });
        } catch (error) {
            console.warn('recomputeParcelsWithAppliedSpatialProposals failed', error);
        }
    }
    parcelsWithAppliedSpatialProposals = result;
    return result;
}

function refreshParcelStylesForAppliedProposals() {
    recomputeParcelsWithAppliedSpatialProposals();
    if (!parcelLayer) return;

    const selectedId = selectedParcelId ? selectedParcelId.toString() : null;
    const hasMultiSelection = typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.isActive;

    parcelLayer.eachLayer(layer => {
        const parcelId = layer?.feature?.properties?.CESTICA_ID;
        if (parcelId === undefined || parcelId === null) return;
        const idStr = parcelId.toString();

        if (selectedId && idStr === selectedId) {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
            return;
        }

        if (hasMultiSelection && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.has(idStr)) {
            layer.setStyle({
                fillColor: '#ff9800',
                fillOpacity: 0.6,
                color: '#f57c00',
                weight: 3
            });
            return;
        }

        const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
            layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
            return;
        }

        layer.setStyle(getParcelBaseStyle(idStr));
    });

    if (hasMultiSelection && typeof multiParcelSelection.reapplyMultiParcelHighlights === 'function') {
        multiParcelSelection.reapplyMultiParcelHighlights();
    }

    if (typeof rehighlightSelectedBlockParcels === 'function') {
        rehighlightSelectedBlockParcels();
    }

    if (selectedId) {
        const selectedLayer = parcelLayer.getLayers().find(layer =>
            layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === selectedId
        );
        if (selectedLayer) {
            selectedLayer.setStyle(selectedParcelStyle);
            selectedLayer.bringToFront();
        }
    }
}

// Make selectedParcelStyle globally available
window.selectedParcelStyle = selectedParcelStyle;

/**
 * Focus on a proposal when clicked from parcel info panel
 * @param {string} proposalHash - The proposal hash to focus on
 */
function focusOnProposal(proposalHash) {
    // Do not force proposals mode; keep normal interactions available

    // Focus on the proposal immediately - the unified function handles proper sequencing
    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (proposal && proposal.parcelIds && proposal.parcelIds.length > 0) {
            selectAndHighlightProposal(proposalHash, proposal.parcelIds[0], true);
        }
    } else if (typeof centerOnProposal === 'function') {
        // Fallback to old function
        centerOnProposal(proposalHash);
    }
}

// Make focusOnProposal globally available
window.focusOnProposal = focusOnProposal;

/**
 * Handle user accepting a proposal from the parcel info panel
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
async function acceptProposalFromParcelInfo(proposalHash, parcelId, ownerKey = null, options = {}) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    const skipParcelPanelFocus = normalizedOptions.skipParcelPanelFocus === true;
    let effectiveOwnerKey = ownerKey;
    if (!effectiveOwnerKey && typeof ensureParcelOwnerSlots === 'function') {
        const slots = await ensureParcelOwnerSlots(parcelId);
        if (Array.isArray(slots) && slots.length === 1) {
            effectiveOwnerKey = slots[0].key;
        }
    }

    if (typeof handleUserAcceptProposal === 'function') {
        await handleUserAcceptProposal(proposalHash, parcelId, effectiveOwnerKey);
    }

    if (!skipParcelPanelFocus) {
        setTimeout(() => {
            const parcel = typeof parcelLayer !== 'undefined' && parcelLayer ?
                parcelLayer.getLayers().find(layer => {
                    return layer.feature && layer.feature.properties &&
                        layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
                }) : null;

            if (parcel) {
                showParcelInfoPanel(parcel.feature);
            }
        }, 100);
    }
}

/**
 * Handle user rejecting a proposal from the parcel info panel
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
async function rejectProposalFromParcelInfo(proposalHash, parcelId, ownerKey = null, options = {}) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    const skipParcelPanelFocus = normalizedOptions.skipParcelPanelFocus === true;

    if (typeof handleUserRejectProposal === 'function') {
        await handleUserRejectProposal(proposalHash, parcelId, ownerKey);
    } else if (typeof rejectProposal === 'function') {
        // Fallback to legacy behavior
        await rejectProposal(proposalHash, parcelId, ownerKey);
    }

    if (!skipParcelPanelFocus) {
        setTimeout(() => {
            const parcel = typeof parcelLayer !== 'undefined' && parcelLayer ?
                parcelLayer.getLayers().find(layer => {
                    return layer.feature && layer.feature.properties &&
                        layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
                }) : null;

            if (parcel) {
                showParcelInfoPanel(parcel.feature);
            }
        }, 100);
    }
}

/**
 * Show proposal details panel when Details button is clicked
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
function showProposalDetails(proposalHash, parcelId) {
    // 1. Close the Parcel Info panel
    hideParcelInfoPanel();

    // 2. Select the proposal and show its details immediately
    if (typeof selectAndHighlightProposal === 'function') {
        selectAndHighlightProposal(proposalHash, parcelId, true);
    } else if (typeof selectProposalFromList === 'function') {
        // Fallback to old function
        selectProposalFromList(proposalHash, parcelId);
    }
}

/**
 * Switch between tabs in the parcel info panel
 * @param {HTMLElement} tabButton - The clicked tab button
 * @param {string} tabId - The ID of the tab content to show
 */
function switchParcelTab(tabButton, tabId) {
    // Remove active class from all tab buttons
    const tabButtons = document.querySelectorAll('.parcel-tab-btn');
    tabButtons.forEach(btn => btn.classList.remove('active'));

    // Add active class to clicked button
    tabButton.classList.add('active');

    // Hide all tab contents
    const tabContents = document.querySelectorAll('.parcel-tab-content');
    tabContents.forEach(content => content.classList.remove('active'));

    // Show selected tab content
    const selectedTab = document.getElementById(tabId);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }

    if (tabId === 'tools-tab') {
        triggerParcelToolsTabActivated();
    }
}

// Make these functions globally available
window.acceptProposalFromParcelInfo = acceptProposalFromParcelInfo;
window.rejectProposalFromParcelInfo = rejectProposalFromParcelInfo;
window.showProposalDetails = showProposalDetails;
window.switchParcelTab = switchParcelTab;

// --- Parcel Layer State ---
let parcelLayer = null;
let selectedParcelId = null;
let currentParcel = null;
let currentParcelCoordinates = null;
let currentParcelMintStatusCache = null;
let currentParcelMintStatusPromise = null;
let currentParcelMintStatusParcelId = null;
let splitLayer = null;
let parcelsTimeout;
const PARCEL_FETCH_LATLNG_PADDING = PARCELS_LATLNG_PADDING;
const PARCEL_FETCH_DEBOUNCE_MS = 500;
const PARCEL_FETCH_GRID_RADIUS = 1;

const parcelCache = {
    grid: new Map(),  // Key: "easting,northing" grid cell, Value: { data: [] }
    gridSize: PARCELS_GRID_SIZE     // Size in meters (city projection coordinates)
};
const parcelLayerIndex = new Map();
let parcelLayerIndexVersion = 0;
let isFetchingParcels = false;
let parcelCoverageVersion = 0;
let parcelMergeInProgress = false;
const PARCEL_OWNER_VALUE_ELEMENT_ID = 'parcel-owner-value';
const parcelOwnerDataCache = new Map();
let parcelOwnerRequestSequence = 0;
let suppressOwnerAcceptanceRefresh = false;
const OSS_PUBLIC_ACCESS_TOKEN = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
const OSS_OWNERSHIP_ENDPOINT = 'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info';
const OSS_OWNERSHIP_PROXY_TARGETS = [
    'https://api.allorigins.win/raw?url=',
    'https://thingproxy.freeboard.io/fetch/',
    'https://corsproxy.io/?',
    'direct'
];
const FRACTION_REGEX = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

function setParcelMergeInProgressState(inProgress) {
    const next = !!inProgress;
    if (parcelMergeInProgress === next) {
        return;
    }
    parcelMergeInProgress = next;
    if (typeof window !== 'undefined') {
        window.parcelMergeInProgress = parcelMergeInProgress;
    }
    const eventName = parcelMergeInProgress ? 'parcelMergeStarted' : 'parcelMergeFinished';
    try {
        window.dispatchEvent(new CustomEvent(eventName, {
            detail: {
                timestamp: Date.now()
            }
        }));
    } catch (_) { }
}

if (typeof window !== 'undefined') {
    window.PARCEL_FETCH_GRID_RADIUS = PARCEL_FETCH_GRID_RADIUS;
    window.PARCEL_FETCH_GRID_PADDING = PARCEL_FETCH_GRID_RADIUS; // legacy name retained
    window.PARCEL_FETCH_LATLNG_PADDING = PARCEL_FETCH_LATLNG_PADDING;
    window.PARCEL_FETCH_DEBOUNCE_MS = PARCEL_FETCH_DEBOUNCE_MS;
    window.parcelCoverageVersion = parcelCoverageVersion;
    window.parcelLayerIndexVersion = parcelLayerIndexVersion;
    window.isParcelMergeInProgress = () => parcelMergeInProgress;
    window.parcelMergeInProgress = parcelMergeInProgress;
}

// --- Helper Functions ---

/**
 * Fetches a URL with a specified number of retries on failure.
 * @param {string} url The URL to fetch.
 * @param {object} options Fetch options.
 * @param {number} retries Number of retries.
 * @param {number} delay Delay between retries in ms.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                if (i > 0) {
                    console.log(`Successfully fetched ${url} after ${i + 1} attempts.`);
                }
                return response;
            }
            if (response.status >= 400 && response.status < 500) {
                // Don't retry on client errors
                lastError = new Error(`Failed to fetch parcel data with client error: ${response.status}`);
                break;
            }
            lastError = new Error(`Server error: ${response.status}`);
            console.warn(`Attempt ${i + 1} for ${url} failed with status ${response.status}. Retrying...`);
        } catch (error) {
            lastError = error;
            console.warn(`Attempt ${i + 1} for ${url} failed with error: ${error.message}. Retrying...`);
        }
        if (i < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

function isGameModeActive() {
    return typeof gameState !== 'undefined' && gameState && !!gameState.isRunning;
}

function shouldUseRealParcelOwners() {
    if (isGameModeActive()) {
        return false;
    }
    if (typeof getCurrentDataSource !== 'function') {
        return false;
    }
    const source = getCurrentDataSource();
    return source === 'oss.uredjenazemlja.hr'
        || source === 'localhost'
        || source === 'api.urbangametheory.xyz';
}

function parseFraction(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }
    const match = value.match(FRACTION_REGEX);
    if (!match) {
        return null;
    }
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
    }
    return { numerator, denominator };
}

function simplifyFraction(fraction) {
    if (!fraction || !Number.isFinite(fraction.numerator) || !Number.isFinite(fraction.denominator) || fraction.denominator === 0) {
        return null;
    }
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const divisor = Math.abs(gcd(Math.abs(fraction.numerator), Math.abs(fraction.denominator))) || 1;
    return {
        numerator: fraction.numerator / divisor,
        denominator: fraction.denominator / divisor
    };
}

function formatFraction(fraction) {
    const simplified = simplifyFraction(fraction);
    if (!simplified) {
        return '';
    }
    return `${simplified.numerator}/${simplified.denominator}`;
}

function multiplyFractions(a, b) {
    if (!a || !b) {
        return null;
    }
    return {
        numerator: a.numerator * b.numerator,
        denominator: a.denominator * b.denominator
    };
}

function computeCondominiumSharePortion(ownershipFraction, condoFraction) {
    if (!condoFraction) {
        return { display: '', detail: '' };
    }

    let product = condoFraction;
    let detail = '';
    const condoText = formatFraction(condoFraction);

    if (ownershipFraction) {
        product = multiplyFractions(ownershipFraction, condoFraction) || condoFraction;
        if (ownershipFraction.numerator !== ownershipFraction.denominator) {
            const ownershipText = formatFraction(ownershipFraction);
            if (ownershipText && condoText) {
                detail = `${ownershipText} of ${condoText}`;
            }
        }
    }

    if (!product) {
        return { display: condoText || '', detail };
    }

    const baseDenominator = condoFraction.denominator;
    const combinedDenominator = product.denominator;
    if (baseDenominator && combinedDenominator % baseDenominator === 0) {
        const scale = combinedDenominator / baseDenominator;
        if (scale !== 0 && Number.isFinite(scale)) {
            const adjustedNumerator = product.numerator / scale;
            if (Number.isFinite(adjustedNumerator)) {
                return {
                    display: `${adjustedNumerator}/${baseDenominator}`,
                    detail
                };
            }
        }
    }

    return {
        display: formatFraction(product) || condoText || '',
        detail
    };
}

function buildSimulatedOwnerHtml(parcelId) {
    if (!parcelId || typeof PersistentStorage === 'undefined' || !PersistentStorage) {
        return '';
    }
    const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
    if (!ownerId) {
        return '';
    }

    if (typeof agentStorage === 'undefined' || !agentStorage) {
        return `<span style="color: #666;">Owner ${ownerId}</span>`;
    }

    const owner = agentStorage.getAgent(ownerId);
    if (!owner) {
        return `<span style="color: #666;">Agent not found (${ownerId})</span>`;
    }

    const safeName = typeof escapeHtml === 'function'
        ? escapeHtml(owner.name || '')
        : (owner.name || '');
    const avatarHtml = typeof getAvatarImagePath === 'function'
        ? `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="agent-avatar" style="width: 30px; height: 30px; border-radius: 50%; border: 2px solid #007bff;">`
        : '';

    return `
        <div class="parcel-owner" onclick="showAgentDialog('${owner.id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
            ${avatarHtml}
            <span class="owner-name" style="color: #007bff; font-weight: 500;">${safeName}</span>
        </div>
    `;
}

function buildRealOwnerRowsHtml(owners) {
    const normalizedOwners = Array.isArray(owners) && owners.length > 0
        ? owners
        : [{ name: 'Unknown owner', actualShareText: '100%', shareDetail: '', placeholder: true }];

    return normalizedOwners.map(owner => {
        const name = owner && owner.name ? owner.name.trim() : '';
        const share = owner && owner.actualShareText ? owner.actualShareText.trim() : '';
        const shareDetail = owner && owner.shareDetail ? owner.shareDetail.trim() : '';
        const safeName = typeof escapeHtml === 'function' ? escapeHtml(name) : name;
        const fallbackShare = owner && owner.placeholder ? '100%' : '';
        const safeShare = (share || fallbackShare)
            ? (typeof escapeHtml === 'function' ? escapeHtml(share || fallbackShare) : (share || fallbackShare))
            : '';
        const safeDetail = shareDetail ? (typeof escapeHtml === 'function' ? escapeHtml(shareDetail) : shareDetail) : '';
        const shareHtml = safeShare
            ? `<span style="color: #666; font-size: 0.9em;"${safeDetail ? ` title="${safeDetail}"` : ''}>${safeShare}</span>`
            : '';
        return `
            <div class="owner-row" style="display: flex; justify-content: space-between; gap: 8px;">
                <span>${safeName || 'Unknown owner'}</span>
                ${shareHtml}
            </div>
        `;
    }).join('');
}

function buildOwnerSlotKey(parcelId, ownerRecord, index) {
    const baseId = parcelId ? parcelId.toString().trim() : 'parcel';
    const condoNumber = ownerRecord && ownerRecord.condoShareNumber
        ? ownerRecord.condoShareNumber.toString().trim()
        : null;
    if (condoNumber) {
        return `oss:${baseId}:condo:${condoNumber}`;
    }

    const name = ownerRecord && ownerRecord.name ? ownerRecord.name.trim().toLowerCase() : '';
    const share = ownerRecord && ownerRecord.actualShareText ? ownerRecord.actualShareText.trim().toLowerCase() : '';
    let normalizedName = (name.replace(/\s+/g, '_') || `owner_${index}`).replace(/[^a-z0-9_\-]/g, '');
    if (!normalizedName) {
        normalizedName = `owner_${index}`;
    }
    let normalizedShare = (share.replace(/\s+/g, '') || `share_${index}`).replace(/[^a-z0-9]/g, '');
    if (!normalizedShare) {
        normalizedShare = `share_${index}`;
    }
    return `oss:${baseId}:${normalizedName}:${normalizedShare}`;
}

function mapOwnerRecordsToSlots(parcelId, owners) {
    if (!Array.isArray(owners) || owners.length === 0) {
        return [];
    }
    return owners.map((owner, index) => {
        const slotKey = buildOwnerSlotKey(parcelId, owner, index);
        return {
            key: slotKey,
            displayName: owner && owner.name ? owner.name.trim() : `Owner ${index + 1}`,
            shareText: owner && owner.actualShareText ? owner.actualShareText.trim() : (owner.ownership || owner.condoShare || ''),
            shareDetail: owner && owner.shareDetail ? owner.shareDetail.trim() : '',
            type: 'oss',
            agentId: null,
            source: 'oss',
            placeholder: false
        };
    });
}

function buildSimulatedOwnerSlot(parcelId) {
    const parcelKey = parcelId ? parcelId.toString() : '';
    const ownerId = (typeof PersistentStorage !== 'undefined' && PersistentStorage)
        ? PersistentStorage.getItem(`parcel_${parcelKey}_owner`)
        : null;
    let displayName = 'Unknown owner';
    if (ownerId && typeof agentStorage !== 'undefined') {
        const agent = agentStorage.getAgent(ownerId);
        displayName = agent && agent.name ? agent.name : ownerId;
    } else if (ownerId) {
        displayName = ownerId;
    }
    return {
        key: ownerId ? `agent:${ownerId}` : `parcel:${parcelKey || 'unknown'}:owner`,
        displayName,
        shareText: '100%',
        shareDetail: '',
        type: ownerId ? 'agent' : 'unknown',
        agentId: ownerId || null,
        source: ownerId ? 'simulation' : 'unknown',
        placeholder: !ownerId
    };
}

function getParcelOwnerSlots(parcelId, options = {}) {
    const useRealOwners = options.forceSimulated ? false : shouldUseRealParcelOwners();
    const cacheKey = parcelId ? parcelId.toString() : '';
    if (useRealOwners && cacheKey && parcelOwnerDataCache.has(cacheKey)) {
        const owners = parcelOwnerDataCache.get(cacheKey) || [];
        const slots = mapOwnerRecordsToSlots(cacheKey, owners);
        if (slots.length > 0) {
            return slots;
        }
    }
    return [buildSimulatedOwnerSlot(parcelId)];
}

async function ensureParcelOwnerSlots(parcelId, options = {}) {
    const cacheKey = parcelId ? parcelId.toString() : '';
    if (!cacheKey) {
        return getParcelOwnerSlots(parcelId, options);
    }
    const useRealOwners = options.forceSimulated ? false : shouldUseRealParcelOwners();
    if (useRealOwners && (!parcelOwnerDataCache.has(cacheKey) || options.forceRefresh)) {
        try {
            await getRealParcelOwners(cacheKey);
        } catch (error) {
            console.warn('ensureParcelOwnerSlots: unable to fetch real owners', error);
        }
    }
    return getParcelOwnerSlots(parcelId, options);
}

if (typeof window !== 'undefined') {
    window.getParcelOwnerSlots = getParcelOwnerSlots;
    window.ensureParcelOwnerSlots = ensureParcelOwnerSlots;
}

function extractOwnersFromOwnershipPayload(payload) {
    const owners = [];
    const seen = new Set();
    const sheets = Array.isArray(payload && payload.possessionSheets) ? payload.possessionSheets : [];

    sheets.forEach(sheet => {
        const possessors = Array.isArray(sheet && sheet.possessors) ? sheet.possessors : [];
        possessors.forEach(possessor => {
            if (!possessor || !possessor.name) {
                return;
            }
            const name = (possessor.name || '').trim();
            if (!name) {
                return;
            }
            const ownership = (possessor.ownership || '').trim();
            const condoShare = (possessor.condominiumShareOwnership || '').trim();
            const condoShareNumber = (possessor.condominiumShareNumber || '').trim();
            const ownershipFraction = parseFraction(ownership);
            const condoFraction = parseFraction(condoShare);
            const sharePortion = computeCondominiumSharePortion(ownershipFraction, condoFraction);
            let actualShareText = sharePortion.display || condoShare || ownership;
            let shareDetail = sharePortion.detail;
            const address = (possessor.address || '').trim();

            const key = `${name}|${ownership}|${condoShare}|${condoShareNumber}|${address}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            owners.push({
                name,
                ownership,
                condoShare,
                actualShareText: actualShareText || ownership || condoShare,
                shareDetail,
                condoShareNumber,
                address
            });
        });
    });

    return owners;
}

async function fetchOwnersFromBackend(parcelId) {
    if (typeof getBackendBase !== 'function') {
        throw new Error('Backend base helper unavailable for ownership lookup');
    }
    const backendBase = getBackendBase();
    if (!backendBase) {
        throw new Error('Backend base is not configured');
    }

    const normalizedCityId = getCurrentCityId();
    const path = normalizedCityId === 'buenos_aires'
        ? `/parcel-ba/${encodeURIComponent(parcelId)}/ownership`
        : `/parcels/${encodeURIComponent(parcelId)}/ownership`;
    const url = `${backendBase.replace(/\/$/, '')}${path}`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const error = new Error(`Backend ownership lookup failed (${response.status})`);
        error.statusCode = response.status;
        throw error;
    }

    const payload = await response.json();
    return extractOwnersFromOwnershipPayload(payload);
}

function buildOssOwnershipRequestUrls(parcelId) {
    const normalizedParcelId = (parcelId || '').toString().trim();
    if (!normalizedParcelId) {
        return [];
    }

    const base = new URL(OSS_OWNERSHIP_ENDPOINT);
    base.searchParams.set('parcelId', normalizedParcelId);
    if (OSS_PUBLIC_ACCESS_TOKEN) {
        base.searchParams.set('token', OSS_PUBLIC_ACCESS_TOKEN);
    }
    const fullUrl = base.toString();

    return OSS_OWNERSHIP_PROXY_TARGETS.map(target => {
        if (target === 'direct') {
            return fullUrl;
        }
        if (target.endsWith('fetch/')) {
            return `${target}${fullUrl}`;
        }
        return `${target}${encodeURIComponent(fullUrl)}`;
    });
}

async function getRealParcelOwners(parcelId) {
    const cacheKey = parcelId ? parcelId.toString() : '';
    if (!cacheKey) {
        return [];
    }

    if (parcelOwnerDataCache.has(cacheKey)) {
        return parcelOwnerDataCache.get(cacheKey);
    }

    if (!shouldUseRealParcelOwners()) {
        parcelOwnerDataCache.set(cacheKey, []);
        return [];
    }

    let owners;
    try {
        owners = await fetchOwnersFromBackend(cacheKey);
    } catch (backendError) {
        if (backendError && backendError.statusCode === 404) {
            console.info('Ownership data not found for parcel', cacheKey);
            owners = [];
        } else if (supportsOssOwnership() && typeof getCurrentDataSource === 'function' && getCurrentDataSource() === 'oss.uredjenazemlja.hr') {
            console.warn('Backend ownership lookup failed, attempting OSS fallback', backendError);
            owners = await fetchOwnersFromOss(cacheKey);
        } else {
            console.warn('Backend ownership lookup failed and no fallback is available in this city', backendError);
            owners = [];
        }
    }
    parcelOwnerDataCache.set(cacheKey, owners);
    return owners;
}

async function fetchOwnersFromOss(parcelId) {
    const candidates = buildOssOwnershipRequestUrls(parcelId);
    if (!candidates.length) {
        return [];
    }

    let payload = null;
    let lastError = null;
    for (const url of candidates) {
        try {
            const response = await fetchWithRetry(url, {
                headers: {
                    'Accept': 'application/json'
                }
            }, 1, 500);

            if (!response.ok) {
                lastError = new Error(`OSS ownership lookup failed (${response.status})`);
                continue;
            }

            payload = await response.json();
            lastError = null;
            break;
        } catch (error) {
            lastError = error;
            console.warn('OSS ownership fetch candidate failed', url, error);
        }
    }

    if (!payload) {
        throw lastError || new Error('OSS ownership lookup failed');
    }

    return extractOwnersFromOwnershipPayload(payload);
}

async function fetchOwnerDataForParcel(parcelId, options = {}) {
    const normalizedId = parcelId && parcelId.toString ? parcelId.toString().trim() : '';
    if (!normalizedId) {
        return { owners: [], slots: [] };
    }

    if (options.forceRefresh) {
        parcelOwnerDataCache.delete(normalizedId);
    }

    if (!shouldUseRealParcelOwners()) {
        const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
        return { owners: [], slots: fallbackSlots };
    }

    try {
        const owners = await getRealParcelOwners(normalizedId);
        const slots = mapOwnerRecordsToSlots(normalizedId, owners);
        return { owners, slots };
    } catch (error) {
        console.warn('fetchOwnerDataForParcel: owner lookup failed', error);
        const fallbackSlots = getParcelOwnerSlots(normalizedId, { forceSimulated: true });
        return { owners: [], slots: fallbackSlots };
    }
}

function fetchAndDisplayRealOwners(parcelId, options = {}) {
    const target = document.getElementById(PARCEL_OWNER_VALUE_ELEMENT_ID);
    if (!target || !parcelId) {
        return;
    }

    const fallbackHtml = options.fallbackHtml || '';
    const hasSimulatedOwner = !!options.hasSimulatedOwner;
    const requestId = ++parcelOwnerRequestSequence;

    getRealParcelOwners(parcelId)
        .then(owners => {
            if (requestId !== parcelOwnerRequestSequence) {
                return;
            }
            if (isGameModeActive()) {
                target.innerHTML = fallbackHtml || buildRealOwnerRowsHtml([]);
                return;
            }
            target.innerHTML = buildRealOwnerRowsHtml(owners);
            if (!suppressOwnerAcceptanceRefresh && typeof refreshParcelOwnerAcceptanceUI === 'function') {
                refreshParcelOwnerAcceptanceUI(parcelId);
            }
        })
        .catch(error => {
            console.warn('Failed to load real owner data', error);
            if (requestId !== parcelOwnerRequestSequence) {
                return;
            }
            if (isGameModeActive()) {
                target.innerHTML = fallbackHtml || buildRealOwnerRowsHtml([]);
                return;
            }
            const fallbackSection = fallbackHtml
                ? (hasSimulatedOwner
                    ? `<div class="owner-fallback-label" style="margin-top: 6px; font-size: 0.85em; color: #666;">Simulated owner</div>${fallbackHtml}`
                    : `<div style="margin-top: 6px; color: #666;">${fallbackHtml}</div>`)
                : buildRealOwnerRowsHtml([]);
            target.innerHTML = `<span class="owner-error" style="color: #c0392b;">Unable to load real owner data.</span>${fallbackSection}`;
        });
}

function refreshParcelOwnerAcceptanceUI(parcelId) {
    if (!parcelId) {
        return;
    }
    const activeParcel = window.currentParcel;
    if (activeParcel && activeParcel.id && activeParcel.layer && activeParcel.id.toString() === parcelId.toString()) {
        try {
            suppressOwnerAcceptanceRefresh = true;
            showParcelInfoPanel(activeParcel.layer.feature);
        } catch (error) {
            console.warn('refreshParcelOwnerAcceptanceUI: failed to refresh panel', error);
        } finally {
            setTimeout(() => {
                suppressOwnerAcceptanceRefresh = false;
            }, 0);
        }
    }
}

if (typeof window !== 'undefined') {
    window.refreshParcelOwnerAcceptanceUI = refreshParcelOwnerAcceptanceUI;
}

function isRoad(parcelId) {
    return PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
}

function getGridKey(easting, northing) {
    const gridEasting = Math.floor(easting / parcelCache.gridSize);
    const gridNorthing = Math.floor(northing / parcelCache.gridSize);
    return `${gridEasting},${gridNorthing}`;
}

function getRequiredGridCells(bounds, extraRadius = 0) {
    const cells = new Set();
    if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof wgs84ToHTRS96 !== 'function') {
        return cells;
    }

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const center = typeof bounds.getCenter === 'function'
        ? bounds.getCenter()
        : {
            lat: (sw.lat + ne.lat) / 2,
            lng: (sw.lng + ne.lng) / 2
        };

    const enforceRadius = Number.isFinite(extraRadius) ? Math.max(0, Math.floor(extraRadius)) : 0;

    const [centerEasting, centerNorthing] = wgs84ToHTRS96(center.lat, center.lng);
    const centerGridE = Math.floor(centerEasting / parcelCache.gridSize);
    const centerGridN = Math.floor(centerNorthing / parcelCache.gridSize);

    const [rawSwEasting, rawSwNorthing] = wgs84ToHTRS96(sw.lat, sw.lng);
    const [rawNeEasting, rawNeNorthing] = wgs84ToHTRS96(ne.lat, ne.lng);

    const minEasting = Math.min(rawSwEasting, rawNeEasting);
    const maxEasting = Math.max(rawSwEasting, rawNeEasting);
    const minNorthing = Math.min(rawSwNorthing, rawNeNorthing);
    const maxNorthing = Math.max(rawSwNorthing, rawNeNorthing);
    const epsilon = 1e-6;

    const minGridE = Math.floor(minEasting / parcelCache.gridSize);
    const maxGridE = Math.max(minGridE, Math.floor((maxEasting - epsilon) / parcelCache.gridSize));
    const minGridN = Math.floor(minNorthing / parcelCache.gridSize);
    const maxGridN = Math.max(minGridN, Math.floor((maxNorthing - epsilon) / parcelCache.gridSize));

    let radiusEast = Math.max(0,
        centerGridE - minGridE,
        maxGridE - centerGridE
    );
    let radiusNorth = Math.max(0,
        centerGridN - minGridN,
        maxGridN - centerGridN
    );

    radiusEast = Math.max(radiusEast, enforceRadius);
    radiusNorth = Math.max(radiusNorth, enforceRadius);

    const radius = Math.max(radiusEast, radiusNorth);

    for (let e = centerGridE - radius; e <= centerGridE + radius; e++) {
        for (let n = centerGridN - radius; n <= centerGridN + radius; n++) {
            cells.add(`${e},${n}`);
        }
    }

    return cells;
}

function computeGridKeysForBounds(bounds) {
    if (!bounds || typeof bounds.getSouthWest !== 'function') {
        return [];
    }
    if (typeof getRequiredGridCells === 'function') {
        const keys = Array.from(getRequiredGridCells(bounds, 0));
        if (keys.length) {
            return keys;
        }
    }
    try {
        if (typeof bounds.getCenter === 'function' && typeof wgs84ToHTRS96 === 'function') {
            const center = bounds.getCenter();
            const coords = wgs84ToHTRS96(center.lat, center.lng);
            if (Array.isArray(coords) && coords.length >= 2) {
                return [getGridKey(coords[0], coords[1])];
            }
        }
    } catch (_) { }
    return [];
}

function indexParcelLayer(layer) {
    if (!layer || typeof layer.getBounds !== 'function') {
        return;
    }

    unindexParcelLayer(layer);

    let keys = [];
    try {
        const bounds = layer.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            keys = computeGridKeysForBounds(bounds);
        }
    } catch (_) { }

    if (!Array.isArray(keys) || !keys.length) {
        return;
    }

    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    if (!uniqueKeys.length) {
        return;
    }

    layer.__parcelGridKeys = uniqueKeys;
    uniqueKeys.forEach(key => {
        let bucket = parcelLayerIndex.get(key);
        if (!bucket) {
            bucket = new Set();
            parcelLayerIndex.set(key, bucket);
        }
        bucket.add(layer);
    });
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function unindexParcelLayer(layer) {
    if (!layer || !Array.isArray(layer.__parcelGridKeys) || !layer.__parcelGridKeys.length) {
        return;
    }
    const keys = layer.__parcelGridKeys.slice();
    delete layer.__parcelGridKeys;
    keys.forEach(key => {
        if (!key) {
            return;
        }
        const bucket = parcelLayerIndex.get(key);
        if (!bucket) {
            return;
        }
        bucket.delete(layer);
        if (bucket.size === 0) {
            parcelLayerIndex.delete(key);
        }
    });
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function clearParcelLayerIndex() {
    parcelLayerIndex.clear();
    if (parcelLayer && typeof parcelLayer.eachLayer === 'function') {
        parcelLayer.eachLayer(layer => {
            if (layer && layer.__parcelGridKeys) {
                delete layer.__parcelGridKeys;
            }
        });
    }
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function getParcelLayersWithinBounds(bounds) {
    if (!parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
        return [];
    }
    if (!bounds || typeof bounds.getSouthWest !== 'function') {
        return parcelLayer.getLayers ? parcelLayer.getLayers() : [];
    }

    const layers = new Set();
    if (parcelLayerIndex.size && typeof getRequiredGridCells === 'function') {
        try {
            const keys = getRequiredGridCells(bounds, 0);
            keys.forEach(key => {
                const bucket = parcelLayerIndex.get(key);
                if (bucket) {
                    bucket.forEach(candidate => {
                        if (candidate) {
                            layers.add(candidate);
                        }
                    });
                }
            });
        } catch (_) { }
    }

    if (layers.size) {
        const indexedLayers = Array.from(layers);
        indexedLayers._source = 'index';
        return indexedLayers;
    }

    const fallback = [];
    parcelLayer.eachLayer(layer => {
        if (layer) {
            fallback.push(layer);
        }
    });
    fallback._source = 'full-scan';
    return fallback;
}

function calculateArea(coordinates) {
    const ring = coordinates[0];
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area += ring[ring.length - 1][0] * ring[0][1] - ring[0][0] * ring[ring.length - 1][1];
    return Math.abs(area / 2);
}

async function yieldToMainThread() {
    if (typeof window !== 'undefined') {
        if (typeof window.requestIdleCallback === 'function') {
            await new Promise(resolve => window.requestIdleCallback(() => resolve()));
            return;
        }
        if (typeof window.requestAnimationFrame === 'function') {
            await new Promise(resolve => window.requestAnimationFrame(() => resolve()));
            return;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
}

// Ensure a ring is in WGS84; if values look like HTRS96/TM, convert to WGS84 [lng, lat]
function ensureRingIsWGS(ring) {
    if (!Array.isArray(ring) || ring.length === 0) return ring;
    const first = ring[0];
    if (!Array.isArray(first) || first.length < 2) return ring;
    const looksLikeHTRS = Math.abs(first[0]) > 1000 || Math.abs(first[1]) > 1000;
    if (!looksLikeHTRS) return ring;
    return ring.map(coord => {
        const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
        return [lon, lat];
    });
}

function cloneCoordinates(coords) {
    if (!Array.isArray(coords)) {
        return coords;
    }
    return coords.map(item => Array.isArray(item) ? cloneCoordinates(item) : item);
}

function convertGeoJSON(geojson) {
    const baseType = geojson && typeof geojson.type === 'string' ? geojson.type : 'FeatureCollection';
    const sourceFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
    const converted = {
        type: baseType,
        features: []
    };

    sourceFeatures.forEach(originalFeature => {
        if (!originalFeature || typeof originalFeature !== 'object') {
            return;
        }

        const properties = Object.assign({}, originalFeature.properties || {});
        let geometry = null;
        if (originalFeature.geometry && typeof originalFeature.geometry === 'object') {
            geometry = {
                type: originalFeature.geometry.type,
                coordinates: cloneCoordinates(originalFeature.geometry.coordinates)
            };
        }

        if (geometry && geometry.coordinates && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const shouldComputeArea = properties.calculatedArea === undefined;
            let computedArea = shouldComputeArea ? 0 : properties.calculatedArea;

            polygons.forEach(polyCoords => {
                if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;
                const exterior = polyCoords[0];
                if (!Array.isArray(exterior) || exterior.length === 0) return;
                const looksLikeHTRS = Math.abs(exterior[0][0]) > 1000 || Math.abs(exterior[0][1]) > 1000;

                if (looksLikeHTRS) {
                    if (shouldComputeArea) {
                        try {
                            computedArea += calculateArea([exterior]);
                        } catch (_) {
                            // ignore area errors, keep accumulator as-is
                        }
                    }
                    for (let r = 0; r < polyCoords.length; r++) {
                        const ring = polyCoords[r];
                        if (!Array.isArray(ring) || ring.length === 0) continue;
                        polyCoords[r] = ring.map(coord => {
                            const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
                            return [lon, lat];
                        });
                    }
                } else {
                    if (shouldComputeArea) {
                        try {
                            const htrsCoords = exterior.map(coord => wgs84ToHTRS96(coord[1], coord[0]));
                            computedArea += calculateArea([htrsCoords]);
                        } catch (_) {
                            // ignore area errors
                        }
                    }
                }
            });

            if (shouldComputeArea) {
                properties.calculatedArea = computedArea;
            }
        }

        converted.features.push({
            type: 'Feature',
            properties,
            geometry
        });
    });

    return converted;
}

function cloneFeatureDeep(feature) {
    if (!feature || typeof feature !== 'object') {
        return null;
    }
    const clone = {
        type: feature.type || 'Feature',
        properties: Object.assign({}, feature.properties || {})
    };
    if (feature.geometry && typeof feature.geometry === 'object') {
        clone.geometry = {
            type: feature.geometry.type,
            coordinates: cloneCoordinates(feature.geometry.coordinates)
        };
    } else {
        clone.geometry = null;
    }
    return clone;
}

// --- Parcel Layer Management ---
function showAllParcels() {
    if (parcelLayer) {
        parcelLayer.addTo(map);
        parcelLayer.eachLayer(layer => {
            layer.addTo(map);
        });
        // updateStatus("Showing all parcels");
    } else {
        fetchParcelData();
        // Don't call updateStatus here since fetchParcelData will handle it
    }
}

function showOnlyRoadParcels() {
    if (!parcelLayer) {
        fetchParcelData();
        setTimeout(() => showOnlyRoadParcels(), 1000);
        return;
    }
    parcelLayer.addTo(map);
    let roadCount = 0;
    parcelLayer.eachLayer(layer => {
        const parcelId = layer.feature.properties.CESTICA_ID;
        const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
        if (isRoad) {
            if (!map.hasLayer(layer)) {
                map.addLayer(layer);
            }
            roadCount++;
        } else {
            if (map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        }
    });
    updateStatus(`Showing ${roadCount} road parcels only`);
}

function hideAllParcels() {
    if (parcelLayer) {
        map.removeLayer(parcelLayer);
    }
    updateStatus("All parcels hidden");
}

function updateVisibleParcelsCount() {
    const label = document.getElementById('parcels-in-view');
    if (!label) return;

    if (!parcelLayer || typeof parcelLayer.getLayers !== 'function' || typeof map === 'undefined' || !map) {
        label.textContent = 'Parcels in map view / total: 0 / 0';
        return;
    }

    const layers = parcelLayer.getLayers();
    const totalParcels = layers.length;

    if (!totalParcels) {
        label.textContent = 'Parcels in map view / total: 0 / 0';
        return;
    }

    const bounds = map.getBounds();
    if (!bounds || typeof bounds.intersects !== 'function') {
        label.textContent = `Parcels in map view / total: 0 / ${totalParcels}`;
        return;
    }

    const visibleParcels = layers.filter(layer => {
        try {
            const layerBounds = layer && typeof layer.getBounds === 'function' ? layer.getBounds() : null;
            return layerBounds ? bounds.intersects(layerBounds) : false;
        } catch (_) {
            return false;
        }
    });

    label.textContent = `Parcels in map view / total: ${visibleParcels.length} / ${totalParcels}`;
}

// --- Parcel Info and Interaction ---
function onParcelClick(e) {
    if (window.measureMode) return;
    const targetLayer = e && e.target ? e.target : null;
    if (!targetLayer || !targetLayer.feature) return;
    const feature = targetLayer.feature;
    const isRoad = PersistentStorage.getItem(`parcel_${feature.properties.CESTICA_ID}_isRoad`) === 'true';

    const proposalDetailsPanel = document.getElementById('proposal-details-panel');
    if (proposalDetailsPanel && proposalDetailsPanel.classList.contains('visible')) {
        if (typeof hideProposalDetailsPanel === 'function') {
            hideProposalDetailsPanel(true);
        } else {
            proposalDetailsPanel.classList.remove('visible');
            if (typeof clearProposalHighlights === 'function') {
                clearProposalHighlights();
            }
        }
        window.currentlyHighlightedProposal = null;
        window.selectedParcelInProposal = null;
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
            multiParcelSelection.toggle({ restoreSingleSelection: false });
        }
    }

    // Check if multi-selection is active and handle it
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
        const wasToggled = multiParcelSelection.toggleParcel(targetLayer);
        if (wasToggled) {
            L.DomEvent.stopPropagation(e);
            return; // Exit early to avoid single parcel selection logic
        }
    }

    // Normal single parcel selection logic - only runs when multi-selection is off or failed
    // Clear any existing multi-selection highlights if they exist
    if (typeof multiParcelSelection !== 'undefined' && !multiParcelSelection.isActive) {
        multiParcelSelection.clearSelection();
    }

    // Rest of the original single parcel selection logic
    if (splitLayer && map.hasLayer(splitLayer)) {
        map.removeLayer(splitLayer);
        splitLayer = null;
    }

    if (!isRoad && feature.properties.geometries) {
        const splitFeatures = feature.properties.geometries;
        if (splitFeatures && splitFeatures.length > 0) {
            const style = {
                color: '#ff0000',
                weight: 3,
                opacity: 0.8,
                fillColor: '#ff0000',
                fillOpacity: 0.3
            };
            splitLayer = L.layerGroup().addTo(map);
            splitFeatures.forEach(geom => {
                const layer = L.geoJSON(geom, { style });
                splitLayer.addLayer(layer);
            });
            showParcelInfoPanel(splitFeatures[0]);
            return;
        }
    }
    showParcelInfoPanel(feature);
    currentParcelCoordinates = feature.geometry.coordinates;
    const parcelId = feature.properties.CESTICA_ID;
    const currentIsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
    document.getElementById('roadCheckbox').checked = currentIsRoad;

    const previousSelectedId = selectedParcelId ? selectedParcelId.toString() : null;
    const previousLayer = currentParcel && currentParcel.layer ? currentParcel.layer : null;
    if (previousLayer && previousSelectedId && previousSelectedId !== parcelId.toString()) {
        const keepHighlighted = typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive &&
            multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.has(previousSelectedId);
        if (!keepHighlighted) {
            const wasRoad = PersistentStorage.getItem(`parcel_${previousSelectedId}_isRoad`) === 'true';
            try {
                previousLayer.setStyle(getParcelBaseStyle(previousSelectedId, { isRoad: wasRoad }));
            } catch (_) { }
        }
    }

    // Set the selected parcel style
    selectedParcelId = parcelId.toString();
    targetLayer.setStyle(selectedParcelStyle);
    targetLayer.bringToFront();

    if (typeof window !== 'undefined') {
        window.selectedParcelId = selectedParcelId;
    }

    const blockName = feature.properties.block;
    const blocksActive = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
    if (blocksActive) {
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        if (blockName) {
            // If blocks mode is on and parcel has a block, select its block
            highlightAndCenterBlock(blockName);
        } else if (currentSelectedBlockName) {
            // Clicking a non-block parcel while a block is selected should exit block selection
            try { if (typeof clearSelectedBlockAndUI === 'function') clearSelectedBlockAndUI(); } catch (_) { }
        }
    }

    currentParcel = {
        id: parcelId,
        layer: targetLayer,
        isRoad: currentIsRoad
    };
    if (typeof window !== 'undefined') {
        window.currentParcel = currentParcel;
    }

    // Show the create proposal button if we have a single parcel selected
    const createProposalButton = document.getElementById('createProposalFromParcelButton');
    if (createProposalButton) {
        createProposalButton.style.display = 'inline-block';
    }

    // Update the sidebar Create Proposal button visibility
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.updateCreateProposalButton) {
        multiParcelSelection.updateCreateProposalButton();
    }

    document.getElementById('parcel-info-panel').classList.add('visible');
    L.DomEvent.stopPropagation(e);

    // Update sidebar button states (enables Single Building when applicable)
    try { if (typeof updateBlockButtonStates === 'function') updateBlockButtonStates(); } catch (_) { }

}

function highlightFeature(e) {
    const layer = e.target;
    const parcelId = layer.feature.properties.CESTICA_ID.toString();
    const proposalUIActive = (typeof isProposalUIActive === 'function') ? isProposalUIActive() : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);

    // Only use proposal hover overlay when Proposal UI is active
    try {
        if (proposalUIActive && typeof proposalStorage !== 'undefined') {
            const proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
            if (proposals && proposals.length > 0) {
                if (typeof showProposalInfoHoverOverlay === 'function') {
                    showProposalInfoHoverOverlay(parcelId);
                    return; // Do not apply default hover styling
                }
            }
        }
    } catch (_) { }

    // Skip highlight if parcel is part of currently highlighted proposal, but only when proposal UI is active
    if (proposalUIActive && window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.parcelIds.includes(parcelId)) {
        return;
    }
    // Do not highlight over the currently selected parcel
    if (parcelId === selectedParcelId) {
        return;
    }
    // Do not highlight over multi-selected parcels
    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
        multiParcelSelection.isActive &&
        multiParcelSelection.selectedParcels.has(parcelId);
    if (isMultiSelected) {
        return;
    }
    // Proposal-aware: only change border, not fill
    layer.setStyle({
        weight: 5,
        color: '#666',
        dashArray: '',
        // Do not change fillColor/fillOpacity
    });
    if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        layer.bringToFront();
    }
}

function resetHighlight(e) {
    const layer = e.target;
    const parcelId = layer.feature.properties.CESTICA_ID.toString();
    const proposalUIActive = (typeof isProposalUIActive === 'function') ? isProposalUIActive() : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);

    // Clear the proposal hover overlay only when Proposal UI is active
    try {
        if (proposalUIActive && typeof clearProposalInfoHoverOverlay === 'function') {
            clearProposalInfoHoverOverlay();
        }
    } catch (_) { }

    // Do not reset the style of the currently selected parcel (normal)
    if (parcelId === selectedParcelId) {
        return;
    }
    // Keep selected block parcels highlighted in blue ONLY when Parcel Blocks are shown
    try {
        const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
            const parcelHighlightStyle = {
                fillColor: '#3388ff',
                fillOpacity: 0.4,
                color: '#3388ff',
                weight: 2
            };
            layer.setStyle(parcelHighlightStyle);
            return;
        }
    } catch (_) { }

    // Otherwise, reset to its original style (road or normal)
    // But check if this parcel is part of multi-selection first
    const isMultiSelected2 = typeof multiParcelSelection !== 'undefined' &&
        multiParcelSelection.isActive &&
        multiParcelSelection.selectedParcels.has(parcelId);

    if (isMultiSelected2) {
        // Restore multi-selection highlighting
        layer.setStyle({
            fillColor: '#ff9800',
            fillOpacity: 0.6,
            color: '#f57c00',
            weight: 3
        });
    } else {
        // Restore normal or road style using the original style definitions
        // but preserve block highlight if this parcel is part of the selected block
        try {
            const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                ? selectedBlockName
                : (typeof window !== 'undefined' ? window.selectedBlockName : null);
            const layerBlockName = layer?.feature?.properties?.block;
            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
            if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
            } else {
                layer.setStyle(getParcelBaseStyle(parcelId));
            }
        } catch (_) {
            layer.setStyle(getParcelBaseStyle(parcelId));
        }
    }
}

// This function will be called on each created feature
function onEachFeature(feature, layer) {
    layer.on({
        mouseover: highlightFeature,
        mouseout: resetHighlight,
        click: onParcelClick
    });
}

function selectParcel(parcelId, showPanel = true) {
    const selectedLayer = parcelLayer.getLayers().find(layer => {
        return layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
    });

    if (selectedLayer) {
        selectedParcelId = parcelId.toString();
        window.selectedParcelId = parcelId.toString();
        if (!(typeof window !== 'undefined' && window.suppressCameraMoves)) {
            map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
        }
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const layerParcelId = layer.feature.properties.CESTICA_ID.toString();
                const isRoad = PersistentStorage.getItem(`parcel_${layerParcelId}_isRoad`) === 'true';
                if (layerParcelId !== parcelId.toString()) {
                    // Check if this parcel is part of multi-selection before resetting style
                    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                        multiParcelSelection.isActive &&
                        multiParcelSelection.selectedParcels.has(layerParcelId);
                    if (!isMultiSelected) {
                        layer.setStyle(getParcelBaseStyle(layerParcelId, { isRoad }));
                    }
                }
            }
        });
        selectedLayer.setStyle(selectedParcelStyle);
        selectedLayer.bringToFront();
        currentParcel = {
            id: parcelId,
            layer: selectedLayer,
            isRoad: PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
        };
        window.currentParcel = currentParcel;

        // Only show the panel if requested (desktop behavior)
        if (showPanel) {
            showParcelInfoPanel(selectedLayer.feature);
            document.getElementById('roadCheckbox').checked = currentParcel.isRoad;
            document.getElementById('parcel-info-panel').classList.add('visible');
        }
        if (typeof neighborHighlightActive !== 'undefined' && neighborHighlightActive) {
            highlightNeighbors(selectedLayer);
        }
        if (typeof verticesDisplayActive !== 'undefined' && verticesDisplayActive) {
            verticesDisplayActive = false;
            const verticesBtn = document.getElementById('verticesButton');
            if (verticesBtn) verticesBtn.classList.remove('active');
            clearVertexMarkers();
        }
        updateStatus(
            `Selected parcel ${selectedLayer.feature.properties.BROJ_CESTICE}`);
    }
}

function buildCompactAcceptanceRow(label, entries, options = {}) {
    if (!entries || entries.length === 0) {
        return '';
    }
    const safeLabel = typeof escapeHtml === 'function'
        ? escapeHtml(label || 'Acceptance')
        : (label || 'Acceptance');
    const summaryText = options.summary || '';
    const summaryHtml = summaryText
        ? `<span class="compact-acceptance-summary">${typeof escapeHtml === 'function' ? escapeHtml(summaryText) : summaryText}</span>`
        : '';
    const circlesHtml = entries.map(entry => {
        const statusClass = entry && entry.accepted ? 'accepted' : 'pending';
        const title = entry && entry.title ? entry.title : '';
        const safeTitle = title && typeof escapeHtml === 'function' ? escapeHtml(title) : title;
        return `<span class="acceptance-circle ${statusClass} compact"${safeTitle ? ` title="${safeTitle}"` : ''}></span>`;
    }).join('');

    return `
        <div class="compact-acceptance-row">
            <div class="compact-acceptance-label">
                ${safeLabel}${summaryHtml ? ` ${summaryHtml}` : ''}
            </div>
            <div class="acceptance-circles compact">${circlesHtml}</div>
        </div>
    `;
}

function buildParcelAcceptanceIndicators(proposal) {
    if (!proposal || !Array.isArray(proposal.parcelIds) || proposal.parcelIds.length === 0) {
        return '';
    }
    const acceptedSet = new Set(
        (proposal.acceptedParcelIds || []).map(id => (id !== undefined && id !== null) ? id.toString() : '')
    );
    const entries = proposal.parcelIds.map((id, index) => {
        const normalizedId = (id !== undefined && id !== null) ? id.toString() : `parcel_${index + 1}`;
        const isAccepted = acceptedSet.has(normalizedId);
        const title = normalizedId ? `Parcel ${normalizedId} ${isAccepted ? 'accepted' : 'pending'}` : '';
        return {
            accepted: isAccepted,
            title
        };
    });
    const acceptedCount = entries.filter(entry => entry.accepted).length;
    return buildCompactAcceptanceRow('Parcel acceptance', entries, {
        summary: `${acceptedCount}/${entries.length}`
    });
}

function buildOwnerAcceptanceIndicators(proposal) {
    if (typeof buildProposalOwnerAcceptanceSummary === 'function') {
        const summary = buildProposalOwnerAcceptanceSummary(proposal);
        if (summary && summary.totalOwners > 0) {
            const entries = summary.entries.map(entry => {
                if (!entry) return null;
                const parts = [];
                if (entry.displayName) parts.push(entry.displayName);
                if (entry.shareText) parts.push(entry.shareText);
                if (entry.parcelId) parts.push(`Parcel ${entry.parcelId}`);
                parts.push(entry.accepted ? 'accepted' : 'pending');
                return {
                    accepted: !!entry.accepted,
                    title: parts.join(' • ')
                };
            }).filter(Boolean);
            if (entries.length > 0) {
                return buildCompactAcceptanceRow('Owner acceptance', entries, {
                    summary: `${summary.acceptedOwners}/${summary.totalOwners}`
                });
            }
        }
    }

    if (typeof getProposalOwnerAcceptanceState !== 'function') {
        return '';
    }
    const targetParcelId = Array.isArray(proposal && proposal.parcelIds) && proposal.parcelIds.length > 0
        ? proposal.parcelIds[0]
        : null;
    if (!targetParcelId) {
        return '';
    }
    const fallbackState = getProposalOwnerAcceptanceState(proposal, targetParcelId, { syncWithParcelAcceptance: false });
    const fallbackEntries = fallbackState && Array.isArray(fallbackState.entries) ? fallbackState.entries : [];
    if (!fallbackEntries.length) {
        return '';
    }
    const mappedEntries = fallbackEntries.map(entry => {
        const parts = [];
        if (entry && entry.displayName) parts.push(entry.displayName);
        if (entry && entry.shareText) parts.push(entry.shareText);
        parts.push(entry && entry.accepted ? 'accepted' : 'pending');
        return {
            accepted: !!(entry && entry.accepted),
            title: parts.join(' • ')
        };
    });
    const acceptedCount = mappedEntries.filter(entry => entry.accepted).length;
    return buildCompactAcceptanceRow('Owner acceptance', mappedEntries, {
        summary: `${acceptedCount}/${mappedEntries.length}`
    });
}

function showParcelInfoPanel(feature) {
    const area = feature.properties.calculatedArea;
    const formattedArea = area ? Math.round(Number(area)).toLocaleString('hr-HR') : 'N/A';
    const estimatedPrice = area ? area * SQM_AVG_PRICE : 0;
    const formattedPrice = estimatedPrice ? estimatedPrice.toLocaleString('hr-HR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }) : 'N/A';

    const blockName = feature.properties.block;
    const blockHtml = blockName ?
        `<span class="block-tag" onclick="highlightAndCenterBlock('${blockName}')" style="cursor: pointer; background-color: #007bff; color: white; padding: 2px 8px; border-radius: 12px;">${blockName}</span>` :
        'Not part of a block';

    // Get parcel ownership information
    const parcelId = feature.properties.CESTICA_ID;
    const parcelProposals = (typeof proposalStorage !== 'undefined')
        ? proposalStorage.getProposalsForParcel(parcelId.toString(), { hydrateRoadAssets: false })
        : [];

    const shouldFetchRealOwners = shouldUseRealParcelOwners();
    const simulatedOwnerHtml = buildSimulatedOwnerHtml(parcelId);
    const fallbackOwnerHtml = simulatedOwnerHtml || 'No owner';
    let ownershipHtml = fallbackOwnerHtml;

    if (shouldFetchRealOwners) {
        ownershipHtml = '<span class="owner-loading" style="color: #666;">Loading real ownership data…</span>';
    }

    // Get proposals for this parcel
    let proposalsHtml = 'No proposals';
    if (parcelProposals.length > 0) {
        const proposalItems = parcelProposals.map(proposal => {
            const isRoadProposal = proposal.type === 'road' && proposal.roadProposal;
            const isBuildingProposal = (!isRoadProposal) && (proposal.type === 'building' || !!proposal.buildingProposal);
            const isStructureProposal = (!isRoadProposal && !isBuildingProposal) && !!proposal.structureProposal;
            const lifecycleKey = (typeof getProposalLifecycleKey === 'function') ? getProposalLifecycleKey(proposal) : null;
            const statusText = (typeof getProposalLifecycleLabel === 'function' && lifecycleKey)
                ? getProposalLifecycleLabel(lifecycleKey)
                : (proposal.status || 'Active');
            const statusClass = (typeof getProposalLifecycleClass === 'function' && lifecycleKey)
                ? getProposalLifecycleClass(lifecycleKey)
                : 'active';
            const mapApplied = (typeof isProposalApplied === 'function') ? isProposalApplied(proposal) : false;

            // Check if current parcel has accepted this proposal
            const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

            // Check if proposal is still active (not executed)
            const isActive = proposal.status !== 'Executed' && proposal.status !== 'Applied';

            // Generate action buttons based on proposal type and state
            let actionButtons = '';

            const parcelAcceptanceIndicatorsHtml = buildParcelAcceptanceIndicators(proposal);
            const ownerAcceptanceIndicatorsHtml = buildOwnerAcceptanceIndicators(proposal);

            return `
                    <div class="proposal-item" onclick="showProposalDetails('${proposal.proposalHash}', '${parcelId}')" style="cursor: pointer;">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title">${proposal.title || proposal.type || 'Proposal'}${isRoadProposal ? ' (Road)' : ''}</span>
                            <div class="proposal-item-badges">
                                <span class="proposal-item-status ${statusClass}">${statusText}</span>
                                ${mapApplied ? `<span class="proposal-item-map-badge applied">Applied</span>` : ''}
                            </div>
                        </div>
                        <div class="proposal-item-details">
                            ID: ${proposal.proposalHash.substring(0, 8)}
                        </div>
                        <div class="proposal-item-details">
                            Author: ${proposal.author || proposal.username || 'Unknown'}
                        </div>
                        ${proposal.budget && !isRoadProposal ? `<div class="proposal-item-details">Budget: ${proposal.budget} ETH</div>` : ''}
                        ${parcelAcceptanceIndicatorsHtml ? `<div class="proposal-item-indicators">${parcelAcceptanceIndicatorsHtml}</div>` : ''}
                        ${ownerAcceptanceIndicatorsHtml ? `<div class="proposal-item-indicators">${ownerAcceptanceIndicatorsHtml}</div>` : ''}
                        ${actionButtons ? `
                        <div class="proposal-item-actions" style="margin-top: 8px; text-align: right;">
                            ${actionButtons}
                        </div>` : ''}
                    </div>
                `;
        }).join('');

        proposalsHtml = `
            <div class="parcel-proposals-list">
                ${proposalItems}
            </div>
        `;
    }

    // Populate Info Tab
    const infoContent = `
        <div class="metric-group">
            <div class="metric-label">Owner:</div>
            <div class="metric-value" id="${PARCEL_OWNER_VALUE_ELEMENT_ID}">${ownershipHtml}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Block:</div>
            <div class="metric-value">${blockHtml}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Parcel Area:</div>
            <div class="metric-value">${formattedArea} m²</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Est. Market Price:</div>
            <div class="metric-value">${formattedPrice} €</div>
        </div>
        <div id="roadMeasurements" style="display: none;">
            <!-- Road measurements will be inserted here when button is clicked -->
        </div>
    `;

    // Populate Proposals Tab
    const proposalsContent = `
        <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
        <div class="metric-group">
            <div class="metric-label">Proposals (${parcelProposals.length}):</div>
            <div class="metric-value">${proposalsHtml}</div>
        </div>
    `;

    // Update the title to include parcel number
    const titleElement = document.getElementById('parcel-info-title');
    if (titleElement) {
        const broj = feature.properties.BROJ_CESTICE;
        const cesticaId = feature.properties.CESTICA_ID;
        const isDebug = document.body && document.body.classList && document.body.classList.contains('debug-mode');
        const brojPart = broj ? ` (${broj})` : '';
        if (isDebug && cesticaId) {
            titleElement.innerHTML = `Parcel Info${brojPart} <span style="font-size:11px;color:#666;margin-left:6px;">ID: <span style="font-family:monospace;">${cesticaId}</span></span>`;
        } else if (broj) {
            titleElement.textContent = `Parcel Info (${broj})`;
        } else {
            titleElement.textContent = 'Parcel Info';
        }
    }

    // Update the Proposals tab title with count
    const proposalCount = parcelProposals.length;
    const proposalsTabButton = document.querySelector('.parcel-tab-btn[onclick*="proposals-tab"]');
    if (proposalsTabButton) {
        proposalsTabButton.textContent = proposalCount > 0 ? `Proposals (${proposalCount})` : 'Proposals';
    }

    // Populate the tabs
    document.getElementById('info-content').innerHTML = infoContent;
    if (shouldFetchRealOwners) {
        fetchAndDisplayRealOwners(parcelId, {
            fallbackHtml: fallbackOwnerHtml,
            hasSimulatedOwner: !!simulatedOwnerHtml
        });
    }
    document.getElementById('proposals-content').innerHTML = proposalsContent;
    if (typeof renderParcelProposalActions === 'function') {
        renderParcelProposalActions(parcelId);
    }

    // Show the panel
    document.getElementById('parcel-info-panel').classList.add('visible');

    resetParcelMintStatusState();
    const toolsTabContent = document.getElementById('tools-tab');
    if (toolsTabContent && toolsTabContent.classList.contains('active')) {
        triggerParcelToolsTabActivated();
    }

    // If multi-select is active, automatically switch to Info tab
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
        switchParcelTab(document.querySelector('.parcel-tab-btn[onclick*="info-tab"]'), 'info-tab');
    }

    // Reset the measure as road button state when showing a new parcel
    resetMeasureAsRoadButton();
}

// Function to reset the measure as road button to its initial state
function resetMeasureAsRoadButton() {
    const button = document.getElementById('measureAsRoadButton');
    const measurementsDiv = document.getElementById('roadMeasurements');

    if (button) {
        button.innerHTML = 'Measure as road';
        button.disabled = false;
    }

    if (measurementsDiv) {
        measurementsDiv.style.display = 'none';
        measurementsDiv.innerHTML = '';
    }
}

function getParcelMintStatusElement() {
    return document.getElementById('parcelMintStatus');
}

function setParcelMintStatusIndicator(message, state = 'neutral') {
    const indicator = getParcelMintStatusElement();
    if (!indicator) return;

    indicator.textContent = message;

    const stateClasses = ['is-neutral', 'is-loading', 'is-minted', 'is-not-minted', 'is-error'];
    indicator.classList.remove(...stateClasses);

    if (state) {
        const normalized = state.startsWith('is-') ? state : `is-${state}`;
        if (stateClasses.includes(normalized)) {
            indicator.classList.add(normalized);
        } else if (stateClasses.includes(`is-${state}`)) {
            indicator.classList.add(`is-${state}`);
        } else {
            indicator.classList.add('is-neutral');
        }
    } else {
        indicator.classList.add('is-neutral');
    }
}

function resetParcelMintStatusState() {
    currentParcelMintStatusCache = null;
    currentParcelMintStatusParcelId = null;
    currentParcelMintStatusPromise = null;
    setParcelMintStatusIndicator('NFT status: Not checked yet.', 'neutral');
}

function applyParcelMintStatusResult(result) {
    if (!result) {
        setParcelMintStatusIndicator('NFT status: Not checked yet.', 'neutral');
        return;
    }

    if (result.minted) {
        const chainText = result.chainSlug ? ` (${result.chainSlug})` : '';
        const tokenText = result.tokenId ? ` • Token ${result.tokenId}` : '';
        setParcelMintStatusIndicator(`NFT status: Minted${chainText}${tokenText}`, 'minted');
    } else {
        setParcelMintStatusIndicator('NFT status: Not minted yet.', 'not-minted');
    }
}

async function fetchParcelMintStatus(parcelId) {
    const claimContext = await resolveParcelClaimContext();
    const ethersLib = typeof window !== 'undefined' ? window.ethers : null;
    if (!ethersLib) {
        throw new Error('Blockchain library is not available.');
    }
    const contract = new ethersLib.Contract(
        claimContext.contractAddress,
        PARCEL_NFT_ABI_FRAGMENT,
        claimContext.provider
    );
    try {
        const tokenIdRaw = await fetchParcelTokenId(contract, parcelId);
        return {
            minted: true,
            tokenId: toStringSafe(tokenIdRaw),
            chainSlug: claimContext.chainSlug,
            contractAddress: claimContext.contractAddress
        };
    } catch (error) {
        if (error && error.message === 'TOKEN_NOT_MINTED') {
            return {
                minted: false,
                chainSlug: claimContext.chainSlug,
                contractAddress: claimContext.contractAddress
            };
        }
        throw error;
    }
}

function triggerParcelToolsTabActivated() {
    const indicator = getParcelMintStatusElement();
    if (!indicator) return null;

    if (!currentParcel || !currentParcel.layer || !currentParcel.layer.feature) {
        setParcelMintStatusIndicator('Select a parcel to check NFT status.', 'neutral');
        currentParcelMintStatusCache = null;
        currentParcelMintStatusParcelId = null;
        currentParcelMintStatusPromise = null;
        return null;
    }

    const parcelId = deriveParcelIdentifier(currentParcel.layer.feature);
    if (!parcelId) {
        setParcelMintStatusIndicator('Parcel identifier unavailable.', 'error');
        currentParcelMintStatusCache = null;
        currentParcelMintStatusParcelId = null;
        currentParcelMintStatusPromise = null;
        return null;
    }

    if (currentParcelMintStatusCache && currentParcelMintStatusCache.parcelId === parcelId) {
        applyParcelMintStatusResult(currentParcelMintStatusCache.result);
        return currentParcelMintStatusPromise;
    }

    if (currentParcelMintStatusPromise && currentParcelMintStatusParcelId === parcelId) {
        setParcelMintStatusIndicator('Checking NFT status...', 'loading');
        return currentParcelMintStatusPromise;
    }

    currentParcelMintStatusParcelId = parcelId;
    setParcelMintStatusIndicator('Checking NFT status...', 'loading');

    const requestPromise = (async () => {
        try {
            const result = await fetchParcelMintStatus(parcelId);
            if (currentParcelMintStatusParcelId === parcelId) {
                currentParcelMintStatusCache = { parcelId, result };
                applyParcelMintStatusResult(result);
            }
            return result;
        } catch (error) {
            if (currentParcelMintStatusParcelId === parcelId) {
                console.error('Parcel NFT status check failed:', error);
                setParcelMintStatusIndicator('Unable to check NFT status.', 'error');
                currentParcelMintStatusCache = null;
            }
            throw error;
        } finally {
            if (currentParcelMintStatusParcelId === parcelId) {
                currentParcelMintStatusPromise = null;
            }
        }
    })();

    currentParcelMintStatusPromise = requestPromise;
    return requestPromise;
}

// --- Proposal Compare Modal ---
function showProposalCompareModal(proposalHash, parcelId) {
    try {
        const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(proposalHash) : null;
        if (!proposal) {
            alert('Proposal not found.');
            return;
        }

        const canCompare = typeof isProposalApplied === 'function'
            ? isProposalApplied(proposal)
            : ((proposal.status || '').toLowerCase() === 'applied' || (proposal.status || '').toLowerCase() === 'executed');
        if (!canCompare) {
            if (typeof updateStatus === 'function') {
                updateStatus('Only the currently applied proposal can be compared.');
            } else {
                alert('Only the currently applied proposal can be compared.');
            }
            return;
        }

        // Create or reuse modal container
        let modal = document.querySelector('.proposal-info-modal.compare-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'proposal-info-modal compare-modal';
            document.body.appendChild(modal);
        }

        // Build modal content
        const content = document.createElement('div');
        content.className = 'proposal-info-modal-content';
        content.innerHTML = `
            <div class="proposal-info-modal-header">
                <h2>Compare: Current vs Proposed</h2>
                <button class="proposal-info-modal-close" aria-label="Close">×</button>
            </div>
            <div class="proposal-info-modal-body" id="compare-modal-body"></div>
            <div class="proposal-info-modal-footer">
                <button class="btn btn-secondary" id="compare-close-btn">Close</button>
            </div>
        `;

        // Clear and append
        modal.innerHTML = '';
        modal.appendChild(content);

        // Wire close events
        const close = () => hideProposalCompareModal();
        content.querySelector('.proposal-info-modal-close').addEventListener('click', close);
        content.querySelector('#compare-close-btn').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        // Render placeholder; actual metrics computed in a separate function so we can reuse
        const body = content.querySelector('#compare-modal-body');
        body.innerHTML = '<div>Loading comparison…</div>';

        // Ensure existing buildings are loaded, then compute and render
        ensureExistingBuildingsLoaded()
            .then(() => {
                try {
                    const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                    body.innerHTML = tableHtml;
                } catch (err) {
                    console.error('Error building comparison table:', err);
                    body.innerHTML = '<div style="color:#dc3545">Failed to build comparison.</div>';
                }
            })
            .catch((err) => {
                console.error('Error ensuring buildings loaded:', err);
                // Proceed with best-effort computation even if buildings failed to load
                try {
                    const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                    body.innerHTML = tableHtml;
                } catch (e2) {
                    console.error('Error building comparison table (fallback):', e2);
                    body.innerHTML = '<div style="color:#dc3545">Failed to build comparison.</div>';
                }
            });

        // Show modal
        modal.style.display = 'flex';
    } catch (e) {
        console.error('showProposalCompareModal error:', e);
        alert('Could not open comparison modal.');
    }
}

function hideProposalCompareModal() {
    const modal = document.querySelector('.proposal-info-modal.compare-modal');
    if (modal) modal.style.display = 'none';
}

// Expose for onclick usage
window.showProposalCompareModal = showProposalCompareModal;

// Wait until existing buildings are available; fetch if needed
function ensureExistingBuildingsLoaded() {
    return new Promise((resolve, reject) => {
        try {
            const ready = () => {
                const bl = typeof window !== 'undefined' ? window.buildingLayer : null;
                if (bl && typeof bl.getLayers === 'function' && bl.getLayers().length > 0) {
                    resolve();
                    return true;
                }
                return false;
            };

            if (ready()) return; // already loaded

            // If we can fetch, listen for update and trigger fetch
            const onUpdated = () => {
                if (ready()) {
                    try { window.removeEventListener('buildingsLayerUpdated', onUpdated); } catch (_) { }
                    resolve();
                }
            };
            try { window.addEventListener('buildingsLayerUpdated', onUpdated, { once: true }); } catch (_) { }

            if (typeof fetchBuildings === 'function') {
                fetchBuildings();
            } else {
                // No fetch function available
                resolve();
            }
        } catch (e) {
            reject(e);
        }
    });
}

// Build the HTML table for comparison; metrics are computed in helper below
function buildProposalComparisonTable(proposal, parcelId) {
    const metrics = computeComparisonMetrics(proposal, parcelId);

    const fmt = (v) => {
        if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
        if (typeof v === 'number') return Math.round(Number(v)).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        return String(v);
    };

    // Adjust proposed market value by subtracting parking cost (10,000€ per spot)
    const PARKING_SPOT_COST = 10000;
    const adjustedProposedMarket = metrics.marketValue.proposed - (metrics.parking.proposed * PARKING_SPOT_COST);

    const rows = [
        { label: 'Parcel area (m²)', current: metrics.parcelArea.current, proposed: metrics.parcelArea.proposed },
        { label: 'Building footprint (m²)', current: metrics.footprint.current, proposed: metrics.footprint.proposed },
        { label: 'Building height (m)', current: metrics.height.current, proposed: metrics.height.proposed },
        { label: 'Building floors', current: metrics.floors.current, proposed: metrics.floors.proposed },
        { label: 'Square meters (m²)', current: metrics.squareMeters.current, proposed: metrics.squareMeters.proposed },
        { label: 'Parking spots', current: metrics.parking.current, proposed: metrics.parking.proposed },
        { label: 'Estimated market value (€)', current: metrics.marketValue.current, proposed: adjustedProposedMarket },
    ];

    const adjustedDiff = adjustedProposedMarket - metrics.marketValue.current;
    const summaryHtml = adjustedDiff > 0
        ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-profit">Profit!</span></div>
                <div class="metric-value">You can profit by accepting this proposal.</div>
            </div>
        `
        : (adjustedDiff < 0
            ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-loss">Loss!</span></div>
                <div class="metric-value">If you accept this proposal your property will be worth less than today.</div>
            </div>
        ` : '');

    const table = `
        <div class="proposal-details">
            ${summaryHtml}
            <div class="metric-group">
                <div class="metric-label">Difference in market value (profit)</div>
                <div class="metric-value ${adjustedDiff >= 0 ? 'profit-positive' : 'profit-negative'}"><span class="animated-amount">${fmt(adjustedDiff)} €</span></div>
            </div>
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Currently</th>
                        <th>Proposed</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                        <tr>
                            <td class="label">${r.label}</td>
                            <td class="value">${fmt(r.current)}</td>
                            <td class="value">${fmt(r.proposed)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
    return table;
}

// Compute comparison metrics based on current parcel and proposal data
function computeComparisonMetrics(proposal, parcelId) {
    // 1) parcel area
    const parcelLayerRef = typeof parcelLayer !== 'undefined' ? parcelLayer : null;
    const parcelLayerObj = parcelLayerRef ? parcelLayerRef.getLayers().find(l => String(l?.feature?.properties?.CESTICA_ID) === String(parcelId)) : null;
    const parcelFeature = parcelLayerObj ? parcelLayerObj.feature : null;
    const parcelArea = parcelFeature ? (parcelFeature.properties?.calculatedArea || safeArea(parcelFeature)) : 0;

    // Proposed parcel area: same as current unless geometry from road splitting exists in proposal
    // For now, follow spec: same for building proposals; roads may change area if polygon intersects
    let proposedParcelArea = parcelArea;
    try {
        if (proposal.type === 'road' && proposal.roadGeometry && proposal.roadGeometry.polygon && parcelFeature) {
            const remaining = turf.difference(parcelFeature, proposal.roadGeometry.polygon);
            proposedParcelArea = remaining ? turf.area(remaining) : parcelArea;
        }
    } catch (_) { proposedParcelArea = parcelArea; }

    // 2) building footprint (current) based on existing buildings layer
    let currentFootprint = 0;
    let currentHeightFromBuildings = null; // meters (area-weighted if multiple)
    try {
        const parcelPoly = parcelFeature;
        const bLayer = (typeof window !== 'undefined') ? window.buildingLayer : null;
        if (parcelPoly && bLayer && typeof bLayer.getLayers === 'function') {
            const layers = bLayer.getLayers();
            let totalIntersectArea = 0;
            let heightAreaProduct = 0;

            for (let i = 0; i < layers.length; i++) {
                const l = layers[i];
                const feat = l && l.feature ? l.feature : null;
                if (!feat || !feat.geometry) continue;
                try {
                    // Quick bbox check to skip non-intersecting
                    if (typeof l.getBounds === 'function' && l.getBounds && parcelLayerObj && parcelLayerObj.getBounds) {
                        const parcelBounds = parcelLayerObj.getBounds();
                        try { if (!parcelBounds.intersects(l.getBounds())) continue; } catch (_) { }
                    }

                    const inter = turf.intersect(parcelPoly, feat);
                    if (inter) {
                        const a = turf.area(inter);
                        if (isFinite(a) && a > 0) {
                            currentFootprint += a;
                            totalIntersectArea += a;
                            const h = extractBuildingHeightMeters(feat.properties);
                            if (isFinite(h) && h > 0) {
                                heightAreaProduct += h * a; // area-weighted aggregation
                            }
                        }
                    }
                } catch (_) { }
            }

            if (totalIntersectArea > 0 && heightAreaProduct > 0) {
                currentHeightFromBuildings = heightAreaProduct / totalIntersectArea;
            }
        }
    } catch (_) { }

    // proposed: intersection of proposed building polygon and parcel
    let proposedFootprint = 0;
    try {
        if (proposal.buildingGeometry && parcelFeature) {
            const inter = turf.intersect(parcelFeature, { type: 'Feature', geometry: proposal.buildingGeometry, properties: {} });
            proposedFootprint = inter ? turf.area(inter) : 0;
        }
    } catch (_) { proposedFootprint = 0; }

    // 3) building height
    const currentHeight = isFinite(currentHeightFromBuildings) && currentHeightFromBuildings > 0
        ? Math.round(currentHeightFromBuildings)
        : 10; // fallback default
    // For proposed: try to pull from building properties if available; default 10 if missing
    let proposedHeight = 10;
    try {
        // Prefer height from buildingGeometry Feature properties if provided
        if (proposal.buildingGeometry && proposal.buildingGeometry.properties && isFinite(Number(proposal.buildingGeometry.properties.height))) {
            proposedHeight = Math.round(Number(proposal.buildingGeometry.properties.height));
        } else if (proposal.properties && isFinite(Number(proposal.properties.height))) {
            proposedHeight = Math.round(Number(proposal.properties.height));
        } else if (proposal.title && /\b(\d{1,3})m\b/i.test(proposal.title)) {
            const m = proposal.title.match(/\b(\d{1,3})m\b/i);
            if (m) proposedHeight = Number(m[1]);
        }
    } catch (_) { }

    // 4) floors
    const currentFloors = Math.floor(currentHeight / 3);
    const proposedFloors = Math.floor(proposedHeight / 3);

    // 5) square meters
    const currentSqm = currentFootprint * currentFloors;
    const proposedSqm = proposedFootprint * proposedFloors;

    // 6) parking spots
    const currentParking = 4;
    const proposedParking = 0;

    // 7) estimated market value
    const sqmPrice = 3500; // As per spec for comparison
    const currentMarket = currentSqm * sqmPrice;
    const proposedMarket = proposedSqm * sqmPrice;

    return {
        parcelArea: { current: parcelArea, proposed: proposedParcelArea },
        footprint: { current: currentFootprint, proposed: proposedFootprint },
        height: { current: currentHeight, proposed: proposedHeight },
        floors: { current: currentFloors, proposed: proposedFloors },
        squareMeters: { current: currentSqm, proposed: proposedSqm },
        parking: { current: currentParking, proposed: proposedParking },
        marketValue: { current: currentMarket, proposed: proposedMarket }
    };
}

function safeArea(feature) {
    try { return turf.area(feature); } catch (_) { return 0; }
}

// Extract height from building properties if available
function extractBuildingHeightMeters(props) {
    if (!props) return null;
    try {
        // Try common fields first
        if (isFinite(Number(props.height))) return Number(props.height);
        if (isFinite(Number(props.HEIGHT))) return Number(props.HEIGHT);
        if (isFinite(Number(props.visina))) return Number(props.visina);
        if (isFinite(Number(props.Visina))) return Number(props.Visina);

        // Try floors then convert to meters (3m per floor)
        const floorsCandidates = [props.floors, props.FLOORS, props.kat, props.KAT, props.katova, props.KATOVA, props.storeys, props.STOREYS];
        for (let i = 0; i < floorsCandidates.length; i++) {
            const f = Number(floorsCandidates[i]);
            if (isFinite(f) && f > 0) return f * 3;
        }
    } catch (_) { }
    return null;
}

// Open Parcel Builder site in a new tab, passing along parcel context when available
function openParcelBuilder() {
    try {
        const defaultExternalUrl = 'https://urbangametheory.xyz/codechecker';
        const env = (typeof window !== 'undefined' && window.current_environment) ? window.current_environment : 'production';
        const origin = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null')
            ? window.location.origin.replace(/\/$/, '')
            : null;

        let baseUrl = defaultExternalUrl;

        if (origin) {
            // Prefer local origin for both dev (localhost) and production deployments
            if (env === 'development' || env === 'production') {
                baseUrl = `${origin}/codechecker`;
            }
        }

        const props = (currentParcel && currentParcel.layer && currentParcel.layer.feature)
            ? (currentParcel.layer.feature.properties || {})
            : {};

        const parcelNumber = props.BROJ_CESTICE || props.parcel_number || null;
        const cesticaId = props.CESTICA_ID || props.cestica_id || null;
        const cadastralId = props.MATICNI_BROJ_KO || props.maticni_broj_ko || null;

        const params = new URLSearchParams();
        if (parcelNumber && cadastralId) {
            params.set('parcel_identifier', `${parcelNumber}-${cadastralId}`);
        }

        const targetUrl = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
        if (typeof window !== 'undefined') {
            const win = window.open(targetUrl, '_blank', 'noopener,noreferrer');
            if (!win) {
                window.location.href = targetUrl;
            }
        }
    } catch (error) {
        console.error('Failed to open Parcel Builder', error);
        if (typeof updateStatus === 'function') {
            updateStatus('Unable to open Parcel Builder. Please try again.');
        }
    }
}

const PARCEL_CLAIM_PORTAL_URLS = Object.freeze({
    development: 'http://localhost:3001/',
    production: 'https://attestify.network/'
});

const PARCEL_CLAIM_RPC_FALLBACKS = Object.freeze({
    '31337': 'http://127.0.0.1:8545',
    '84532': 'https://sepolia.base.org'
});

const PARCEL_NFT_ABI_FRAGMENT = [
    'function tokenIdForParcelId(string parcelId) view returns (uint256)'
];

function resolveClaimPortalBaseUrl() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return PARCEL_CLAIM_PORTAL_URLS.production;
    }
    if (typeof globalScope.CLAIM_PORTAL_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_BASE_URL.trim()) {
        return globalScope.CLAIM_PORTAL_BASE_URL.trim();
    }
    const env = globalScope.current_environment || 'production';
    if (env === 'development') {
        if (typeof globalScope.CLAIM_PORTAL_DEV_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_DEV_BASE_URL.trim()) {
            return globalScope.CLAIM_PORTAL_DEV_BASE_URL.trim();
        }
        return PARCEL_CLAIM_PORTAL_URLS.development;
    }
    if (typeof globalScope.CLAIM_PORTAL_PROD_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_PROD_BASE_URL.trim()) {
        return globalScope.CLAIM_PORTAL_PROD_BASE_URL.trim();
    }
    return PARCEL_CLAIM_PORTAL_URLS.production;
}

const MINT_DECLARE_DEFAULT_RIGHTS_TYPE = 'Ownership';
const MINT_DECLARE_DEFAULT_ASSET_TYPE = 'Real Estate';

function resolveMintDeclareConfig() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const candidateBaseUrls = [
        globalScope && typeof globalScope.MINT_DECLARE_BASE_URL === 'string' ? globalScope.MINT_DECLARE_BASE_URL : null,
        globalScope && typeof globalScope.MINT_DECLARE_URL === 'string' ? globalScope.MINT_DECLARE_URL : null,
        globalScope && typeof globalScope.MINT_AND_DECLARE_BASE_URL === 'string' ? globalScope.MINT_AND_DECLARE_BASE_URL : null
    ]
        .filter(value => typeof value === 'string')
        .map(value => value.trim())
        .filter(Boolean);
    const baseUrl = candidateBaseUrls.length > 0 ? candidateBaseUrls[0] : resolveClaimPortalBaseUrl();
    const rightsTypeRaw = globalScope && globalScope.MINT_DECLARE_RIGHTS_TYPE ? globalScope.MINT_DECLARE_RIGHTS_TYPE : null;
    const assetTypeRaw = globalScope && globalScope.MINT_DECLARE_ASSET_TYPE ? globalScope.MINT_DECLARE_ASSET_TYPE : null;
    const rightsType = rightsTypeRaw && String(rightsTypeRaw).trim() ? String(rightsTypeRaw).trim() : MINT_DECLARE_DEFAULT_RIGHTS_TYPE;
    const assetType = assetTypeRaw && String(assetTypeRaw).trim() ? String(assetTypeRaw).trim() : MINT_DECLARE_DEFAULT_ASSET_TYPE;
    return { baseUrl, rightsType, assetType };
}

function ensureArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseGeoJsonGeometry(input) {
    if (!input) return null;
    let source = input;
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch (error) {
            return null;
        }
    }
    if (!source) return null;
    if (source.type === 'Feature') {
        return parseGeoJsonGeometry(source.geometry);
    }
    if (source.type && source.coordinates) {
        return source;
    }
    if (source.geometry) {
        return parseGeoJsonGeometry(source.geometry);
    }
    return null;
}

function extractPolygonCoordinateSets(geometryLike) {
    const geometry = parseGeoJsonGeometry(geometryLike);
    if (!geometry) return [];
    switch (geometry.type) {
        case 'Polygon':
            return geometry.coordinates ? [geometry.coordinates] : [];
        case 'MultiPolygon':
            return geometry.coordinates ? geometry.coordinates.map(coords => coords || []) : [];
        case 'GeometryCollection': {
            const polygons = [];
            ensureArray(geometry.geometries).forEach(inner => {
                extractPolygonCoordinateSets(inner).forEach(coords => polygons.push(coords));
            });
            return polygons;
        }
        default:
            return [];
    }
}

function sanitizeRing(ring) {
    if (!Array.isArray(ring)) return [];
    if (ring.length <= 2) return ring.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Array.isArray(first) && Array.isArray(last) && first.length >= 2 && last.length >= 2 && first[0] === last[0] && first[1] === last[1]) {
        return ring.slice(0, ring.length - 1);
    }
    return ring.slice();
}

function computeBoundingBox(polygons) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    polygons.forEach(polygon => {
        ensureArray(polygon).forEach(ring => {
            sanitizeRing(ring).forEach(coord => {
                if (!Array.isArray(coord) || coord.length < 2) return;
                const [lon, lat] = coord;
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
                if (lon < minX) minX = lon;
                if (lat < minY) minY = lat;
                if (lon > maxX) maxX = lon;
                if (lat > maxY) maxY = lat;
            });
        });
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }
    if (minX === maxX) {
        minX -= 0.0001;
        maxX += 0.0001;
    }
    if (minY === maxY) {
        minY -= 0.0001;
        maxY += 0.0001;
    }
    return { minX, minY, maxX, maxY };
}

function projectCoordinate(coord, bounds, width, height, padding) {
    const [lon, lat] = coord;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const maxDrawableWidth = Math.max(width - padding * 2, 1);
    const maxDrawableHeight = Math.max(height - padding * 2, 1);
    const scaleX = spanX > 0 ? maxDrawableWidth / spanX : 1;
    const scaleY = spanY > 0 ? maxDrawableHeight / spanY : 1;
    const scale = Math.min(scaleX, scaleY);
    const usedWidth = spanX * scale;
    const usedHeight = spanY * scale;
    const offsetX = padding + (maxDrawableWidth - usedWidth) / 2;
    const offsetY = padding + (maxDrawableHeight - usedHeight) / 2;
    const x = offsetX + (lon - bounds.minX) * scale;
    const y = height - (offsetY + (lat - bounds.minY) * scale);
    return [
        Number.isFinite(x) ? x : width / 2,
        Number.isFinite(y) ? y : height / 2
    ];
}

function buildParcelSvg(feature, { parcelId, parcelName, width = 512, height = 512, paddingRatio = 0.08 } = {}) {
    if (!feature) return null;
    const geometrySource = feature.geometry || feature;
    const polygons = extractPolygonCoordinateSets(geometrySource);
    if (polygons.length === 0) {
        return null;
    }
    const bounds = computeBoundingBox(polygons);
    if (!bounds) {
        return null;
    }
    const padding = Math.min(width, height) * paddingRatio;
    const pathElements = [];

    polygons.forEach(polygon => {
        const commands = [];
        ensureArray(polygon).forEach(ring => {
            const sanitized = sanitizeRing(ring);
            sanitized.forEach((coord, index) => {
                const projected = projectCoordinate(coord, bounds, width, height, padding);
                commands.push(`${index === 0 ? 'M' : 'L'}${projected[0].toFixed(2)} ${projected[1].toFixed(2)}`);
            });
            if (sanitized.length > 0) {
                commands.push('Z');
            }
        });
        if (commands.length > 0) {
            pathElements.push(
                `<path d="${commands.join(' ')}" fill="#facd55" fill-opacity="0.85" stroke="#f97316" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" fill-rule="evenodd" />`
            );
        }
    });

    if (pathElements.length === 0) {
        return null;
    }

    const primaryLabel = parcelId ? escapeXml(parcelId) : (parcelName ? escapeXml(parcelName) : null);
    const secondaryLabel = parcelId && parcelName && parcelName !== parcelId ? escapeXml(parcelName) : null;
    const labelElements = [];
    if (primaryLabel) {
        labelElements.push(
            `<text x="50%" y="88%" text-anchor="middle" fill="#e5e7eb" font-size="40" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${primaryLabel}</text>`
        );
    }
    if (secondaryLabel) {
        labelElements.push(
            `<text x="50%" y="95%" text-anchor="middle" fill="#94a3b8" font-size="28" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${secondaryLabel}</text>`
        );
    }

    const svgParts = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `  <rect width="${width}" height="${height}" fill="#0b1120" rx="24" />`,
        `  <g>${pathElements.join('\n    ')}</g>`,
        labelElements.length > 0 ? `  <g>${labelElements.join('\n    ')}</g>` : '',
        `</svg>`
    ].filter(Boolean);

    return svgParts.join('\n');
}

function encodeSvgToBase64(svgContent) {
    if (typeof svgContent !== 'string' || !svgContent) {
        return null;
    }
    try {
        if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
            return window.btoa(unescape(encodeURIComponent(svgContent)));
        }
    } catch (error) {
        console.warn('Failed to encode SVG using btoa, falling back to Buffer if available.', error);
    }
    try {
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(svgContent, 'utf8').toString('base64');
        }
    } catch (error) {
        console.warn('Failed to encode SVG using Buffer', error);
    }
    return null;
}

function extractMunicipalityName(feature) {
    if (!feature) return null;
    const props = feature.properties || {};
    const candidates = [
        props.cadastralName,
        props.CADASTRAL_NAME,
        props.cadastralMunicipality && props.cadastralMunicipality.name,
        props.cadastralMunicipality && props.cadastralMunicipality.naziv,
        props.municipality,
        props.MUNICIPALITY
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const value = String(candidate).trim();
        if (value) {
            return value;
        }
    }
    return null;
}

function buildMintDeclareDescription({ parcelId, parcelName, municipality }) {
    if (parcelName && municipality) {
        return `${parcelName} (${parcelId}) in ${municipality}.`;
    }
    if (parcelName) {
        return `${parcelName} (${parcelId}).`;
    }
    if (parcelId && municipality) {
        return `Digitized cadastral parcel ${parcelId} in ${municipality}.`;
    }
    if (parcelId) {
        return `Digitized cadastral parcel ${parcelId}.`;
    }
    return 'Digitized cadastral parcel.';
}

function buildMintDeclareUrl({ feature, parcelId, parcelName, claimContext }) {
    const config = resolveMintDeclareConfig();
    if (!config.baseUrl) {
        return null;
    }
    const svg = buildParcelSvg(feature, { parcelId, parcelName });
    if (!svg) {
        return null;
    }
    const svgBase64 = encodeSvgToBase64(svg);
    if (!svgBase64) {
        return null;
    }

    let urlObject;
    const attemptAbsolute = (raw, fallback) => {
        try {
            return new URL(raw);
        } catch (_) {
            if (!fallback) {
                throw _;
            }
            return new URL(fallback);
        }
    };
    try {
        urlObject = attemptAbsolute(config.baseUrl);
    } catch (_) {
        const normalized = config.baseUrl.startsWith('http://') || config.baseUrl.startsWith('https://')
            ? config.baseUrl
            : `http://${config.baseUrl}`;
        try {
            urlObject = attemptAbsolute(normalized);
        } catch (error) {
            if (typeof window !== 'undefined' && window.location) {
                urlObject = new URL(config.baseUrl, window.location.origin);
            } else {
                console.warn('Unable to resolve Mint & Declare base URL:', config.baseUrl, error);
                return null;
            }
        }
    }

    urlObject.searchParams.set('attest', 'relationship');
    urlObject.searchParams.set('parcelSvgB64', svgBase64);

    const resolvedParcelName = parcelName || (parcelId ? `Parcel ${parcelId}` : 'Selected Parcel');
    const municipality = extractMunicipalityName(feature);
    const description = buildMintDeclareDescription({ parcelId, parcelName: resolvedParcelName, municipality });

    urlObject.searchParams.set('assetName', resolvedParcelName);
    urlObject.searchParams.set('assetDescription', description);
    urlObject.searchParams.set('rightsType', config.rightsType);
    urlObject.searchParams.set('assetType', config.assetType);

    if (parcelId) {
        urlObject.searchParams.set('parcelId', parcelId);
    }
    if (municipality) {
        urlObject.searchParams.set('municipality', municipality);
    }
    if (claimContext && claimContext.contractAddress) {
        urlObject.searchParams.set('contractAddress', claimContext.contractAddress);
    }
    if (claimContext && claimContext.chainId !== undefined && claimContext.chainId !== null) {
        urlObject.searchParams.set('chainId', String(claimContext.chainId));
    }

    return urlObject.toString();
}

function normalizeChainIdValue(chainIdInput) {
    if (chainIdInput === undefined || chainIdInput === null) return null;
    if (typeof chainIdInput === 'bigint') {
        return chainIdInput.toString();
    }
    if (typeof chainIdInput === 'number') {
        if (!Number.isFinite(chainIdInput)) return null;
        return String(Math.trunc(chainIdInput));
    }
    if (typeof chainIdInput === 'string') {
        const trimmed = chainIdInput.trim();
        if (!trimmed) return null;
        const lower = trimmed.toLowerCase();
        const named = {
            'ethereum': '1',
            'mainnet': '1',
            'goerli': '5',
            'sepolia': '11155111',
            'base-sepolia': '84532',
            'base': '8453',
            'hardhat': '31337',
            'anvil': '31337',
            'localhost': '31337',
            'default': null
        };
        if (Object.prototype.hasOwnProperty.call(named, lower) && named[lower]) {
            return named[lower];
        }
        if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
            try {
                return BigInt(trimmed).toString();
            } catch (_) {
                return trimmed.toLowerCase();
            }
        }
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return String(Math.trunc(numeric));
        }
        return trimmed;
    }
    return String(chainIdInput);
}

function chainKeyVariants(chainIdInput) {
    const normalized = normalizeChainIdValue(chainIdInput);
    const variants = new Set();
    if (normalized) {
        variants.add(normalized);
        const numeric = Number(normalized);
        if (Number.isFinite(numeric)) {
            const hex = '0x' + numeric.toString(16);
            variants.add(hex);
            variants.add(hex.toLowerCase());
            variants.add(hex.toUpperCase());
        }
    }
    if (typeof chainIdInput === 'string') {
        const trimmed = chainIdInput.trim();
        if (trimmed) {
            variants.add(trimmed);
            variants.add(trimmed.toLowerCase());
        }
    }
    switch (normalized) {
        case '1':
            variants.add('ethereum');
            break;
        case '5':
            variants.add('goerli');
            break;
        case '11155111':
            variants.add('sepolia');
            break;
        case '84532':
            variants.add('base-sepolia');
            break;
        case '8453':
            variants.add('base');
            break;
        case '31337':
            variants.add('hardhat');
            variants.add('anvil');
            variants.add('localhost');
            break;
        default:
            break;
    }
    variants.add('default');
    return Array.from(variants).filter(Boolean).map(value => value.toLowerCase());
}

function resolveChainSlug(chainIdInput) {
    const normalized = normalizeChainIdValue(chainIdInput);
    if (!normalized) return 'ethereum';
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const overrides = (globalScope && typeof globalScope.CLAIM_CHAIN_SLUGS === 'object' && globalScope.CLAIM_CHAIN_SLUGS) || null;
    if (overrides && overrides[normalized]) {
        const override = String(overrides[normalized]).trim();
        if (override) {
            return override;
        }
    }
    switch (normalized) {
        case '1':
            return 'ethereum';
        case '5':
            return 'goerli';
        case '11155111':
            return 'sepolia';
        case '84532':
            return 'base-sepolia';
        case '8453':
            return 'base';
        case '31337':
            return 'hardhat';
        default:
            return overrides && typeof overrides.default === 'string' && overrides.default.trim()
                ? overrides.default.trim()
                : 'ethereum';
    }
}

function resolveRpcUrlForChain(chainIdInput) {
    const normalized = normalizeChainIdValue(chainIdInput);
    if (!normalized) return null;
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (globalScope) {
        if (typeof globalScope.CLAIM_RPC_URL === 'string' && globalScope.CLAIM_RPC_URL.trim()) {
            return globalScope.CLAIM_RPC_URL.trim();
        }
        if (globalScope.CLAIM_RPC_URLS && typeof globalScope.CLAIM_RPC_URLS === 'object') {
            const custom = globalScope.CLAIM_RPC_URLS[normalized];
            if (typeof custom === 'string' && custom.trim()) {
                return custom.trim();
            }
        }
        if (typeof globalScope.PARCEL_NFT_RPC_URL === 'string' && globalScope.PARCEL_NFT_RPC_URL.trim()) {
            return globalScope.PARCEL_NFT_RPC_URL.trim();
        }
        if (globalScope.PARCEL_NFT_RPC_URLS && typeof globalScope.PARCEL_NFT_RPC_URLS === 'object') {
            const customParcel = globalScope.PARCEL_NFT_RPC_URLS[normalized];
            if (typeof customParcel === 'string' && customParcel.trim()) {
                return customParcel.trim();
            }
        }
    }
    return PARCEL_CLAIM_RPC_FALLBACKS[normalized] || null;
}

function normalizeContractAddress(address, ethersLib) {
    if (typeof address !== 'string') return null;
    const trimmed = address.trim();
    if (!trimmed) return null;
    if (ethersLib && typeof ethersLib.getAddress === 'function') {
        try {
            return ethersLib.getAddress(trimmed);
        } catch (error) {
            console.warn('Invalid ParcelNFT address encountered:', trimmed, error);
            return null;
        }
    }
    return trimmed;
}

function deriveParcelIdentifier(feature) {
    if (!feature || typeof feature !== 'object') return null;
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (globalScope && globalScope.ProposalChainBridge && typeof globalScope.ProposalChainBridge.deriveParcelIdFromFeature === 'function') {
        try {
            const derived = globalScope.ProposalChainBridge.deriveParcelIdFromFeature(feature);
            if (derived) {
                return derived;
            }
        } catch (error) {
            console.warn('Failed to derive parcel id using ProposalChainBridge', error);
        }
    }
    const props = feature.properties || {};
    const brojCestice = props.BROJ_CESTICE ?? props.broj_cestice ?? props.parcel_number ?? props.parcelNumber;
    const maticniBrojKo = props.MATICNI_BROJ_KO ?? props.maticni_broj_ko ?? (props.cadastralMunicipality && props.cadastralMunicipality.id);
    if (brojCestice !== undefined && brojCestice !== null && maticniBrojKo !== undefined && maticniBrojKo !== null) {
        const numberStr = String(brojCestice).trim();
        const municipalityStr = String(maticniBrojKo).trim();
        if (numberStr && municipalityStr) {
            return `HR-${municipalityStr}-${numberStr}`;
        }
    }
    const fallbacks = [
        props.CESTICA_ID,
        props.cestica_id,
        props.parcelId,
        props.parcel_id
    ];
    for (const value of fallbacks) {
        if (value === undefined || value === null) continue;
        const str = String(value).trim();
        if (str) return str;
    }
    return null;
}

function deriveParcelDisplayName(props, fallbackName) {
    if (!props || typeof props !== 'object') {
        return fallbackName;
    }
    const preferredFields = [
        props.name,
        props.NAME,
        props.naziv,
        props.NAZIV,
        props.parcel_name,
        props.PARCEL_NAME,
        props.title
    ];
    for (const value of preferredFields) {
        if (value === undefined || value === null) continue;
        const str = String(value).trim();
        if (str) return str;
    }
    const brojCestice = props.BROJ_CESTICE ?? props.broj_cestice ?? props.parcel_number ?? props.parcelNumber;
    if (brojCestice !== undefined && brojCestice !== null) {
        const numberStr = String(brojCestice).trim();
        if (numberStr) return `Parcel ${numberStr}`;
    }
    return fallbackName;
}

async function resolveParcelNftAddress(chainIdInput) {
    const normalized = normalizeChainIdValue(chainIdInput);
    if (!normalized) return null;
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) return null;
    if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
        try {
            const loaderAddress = await globalScope.ContractsLoader.getContractAddress(normalized, 'ParcelNFT');
            if (loaderAddress) {
                return loaderAddress;
            }
        } catch (error) {
            console.warn('Failed to load ParcelNFT address from ContractsLoader:', error);
        }
    }
    const directSources = [
        globalScope.PARCEL_NFT_ADDRESS,
        globalScope.parcelNftAddress,
        globalScope.envParcelNftAddress,
        globalScope.CONSENSUS_PARCEL_NFT_ADDRESS
    ];
    for (const source of directSources) {
        if (typeof source === 'string' && source.trim()) {
            return source.trim();
        }
    }
    const variants = chainKeyVariants(normalized);
    const objectSources = [
        globalScope.CONSENSUS_CONTRACTS && globalScope.CONSENSUS_CONTRACTS.parcelNFT,
        globalScope.consensusContracts && globalScope.consensusContracts.parcelNFT
    ];
    for (const candidate of objectSources) {
        if (!candidate) continue;
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
        if (typeof candidate === 'object') {
            for (const key of variants) {
                const value = candidate[key];
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
        }
    }
    try {
        if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.getItem === 'function') {
            const storageKeys = ['parcel_nft_address', 'parcelNFTAddress', 'parcelNftAddress'];
            for (const key of storageKeys) {
                const stored = globalScope.PersistentStorage.getItem(key);
                if (typeof stored === 'string' && stored.trim()) {
                    return stored.trim();
                }
            }
        }
    } catch (error) {
        console.warn('Failed to load ParcelNFT address from persistent storage', error);
    }
    return null;
}

async function resolveParcelClaimContext() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.ethers) {
        throw new Error('Blockchain library is not available.');
    }
    const walletManager = globalScope.walletManager;
    const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
    const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;

    const candidates = [];
    if (walletState && walletState.chainId !== undefined && walletState.chainId !== null) {
        const normalized = normalizeChainIdValue(walletState.chainId);
        if (normalized) {
            candidates.push({ chainId: normalized, source: 'wallet', provider: walletProvider });
        }
    }

    if (Array.isArray(globalScope.CLAIM_CHAIN_ID_PRIORITY)) {
        globalScope.CLAIM_CHAIN_ID_PRIORITY.forEach(idValue => {
            const normalized = normalizeChainIdValue(idValue);
            if (normalized && !candidates.some(entry => entry.chainId === normalized)) {
                candidates.push({ chainId: normalized, source: 'priority' });
            }
        });
    }

    const defaultChainId = normalizeChainIdValue((function () {
        if (globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
            return globalScope.DEFAULT_CHAIN_ID;
        }
        const env = globalScope.current_environment || 'production';
        if (env === 'development') return '31337';
        return '84532';
    })());
    if (defaultChainId && !candidates.some(entry => entry.chainId === defaultChainId)) {
        candidates.push({ chainId: defaultChainId, source: 'default' });
    }

    if (candidates.length === 0) {
        throw new Error('No chain candidates available for parcel claims.');
    }

    for (const candidate of candidates) {
        const resolvedAddress = await resolveParcelNftAddress(candidate.chainId);
        if (!resolvedAddress) {
            continue;
        }

        if (candidate.source === 'wallet' && candidate.provider) {
            try {
                const browserProvider = new globalScope.ethers.BrowserProvider(candidate.provider);
                const network = await browserProvider.getNetwork();
                const networkChainId = network && network.chainId ? normalizeChainIdValue(network.chainId) : candidate.chainId;
                const addressForNetwork = await resolveParcelNftAddress(networkChainId);
                const normalizedAddress = normalizeContractAddress(addressForNetwork || resolvedAddress, globalScope.ethers);
                if (!normalizedAddress) {
                    continue;
                }
                return {
                    chainId: networkChainId,
                    chainSlug: resolveChainSlug(networkChainId),
                    contractAddress: normalizedAddress,
                    provider: browserProvider
                };
            } catch (error) {
                console.warn('Wallet provider unusable for parcel claim context', error);
                // Fall back to RPC lookup for the same chain
            }
        }

        const rpcUrl = resolveRpcUrlForChain(candidate.chainId);
        if (!rpcUrl) {
            console.warn('No RPC endpoint configured for chain', candidate.chainId);
            continue;
        }

        const normalizedAddress = normalizeContractAddress(resolvedAddress, globalScope.ethers);
        if (!normalizedAddress) {
            continue;
        }

        const numericChainId = Number(candidate.chainId);
        let provider;
        try {
            provider = Number.isFinite(numericChainId)
                ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                : new globalScope.ethers.JsonRpcProvider(rpcUrl);
            if (typeof provider._detectNetwork === 'function') {
                await provider._detectNetwork();
            } else if (typeof provider.getNetwork === 'function') {
                await provider.getNetwork();
            }
        } catch (error) {
            console.warn('Unable to reach RPC endpoint for parcel claim resolution', {
                chainId: candidate.chainId,
                rpcUrl,
                error
            });
            continue;
        }

        return {
            chainId: candidate.chainId,
            chainSlug: resolveChainSlug(candidate.chainId),
            contractAddress: normalizedAddress,
            provider
        };
    }

    throw new Error('ParcelNFT contract configuration or RPC connectivity is unavailable for parcel claims.');
}

function isParcelTokenMissingError(error) {
    if (!error) return false;
    const candidates = [
        typeof error.shortMessage === 'string' ? error.shortMessage : null,
        typeof error.message === 'string' ? error.message : null,
        typeof error.reason === 'string' ? error.reason : null,
        typeof error.data === 'string' ? error.data : null,
        typeof error.data?.message === 'string' ? error.data.message : null,
        typeof error?.info?.error?.message === 'string' ? error.info.error.message : null,
        typeof error?.info?.error?.data?.message === 'string' ? error.info.error.data.message : null,
        typeof error?.error?.message === 'string' ? error.error.message : null,
        typeof error?.error?.data?.message === 'string' ? error.error.data.message : null,
        typeof error?.data?.originalError?.message === 'string' ? error.data.originalError.message : null,
        typeof error?.error?.data?.originalError?.message === 'string' ? error.error.data.originalError.message : null,
        typeof error?.data?.originalError?.data === 'string' ? error.data.originalError.data : null,
        typeof error?.error?.data?.originalError?.data === 'string' ? error.error.data.originalError.data : null
    ].filter(Boolean);
    if (candidates.length === 0) return false;
    return candidates.some(msg => msg.toLowerCase().includes('parcel does not exist'));
}

function buildClaimUrl({ baseUrl, chainSlug, contractAddress, tokenId, parcelName }) {
    const url = new URL(baseUrl || PARCEL_CLAIM_PORTAL_URLS.production);
    url.searchParams.set('attest', 'ownership');
    if (chainSlug) {
        url.searchParams.set('targetChain', chainSlug);
    }
    if (contractAddress) {
        url.searchParams.set('targetContract', contractAddress);
    }
    if (tokenId !== undefined && tokenId !== null) {
        url.searchParams.set('targetTokenId', String(tokenId));
    }
    if (parcelName) {
        url.searchParams.set('targetName', parcelName);
    }
    url.searchParams.set('tab', 'attestations');
    return url.toString();
}

function openExternalUrl(targetUrl) {
    if (!targetUrl) return;
    if (typeof window === 'undefined') {
        return;
    }
    const opened = window.open(targetUrl, '_blank', 'noopener,noreferrer');
    if (opened) {
        return;
    }
    if (typeof document === 'undefined' || !document.body) {
        window.location.href = targetUrl;
        return;
    }
    const anchor = document.createElement('a');
    anchor.href = targetUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
}

function toStringSafe(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
    return String(value);
}

async function fetchParcelTokenId(contract, parcelId) {
    try {
        return await contract.tokenIdForParcelId(parcelId);
    } catch (error) {
        if (isParcelTokenMissingError(error)) {
            const sentinel = new Error('TOKEN_NOT_MINTED');
            sentinel.cause = error;
            throw sentinel;
        }
        throw error;
    }
}

async function openClaimPortal() {
    if (!currentParcel || !currentParcel.layer || !currentParcel.layer.feature) {
        if (typeof updateStatus === 'function') {
            updateStatus('Select a parcel before attempting to claim it.');
        }
        return;
    }
    const feature = currentParcel.layer.feature;
    const props = feature.properties || {};
    const parcelId = deriveParcelIdentifier(feature);
    if (!parcelId) {
        if (typeof updateStatus === 'function') {
            updateStatus('Unable to determine parcel identifier for claims.');
        }
        return;
    }
    const parcelName = `Parcel ${parcelId}`;

    try {
        if (typeof updateStatus === 'function') {
            updateStatus('Resolving parcel claim details...');
        }
        currentParcelMintStatusCache = null;
        currentParcelMintStatusParcelId = parcelId;
        currentParcelMintStatusPromise = null;
        setParcelMintStatusIndicator('Checking NFT status...', 'loading');
        const claimContext = await resolveParcelClaimContext();
        const baseUrl = resolveClaimPortalBaseUrl();
        const ethersLib = typeof window !== 'undefined' ? window.ethers : null;
        if (!ethersLib) {
            throw new Error('Blockchain library is not available.');
        }
        const contract = new ethersLib.Contract(
            claimContext.contractAddress,
            PARCEL_NFT_ABI_FRAGMENT,
            claimContext.provider
        );

        let tokenId;
        try {
            const tokenIdRaw = await fetchParcelTokenId(contract, parcelId);
            tokenId = toStringSafe(tokenIdRaw);
            const mintedResult = {
                minted: true,
                tokenId,
                chainSlug: claimContext.chainSlug,
                contractAddress: claimContext.contractAddress
            };
            currentParcelMintStatusCache = { parcelId, result: mintedResult };
            currentParcelMintStatusParcelId = parcelId;
            applyParcelMintStatusResult(mintedResult);
        } catch (error) {
            if (error && error.message === 'TOKEN_NOT_MINTED') {
                const notMintedResult = {
                    minted: false,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress
                };
                currentParcelMintStatusCache = { parcelId, result: notMintedResult };
                currentParcelMintStatusParcelId = parcelId;
                applyParcelMintStatusResult(notMintedResult);
                const mintDeclareUrl = buildMintDeclareUrl({
                    feature,
                    parcelId,
                    parcelName,
                    claimContext
                });
                if (mintDeclareUrl) {
                    if (typeof updateStatus === 'function') {
                        updateStatus('Parcel not minted yet. Opening Mint & Declare flow...');
                    }
                    openExternalUrl(mintDeclareUrl);
                } else if (typeof updateStatus === 'function') {
                    updateStatus("Parcel not minted yet and the Mint & Declare flow couldn't be prepared.");
                }
                return;
            }
            throw error;
        }

        const claimUrl = buildClaimUrl({
            baseUrl,
            chainSlug: claimContext.chainSlug,
            contractAddress: claimContext.contractAddress,
            tokenId,
            parcelName
        });
        if (typeof updateStatus === 'function') {
            updateStatus('Opening claim portal...');
        }
        openExternalUrl(claimUrl);
    } catch (error) {
        console.error('Failed to open claim portal', error);
        setParcelMintStatusIndicator('Unable to check NFT status.', 'error');
        currentParcelMintStatusCache = null;
        if (typeof updateStatus === 'function') {
            updateStatus('Unable to open claim portal. Please try again.');
        }
    }
}

if (typeof window !== 'undefined') {
    window.openParcelBuilder = openParcelBuilder;
    window.openClaimPortal = openClaimPortal;
}

// Function to measure parcel as road when button is clicked
function measureAsRoad() {
    if (!currentParcel || !currentParcel.layer) {
        updateStatus('No parcel selected for road measurement.');
        return;
    }

    const button = document.getElementById('measureAsRoadButton');
    const measurementsDiv = document.getElementById('roadMeasurements');

    // Show loading state
    button.innerHTML = '⏳ Calculating...';
    button.disabled = true;

    try {
        // Calculate road metrics
        const feature = currentParcel.layer.feature;
        const metrics = calculateRoadMetrics(feature.geometry.coordinates);

        // Format the measurements
        const formattedLength = metrics ? Number(metrics.length).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedAvgWidth = metrics ? Number(metrics.widths.average).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedMaxWidth = metrics ? Number(metrics.widths.maximum).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedMinWidth = metrics ? Number(metrics.widths.minimum).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedTolerance = metrics ? Number(metrics.widths.tolerancePercentage).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1
        }) : 'N/A';

        // Display the measurements
        measurementsDiv.innerHTML = `
        <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
        <div class="metric-group">
            <div class="metric-label">As Road Length:</div>
            <div class="metric-value">${formattedLength} m</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">As Road Width:</div>
            <div class="metric-value">
                Average: ${formattedAvgWidth} m<br>
                Maximum: ${formattedMaxWidth} m<br>
                Minimum: ${formattedMinWidth} m
            </div>
        </div>
        <div class="metric-group">
                <div class="metric-label">As Road Width Consistency:</div>
            <div class="metric-value">${formattedTolerance}% within ±10% of average</div>
        </div>
    `;

        measurementsDiv.style.display = 'block';

        // Update button to show completion and disable it since measurements are now shown
        button.innerHTML = 'Measurements added';
        button.disabled = true;

        updateStatus('Road measurements calculated and added to panel.');

    } catch (error) {
        console.error('Error calculating road metrics:', error);
        updateStatus('Error calculating road measurements.');
        button.innerHTML = 'Measure as road';
        button.disabled = false;
    }
}

function hideParcelInfoPanel() {
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');
    clearRoadVisualization();

    resetParcelMintStatusState();

    const previouslySelectedId = selectedParcelId ? selectedParcelId.toString() : null;
    selectedParcelId = null;
    window.selectedParcelId = null;
    currentParcel = null;
    window.currentParcel = null;
    currentParcelCoordinates = null;

    if (typeof refreshParcelStylesForAppliedProposals === 'function') {
        refreshParcelStylesForAppliedProposals();
    } else if (previouslySelectedId && parcelLayer) {
        const previousLayer = parcelLayer.getLayers().find(layer => {
            const id = layer?.feature?.properties?.CESTICA_ID;
            return id !== undefined && id !== null && id.toString() === previouslySelectedId;
        });
        if (previousLayer) {
            const isRoad = PersistentStorage.getItem(`parcel_${previouslySelectedId}_isRoad`) === 'true';
            previousLayer.setStyle(getParcelBaseStyle(previouslySelectedId, { isRoad }));
        }
    }

    // Leaving parcel details should also clear any proposal overlays/highlights
    try { if (typeof clearProposalInfoHoverOverlay === 'function') clearProposalInfoHoverOverlay(); } catch (_) { }
    try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }

    // Hide the create proposal button
    const createProposalButton = document.getElementById('createProposalFromParcelButton');
    if (createProposalButton) {
        createProposalButton.style.display = 'none';
    }

    // Update the sidebar Create Proposal button visibility
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.updateCreateProposalButton) {
        multiParcelSelection.updateCreateProposalButton();
    }

    if (typeof neighborHighlightActive !== 'undefined' && neighborHighlightActive) {
        neighborHighlightActive = false;
        const neighborBtn = document.getElementById('neighboursButton');
        if (neighborBtn) neighborBtn.classList.remove('active');
        clearHighlightedNeighbors();
    }
    if (typeof verticesDisplayActive !== 'undefined' && verticesDisplayActive) {
        verticesDisplayActive = false;
        const verticesBtn = document.getElementById('verticesButton');
        if (verticesBtn) verticesBtn.classList.remove('active');
        clearVertexMarkers();
    }
}

// Function to create proposal from single parcel
function createProposalFromSingleParcel() {
    console.log('createProposalFromSingleParcel called');

    if (!currentParcel || !currentParcel.layer) {
        updateStatus('No parcel selected. Please select a parcel first.');
        return;
    }

    // Add the current parcel to multi-selection and show proposal dialog
    if (typeof multiParcelSelection !== 'undefined') {
        // Only clear existing selection if multi-select is not active
        // If multi-select is active, this function shouldn't be called
        if (!multiParcelSelection.isActive) {
            multiParcelSelection.selectedParcels.clear();
            multiParcelSelection.selectedParcels.add(currentParcel.id);
            showProposalDialog();
        } else {
            // Multi-select is active, so we shouldn't interfere with existing selection
            console.warn('createProposalFromSingleParcel called while multi-select is active - this should not happen');
            updateStatus('Please use the main "Create Proposal" button when multiple parcels are selected.');
        }
    }
}

function createProposalFromSelectedParcels() {
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || !multiParcelSelection.isActive) {
        updateStatus('Enable multi-parcel selection to use this action.');
        return;
    }

    const hasSelection = multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0;
    if (!hasSelection) {
        updateStatus('Select at least one parcel to create a proposal.');
        return;
    }

    if (typeof showProposalDialog === 'function') {
        showProposalDialog();
    }
}

function renderParcelProposalActions(parcelIdOverride = null) {
    const container = document.getElementById('parcel-proposal-actions');
    if (!container) return;

    const hasMultiSelect = typeof multiParcelSelection !== 'undefined' && !!multiParcelSelection;
    const multiSelectActive = hasMultiSelect && multiParcelSelection.isActive;
    const selectionCount = multiSelectActive && multiParcelSelection.selectedParcels
        ? multiParcelSelection.selectedParcels.size
        : 0;

    if (multiSelectActive && selectionCount > 0) {
        const label = 'Create proposal';
        container.innerHTML = `
            <button type="button" class="btn btn-proposal" id="createProposalFromSelectionButton" onclick="createProposalFromSelectedParcels()">
                ${label}
            </button>
        `;
        return;
    }

    const parcelContextId = parcelIdOverride || (currentParcel && currentParcel.id);
    if (parcelContextId) {
        container.innerHTML = `
            <button type="button" class="btn btn-proposal" id="createProposalFromParcelButton" onclick="createProposalFromSingleParcel()">
                Create proposal
            </button>
        `;
    } else {
        container.innerHTML = '';
    }
}

// --- Parcel Number Labels ---
let parcelNumberLabels = [];
let parcelNumberLabelFilter = null;

function toggleParcelNumbers() {
    const checkbox = document.getElementById('showParcelNumbers');
    const show = checkbox ? checkbox.checked : false;
    if (show) {
        drawParcelNumberLabels();
    } else {
        clearParcelNumberLabels();
    }
}

function drawParcelNumberLabels() {
    clearParcelNumberLabels();
    if (!parcelLayer) return;

    const cityId = getCurrentCityId();
    const parcelNumberProperty = cityId === 'buenos_aires' ? 'smp' : 'BROJ_CESTICE';
    const parcelIdProperty = cityId === 'buenos_aires' ? 'CESTICA_ID' : 'CESTICA_ID';

    parcelLayer.eachLayer(layer => {
        if (!layer?.feature?.properties) return;
        const parcelNumber = layer.feature.properties[parcelNumberProperty];
        if (!parcelNumber) return;
        const parcelId = layer.feature.properties[parcelIdProperty] ? layer.feature.properties[parcelIdProperty].toString() : null;
        if (parcelNumberLabelFilter && parcelId && !parcelNumberLabelFilter.has(parcelId)) {
            return;
        }

        let labelLatLng = null;
        const geometry = layer.feature.geometry;

        if (geometry && typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            try {
                const centroid = turf.centerOfMass(geometry);
                const coords = centroid?.geometry?.coordinates;
                if (Array.isArray(coords) && coords.length >= 2) {
                    const [lng, lat] = coords;
                    if (Number.isFinite(lat) && Number.isFinite(lng)) {
                        labelLatLng = L.latLng(lat, lng);
                    }
                }
            } catch (error) {
                console.warn('Unable to compute centroid for parcel label', error);
            }
        }

        if (!labelLatLng && typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && typeof bounds.getCenter === 'function') {
                const center = bounds.getCenter();
                if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                    labelLatLng = center;
                }
            }
        }

        if (!labelLatLng) return;

        const label = L.marker(labelLatLng, {
            icon: L.divIcon({
                className: 'parcel-number-label',
                html: `${parcelNumber}`,
                iconSize: [40, 18],
                iconAnchor: [20, 9]
            }),
            interactive: false
        }).addTo(map);
        parcelNumberLabels.push(label);
    });
}

function clearParcelNumberLabels() {
    parcelNumberLabels.forEach(label => map.removeLayer(label));
    parcelNumberLabels = [];
}

function refreshParcelNumberLabelsIfVisible() {
    const checkbox = document.getElementById('showParcelNumbers');
    if (checkbox && checkbox.checked) {
        drawParcelNumberLabels();
    }
}

function setParcelNumberLabelFilter(ids) {
    if (ids && ids.size) {
        parcelNumberLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
    } else {
        parcelNumberLabelFilter = null;
    }
    refreshParcelNumberLabelsIfVisible();
}

// --- Parcel Data Fetching and Management ---
async function fetchParcelData(customBounds) {
    if (isFetchingParcels) {
        // updateStatus("Already fetching parcel data...");
        return;
    }
    // Respect zoom guard to avoid fetching when zoomed too far out/in
    try {
        if (!customBounds && typeof window.isZoomWithinParcelRange === 'function' && !window.isZoomWithinParcelRange()) {
            updateStatus('Parcels disabled at this zoom');
            return;
        }
    } catch (_) { }
    isFetchingParcels = true;
    setParcelMergeInProgressState(true);
    updateStatus('Fetching data...');
    const newParcelIdsSet = new Set();
    try {
        const viewBounds = customBounds || map.getBounds();
        if (!viewBounds) {
            updateStatus('Unable to determine map bounds for parcel fetch.');
            return;
        }
        const latLngPadding = (!customBounds && typeof viewBounds.pad === 'function')
            ? Number((typeof window !== 'undefined' && window.PARCEL_FETCH_LATLNG_PADDING !== undefined)
                ? window.PARCEL_FETCH_LATLNG_PADDING
                : PARCEL_FETCH_LATLNG_PADDING)
            : 0;
        const boundsForCells = (!customBounds && typeof viewBounds.pad === 'function' && latLngPadding > 0)
            ? viewBounds.pad(latLngPadding)
            : viewBounds;
        const gridRadius = Number((typeof window !== 'undefined' && window.PARCEL_FETCH_GRID_RADIUS !== undefined)
            ? window.PARCEL_FETCH_GRID_RADIUS
            : PARCEL_FETCH_GRID_RADIUS);
        const requiredCells = getRequiredGridCells(boundsForCells, gridRadius);
        const missingCells = new Set(requiredCells);
        for (const cell of requiredCells) {
            if (parcelCache.grid.has(cell)) {
                missingCells.delete(cell);
            }
        }
        if (missingCells.size > 0) {
            const totalCells = missingCells.size;
            let completedCells = 0;
            updateStatus(`Fetching data for ${totalCells} new grid cells (0/${totalCells})...`);
            const fetchPromises = Array.from(missingCells).map(async (cell) => {
                const [gridEasting, gridNorthing] = cell.split(',').map(Number);
                const swEasting = gridEasting * parcelCache.gridSize;
                const swNorthing = gridNorthing * parcelCache.gridSize;
                const neEasting = (gridEasting + 1) * parcelCache.gridSize;
                const neNorthing = (gridNorthing + 1) * parcelCache.gridSize;
                const bbox = `${swEasting},${swNorthing},${neEasting},${neNorthing}`;
                const swLatLng = htrs96ToWGS84(swEasting, swNorthing);
                const neLatLng = htrs96ToWGS84(neEasting, neNorthing);
                const latLonBbox = (function () {
                    const latValues = [swLatLng[0], neLatLng[0]].filter(Number.isFinite);
                    const lonValues = [swLatLng[1], neLatLng[1]].filter(Number.isFinite);
                    if (latValues.length < 2 || lonValues.length < 2) {
                        return null;
                    }
                    const minLat = Math.min(latValues[0], latValues[1]);
                    const maxLat = Math.max(latValues[0], latValues[1]);
                    const minLon = Math.min(lonValues[0], lonValues[1]);
                    const maxLon = Math.max(lonValues[0], lonValues[1]);
                    return `${minLon},${minLat},${maxLon},${maxLat}`;
                })();
                const builder = (typeof buildParcelRequestParams === 'function') ? buildParcelRequestParams : null;
                let allFeatures = [];
                let startIndex = 0;
                const count = 2000;
                let more = true;
                while (more) {
                    const req = builder ? builder(bbox, { count, startIndex, latLonBbox }) : null;
                    const useParcelBa = req && req.source === 'parcel-ba';
                    const url = req ? req.url : (function () {
                        const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
                        const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
                        return `${baseUrl}?${new URLSearchParams({
                            token: token,
                            service: 'WFS',
                            version: '2.0.0',
                            request: 'GetFeature',
                            outputFormat: 'json',
                            typeName: 'oss:DKP_CESTICE',
                            srsName: 'EPSG:3765',
                            bbox: bbox,
                            count: String(count),
                            startIndex: String(startIndex)
                        }).toString()}`;
                    })();
                    let data;
                    if (useParcelBa) {
                        try {
                            const response = await fetch(url);
                            if (response.status === 404) {
                                data = { features: [], numberReturned: 0 };
                                more = false;
                            } else {
                                if (!response.ok) {
                                    throw new Error(`Failed parcel-ba fetch ${response.status}`);
                                }
                                data = await response.json();
                            }
                        } catch (error) {
                            console.warn('parcel-ba fetch failed', error);
                            throw error;
                        }
                    } else {
                        const response = await fetchWithRetry(url);
                        data = await response.json();
                    }
                    const features = Array.isArray(data.features) ? data.features : [];
                    allFeatures = allFeatures.concat(features);
                    const numberReturned = Number(data.numberReturned || features.length);
                    // If WFS 2.0 numberMatched is provided, use it for termination
                    const numberMatched = Number(data.numberMatched);
                    if (isFinite(numberMatched) && numberMatched > 0) {
                        more = startIndex + numberReturned < numberMatched && numberReturned > 0;
                    } else {
                        // Fallback: stop when a page returns fewer than requested
                        more = numberReturned === count && numberReturned > 0;
                    }
                    startIndex += numberReturned;
                }
                const cellData = { type: 'FeatureCollection', features: allFeatures };
                parcelCache.grid.set(cell, cellData);
                completedCells++;
                updateStatus(`Fetching data for ${totalCells} new grid cells (${completedCells}/${totalCells})...`);
                allFeatures.forEach(feature => {
                    const parcelId = feature?.properties?.CESTICA_ID;
                    if (parcelId !== undefined && parcelId !== null) {
                        newParcelIdsSet.add(String(parcelId));
                    }
                });
            });
            const settledPromises = await Promise.allSettled(fetchPromises);
            settledPromises
                .filter(p => p.status === 'rejected')
                .forEach(p => console.error("Failed to fetch parcel grid cell:", p.reason));
        }

        setParcelMergeInProgressState(true);
        updateStatus('Merging parcel data...');

        // Build set of existing parcel IDs already on the map to avoid reprocessing
        const existingParcelIds = new Set();
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const parcelId = layer.feature?.properties?.CESTICA_ID;
                if (parcelId !== undefined && parcelId !== null) {
                    existingParcelIds.add(String(parcelId));
                }
            });
        }

        // Merge and process features - ONLY from required cells
        const featuresMap = new Map();
        const serverParcelIds = new Set();
        const modifiedParcelSet = (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getModifiedParcelsSet === 'function')
            ? ProposalManager._getModifiedParcelsSet()
            : (function () {
                try {
                    const list = JSON.parse(PersistentStorage.getItem('modified_parcels') || '[]');
                    if (Array.isArray(list)) {
                        return new Set(list.map(String));
                    }
                } catch (_) { }
                return new Set();
            })();

        let storedGeometryCount = 0;
        let storedPropertiesCount = 0;
        let processedFeatureCount = 0;

        // Process features from required cells
        for (const cell of requiredCells) {
            const cellData = parcelCache.grid.get(cell);
            if (!cellData || !Array.isArray(cellData.features)) {
                continue;
            }
            for (const feature of cellData.features) {
                const parcelId = String(feature.properties.CESTICA_ID);
                serverParcelIds.add(parcelId);

                // Skip if modified or already exists on map
                if (modifiedParcelSet.has(parcelId) || existingParcelIds.has(parcelId)) {
                    continue;
                }

                const storedGeometryStr = PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
                const storedPropertiesStr = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
                if (storedGeometryStr) {
                    try {
                        const storedGeometry = JSON.parse(storedGeometryStr);
                        feature.geometry = {
                            type: 'Polygon',
                            coordinates: [storedGeometry]
                        };
                        feature.properties.calculatedArea = calculateArea([storedGeometry]);
                        storedGeometryCount++;
                    } catch (e) { console.error(`Error parsing stored geometry for ${parcelId}:`, e); }
                }
                if (storedPropertiesStr) {
                    try {
                        const storedProperties = JSON.parse(storedPropertiesStr);
                        const originalCalculatedArea = feature.properties.calculatedArea;
                        feature.properties = { ...feature.properties, ...storedProperties };
                        if (storedGeometryStr) {
                            feature.properties.calculatedArea = originalCalculatedArea;
                        } else {
                            feature.properties.calculatedArea = calculateArea(feature.geometry.coordinates);
                        }
                        storedPropertiesCount++;
                    } catch (e) { console.error(`Error parsing stored properties for ${parcelId}:`, e); }
                }
                if (!storedGeometryStr && storedPropertiesStr) {
                    feature.properties.calculatedArea = calculateArea(feature.geometry.coordinates);
                }
                const govtPlanAppliedValue = PersistentStorage.getItem(`parcel_${parcelId}_government_plan_applied`);
                if (govtPlanAppliedValue) {
                    feature.properties.governmentPlanApplied = true;
                    feature.properties.government_plan_applied = true;
                    feature.properties.governmentPlanAppliedHash = govtPlanAppliedValue;
                    feature.properties.government_plan_applied_hash = govtPlanAppliedValue;
                }
                if (!featuresMap.has(parcelId)) {
                    featuresMap.set(parcelId, feature);
                }
                processedFeatureCount += 1;
                if (processedFeatureCount % 200 === 0) {
                    await yieldToMainThread();
                }
            }
        }

        // Only add modified parcels from localStorage (not ALL parcels)
        // These are parcels that have been split or edited and aren't in the server data
        let addedFromPersistentStorage = 0;
        for (const parcelId of modifiedParcelSet) {
            if (!featuresMap.has(parcelId) && !existingParcelIds.has(parcelId)) {
                const geometryStr = PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
                const propertiesStr = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
                if (geometryStr && propertiesStr) {
                    try {
                        const geometry = JSON.parse(geometryStr);
                        const properties = JSON.parse(propertiesStr);
                        if (!properties.calculatedArea) {
                            properties.calculatedArea = calculateArea([geometry]);
                        }
                        const govtPlanAppliedValue = PersistentStorage.getItem(`parcel_${parcelId}_government_plan_applied`);
                        if (govtPlanAppliedValue) {
                            properties.governmentPlanApplied = true;
                            properties.government_plan_applied = true;
                            properties.governmentPlanAppliedHash = govtPlanAppliedValue;
                            properties.government_plan_applied_hash = govtPlanAppliedValue;
                        }
                        const newFeature = {
                            type: 'Feature',
                            properties: properties,
                            geometry: {
                                type: 'Polygon',
                                coordinates: [geometry]
                            }
                        };
                        featuresMap.set(parcelId, newFeature);
                        addedFromPersistentStorage++;
                    } catch (e) { console.error(`Error reconstructing feature ${parcelId} from PersistentStorage:`, e); }
                }
            }
        }
        // Convert only NEW features from HTRS96 to WGS84
        const newFeatures = Array.from(featuresMap.values());
        const convertedFeatures = [];
        const conversionChunkSize = 200;

        if (newFeatures.length > 0) {
            for (let start = 0; start < newFeatures.length; start += conversionChunkSize) {
                const chunk = newFeatures.slice(start, start + conversionChunkSize);
                const convertedChunk = convertGeoJSON({
                    type: 'FeatureCollection',
                    features: chunk
                });
                if (convertedChunk && Array.isArray(convertedChunk.features)) {
                    convertedFeatures.push(...convertedChunk.features);
                }
                await yieldToMainThread();
            }
        }

        // For the parcelDataLoaded event, we need all features (existing + new)
        // But we only need to process/render the new ones
        const allFeatures = [];

        // Add existing features from parcelLayer
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                if (layer.feature) {
                    allFeatures.push(layer.feature);
                }
            });
        }

        // Add newly converted features
        allFeatures.push(...convertedFeatures);

        const convertedData = {
            type: 'FeatureCollection',
            features: allFeatures
        };

        const newConvertedFeatures = convertedFeatures; // All converted features are new
        if (!parcelLayer) {
            parcelLayer = L.featureGroup().addTo(map);
            window.parcelLayer = parcelLayer; // Update global reference
        }

        await yieldToMainThread();
        recomputeParcelsWithAppliedSpatialProposals();

        const styleFeature = (feature) => {
            const parcelId = feature.properties.CESTICA_ID;
            const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            return getParcelBaseStyle(parcelId, { isRoad });
        };
        const attachParcelEvents = function (feature, layer) {
            layer.on({
                mouseover: highlightFeature,
                mouseout: resetHighlight,
                click: onParcelClick
            });
        };

        // Add new parcels to the map FIRST (convertedFeatures only contains NEW parcels)
        const featureAddChunkSize = 150;
        for (let start = 0; start < convertedFeatures.length; start += featureAddChunkSize) {
            const chunk = convertedFeatures.slice(start, start + featureAddChunkSize);

            if (chunk.length > 0) {
                L.geoJSON({
                    type: 'FeatureCollection',
                    features: chunk
                }, {
                    style: styleFeature,
                    onEachFeature: attachParcelEvents
                }).eachLayer(layer => {
                    parcelLayer.addLayer(layer);
                    indexParcelLayer(layer);
                    const parcelId = layer.feature.properties.CESTICA_ID;
                    const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    if (isRoad) {
                        const roadName = PersistentStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';
                        layer.bindTooltip(roadName, {
                            permanent: false,
                            direction: 'center',
                            className: 'road-name-tooltip'
                        });
                        layer.feature.properties.isRoad = true;
                        layer.feature.properties.roadName = roadName;
                        layer.feature.properties.roadId = PersistentStorage.getItem(`parcel_${parcelId}_roadId`) || '';
                        layer.feature.properties.roadConfidence =
                            PersistentStorage.getItem(`parcel_${parcelId}_roadConfidence`) || '0';
                    }
                });
            }
            await yieldToMainThread();
        }

        // Don't remove parcels from the map - just keep adding new ones
        // This prevents issues with:
        // 1. Parent parcels being removed before proposals can apply
        // 2. Parcels disappearing when panning
        // 3. Complex parent-child relationship tracking
        // The user can clear the cache manually if memory becomes an issue

        parcelCoverageVersion += 1;
        try { window.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { }
        try {
            window.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                detail: {
                    version: parcelCoverageVersion,
                    source: 'fetch',
                    timestamp: Date.now()
                }
            }));
        } catch (_) { }
        // Update block info for parcels
        if (typeof blockStorage !== 'undefined' && blockStorage.load) {
            blockStorage.load();
            blockStorage.blocks.forEach((block, blockName) => {
                block.parcels = [];
                parcelLayer.eachLayer(layer => {
                    const parcelId = layer.feature.properties.CESTICA_ID;
                    if (block.parcelIds.includes(parcelId)) {
                        layer.feature.properties.block = blockName;
                        layer.feature.properties.blockValid = block.valid;
                        block.parcels.push(layer);
                    }
                });
            });
        }
        refreshParcelStylesForAppliedProposals();
        updateVisibleParcelsCount();

        const totalOnMap = parcelLayer ? parcelLayer.getLayers().length : 0;
        const newCount = convertedFeatures.length;
        if (newCount > 0) {
            updateStatus(`Added ${newCount} new parcels (${totalOnMap} total in layer)`);
        } else {
            updateStatus(`No new parcels to load (${totalOnMap} parcels visible)`);
        }
        const showParcelsElem = document.getElementById('showParcels');
        const showParcels = showParcelsElem ? showParcelsElem.checked : true;
        if (showParcels) {
            // Add parcels to map without calling showAllParcels() to avoid redundant status messages
            parcelLayer.addTo(map);
            parcelLayer.eachLayer(layer => {
                layer.addTo(map);
            });
        } else {
            hideAllParcels();
        }
        if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked && typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }
        // Trigger a redraw event for listeners that need to refresh overlays after parcels load
        try { window.dispatchEvent(new CustomEvent('parcelBlocksShouldRedraw')); } catch (_) { }

        // Re-apply blue highlighting for selected block parcels (now that more parcels may be present)
        try {
            if (typeof rehighlightSelectedBlockParcels === 'function') {
                rehighlightSelectedBlockParcels();
            }
        } catch (_) { }

        // Notify other modules that parcel data (and parcelLayer) are ready
        setParcelMergeInProgressState(false);
        const newParcelIds = newConvertedFeatures.map(f => String(f.properties.CESTICA_ID));
        window.dispatchEvent(new CustomEvent('parcelDataLoaded', {
            detail: {
                features: Array.isArray(convertedData.features) ? convertedData.features.slice() : [],
                parcelIds: Array.isArray(convertedData.features)
                    ? convertedData.features.map(feature => String(feature.properties.CESTICA_ID))
                    : [],
                newFeatures: newConvertedFeatures,
                newParcelIds: newParcelIds
            }
        }));
        refreshParcelNumberLabelsIfVisible();
        // Note: Visual controllers (proposal mode, single-selection, blocks, etc.) should listen to this event and
        //       update their own layers instead of fetchParcelData trying to do it here.
    } catch (error) {
        console.error('Error fetching data:', error);
        updateStatus('Error fetching data. Please try again.');
    } finally {
        isFetchingParcels = false;
        setParcelMergeInProgressState(false);
    }
}

const DIRECT_PARCEL_FETCH_BATCH_SIZE = 8;
const DIRECT_PARCEL_BACKEND_CHUNK_SIZE = 4;
const OSS_PARCEL_WFS_BASE_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';

function normalizeParcelIdValue(value) {
    if (value === undefined || value === null) {
        return '';
    }
    try {
        return value.toString().trim();
    } catch (_) {
        return '';
    }
}

function resolveParcelLayerById(parcelId) {
    const normalizedId = normalizeParcelIdValue(parcelId);
    if (!normalizedId) {
        return null;
    }
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
        const viaManager = multiParcelSelection.findParcelById(normalizedId);
        if (viaManager) {
            return viaManager;
        }
    }
    if (!parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
        return null;
    }
    let resolved = null;
    parcelLayer.eachLayer(layer => {
        if (resolved) {
            return;
        }
        const candidate = layer?.feature?.properties?.CESTICA_ID;
        if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
            resolved = layer;
        }
    });
    return resolved;
}

function removeParcelLayerById(parcelId) {
    const normalizedId = normalizeParcelIdValue(parcelId);
    if (!normalizedId || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
        return;
    }
    const layersToRemove = [];
    parcelLayer.eachLayer(layer => {
        const candidate = layer?.feature?.properties?.CESTICA_ID;
        if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
            layersToRemove.push(layer);
        }
    });
    layersToRemove.forEach(layer => {
        if (typeof unindexParcelLayer === 'function') {
            unindexParcelLayer(layer);
        }
        parcelLayer.removeLayer(layer);
        try {
            if (typeof map !== 'undefined' && map && map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        } catch (_) { }
    });
}

function ensureParcelLayerInitialized() {
    if (!parcelLayer) {
        parcelLayer = L.featureGroup();
        if (typeof map !== 'undefined' && map) {
            parcelLayer.addTo(map);
        }
        window.parcelLayer = parcelLayer;
    }
}

async function fetchSingleParcelById(parcelId, options = {}) {
    const normalizedId = normalizeParcelIdValue(parcelId);
    if (!normalizedId) {
        return null;
    }

    const forceRefresh = options.forceRefresh === true;
    const existing = resolveParcelLayerById(normalizedId);
    if (existing && !forceRefresh) {
        return existing;
    }
    if (forceRefresh && existing) {
        removeParcelLayerById(normalizedId);
    }

    setParcelMergeInProgressState(true);
    try {
        const rawFeatures = await fetchParcelFeaturesByIds([normalizedId]);
        if (!rawFeatures.length) {
            throw new Error(`Parcel ${normalizedId} could not be fetched from the upstream data source.`);
        }
        await ingestParcelFeatures(rawFeatures, { replaceExisting: true });
        return resolveParcelLayerById(normalizedId);
    } finally {
        setParcelMergeInProgressState(false);
    }
}

async function fetchParcelsByIds(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return [];
    }
    const normalizedIds = parcelIds
        .map(value => normalizeParcelIdValue(value))
        .filter(Boolean);
    if (!normalizedIds.length) {
        return [];
    }

    const forceRefresh = options.forceRefresh === true;
    const missing = [];
    normalizedIds.forEach(id => {
        const existing = resolveParcelLayerById(id);
        if (!existing || forceRefresh) {
            if (forceRefresh && existing) {
                removeParcelLayerById(id);
            }
            if (!missing.includes(id)) {
                missing.push(id);
            }
        }
    });

    if (missing.length) {
        setParcelMergeInProgressState(true);
        try {
            const rawFeatures = await fetchParcelFeaturesByIds(missing);
            if (rawFeatures.length) {
                await ingestParcelFeatures(rawFeatures, { replaceExisting: true });
            }
        } finally {
            setParcelMergeInProgressState(false);
        }
    }

    return normalizedIds.map(id => resolveParcelLayerById(id)).filter(Boolean);
}

async function fetchParcelFeaturesByIds(parcelIds) {
    const normalizedIds = Array.from(new Set(
        (Array.isArray(parcelIds) ? parcelIds : [])
            .map(value => normalizeParcelIdValue(value))
            .filter(Boolean)
    ));
    if (!normalizedIds.length) {
        return [];
    }

    const batches = [];
    for (let i = 0; i < normalizedIds.length; i += DIRECT_PARCEL_FETCH_BATCH_SIZE) {
        batches.push(normalizedIds.slice(i, i + DIRECT_PARCEL_FETCH_BATCH_SIZE));
    }

    const collected = [];
    for (const batch of batches) {
        const features = await requestParcelBatchForCurrentCity(batch);
        collected.push(...features);
    }

    const deduped = [];
    const seen = new Set();
    collected.forEach(feature => {
        const id = feature?.properties?.CESTICA_ID;
        if (id === undefined || id === null) {
            return;
        }
        const key = id.toString();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        deduped.push(feature);
    });
    return deduped;
}

async function requestParcelBatchForCurrentCity(ids) {
    if (getCurrentCityId() === 'buenos_aires') {
        return requestParcelBatchFromParcelBa(ids);
    }
    return requestParcelBatchFromOss(ids);
}

async function requestParcelBatchFromOss(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return [];
    }
    const filterXml = buildParcelFilterXml(ids);
    const params = new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        outputFormat: 'json',
        typeName: 'oss:DKP_CESTICE',
        srsName: 'EPSG:3765'
    });
    if (OSS_PUBLIC_ACCESS_TOKEN) {
        params.set('token', OSS_PUBLIC_ACCESS_TOKEN);
    }
    if (filterXml) {
        params.set('FILTER', filterXml);
    }
    const url = `${OSS_PARCEL_WFS_BASE_URL}?${params.toString()}`;
    const response = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 2, 800);
    const payload = await response.json();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    return features;
}

async function requestParcelBatchFromParcelBa(ids) {
    const normalizedIds = Array.isArray(ids) ? ids.map(value => normalizeParcelIdValue(value)).filter(Boolean) : [];
    if (!normalizedIds.length) {
        return [];
    }

    const backendBase = (function () {
        try {
            if (typeof getBackendBase === 'function') {
                const base = getBackendBase();
                if (base && typeof base === 'string') {
                    return base.replace(/\/$/, '');
                }
            }
        } catch (_) { }
        return 'http://localhost:3000';
    })();

    const aggregated = [];
    for (let start = 0; start < normalizedIds.length; start += DIRECT_PARCEL_BACKEND_CHUNK_SIZE) {
        const chunk = normalizedIds.slice(start, start + DIRECT_PARCEL_BACKEND_CHUNK_SIZE);
        await Promise.all(chunk.map(async (smp) => {
            const search = new URLSearchParams({ smp });
            const url = `${backendBase}/parcel-ba?${search.toString()}`;
            try {
                const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (response.status === 404) {
                    return;
                }
                if (!response.ok) {
                    console.warn(`parcel-ba request failed for ${smp}: ${response.status}`);
                    return;
                }
                const payload = await response.json();
                if (Array.isArray(payload?.features)) {
                    aggregated.push(...payload.features);
                }
            } catch (error) {
                console.warn(`parcel-ba request error for ${smp}`, error);
            }
        }));
    }

    return aggregated;
}

function buildParcelFilterXml(ids) {
    const clauses = (Array.isArray(ids) ? ids : [])
        .map(value => normalizeParcelIdValue(value))
        .filter(Boolean)
        .map(id => `<PropertyIsEqualTo><PropertyName>CESTICA_ID</PropertyName><Literal>${escapeXmlValue(id)}</Literal></PropertyIsEqualTo>`);
    if (!clauses.length) {
        return '';
    }
    if (clauses.length === 1) {
        return `<Filter>${clauses[0]}</Filter>`;
    }
    return `<Filter><Or>${clauses.join('')}</Or></Filter>`;
}

function escapeXmlValue(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function ingestParcelFeatures(rawFeatures, options = {}) {
    if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) {
        return [];
    }
    const converted = convertGeoJSON({
        type: 'FeatureCollection',
        features: rawFeatures
    });
    const convertedFeatures = Array.isArray(converted?.features) ? converted.features : [];
    if (!convertedFeatures.length) {
        return [];
    }

    ensureParcelLayerInitialized();

    const addedLayers = [];
    const styleFeature = (feature) => {
        const parcelId = feature?.properties?.CESTICA_ID;
        const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
        return getParcelBaseStyle(parcelId, { isRoad });
    };
    const attachParcelEvents = (feature, layer) => {
        layer.on({
            mouseover: typeof highlightFeature === 'function' ? highlightFeature : () => { },
            mouseout: typeof resetHighlight === 'function' ? resetHighlight : () => { },
            click: onParcelClick
        });
    };

    const shouldReplace = options.replaceExisting !== false;

    convertedFeatures.forEach(feature => {
        const parcelId = feature?.properties?.CESTICA_ID;
        if (parcelId === undefined || parcelId === null) {
            return;
        }
        const normalizedId = parcelId.toString();
        if (shouldReplace) {
            removeParcelLayerById(normalizedId);
        }
        L.geoJSON({
            type: 'FeatureCollection',
            features: [feature]
        }, {
            style: styleFeature,
            onEachFeature: attachParcelEvents
        }).eachLayer(layer => {
            parcelLayer.addLayer(layer);
            indexParcelLayer(layer);
            const storedRoad = PersistentStorage.getItem(`parcel_${normalizedId}_isRoad`) === 'true';
            if (storedRoad) {
                const roadName = PersistentStorage.getItem(`parcel_${normalizedId}_roadName`) || 'Unnamed Road';
                layer.bindTooltip(roadName, {
                    permanent: false,
                    direction: 'center',
                    className: 'road-name-tooltip'
                });
                layer.feature.properties.isRoad = true;
                layer.feature.properties.roadName = roadName;
                layer.feature.properties.roadId = PersistentStorage.getItem(`parcel_${normalizedId}_roadId`) || '';
                layer.feature.properties.roadConfidence =
                    PersistentStorage.getItem(`parcel_${normalizedId}_roadConfidence`) || '0';
            }
            addedLayers.push(layer);
        });
    });

    if (addedLayers.length) {
        parcelCoverageVersion += 1;
        try { window.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { }
        try {
            window.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                detail: {
                    version: parcelCoverageVersion,
                    source: 'id-fetch',
                    timestamp: Date.now()
                }
            }));
        } catch (_) { }
        try {
            const parcelIds = convertedFeatures.map(feature => String(feature.properties.CESTICA_ID));
            window.dispatchEvent(new CustomEvent('parcelDataLoaded', {
                detail: {
                    features: convertedFeatures,
                    parcelIds,
                    newFeatures: convertedFeatures,
                    newParcelIds: parcelIds
                }
            }));
        } catch (_) { }
        refreshParcelStylesForAppliedProposals();
        updateVisibleParcelsCount();
        refreshParcelNumberLabelsIfVisible();
    }

    return addedLayers;
}

async function refreshParcelDataWithBusyState(customBounds) {
    const button = document.getElementById('refreshParcelDataButton');
    const task = () => fetchParcelData(customBounds);
    if (button && typeof runWithButtonBusyState === 'function') {
        return runWithButtonBusyState(button, 'Refreshing...', task);
    }
    return task();
}

async function clearLocalParcelData() {
    updateStatus('Clearing local parcel data...');
    let count = 0;
    const keysToDelete = [];
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key === 'cadastre_blocks') {
            continue;
        }
        if (key.startsWith('parcel_') ||
            key.startsWith('road_') ||
            key.includes('_geometry') ||
            key.includes('_properties') ||
            key.includes('_isRoad') ||
            key.includes('_roadName') ||
            key.includes('_split_')) {
            keysToDelete.push(key);
            count++;
        }
    }
    keysToDelete.forEach(key => {
        PersistentStorage.removeItem(key);
    });

    PersistentStorage.removeItem('modified_parcels');

    // Final message shown after clearing
    const clearedMessage = `Cleared ${count} parcel-related items from local storage`;

    if (parcelLayer) {
        parcelLayer.clearLayers();
    }
    clearParcelLayerIndex();
    parcelCache.grid.clear();
    parcelCoverageVersion += 1;
    try { window.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { }
    try {
        window.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
            detail: {
                version: parcelCoverageVersion,
                source: 'clear',
                timestamp: Date.now()
            }
        }));
    } catch (_) { }
    clearParcelNumberLabels();
    currentParcel = null;
    selectedParcelId = null;
    hideParcelInfoPanel();
    if (typeof hideBlockInfo === 'function') hideBlockInfo();
    if (typeof hideRoadInfoPanel === 'function') hideRoadInfoPanel();

    // Set the final status message after fetchParcelData has run its course
    updateStatus(clearedMessage);
}

function handleParcelLayerChange(checkbox) {
    const showParcelsCheckbox = document.getElementById('showParcels');
    const showRoadParcelsCheckbox = document.getElementById('showRoadParcels');
    if (checkbox.id === 'showParcels' && checkbox.checked) {
        showRoadParcelsCheckbox.checked = false;
    } else if (checkbox.id === 'showRoadParcels' && checkbox.checked) {
        showParcelsCheckbox.checked = false;
    }
    if (showParcelsCheckbox.checked) {
        showAllParcels();
    } else if (showRoadParcelsCheckbox.checked) {
        showOnlyRoadParcels();
    } else {
        hideAllParcels();
    }
}

// Parcel locating functionality
// Assumes parcelLayer and selectParcel are globally available
document.addEventListener('DOMContentLoaded', function () {
    const locateInput = document.getElementById('locateParcelInput');
    const locateButton = document.getElementById('locateParcelButton');
    const locateError = document.getElementById('locateParcelError');

    if (!locateInput || !locateButton || !locateError) {
        // UI elements not present
        return;
    }

    function locateParcel() {
        const value = locateInput.value.trim();
        locateError.textContent = '';
        if (!value) return;

        // Ensure the 'Show parcel numbers' checkbox is checked
        const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');
        if (showParcelNumbersCheckbox && !showParcelNumbersCheckbox.checked) {
            showParcelNumbersCheckbox.checked = true;
            if (typeof toggleParcelNumbers === 'function') {
                toggleParcelNumbers();
            }
        }

        if (typeof parcelLayer === 'undefined' || !parcelLayer) {
            locateError.textContent = 'Parcel data not loaded';
            return;
        }

        // Find the layer with the matching parcel number (city-aware)
        const cityId = getCurrentCityId();
        const parcelNumberProperty = cityId === 'buenos_aires' ? 'smp' : 'BROJ_CESTICE';

        const foundLayer = parcelLayer.getLayers().find(layer =>
            layer.feature &&
            layer.feature.properties &&
            layer.feature.properties[parcelNumberProperty] &&
            layer.feature.properties[parcelNumberProperty].toString() === value
        );

        if (foundLayer) {
            if (typeof selectParcel === 'function') {
                selectParcel(foundLayer.feature.properties.CESTICA_ID);
            }
            locateError.textContent = '';
        } else {
            locateError.textContent = 'Parcel not found';
        }
    }

    locateButton.addEventListener('click', locateParcel);
    locateInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            locateParcel();
        }
    });
});

// Add road checkbox event listener
document.getElementById('roadCheckbox').addEventListener('change', function (e) {
    if (currentParcel) {
        const wasRoad = currentParcel.isRoad;
        currentParcel.isRoad = e.target.checked;

        // Check if this parcel is part of multi-selection
        const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
            multiParcelSelection.isActive &&
            multiParcelSelection.selectedParcels.has(currentParcel.id.toString());

        // Only update appearance if not part of multi-selection
        if (!isMultiSelected) {
            currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: e.target.checked }));
        }
        // If it's multi-selected, keep the multi-selection highlighting

        // Store the road status in PersistentStorage
        PersistentStorage.setItem(`parcel_${currentParcel.id}_isRoad`, e.target.checked);

        // Update TOTAL_SPENT based on the parcel's market price
        const area = currentParcel.layer.feature.properties.calculatedArea || 0;
        const parcelPrice = area * SQM_AVG_PRICE;

        if (e.target.checked && !wasRoad) {
            // Parcel was marked as road - add to total
            TOTAL_SPENT += parcelPrice;
        } else if (!e.target.checked && wasRoad) {
            // Parcel was unmarked as road - subtract from total
            TOTAL_SPENT -= parcelPrice;
        }

        // Update the display
        updateTotalSpentDisplay();

        try {
            window.dispatchEvent(new CustomEvent('parcelRoadStatusChanged', {
                detail: {
                    parcelId: currentParcel.id,
                    cesticaId: currentParcel.layer?.feature?.properties?.CESTICA_ID,
                    isRoad: e.target.checked
                }
            }));
        } catch (_) { }
    }
});

// --- Expose to window for HTML/other JS ---
window.fetchParcelData = fetchParcelData;
window.fetchSingleParcelById = fetchSingleParcelById;
window.fetchParcelsByIds = fetchParcelsByIds;
window.fetchOwnerDataForParcel = fetchOwnerDataForParcel;
window.refreshParcelDataWithBusyState = refreshParcelDataWithBusyState;
window.selectParcel = selectParcel;
window.resolveParcelLayerById = resolveParcelLayerById;
window.showAllParcels = showAllParcels;
window.showOnlyRoadParcels = showOnlyRoadParcels;
window.hideAllParcels = hideAllParcels;
window.toggleParcelNumbers = toggleParcelNumbers;
window.clearLocalParcelData = clearLocalParcelData;
window.handleParcelLayerChange = handleParcelLayerChange;
window.isRoad = isRoad;
window.onEachFeature = onEachFeature;
window.showParcelInfoPanel = showParcelInfoPanel;
window.createProposalFromSelectedParcels = createProposalFromSelectedParcels;
window.renderParcelProposalActions = renderParcelProposalActions;
window.hideParcelInfoPanel = hideParcelInfoPanel;
window.updateVisibleParcelsCount = updateVisibleParcelsCount;
window.clearParcelNumberLabels = clearParcelNumberLabels;
window.refreshParcelNumberLabelsIfVisible = refreshParcelNumberLabelsIfVisible;
window.setParcelNumberLabelFilter = setParcelNumberLabelFilter;
window.getRequiredGridCells = getRequiredGridCells;
window.parcelLayer = parcelLayer;
window.parcelsTimeout = parcelsTimeout;
window.roadStyle = roadStyle;
window.normalStyle = normalStyle;
window.recomputeParcelsWithAppliedSpatialProposals = recomputeParcelsWithAppliedSpatialProposals;
window.refreshParcelStylesForAppliedProposals = refreshParcelStylesForAppliedProposals;
window.parcelHasAppliedSpatialProposal = parcelHasAppliedSpatialProposal;
window.indexParcelLayer = indexParcelLayer;
window.unindexParcelLayer = unindexParcelLayer;
window.clearParcelLayerIndex = clearParcelLayerIndex;
window.getParcelLayersWithinBounds = getParcelLayersWithinBounds;

function refreshAllMapLayers() {
    // Update block info for parcels
    if (typeof blockStorage !== 'undefined' && typeof parcelLayer !== 'undefined' && parcelLayer && blockStorage.load) {
        blockStorage.load();
        blockStorage.blocks.forEach((block, blockName) => {
            block.parcels = [];
            parcelLayer.eachLayer(layer => {
                const parcelId = layer.feature.properties.CESTICA_ID;
                if (block.parcelIds.includes(parcelId)) {
                    layer.feature.properties.block = blockName;
                    layer.feature.properties.blockValid = block.valid;
                    block.parcels.push(layer);
                }
            });
        });
    }

    if (typeof refreshParcelStylesForAppliedProposals === 'function') {
        refreshParcelStylesForAppliedProposals();
    }

    const showParcelsElem = document.getElementById('showParcels');
    const showParcels = showParcelsElem ? showParcelsElem.checked : true;
    if (showParcels) {
        if (parcelLayer) {
            parcelLayer.addTo(map);
            parcelLayer.eachLayer(layer => {
                layer.addTo(map);
            });
        }
    } else {
        if (typeof hideAllParcels === 'function') {
            hideAllParcels();
        }
    }

    if (typeof updateVisibleParcelsCount === 'function') {
        updateVisibleParcelsCount();
    }
    if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked && typeof updateBlockLayer === 'function') {
        updateBlockLayer();
    }
    // Trigger a redraw event for listeners that need to refresh overlays after parcels load
    try { window.dispatchEvent(new CustomEvent('parcelBlocksShouldRedraw')); } catch (_) { }

    // Re-apply blue highlighting for selected block parcels (now that more parcels may be present)
    try {
        if (typeof rehighlightSelectedBlockParcels === 'function') {
            rehighlightSelectedBlockParcels();
        }
    } catch (_) { }

    if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
        refreshParcelNumberLabelsIfVisible();
    }
}

function setupMap() {
    // ... Map initialization ...

    // Define the click handler here, where it has access to map-related scope
    // if it needs it. This also makes it the definitive "original" handler.
    window.onParcelClick = function onParcelClick(e) {
        const parcelId = e.target.feature.properties.CESTICA_ID.toString();

        // Handle multi-parcel selection if active
        if (multiParcelSelection.isActive) {
            if (multiParcelSelection.toggleParcel(e.target)) {
                return; // Stop further processing if multi-selection handled it
            }
        }

        // Standard single-parcel selection logic
        if (selectedParcelId === parcelId) {
            // Deselect if clicking the same parcel again
            if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
            if (currentParcel) {
                // Check if this parcel is part of multi-selection before resetting style
                const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                    multiParcelSelection.isActive &&
                    multiParcelSelection.selectedParcels.has(currentParcel.id.toString());
                if (!isMultiSelected) {
                    // Preserve block highlight if part of selected block
                    const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                        ? selectedBlockName
                        : (typeof window !== 'undefined' ? window.selectedBlockName : null);
                    const layerBlockName = currentParcel.layer?.feature?.properties?.block;
                    if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                        currentParcel.layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                    } else {
                        currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: currentParcel.isRoad }));
                    }
                }
            }
            selectedParcelId = null;
            currentParcel = null;
        } else {
            // Select a new parcel
            if (currentParcel) {
                // Check if the previous parcel is part of multi-selection before resetting style
                const isPrevMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                    multiParcelSelection.isActive &&
                    multiParcelSelection.selectedParcels.has(currentParcel.id.toString());
                if (!isPrevMultiSelected) {
                    // Preserve block highlight if part of selected block
                    const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                        ? selectedBlockName
                        : (typeof window !== 'undefined' ? window.selectedBlockName : null);
                    const layerBlockName = currentParcel.layer?.feature?.properties?.block;
                    if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                        currentParcel.layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                    } else {
                        currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: currentParcel.isRoad }));
                    }
                }
            }
            selectParcel(e.target);
        }
    };

    // Store the definitive original handler
    if (typeof originalOnParcelClick === 'undefined' || originalOnParcelClick === null) {
        originalOnParcelClick = window.onParcelClick;
    }

    fetchParcelData();
    loadBuildings();
    // ... other setup calls ...
}