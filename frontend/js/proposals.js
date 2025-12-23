/*
    Proposals functionality for the cadastre application.
    This file contains the functionality for creating and managing proposals
    including persistence helpers, map highlighting, UI interactions, and
    dependency management between proposals.
*/

const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';
const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';

function isLocalProposalId(value) {
    if (value === undefined || value === null) return false;
    const str = String(value);
    return str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop');
}

function isProposalMinted(proposal) {
    if (!proposal) return false;
    const flaggedMinted = proposal.isMinted === true;
    const hasOnchainTx = !!(proposal.onchain && proposal.onchain.transactionHash);
    const hasNft = !!getProposalNftInfo(proposal);
    const hasNumericNonLocalId = proposal.proposalId
        && !isLocalProposalId(proposal.proposalId)
        && /^[0-9]+$/.test(String(proposal.proposalId));
    return flaggedMinted || hasOnchainTx || hasNumericNonLocalId || hasNft;
}

function isInCity(parcelId, cityId) {
    if (!parcelId) return false;
    const id = parcelId.toString().trim();
    if (!id) return false;
    const upper = id.toUpperCase();
    const city = (cityId || '').toString().toLowerCase();

    if (city === 'zagreb') {
        return upper.startsWith('HR-');
    }
    if (city === 'belgrade') {
        return upper.startsWith('SR-');
    }
    if (city === 'buenos_aires') {
        const baPattern = /^\d{3}-\d{3}-[0-9A-Z]+$/;
        return upper.startsWith('AR-') || baPattern.test(upper);
    }

    // Unknown city: do not filter
    return true;
}

function getProposalNftInfo(proposal) {
    if (!proposal) return null;
    const nft = proposal.nft || {};
    const onchain = proposal.onchain || {};

    const chain = (nft.chain ?? onchain.chainId ?? proposal.chainId) || null;
    const contract = (nft.contract ?? onchain.contractAddress ?? proposal.contractAddress) || null;
    const tokenId = (nft.tokenId ?? onchain.proposalId ?? proposal.proposalId) || null;

    if (!contract || tokenId === undefined || tokenId === null) return null;

    return {
        chain: chain ? chain.toString() : null,
        contract: contract.toString(),
        tokenId: tokenId.toString()
    };
}
function handleUrbanRuleMainTypeClick() {
    setProposalMainType('Urban Rule');
    setProposalType('Urban Rule');
    updateProposalDescription('Urban Rule', true);
    resetUrbanRuleTypologySelection();
    // Contiguity check is already done when modal opens, but re-apply when switching to Urban Rule
    applyContiguityConstraints();
}

// Check contiguity and disable buttons that require contiguous parcels
// This applies to: Urban Rule's Block/Row buttons and Purchase's Park/Square/Lake buttons
function applyContiguityConstraints() {
    const selection = getCurrentParcelSelectionContext();
    const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
    const isContiguous = contiguity.contiguous;

    const disabledMessage = (typeof t === 'function')
        ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
        : 'Disabled because the parcels in the proposal are not contiguous';

    // Urban Rule typology buttons (Block and Row)
    const blockButton = document.querySelector('.proposal-typology-button[data-proposal-typology="block"]');
    const rowButton = document.querySelector('.proposal-typology-button[data-proposal-typology="row"]');

    // Purchase goal buttons (Park, Square, Lake)
    const parkButton = document.querySelector('.proposal-type-button[data-proposal-tool="park"]');
    const squareButton = document.querySelector('.proposal-type-button[data-proposal-tool="square"]');
    const lakeButton = document.querySelector('.proposal-type-button[data-proposal-tool="lake"]');

    const buttonsRequiringContiguity = [blockButton, rowButton, parkButton, squareButton, lakeButton];

    buttonsRequiringContiguity.forEach(btn => {
        if (!btn) return;
        if (!isContiguous) {
            btn.setAttribute('disabled', 'disabled');
            btn.setAttribute('data-contiguity-disabled', 'true');
            btn.title = disabledMessage;
        } else {
            // Only re-enable if it was disabled due to contiguity (not for other reasons)
            if (btn.getAttribute('data-contiguity-disabled') === 'true') {
                btn.removeAttribute('disabled');
                btn.removeAttribute('data-contiguity-disabled');
                btn.title = '';
            }
        }
    });
}

function resetUrbanRuleTypologySelection() {
    const buttons = document.querySelectorAll('.proposal-typology-button');
    buttons.forEach(btn => btn.classList.remove('selected'));
}

function handleUrbanRuleTypologyClick(typologyKey = 'block', options = {}) {
    const { skipLaunch = false } = options;
    setProposalMainType('Urban Rule');

    const buttons = document.querySelectorAll('.proposal-typology-button');
    let targetButton = null;
    buttons.forEach(btn => {
        const btnTypology = btn.getAttribute('data-proposal-typology');
        const isTarget = btnTypology === typologyKey;
        if (isTarget) {
            targetButton = btn;
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    if (!targetButton) return;
    // Allow 'block', 'row', and 'parcelBased' typologies
    const supportedTypologies = ['block', 'row', 'parcelBased'];
    if (targetButton.disabled || !supportedTypologies.includes(typologyKey)) {
        targetButton.classList.remove('selected');
        return;
    }

    if (!skipLaunch) {
        setProposalType('Residences');
    }

    if (skipLaunch) {
        return;
    }

    if (typologyKey === 'row') {
        // Row typology uses the row house flow
        currentProposalTool = 'row';
        launchRowHouseToolForSelection();
    } else if (typologyKey === 'parcelBased') {
        // Parcel-based typology generates individual buildings per parcel
        currentProposalTool = 'parcelBased';
        launchParcelBasedToolForSelection();
    } else {
        // Block typology uses the buildings/urban rule flow
        currentProposalTool = 'buildings';
        launchUrbanRuleToolForSelection();
    }
}

function normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    const str = value.toString().trim();
    return str.length > 0 ? str : null;
}

function getParcelIdFromProperties(props) {
    if (!props || typeof props !== 'object') return null;
    try {
        if (typeof ensureParcelId === 'function') {
            const ensured = ensureParcelId({ properties: props });
            const normalized = normalizeParcelId(ensured);
            if (normalized) return normalized;
        }
    } catch (_) { /* ignore */ }
    const candidates = [props.parcelId, props.parcel_id, props.id];
    for (const candidate of candidates) {
        const normalized = normalizeParcelId(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function getParcelIdFromFeature(feature) {
    if (!feature || typeof feature !== 'object') return null;
    if (typeof ensureParcelId === 'function') {
        try {
            const ensured = ensureParcelId(feature);
            const normalized = normalizeParcelId(ensured);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return getParcelIdFromProperties(feature.properties);
}

function ensureParcelIdOnFeature(feature, preferredId = null) {
    if (!feature || typeof feature !== 'object') return null;
    const props = feature.properties || (feature.properties = {});
    const resolved = normalizeParcelId(preferredId) || getParcelIdFromProperties(props);
    if (!resolved) return null;
    props.parcelId = resolved;
    return resolved;
}

function parseOwnerShareFraction(shareText = '') {
    const raw = (shareText || '').trim();
    if (!raw) return 1;
    if (raw.endsWith('%')) {
        const pct = parseFloat(raw.slice(0, -1));
        if (Number.isFinite(pct)) return Math.max(0, pct) / 100;
    }
    if (raw.includes('/')) {
        const [a, b] = raw.split('/').map(v => parseFloat(v.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
            return Math.max(0, a / b);
        }
    }
    const num = parseFloat(raw);
    if (Number.isFinite(num)) {
        // Treat 0-1 as fraction, >1 as already a ratio of 1 (e.g., "100" means 100x, clamp to 1)
        if (num > 1) {
            return num > 100 ? 1 : num / 100;
        }
        return Math.max(0, num);
    }
    return 1;
}

function normalizeParcelIdList(list) {
    if (!Array.isArray(list)) return [];
    const unique = new Set();
    list.forEach(value => {
        const normalized = normalizeParcelId(value);
        if (normalized) {
            unique.add(normalized);
        }
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function normalizeFeature(feature) {
    if (!feature || typeof feature !== 'object') return feature;
    ensureParcelIdOnFeature(feature);
    return feature;
}

function normalizeOwnerAcceptances(ownerAcceptances = {}) {
    const normalized = {};
    if (!ownerAcceptances || typeof ownerAcceptances !== 'object') {
        return normalized;
    }
    Object.entries(ownerAcceptances).forEach(([parcelId, entry]) => {
        if (parcelId === undefined || parcelId === null) {
            return;
        }
        const normalizedParcelId = parcelId.toString();
        const owners = entry && typeof entry.owners === 'object' ? entry.owners : {};
        const ownerOrder = Array.isArray(entry && entry.ownerOrder)
            ? entry.ownerOrder.filter(key => typeof key === 'string' && key.length > 0)
            : Object.keys(owners);
        const acceptedOwnerKeys = Array.isArray(entry && entry.acceptedOwnerKeys)
            ? Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)))
            : [];
        const acceptedBy = entry && typeof entry.acceptedBy === 'object' ? entry.acceptedBy : {};

        // Ensure ownerOrder also contains any accepted keys
        acceptedOwnerKeys.forEach(key => {
            if (!ownerOrder.includes(key)) {
                ownerOrder.push(key);
            }
        });

        normalized[normalizedParcelId] = {
            owners,
            ownerOrder,
            acceptedOwnerKeys,
            acceptedBy
        };
    });
    return normalized;
}

function normalizeLensEntries(entries) {
    const sanitized = [];
    if (!Array.isArray(entries)) return sanitized;
    const seen = new Set();
    entries.forEach(item => {
        const address = typeof item === 'string'
            ? item
            : (item && (item.address || item.addr || item.value || item.wallet));
        const name = item && typeof item === 'object'
            ? (item.name || item.label || item.title || '')
            : '';
        const normalizedAddress = address ? String(address).trim() : '';
        const normalizedName = name ? String(name).trim() : '';
        const key = normalizedAddress.toLowerCase();
        if (!normalizedAddress && !normalizedName) {
            return;
        }
        if (normalizedAddress) {
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
        }
        sanitized.push({ address: normalizedAddress, name: normalizedName });
    });
    return sanitized;
}

function getProposalLensEntries(proposal, options = {}) {
    const preferFallback = options.fallbackToGlobal === true;
    if (!proposal || typeof proposal !== 'object') return [];
    const candidates = [
        proposal.lens,
        proposal.lensEntries,
        proposal.lensAddresses,
        proposal.trustedLens
    ];
    for (const candidate of candidates) {
        const normalized = normalizeLensEntries(candidate);
        if (normalized.length) return normalized;
    }
    if (preferFallback && typeof getLensEntries === 'function') {
        return normalizeLensEntries(getLensEntries());
    }
    return [];
}

async function fetchLensFromChain(proposal) {
    try {
        if (!proposal || !proposal.onchain || !proposal.onchain.proposalId) return [];
        const chainId = proposal.onchain.chainId || (typeof normalizeChainId === 'function' ? normalizeChainId(window?.DEFAULT_CHAIN_ID) : null);
        let contractAddress = proposal.onchain.contractAddress || null;
        if (!contractAddress && typeof window !== 'undefined' && window.ChainDataLoader && typeof window.ChainDataLoader.resolveContractAddress === 'function') {
            contractAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'ProposalNFT');
        }
        if (!contractAddress || !window.ethers) return [];
        const provider = await window.ChainDataLoader.getProviderForChain(chainId);
        const { Contract, getAddress } = window.ethers;
        const normalizedAddress = getAddress(contractAddress);
        const abi = [
            'function getLens(uint256 proposalId) public view returns (address[] memory)'
        ];
        const contract = new Contract(normalizedAddress, abi, provider);
        const lensResult = await contract.getLens(proposal.onchain.proposalId);
        return normalizeLensEntries(lensResult || []);
    } catch (err) {
        console.warn('fetchLensFromChain failed', err);
        return [];
    }
}

function applyLensPatternToButton(button, entries) {
    const normalized = normalizeLensEntries(entries || []).filter(e => e && e.address);
    if (!normalized.length || typeof getLensPatternDataUrl !== 'function') return;
    try {
        const url = getLensPatternDataUrl(normalized);
        if (url) {
            button.style.backgroundImage = `url("${url}")`;
            button.style.backgroundSize = 'cover';
            button.style.backgroundRepeat = 'no-repeat';
            button.style.backgroundPosition = 'center';
        }
    } catch (err) {
        console.warn('applyLensPatternToButton failed', err);
    }
}

function getOwnerSlotsForParcel(parcelId) {
    const tProposalUI = getProposalI18nHelper();
    if (typeof getParcelOwnerSlots === 'function') {
        try {
            const slots = getParcelOwnerSlots(parcelId);
            if (Array.isArray(slots) && slots.length > 0) {
                return slots;
            }
        } catch (error) {
            console.warn('getOwnerSlotsForParcel: failed to read slots from parcels module', error);
        }
    }
    const normalizedParcelId = parcelId ? parcelId.toString() : 'parcel';
    return [{
        key: `parcel:${normalizedParcelId}:owner`,
        displayName: tProposalUI('panel.parcel.owner.single', 'Single owner'),
        shareText: '1',
        shareDetail: '',
        type: 'unknown',
        agentId: null,
        placeholder: true
    }];
}

function setParcelInfoPanelTitle(titleText, options = {}) {
    const panel = document.getElementById('parcel-info-panel');
    if (!panel) return;
    const titleEl = panel.querySelector('h3');
    if (!titleEl) return;
    const { i18nKey = null, i18nParams = null } = options;
    if (i18nKey) {
        titleEl.setAttribute('data-i18n-key', i18nKey);
        if (i18nParams) {
            titleEl.setAttribute('data-i18n-params', JSON.stringify(i18nParams));
        } else {
            titleEl.removeAttribute('data-i18n-params');
        }
    } else {
        titleEl.removeAttribute('data-i18n-key');
        titleEl.removeAttribute('data-i18n-params');
    }
    titleEl.textContent = titleText;
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try { window.i18n.applyTranslations(titleEl); } catch (_) { /* ignore */ }
    }
}

function tParcelMulti(key, params = {}, fallback = '') {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    // simple template replacement for fallback
    return String(fallback || key || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params && k in params) ? params[k] : m);
}

function ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots = [], options = {}) {
    if (!proposal) {
        return null;
    }
    if (!proposal.ownerAcceptances || typeof proposal.ownerAcceptances !== 'object') {
        proposal.ownerAcceptances = {};
    }

    const normalizedParcelId = parcelId ? parcelId.toString() : null;
    if (!normalizedParcelId) {
        return null;
    }

    if (!proposal.ownerAcceptances[normalizedParcelId]) {
        proposal.ownerAcceptances[normalizedParcelId] = {
            owners: {},
            ownerOrder: [],
            acceptedOwnerKeys: [],
            acceptedBy: {}
        };
    }

    const entry = proposal.ownerAcceptances[normalizedParcelId];
    const ownerOrderSet = new Set(entry.ownerOrder || []);

    const ownerSlotsArray = Array.isArray(ownerSlots) ? ownerSlots : [];
    ownerSlotsArray.forEach(slot => {
        if (!slot || !slot.key) {
            return;
        }
        const normalizedOwner = {
            key: slot.key,
            displayName: slot.displayName || slot.name || `Owner ${ownerOrderSet.size + 1}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            type: slot.type || 'unknown',
            agentId: slot.agentId || null,
            placeholder: !!slot.placeholder
        };
        entry.owners[slot.key] = {
            ...(entry.owners[slot.key] || {}),
            ...normalizedOwner
        };
        if (!ownerOrderSet.has(slot.key)) {
            entry.ownerOrder.push(slot.key);
            ownerOrderSet.add(slot.key);
        }
    });

    const hasNonPlaceholderSlots = ownerSlotsArray.some(slot => slot && !slot.placeholder);
    if (hasNonPlaceholderSlots) {
        const placeholderKeys = Object.keys(entry.owners || {}).filter(key => {
            const owner = entry.owners[key];
            if (!owner) return false;
            if (owner.placeholder) return true;
            const display = (owner.displayName || '').toLowerCase();
            const share = (owner.shareText || '').trim();
            const looksLegacyPlaceholder = owner.type === 'unknown'
                && !owner.agentId
                && (!display || display.includes('parcel owner') || display.includes('unknown owner'))
                && (!share || share === '100%' || share === '1');
            return looksLegacyPlaceholder;
        });
        if (placeholderKeys.length > 0) {
            placeholderKeys.forEach(key => {
                delete entry.owners[key];
                if (entry.acceptedBy && entry.acceptedBy[key]) {
                    delete entry.acceptedBy[key];
                }
            });
            entry.ownerOrder = (entry.ownerOrder || []).filter(key => !placeholderKeys.includes(key));
            entry.acceptedOwnerKeys = (entry.acceptedOwnerKeys || []).filter(key => !placeholderKeys.includes(key));
            placeholderKeys.forEach(key => ownerOrderSet.delete(key));
        }
    }

    if (!Array.isArray(entry.acceptedOwnerKeys)) {
        entry.acceptedOwnerKeys = [];
    }
    entry.acceptedOwnerKeys = Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)));
    entry.acceptedOwnerKeys.forEach(key => {
        if (!ownerOrderSet.has(key)) {
            entry.ownerOrder.push(key);
            ownerOrderSet.add(key);
        }
    });

    if (!entry.acceptedBy || typeof entry.acceptedBy !== 'object') {
        entry.acceptedBy = {};
    }

    const shouldSync = options.syncWithParcelAcceptance !== false;
    const parcelAccepted = shouldSync
        ? Array.isArray(proposal.acceptedParcelIds) && proposal.acceptedParcelIds.includes(normalizedParcelId)
        : false;

    if (parcelAccepted && entry.acceptedOwnerKeys.length === 0 && entry.ownerOrder.length > 0) {
        entry.ownerOrder.forEach(key => {
            if (!entry.acceptedOwnerKeys.includes(key)) {
                entry.acceptedOwnerKeys.push(key);
                if (!entry.acceptedBy[key]) {
                    entry.acceptedBy[key] = {
                        agentId: null,
                        username: null,
                        acceptedAt: proposal.executedAt || proposal.updatedAt || new Date().toISOString()
                    };
                }
            }
        });
    }

    proposal.ownerAcceptances[normalizedParcelId] = entry;
    return entry;
}

function getProposalOwnerAcceptanceState(proposal, parcelId, options = {}) {
    if (!proposal) {
        return { entries: [] };
    }

    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots);
    if (!entry) {
        return { entries: [] };
    }

    const acceptedKeys = new Set(entry.acceptedOwnerKeys || []);
    const currentUser = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    const entries = (entry.ownerOrder || []).map(ownerKey => {
        const slot = entry.owners[ownerKey] || ownerSlots.find(s => s.key === ownerKey) || { key: ownerKey };
        const acceptanceMeta = entry.acceptedBy[ownerKey] || {};
        const isAccepted = acceptedKeys.has(ownerKey);
        const slotType = slot.type || 'unknown';
        const slotAgentId = slot.agentId || null;
        let canAccept = !isAccepted && !!currentUser;
        if (slotType === 'agent' && slotAgentId && (!currentUser || slotAgentId !== currentUser.id)) {
            canAccept = false;
        }
        if (!currentUser && slotType !== 'oss') {
            canAccept = false;
        }
        let canUndo = false;
        if (isAccepted && currentUser && acceptanceMeta.agentId === currentUser.id) {
            canUndo = true;
            // If proposal is executed, only allow undo if there are no descendants
            const proposalStatus = (proposal.status || '').toLowerCase();
            if (proposalStatus === 'executed') {
                if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
                    const descendants = ProposalManager._getProposalDescendants(proposal.proposalId);
                    if (descendants && descendants.length > 0) {
                        canUndo = false;
                    }
                }
            }
        }

        return {
            key: ownerKey,
            displayName: slot.displayName || `Owner ${ownerKey}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            accepted: isAccepted,
            acceptedAt: acceptanceMeta.acceptedAt || null,
            acceptedByName: acceptanceMeta.username || '',
            acceptedByAgentId: acceptanceMeta.agentId || null,
            slotType,
            agentId: slotAgentId,
            canAccept,
            canUndo
        };
    });

    return {
        entries,
        ownerEntry: entry
    };
}

function getProposalI18nHelper() {
    const api = (typeof window !== 'undefined') ? window.i18n : null;
    const format = (template, values = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const k = k1 || k2;
            return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : match;
        });
    };
    return (key, fallback, params = {}) => {
        if (api && typeof api.t === 'function') {
            const translated = api.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return format(fallback, params);
    };
}

function getConstrainedCorridorTranslator(baseHelper) {
    return (key, fallback, params = {}) => {
        if (typeof baseHelper === 'function') {
            return baseHelper(`proposals.constrainedCorridor.${key}`, fallback, params);
        }
        return fallback;
    };
}

function getCorridorI18nHelper() {
    const baseHelper = (typeof getProposalI18nHelper === 'function') ? getProposalI18nHelper() : null;
    return getConstrainedCorridorTranslator(baseHelper);
}

// --- Translation hydration (pulls from JSON source to avoid hardcoding strings) ---
const proposalListTranslationsHydrated = new Set();

// Cache parcel areas per proposal to avoid repeated lookups/hydration
const proposalAreaCache = new Map();

function flattenObject(node, prefix = '', out = {}) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
    Object.entries(node).forEach(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenObject(value, path, out);
        } else {
            out[path] = value;
        }
    });
    return out;
}

async function ensureProposalListTranslations(lang) {
    const api = (typeof window !== 'undefined') ? window.i18n : null;
    if (!api || typeof api.registerTranslations !== 'function') return false;
    const targetLang = lang || (typeof api.getLanguage === 'function' ? api.getLanguage() : 'en');
    if (proposalListTranslationsHydrated.has(targetLang)) return false;
    const cacheBust = (typeof window !== 'undefined' && typeof window.getCacheBustToken === 'function')
        ? window.getCacheBustToken()
        : ((typeof window !== 'undefined' && Array.isArray(window.APP_VERSIONS) && window.APP_VERSIONS.length > 0)
            ? window.APP_VERSIONS[0].version_number
            : Date.now());
    try {
        const response = await fetch(`i18n/${targetLang}.json?proposalListHydrate=${cacheBust}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Failed to load i18n/${targetLang}.json: ${response.status}`);
        const json = await response.json();
        const flat = flattenObject(json);
        // Only register the proposal list subtree to avoid clobbering other runtime translations
        const subset = {};
        const prefix = 'modal.roadWidth.proposalList.';
        Object.entries(flat).forEach(([k, v]) => {
            if (k.startsWith(prefix)) {
                subset[k] = v;
            }
        });
        if (Object.keys(subset).length > 0) {
            api.registerTranslations(targetLang, subset);
            proposalListTranslationsHydrated.add(targetLang);
            if (typeof api.applyTranslations === 'function') {
                api.applyTranslations();
            }
            return true;
        }
    } catch (err) {
        console.warn('[i18n] Failed to hydrate proposal list translations', err);
    }
    return false;
}
function showProposalAlertMessage(key, fallback, params = {}, alertOptions = {}) {
    const translate = getProposalI18nHelper();
    const message = translate(`alerts.messages.${key}`, fallback, params);
    if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
        window.showStyledAlert(message, alertOptions);
    } else {
        alert(message);
    }
    return message;
}

/**
 * Check if current user is a guest and needs to personalize their profile.
 * If guest, shows welcome modal and returns true; otherwise returns false.
 * Use this to gate functionality that requires a personalized profile.
 */
function requirePersonalizedUser() {
    const t = getProposalI18nHelper();
    if (typeof getCurrentUserAgent !== 'function') {
        return false; // Can't check, allow through
    }
    const agent = getCurrentUserAgent();
    if (!agent || !agent.isGuest) {
        return false; // Not a guest, allow through
    }
    // User is a guest - prompt them to personalize
    if (typeof showWelcomeModal === 'function') {
        showWelcomeModal();
    }
    if (typeof showEphemeralMessage === 'function') {
        const message = t(
            'ephemeral.messages.personalize_to_create_proposal',
            'Please personalize your profile to create proposals.'
        );
        showEphemeralMessage(message);
    }
    return true; // Blocked - user is guest
}

// PERFORMANCE: Write cache to batch localStorage operations
// When enabled, writes go to cache instead of storage, then flush at once
let _parcelRecordWriteCache = null; // Map<parcelId, record> when caching is enabled

function _startParcelWriteCache() {
    _parcelRecordWriteCache = new Map();
}

function _flushParcelWriteCache() {
    if (!_parcelRecordWriteCache) return;
    const cache = _parcelRecordWriteCache;
    _parcelRecordWriteCache = null;
    if (typeof PersistentStorage === 'undefined') return;
    cache.forEach((record, parcelId) => {
        const key = `parcel_${parcelId}`;
        try { PersistentStorage.setItem(key, JSON.stringify(record)); } catch (_) { }
    });
}

function _discardParcelWriteCache() {
    _parcelRecordWriteCache = null;
}

/**
 * Check if a parcel is a parent that was replaced by child parcels from an applied proposal.
 * Returns true if the parcel should be hidden (replaced by children), false if it should be visible.
 * This replaces the removedByProposal flag with logic based on parent/child relationships.
 */
function isParcelReplacedByChildren(parcelId) {
    if (!parcelId) return false;
    const idStr = String(parcelId);

    // Child parcels (those with ancestorProposal) should always be visible
    const record = readPersistedParcelRecord(idStr);
    if (record && record.properties && record.properties.ancestorProposal) {
        return false; // This is a child parcel, it should be visible
    }

    // Check if this parcel is a parent that was replaced by checking applied proposals
    if (typeof proposalStorage === 'undefined' || typeof ProposalManager === 'undefined') {
        return false;
    }

    try {
        const allProposals = proposalStorage.getAllProposals();
        const isAppliedLike = (p) => {
            const status = (p.status || '').toLowerCase();
            const roadStatus = (p.roadProposal && p.roadProposal.status) ? p.roadProposal.status.toLowerCase() : '';
            const structureStatus = (p.structureProposal && p.structureProposal.status) ? p.structureProposal.status.toLowerCase() : '';
            const buildingStatus = (p.buildingProposal && p.buildingProposal.status) ? p.buildingProposal.status.toLowerCase() : '';
            const reparcelStatus = (p.reparcellization && p.reparcellization.status) ? p.reparcellization.status.toLowerCase() : '';
            const decideLaterStatus = (p.decideLaterProposal && p.decideLaterProposal.status) ? p.decideLaterProposal.status.toLowerCase() : '';
            return status === 'executed' || status === 'applied'
                || roadStatus === 'applied' || roadStatus === 'executed'
                || structureStatus === 'applied' || structureStatus === 'executed'
                || buildingStatus === 'applied' || buildingStatus === 'executed'
                || reparcelStatus === 'applied' || reparcelStatus === 'executed'
                || decideLaterStatus === 'applied' || decideLaterStatus === 'executed';
        };

        // Check if any applied proposal lists this parcel as a parent.
        // IMPORTANT: Only treat a parent as "replaced" if the proposal actually creates
        // descendant parcels (childParcelIds / descendantParcelIds). Urban-rule/building/structure
        // overlays (e.g., row houses / parcel-based / blockify) should NOT hide their parent
        // parcels on reload.
        for (const proposal of allProposals) {
            if (!isAppliedLike(proposal)) continue;

            const parentIds = [];
            if (proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) {
                parentIds.push(...proposal.roadProposal.parentParcelIds);
            }
            if (proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) {
                parentIds.push(...proposal.decideLaterProposal.parentParcelIds);
            }
            if (proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) {
                parentIds.push(...proposal.buildingProposal.parentParcelIds);
            }
            if (proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) {
                parentIds.push(...proposal.structureProposal.parentParcelIds);
            }
            if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parentParcelIds)) {
                parentIds.push(...proposal.reparcellization.parentParcelIds);
            }
            if (Array.isArray(proposal.parentParcelIds)) {
                parentIds.push(...proposal.parentParcelIds);
            }

            // Check if this parcel is a parent of this applied proposal
            if (parentIds.some(pid => String(pid) === idStr)) {
                // Check if the proposal has descendant parcel IDs (meaning parent was replaced)
                // NOTE: buildingProposal.buildingFeature / structureProposal geometry are overlays
                // and should not imply parcel replacement.
                const goalKey = normalizeProposalGoalKey(proposal.goal) || '';
                const isBuildingOverlay = !!proposal.buildingProposal || ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey);
                const isStructureOverlay = !!proposal.structureProposal || ['park', 'square', 'lake'].includes(goalKey);

                const hasChildren = (proposal.roadProposal && Array.isArray(proposal.roadProposal.childParcelIds) && proposal.roadProposal.childParcelIds.length > 0)
                    || (proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.childParcelIds) && proposal.decideLaterProposal.childParcelIds.length > 0)
                    || (!isBuildingOverlay && !isStructureOverlay && Array.isArray(proposal.childParcelIds) && proposal.childParcelIds.length > 0)
                    || (!isBuildingOverlay && !isStructureOverlay && Array.isArray(proposal.descendantParcelIds) && proposal.descendantParcelIds.length > 0);

                if (hasChildren) {
                    return true; // This parcel is a parent that was replaced
                }
            }
        }
    } catch (_) {
        // On error, default to showing the parcel
        return false;
    }

    return false; // Not replaced, should be visible
}

function readPersistedParcelRecord(parcelId) {
    if (!parcelId) return null;
    const idStr = String(parcelId);

    // Check write cache first
    if (_parcelRecordWriteCache && _parcelRecordWriteCache.has(idStr)) {
        return _parcelRecordWriteCache.get(idStr);
    }

    if (typeof PersistentStorage === 'undefined') return null;
    const key = `parcel_${parcelId}`;
    try {
        const raw = PersistentStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!parsed.properties) parsed.properties = {};
        return parsed;
    } catch (_) { }
    return null;
}

function writePersistedParcelRecord(parcelId, updater) {
    if (!parcelId) return null;
    const idStr = String(parcelId);

    // Get existing record from cache or storage
    let record = null;
    if (_parcelRecordWriteCache && _parcelRecordWriteCache.has(idStr)) {
        record = _parcelRecordWriteCache.get(idStr);
    } else {
        record = readPersistedParcelRecord(parcelId) || { id: idStr, properties: {}, geometry: null };
    }

    if (typeof updater === 'function') {
        try { updater(record); } catch (_) { /* ignore */ }
    }

    // If caching is enabled, store in cache instead of writing immediately
    if (_parcelRecordWriteCache) {
        _parcelRecordWriteCache.set(idStr, record);
        return record;
    }

    // No cache - write immediately
    if (typeof PersistentStorage !== 'undefined') {
        const key = `parcel_${parcelId}`;
        try { PersistentStorage.setItem(key, JSON.stringify(record)); } catch (_) { }
    }
    return record;
}

function clearPersistedParcelRecord(parcelId) {
    if (!parcelId) return;
    const idStr = String(parcelId);

    // Remove from cache if present
    if (_parcelRecordWriteCache) {
        _parcelRecordWriteCache.delete(idStr);
    }

    if (typeof PersistentStorage === 'undefined') return;
    try { PersistentStorage.removeItem(`parcel_${parcelId}`); } catch (_) { }
}

if (typeof window !== 'undefined') {
    window.readPersistedParcelRecord = readPersistedParcelRecord;
    window.writePersistedParcelRecord = writePersistedParcelRecord;
    window.clearPersistedParcelRecord = clearPersistedParcelRecord;
    window._startParcelWriteCache = _startParcelWriteCache;
    window._flushParcelWriteCache = _flushParcelWriteCache;
    window._discardParcelWriteCache = _discardParcelWriteCache;
}

function getProposalAreaMap(proposal) {
    if (!proposal) return { areaMap: new Map(), totalArea: 0 };

    const cacheKey = getProposalKey(proposal) || proposal.proposalId || JSON.stringify(proposal.parentParcelIds || []);
    if (cacheKey && proposalAreaCache.has(cacheKey)) {
        return proposalAreaCache.get(cacheKey);
    }

    const areaMap = new Map();
    let totalArea = 0;
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];

    parcelIds.forEach(id => {
        const key = id?.toString ? id.toString() : String(id || '');
        if (!key) return;

        let area = 0;

        // Prefer cached proposal feature data (no map hydration)
        const cached = getCachedParcelFeature(key, proposal);
        const props = cached?.properties;
        if (props) {
            area = Number(props.calculatedArea || props.area || props.parcelArea || 0) || 0;
        }

        // Fallback to persisted properties
        if (!area) {
            try {
                const record = readPersistedParcelRecord(key);
                const storedProps = record?.properties || null;
                if (storedProps) {
                    area = Number(storedProps.calculatedArea || storedProps.area || storedProps.parcelArea || 0) || 0;
                }
            } catch (_) { }
        }

        // Final fallback: treat as unit area to avoid zero totals
        if (!area) {
            area = 1;
        }

        areaMap.set(key, area);
        totalArea += area;
    });

    const result = { areaMap, totalArea };
    if (cacheKey) {
        proposalAreaCache.set(cacheKey, result);
    }
    return result;
}

function buildOwnerAcceptanceSectionHtml(proposal, parcelId, options = {}) {
    const proposalId = proposal && proposal.proposalId ? proposal.proposalId : '';
    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId, options);
    const entries = acceptanceState.entries || [];
    if (!entries.length) {
        return '';
    }
    const compact = options.compact ? 'owner-acceptance-list compact' : 'owner-acceptance-list';
    const skipParcelPanelFocus = options && options.skipParcelPanelFocus === true;

    // Check if proposal is expired - disable buttons if so
    const proposalExpired = isProposalExpired(proposal);

    // Compute parcel and owner payout shares
    const offerAmount = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : 0;
    const offerCurrency = proposal.offerCurrency || proposal.currency || '';
    const { areaMap, totalArea } = options.areaContext || getProposalAreaMap(proposal);

    const parcelKey = parcelId?.toString ? parcelId.toString() : String(parcelId || '');
    const parcelArea = areaMap.get(parcelKey) || 0;
    const parcelAreaShare = totalArea > 0 ? parcelArea / totalArea : 0;
    const parcelPayout = offerAmount * parcelAreaShare;

    const formatPayout = (value) => {
        if (!Number.isFinite(value) || value <= 0) return '';
        const rounded = Math.round(value);
        const roundedText = rounded.toLocaleString(undefined, { maximumFractionDigits: 0 });
        return `${roundedText}${offerCurrency ? ' ' + offerCurrency : ''}`;
    };

    const rowsHtml = entries.map(entry => {
        const safeName = typeof escapeHtml === 'function' ? escapeHtml(entry.displayName || '') : (entry.displayName || getProposalI18nHelper()('panel.proposal.metrics.ownerFallback', 'Owner'));
        const safeShare = entry.shareText ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareText) : entry.shareText) : '';
        const shareTitle = entry.shareDetail ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareDetail) : entry.shareDetail) : '';
        const ownerFraction = parseOwnerShareFraction(entry.shareText);
        const ownerPayoutText = formatPayout(parcelPayout * ownerFraction);
        const payoutHtml = ownerPayoutText ? `<span class="owner-payout" style="color:#444; font-size:0.85em;">· ${ownerPayoutText}</span>` : '';
        const shareHtml = safeShare
            ? `<span class="owner-share" style="color:#666; font-size:0.85em;"${shareTitle ? ` title="${shareTitle}"` : ''}>${safeShare}</span>${payoutHtml}`
            : (payoutHtml || '');

        let buttonsHtml = '';
        const tProposalUI = getProposalI18nHelper();
        if (proposalExpired) {
            // Show disabled buttons for expired proposals
            if (entry.accepted) {
                buttonsHtml = `
                    <button class="btn btn-sm btn-outline-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${tProposalUI('panel.proposal.expiry.expired', 'Proposal Expired')}">
                        ${tProposalUI('panel.proposal.acceptance.undo', 'Undo')}
                    </button>`;
            }
            else {
                buttonsHtml = `
                    <button class="btn btn-sm btn-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${tProposalUI('panel.proposal.expiry.expired', 'Proposal Expired')}">
                        ${tProposalUI('panel.proposal.acceptance.accept', 'Accept')}
                    </button>`;
            }
        } else if (entry.accepted && entry.canUndo) {
            const rejectCall = skipParcelPanelFocus
                ? `rejectProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `rejectProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-outline-danger" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${rejectCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    Undo
                </button>`;
        } else if (!entry.accepted && entry.canAccept) {
            const acceptCall = skipParcelPanelFocus
                ? `acceptProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `acceptProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-success" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${acceptCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    ${tProposalUI('panel.proposal.acceptance.accept', 'Accept')}
                </button>`;
        }

        return `
            <div class="owner-acceptance-row" data-owner-key="${entry.key}" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="display:grid; grid-template-columns: 1fr auto auto; align-items:center; gap:8px; padding:4px 0;">
                <div class="owner-identity" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="font-size: 13px; font-weight:500;">
                    ${safeName}
                </div>
                <div class="owner-share" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="font-size: 13px; color:#666; text-align:right;">
                    ${shareHtml || '-'}
                </div>
                <div class="owner-actions" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="text-align:right;">
                    ${buttonsHtml}
                </div>
            </div>`;
    }).join('');

    return `<div class="${compact}" style="width: 100%; box-sizing: border-box;">${rowsHtml}</div>`;
}

function buildParcelAcceptanceStatusHtml(proposal) {
    const tProposalUI = getProposalI18nHelper();
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];
    const total = parcelIds.length;
    if (!total) {
        return '';
    }

    const acceptedCount = Math.min(
        Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0,
        total
    );

    const labelText = `${tProposalUI('panel.proposal.acceptance.parcelTitle', 'Parcel Acceptance Status:')} (${acceptedCount}/${total})`;

    // If more than 65 parcels, show progress bar instead of circles
    if (total > 65) {
        const percentage = total > 0 ? (acceptedCount / total) * 100 : 0;
        return `
            <div class="proposal-acceptance-status">
                <div class="acceptance-label">${labelText}</div>
                <div class="acceptance-progress-bar" style="
                    width: 100%;
                    height: 20px;
                    background-color: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                    position: relative;
                ">
                    <div class="acceptance-progress-fill" style="
                        width: ${percentage}%;
                        height: 100%;
                        background-color: #4caf50;
                        transition: width 0.3s ease;
                    "></div>
                </div>
            </div>`;
    }

    // For 65 or fewer parcels, show circles
    let circlesHtml = '';
    const acceptedTitle = tProposalUI('panel.proposal.acceptance.accepted', 'Accepted');
    const pendingTitle = tProposalUI('panel.proposal.acceptance.pending', 'Pending');
    for (let i = 0; i < acceptedCount; i++) {
        circlesHtml += `<div class="acceptance-circle accepted" title="${acceptedTitle}"></div>`;
    }
    for (let i = acceptedCount; i < total; i++) {
        circlesHtml += `<div class="acceptance-circle pending" title="${pendingTitle}"></div>`;
    }

    return `
        <div class="proposal-acceptance-status">
            <div class="acceptance-label">${labelText}</div>
            <div class="acceptance-circles">${circlesHtml}</div>
        </div>`;
}

function buildProposalOwnerAcceptanceSummaryFast(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.parentParcelIds)) {
        return summary;
    }

    const acceptances = proposal.ownerAcceptances || {};
    let includeEntries = true;

    proposal.parentParcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) return;

        const entry = acceptances[normalizedParcelId];
        if (!entry) return;

        const ownerOrder = Array.isArray(entry.ownerOrder)
            ? entry.ownerOrder
            : Object.keys(entry.owners || {});
        const acceptedKeysArray = Array.isArray(entry.acceptedOwnerKeys)
            ? entry.acceptedOwnerKeys
            : Object.keys(entry.acceptedBy || {});
        const acceptedSet = new Set(acceptedKeysArray.map(key => key && key.toString()).filter(Boolean));

        summary.totalOwners += ownerOrder.length;
        summary.acceptedOwners += acceptedSet.size;

        if (includeEntries) {
            ownerOrder.forEach(ownerKey => {
                if (!ownerKey) return;
                const ownerMeta = entry.owners && entry.owners[ownerKey] ? entry.owners[ownerKey] : {};
                summary.entries.push({
                    key: ownerKey,
                    displayName: ownerMeta.displayName || `Owner ${ownerKey}`,
                    shareText: ownerMeta.shareText || '',
                    parcelId: normalizedParcelId,
                    accepted: acceptedSet.has(ownerKey.toString())
                });
            });
            if (summary.totalOwners > 65) {
                summary.entries = [];
                includeEntries = false;
            }
        }
    });

    return summary;
}

function buildOwnerAcceptanceStatusHtml(proposal, summaryOverride) {
    const tProposalUI = getProposalI18nHelper();
    const ownerAcceptanceSummary = summaryOverride || buildProposalOwnerAcceptanceSummary(proposal);
    if (!ownerAcceptanceSummary.totalOwners) {
        return '';
    }
    try {
        const total = ownerAcceptanceSummary.totalOwners;
        const acceptedCount = ownerAcceptanceSummary.acceptedOwners || 0;
        const labelText = `${tProposalUI('panel.proposal.acceptance.ownerTitle', 'Owner Acceptance Status:')} (${acceptedCount}/${total})`;

        // If more than 65 owners, show progress bar instead of circles
        if (total > 65) {
            const percentage = total > 0 ? (acceptedCount / total) * 100 : 0;
            return `
                <div class="proposal-acceptance-status owner">
                    <div class="acceptance-label">${labelText}</div>
                    <div class="acceptance-progress-bar" style="
                        width: 100%;
                        height: 20px;
                        background-color: #e0e0e0;
                        border-radius: 4px;
                        overflow: hidden;
                        position: relative;
                    ">
                        <div class="acceptance-progress-fill" style="
                            width: ${percentage}%;
                            height: 100%;
                            background-color: #4caf50;
                            transition: width 0.3s ease;
                        "></div>
                    </div>
                </div>`;
        }

        // For 65 or fewer owners, show circles
        const circlesHtml = ownerAcceptanceSummary.entries.map(entry => {
            if (!entry) return '';
            const parts = [];
            if (entry.displayName) parts.push(entry.displayName);
            if (entry.shareText) parts.push(entry.shareText);
            if (entry.parcelId) parts.push(tProposalUI('panel.proposal.parcels.label', 'Parcel {{id}}', { id: entry.parcelId }));
            parts.push(entry.accepted ? tProposalUI('panel.proposal.acceptance.accepted', 'Accepted') : tProposalUI('panel.proposal.acceptance.pending', 'Pending'));
            const title = parts.join(' • ');
            const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(title) : title;
            return `<div class="acceptance-circle ${entry.accepted ? 'accepted' : 'pending'}" title="${safeTitle}"></div>`;
        }).join('');
        return `
            <div class="proposal-acceptance-status owner">
                <div class="acceptance-label">${labelText}</div>
                <div class="acceptance-circles">${circlesHtml}</div>
            </div>`;
    } catch (error) {
        console.warn('buildOwnerAcceptanceStatusHtml: failed to build summary', error);
        return '';
    }
}

function buildProposalOwnerAcceptanceSummary(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.parentParcelIds) || typeof getProposalOwnerAcceptanceState !== 'function') {
        return summary;
    }

    const entries = [];
    proposal.parentParcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) {
            return;
        }
        try {
            const parcelAcceptance = typeof getProposalOwnerAcceptanceState === 'function'
                ? getProposalOwnerAcceptanceState(proposal, normalizedParcelId)
                : { entries: [] };
            const parcelEntries = Array.isArray(parcelAcceptance.entries) ? parcelAcceptance.entries.slice() : [];
            const entriesForParcel = parcelEntries;

            entriesForParcel.forEach((entry, index) => {
                if (!entry) return;
                const entryKey = (entry.key || `${normalizedParcelId}_${index}`).toString();
                entries.push({
                    key: entryKey,
                    parcelId: normalizedParcelId,
                    displayName: entry.displayName || `Owner ${index + 1}`,
                    shareText: entry.shareText || '',
                    accepted: !!entry.accepted,
                    acceptedByName: entry.acceptedByName || '',
                    acceptanceMeta: entry
                });
            });
        } catch (error) {
            console.warn('buildProposalOwnerAcceptanceSummary: failed to gather owners', error);
        }
    });

    // Total owners = sum of per-parcel owner slots (no metadata shortcuts)
    summary.totalOwners = entries.length;
    summary.entries = entries;
    summary.acceptedOwners = Math.min(entries.filter(entry => entry.accepted).length, summary.totalOwners);
    return summary;
}

async function autoApplyExecutedProposalToMap(proposal) {
    if (!proposal || !proposal.proposalId) {
        return false;
    }
    if (typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        return false;
    }
    try {
        const applied = await ProposalManager.applyProposal(proposal.proposalId);
        if (applied && typeof window !== 'undefined' && window.currentlyHighlightedProposal &&
            (window.currentlyHighlightedProposal.proposalId === proposal.proposalId)) {
            let refreshed = proposal;
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const stored = proposalStorage.getProposal(proposal.proposalId);
                if (stored) {
                    refreshed = stored;
                }
            }
            window.currentlyHighlightedProposal = refreshed;
            if (typeof showProposalInfo === 'function') {
                try {
                    showProposalInfo(refreshed, window.selectedParcelInProposal);
                } catch (error) {
                    console.warn('autoApplyExecutedProposalToMap: failed to refresh proposal details', error);
                }
            }
            if (typeof applyProposalHighlights === 'function') {
                try { applyProposalHighlights(); } catch (error) { console.warn('autoApplyExecutedProposalToMap: failed to refresh highlights', error); }
            }
        }
        return applied;
    } catch (error) {
        console.warn('autoApplyExecutedProposalToMap: failed to apply executed proposal', { proposalId: proposal.proposalId, error });
        return false;
    }
}

function serialiseRoadCoordinates(coords = []) {
    return coords
        .map(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return '0,0';
            const [lng, lat] = pair;
            const safeLng = Number.isFinite(lng) ? lng.toFixed(6) : '0.000000';
            const safeLat = Number.isFinite(lat) ? lat.toFixed(6) : '0.000000';
            return `${safeLng},${safeLat}`;
        })
        .join(';');
}

function serialiseGeometry(geometry) {
    if (!geometry) return '';
    try {
        return JSON.stringify(geometry);
    } catch (_) {
        return '';
    }
}

// Deterministic, order-insensitive hash (cyrb53) to produce stable proposal ids across clients.
function hashStringDeterministic(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return combined.toString(36);
}

function serialiseRoadDefinition(definition) {
    if (!definition || typeof definition !== 'object') return '';

    const width = Number.isFinite(definition.width)
        ? definition.width.toFixed(2)
        : (definition.width !== undefined && definition.width !== null
            ? definition.width.toString()
            : '');

    const points = Array.isArray(definition.points)
        ? definition.points.map(point => {
            if (!point) return '0.000000,0.000000';
            const lat = Number.isFinite(point.lat) ? point.lat.toFixed(6) : '0.000000';
            const lng = Number.isFinite(point.lng) ? point.lng.toFixed(6) : '0.000000';
            return `${lng},${lat}`;
        }).join(';')
        : '';

    return `w=${width}|pts=${points}`;
}

const proposalStorage = {
    proposals: new Map(),
    proposalIndexByHash: new Map(),
    nextProposalId: 0,
    _roadAssetSuffixes: {
        parents: 'roadParents',
        children: 'roadChildren',
        metadata: 'roadParentsKeep'
    },

    _ensureIndexes() {
        if (!this.proposals || typeof this.proposals.clear !== 'function') {
            this.proposals = new Map();
        }
        if (!this.proposalIndexByHash || typeof this.proposalIndexByHash.clear !== 'function') {
            this.proposalIndexByHash = new Map();
        }
    },

    _normalizeProposalIdentity(proposal, context = {}) {
        if (!proposal || typeof proposal !== 'object') return proposal;
        const { existingHash = null } = context;
        const candidate = proposal.proposalId
            || proposal.tokenId
            || existingHash;
        if (candidate !== undefined && candidate !== null) {
            proposal.proposalId = String(candidate);
        }
        return proposal;
    },

    _coerceProposalId(value) {
        if (value === undefined || value === null) return null;
        return String(value);
    },

    _indexProposal(proposal) {
        this._ensureIndexes();
        if (!proposal) return null;
        this._normalizeProposalIdentity(proposal);
        const id = this._coerceProposalId(
            proposal.proposalId
            || proposal.tokenId
        );
        if (!id) return null;
        this.proposals.set(id, proposal);
        return id;
    },

    _removeIndexForProposal(proposal) {
    },

    _resolveProposalId(idOrHash) {
        this._ensureIndexes();
        if (idOrHash === undefined || idOrHash === null) return null;
        const key = String(idOrHash);
        if (this.proposals.has(key)) {
            return key;
        }
        for (const [id, proposal] of this.proposals.entries()) {
            if (!proposal) continue;
            const candidates = [
                proposal.proposalId,
                proposal.tokenId,
                proposal.serverProposalId,
                proposal.id
            ]
                .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
                .map(String);
            if (candidates.includes(key)) {
                return id;
            }
        }
        return null;
    },

    findProposalByIdOrHash(idOrHash) {
        const resolved = this._resolveProposalId(idOrHash);
        return resolved ? this.proposals.get(resolved) : null;
    },

    _computeSimilarityHash(parcelIds = []) {
        const ids = Array.from(new Set((parcelIds || []).map(id => String(id).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return ids.join('|');
    },

    getSimilarProposalsByParcelIds(parcelIds = []) {
        const normalizedIds = normalizeParcelIdList(parcelIds);
        const targetHash = this._computeSimilarityHash(normalizedIds);
        if (!targetHash || !this.proposals || this.proposals.size === 0) {
            return [];
        }

        const matches = [];
        for (const proposal of this.proposals.values()) {
            if (!proposal) continue;
            const proposalIdKey = proposal.similarityHash || this._computeSimilarityHash(proposal.parentParcelIds);
            if (proposalIdKey && proposalIdKey === targetHash) {
                matches.push(proposal);
            }
        }
        return matches;
    },

    importOnChainProposal(raw) {
        if (!raw || !raw.proposalId) return null;
        const proposalId = String(raw.proposalId);
        const parentParcelIds = Array.isArray(raw.parentParcelIds) ? raw.parentParcelIds : [];

        // Try to reuse any already-known record (by id OR hash) to avoid losing richer metadata/titles
        const existing =
            (typeof this.findProposalByIdOrHash === 'function' ? this.findProposalByIdOrHash(proposalId) : null)
            || this.proposals.get(proposalId)
            || null;

        // Prefer any already known human-friendly title/name before falling back to raw chain data
        const pickPreferredString = (...candidates) => {
            const typeLabels = Object.values(PROPOSAL_TYPE_LABELS || {}).map(v => String(v).toLowerCase());
            try {
                Object.keys(PROPOSAL_TYPE_LABELS || {}).forEach(key => {
                    const localized = getProposalTypeLabel(key);
                    if (localized) {
                        typeLabels.push(String(localized).toLowerCase());
                    }
                });
            } catch (_) { }
            let best = '';
            let bestScore = -Infinity;
            const seen = new Set();
            candidates.forEach(c => {
                const trimmed = typeof c === 'string' ? c.trim() : '';
                if (!trimmed || seen.has(trimmed)) return;
                seen.add(trimmed);
                const lower = trimmed.toLowerCase();
                let score = trimmed.length;
                if (typeLabels.includes(lower)) {
                    score -= 100; // heavily de-prioritise pure type labels like "Square"
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = trimmed;
                }
            });
            return best;
        };

        // Try to match an existing local proposal by similarity (parcel set) to borrow its richer title/name
        const similarityHash = raw.similarityHash || this._computeSimilarityHash(parentParcelIds);
        let similar = null;
        try {
            for (const p of this.proposals.values()) {
                if (!p) continue;
                const hash = this._computeSimilarityHash(p.parentParcelIds || []);
                if (hash === similarityHash) {
                    similar = p;
                    break;
                }
            }
        } catch (_) { /* ignore */ }

        const title = pickPreferredString(
            existing && existing.title,
            existing && existing.name,
            existing && existing.blockName,
            existing && existing.structureProposal && existing.structureProposal.blockName,
            existing && existing.metadata && existing.metadata.name,
            existing && existing.metadata && existing.metadata.title,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.name,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.title,
            similar && similar.title,
            similar && similar.name,
            similar && similar.blockName,
            similar && similar.structureProposal && similar.structureProposal.blockName,
            raw.title,
            raw.name,
            raw.blockName,
            raw.structureProposal && raw.structureProposal.blockName,
            raw.metadata && raw.metadata.name,
            raw.metadata && raw.metadata.title,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.name,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.title,
            raw.description,
            `Proposal ${proposalId}`
        );

        const description = pickPreferredString(
            raw.description,
            existing && existing.description,
            raw.metadata && raw.metadata.description,
            existing && existing.metadata && existing.metadata.description,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.description,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.description,
            `Proposal ${proposalId}`
        );
        const author = raw.author || raw.owner || raw.creator || (existing && existing.author) || '';
        const lensEntries = normalizeLensEntries(
            raw.lens
            || raw.lensAddresses
            || (raw.onchain && raw.onchain.lens)
            || (existing && existing.lens)
        );
        const normalizedChainId = typeof normalizeChainId === 'function'
            ? normalizeChainId(raw.chainId || (raw.onchain && raw.onchain.chainId))
            : (raw.chainId || (raw.onchain && raw.onchain.chainId) || null);
        const metaProps = raw.metadata && raw.metadata.properties ? raw.metadata.properties : {};
        const rawGoal = raw.goal
            || metaProps.goal
            || (raw.metadata && raw.metadata.attributes && raw.metadata.attributes.find && (() => {
                const goalAttr = raw.metadata.attributes.find(a => a && a.trait_type && String(a.trait_type).toLowerCase() === 'goal');
                return goalAttr && goalAttr.value;
            })());
        const normalizedGoal = normalizeProposalGoalKey(rawGoal || (existing && existing.goal) || '');

        const normalized = {
            proposalId,
            parentParcelIds,
            title,
            description,
            author,
            chainId: normalizedChainId || (existing && existing.chainId) || null,
            isConditional: !!raw.isConditional,
            imageURI: raw.imageURI || '',
            acceptancePossible: raw.acceptancePossible !== false,
            status: raw.status || 'Active',
            ethBalance: raw.ethBalance || '0',
            tokenBalance: raw.tokenBalance || '0',
            acceptanceCount: raw.acceptanceCount || '0',
            expiryTimestamp: raw.expiryTimestamp || '0',
            expiringPercentage: raw.expiringPercentage || '0',
            createdAt: raw.createdAt || metaProps.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            acceptedParcels: Array.isArray(raw.acceptedParcels) ? raw.acceptedParcels : [],
            similarityHash,
            isMinted: true,
            metadata: raw.metadata || (existing && existing.metadata) || null,
            lens: lensEntries.length ? lensEntries : (existing && existing.lens ? existing.lens : undefined),
            goal: normalizedGoal || (existing && existing.goal) || null,
            onchain: {
                ...(existing && existing.onchain ? existing.onchain : {}),
                ...(raw.onchain ? raw.onchain : {})
            }
        };

        const incomingOnchain = raw.onchain || {};
        const existingOnchain = (existing && existing.onchain) || {};
        const mergedOnchain = {
            ...existingOnchain,
            ...incomingOnchain,
            chainId: normalizedChainId || existingOnchain.chainId || raw.chainId || incomingOnchain.chainId || null,
            proposalId,
            transactionHash: incomingOnchain.transactionHash || existingOnchain.transactionHash || raw.transactionHash || null,
            contractAddress: incomingOnchain.contractAddress || existingOnchain.contractAddress || raw.contractAddress || null
        };
        if (mergedOnchain.chainId || mergedOnchain.transactionHash || mergedOnchain.contractAddress) {
            normalized.onchain = mergedOnchain;
        }

        // Merge with existing (preserve local extras if any)
        const merged = existing ? { ...existing, ...normalized } : normalized;
        merged.isMinted = true; // ensure minted flag stays true

        // Preserve offer-related fields from existing proposal or raw input
        // These fields are not returned by the smart contract, so we must preserve them
        if (existing) {
            // Preserve offer fields from existing proposal (only if they exist)
            if (typeof existing.offer === 'number' && existing.offer > 0) {
                merged.offer = existing.offer;
            }
            if (existing.offerCurrency) {
                merged.offerCurrency = existing.offerCurrency;
            }
            if (typeof existing.decayEnabled === 'boolean') {
                merged.decayEnabled = existing.decayEnabled;
            }
            if (typeof existing.decayPercent === 'number') {
                merged.decayPercent = existing.decayPercent;
            }
            if (typeof existing.decayDurationMs === 'number') {
                merged.decayDurationMs = existing.decayDurationMs;
            }
            if (typeof existing.depositEnabled === 'boolean') {
                merged.depositEnabled = existing.depositEnabled;
            }
            if (typeof existing.depositPercent === 'number') {
                merged.depositPercent = existing.depositPercent;
            }
        } else if (raw) {
            // If no existing proposal, try to get offer fields from raw input
            if (typeof raw.offer === 'number' && raw.offer > 0) {
                merged.offer = raw.offer;
            }
            if (raw.offerCurrency) {
                merged.offerCurrency = raw.offerCurrency;
            }
            if (typeof raw.decayEnabled === 'boolean') {
                merged.decayEnabled = raw.decayEnabled;
            }
            if (typeof raw.decayPercent === 'number') {
                merged.decayPercent = raw.decayPercent;
            }
            if (typeof raw.decayDurationMs === 'number') {
                merged.decayDurationMs = raw.decayDurationMs;
            }
            if (typeof raw.depositEnabled === 'boolean') {
                merged.depositEnabled = raw.depositEnabled;
            }
            if (typeof raw.depositPercent === 'number') {
                merged.depositPercent = raw.depositPercent;
            }
        }

        // Derive offer from chain balances if not already set
        // The smart contract stores balances in Wei (for ETH) and token units
        if (!merged.offer || typeof merged.offer !== 'number' || merged.offer === 0) {
            // Try to derive offer from ethBalance (in Wei)
            const ethBalanceStr = String(raw.ethBalance || normalized.ethBalance || '0');
            try {
                const ethBalanceWei = BigInt(ethBalanceStr);

                if (ethBalanceWei > 0n) {
                    // Convert Wei to ETH (divide by 10^18)
                    const ethAmount = Number(ethBalanceWei) / 1e18;
                    merged.offer = ethAmount;
                    if (!merged.offerCurrency) {
                        merged.offerCurrency = 'ETH';
                    }
                } else {
                    // Check tokenBalance as fallback
                    const tokenBalanceStr = String(raw.tokenBalance || normalized.tokenBalance || '0');
                    const tokenBalance = BigInt(tokenBalanceStr);

                    if (tokenBalance > 0n) {
                        // For tokens, we'd need to know the token decimals, but for now
                        // we'll assume 18 decimals (standard) and use a generic currency
                        const tokenAmount = Number(tokenBalance) / 1e18;
                        merged.offer = tokenAmount;
                        if (!merged.offerCurrency) {
                            merged.offerCurrency = 'USDT'; // Default to USDT for tokens
                        }
                    }
                }
            } catch (e) {
                console.warn('Failed to parse balance for proposal', proposalId, e);
            }
        }

        merged.proposalId = this._coerceProposalId(merged.proposalId);
        this._indexProposal(merged);
        this.save();
        return merged;
    },

    load() {
        this._ensureIndexes();
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const raw = PersistentStorage.getItem(PROPOSALS_STORAGE_KEY);
            if (!raw) {
                this.proposals.clear();
                this.proposalIndexByHash.clear();
                // Initialize next id from persisted key or 0
                const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
                this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
                return;
            }
            const parsed = JSON.parse(raw);
            this.proposals.clear();
            this.proposalIndexByHash.clear();
            if (!Array.isArray(parsed)) return;

            parsed.forEach(entry => {
                if (!entry) return;
                const normalized = this._normalizeProposal({ ...entry });
                // Ensure we have a stable proposalId
                if (!normalized.proposalId) {
                    // Prefer preserving uploaded proposals as their server id when we have evidence (`id` or `serverProposalId`).
                    const serverHintRaw = normalized.serverProposalId || normalized.id;
                    const serverHint = serverHintRaw && !isLocalProposalId(serverHintRaw) ? String(serverHintRaw) : null;
                    if (serverHint) {
                        normalized.proposalId = serverHint;
                    }
                }
                // Ensure timestamps exist
                normalized.createdAt = normalized.createdAt || new Date().toISOString();
                normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
                normalized.proposalId = this._coerceProposalId(normalized.proposalId);
                this._indexProposal(normalized);
            });

            // Initialize nextProposalId from persisted value, default to 0
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;

            // Persist migrated isMinted flags (tokenId-based proposals => minted)
            this.save();
        } catch (error) {
            console.error('proposalStorage.load: Failed to parse proposals from storage', error);
            this._ensureIndexes();
            this.proposals.clear();
            this.proposalIndexByHash.clear();
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
        }
    },

    save() {
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const serialisable = Array.from(this.proposals.values());
            PersistentStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(serialisable));
            // Persist the next proposal id counter
            PersistentStorage.setItem(PROPOSALS_NEXT_ID_KEY, String(this.nextProposalId));
        } catch (error) {
            console.error('proposalStorage.save: Failed to persist proposals', error);
        }
    },

    _roadAssetKey(proposalId, suffix) {
        if (!proposalId || !suffix) return null;
        return `proposal_${proposalId}_${suffix}`;
    },

    _resolveRoadAssetKey(idOrHash) {
        const resolved = this._resolveProposalId(idOrHash);
        return resolved ? String(resolved) : null;
    },

    persistRoadAssets(proposalIdOrHash) {
        // Road assets now live on-demand; clear any legacy sidecars when touched.
        this.clearRoadAssets(proposalIdOrHash);
    },

    loadRoadAssets() {
        // Sidecars removed; keep signature for backward compatibility.
        return { parentFeatures: [], parentsKeepDetails: null };
    },

    clearRoadAssets(proposalIdOrHash) {
        if (typeof PersistentStorage === 'undefined') return;
        const key = this._resolveRoadAssetKey(proposalIdOrHash);
        if (!key) return;
        const parentKey = this._roadAssetKey(key, this._roadAssetSuffixes.parents);
        const childKey = this._roadAssetKey(key, this._roadAssetSuffixes.children);
        const metaKey = this._roadAssetKey(key, this._roadAssetSuffixes.metadata);
        try { if (parentKey) PersistentStorage.removeItem(parentKey); } catch (_) { }
        try { if (childKey) PersistentStorage.removeItem(childKey); } catch (_) { }
        try { if (metaKey) PersistentStorage.removeItem(metaKey); } catch (_) { }
    },

    getAllProposals() {
        return Array.from(this.proposals.values());
    },

    /**
     * Remove minted proposals that are not on the provided chain (or have unknown chain)
     * Used when the active chain changes to prevent cross-chain mixing in UI caches.
     * @param {string|number|null} chainId - normalized chain id to keep
     * @returns {number} removed count
     */
    purgeMintedProposalsNotOnChain(chainId) {
        const normalizedTarget = typeof normalizeChainId === 'function'
            ? normalizeChainId(chainId)
            : (chainId !== undefined && chainId !== null ? String(chainId) : null);

        let removed = 0;
        for (const [id, proposal] of this.proposals.entries()) {
            if (!proposal || proposal.isMinted !== true) continue;
            const proposalChain = typeof normalizeChainId === 'function'
                ? normalizeChainId(proposal.chainId || (proposal.onchain && proposal.onchain.chainId))
                : (proposal.chainId || (proposal.onchain && proposal.onchain.chainId) || null);

            const keep = normalizedTarget && proposalChain === normalizedTarget;
            if (!keep) {
                this.removeProposal(id);
                removed += 1;
            }
        }
        if (removed > 0 && typeof this.save === 'function') {
            this.save();
        }
        return removed;
    },

    getProposal(idOrHash) {
        const resolvedId = this._resolveProposalId(idOrHash);
        return resolvedId ? this.proposals.get(resolvedId) || null : null;
    },

    getProposalsForParcel(parcelId, options = {}) {
        const id = normalizeParcelId(parcelId);
        if (!id) {
            return [];
        }
        const results = [];
        const hydrateRoadAssets = options && Object.prototype.hasOwnProperty.call(options, 'hydrateRoadAssets')
            ? !!options.hydrateRoadAssets
            : true;
        for (const proposal of this.proposals.values()) {
            const parentIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            const parcelMatch = parentIds.some(value => normalizeParcelId(value) === id);

            const childIds = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [];
            const decideLaterChildIds = Array.isArray(proposal.decideLaterProposal?.childParcelIds) ? proposal.decideLaterProposal.childParcelIds : [];
            const allChildIds = childIds.concat(decideLaterChildIds);
            const childMatch = allChildIds.some(value => normalizeParcelId(value) === id);

            let roadMatch = false;
            if (!parcelMatch && proposal.roadProposal) {
                const road = proposal.roadProposal;
                const roadParentIds = Array.isArray(road.parentParcelIds) ? road.parentParcelIds : [];
                const roadChildIds = Array.isArray(road.childParcelIds) ? road.childParcelIds : [];
                const combinedIds = roadParentIds.concat(roadChildIds);
                roadMatch = combinedIds.some(value => normalizeParcelId(value) === id);

                if (!roadMatch && hydrateRoadAssets) {
                    // With road assets stored in-proposal, only ids are available; rely on parent/child id lists
                    roadMatch = roadParentIds.some(value => normalizeParcelId(value) === id)
                        || roadChildIds.some(value => normalizeParcelId(value) === id);
                }
            }

            if (parcelMatch || childMatch || roadMatch) {
                results.push(proposal);
            }
        }
        return results;
    },

    addProposal(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;

        if (typeof this._ensureIndexes === 'function') {
            this._ensureIndexes();
        }

        const normalized = this._normalizeProposal({ ...proposal });
        const seed = this._buildHashSeed(normalized);
        const duplicate = this._findDuplicateBySeed(seed);
        if (duplicate) {
            console.debug('[proposalStorage] Duplicate seed detected; allowing insert', { seed, existingId: duplicate.proposalId });
        }

        normalized.createdAt = normalized.createdAt || new Date().toISOString();
        normalized.updatedAt = new Date().toISOString();

        // Ensure proposals get a deterministic, stable ID derived from immutable inputs
        if (!normalized.proposalId || isLocalProposalId(normalized.proposalId)) {
            normalized.proposalId = this._buildDeterministicId(normalized);
        }

        // Local proposals default to not minted
        if (normalized.isMinted === undefined || normalized.isMinted === null) {
            normalized.isMinted = false;
        }

        // Ensure legacy hash fields are removed

        normalized.proposalId = this._coerceProposalId(normalized.proposalId);
        if (this.proposals && this.proposals.has(normalized.proposalId)) {
            const suffix = Date.now().toString(36);
            normalized.proposalId = `${normalized.proposalId}-${suffix}`;
        }
        if (normalized.roadProposal) {
            normalized.roadProposal.id = normalized.proposalId;
            normalized.roadProposal.proposalId = normalized.proposalId;
        }

        this._indexProposal(normalized);
        this.save();
        return normalized.proposalId;
    },

    importProposal(proposal, options = {}) {
        if (!proposal || typeof proposal !== 'object') {
            return null;
        }

        const { overwrite = true, preserveStatus = false } = options;
        const normalized = this._normalizeProposal({ ...proposal });

        if (!preserveStatus) {
            normalized.status = normalized.status === 'Executed' ? 'Executed' : 'Active';
            if (normalized.roadProposal) {
                normalized.roadProposal.status = 'unapplied';
            }
            if (normalized.buildingProposal) {
                normalized.buildingProposal.status = normalized.buildingProposal.status === 'executed' ? 'executed' : 'unapplied';
            }
        }

        normalized.createdAt = normalized.createdAt || new Date().toISOString();
        normalized.updatedAt = new Date().toISOString();

        // Preserve the original server ID before potentially replacing with hash-based ID.
        const incomingId = this._coerceProposalId(normalized.proposalId);
        const isNumericServerId = incomingId && /^\d+$/.test(incomingId);
        if (isNumericServerId && !normalized.serverProposalId) {
            normalized.serverProposalId = incomingId;
        }

        let idKey = incomingId;
        if (!idKey || isLocalProposalId(idKey)) {
            idKey = this._buildDeterministicId(normalized);
        }
        normalized.proposalId = idKey;

        if (!overwrite && idKey && this.proposals.has(idKey)) {
            return null;
        }

        this._indexProposal(normalized);
        this.save();
        return normalized;
    },

    removeProposal(idOrHash) {
        const resolvedId = this._resolveProposalId(idOrHash);
        const existing = resolvedId ? this.proposals.get(resolvedId) : null;
        const deleted = resolvedId ? this.proposals.delete(resolvedId) : false;
        if (deleted) {
            this._removeIndexForProposal(existing);
            this.clearRoadAssets(resolvedId || idOrHash);
            this.save();
            if (typeof removeExecutedBuildingByProposalId === 'function') {
                try {
                    removeExecutedBuildingByProposalId(existing?.proposalId || idOrHash);
                } catch (error) {
                    console.warn('removeExecutedBuildingByProposalId failed', error);
                }
            }
        }
        return deleted && existing ? existing : null;
    },

    clear() {
        this.proposals.clear();
        if (typeof PersistentStorage !== 'undefined') {
            PersistentStorage.removeItem(PROPOSALS_STORAGE_KEY);
        }
    },

    updateProposalStatus(proposalId, status) {
        const proposal = this.getProposal(proposalId);
        if (proposal) {
            proposal.status = status;
            proposal.updatedAt = new Date().toISOString();

            if (proposal.roadProposal) {
                const nextStatus = status === 'Applied' ? 'applied' : status === 'Executed' ? 'executed' : 'unapplied';
                proposal.roadProposal.status = nextStatus;
            }

            if (proposal.buildingProposal) {
                const nextStatus = status === 'Executed' ? 'executed' : status === 'Applied' ? 'applied' : 'unapplied';
                proposal.buildingProposal.status = nextStatus;
            }

            this._indexProposal(proposal);
        }
    },

    _normalizeProposal(proposal, context = {}) {
        const { existingHash = null } = context || {};
        const normalizedParentParcelIds = normalizeParcelIdList(
            (proposal.parentParcelIds && proposal.parentParcelIds.length ? proposal.parentParcelIds : proposal.parcelIds) || []
        );
        proposal.parentParcelIds = normalizedParentParcelIds;
        if (proposal.parcelIds) {
            delete proposal.parcelIds;
        }
        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);
        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        proposal.status = proposal.status || 'Active';
        proposal.similarityHash = proposal.similarityHash || this._computeSimilarityHash(proposal.parentParcelIds);
        proposal.lens = normalizeLensEntries(
            proposal.lens
            || proposal.lensEntries
            || proposal.lensAddresses
            || proposal.trustedLens
            || []
        );

        // Normalize identity to proposalId and drop legacy hash fields
        this._normalizeProposalIdentity(proposal, { existingHash });

        // Minted flag default (keep local-only proposals as not minted)
        if (proposal.isMinted === undefined || proposal.isMinted === null) {
            proposal.isMinted = !!(proposal.onchain && proposal.onchain.transactionHash);
        } else {
            proposal.isMinted = !!proposal.isMinted;
        }

        // Ensure proposalId is preserved (it is the canonical key used across the UI and persistence).
        // IMPORTANT: Do NOT delete proposal.proposalId here, otherwise uploaded proposals lose their server id on save,
        // and reload will re-wrap them as local-*.
        const derivedId = proposal.proposalId
            ?? proposal.serverProposalId
            ?? proposal.id
            ?? proposal.tokenId
            ?? existingHash;
        if (derivedId !== undefined && derivedId !== null && String(derivedId).trim().length > 0) {
            proposal.proposalId = String(derivedId);
        }

        // If still missing or local-like, assign deterministic hash-based id
        if (!proposal.proposalId || isLocalProposalId(proposal.proposalId)) {
            try {
                proposal.proposalId = proposalStorage._buildDeterministicId(proposal);
            } catch (_) { /* fallback handled elsewhere */ }
        }

        // Canonical goal: this is the ONLY type discriminator going forward.
        proposal.goal = normalizeProposalGoalKey(proposal.goal);
        if (!proposal.goal) {
            if (proposal.decideLaterProposal) {
                proposal.goal = 'decide-later';
            } else if (proposal.roadProposal) {
                proposal.goal = 'road-track';
            } else if (proposal.reparcellization) {
                proposal.goal = 'reparcellization';
            } else if (proposal.structureProposal && proposal.structureProposal.kind) {
                const kind = normalizeProposalGoalKey(proposal.structureProposal.kind);
                proposal.goal = (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square';
            } else if (proposal.buildingProposal || proposal.buildingGeometry) {
                proposal.goal = 'buildings';
            } else {
                proposal.goal = 'parcel';
            }
        }

        if (proposal.roadProposal) {
            const rp = { ...proposal.roadProposal };
            rp.parentParcelIds = normalizeParcelIdList(rp.parentParcelIds || proposal.parentParcelIds || []);
            rp.childParcelIds = normalizeParcelIdList(rp.childParcelIds || []);
            if (rp.parentsKeepDetails && typeof rp.parentsKeepDetails !== 'object') {
                rp.parentsKeepDetails = null;
            }
            delete rp.parentFeatures;
            delete rp.childFeatures;
            proposal.roadProposal = rp;
        }

        if (proposal.buildingProposal) {
            const bp = { ...proposal.buildingProposal };
            bp.parentParcelIds = normalizeParcelIdList(bp.parentParcelIds && bp.parentParcelIds.length > 0 ? bp.parentParcelIds : proposal.parentParcelIds || []);
            if (Array.isArray(bp.parentParcelNumbers)) {
                bp.parentParcelNumbers = bp.parentParcelNumbers.map(entry => ({
                    id: normalizeParcelId(entry?.id) || (entry?.id ? String(entry.id) : null),
                    number: entry && entry.number ? String(entry.number) : (normalizeParcelId(entry?.id) || null)
                })).filter(entry => entry.id);
            }
            bp.status = bp.status === 'executed' ? 'executed' : (bp.status === 'applied' ? 'applied' : 'unapplied');
            bp.parameters = bp.parameters && typeof bp.parameters === 'object' ? { ...bp.parameters } : {};
            Object.keys(bp.parameters).forEach(key => {
                if (bp.parameters[key] === undefined || bp.parameters[key] === null) {
                    delete bp.parameters[key];
                }
            });

            if (!proposal.geometry) proposal.geometry = {};

            // Legacy buildingFeatures/buildingFeature intentionally ignored; left untouched

            if (Array.isArray(bp.buildings)) {
                bp.buildings = bp.buildings
                    .map(entry => {
                        if (!entry || typeof entry !== 'object') return null;
                        const clone = { ...entry };
                        if (clone.feature) {
                            try { clone.feature = JSON.parse(JSON.stringify(clone.feature)); } catch (_) { }
                        }
                        return clone;
                    })
                    .filter(Boolean);
            }
            if (!bp.ancestorKey) {
                bp.ancestorKey = (bp.parentParcelIds || []).join('|');
            }
            proposal.buildingProposal = bp;
        } else if (proposal.buildingGeometry || ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(normalizeProposalGoalKey(proposal.goal) || '')) {
            const parentIds = normalizeParcelIdList(proposal.parentParcelIds || []);
            proposal.buildingProposal = {
                parentParcelIds: parentIds,
                parentParcelNumbers: parentIds.map(id => ({ id, number: id })),
                status: (proposal.status === 'Applied' || proposal.status === 'Executed') ? 'applied' : 'unapplied',
                ancestorKey: parentIds.join('|'),
                parameters: {}
            };
            if (!proposal.geometry) proposal.geometry = {};
            if (proposal.buildingGeometry && !proposal.geometry.buildings) {
                proposal.geometry.buildings = [deepClone(proposal.buildingGeometry)];
            }
        }

        // Normalize structure proposals (parks/squares)
        if (proposal.structureProposal) {
            const sp = { ...proposal.structureProposal };
            sp.kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';
            sp.parentParcelIds = normalizeParcelIdList(Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0 ? sp.parentParcelIds : proposal.parentParcelIds || []);
            if (sp.geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(sp.geometry)); } catch (_) { }
            }
            if (sp.blockName === undefined) {
                sp.blockName = null;
            }
            proposal.structureProposal = sp;
            proposal.goal = normalizeProposalGoalKey(sp.kind) || proposal.goal;
        }

        return proposal;
    },

    _buildHashSeed(proposal) {
        // Canonical, immutable inputs only (no titles/offers/lens). Used for stable proposalId.
        const parts = [];
        const city = (typeof getCurrentCityId === 'function') ? getCurrentCityId() : (proposal.city || '');
        const goal = normalizeProposalGoalKey(proposal.goal) || 'parcel';
        const parentIds = normalizeParcelIdList(proposal.parentParcelIds || (proposal.roadProposal && proposal.roadProposal.parentParcelIds) || []);

        parts.push(`city:${city}`);
        parts.push(`goal:${goal}`);
        parts.push(`parents:${parentIds.join(',')}`);

        // Road / track
        const roadDef = proposal.roadProposal?.definition || proposal.definition || null;
        if (roadDef) {
            parts.push(`roadDef:${serialiseRoadDefinition(roadDef)}`);
        }
        if (proposal.roadProposal?.mode) {
            parts.push(`roadMode:${proposal.roadProposal.mode}`);
        }
        const roadGeom = proposal.roadGeometry?.polygon?.coordinates?.[0];
        if (roadGeom) {
            parts.push(`roadGeom:${serialiseRoadCoordinates(roadGeom)}`);
        }

        // Building proposals
        if (proposal.buildingProposal) {
            parts.push(`buildingParents:${normalizeParcelIdList(proposal.buildingProposal.parentParcelIds || parentIds).join(',')}`);
            if (proposal.buildingProposal.parameters) {
                try { parts.push(`buildingParams:${JSON.stringify(proposal.buildingProposal.parameters, Object.keys(proposal.buildingProposal.parameters).sort())}`); } catch (_) { }
            }
        }
        if (proposal.buildingGeometry) {
            parts.push(`buildingGeom:${serialiseGeometry(proposal.buildingGeometry)}`);
        }

        // Structure (park/square/lake)
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            parts.push(`structureKind:${sp.kind || ''}`);
            parts.push(`structureParents:${normalizeParcelIdList(sp.parentParcelIds || parentIds).join(',')}`);
            if (sp.geometry) parts.push(`structureGeom:${serialiseGeometry(sp.geometry)}`);
        }

        // Reparcellization
        if (proposal.reparcellization) {
            const rep = proposal.reparcellization;
            parts.push(`reparcAlg:${rep.algorithm || ''}`);
            parts.push(`reparcParcels:${normalizeParcelIdList(rep.parcelIds || parentIds).join(',')}`);
            if (Array.isArray(rep.polygons)) {
                try { parts.push(`reparcPolys:${JSON.stringify(rep.polygons)}`); } catch (_) { }
            }
        }

        // Fallback geometry if present
        if (proposal.geometry) {
            try { parts.push(`geom:${JSON.stringify(proposal.geometry)}`); } catch (_) { }
        }

        return parts.join('|');
    },

    _buildDeterministicId(proposal) {
        const seed = this._buildHashSeed(proposal);
        const digest = hashStringDeterministic(seed);
        return `p-${digest}`;
    },

    _findDuplicateBySeed(seed) {
        for (const proposal of this.proposals.values()) {
            if (this._buildHashSeed(proposal) === seed) {
                return proposal;
            }
        }
        return null;
    }
};

const proposalHighlightState = {
    activeParcelIds: new Set(),
    activeChildFeatures: [],
    activeParentFeatures: [],
    activeProposalId: null,
    pendingBlink: false
};

let currentProposalPreviewId = null;

function getProposalKey(proposal) {
    if (!proposal) return null;
    if (proposal.proposalId !== undefined && proposal.proposalId !== null) {
        return String(proposal.proposalId);
    }
    if (proposal.proposalId) {
        return String(proposal.proposalId);
    }
    return null;
}

function resolveProposalIdKey(idOrHash) {
    if (idOrHash === undefined || idOrHash === null || typeof proposalStorage === 'undefined') {
        return null;
    }
    if (typeof proposalStorage._resolveProposalId === 'function') {
        const resolved = proposalStorage._resolveProposalId(idOrHash);
        if (resolved !== null && resolved !== undefined) {
            return resolved;
        }
    }
    return String(idOrHash);
}

function getProposalByIdOrHash(idOrHash) {
    if (typeof proposalStorage === 'undefined') return null;
    const resolved = resolveProposalIdKey(idOrHash);
    return resolved ? proposalStorage.getProposal(resolved) : null;
}

function ensureProposalHighlightPanes(targetMap) {
    if (!targetMap || typeof targetMap.getPane !== 'function' || typeof targetMap.createPane !== 'function') {
        return null;
    }

    // Keep these above markerPane (600) but below popupPane (700)
    const panes = {
        highlight: { name: 'proposalHighlightPane', zIndex: 650 },
        hover: { name: 'proposalHoverPane', zIndex: 660 },
        hoverLabels: { name: 'proposalHoverLabelPane', zIndex: 670 }
    };

    Object.values(panes).forEach(({ name, zIndex }) => {
        try {
            if (!targetMap.getPane(name)) {
                targetMap.createPane(name);
            }
            const pane = targetMap.getPane(name);
            if (pane && pane.style) {
                pane.style.zIndex = String(zIndex);
            }
        } catch (error) {
            console.warn('ensureProposalHighlightPanes: unable to create pane', name, error);
        }
    });

    window.__proposalHighlightPanes = {
        highlight: panes.highlight.name,
        hover: panes.hover.name,
        hoverLabels: panes.hoverLabels.name
    };

    return window.__proposalHighlightPanes;
}

function ensureProposalOverlayGroups() {
    if (typeof map === 'undefined' || !map) {
        return {};
    }

    const panes = ensureProposalHighlightPanes(map);

    if (!window.proposalPreviewGroup) {
        window.proposalPreviewGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBorderGroup) {
        window.proposalBorderGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverGroup) {
        window.proposalHoverGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverLabelGroup) {
        window.proposalHoverLabelGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBackgroundGroup) {
        window.proposalBackgroundGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalAcceptedGroup) {
        window.proposalAcceptedGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBuildingPreviewGroup) {
        window.proposalBuildingPreviewGroup = L.featureGroup().addTo(map);
    }

    // Attach pane metadata so individual layers can render in a dedicated high-zIndex pane.
    // (FeatureGroup itself doesn't accept pane options.)
    if (panes) {
        window.proposalPreviewGroup.__paneName = panes.highlight;
        window.proposalBorderGroup.__paneName = panes.highlight;
        window.proposalBackgroundGroup.__paneName = panes.highlight;
        window.proposalAcceptedGroup.__paneName = panes.highlight;
        window.proposalBuildingPreviewGroup.__paneName = panes.highlight;
        window.proposalHoverGroup.__paneName = panes.hover;
        window.proposalHoverLabelGroup.__paneName = panes.hoverLabels;
    }

    return {
        preview: window.proposalPreviewGroup,
        border: window.proposalBorderGroup,
        hover: window.proposalHoverGroup,
        hoverLabels: window.proposalHoverLabelGroup,
        background: window.proposalBackgroundGroup,
        accepted: window.proposalAcceptedGroup,
        buildingPreview: window.proposalBuildingPreviewGroup
    };
}

function clearProposalBackgroundLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.background) groups.background.clearLayers();
}

function clearProposalAcceptedLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.accepted) groups.accepted.clearLayers();
}

function clearProposalPreviewLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) groups.preview.clearLayers();
    if (groups.border) groups.border.clearLayers();
    if (groups.buildingPreview) groups.buildingPreview.clearLayers();
}

function clearProposalHoverLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.hover) groups.hover.clearLayers();
    if (groups.hoverLabels) groups.hoverLabels.clearLayers();
}

function updateParcelNumberFilterForProposal(ids) {
    proposalHighlightState.activeParcelIds = ids ? new Set(Array.from(ids)) : new Set();
    if (typeof setParcelNumberLabelFilter === 'function') {
        if (proposalHighlightState.activeParcelIds.size > 0) {
            setParcelNumberLabelFilter(proposalHighlightState.activeParcelIds);
        } else {
            setParcelNumberLabelFilter(null);
        }
    }
}

function getFeatureCentroid(feature) {
    if (!feature || !feature.geometry) return null;
    try {
        if (typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            const centroid = turf.centerOfMass(feature);
            const coords = centroid?.geometry?.coordinates;
            if (Array.isArray(coords) && coords.length >= 2) {
                const [lng, lat] = coords;
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    return L.latLng(lat, lng);
                }
            }
        }
    } catch (_) { }

    try {
        const temp = L.geoJSON(feature);
        const bounds = temp.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds.getCenter();
        }
    } catch (_) { }
    return null;
}

function highlightFeaturesForHover(features, { color = '#FFB300', weight = 5, dashArray = '4 4', showLabels = false, className = 'proposal-hover-outline proposal-hover-outline--animate' } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.hover || !groups.hoverLabels) return;

    const panes = window.__proposalHighlightPanes || null;

    groups.hover.clearLayers();
    groups.hoverLabels.clearLayers();

    if (!Array.isArray(features)) return;

    features.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            const outline = L.geoJSON(feature, {
                pane: panes?.hover || undefined,
                style: {
                    color,
                    weight,
                    fillOpacity: 0,
                    dashArray,
                    className
                },
                interactive: false
            });
            outline.addTo(groups.hover);

            if (showLabels) {
                const broj = getParcelDisplayNumberFromFeature(feature);
                const center = getFeatureCentroid(feature);
                if (broj && center) {
                    const label = L.marker(center, {
                        pane: panes?.hoverLabels || undefined,
                        icon: L.divIcon({
                            className: 'proposal-hover-parcel-label',
                            html: `${broj}`,
                            iconSize: [46, 20],
                            iconAnchor: [23, 10]
                        }),
                        interactive: false
                    });
                    label.addTo(groups.hoverLabels);
                }
            }
        } catch (error) {
            console.warn('Failed to highlight feature for hover', error);
        }
    });

    if (groups.hover.bringToFront) groups.hover.bringToFront();
    if (groups.hoverLabels.bringToFront) groups.hoverLabels.bringToFront();
}

function getParcelFeatureForHighlight(parcelId, proposalContext = null, options = {}) {
    const { skipRecovery = false } = options;
    const proposal = proposalContext && proposalContext.proposal ? proposalContext.proposal : proposalContext;
    const cached = proposal ? getCachedParcelFeature(parcelId, proposal) : null;
    if (cached) {
        return cached;
    }

    if (!parcelId || typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) {
        return null;
    }

    try {
        // If skipRecovery is true, don't trigger recoverParcelFromProposals (prevents infinite recursion)
        const layer = skipRecovery
            ? (multiParcelSelection.parcelIdIndex && multiParcelSelection.parcelIdIndex.get(parcelId.toString()))
            : multiParcelSelection.findParcelById(parcelId);
        if (layer && typeof layer.toGeoJSON === 'function') {
            const feature = layer.toGeoJSON();
            if (proposal) {
                const cache = buildProposalFeatureCache(proposal);
                if (cache && cache.parcelsById) {
                    try {
                        cache.parcelsById.set(parcelId.toString(), feature);
                    } catch (_) { }
                }
            }
            return feature;
        }
    } catch (error) {
        console.warn('getParcelFeatureForHighlight: unable to locate parcel', parcelId, error);
    }
    return null;
}

function collectProposalHighlightFeatures(proposal, { includeParents = false, includeChildren = true } = {}) {
    const features = [];
    if (!proposal) return features;

    const cache = buildProposalFeatureCache(proposal) || {};

    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal;

    if (isRoadProposal && includeChildren !== false) {
        const childIds = Array.isArray(proposal.roadProposal.childParcelIds)
            ? proposal.roadProposal.childParcelIds
            : [];
        const uniqueChildIds = Array.from(new Set(childIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueChildIds.forEach(childId => {
            const feature = getParcelFeatureForHighlight(childId, proposal);
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if (includeParents && proposal.roadProposal) {
        // Fetch parent features by ID - never read from cached parentFeatures
        const parentIds = [];
        if (Array.isArray(proposal.roadProposal.parentParcelIds)) parentIds.push(...proposal.roadProposal.parentParcelIds);
        if (Array.isArray(proposal.parentParcelIds)) parentIds.push(...proposal.parentParcelIds);
        if (Array.isArray(proposal.parentParcelIds)) parentIds.push(...proposal.parentParcelIds);
        const uniqueParentIds = Array.from(new Set(parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueParentIds.forEach(parentId => {
            const feature = getParcelFeatureForHighlight(parentId, proposal);
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if ((!isRoadProposal || features.length === 0) && Array.isArray(proposal.parentParcelIds)) {
        proposal.parentParcelIds.forEach(parcelId => {
            const feature = getParcelFeatureForHighlight(parcelId, proposal);
            if (feature) {
                features.push(feature);
            }
        });
    }

    return features;
}

function highlightParcelHover(parcelId, options = {}) {
    const proposal = options.proposal || null;
    const feature = getParcelFeatureForHighlight(parcelId, proposal);
    if (feature) {
        highlightFeaturesForHover([feature], {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true,
            ...options
        });
    }
}

function highlightProposalHover(proposal, options = {}) {
    const features = collectProposalHighlightFeatures(proposal, options);
    if (features.length > 0) {
        highlightFeaturesForHover(features, options);
    }
}

function collectProposalBuildingFeatures(proposal) {
    const features = [];
    if (!proposal) return features;

    const clone = (raw) => {
        try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
    };

    const bp = proposal.buildingProposal || {};

    if (Array.isArray(proposal.geometry?.buildings) && proposal.geometry.buildings.length) {
        proposal.geometry.buildings.forEach(raw => {
            const cloned = clone(raw);
            if (cloned && cloned.geometry) features.push(cloned);
        });
        return features;
    }

    if (Array.isArray(bp.buildings) && bp.buildings.length) {
        proposal.geometry = proposal.geometry || {};
        proposal.geometry.buildings = bp.buildings
            .map(entry => clone(entry?.feature))
            .filter(f => f && f.geometry);
        return proposal.geometry.buildings;
    }

    return features;
}

function renderProposalBuildingPreview(proposal) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.buildingPreview) return;
    groups.buildingPreview.clearLayers();

    const panes = window.__proposalHighlightPanes || null;

    if (!proposal || !collectProposalBuildingFeatures) return;
    const buildingFeatures = collectProposalBuildingFeatures(proposal);
    if (!buildingFeatures.length) return;

    buildingFeatures.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            L.geoJSON(feature, {
                pane: panes?.highlight || undefined,
                style: {
                    color: '#6c63ff',
                    weight: 2,
                    dashArray: '6 4',
                    fillOpacity: 0
                },
                interactive: false
            }).addTo(groups.buildingPreview);
        } catch (error) {
            console.warn('renderProposalBuildingPreview failed for feature', error);
        }
    });

    if (groups.buildingPreview.bringToFront) groups.buildingPreview.bringToFront();
}

function highlightProposalHoverById(proposalId, options = {}) {
    if (!proposalId || typeof proposalStorage === 'undefined') return;
    const proposal = proposalStorage.getProposal(proposalId);
    if (proposal) {
        highlightProposalHover(proposal, options);
    }
}

// Global flag to suppress camera movements during certain flows (e.g., shared apply)
function isCameraMovementSuppressed() {
    try { return !!(window && window.suppressCameraMoves); } catch (_) { return false; }
}

function cloneGeoJSONFeature(feature) {
    try {
        return JSON.parse(JSON.stringify(feature));
    } catch (_) {
        return null;
    }
}

function normaliseToFeature(input, defaultProperties = {}) {
    if (!input) return null;

    if (input.type === 'Feature' && input.geometry) {
        const cloned = cloneGeoJSONFeature(input);
        if (cloned) {
            cloned.properties = { ...(cloned.properties || {}), ...defaultProperties };
        }
        return cloned;
    }

    if (input.type && input.coordinates) {
        const geometryClone = cloneGeoJSONFeature(input);
        if (!geometryClone) return null;
        return {
            type: 'Feature',
            geometry: geometryClone,
            properties: { ...defaultProperties }
        };
    }

    return null;
}

// Cache proposal-provided parcel features to avoid re-hydrating from the map layer
const proposalFeatureCache = new Map();

function getProposalFeatureCacheKey(proposal) {
    if (!proposal) return null;
    if (typeof getProposalKey === 'function') {
        const key = getProposalKey(proposal);
        if (key) return key;
    }
    return proposal.proposalId || null;
}

function loadRoadAssetsForCache(proposal) {
    const roadProposal = proposal?.roadProposal || {};
    const manager = (typeof ProposalManager !== 'undefined') ? ProposalManager : null;

    // Always fetch by ID - never cache parentFeatures on proposal objects
    let parentFeatures = [];
    if (manager && typeof manager._loadRoadProposalAssets === 'function') {
        try {
            // Get parent IDs from the proposal data directly (don't call _collectParentParcelIds which might fail)
            const parentIds = Array.isArray(roadProposal.parentParcelIds) && roadProposal.parentParcelIds.length > 0
                ? roadProposal.parentParcelIds
                : (Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0
                    ? proposal.parentParcelIds
                    : (Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : []));
            if (parentIds.length > 0) {
                const loaded = manager._loadRoadProposalAssets(proposal, {
                    includeParents: true,
                    includeChildren: false,
                    includeKeepDetails: false,
                    allowMissing: true
                }) || {};
                if (Array.isArray(loaded.parentFeatures)) {
                    parentFeatures = loaded.parentFeatures;
                }
            }
        } catch (error) {
            // Silently fail - this is just for caching, not critical
            console.debug('loadRoadAssetsForCache: failed to load assets for proposal', error);
        }
    }

    return { parentFeatures };
}

function buildProposalFeatureCache(proposal) {
    if (!proposal) return null;
    const cacheKey = getProposalFeatureCacheKey(proposal);
    if (cacheKey && proposalFeatureCache.has(cacheKey)) {
        const existing = proposalFeatureCache.get(cacheKey);
        // Check if parentParcelIds changed (not parentFeatures - we don't cache those)
        const existingParentIds = Array.isArray(existing?.parentParcelIds) ? existing.parentParcelIds : [];
        const currentParentIds = Array.isArray(proposal?.roadProposal?.parentParcelIds) ? proposal.roadProposal.parentParcelIds : [];
        const parentIdsChanged = existingParentIds.length !== currentParentIds.length ||
            !existingParentIds.every((id, i) => String(id) === String(currentParentIds[i]));
        if (!parentIdsChanged) {
            return existing;
        }
        proposalFeatureCache.delete(cacheKey);
    }

    const parcelsById = new Map();
    const parentFeatures = [];

    const addFeaturesToCache = (features, targetList, defaultSource) => {
        if (!Array.isArray(features)) return;
        features.forEach(feature => {
            const normalised = normaliseToFeature(feature, defaultSource ? { source: defaultSource } : {});
            if (!normalised || !normalised.geometry) return;
            const parcelId = getParcelIdFromFeature(normalised);
            if (parcelId) {
                parcelsById.set(parcelId.toString(), normalised);
            }
            targetList.push(normalised);
        });
    };

    // Prefer proposal-provided road assets (parent features)
    const roadAssets = loadRoadAssetsForCache(proposal);
    addFeaturesToCache(roadAssets.parentFeatures, parentFeatures, 'road-parent');

    // Cache any other parcels listed on the proposal (e.g., building proposals)
    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    parcelIds.forEach(parcelId => {
        const key = parcelId && parcelId.toString ? parcelId.toString() : (parcelId ? String(parcelId) : null);
        if (!key || parcelsById.has(key)) {
            return;
        }
        // Only index placeholders here; actual feature resolution happens lazily
        parcelsById.set(key, parcelsById.get(key) || null);
    });

    const cacheValue = { parcelsById, parentFeatures, childFeatures: [] };
    if (cacheKey) {
        proposalFeatureCache.set(cacheKey, cacheValue);
    }
    return cacheValue;
}

function getCachedParcelFeature(parcelId, proposal) {
    if (!parcelId || !proposal) return null;
    const cache = buildProposalFeatureCache(proposal);
    if (!cache || !cache.parcelsById) return null;
    const key = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
    const cached = cache.parcelsById.get(key);
    if (cached && cached.geometry) {
        const clone = cloneGeoJSONFeature(cached);
        return clone || cached;
    }
    return null;
}

function collectProposalFeatureSets(proposal, options = {}) {
    const includeBuildingGeometry = options && Object.prototype.hasOwnProperty.call(options, 'includeBuildingGeometry')
        ? !!options.includeBuildingGeometry
        : true;
    const parcelFeatures = [];
    const primaryFeatures = [];
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];
    const cache = buildProposalFeatureCache(proposal) || {};

    parcelIds.forEach(parcelId => {
        const feature = getParcelFeatureForHighlight(parcelId, proposal);
        if (feature) {
            parcelFeatures.push(feature);
        }
    });

    if (resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal) {
        const childIds = Array.isArray(proposal.roadProposal.childParcelIds)
            ? proposal.roadProposal.childParcelIds
            : [];
        const uniqueChildIds = Array.from(new Set(childIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        // If we have child ids (from applied proposals), resolve them for display
        const resolvedChildren = uniqueChildIds
            .map(id => getParcelFeatureForHighlight(id, proposal))
            .filter(Boolean);

        if (resolvedChildren.length > 0) {
            resolvedChildren.forEach(feature => {
                const normalised = normaliseToFeature(feature, { source: 'road-child' });
                if (normalised) {
                    primaryFeatures.push(normalised);
                }
            });
        } else if (proposal.roadProposal.definition) {
            // If no child features, calculate road polygon from definition
            const definition = proposal.roadProposal.definition;
            const points = Array.isArray(definition.points) ? definition.points : null;
            const width = typeof definition.width === 'number' ? definition.width : parseFloat(definition.width);

            if (points && points.length >= 2 && Number.isFinite(width) && width > 0) {
                // Use the calculateRoadPolygon function from road-drawing.js if available
                let roadPolygon = null;

                // Try multiple ways to access the calculateRoadPolygon function
                if (typeof window !== 'undefined' && typeof window.calculateRoadPolygon === 'function') {
                    roadPolygon = window.calculateRoadPolygon(points, width);
                } else if (typeof calculateRoadPolygon === 'function') {
                    roadPolygon = calculateRoadPolygon(points, width);
                } else if (typeof ProposalManager !== 'undefined' && ProposalManager._calculateRoadPolygon && typeof ProposalManager._calculateRoadPolygon === 'function') {
                    // Fallback to ProposalManager's internal function
                    roadPolygon = ProposalManager._calculateRoadPolygon(points, width);
                } else if (typeof _calculateRoadPolygon === 'function') {
                    // Another fallback
                    roadPolygon = _calculateRoadPolygon(points, width);
                }

                if (roadPolygon && Array.isArray(roadPolygon)) {
                    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

                    const ensureClosedRing = (coords) => {
                        if (!Array.isArray(coords) || coords.length < 3) return null;
                        const first = coords[0];
                        const last = coords[coords.length - 1];
                        if (!first || !last) return null;
                        const closed = coords.slice();
                        if (first[0] !== last[0] || first[1] !== last[1]) {
                            closed.push([first[0], first[1]]);
                        }
                        return closed.length >= 4 ? closed : null;
                    };

                    const ringFromLatLngs = (ring) => {
                        const coords = (Array.isArray(ring) ? ring : [])
                            .map(pt => (isLatLng(pt) ? [pt.lng, pt.lat] : null))
                            .filter(Boolean);
                        return ensureClosedRing(coords);
                    };

                    const buildGeometry = (poly) => {
                        // LatLng[]
                        if (poly.length && isLatLng(poly[0])) {
                            const outer = ringFromLatLngs(poly);
                            return outer ? { type: 'Polygon', coordinates: [outer] } : null;
                        }
                        // LatLng[][] (polygon with holes)
                        if (poly.length && Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                            const rings = poly.map(ringFromLatLngs).filter(Boolean);
                            return rings.length ? { type: 'Polygon', coordinates: rings } : null;
                        }
                        // LatLng[][][] (multipolygon)
                        if (poly.length && Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                            const polys = poly
                                .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(ringFromLatLngs).filter(Boolean))
                                .filter(rings => rings.length > 0);
                            return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
                        }
                        return null;
                    };

                    const geometry = buildGeometry(roadPolygon);
                    if (geometry) {
                        const roadFeature = {
                            type: 'Feature',
                            geometry: geometry,
                            properties: {
                                isRoad: true,
                                isProposed: true,
                                proposalId: proposal.proposalId || null,
                                source: 'road-definition'
                            }
                        };

                        const normalised = normaliseToFeature(roadFeature, { source: 'road-definition' });
                        if (normalised) {
                            primaryFeatures.push(normalised);
                        }
                    }
                }
            }
        }
    }
    if (includeBuildingGeometry) {
        const addBuildingGeometry = (input) => {
            if (!input) return;
            if (Array.isArray(input)) {
                input.forEach(item => addBuildingGeometry(item));
                return;
            }
            if (input.type === 'FeatureCollection' && Array.isArray(input.features)) {
                input.features.forEach(f => addBuildingGeometry(f));
                return;
            }
            const buildingFeature = normaliseToFeature(input, { source: 'building' });
            if (buildingFeature) {
                primaryFeatures.push(buildingFeature);
            }
        };

        if (proposal?.geometry?.buildings && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length) {
            addBuildingGeometry(proposal.geometry.buildings);
        }
    }

    if (proposal?.structureProposal?.geometry) {
        const kind = (proposal.structureProposal.kind || '').toLowerCase();
        const structureFeature = normaliseToFeature(
            proposal.structureProposal.geometry,
            { source: `structure-${kind || 'generic'}` }
        );
        if (structureFeature) {
            primaryFeatures.push(structureFeature);
        }
    }

    if (Array.isArray(proposal?.reparcellization?.polygons)) {
        proposal.reparcellization.polygons.forEach(slice => {
            if (!slice || !slice.geometry) return;
            const featureInput = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                }
            };
            const reparcelFeature = normaliseToFeature(featureInput, { source: 'reparcellization-slice' });
            if (reparcelFeature) {
                reparcelFeature.properties = {
                    ...(reparcelFeature.properties || {}),
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                };
                primaryFeatures.push(reparcelFeature);
            }
        });
    }

    if (primaryFeatures.length === 0 && parcelFeatures.length > 0) {
        primaryFeatures.push(...parcelFeatures);
    }

    return {
        parcelFeatures,
        primaryFeatures,
        parcelIds: parcelIds.map(id => (id !== undefined && id !== null) ? id.toString() : null).filter(Boolean)
    };
}

function applyBlinkToLayerGroup(layerGroup, className) {
    if (!layerGroup || !className) return;
    if (typeof layerGroup.eachLayer !== 'function') return;

    layerGroup.eachLayer(layer => {
        if (layer && typeof layer.getElement === 'function') {
            const el = layer.getElement();
            if (el) {
                el.classList.remove(className);
                // Force reflow to restart animation
                // eslint-disable-next-line no-unused-expressions
                el.offsetWidth;
                el.classList.add(className);
            }
        }
    });
}

function addFeatureToGroup(feature, group, styleOptions, blinkClass) {
    if (!feature || !group) return null;
    try {
        const paneName = group.__paneName;
        const layer = L.geoJSON(feature, {
            pane: paneName || undefined,
            style: typeof styleOptions === 'function' ? styleOptions : () => ({ ...styleOptions }),
            interactive: false
        });
        layer.addTo(group);
        if (blinkClass) {
            requestAnimationFrame(() => applyBlinkToLayerGroup(layer, blinkClass));
        }
        return layer;
    } catch (error) {
        console.warn('addFeatureToGroup: unable to render feature', error);
        return null;
    }
}

function renderAppliedProposalHighlight(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.border) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    groups.border.clearLayers();

    if (!proposal) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    const { parcelFeatures, primaryFeatures, parcelIds } = collectProposalFeatureSets(proposal, { includeBuildingGeometry: false });

    // Check if this is a road proposal to style road geometry differently
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;

    // Check if this is a track proposal (has isTrack in metadata)
    const isTrack = isRoadProposal && (
        proposal?.roadProposal?.definition?.metadata?.isTrack === true ||
        proposal?.definition?.metadata?.isTrack === true
    );

    const lifecycleStatus = (proposal?.status || proposal?.roadProposal?.status || '').toLowerCase();
    const isAppliedTrack = lifecycleStatus === 'applied' || lifecycleStatus === 'executed';

    // Applied proposals should always be visible at all zoom levels, even when parcels are not shown
    // This allows users to see applied proposals regardless of zoom level

    // Parcels should be highlighted with blue fill like other proposals (parks, squares, etc.)
    // Solid border (not dashed) - only road geometry should be dashed
    const parcelStyle = {
        color: '#2563EB',
        fillColor: '#2563EB',
        weight: 3,
        opacity: 0.9,
        dashArray: null,
        fillOpacity: 0.2,
        className: 'proposal-parcel-outline'
    };

    // For track proposals, render with rails and sleepers instead of polygon
    if (isTrack) {
        // Extract track points and width from proposal definition
        const definition = proposal?.roadProposal?.definition || proposal?.definition;
        const trackPoints = Array.isArray(definition?.points) ? definition.points : null;
        const trackWidth = definition?.width;

        if (trackPoints && trackPoints.length >= 2) {
            // Convert points to L.latLng format if needed
            // Points can be stored as L.latLng objects, {lat, lng} objects, or [lat, lng] arrays
            const normalizedPoints = trackPoints.map(p => {
                // If already a L.latLng object
                if (p && typeof p.lat === 'function' && typeof p.lng === 'function') {
                    return p;
                }
                // If it's an object with lat/lng properties
                if (p && typeof p === 'object' && 'lat' in p && 'lng' in p) {
                    return L.latLng(Number(p.lat), Number(p.lng));
                }
                // If it's an array [lat, lng] or [lng, lat]
                if (Array.isArray(p) && p.length >= 2) {
                    const val1 = Number(p[0]);
                    const val2 = Number(p[1]);
                    // If first value is between -90 and 90, it's likely lat
                    if (Math.abs(val1) <= 90 && Math.abs(val2) <= 180) {
                        return L.latLng(val1, val2);
                    } else {
                        return L.latLng(val2, val1);
                    }
                }
                return null;
            }).filter(Boolean);

            if (normalizedPoints.length >= 2) {
                // Render track with distinct styling depending on whether it is applied
                // Check if renderTrackWithRails is available
                const renderFn = typeof renderTrackWithRails === 'function'
                    ? renderTrackWithRails
                    : (typeof window !== 'undefined' && typeof window.renderTrackWithRails === 'function')
                        ? window.renderTrackWithRails
                        : null;

                if (renderFn) {
                    const railColor = isAppliedTrack ? '#000000' : '#FF8A00';
                    const sleeperColor = isAppliedTrack ? '#000000' : '#FFC266';
                    const trackRailsLayer = renderFn(normalizedPoints, false, {
                        railColor,
                        sleeperColor,
                        trackWidth: trackWidth,
                        pane: groups.border?.__paneName || (window.__proposalHighlightPanes && window.__proposalHighlightPanes.highlight) || undefined
                    });
                    if (trackRailsLayer) {
                        trackRailsLayer.addTo(groups.border);
                    }
                }
            }
        }

        // Always render parcel outlines for applied proposals at all zoom levels
        parcelFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.border, parcelStyle, blink ? 'proposal-blink-twice' : null);
        });
    } else {
        // For road proposals, style road geometry with dashed lines and no fill
        // For other proposals, use the standard primary style
        const primaryStyle = isRoadProposal ? {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: '10 5',
            fillOpacity: 0,
            className: 'proposal-road-outline'
        } : {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: null,
            fillOpacity: 0.2,
            className: 'proposal-primary-outline'
        };

        // Always render parcel outlines for applied proposals at all zoom levels
        parcelFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.border, parcelStyle, blink ? 'proposal-blink-twice' : null);
        });

        // Always show primary features for applied proposals at all zoom levels
        primaryFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.border, primaryStyle, blink ? 'proposal-blink-twice' : null);
        });
    }

    if (groups.border.bringToFront) {
        groups.border.bringToFront();
    }

    return {
        activeIds: new Set(parcelIds),
        primaryFeatures
    };
}

function renderPreviewOverlay(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.preview) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    groups.preview.clearLayers();

    if (!proposal) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    const { parcelFeatures, primaryFeatures } = collectProposalFeatureSets(proposal);
    const hasPrimary = primaryFeatures.length > 0;

    // Check if this is a road proposal to style road geometry differently
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;

    // CRITICAL: Check zoom level before rendering parcel features
    // When zoomed out (below parcel display threshold), we should NOT render individual parcel outlines
    const isZoomWithinRange = (typeof window !== 'undefined' && typeof window.isZoomWithinParcelRange === 'function')
        ? window.isZoomWithinParcelRange()
        : (typeof map !== 'undefined' && map ? map.getZoom() >= 17 : true);

    const parcelStyle = {
        color: '#2563EB',
        weight: 3,
        opacity: 1,
        dashArray: '4 6',
        fillOpacity: 0,
        className: 'proposal-preview-parcel'
    };

    // For road proposals, style road geometry with dashed lines and no fill
    // For other proposals, use the standard primary style
    const primaryStyle = isRoadProposal ? {
        color: '#2563EB',
        weight: 4,
        opacity: 0.95,
        dashArray: '10 5',
        fillOpacity: 0,
        className: 'proposal-preview-road-outline'
    } : {
        color: '#8E24AA',
        weight: 4,
        opacity: 0.95,
        dashArray: '2 8',
        fillOpacity: 0.25,
        className: 'proposal-preview-outline'
    };

    // Only render parcel outlines if zoom is within parcel display range
    if (isZoomWithinRange) {
        parcelFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, parcelStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    // For road proposals, always show the road geometry (primaryFeatures) even when zoomed out
    // For non-road proposals without primary features, show parcel outlines if zoom is appropriate
    const featuresToDraw = hasPrimary ? primaryFeatures : (isZoomWithinRange ? parcelFeatures : []);

    if (isRoadProposal || isZoomWithinRange) {
        featuresToDraw.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, primaryStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    if (groups.preview.bringToFront) {
        groups.preview.bringToFront();
    }

    return { parcelFeatures, primaryFeatures };
}

function clearProposalPreview() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) {
        groups.preview.clearLayers();
    }
    currentProposalPreviewId = null;
}

function getFirstSelectableParcel(proposal) {
    if (!proposal || !Array.isArray(proposal.parentParcelIds)) {
        return null;
    }

    for (const parcelId of proposal.parentParcelIds) {
        try {
            const layer = multiParcelSelection.findParcelById(parcelId);
            if (layer) {
                return parcelId;
            }
        } catch (_) {
            // Ignore lookup issues and continue searching
        }
    }

    return proposal.parentParcelIds.length > 0 ? proposal.parentParcelIds[0] : null;
}

function previewProposalOnMap(proposalIdOrHash, { center = true, blink = true } = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return;
    }

    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        return;
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);
    currentProposalPreviewId = proposalKey;

    const { parcelFeatures, primaryFeatures } = renderPreviewOverlay(proposal, { blink });

    if (!center || typeof map === 'undefined' || !map) {
        return;
    }

    const featuresForBounds = primaryFeatures.length > 0 ? primaryFeatures : parcelFeatures;
    let bounds = computeBoundsFromFeatures(featuresForBounds);

    if (!bounds && Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0) {
        const calculated = calculateProposalBounds(proposal.parentParcelIds, { proposal });
        if (calculated && calculated.north !== undefined && calculated.west !== undefined) {
            try {
                bounds = L.latLngBounds(
                    [calculated.south, calculated.west],
                    [calculated.north, calculated.east]
                );
            } catch (_) {
                bounds = null;
            }
        }
    }

    if (bounds && bounds.isValid && bounds.isValid()) {
        // Suppress parcel fetching when showing proposal contours
        try { window.suppressCameraMoves = true; } catch (_) { }

        // Hide parcel layer if zoomed out too far (to prevent showing all parcels in memory)
        const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
        const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
        if (parcelLayer && wasParcelLayerVisible) {
            try { map.removeLayer(parcelLayer); } catch (_) { }
        }

        map.fitBounds(bounds.pad(0.08), { maxZoom: 19 });

        // Re-enable after map movement completes
        const onMoveEnd = () => {
            map.off('moveend', onMoveEnd);
            try { window.suppressCameraMoves = false; } catch (_) { }

            // Restore parcel layer only if zoom is appropriate
            const finalZoom = map.getZoom();
            const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                ? isZoomWithinParcelRange()
                : finalZoom >= 15; // Default threshold

            if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                try {
                    if (!map.hasLayer(parcelLayer)) {
                        parcelLayer.addTo(map);
                    }
                } catch (_) { }
            }
        };
        map.on('moveend', onMoveEnd);
    } else if (proposal.bounds && proposal.bounds.center) {
        const { lat, lng } = proposal.bounds.center;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Suppress parcel fetching when showing proposal contours
            try { window.suppressCameraMoves = true; } catch (_) { }

            // Hide parcel layer if zoomed out too far
            const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
            const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
            if (parcelLayer && wasParcelLayerVisible) {
                try { map.removeLayer(parcelLayer); } catch (_) { }
            }

            map.setView([lat, lng], map.getZoom());

            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd);
                try { window.suppressCameraMoves = false; } catch (_) { }

                // Restore parcel layer only if zoom is appropriate
                const finalZoom = map.getZoom();
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : finalZoom >= 15;

                if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                    try {
                        if (!map.hasLayer(parcelLayer)) {
                            parcelLayer.addTo(map);
                        }
                    } catch (_) { }
                }
            };
            map.on('moveend', onMoveEnd);
        }
    }
}

function getFeatureByParcelId(features, parcelId) {
    if (!Array.isArray(features) || !parcelId) return null;
    const target = parcelId.toString();
    return features.find(f => {
        const id = getParcelIdFromFeature(f);
        return id && id.toString() === target;
    }) || null;
}

function computeBoundsFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0 || typeof L === 'undefined') {
        return null;
    }
    try {
        const combined = L.featureGroup(features.map(f => L.geoJSON(f)));
        const bounds = combined.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds;
        }
    } catch (error) {
        console.warn('computeBoundsFromFeatures failed', error);
    }
    return null;
}
// Multi-parcel selection state
function syncMultiSelectCheckboxes(isChecked) {
    const checkboxIds = ['multiSelectCheckbox', 'multiSelectCheckboxInfo'];
    checkboxIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.checked = !!isChecked;
        }
    });
}

const multiParcelSelection = {
    isActive: false,
    selectedParcels: new Set(),
    syntheticParcelLayers: new Map(),
    syntheticLayerGroup: null,
    lastSelectedParcelId: null,
    parcelIdIndex: new Map(),
    parcelIdIndexSize: 0,

    // Toggle multi-selection mode
    toggle(options = {}) {
        const preserveSelectedParcel = !!options.preserveSelectedParcel;
        const restoreSingleSelection = options.restoreSingleSelection !== false;
        const wasActive = this.isActive;
        this.isActive = !this.isActive;

        if (wasActive && !this.isActive) {
            const fallbackParcelId = this.lastSelectedParcelId ||
                (this.selectedParcels.size > 0 ? Array.from(this.selectedParcels).slice(-1)[0] : null) ||
                (typeof selectedParcelId !== 'undefined' && selectedParcelId ? selectedParcelId.toString() : null);

            this.clearSelection();
            if (restoreSingleSelection) {

                if (fallbackParcelId && typeof selectParcel === 'function') {
                    try {
                        selectParcel(fallbackParcelId, true);
                    } catch (error) {
                        console.warn('multiParcelSelection.toggle: failed to reselect fallback parcel', error);
                        this.hideParcelInfo();
                    }
                } else {
                    this.hideParcelInfo();
                }
            }
        } else if (!wasActive && this.isActive) {
            const hasCurrentParcel = typeof currentParcel !== 'undefined' && currentParcel && currentParcel.id;
            const fallbackParcelId = !hasCurrentParcel && typeof selectedParcelId !== 'undefined' && selectedParcelId
                ? selectedParcelId.toString()
                : null;
            const preservedParcelInfo = (preserveSelectedParcel && (hasCurrentParcel || fallbackParcelId))
                ? {
                    id: hasCurrentParcel ? currentParcel.id.toString() : fallbackParcelId,
                    layer: hasCurrentParcel
                        ? (currentParcel.layer || this.findParcelById(currentParcel.id))
                        : this.findParcelById(fallbackParcelId)
                }
                : null;

            // Always seed multi-select with the currently viewed parcel (or the last single selection)
            let seedInfo = preservedParcelInfo;
            if (!seedInfo) {
                const seedId = hasCurrentParcel
                    ? currentParcel.id.toString()
                    : (fallbackParcelId || null);
                if (seedId) {
                    const seedLayer = hasCurrentParcel
                        ? (currentParcel.layer || this.findParcelById(seedId))
                        : this.findParcelById(seedId);
                    if (seedLayer) {
                        seedInfo = { id: seedId, layer: seedLayer };
                    }
                }
            }

            this.selectedParcels.clear();

            if (seedInfo && seedInfo.id) {
                this.clearSingleParcelSelection({ preservePanel: true });
                this.selectedParcels.add(seedInfo.id);
                this.lastSelectedParcelId = seedInfo.id;
                const targetLayer = seedInfo.layer || this.findParcelById(seedInfo.id);
                if (targetLayer) {
                    this.addParcelHighlight(targetLayer);
                }
            } else {
                this.clearSingleParcelSelection();
            }
        }

        this.updateUI();
    },

    // Clear any currently selected single parcel
    clearSingleParcelSelection(options = {}) {
        const preservePanel = !!options.preservePanel;
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layer.feature && layer.feature.properties &&
                    layerId && layerId.toString() === selectedParcelId) {

                    // Reset style
                    const parcelIdValue = layerId;
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(parcelIdValue)
                        : (() => {
                            const isRoad = (typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelIdValue) : false;
                            const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                            const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                            return isRoad ? globalRoadStyle : globalNormalStyle;
                        })();
                    layer.setStyle(baseStyle);

                    // ALWAYS use the authoritative function to re-attach the click handler
                    layer.off('click').on('click', getCorrectClickHandler());
                }
            });

            // Clear the global selected parcel state
            window.selectedParcelId = null;
            if (typeof currentParcel !== 'undefined') {
                window.currentParcel = null;
            }

            // Hide single parcel info panel if it's showing and showing parcel info
            const parcelInfoPanel = document.getElementById('parcel-info-panel');
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (!preservePanel && parcelInfoPanel && parcelInfoPanel.classList.contains('visible') &&
                panelTitle && panelTitle.textContent.trim().startsWith('Parcel')) {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                }
            }
        }
    },

    // Add or remove parcel from selection
    toggleParcel(parcel) {
        if (!this.isActive) return false;

        const parcelId = getParcelIdFromFeature(parcel.feature)?.toString();
        if (!parcelId) return false;

        if (this.selectedParcels.has(parcelId)) {
            this.selectedParcels.delete(parcelId);
            this.removeParcelHighlight(parcel);
            if (this.lastSelectedParcelId === parcelId) {
                this.lastSelectedParcelId = this.selectedParcels.size > 0
                    ? Array.from(this.selectedParcels).slice(-1)[0]
                    : null;
            }
        } else {
            this.selectedParcels.add(parcelId);
            this.lastSelectedParcelId = parcelId;
            this.addParcelHighlight(parcel);
        }

        this.updateUI();
        return true;
    },

    // Clear all selected parcels
    clearSelection() {
        // Remove highlights from all selected parcels
        this.selectedParcels.forEach(parcelId => {
            const parcel = this.findParcelById(parcelId);
            if (parcel) {
                this.removeParcelHighlight(parcel);
            }
        });
        this.selectedParcels.clear();
        this.lastSelectedParcelId = null;

        // Also clear any currently selected single parcel to avoid conflicts
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layer.feature && layer.feature.properties && layerId && layerId.toString() === selectedParcelId) {
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(selectedParcelId)
                        : (() => {
                            const isRoad = (typeof window.isRoadParcel === 'function') ? window.isRoadParcel(selectedParcelId) : false;
                            const globalRoadStyle = window.roadStyle || {
                                fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                            };
                            const globalNormalStyle = window.normalStyle || {
                                fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                            };
                            return isRoad ? globalRoadStyle : globalNormalStyle;
                        })();
                    layer.setStyle(baseStyle);
                }
            });
            window.selectedParcelId = null;
        }

        this.updateUI();
    },

    getSyntheticLayerGroup() {
        if (this.syntheticLayerGroup && typeof map !== 'undefined' && map && map.hasLayer(this.syntheticLayerGroup)) {
            return this.syntheticLayerGroup;
        }

        if (!this.syntheticLayerGroup) {
            this.syntheticLayerGroup = L.featureGroup();
        }

        if (typeof map !== 'undefined' && map && !map.hasLayer(this.syntheticLayerGroup)) {
            this.syntheticLayerGroup.addTo(map);
        }

        return this.syntheticLayerGroup;
    },

    // Find parcel layer by ID with fallback to cache
    findParcelById(parcelId) {
        if (parcelId === undefined || parcelId === null) return null;
        const targetId = parcelId.toString();
        if (!targetId) return null;

        if (this.syntheticParcelLayers.has(targetId)) {
            const syntheticLayer = this.syntheticParcelLayers.get(targetId);
            if (syntheticLayer) {
                return syntheticLayer;
            } else {
                this.syntheticParcelLayers.delete(targetId);
            }
        }

        let foundParcel = null;

        // Ensure the parcel layer is initialized/attached before trying to index
        if ((typeof parcelLayer === 'undefined' || !parcelLayer) && typeof ensureParcelLayerInitialized === 'function') {
            ensureParcelLayerInitialized();
        }
        if ((typeof parcelLayer === 'undefined' || !parcelLayer) && typeof addParcelLayerToMapIfAppropriate === 'function') {
            addParcelLayerToMapIfAppropriate();
        }

        // Keep an index of parcelId -> layer for O(1) lookups
        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            const currentLayerCount = typeof parcelLayer.getLayers === 'function'
                ? parcelLayer.getLayers().length
                : 0;
            const indexStale = this.parcelIdIndexSize !== currentLayerCount || currentLayerCount === 0;
            if (indexStale) {
                this.parcelIdIndex.clear();
                parcelLayer.eachLayer(layer => {
                    const layerId = getParcelIdFromFeature(layer.feature);
                    if (layerId !== undefined && layerId !== null) {
                        this.parcelIdIndex.set(layerId.toString(), layer);
                    }
                });
                this.parcelIdIndexSize = currentLayerCount;
            }

            if (this.parcelIdIndex.has(targetId)) {
                foundParcel = this.parcelIdIndex.get(targetId) || null;
            }
        } else {
            console.warn('findParcelById: parcelLayer not available (initialization pending)');
        }

        // If not found in parcelLayer, try to recover from cache
        if (!foundParcel && typeof parcelCache !== 'undefined') {
            foundParcel = this.recoverParcelFromCache(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        // Final fallback: try PersistentStorage
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromPersistentStorage(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        // Try to recover from proposal data (unapplied descendants)
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromProposals(targetId);
            if (foundParcel) {
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        if (!foundParcel) {
            // Only escalate when there is no known way to recover the parcel.
            const hasFetchers = typeof fetchSingleParcelById === 'function' || typeof fetchParcelsForIds === 'function';
            if (!hasFetchers) {
                console.error('findParcelById: Could not find parcel with ID:', parcelId, 'and no fetcher is available');
            } else {
                // Expected when hydration/fetch will run later (e.g., showProposalInfo).
                console.debug('findParcelById: Parcel missing for now, awaiting hydration for ID:', parcelId);
            }
        }

        return foundParcel;
    },

    // Recover parcel from grid cache and instantiate as layer
    recoverParcelFromCache(parcelId) {
        // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
            return null;
        }

        if (!parcelCache || !parcelCache.grid) return null;

        // Search all grid cells for the parcel
        for (const [gridKey, cellData] of parcelCache.grid) {
            if (cellData && cellData.features) {
                const feature = cellData.features.find(f =>
                    getParcelIdFromFeature(f)?.toString() === parcelId.toString()
                );

                if (feature) {
                    return this.createParcelLayerFromFeature(feature);
                }
            }
        }
        return null;
    },

    // Recover parcel from PersistentStorage and instantiate as layer
    recoverParcelFromPersistentStorage(parcelId) {
        // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
            return null;
        }

        const record = typeof readPersistedParcelRecord === 'function'
            ? readPersistedParcelRecord(parcelId)
            : null;

        if (record && record.geometry && record.properties) {
            try {
                const rawGeometry = record.geometry;
                const properties = record.properties;

                const geometry = (rawGeometry && typeof rawGeometry === 'object' && rawGeometry.type && rawGeometry.coordinates)
                    ? JSON.parse(JSON.stringify(rawGeometry))
                    : null;

                if (!geometry) return null;

                const feature = ensureParcelIdOnFeature({
                    type: 'Feature',
                    properties: properties && typeof properties === 'object' ? { ...properties } : {},
                    geometry
                });

                if (!feature || !feature.properties) {
                    return null;
                }

                // Ensure calculatedArea is set when possible, but don't fail if unavailable
                if (feature.properties.calculatedArea === undefined || feature.properties.calculatedArea === null) {
                    if (typeof calculateArea === 'function') {
                        try {
                            feature.properties.calculatedArea = calculateArea([geometry]);
                        } catch (_) {
                            // Ignore area calculation failure; allow layer creation to proceed
                        }
                    }
                }

                return this.createParcelLayerFromFeature(feature);
            } catch (e) {
                console.error(`Error reconstructing parcel ${parcelId} from PersistentStorage:`, e);
            }
        }
        return null;
    },

    recoverParcelFromProposals(parcelId) {
        // Guard against infinite recursion
        if (this._recoveringParcels && this._recoveringParcels.has(parcelId.toString())) {
            return null;
        }
        if (!this._recoveringParcels) {
            this._recoveringParcels = new Set();
        }
        this._recoveringParcels.add(parcelId.toString());

        try {
            // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
                return null;
            }

            if (typeof proposalStorage === 'undefined' || !proposalStorage.getAllProposals) {
                return null;
            }

            const proposals = proposalStorage.getAllProposals();
            if (!Array.isArray(proposals) || proposals.length === 0) {
                return null;
            }

            const targetId = parcelId.toString();

            for (const proposal of proposals) {
                if (!proposal || normalizeProposalGoalKey(proposal.goal) !== 'road-track') continue;
                const roadProposal = proposal.roadProposal;
                if (!roadProposal) continue;

                const parentIds = ensureArrayOfStrings(roadProposal.parentParcelIds || proposal.parentParcelIds || proposal.parentParcelIds || []);
                const childIds = ensureArrayOfStrings(roadProposal.childParcelIds || []);

                const isParent = parentIds.includes(targetId);
                const isChild = childIds.includes(targetId);

                if (!isParent && !isChild) continue;

                // Skip recovery to prevent infinite recursion (we're already in recoverParcelFromProposals)
                const candidateFeature = getParcelFeatureForHighlight(targetId, proposal, { skipRecovery: true });
                if (!candidateFeature) continue;

                try {
                    const featureClone = JSON.parse(JSON.stringify(candidateFeature));
                    const layer = this.createParcelLayerFromFeature(featureClone, {
                        addToParcelLayer: false,
                        makeInteractive: false
                    });

                    if (!layer) {
                        continue;
                    }

                    layer._isSynthetic = true;
                    const group = this.getSyntheticLayerGroup();
                    if (group) {
                        group.addLayer(layer);
                    } else if (typeof map !== 'undefined' && map) {
                        layer.addTo(map);
                    }
                    this.syntheticParcelLayers.set(targetId, layer);
                    return layer;
                } catch (error) {
                    console.error('recoverParcelFromProposals: unable to instantiate feature', error);
                }
            }

            return null;
        } finally {
            // Always remove from recovering set, even if we return early
            if (this._recoveringParcels) {
                this._recoveringParcels.delete(parcelId.toString());
            }
        }
    },

    // Create a Leaflet layer from a feature and add it to parcelLayer
    createParcelLayerFromFeature(feature, options = {}) {
        if (!feature || !feature.geometry || !feature.properties) {
            console.error('createParcelLayerFromFeature: Invalid feature provided');
            return null;
        }

        const { addToParcelLayer = true, makeInteractive = true } = options;

        const normalizedFeature = ensureParcelIdOnFeature(feature);

        // Don't add parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        const parcelId = getParcelIdFromFeature(normalizedFeature);
        const persistedRecord = parcelId ? readPersistedParcelRecord(parcelId) : null;
        if (addToParcelLayer && parcelId) {
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
                // Return null to prevent re-adding a removed parcel
                return null;
            }
        }

        try {
            // Convert coordinates if needed (same logic as in fetchParcelData)
            let convertedFeature = normalizedFeature;
            if (typeof convertGeoJSON === 'function') {
                const featureCollection = {
                    type: 'FeatureCollection',
                    features: [normalizedFeature]
                };
                const converted = convertGeoJSON(featureCollection);
                convertedFeature = converted.features[0];
            }

            // Create the Leaflet layer
            const layer = L.geoJSON(convertedFeature, {
                style: (feature) => {
                    const parcelId = getParcelIdFromFeature(feature);
                    const storedRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                    const propertyRoad = feature?.properties?.isRoad === true;
                    const isRoad = storedRoad || propertyRoad;
                    // Use global styles if available
                    const roadStyleToUse = typeof roadStyle !== 'undefined' ? roadStyle : {
                        fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                    };
                    const normalStyleToUse = typeof normalStyle !== 'undefined' ? normalStyle : {
                        fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                    };
                    return isRoad ? roadStyleToUse : normalStyleToUse;
                },
                onEachFeature: function (feature, layer) {
                    if (makeInteractive && typeof onParcelClick === 'function') {
                        layer.on({
                            mouseover: typeof highlightFeature === 'function' ? highlightFeature : () => { },
                            mouseout: typeof resetHighlight === 'function' ? resetHighlight : () => { },
                            click: onParcelClick
                        });
                    }
                }
            });

            // Extract the actual parcel layer (geoJSON creates a layer group)
            let parcelLayerInstance = null;
            layer.eachLayer(l => {
                if (!parcelLayerInstance) parcelLayerInstance = l;
            });

            if (parcelLayerInstance) {
                // Add road properties if applicable
                const parcelId = getParcelIdFromFeature(feature);
                const storedRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                const persistedProps = persistedRecord?.properties || {};
                const propertyRoad = parcelLayerInstance?.feature?.properties?.isRoad === true
                    || feature?.properties?.isRoad === true
                    || persistedProps.isRoad === true;
                const isRoad = storedRoad || propertyRoad;
                parcelLayerInstance.feature.properties.isRoad = !!isRoad;
                if (isRoad) {
                    const roadName = feature?.properties?.roadName
                        || persistedProps.roadName
                        || 'Unnamed Road';
                    parcelLayerInstance.bindTooltip(roadName, {
                        permanent: false,
                        direction: 'center',
                        className: 'road-name-tooltip'
                    });
                    parcelLayerInstance.feature.properties.roadName = roadName;
                    parcelLayerInstance.feature.properties.roadId = feature?.properties?.roadId
                        || persistedProps.roadId
                        || '';
                    parcelLayerInstance.feature.properties.roadConfidence = feature?.properties?.roadConfidence
                        || persistedProps.roadConfidence
                        || '0';
                }

                // Add to parcelLayer if it exists
                if (addToParcelLayer && typeof parcelLayer !== 'undefined' && parcelLayer) {
                    parcelLayer.addLayer(parcelLayerInstance);
                    if (typeof window.indexParcelLayer === 'function') {
                        window.indexParcelLayer(parcelLayerInstance);
                    }
                    // Don't add directly to map - layers in parcelLayer are automatically rendered
                    // when parcelLayer is on the map. Adding directly causes double rendering.
                }

                // Validate that the layer has getBounds before returning
                if (typeof parcelLayerInstance.getBounds === 'function') {
                    return parcelLayerInstance;
                } else {
                    console.error('createParcelLayerFromFeature: Created layer does not have getBounds method');
                    return null;
                }
            }
        } catch (e) {
            console.error('Error creating parcel layer from feature:', e);
        }

        return null;
    },

    // Add highlight to selected parcel
    addParcelHighlight(parcel) {
        // Apply multi-selection style (matches .parcel-layer.multi-selected CSS)
        parcel.setStyle({
            fillColor: '#ff9800',
            fillOpacity: 0.6,
            color: '#f57c00',
            weight: 3
        });
        parcel.bringToFront();
    },

    // Remove highlight from parcel
    removeParcelHighlight(parcel) {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        const baseStyle = (typeof getParcelBaseStyle === 'function')
            ? getParcelBaseStyle(parcelId)
            : (() => {
                const isRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                const globalRoadStyle = window.roadStyle || {
                    fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                };
                const globalNormalStyle = window.normalStyle || {
                    fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                };
                return isRoad ? globalRoadStyle : globalNormalStyle;
            })();
        parcel.setStyle(baseStyle);
    },

    // Get selected parcels as array
    getSelectedParcels() {
        const parcels = Array.from(this.selectedParcels).map(id => this.findParcelById(id)).filter(p => p);
        console.debug('getSelectedParcels called, selectedParcels size:', this.selectedParcels.size, 'found parcels:', parcels.length);
        return parcels;
    },

    // Update UI based on current selection
    updateUI() {
        syncMultiSelectCheckboxes(this.isActive);

        // Hide single-parcel proposal button when multi-select is active
        const singleParcelButton = document.getElementById('createProposalFromParcelButton');
        if (singleParcelButton) {
            if (this.isActive) {
                singleParcelButton.style.display = 'none';
            }
            // When multi-select is off, the button visibility is controlled by single parcel selection
        }

        const count = this.selectedParcels.size;
        if (count >= 2) {
            this.showMultiParcelInfo();
        } else if (count === 1 && this.isActive) {
            // Show single parcel info even in multi-select mode
            const parcels = this.getSelectedParcels();
            if (parcels.length === 1) {
                const parcel = parcels[0];
                if (typeof showParcelInfoPanel === 'function') {
                    // Ensure parcel-specific buttons are visible for single parcel view
                    const parcelButtons = document.querySelector('.parcel-info-buttons');
                    if (parcelButtons) {
                        parcelButtons.style.display = '';
                    }

                    // Ensure road checkbox is visible for single parcel view
                    const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
                    if (roadCheckboxGroup) {
                        roadCheckboxGroup.style.display = '';
                    }

                    // Clear all tab content
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';

                    showParcelInfoPanel(parcel.feature);
                    document.getElementById('parcel-info-panel').classList.add('visible');
                    setParcelInfoPanelTitle(
                        window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
                        { i18nKey: 'panel.parcel.multiSelectionTitle' }
                    );
                }
            }
        } else if (count === 0 && this.isActive) {
            this.hideParcelInfo();
        } else if (!this.isActive && count === 0) {
            // Multi-select is off and no selection - hide panel
            this.hideParcelInfo();
        }

        // Update create proposal button visibility
        this.updateCreateProposalButton();

        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions();
        }

        if (this.isActive) {
            const panel = document.getElementById('parcel-info-panel');
            if (panel && panel.classList.contains('visible')) {
                setParcelInfoPanelTitle(
                    window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
                    { i18nKey: 'panel.parcel.multiSelectionTitle' }
                );
            }

            if (typeof window !== 'undefined' && window.ParcelsUIClaim && typeof window.ParcelsUIClaim.setParcelClaimButtonsState === 'function') {
                window.ParcelsUIClaim.setParcelClaimButtonsState('not-minted');
            }
        }
    },

    // Show multi-parcel info panel
    showMultiParcelInfo() {
        const parcels = this.getSelectedParcels();
        const avgSqmPrice = (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);

        const parcelSummaries = parcels.map(parcel => {
            const props = parcel?.feature?.properties || {};
            const areaSource = props.calculatedArea
                || props.area
                || props.parcelArea
                || props.informationTechnical?.superficie_total;
            const area = Number.isFinite(Number(areaSource)) ? Number(areaSource) : 0;
            const explicitPrice = Number(props.estimatedMarketPrice);
            const price = Number.isFinite(explicitPrice) ? explicitPrice : (area ? area * avgSqmPrice : 0);
            const currency = props.estimatedMarketPriceCurrency || props.currency || 'EUR';
            return { parcel, area, price, currency };
        });

        const totalArea = parcelSummaries.reduce((sum, p) => sum + (p.area || 0), 0);
        const totalEstimatedPrice = parcelSummaries.reduce((sum, p) => sum + (p.price || 0), 0);

        // Calculate total owners across all parcels
        let totalOwners = 0;
        const ownerKeys = new Set();
        if (typeof getParcelOwnerSlots === 'function') {
            for (const parcel of parcels) {
                const parcelId = getParcelIdFromFeature(parcel?.feature);
                if (parcelId) {
                    try {
                        const slots = getParcelOwnerSlots(parcelId.toString());
                        if (Array.isArray(slots) && slots.length > 0) {
                            slots.forEach(slot => {
                                const key = slot.key || slot.displayName || `parcel:${parcelId}:${slot.displayName || 'owner'}`;
                                if (key && !ownerKeys.has(key)) {
                                    ownerKeys.add(key);
                                    totalOwners++;
                                }
                            });
                        } else {
                            // If no slots found, count as 1 owner per parcel
                            const fallbackKey = `parcel:${parcelId}:fallback`;
                            if (!ownerKeys.has(fallbackKey)) {
                                ownerKeys.add(fallbackKey);
                                totalOwners++;
                            }
                        }
                    } catch (error) {
                        // If owner slots can't be retrieved, count as 1 owner per parcel
                        const fallbackKey = `parcel:${parcelId}:error`;
                        if (!ownerKeys.has(fallbackKey)) {
                            ownerKeys.add(fallbackKey);
                            totalOwners++;
                        }
                    }
                }
            }
        }
        // Fallback: if we couldn't calculate, use parcel count as estimate
        if (totalOwners === 0) {
            totalOwners = parcels.length;
        }

        setParcelInfoPanelTitle(
            window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
            { i18nKey: 'panel.parcel.multiSelectionTitle' }
        );

        // Keep parcel tools visible so multi-select mint remains accessible
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = '';
        }

        // Hide road checkbox section
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = 'none';
        }

        // Clear the regular info content and use parcel-info-content for multi-parcel display
        document.getElementById('info-content').innerHTML = '';

        const content = `
            <div class="multi-parcel-actions" style="margin-bottom: 15px; text-align: center;">
                <button class="btn btn-secondary" onclick="cancelMultiParcelSelection()" style="padding: 8px 16px;"
                    data-i18n-key="panel.parcel.multi.cancelSelection">
                    ${tParcelMulti('panel.parcel.multi.cancelSelection', {}, 'Cancel Selection')}
                </button>
            </div>
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.selectedParcels">${tParcelMulti('panel.parcel.multi.selectedParcels', {}, 'Selected Parcels:')}</div>
                    <div class="metric-value">${parcels.length}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.totalArea">${tParcelMulti('panel.parcel.multi.totalArea', {}, 'Total Area:')}</div>
                    <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.estValue">${tParcelMulti('panel.parcel.multi.estValue', {}, 'Est. Val.:')}</div>
                    <div class="metric-value">${Math.round(totalEstimatedPrice).toLocaleString('hr-HR')}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.totalOwners">${tParcelMulti('panel.parcel.multi.totalOwners', {}, 'Total owners:')}</div>
                    <div class="metric-value">${totalOwners}</div>
                </div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="selected-parcels-section">
                <div class="metric-label" data-i18n-key="panel.parcel.multi.selectedParcelsHeading">${tParcelMulti('panel.parcel.multi.selectedParcelsHeading', {}, 'Selected Parcels:')}</div>
                <div class="selected-parcels-list">
                        ${parcelSummaries.map(({ parcel, area, price, currency }) => {
            const parcelId = getParcelIdFromFeature(parcel?.feature);
            const isRoad = parcelId && typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
            const parcelNumberDisplay = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId);
            const parcelLabel = tParcelMulti('panel.parcel.multi.parcelLabel', { number: parcelNumberDisplay || parcelId }, `Parcel ${parcelNumberDisplay || parcelId}`);
            const roadLabel = tParcelMulti('panel.parcel.multi.roadTag', {}, 'Road');
            const currencyLabel = currency === 'EUR' ? '€' : currency || '';
            return `
                            <div class="selected-parcel-item">
                                <div class="parcel-number">${parcelLabel}</div>
                                <div class="parcel-details">
                                            ${Math.round(area).toLocaleString('hr-HR')} m² • 
                                            ${Math.round(price).toLocaleString('hr-HR')} ${currencyLabel}
                                    ${isRoad ? ` • <span style="color: #28a745;">${roadLabel}</span>` : ''}
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;

        // Show multi-parcel content in the Info tab
        document.getElementById('info-content').innerHTML = content;

        const proposalsContent = `
            <div class="metric-group multi-parcel-proposal-hint">
                <div class="metric-value" data-i18n-key="panel.parcel.multi.proposalsHint">${tParcelMulti('panel.parcel.multi.proposalsHint', {}, 'Create a proposal that includes all the selected parcels.')}</div>
            </div>
            <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
        `;
        document.getElementById('proposals-content').innerHTML = proposalsContent;
        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions();
        }

        const infoPanelEl = document.getElementById('parcel-info-panel');
        if (infoPanelEl) {
            infoPanelEl.classList.add('visible');
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                try {
                    window.i18n.applyTranslations(infoPanelEl);
                } catch (_) { /* ignore */ }
            }
        }
    },

    // Hide parcel info panel
    hideParcelInfo() {
        // Reset the panel title back to original
        const panelTitle = document.querySelector('#parcel-info-panel h3');
        if (panelTitle) {
            panelTitle.textContent = 'Parcel';
        }

        // Show parcel-specific buttons again (they might have been hidden for proposal view)
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = '';
        }

        // Show road checkbox section again
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = '';
        }

        // Clear all tab content areas
        const infoContent = document.getElementById('info-content');
        const proposalsContent = document.getElementById('proposals-content');

        if (infoContent) infoContent.innerHTML = '';
        if (proposalsContent) proposalsContent.innerHTML = '';

        document.getElementById('parcel-info-panel').classList.remove('visible');

        // Clear any proposal highlights
        clearProposalHighlights();
    },

    // Update create proposal button visibility
    updateCreateProposalButton() {
        const button = document.getElementById('createProposalButton');
        if (button) {
            // Show button if we have multiple parcels selected OR a single parcel selected
            const hasMultipleParcels = this.selectedParcels.size > 0;
            const hasSingleParcel = typeof selectedParcelId !== 'undefined' && selectedParcelId &&
                typeof currentParcel !== 'undefined' && currentParcel;
            button.style.display = (hasMultipleParcels || hasSingleParcel) ? 'inline-block' : 'none';
        }
    },

    // Reapply highlights to all currently selected parcels
    reapplyMultiParcelHighlights() {
        if (!this.isActive || !this.selectedParcels || this.selectedParcels.size === 0) return;

        // Use a small delay to ensure parcel layer updates are complete
        setTimeout(() => {
            this.selectedParcels.forEach(parcelId => {
                const parcel = this.findParcelById(parcelId);
                if (parcel) {
                    this.addParcelHighlight(parcel);
                }
            });
        }, 50);
    },

    // Select all parcels in a block (used for Buenos Aires block selection)
    selectBlockLayers(blockLayers) {
        if (!Array.isArray(blockLayers) || blockLayers.length === 0) {
            return;
        }

        // Enable multi-selection mode if not already active
        if (!this.isActive) {
            this.toggle({ preserveSelectedParcel: false });
        }

        // Clear existing selection
        this.clearSelection();

        // Add all block layers to selection
        blockLayers.forEach(layer => {
            if (layer && layer.feature && layer.feature.properties) {
                const parcelId = getParcelIdFromFeature(layer.feature);
                if (parcelId) {
                    const parcelIdStr = parcelId.toString();
                    this.selectedParcels.add(parcelIdStr);
                    this.addParcelHighlight(layer);
                }
            }
        });

        // Update the last selected parcel ID
        if (this.selectedParcels.size > 0) {
            this.lastSelectedParcelId = Array.from(this.selectedParcels).slice(-1)[0];
        }

        // Update UI to show the selected parcels
        this.updateUI();

        // Show ephemeral message
        if (typeof showEphemeralMessage === 'function') {
            const message = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
                ? window.i18n.t('ephemeral.messages.all_parcels_in_block_selected', 'All parcels in the block selected!')
                : 'All parcels in the block selected!';
            showEphemeralMessage(message, 4000);
        }
    }
};

// Proposal layer management
let proposalLayer = null;

// --- Proposal Color Palette ---
const PROPOSAL_COLORS = [
    '#4caf50', // green
    '#2196f3', // blue
    '#ff9800', // orange
    '#e91e63', // pink
    '#9c27b0', // purple
    '#f44336', // red
    '#00bcd4', // cyan
    '#8bc34a', // light green
    '#ffc107', // amber
    '#795548', // brown
    '#607d8b', // blue grey
];
function getProposalColor(hash) {
    // Simple hash to color mapping
    let sum = 0;
    for (let i = 0; i < hash.length; i++) sum += hash.charCodeAt(i);
    return PROPOSAL_COLORS[sum % PROPOSAL_COLORS.length];
}
function blendColors(colors) {
    // Simple average RGB blend
    if (colors.length === 1) return colors[0];
    let r = 0, g = 0, b = 0;
    colors.forEach(hex => {
        const c = hex.replace('#', '');
        r += parseInt(c.substring(0, 2), 16);
        g += parseInt(c.substring(2, 4), 16);
        b += parseInt(c.substring(4, 6), 16);
    });
    r = Math.floor(r / colors.length);
    g = Math.floor(g / colors.length);
    b = Math.floor(b / colors.length);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// With no separate proposal mode, this becomes a no-op kept for compatibility.
function updateProposalLayer() { /* intentionally empty */ }

// Refresh the proposals layer (called when proposals are updated)
function refreshProposalsLayer() {
    // No special layer to refresh anymore, keep count and indicator in sync
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
}

// Lightweight function to refresh proposal data without rebuilding visual layers
function refreshProposalData() {
    // This function updates proposal-related data without touching the visual layers
    // It's called during game turns when there are active highlights to avoid flicker

    // Update proposal counts and status if needed
    if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
    if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator();

    // Only refresh proposal info if the modal is currently open
    if (window.currentlyHighlightedProposal && window.selectedParcelInProposal) {
        // Check if the proposal details panel is actually visible
        const proposalPanel = document.getElementById('parcel-info-panel');
        const isProposalModalOpen = proposalPanel &&
            proposalPanel.classList.contains('visible') &&
            proposalPanel.querySelector('h3')?.textContent === 'Proposal Details';

        if (isProposalModalOpen) {
            const updatedProposal = proposalStorage.getProposal(window.currentlyHighlightedProposal.proposalId);
            if (updatedProposal) {
                // Update the proposal info only if modal is open
                showProposalInfo(updatedProposal, window.selectedParcelInProposal);
            }
        }
    }
}

// Handle clicks on road proposals
function showRoadProposalInfo(proposal) {
    // Clear any existing highlights
    clearProposalHighlights();

    // Show road proposal info in the parcel info panel (reusing existing UI)
    const roadGeometry = proposal.roadGeometry;
    const displayId = proposal.proposalId || '';
    const safeDisplayId = typeof escapeHtml === 'function'
        ? escapeHtml(String(displayId))
        : (displayId || '');
    const infoHTML = `
        <div class="proposal-info">
            <h4>Road Proposal</h4>
            <div class="proposal-hash">ID: ${safeDisplayId}</div>
            <div class="metric-group">
                <div class="metric-label">Type:</div>
                <div class="metric-value">${(typeof escapeHtml === 'function' ? escapeHtml(String(resolveProposalGoalKey(proposal) || '')) : String(resolveProposalGoalKey(proposal) || ''))}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Name:</div>
                <div class="metric-value">${roadGeometry.name}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Width:</div>
                <div class="metric-value">${roadGeometry.width}m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value">${proposal.username}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Date:</div>
                <div class="metric-value">${new Date(proposal.timestamp).toLocaleDateString()}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Description:</div>
                <div class="metric-value">${proposal.description}</div>
            </div>
            ${proposal.offer ? `
                <div class="metric-group">
                    <div class="metric-label">Offer:</div>
                    <div class="metric-value">${proposal.offer}</div>
                </div>
            ` : ''}
        </div>
    `;

    // Show in parcel info panel (Info tab)
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    const infoContent = document.getElementById('info-content');

    if (parcelInfoPanel && infoContent) {
        infoContent.innerHTML = infoHTML;
        parcelInfoPanel.classList.add('visible');

        // Update the panel title
        const panelTitle = parcelInfoPanel.querySelector('h3');
        if (panelTitle) {
            panelTitle.textContent = 'Road Proposal Info';
        }
    }
}

// Handle clicks on proposal parcels
// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;
window.isApplyingProposalHighlights = false;

// Apply proposal highlights (can be called repeatedly)
function applyProposalHighlights() {
    if (!window.currentlyHighlightedProposal) return;

    const proposal = window.currentlyHighlightedProposal;
    const shouldBlink = !!proposalHighlightState.pendingBlink;
    const { activeIds, primaryFeatures } = renderAppliedProposalHighlight(proposal, { blink: shouldBlink });

    proposalHighlightState.pendingBlink = false;
    proposalHighlightState.activeChildFeatures = primaryFeatures;
    // Don't cache parentFeatures - fetch by ID when needed
    proposalHighlightState.activeParentFeatures = [];
    proposalHighlightState.activeProposalId = getProposalKey(proposal);

    updateParcelNumberFilterForProposal(activeIds);
}

// Clear proposal highlights
function clearProposalHighlights() {
    window.currentlyHighlightedProposal = null;
    window.selectedParcelInProposal = null;

    clearProposalPreviewLayers();
    clearProposalHoverLayers();
    updateParcelNumberFilterForProposal(null);
    proposalHighlightState.activeChildFeatures = [];
    proposalHighlightState.activeParentFeatures = [];
    proposalHighlightState.activeProposalId = null;
    currentProposalPreviewId = null;

    if (multiParcelSelection.syntheticParcelLayers && multiParcelSelection.syntheticParcelLayers.size > 0) {
        multiParcelSelection.syntheticParcelLayers.forEach(layer => {
            try {
                if (multiParcelSelection.syntheticLayerGroup && multiParcelSelection.syntheticLayerGroup.hasLayer(layer)) {
                    multiParcelSelection.syntheticLayerGroup.removeLayer(layer);
                } else if (typeof map !== 'undefined' && map && map.hasLayer(layer)) {
                    map.removeLayer(layer);
                }
            } catch (error) {
                console.warn('clearProposalHighlights: unable to remove synthetic layer', error);
            }
        });
        multiParcelSelection.syntheticParcelLayers.clear();
    }

    if (multiParcelSelection.syntheticLayerGroup) {
        try {
            if (multiParcelSelection.syntheticLayerGroup.getLayers().length === 0 && typeof map !== 'undefined' && map && map.hasLayer(multiParcelSelection.syntheticLayerGroup)) {
                map.removeLayer(multiParcelSelection.syntheticLayerGroup);
                multiParcelSelection.syntheticLayerGroup = null;
            }
        } catch (_) {
            multiParcelSelection.syntheticLayerGroup = null;
        }
    }
}

// Function to re-apply highlights after parcel layer updates
function reapplyProposalHighlights() {
    if (window.currentlyHighlightedProposal && !window.isApplyingProposalHighlights) {
        // Apply highlights immediately - no delay needed with proper event handling
        applyProposalHighlights();
    }
}

// Show a modal to choose between multiple proposals for a parcel
function showProposalChoiceModal(proposals, parcelId) {
    // Get parcel info for display
    const parcel = multiParcelSelection.findParcelById(parcelId);
    const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId) || parcelId;

    // Remove any existing modal
    const existingModal = document.querySelector('.proposal-choice-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'proposal-choice-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
    `;

    modal.innerHTML = `
        <div class="proposal-choice-content" style="
            background: white;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        ">
            <div class="proposal-choice-header" style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                border-bottom: 1px solid #ddd;
                padding-bottom: 15px;
            ">
                <h3 style="margin: 0; color: #333;">Choose Proposal</h3>
                <button type="button" class="proposal-choice-close close-circle-btn close-circle-btn--lg" aria-label="Close proposal chooser" onclick="closeProposalChoiceModal()">&times;</button>
            </div>
            <div class="proposal-choice-info" style="
                margin-bottom: 20px;
                padding: 10px;
                background-color: #f8f9fa;
                border-radius: 4px;
                color: #666;
                font-size: 14px;
            ">
                Parcel ${parcelNumber} is part of ${proposals.length} proposals. Choose which one to view:
            </div>
            <div class="proposal-choice-list">
                ${proposals.map(proposal => `
                    <div class="proposal-choice-item" onclick="selectProposalFromChoice('${proposal.proposalId}', '${parcelId}')" style="
                        border: 1px solid #ddd;
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 10px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        border-left: 4px solid ${getProposalColor(proposal.proposalId)};
                    " onmouseover="this.style.backgroundColor='#f8f9fa'; this.style.borderColor='#007bff';" 
                       onmouseout="this.style.backgroundColor='white'; this.style.borderColor='#ddd';">
                        <div class="proposal-choice-title" style="
                            font-weight: 600;
                            color: #333;
                            margin-bottom: 8px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        ">
                            <div class="proposal-color-dot" style="
                                width: 12px;
                                height: 12px;
                                border-radius: 50%;
                                background-color: ${getProposalColor(getProposalKey(proposal) || '')};
                            "></div>
                            ${proposal.title}
                        </div>
                        <div class="proposal-choice-details" style="
                            color: #666;
                            font-size: 14px;
                            line-height: 1.4;
                        ">
                            <div>Author: ${proposal.author}</div>
                            ${proposal.offer ? `<div>Offer: €${proposal.offer.toLocaleString('hr-HR')}</div>` : ''}
                            <div>Parcels: ${proposal.parentParcelIds.length}</div>
                            <div>Accepted: ${proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0}/${proposal.parentParcelIds.length}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeProposalChoiceModal();
        }
    });

    // Close modal with Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            closeProposalChoiceModal();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
}

// Close the proposal choice modal
function closeProposalChoiceModal() {
    const modal = document.querySelector('.proposal-choice-modal');
    if (modal) {
        modal.remove();
    }
}

// Select a proposal from the choice modal
function selectProposalFromChoice(proposalIdOrHash, parcelId) {
    closeProposalChoiceModal();
    selectAndHighlightProposal(proposalIdOrHash, parcelId, true);
}

// Unified function to select and highlight a proposal with proper sequencing
function selectAndHighlightProposal(proposalIdOrHash, parcelId, shouldCenter = false, showDetails = true) {
    console.debug('[selectAndHighlightProposal] Called', {
        proposalIdOrHash,
        parcelId,
        shouldCenter,
        showDetails
    });

    const resolvedId = resolveProposalIdKey(proposalIdOrHash);
    console.debug('[selectAndHighlightProposal] Resolved ID:', resolvedId);

    const proposal = getProposalByIdOrHash(resolvedId);
    if (!proposal) {
        console.error('[selectAndHighlightProposal] Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }
    console.debug('[selectAndHighlightProposal] Proposal found', {
        proposalId: proposal.proposalId,
        proposalId: proposal.proposalId,
        title: proposal.title,
        parcelIdsCount: proposal.parentParcelIds?.length || 0
    });

    const proposalKey = getProposalKey(proposal) || resolvedId;
    proposalListState.selectedId = proposalKey;
    console.debug('[selectAndHighlightProposal] Set proposal key:', proposalKey);

    // Skip heavy restyle work if the same proposal is already active and we are not recentering
    const alreadySelected = window.currentlyHighlightedProposalId === proposalKey;
    if (alreadySelected && !shouldCenter) {
        window.currentlyHighlightedProposal = proposal;
        window.selectedParcelInProposal = parcelId;
        if (showDetails) {
            showProposalInfo(proposal, parcelId);
        } else {
            hideProposalDetailsPanel();
        }
        updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parentParcelIds.length} parcels)`);
        // If the same proposal remains selected (common when clicking Apply/Remove inside the panel),
        // we still need to (re)apply overlays when its applied/unapplied state changes.
        // In particular, after "Remove from map" the proposal becomes unapplied and should show blue fill + dashed road geometry.
        try {
            const appliedState = (typeof isProposalApplied === 'function') ? isProposalApplied(proposal) : false;
            if (!appliedState) {
                if (typeof applyProposalHighlights === 'function') {
                    applyProposalHighlights();
                }
            } else {
                // For applied proposals, ensure preview overlays are not shown.
                if (typeof clearProposalPreviewLayers === 'function') {
                    clearProposalPreviewLayers();
                }
            }
        } catch (_) { }
        return;
    }

    // Clear any existing proposal highlights
    console.debug('[selectAndHighlightProposal] Clearing existing proposal highlights...');
    clearProposalHighlights();
    console.debug('[selectAndHighlightProposal] Cleared existing highlights');

    // Set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.currentlyHighlightedProposalId = proposalKey;
    window.selectedParcelInProposal = parcelId;
    console.debug('[selectAndHighlightProposal] Set window state variables');

    // Show proposal info immediately (no visual changes yet)
    if (showDetails) {
        console.debug('[selectAndHighlightProposal] Calling showProposalInfo...');
        showProposalInfo(proposal, parcelId);
        console.debug('[selectAndHighlightProposal] showProposalInfo called');
    } else {
        console.debug('[selectAndHighlightProposal] showDetails is false, hiding proposal details panel');
        hideProposalDetailsPanel();
    }

    // Update status
    updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parentParcelIds.length} parcels)`);

    // If we will center the map, suppress overlay reapplication during movement
    if (shouldCenter && !isCameraMovementSuppressed()) {
        window.isApplyingProposalHighlights = true;
    }

    // Refresh base proposal styling across all parcels to reflect the newly selected proposal
    // This ensures the previous proposal regains hatched styling and the new one uses transparent stroke
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    if (shouldCenter) {
        // Center map first, then apply overlays when movement is complete
        const parcelIdsForCentering = (() => {
            // Prefer descendants (children) because they cover the ancestor area and are present after reloads
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
                const descendants = ProposalManager._getProposalDescendants(proposalKey);
                if (Array.isArray(descendants) && descendants.length > 0) return descendants;
            }
            const childIds = (proposal.roadProposal && Array.isArray(proposal.roadProposal.childParcelIds))
                ? proposal.roadProposal.childParcelIds
                : (Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : []);
            if (childIds.length > 0) return childIds;
            return Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
        })();

        const parcels = parcelIdsForCentering.map(id => multiParcelSelection.findParcelById(id))
            .filter(p => {
                if (!p) return false;
                if (typeof p.getBounds !== 'function') return false;
                try {
                    const center = p.getBounds().getCenter();
                    if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                    if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                    return true;
                } catch (e) {
                    return false;
                }
            });
        if (parcels.length > 0) {
            // Calculate bounds of all parcels in the proposal
            const bounds = L.latLngBounds();
            parcels.forEach(parcel => {
                bounds.extend(parcel.getBounds());
            });

            // Suppress parcel fetching when showing proposal contours
            try { window.suppressCameraMoves = true; } catch (_) { }

            // Hide parcel layer if zoomed out too far (to prevent showing all parcels in memory)
            const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
            const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
            if (parcelLayer && wasParcelLayerVisible) {
                // Hide parcel layer temporarily - it will be restored if zoom is appropriate
                try { map.removeLayer(parcelLayer); } catch (_) { }
            }

            // Listen for moveend event to know when centering is complete
            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd); // Remove listener
                window.isApplyingProposalHighlights = false;

                // Check if zoom is appropriate for showing parcels
                const finalZoom = map.getZoom();
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : finalZoom >= 15; // Default threshold

                // Re-enable parcel fetching after centering is complete
                try { window.suppressCameraMoves = false; } catch (_) { }

                // Ensure parcel layer visibility matches zoom appropriateness
                if (parcelLayer) {
                    if (isZoomAppropriate && wasParcelLayerVisible) {
                        // Restore parcel layer only if zoom is appropriate and it was visible before
                        try {
                            if (!map.hasLayer(parcelLayer)) {
                                parcelLayer.addTo(map);
                            }
                        } catch (_) { }
                    } else {
                        // Remove parcel layer if zoom is not appropriate (even if it was added elsewhere)
                        try {
                            if (map.hasLayer(parcelLayer)) {
                                map.removeLayer(parcelLayer);
                            }
                        } catch (_) { }
                    }
                }

                // Apply overlays after centering is complete
                applyProposalHighlights();
            };

            map.on('moveend', onMoveEnd);

            // Calculate bounds and padding, accounting for proposal details panel on desktop
            const isDesktop = window.innerWidth > 768;
            let adjustedBounds = bounds;
            let fitOptions = { padding: [50, 50] }; // Default: [top/bottom, left/right]

            if (isDesktop && showDetails) {
                // If showing details, expand bounds to account for the proposal details panel on the right
                // Panel is 400px wide + 10px margin on each side = 420px total
                const panelWidth = 400;
                const panelMargin = 20;
                const totalPanelSpace = panelWidth + panelMargin;

                // Get map container to calculate expansion ratio
                const mapContainer = map.getContainer();
                const mapWidth = mapContainer ? mapContainer.clientWidth : window.innerWidth;

                // Calculate expansion needed: visible area is (mapWidth - panelSpace)
                // We need to expand bounds so they fit in this smaller visible area
                const visibleWidth = mapWidth - totalPanelSpace;
                const expansionRatio = mapWidth / visibleWidth;

                // Expand bounds using pad() - pad takes a ratio (0.1 = 10% expansion)
                // We need to expand by (expansionRatio - 1) to account for panel
                // Reduced multiplier (0.5 instead of 0.8) to zoom in more
                const padRatio = Math.max(0.1, (expansionRatio - 1) * 0.5);
                adjustedBounds = bounds.pad(padRatio);

                // Use standard padding
                fitOptions = { padding: [50, 50] };
            }

            // Start the map centering
            // Add maxZoom to prevent zooming out too far (where parcels shouldn't be visible)
            fitOptions.maxZoom = 19;
            map.fitBounds(adjustedBounds, fitOptions);
        } else {
            // No parcels found, just apply overlays immediately
            window.isApplyingProposalHighlights = false;
            applyProposalHighlights();
        }
    } else {
        // Not centering; apply overlays immediately
        applyProposalHighlights();
    }

    // Safety: if proposal UI isn't actually visible, clear any proposal-specific visuals
    try {
        if (typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            clearProposalHighlights();
            clearProposalInfoHoverOverlay();
        }
    } catch (_) { }
}

function focusProposalDetails(proposalIdOrHash, options = {}) {
    if (typeof proposalStorage === 'undefined') return false;
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) return false;

    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);

    selectAndHighlightProposal(
        proposalIdOrHash,
        fallbackParcelId,
        options.centerOnProposal !== false,
        options.showDetails !== false
    );
    return true;
}

function openProposalFromList(proposalIdOrHash, options = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return false;
    }

    const normalized = options && typeof options === 'object' ? options : {};
    const proposal = normalized.proposal || getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return false;
    }

    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    const fallbackParcel = normalized.parcelId
        || getFirstSelectableParcel(proposal)
        || (parcelIds.length > 0 ? parcelIds[0] : null);

    if (normalized.closeAgentDialog !== false && typeof closeAgentDialog === 'function') {
        closeAgentDialog();
    }

    if (normalized.closeParcelInfo !== false && typeof hideParcelInfoPanel === 'function') {
        hideParcelInfoPanel();
    }

    if (normalized.closeProposalList !== false) {
        closeProposalList({ clearHighlights: false });
    }

    if (normalized.collapseSidebar) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);

    focusProposalDetails(proposalKey, {
        parcelId: fallbackParcel,
        centerOnProposal: normalized.centerOnProposal !== false,
        showDetails: normalized.showDetails !== false
    });

    return true;
}

window.openProposalFromList = openProposalFromList;

const APPLY_DISABLED_TYPE_KEYS = new Set();

function normalizeProposalGoalKey(rawGoal) {
    if (rawGoal === undefined || rawGoal === null) return '';
    const text = String(rawGoal).trim().toLowerCase();
    if (!text) return '';
    const dashed = text.replace(/\s+/g, '-');

    // Canonical mappings (human labels -> goal keys)
    if (text === 'road/track' || text === 'road' || text === 'track') return 'road-track';
    if (text === 'decide later' || text === 'decide-later') return 'decide-later';
    if (text === 'building(s)' || text === 'single building' || text === 'single') return 'single';
    if (text === 'buildings' || text === 'residences') return 'buildings';

    // Normalize separators (e.g. road/track -> road-track)
    const key = dashed.replace(/\//g, '-');

    if (key === 'road-track') return 'road-track';
    if (key === 'decide-later') return 'decide-later';
    if (key === 'reparcellization') return 'reparcellization';
    if (key === 'park' || key === 'square' || key === 'lake') return key;
    if (key === 'buildings') return 'buildings';
    if (key === 'single') return 'single';
    if (key === 'row') return 'row';
    if (key === 'parcelbased' || key === 'parcel-based') return 'parcelBased';
    if (key === 'urban-rule') return 'urban-rule';
    if (key === 'parcel') return 'parcel';

    return key;
}

function resolveProposalGoalKey(proposal, fallbackProposal) {
    const subject = proposal || fallbackProposal || {};
    const raw = subject.goal !== undefined && subject.goal !== null
        ? subject.goal
        : (fallbackProposal && fallbackProposal.goal !== undefined && fallbackProposal.goal !== null ? fallbackProposal.goal : null);
    return normalizeProposalGoalKey(raw);
}

if (typeof window !== 'undefined') {
    window.normalizeProposalGoalKey = normalizeProposalGoalKey;
    window.resolveProposalGoalKey = resolveProposalGoalKey;
}

function resolveProposalActionTypeKey(proposal, fallbackProposal) {
    return resolveProposalGoalKey(proposal, fallbackProposal);
}

async function applyProposalToMap(proposalIdOrHash, options = {}) {
    const startTime = performance.now();
    const safeId = proposalIdOrHash ? String(proposalIdOrHash) : '';
    console.log(`[applyProposalToMap] Starting application for proposal ${safeId}...`);

    if (!safeId || typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        console.warn(`[applyProposalToMap] Invalid proposal id/hash or ProposalManager unavailable`);
        return false;
    }

    const step1Time = performance.now();
    const proposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
        ? proposalStorage.getProposal(safeId)
        : null;
    console.log(`[applyProposalToMap] Step 1: Retrieved proposal from storage (${(performance.now() - step1Time).toFixed(2)}ms)`);

    // Road proposals should always be able to be applied
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;
    const normalizedType = resolveProposalActionTypeKey(proposal, null);
    if (!isRoadProposal && APPLY_DISABLED_TYPE_KEYS.has(normalizedType)) {
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const message = t
            ? t('panel.proposal.actions.apply_disabled_for_type', 'Apply is disabled for this proposal type.')
            : 'Apply is disabled for this proposal type.';
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(message, 3500, 'info');
        }
        console.log(`[applyProposalToMap] Apply disabled for proposal type: ${normalizedType}`);
        return false;
    }

    const step2Time = performance.now();
    // Update button to show loading state
    const buttonId = `proposal-action-btn-${safeId}`;
    const button = document.getElementById(buttonId);
    let originalButtonContent = null;
    if (button) {
        originalButtonContent = button.innerHTML;
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const applyingText = t
            ? t('panel.proposal.actions.applying', 'Applying...')
            : 'Applying...';
        button.disabled = true;
        button.innerHTML = `<span class="metric-spinner" aria-hidden="true"></span> ${applyingText}`;
        button.style.opacity = '0.7';
        button.style.cursor = 'wait';
    }
    console.log(`[applyProposalToMap] Step 2: Updated button UI (${(performance.now() - step2Time).toFixed(2)}ms)`);

    try {
        const step3Time = performance.now();
        // Use setTimeout to allow UI to update before heavy operation
        await new Promise(resolve => setTimeout(resolve, 0));
        console.log(`[applyProposalToMap] Step 3: UI update delay (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        console.log(`[applyProposalToMap] Step 4: Calling ProposalManager.applyProposal...`);
        const applied = await ProposalManager.applyProposal(safeId);
        const step4Duration = performance.now() - step4Time;
        console.log(`[applyProposalToMap] Step 4: ProposalManager.applyProposal completed (${step4Duration.toFixed(2)}ms)`);

        if (applied === false) {
            console.warn(`[applyProposalToMap] Proposal application returned false`);
            // Restore button on failure
            if (button && originalButtonContent) {
                button.innerHTML = originalButtonContent;
                button.disabled = false;
                button.style.opacity = '';
                button.style.cursor = '';
            }
            return false;
        }
    } catch (error) {
        console.error(`[applyProposalToMap] Error applying proposal to map (${(performance.now() - startTime).toFixed(2)}ms):`, error);
        // Restore button on error
        if (button && originalButtonContent) {
            button.innerHTML = originalButtonContent;
            button.disabled = false;
            button.style.opacity = '';
            button.style.cursor = '';
        }
        return false;
    }

    const step5Time = performance.now();
    // Clear the preview overlay (dashed outline) when proposal is applied
    // The actual parcels are now on the map with normal styling, so preview is no longer needed
    if (typeof clearProposalPreviewLayers === 'function') {
        clearProposalPreviewLayers();
    }
    console.debug(`[applyProposalToMap] Step 5: Cleared preview layers (${(performance.now() - step5Time).toFixed(2)}ms)`);

    // Immediately restore button state to prevent it from being stuck in loading state
    // The button will be updated to "Remove from map" by showProposalInfo below
    const currentButton = document.getElementById(buttonId);
    if (currentButton) {
        currentButton.disabled = false;
        currentButton.style.opacity = '';
        currentButton.style.cursor = '';
        // Temporarily show a success state, will be replaced by showProposalInfo
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const appliedText = t
            ? t('panel.proposal.actions.remove', 'Remove from map')
            : 'Remove from map';
        currentButton.innerHTML = `<i class="fas fa-eye-slash"></i> ${appliedText}`;
        currentButton.className = 'btn btn-warning';
        currentButton.setAttribute('onclick', `removeProposalFromMap('${safeId}')`);
    }

    const step6Time = performance.now();
    let step6Label = 'Revealed details';
    // Do not auto-refresh proposal details during apply by default; it is expensive for large proposals.
    // Callers can opt-in with options.revealDetails = true.
    const revealDetails = options.revealDetails === true;

    let proposalUpdated = false;
    if (revealDetails && typeof proposalStorage !== 'undefined') {
        const proposalForRefresh = proposalStorage.getProposal(safeId);
        if (proposalForRefresh) {
            const parcelIds = Array.isArray(proposalForRefresh.parentParcelIds) ? proposalForRefresh.parentParcelIds : [];
            const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);
            const proposalKey = typeof getProposalKey === 'function' ? getProposalKey(proposalForRefresh) : null;
            const alreadyHighlighted = proposalKey && window.currentlyHighlightedProposalId === proposalKey;
            const resolvedParcel = options.parcelId || window.selectedParcelInProposal || fallbackParcelId;

            if (alreadyHighlighted && options.forceRefocus !== true) {
                // When the proposal is already selected (common when clicking Apply inside its panel),
                // avoid re-running highlight + fitBounds work; just update button state.
                // Don't call showProposalInfo during apply - it's expensive and not needed.
                // The button will be updated by the fallback code below.
                proposalUpdated = true;
                step6Label = 'Reused existing selection (skipped refocus)';
            } else {
                focusProposalDetails(safeId, {
                    parcelId: resolvedParcel,
                    centerOnProposal: options.centerOnProposal !== false,
                    showDetails: options.showDetails !== false
                });
                proposalUpdated = true;

                // Clear overlays again after focusProposalDetails (which may have re-added them via applyProposalHighlights)
                // For applied proposals, we want normal parcel styling, not dashed outline overlays
                if (typeof clearProposalPreviewLayers === 'function') {
                    clearProposalPreviewLayers();
                }
            }
        }
    }

    // Fallback: If showProposalInfo wasn't called, ensure button is still updated
    if (!proposalUpdated) {
        const fallbackButton = document.getElementById(buttonId);
        if (fallbackButton && (fallbackButton.innerHTML.includes('Applying') || fallbackButton.innerHTML.includes('metric-spinner'))) {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const appliedText = t
                ? t('panel.proposal.actions.remove', 'Remove from map')
                : 'Remove from map';
            fallbackButton.innerHTML = `<i class="fas fa-eye-slash"></i> ${appliedText}`;
            fallbackButton.className = 'btn btn-warning';
            fallbackButton.disabled = false;
            fallbackButton.style.opacity = '';
            fallbackButton.style.cursor = '';
            fallbackButton.setAttribute('onclick', `removeProposalFromMap('${safeId}')`);
        }
    }

    console.debug(`[applyProposalToMap] Step 6: ${step6Label} (${(performance.now() - step6Time).toFixed(2)}ms)`);

    const totalTime = performance.now() - startTime;
    console.log(`[applyProposalToMap] ✓ Application completed successfully in ${totalTime.toFixed(2)}ms`);
    return true;
}

async function removeProposalFromMap(proposalId, options = {}) {
    if (!proposalId || typeof ProposalManager === 'undefined' || typeof ProposalManager.unapplyProposal !== 'function') {
        return false;
    }

    console.log(`[removeProposalFromMap] Attempting to unapply proposal ${proposalId}...`);
    const proposalSnapshot = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
        ? proposalStorage.getProposal(proposalId)
        : null;
    if (proposalSnapshot) {
        console.log('[removeProposalFromMap] Current proposal status', {
            status: proposalSnapshot.status,
            roadStatus: proposalSnapshot.roadProposal?.status,
            childIds: Array.isArray(proposalSnapshot.childParcelIds) ? proposalSnapshot.childParcelIds.slice() : [],
            parentIds: Array.isArray(proposalSnapshot.parentParcelIds) ? proposalSnapshot.parentParcelIds.slice() : []
        });
    }

    const buttonId = `proposal-action-btn-${proposalId}`;
    const button = document.getElementById(buttonId);
    const original = button ? button.innerHTML : null;

    if (button) {
        button.disabled = true;
        button.style.opacity = '0.6';
        button.style.cursor = 'wait';
        button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${options.removingLabel || 'Removing…'}`;
    }

    try {
        // ProposalManager.unapplyProposal handles everything:
        // - Restores ancestor parcels, removes descendants
        // - Updates proposal status
        // - Refreshes UI indicators
        // - Re-highlights the proposal if it's currently highlighted (via selectAndHighlightProposal)
        const unapplied = await ProposalManager.unapplyProposal(proposalId);
        if (unapplied === false) {
            return false;
        }
        return true;
    } finally {
        if (button) {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const label = t
                ? t('panel.proposal.actions.remove', 'Remove from map')
                : 'Remove from map';
            button.disabled = false;
            button.style.opacity = '';
            button.style.cursor = '';
            button.className = 'btn btn-warning';
            button.innerHTML = original || `<i class="fas fa-eye-slash"></i> ${label}`;
        }
    }
}

window.focusProposalDetails = focusProposalDetails;
window.applyProposalToMap = applyProposalToMap;
window.removeProposalFromMap = removeProposalFromMap;



// Override the parcel click when proposals are shown
let originalOnParcelClick = null;

function collapseSidebarIfOpen() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || sidebar.classList.contains('collapsed')) return;
    if (typeof toggleSidebar === 'function') {
        try { toggleSidebar(); } catch (_) { }
    }
}

/**
 * Returns the correct parcel click handler based on the current UI state.
 * This is the single source of truth for parcel click behavior.
 */
function getCorrectClickHandler() {
    // Always allow normal parcel clicking; proposals display should never block interactions
    // Fallback to the global handler if the original has not been captured yet
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    // Ensure we always return a function to avoid Leaflet listener errors
    return (typeof originalOnParcelClick === 'function')
        ? originalOnParcelClick
        : (typeof window !== 'undefined' && typeof window.onParcelClick === 'function'
            ? window.onParcelClick
            : function () { });
}

/**
 * A robust click handler that is aware of the proposal mode.
 * It checks if a clicked parcel is part of a proposal and routes
 * the click to the appropriate handler.
 * @param {L.LeafletEvent} e The Leaflet click event.
 */
function proposalAwareParcelClickHandler(e) {
    // Pass-through to the original click handler to ensure parcels are always selectable
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        originalOnParcelClick.call(this, e);
    }
}

// Show proposal info panel
// NOTE: This is a pure display function. It expects the proposal to contain all necessary data
// (parentFeatures, childFeatures, parcelIds). No data fetching should happen here.
// Proposals are created from loaded parcels, so all data should already be present.
function showProposalInfo(proposal, currentParcelId = null, preserveScrollPosition = null) {
    console.debug('[showProposalInfo] Called', {
        proposalId: proposal?.proposalId,
        proposalId: proposal?.proposalId,
        title: proposal?.title,
        currentParcelId,
        preserveScrollPosition
    });

    const i18nProposal = (typeof window !== 'undefined') ? window.i18n : null;
    const formatProposalString = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const key = k1 || k2;
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };
    const tProposal = (key, fallback, params = {}) => {
        if (i18nProposal && typeof i18nProposal.t === 'function') {
            const translated = i18nProposal.t(key, params);
            // If translation returns the key itself (meaning translation not found), use fallback
            if (translated && translated !== key) {
                return translated;
            }
        }
        return formatProposalString(fallback, params);
    };

    console.debug('[showProposalInfo] Collapsing sidebar...');
    collapseSidebarIfOpen();
    console.debug('[showProposalInfo] Sidebar collapsed');

    const parcelIds = ensureArrayOfStrings(proposal.parentParcelIds);
    console.debug('[showProposalInfo] Got parcel IDs', { parcelIdsCount: parcelIds.length });

    // Check proposal category for map application controls
    // Ensure we have the full proposal from storage if needed
    // This needs to be done early because we use fullProposal for ancestor parcels
    console.debug('[showProposalInfo] Getting full proposal from storage...');
    let fullProposal = proposal;
    if (proposal.proposalId && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
        try {
            const stored = proposalStorage.getProposal(proposal.proposalId);
            if (stored) {
                console.debug('[showProposalInfo] Found full proposal in storage');
                fullProposal = stored;
            } else {
                console.debug('[showProposalInfo] Proposal not found in storage, using provided proposal');
            }
        } catch (err) {
            console.warn('[showProposalInfo] Error getting proposal from storage:', err);
        }
    } else {
        console.debug('[showProposalInfo] Storage not available, using provided proposal');
    }

    // PERFORMANCE: Start timing parent parcel processing
    const perfStartParentIds = performance.now();

    // Get parent parcel IDs from proposal (parentParcelIds for road/building proposals)
    // WHY: We need to show which parcels were used to create this proposal in the UI
    // The parent parcels are the ones that were split/merged to create new parcels
    let parentParcelIds = [];
    if (fullProposal.roadProposal) {
        if (Array.isArray(fullProposal.roadProposal.parentParcelIds) && fullProposal.roadProposal.parentParcelIds.length > 0) {
            parentParcelIds = fullProposal.roadProposal.parentParcelIds;
        }
    } else if (fullProposal.buildingProposal) {
        if (Array.isArray(fullProposal.buildingProposal.parentParcelIds) && fullProposal.buildingProposal.parentParcelIds.length > 0) {
            parentParcelIds = fullProposal.buildingProposal.parentParcelIds;
        }
    }

    // If no parent parcel IDs found, fall back to proposal.parentParcelIds (for proposals that haven't been applied yet)
    // But only if the proposal hasn't been applied (no childParcelIds exist)
    if (parentParcelIds.length === 0) {
        const hasChildren = (fullProposal.roadProposal && Array.isArray(fullProposal.roadProposal.childParcelIds) && fullProposal.roadProposal.childParcelIds.length > 0)
            || (fullProposal.buildingProposal && fullProposal.buildingProposal.buildingFeature);

        if (!hasChildren) {
            parentParcelIds = parcelIds;
        }
    }

    const perfEndParentIds = performance.now();
    console.debug('[showProposalInfo] Parent parcel IDs extracted', {
        count: parentParcelIds.length,
        timeMs: (perfEndParentIds - perfStartParentIds).toFixed(2),
        source: fullProposal.roadProposal ? 'roadProposal' : fullProposal.buildingProposal ? 'buildingProposal' : 'parcelIds'
    });

    // PERFORMANCE: Start timing parcel feature loading
    const perfStartParcelFeatures = performance.now();
    let persistentStorageHits = 0;
    let cachedFeatureHits = 0;
    let parentFeatureHits = 0;
    let stubHits = 0;

    // Build parent parcels list without hydrating from map (avoid mass findParcelById lookups)
    // WHY: We need parcel features to display in the UI (parcel numbers, owner info, acceptance status)
    // The HTML we're building shows a list of all ancestor parcels with their details
    // WHY PersistentStorage: This function is used both for:
    //   1. Viewing saved proposals (parcels might not be in memory - need to load from storage)
    //   2. Viewing proposals being created (parcels SHOULD be in memory via parentFeatures)
    // The code tries parentFeatures first (in-memory), then falls back to PersistentStorage
    const parentParcels = parentParcelIds.map(parcelId => {
        const canonicalId = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId || '');
        if (!canonicalId) {
            return null;
        }

        // First preference: cached proposal features (parent/child)
        // OPTIMIZATION: If proposal has parentFeatures in memory, use those (fast path)
        let feature = getCachedParcelFeature(canonicalId, fullProposal);
        if (feature) {
            cachedFeatureHits++;
        }

        // No fallback to parentFeatures - always fetch by ID

        // Fallback: persistent storage
        // WHY: For saved proposals, parcels might not be in memory
        // This is the slow path - should only happen when viewing old saved proposals
        let geometry = null;
        if (!feature) {
            try {
                const record = readPersistedParcelRecord(canonicalId);
                if (record && record.geometry && record.properties) {
                    persistentStorageHits++;
                    geometry = record.geometry;
                    const properties = record.properties;
                    feature = ensureParcelIdOnFeature({
                        type: 'Feature',
                        properties,
                        geometry: {
                            type: 'Polygon',
                            coordinates: [geometry]
                        }
                    });
                }
            } catch (_) { }
        }

        // Final fallback: minimal stub
        // WHY: If we can't find parcel data anywhere, create a minimal feature
        // This allows the UI to still show the parcel ID even if data is missing
        if (!feature) {
            stubHits++;
            feature = ensureParcelIdOnFeature({
                type: 'Feature',
                properties: {
                    parcelId: canonicalId,
                    BROJ_CESTICE: canonicalId
                },
                geometry: null
            });
        }

        // Check if parcel was removed by this proposal
        const isReplaced = (typeof isParcelReplacedByChildren === 'function') ? isParcelReplacedByChildren(canonicalId) : false;
        const isRemoved = isReplaced || !feature.geometry;

        return {
            parcelId: getParcelIdFromFeature(feature) || canonicalId,
            parcel: null, // intentionally avoid parcelLayer hydration
            feature,
            geometry,
            isRemoved
        };
    }).filter(Boolean);

    const perfEndParcelFeatures = performance.now();
    console.debug('[showProposalInfo] Parent parcel features loaded', {
        totalParcels: parentParcels.length,
        timeMs: (perfEndParcelFeatures - perfStartParcelFeatures).toFixed(2),
        cachedHits: cachedFeatureHits,
        parentFeatureHits: parentFeatureHits,
        persistentStorageHits: persistentStorageHits,
        stubHits: stubHits,
        avgTimePerParcel: parentParcelIds.length > 0
            ? ((perfEndParcelFeatures - perfStartParcelFeatures) / parentParcelIds.length).toFixed(2) + 'ms'
            : '0ms',
        note: persistentStorageHits > 0
            ? '⚠️ Using PersistentStorage (slow) - proposal may not have parentFeatures in memory'
            : '✓ Using in-memory features (fast)'
    });

    // For total area calculation, use cached feature properties when available
    const totalArea = parentParcels.reduce((sum, ap) => {
        const area = ap?.feature?.properties?.calculatedArea;
        if (Number.isFinite(area)) return sum + area;
        return sum;
    }, 0);

    // Lazy-render helpers
    const MAX_LIST_INITIAL = 20;
    const renderAncestorParcelItem = (parentParcel) => {
        const parcelId = parentParcel.parcelId;
        const feature = parentParcel.feature;
        const isRemoved = parentParcel.isRemoved;
        const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

        // Get parcel owner information
        const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
        let ownerAvatarHtml = '';

        if (ownerId && typeof agentStorage !== 'undefined') {
            const owner = agentStorage.getAgent(ownerId);
            if (owner && typeof getAvatarImagePath === 'function') {
                ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
            }
        }

        const ownerAcceptanceHtml = (typeof buildOwnerAcceptanceSectionHtml === 'function')
            ? buildOwnerAcceptanceSectionHtml(proposal, parcelId, { compact: true, skipParcelPanelFocus: true })
            : '';

        const parcelNumberDisplay = getParcelDisplayNumberFromProperties(feature?.properties, parcelId);
        const parcelLabelText = tProposal('panel.proposal.parcels.label', 'Parcel {{id}}', { id: parcelNumberDisplay || parcelId });
        const parcelTooltip = isRemoved
            ? tProposal('panel.proposal.parcels.tooltipRemoved', 'Click to focus on where this parcel was')
            : tProposal('panel.proposal.parcels.tooltip', 'Click to view parcel details');
        const acceptedLabel = tProposal('panel.proposal.acceptance.accepted', 'Accepted');
        const pendingLabel = tProposal('panel.proposal.acceptance.pending', 'Pending');
        const removedLabel = tProposal('panel.proposal.parcels.removed', 'Removed');

        // Store geometry data for removed parcels so we can focus on location
        const removedGeometry = isRemoved
            ? (parentParcel.geometry || (feature && feature.geometry) || null)
            : null;
        const geometryDataAttr = removedGeometry
            ? `data-parcel-geometry='${JSON.stringify(removedGeometry)}'`
            : '';
        const removedDataAttr = isRemoved ? 'data-parcel-removed="true"' : '';

        return `
            <div class="proposal-parcel-item" data-parcel-id="${parcelId}" ${removedDataAttr} ${geometryDataAttr} onclick="handleProposalParcelClick('${parcelId}', event)" style="display: flex; flex-direction: column; gap:6px; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''} ${isRemoved ? 'opacity: 0.7;' : ''}" title="${parcelTooltip}">
                <div class="parcel-info" style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${ownerAvatarHtml}
                        <div>
                            <span class="parcel-number" style="font-weight: 500;">${parcelLabelText}</span>
                            <span style="margin: 0 4px; color: #999;">·</span>
                            ${isRemoved
                ? `<span class="parcel-status parcel-status-removed" style="color: #999; font-size: 12px; font-style: italic;">${removedLabel}</span>`
                : (hasAccepted ?
                    `<span class="parcel-status parcel-status-accepted" style="color: #28a745; font-size: 12px; font-weight: 500;">✓ ${acceptedLabel}</span>` :
                    `<span class="parcel-status parcel-status-pending" style="color: #666; font-size: 12px;">${pendingLabel}</span>`)
            }
                        </div>
                    </div>
                </div>
                ${ownerAcceptanceHtml ? `<div class="parcel-owner-acceptance" onclick="event.stopPropagation(); event.preventDefault(); return false;">${ownerAcceptanceHtml}</div>` : ''}
            </div>
        `;
    };

    const parentParcelItemsInitial = parentParcels.slice(0, MAX_LIST_INITIAL).map(renderAncestorParcelItem).join('');
    const parentParcelItemsRemaining = parentParcels.slice(MAX_LIST_INITIAL);

    const renderDescendantItem = (descendant) => {
        const descendantKey = (descendant !== undefined && descendant !== null) ? String(descendant) : '';
        const descendantData = proposalStorage.getProposal(descendantKey);
        if (descendantData) {
            const descendantId = descendantData.proposalId || descendantKey;
            return `<div class="descendant-item" data-descendant-type="proposal" data-proposal-id="${descendantId}" tabindex="0">
                <strong>${descendantData.title}</strong> (${descendantData.type || 'proposal'})
            </div>`;
        }

        let parcelNumber = null;
        let isRoad = false;
        let roadName = null;

        // Prefer cached proposal features to avoid hydrating parcel layers
        const cachedFeature = getCachedParcelFeature(descendantKey);
        if (cachedFeature?.properties) {
            parcelNumber = getParcelDisplayNumberFromProperties(cachedFeature.properties, parcelNumber);
            isRoad = isRoad || !!cachedFeature.properties.isRoad;
            roadName = roadName || cachedFeature.properties.roadName || null;
        }

        if (!parcelNumber) {
            try {
                const record = readPersistedParcelRecord(descendantKey);
                const props = record?.properties;
                if (props) {
                    parcelNumber = getParcelDisplayNumberFromProperties(props, parcelNumber);
                    isRoad = isRoad || !!props.isRoad;
                    roadName = roadName || props.roadName || record?.roadName || null;
                }
            } catch (_) { }
        }

        const label = parcelNumber ? `Parcel ${parcelNumber}` : `Parcel ${descendantKey}`;
        const roadSuffix = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
        return `<div class="descendant-item" data-descendant-type="parcel" data-parcel-id="${descendantKey}" tabindex="0">
            ${label}${roadSuffix}
        </div>`;
    };

    const descendantKeys = (typeof ProposalManager !== 'undefined')
        ? (ProposalManager._getProposalDescendants(proposal.proposalId) || [])
        : [];
    const descendantItemsInitial = descendantKeys.slice(0, MAX_LIST_INITIAL).map(renderDescendantItem).join('');
    const descendantItemsRemaining = descendantKeys.slice(MAX_LIST_INITIAL);

    // PERFORMANCE: Start timing HTML generation
    const perfStartHtml = performance.now();

    // Determine current parcel - try passed parameter first, then global selectedParcelId
    const tProposalUI = getProposalI18nHelper();
    const ownerAcceptanceSummaryFast = buildProposalOwnerAcceptanceSummaryFast(proposal);

    // Update the proposal details panel title
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        proposalPanelTitle.textContent = tProposal('panel.proposal.title', 'Proposal Details');
    }

    const formatAuthorForDisplay = (authorRaw) => {
        const author = authorRaw || '';
        const isHexAddress = author.startsWith('0x') && author.length > 12;
        const truncated = isHexAddress
            ? `${author.slice(0, 6)}...${author.slice(-4)}`
            : author;
        const safeText = typeof escapeHtml === 'function' ? escapeHtml(truncated) : truncated;
        const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(author) : author;
        return `<span class="author-text" style="display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${safeTitle}">${safeText}</span>`;
    };

    const {
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        supportsMapToggle
    } = computeProposalCategoryFlags(fullProposal, { fallbackProposal: proposal });

    const normalizedTypeForActions = resolveProposalActionTypeKey(fullProposal, proposal);
    // Road proposals should always be able to be applied
    const applyDisabledForType = isRoadProposal ? false : APPLY_DISABLED_TYPE_KEYS.has(normalizedTypeForActions);

    const appliedState = isProposalApplied(fullProposal);
    // Check multiple signals for minted state: explicit flag, onchain data, or tokenId-style proposalId
    const isMinted = isProposalMinted(fullProposal);
    const lifecycleKey = getProposalLifecycleKey(fullProposal);
    const statusBadgeClass = getProposalLifecycleClass(lifecycleKey);
    const statusBadgeLabel = getProposalLifecycleLabel(lifecycleKey);
    const mapStatusBadgeClass = appliedState ? 'applied' : 'not-applied';
    const mapStatusBadgeLabel = appliedState
        ? tProposal('panel.proposal.mapStatus.applied', 'Applied')
        : tProposal('panel.proposal.mapStatus.notApplied', 'Not Applied');
    const disbursementModeRaw = (fullProposal.disbursementMode || proposal.disbursementMode || '').toLowerCase();
    const isConditional = fullProposal.isConditional === true || proposal.isConditional === true || disbursementModeRaw === 'conditional';
    const conditionalBadgeClass = isConditional ? 'conditional' : 'partial';
    const conditionalBadgeLabel = isConditional
        ? tProposal('panel.proposal.disbursement.conditional', 'Conditional')
        : tProposal('panel.proposal.disbursement.partial', 'Partial payouts');
    const conditionalBadgeTitle = isConditional
        ? tProposal('panel.proposal.disbursement.conditionalHint', 'All owners must accept before payout')
        : tProposal('panel.proposal.disbursement.partialHint', 'Payout released as each owner accepts');

    const nftInfo = getProposalNftInfo(fullProposal);
    const mintedExplorerUrl = nftInfo ? buildProposalNftExplorerUrl(fullProposal) : null;

    // Use stable proposalId only (hash support removed)
    const proposalKey = fullProposal.proposalId
        || proposal.proposalId;
    // Show map actions whenever we have an identifier and the ProposalManager is available,
    // even if type detection failed. This keeps Apply/Remove visible in production too.
    const hasProposalManager = typeof ProposalManager !== 'undefined'
        && typeof ProposalManager.applyProposal === 'function'
        && typeof ProposalManager.unapplyProposal === 'function';
    const canShowMapActions = !!proposalKey && (supportsMapToggle || hasProposalManager);

    let mapActionButtonHtml = '';
    if (canShowMapActions) {
        const isApplyAction = !appliedState;
        const buttonLabel = appliedState
            ? tProposal('panel.proposal.actions.remove', 'Remove from map')
            : tProposal('panel.proposal.actions.apply', 'Apply to map');
        const iconClass = appliedState ? 'fa-eye-slash' : 'fa-check';
        const isDisabled = isApplyAction && applyDisabledForType;
        const buttonClass = appliedState
            ? 'btn btn-warning'
            : (isDisabled ? 'btn btn-secondary disabled' : 'btn btn-success');
        const defaultActionClass = (isApplyAction && !isDisabled) ? ' proposal-action-default' : '';
        const defaultActionAttrs = (isApplyAction && !isDisabled)
            ? 'data-default-action="true" aria-keyshortcuts="Enter"'
            : '';
        const handler = appliedState
            ? `removeProposalFromMap('${proposalKey}')`
            : (isDisabled ? null : `applyProposalToMap('${proposalKey}')`);
        const disabledStyle = 'cursor: not-allowed; opacity: 0.55; pointer-events: none; background-color: #d1d5db; border-color: #cbd5e1; color: #555;';
        const enabledStyle = '';
        const disabledAttrs = isDisabled
            ? `disabled aria-disabled="true" style="${disabledStyle}"`
            : (enabledStyle ? `style="${enabledStyle}"` : '');
        const buttonId = `proposal-action-btn-${proposalKey}`;
        mapActionButtonHtml = `
            <button id="${buttonId}" type="button" class="${buttonClass}${defaultActionClass}" ${handler ? `onclick="${handler}"` : ''} ${disabledAttrs} ${defaultActionAttrs}>
                <i class="fas ${iconClass}"></i> ${buttonLabel}
            </button>
        `;
    }

    const shareButtonHtml = `
        <button class="btn btn-outline-primary btn-share-proposal" onclick="shareSingleProposal('${proposalKey}')">
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share Proposal')}
        </button>
    `;

    const primaryActionsHtml = `
        <div class="proposal-actions proposal-actions-group">
            ${mapActionButtonHtml ? mapActionButtonHtml : ''}
            ${shareButtonHtml}
        </div>
    `;

    const escapedProposalDescription = typeof escapeHtml === 'function'
        ? escapeHtml(proposal.description || '')
        : (proposal.description || '');

    const proposalDisplayId = proposal.proposalId ? String(proposal.proposalId) : null;

    const escapedProposalDisplayId = proposalDisplayId && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayId)
        : proposalDisplayId;
    const proposalLensEntries = getProposalLensEntries(fullProposal || proposal);
    const hasProposalLens = proposalLensEntries.length > 0;
    const lensPatternUrl = hasProposalLens && typeof getLensPatternDataUrl === 'function'
        ? getLensPatternDataUrl(proposalLensEntries)
        : null;
    const translateLensKey = (key, fallback) => {
        if (i18nProposal && typeof i18nProposal.t === 'function') {
            const value = i18nProposal.t(key);
            if (value && value !== key) return value;
        }
        return fallback;
    };
    const lensButtonLabel = translateLensKey('modal.lens.proposalTriggerTitle', 'View proposal lens');
    const safeLensButtonLabel = typeof escapeHtml === 'function' ? escapeHtml(lensButtonLabel) : lensButtonLabel;
    const lensProposalId = fullProposal.proposalId || proposal.proposalId || '';
    const lensButtonHtml = hasProposalLens ? `
        <button type="button"
            class="lens-pattern-button proposal-lens-button"
            onclick="openProposalLens('${lensProposalId}')"
            title="${safeLensButtonLabel}"
            aria-label="${safeLensButtonLabel}"
            ${lensPatternUrl ? `style="background-image: url(&quot;${lensPatternUrl}&quot;);"` : ''}>
            👓
        </button>
    ` : `
        <button type="button"
            class="lens-pattern-button proposal-lens-button proposal-lens-button--empty"
            title="${safeLensButtonLabel}"
            aria-label="${safeLensButtonLabel}"
            disabled>
            👓
        </button>
    `;

    // Build expiry countdown HTML if proposal has an expiry set and is not executed
    let expiryCountdownHtml = '';
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposal.expiresAt && proposalStatus !== 'executed') {
        const expiresAt = new Date(proposal.expiresAt).getTime();
        const now = Date.now();
        const isExpired = expiresAt <= now;

        if (isExpired) {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown expired" style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-clock" style="margin-right: 6px;"></i>
                    <span class="expiry-label" style="color: #721c24; font-weight: 600;">${tProposal('panel.proposal.expiry.expired', 'Proposal Expired')}</span>
                </div>
            `;
        } else {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown" data-expires-at="${proposal.expiresAt}" data-proposal-id="${proposal.proposalId}" style="background: #fff3cd; border: 1px solid #ffeaa8; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-hourglass-half" style="margin-right: 6px; color: #856404;"></i>
                    <span class="expiry-label" style="color: #856404; font-weight: 500;">${tProposal('panel.proposal.expiry.countdown', 'Expires in:')} </span>
                    <span class="expiry-timer" style="color: #856404; font-weight: 700; font-family: monospace;"></span>
                </div>
            `;
        }
    }

    const acceptanceLoadingLabel = tProposal('panel.proposal.rendering', 'Loading...');
    const parcelAcceptanceLabel = tProposalUI('panel.proposal.acceptance.parcelTitle', 'Parcel Acceptance Status:');
    const ownerAcceptanceLabel = tProposalUI('panel.proposal.acceptance.ownerTitle', 'Owner Acceptance Status:');
    const acceptanceSpinnerHtml = `
        <div class="acceptance-loading" style="display: inline-flex; align-items: center; gap: 8px; color: #666; font-size: 12px; margin: 6px 0;">
            <div class="spinner-circle" aria-hidden="true" style="width: 16px; height: 16px; border: 2px solid #ccc; border-top-color: #555; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
            <span>${acceptanceLoadingLabel}</span>
        </div>`;
    const parcelAcceptancePlaceholder = `
        <div class="proposal-acceptance-status placeholder" id="proposal-parcel-acceptance-section">
            <div class="acceptance-label">${parcelAcceptanceLabel}</div>
            ${acceptanceSpinnerHtml}
        </div>`;
    const ownerAcceptancePlaceholder = `
        <div class="proposal-acceptance-status owner placeholder" id="proposal-owner-acceptance-section">
            <div class="acceptance-label">${ownerAcceptanceLabel}</div>
            ${acceptanceSpinnerHtml}
        </div>`;

    const createdAtLabel = fullProposal.createdAt
        ? new Date(fullProposal.createdAt).toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })
        : '—';

    const content = `
        <div class="proposal-info">
            ${expiryCountdownHtml}
            <div class="proposal-badges-row" style="display: flex; justify-content: center; align-items: center; gap: 6px; margin: 10px 0;">
                <div class="proposal-status ${statusBadgeClass}">${statusBadgeLabel}</div>
                <div class="proposal-application-status ${mapStatusBadgeClass}">
                    ${mapStatusBadgeLabel}
                </div>
                <div class="proposal-conditionality ${conditionalBadgeClass}" title="${conditionalBadgeTitle}">
                    ${conditionalBadgeLabel}
                </div>
                ${(() => {
            const label = isMinted
                ? tProposal('panel.proposal.lifecycle.minted', 'Minted')
                : tProposal('panel.proposal.lifecycle.inMemory', 'In-memory');
            const baseClasses = 'proposal-mint-state' + (isMinted ? ' is-minted minted-glow' : ' is-local');
            const style = `display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 10px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: ${isMinted ? '#065f46' : '#7a6000'}; background: ${isMinted ? '#d1fae5' : '#fff7d6'}; border: 1px solid ${isMinted ? '#34d399' : '#ffe08a'}; text-decoration: none; cursor: ${mintedExplorerUrl ? 'pointer' : 'default'};`;
            if (isMinted && mintedExplorerUrl) {
                return `<a class="${baseClasses}" style="${style}" href="${mintedExplorerUrl}" target="_blank" rel="noopener" title="${tProposal('panel.proposal.lifecycle.viewOnExplorer', 'View on explorer')}">${label}</a>`;
            }
            return `<div class="${baseClasses}" style="${style}" title="${isMinted ? tProposal('panel.proposal.lifecycle.mintedHint', 'Minted on-chain') : ''}">${label}</div>`;
        })()}
            </div>
            <div class="proposal-description-row" style="text-align: center; margin: 10px 0; padding: 0 10px;">
                ${escapedProposalDescription}
                ${escapedProposalDisplayId ? `<div class="proposal-id-row">
                    <div class="proposal-id-label" style="font-size: 12px; color: #666;">ID: ${escapedProposalDisplayId}</div>
                    ${lensButtonHtml}
                </div>` : ''}
            </div>
            ${parcelAcceptancePlaceholder}
            ${ownerAcceptancePlaceholder}

            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                        <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${formatAuthorForDisplay(proposal.author)}</a>
                                    `;
                }
            }
            return formatAuthorForDisplay(proposal.author);
        })()}
                </div>
            </div>
            ${proposal.offer ? (() => {
            const currentOffer = typeof calculateDecayedOffer === 'function' ? calculateDecayedOffer(proposal) : proposal.offer;
            const decayProgress = proposal.decayEnabled && typeof getDecayProgress === 'function' ? getDecayProgress(proposal) : 0;
            const hasDecay = proposal.decayEnabled && proposal.decayPercent > 0 && proposal.decayDurationMs > 0;
            const decayedPercent = hasDecay ? (proposal.decayPercent * decayProgress) : 0;
            const remainingPercent = 100 - decayedPercent;
            const targetPercent = hasDecay ? (100 - proposal.decayPercent) : 100;
            const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
            const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';
            const originalAmountText = tProposal('panel.proposal.metrics.offerOriginal', '(was {{amount}})', {
                amount: `${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}`
            });

            // Deposit indicator - bars inside offer bar, warning text only if no deposit
            const hasDeposit = proposal.depositEnabled && proposal.depositPercent > 0;
            const depositPercent = hasDeposit ? proposal.depositPercent : 0;

            // Generate deposit bars HTML (to go inside offer bar)
            let depositBarsHtml = '';
            if (hasDeposit) {
                const fullRows = Math.floor(depositPercent / 100);
                const partialPercent = depositPercent % 100;

                for (let i = 0; i < fullRows; i++) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill" style="width: 100%;"></div></div>`;
                }
                if (partialPercent > 0 || fullRows === 0) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill${fullRows > 0 ? ' overflow' : ''}" style="width: ${partialPercent || depositPercent}%;"></div></div>`;
                }
            }

            // Warning text only shown when no deposit
            const noDepositWarningHtml = !hasDeposit ? `
            <div class="proposal-no-deposit-warning">⚠️ ${tProposal('panel.proposal.offer.noDepositWarning', 'No deposit - proposal not backed by funds')}</div>` : '';
            const boostLabel = tProposal('panel.proposal.boost.buttonLabel', 'Boost this proposal');

            if (hasDecay) {
                return `
            <div class="proposal-offer-bar with-decay${hasDeposit ? ' with-deposit' : ''}" data-proposal-id="${proposal.proposalId || ''}" data-original-offer="${proposal.offer}" data-decay-percent="${proposal.decayPercent}" data-decay-duration="${proposal.decayDurationMs}" data-created-at="${proposal.createdAt}">
                <div class="offer-bar-background">
                    <div class="offer-bar-remaining" style="width: ${remainingPercent}%;"></div>
                    <div class="offer-bar-decayed" style="width: ${decayedPercent}%;"></div>
                    <div class="offer-bar-target-line" style="left: ${targetPercent}%;"></div>
                </div>
                <div class="offer-bar-content">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount decaying">${currencySymbol}${Math.round(currentOffer).toLocaleString('hr-HR')}${currencySuffix}</span>
                        <span class="offer-original">${originalAmountText}</span>
                    </div>
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalId || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            } else {
                return `
            <div class="proposal-offer-bar${hasDeposit ? ' with-deposit' : ''}">
                <div class="offer-bar-content-simple">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount">${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}</span>
                    </div>
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalId || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            }
        })() : ''}
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.parcels', 'Parcels in Proposal:')}</span> <span class="metric-value">${proposal.parentParcelIds.length}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.owners', 'Owners in Proposal:')}</span> <span class="metric-value">${(() => {
            // For road/track proposals, use individualOwners from ownershipAndAcquisitionStats if available
            // This is more accurate than counting ownerAcceptance entries which may not be populated
            const roadProposal = fullProposal.roadProposal || proposal.roadProposal;
            const stats = roadProposal?.definition?.metadata?.ownershipAndAcquisitionStats ||
                fullProposal.ownershipAndAcquisitionStats ||
                proposal.ownershipAndAcquisitionStats;
            if (stats && stats.individualOwners !== null && stats.individualOwners !== undefined) {
                return stats.individualOwners;
            }
            // Fallback to owner acceptance count if stats not available
            return ownerAcceptanceSummaryFast.totalOwners;
        })()}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.area', 'Total Area:')}</span> <span class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.created', 'Created:')}</span> <span class="metric-value">${createdAtLabel}</span>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            ${parentParcels.length > 0 ? `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.ancestorsParcels', 'Parents (Parcels):')}</span> <span class="metric-value">${parentParcels.length}</span>
                </div>
                <div class="proposal-parcels-list" id="proposal-parent-parcels-list" style="max-height: 420px; overflow-y: auto;">
                    ${parentParcelItemsInitial}
                </div>
            </div>
            ` : `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.ancestorsParcels', 'Ancestors (Parcels):')}</span> <span class="metric-value">0</span>
            </div>
            `}
            
            <!-- Ancestors (Proposals) Section -->
            <div class="metric-group" id="proposal-ancestors-proposals-section">
                <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                <div class="metric-value" id="proposal-ancestors-proposals-content">Loading...</div>
            </div>
            
            <!-- Descendants Section -->
            ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                if (descendantKeys.length > 0) {
                    return `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">${descendantKeys.length}</span>
                </div>
                <div class="proposal-descendants-list" id="proposal-descendants-list" style="max-height: 420px; overflow-y: auto;">
                    ${descendantItemsInitial}
                </div>
            </div>`;
                } else {
                    return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">0</span>
            </div>`;
                }
            }
            return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">0</span>
            </div>`;
        })()}
            
            <!-- Ownership & Acquisition Stats Section -->
            ${(() => {
            // Check if proposal has ownershipAndAcquisitionStats
            const roadProposal = fullProposal.roadProposal || proposal.roadProposal;
            const stats = roadProposal?.definition?.metadata?.ownershipAndAcquisitionStats ||
                fullProposal.ownershipAndAcquisitionStats ||
                proposal.ownershipAndAcquisitionStats;

            if (!stats) {
                return '';
            }

            const statsItems = [];

            if (stats.individualOwners !== null && stats.individualOwners !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.individualOwners', 'Individual Owners:')}</span>
                        <span class="metric-value">${stats.individualOwners}</span>
                    </div>
                `);
            }
            if (stats.ownershipCounts) {
                if (stats.ownershipCounts.individual !== null && stats.ownershipCounts.individual !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByIndividuals', 'Owned by Individuals:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.individual}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.company !== null && stats.ownershipCounts.company !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByCompanies', 'Owned by Companies:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.company}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.government !== null && stats.ownershipCounts.government !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByGovernment', 'Owned by Government:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.government}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.institution !== null && stats.ownershipCounts.institution !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByInstitution', 'Owned by Institution:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.institution}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.mixed !== null && stats.ownershipCounts.mixed !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownershipMixed', 'Ownership Mixed:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.mixed}</span>
                        </div>
                    `);
                }
            }
            if (stats.totalMarketPrice !== null && stats.totalMarketPrice !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalMarketPrice', 'Total Market Price:')}</span>
                        <span class="metric-value">${Math.round(stats.totalMarketPrice).toLocaleString('hr-HR')} EUR</span>
                    </div>
                `);
            }
            if (stats.totalAcquiringDifficulty !== null && stats.totalAcquiringDifficulty !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalAcquiringDifficulty', 'Total Acquiring Difficulty:')}</span>
                        <span class="metric-value">${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</span>
                    </div>
                `);
            }

            if (statsItems.length === 0) {
                return '';
            }

            return `
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label" style="font-weight: 600; margin-bottom: 10px;">${tProposal('panel.proposal.sections.ownershipStats', 'Ownership & Acquisition Stats')}</div>
            </div>
            ${statsItems.join('')}
            `;
        })()}
        </div>
    `;

    const perfEndHtml = performance.now();
    console.debug('[showProposalInfo] HTML content generated', {
        timeMs: (perfEndHtml - perfStartHtml).toFixed(2),
        htmlLength: content.length,
        note: 'HTML includes proposal metadata, ancestor parcels list, owner acceptance status, etc.'
    });

    // Preserve scroll/anchor before the DOM rewrite
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    let preservedScrollTop = panelBody ? panelBody.scrollTop : 0;
    let anchorKey = null;
    let anchorOffset = null;

    if (preserveScrollPosition && typeof preserveScrollPosition === 'object') {
        if (typeof preserveScrollPosition.scrollTop === 'number') {
            preservedScrollTop = preserveScrollPosition.scrollTop;
        }
        if (typeof preserveScrollPosition.anchorKey === 'string') {
            anchorKey = preserveScrollPosition.anchorKey;
        }
        if (typeof preserveScrollPosition.anchorOffset === 'number') {
            anchorOffset = preserveScrollPosition.anchorOffset;
        }
    } else if (typeof preserveScrollPosition === 'number') {
        preservedScrollTop = preserveScrollPosition;
    }

    // Show loading spinner briefly while rendering (for large proposals)
    // WHY HTML: The HTML string contains the entire proposal details UI:
    //   - Proposal metadata (title, description, author, dates)
    //   - Status badges (applied, minted, conditional, etc.)
    //   - Offer/decay visualization
    //   - Owner acceptance status
    //   - List of all ancestor parcels with their details (parcel numbers, owners, acceptance status)
    //   - Ancestors/descendants proposals
    //   - Ownership & acquisition stats
    // This HTML is inserted into #proposal-details-content to display the proposal info panel
    console.debug('[showProposalInfo] Getting proposal details content element...', { parcelIdsCount: parcelIds.length });
    const detailsContent = document.getElementById('proposal-details-content');
    function populateAcceptanceSectionsAsync(proposalForStatus, precomputedOwnerSummary) {
        const parcelContainer = document.getElementById('proposal-parcel-acceptance-section');
        const ownerContainer = document.getElementById('proposal-owner-acceptance-section');
        if (!parcelContainer && !ownerContainer) return;

        const doWork = () => {
            const parcelStart = performance.now();
            if (parcelContainer) {
                const parcelHtml = buildParcelAcceptanceStatusHtml(proposalForStatus);
                parcelContainer.innerHTML = parcelHtml || '';
            }
            const parcelAcceptanceMs = (performance.now() - parcelStart).toFixed(2);

            const ownerStart = performance.now();
            let ownerSummary = precomputedOwnerSummary || buildProposalOwnerAcceptanceSummaryFast(proposalForStatus);
            if (!ownerSummary || ownerSummary.totalOwners === 0) {
                ownerSummary = buildProposalOwnerAcceptanceSummary(proposalForStatus);
            }
            if (ownerContainer) {
                const ownerHtml = buildOwnerAcceptanceStatusHtml(proposalForStatus, ownerSummary);
                ownerContainer.innerHTML = ownerHtml || '';
            }
            const ownerAcceptanceMs = (performance.now() - ownerStart).toFixed(2);

            console.info('[showProposalInfo] Acceptance async render', {
                ownerAcceptanceMs,
                ownerCount: ownerSummary?.totalOwners || 0,
                parcelAcceptanceMs,
                parcelCount: Array.isArray(proposalForStatus?.parentParcelIds) ? proposalForStatus.parentParcelIds.length : 0
            });
        };

        // Let the panel paint first, then populate acceptance sections
        requestAnimationFrame(() => setTimeout(doWork, 0));
    }

    const runPostRender = () => {
        // Lazy append remaining ancestor parcels
        setupLazyList('proposal-parent-parcels-list', parentParcelItemsRemaining, renderAncestorParcelItem);
        // Lazy append remaining descendant parcels
        setupLazyList('proposal-descendants-list', descendantItemsRemaining, renderDescendantItem);
        // Render ancestor proposals list (after DOM exists)
        renderAncestorsProposalsSection();
        // Populate acceptance sections asynchronously to avoid blocking panel open
        populateAcceptanceSectionsAsync(fullProposal || proposal, ownerAcceptanceSummaryFast);
    };

    if (detailsContent && parcelIds.length > 20) {
        console.debug('[showProposalInfo] Large proposal detected, showing loading spinner first...');
        // Only show spinner for proposals with many parcels
        const loadingText = tProposal('panel.proposal.rendering', 'Rendering proposal details...');
        detailsContent.innerHTML = `
            <div class="loader-spinner" role="status" aria-live="polite" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; min-height: 200px;">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text" style="margin-top: 16px; color: #666;">${loadingText}</span>
            </div>
        `;
        console.debug('[showProposalInfo] Loading spinner set, scheduling content render...');

        // Defer heavy DOM insertion and chunk it across animation frames
        setTimeout(() => {
            console.debug('[showProposalInfo] Rendering proposal content (large proposal) in chunks...');
            if (!detailsContent) return;

            const container = document.createElement('div');
            container.innerHTML = content;
            const nodes = Array.from(container.childNodes);
            detailsContent.innerHTML = '';

            const chunkSize = 50;
            let index = 0;

            const appendChunk = () => {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < chunkSize && index < nodes.length; i++, index++) {
                    frag.appendChild(nodes[index]);
                }
                detailsContent.appendChild(frag);
                if (index < nodes.length) {
                    requestAnimationFrame(appendChunk);
                } else {
                    console.debug('[showProposalInfo] Proposal content rendered to DOM');
                    runPostRender();
                }
            };

            requestAnimationFrame(appendChunk);
        }, 0);
    } else {
        console.debug('[showProposalInfo] Rendering proposal content directly (small proposal or no spinner needed)...');
        // Set innerHTML which resets scroll to 0
        if (detailsContent) {
            detailsContent.innerHTML = content;
            console.debug('[showProposalInfo] Proposal content rendered to DOM');
            runPostRender();
        } else {
            console.warn('[showProposalInfo] Proposal details content element not found');
        }
    }

    // Populate footer with action buttons
    const footer = document.getElementById('proposal-details-footer');
    if (footer) {
        footer.innerHTML = primaryActionsHtml;
        const defaultActionButton = footer.querySelector('.proposal-action-default');
        if (defaultActionButton && typeof defaultActionButton.focus === 'function' && !defaultActionButton.disabled) {
            requestAnimationFrame(() => {
                defaultActionButton.focus({ preventScroll: true });
            });
        }
    }

    // Ensure lens pattern is applied after render when lens exists
    try {
        if (hasProposalLens) {
            const btn = document.querySelector('#proposal-details-content .proposal-lens-button');
            if (btn) {
                applyLensPatternToButton(btn, proposalLensEntries);
            }
        }
    } catch (err) {
        console.warn('post-render lens pattern apply failed', err);
    }

    // If lens missing but on-chain, attempt a lazy fetch to hydrate and repaint the button
    (async () => {
        try {
            if (!hasProposalLens && fullProposal && fullProposal.onchain && fullProposal.onchain.proposalId) {
                const fetchedLens = await fetchLensFromChain(fullProposal);
                if (fetchedLens && fetchedLens.length) {
                    fullProposal.lens = fetchedLens;
                    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') {
                        proposalStorage._indexProposal(fullProposal);
                        if (typeof proposalStorage.save === 'function') proposalStorage.save();
                    }
                    const btn = document.querySelector('#proposal-details-content .proposal-lens-button');
                    if (btn) {
                        applyLensPatternToButton(btn, fetchedLens);
                        btn.classList.remove('proposal-lens-button--empty');
                        btn.disabled = false;
                        btn.onclick = () => openProposalLens(lensProposalId);
                    }
                }
            }
        } catch (err) {
            console.warn('lazy lens hydration failed', err);
        }
    })();

    function renderAncestorsProposalsSection() {
        try {
            const ancestorsSection = document.getElementById('proposal-ancestors-proposals-section');
            const ancestorsContent = document.getElementById('proposal-ancestors-proposals-content');
            if (!ancestorsSection || !ancestorsContent) return false;

            // Fast path: derive ancestors from in-memory parentParcels (already built above) to avoid
            // reading/parsing persisted parcel records.
            const ancestorsSet = new Set();
            if (Array.isArray(parentParcels) && parentParcels.length > 0) {
                parentParcels.forEach(ap => {
                    const anc = ap?.feature?.properties?.ancestorProposal;
                    if (anc) ancestorsSet.add(String(anc));
                });
            }

            // Backup: consult persisted parcel records for ancestorProposal linkage without hydrating layers
            if (ancestorsSet.size === 0 && Array.isArray(parentParcelIds) && parentParcelIds.length > 0) {
                parentParcelIds.forEach(parcelId => {
                    try {
                        const record = readPersistedParcelRecord(parcelId);
                        const anc = record?.properties?.ancestorProposal;
                        if (anc) ancestorsSet.add(String(anc));
                    } catch (_) { }
                });
            }

            // Fallback: query ProposalManager for ancestor linkage using parcel IDs
            if (ancestorsSet.size === 0 && typeof ProposalManager !== 'undefined') {
                const parcelsToCheck = (fullProposal.roadProposal && Array.isArray(parentParcelIds) && parentParcelIds.length > 0)
                    ? parentParcelIds
                    : proposal.parentParcelIds;

                parcelsToCheck.forEach(parcelId => {
                    const parcelAncestors = ProposalManager._getParcelAncestors(parcelId);
                    parcelAncestors.forEach(ancestorHash => {
                        ancestorsSet.add(String(ancestorHash));
                    });
                });
            }

            const ancestors = Array.from(ancestorsSet);

            if (ancestors.length > 0) {
                const ancestorsHtml = ancestors.map(ancestorId => {
                    const ancestorData = proposalStorage.getProposal(ancestorId);
                    if (ancestorData) {
                        return `<div class="ancestor-item" data-proposal-id="${ancestorData.proposalId || ancestorId}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                            <strong>${ancestorData.title}</strong> (${ancestorData.type || 'proposal'})
                        </div>`;
                    }
                    return null;
                }).filter(Boolean).join('');

                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="proposal-ancestors-list" id="proposal-ancestors-proposals-content">${ancestorsHtml}</div>
                `;

                // Attach event listeners for ancestor items (same as in showProposalInfo)
                const ancestorItems = ancestorsSection.querySelectorAll('.ancestor-item[data-proposal-id]');
                ancestorItems.forEach(item => {
                    item.addEventListener('mouseenter', () => {
                        try {
                            if (typeof handleAncestorItemHover === 'function') {
                                handleAncestorItemHover(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('mouseleave', () => {
                        try {
                            if (typeof clearProposalHoverLayers === 'function') {
                                clearProposalHoverLayers();
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('focus', () => {
                        try {
                            if (typeof handleAncestorItemHover === 'function') {
                                handleAncestorItemHover(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('blur', () => {
                        try {
                            if (typeof clearProposalHoverLayers === 'function') {
                                clearProposalHoverLayers();
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        try {
                            if (typeof handleAncestorItemClick === 'function') {
                                handleAncestorItemClick(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            try {
                                if (typeof handleAncestorItemClick === 'function') {
                                    handleAncestorItemClick(item);
                                }
                            } catch (_) { }
                        }
                    });
                });
            } else {
                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="metric-value" id="proposal-ancestors-proposals-content">0</div>
                `;
            }
            return true;
        } catch (err) {
            console.warn('Failed to populate ancestors proposals section', err);
            const ancestorsSection = document.getElementById('proposal-ancestors-proposals-section');
            const ancestorsContent = document.getElementById('proposal-ancestors-proposals-content');
            if (ancestorsSection && ancestorsContent) {
                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="metric-value">0</div>
                `;
            }
            return false;
        }
    }

    function setupLazyList(containerId, items, renderItem) {
        if (!items || items.length === 0) return;
        const container = document.getElementById(containerId);
        if (!container) return;

        let nextIndex = 0;
        const batchSize = 20;

        const appendBatch = () => {
            const frag = document.createDocumentFragment();
            for (let i = 0; i < batchSize && nextIndex < items.length; i++, nextIndex++) {
                const html = renderItem(items[nextIndex]);
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html;
                while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
            }
            container.appendChild(frag);
        };

        // Append as the user scrolls near the end
        const maybeAppend = () => {
            if (!container) return;
            const { scrollTop, clientHeight, scrollHeight } = container;
            const threshold = 120;
            if (scrollTop + clientHeight >= scrollHeight - threshold) {
                appendBatch();
                if (nextIndex >= items.length) {
                    container.removeEventListener('scroll', maybeAppend);
                }
            }
        };

        // Initial batch
        appendBatch();
        if (nextIndex < items.length) {
            container.addEventListener('scroll', maybeAppend);
        }
    }

    // Restore scroll position or anchor row after the DOM rewrite
    const combinedPreserveState = {
        scrollTop: preservedScrollTop,
        anchorKey,
        anchorOffset,
        parcelId: preserveScrollPosition && typeof preserveScrollPosition === 'object'
            ? preserveScrollPosition.parcelId || currentParcelId || null
            : currentParcelId
    };
    restoreProposalDetailsScroll(combinedPreserveState);

    // Show dashed building outlines while the details modal is open (only for unapplied building proposals)
    try {
        if (isBuildingProposal && !appliedState) {
            renderProposalBuildingPreview(fullProposal || proposal);
        } else {
            const groups = ensureProposalOverlayGroups();
            if (groups.buildingPreview) groups.buildingPreview.clearLayers();
        }
    } catch (error) {
        console.warn('Failed to render building preview overlay', error);
    }

    // Add hover-based map highlighting for parcels listed in the proposal details
    try {
        // Clear any previous hover overlay when rendering
        clearProposalInfoHoverOverlay();
        const proposalDetailsContainer = document.getElementById('proposal-details-content');
        const proposalParcelItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.proposal-parcel-item[data-parcel-id]')
            : [];
        proposalParcelItems.forEach(item => {
            const hoveredParcelId = item.getAttribute('data-parcel-id');
            if (!hoveredParcelId) return;
            item.addEventListener('mouseenter', () => {
                try {
                    showProposalInfoHoverOverlay(hoveredParcelId);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalInfoHoverOverlay();
                } catch (_) { }
            });
        });

        const descendantItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.descendant-item[data-descendant-type]')
            : [];
        descendantItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleDescendantItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleDescendantItemClick(item);
                    } catch (_) { }
                }
            });
        });

        const ancestorItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.ancestor-item[data-proposal-id]')
            : [];
        ancestorItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleAncestorItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleAncestorItemClick(item);
                    } catch (_) { }
                }
            });
        });
    } catch (_) { }

    console.debug('[showProposalInfo] Initializing expiry and decay countdowns...');
    // Initialize expiry countdown timer if present
    initializeExpiryCountdown();

    // Initialize decay countdown animation if present
    initializeDecayCountdown();
    console.debug('[showProposalInfo] Countdowns initialized');

    console.debug('[showProposalInfo] Making proposal details panel visible...');
    const detailsPanel = document.getElementById('proposal-details-panel');
    if (detailsPanel) {
        detailsPanel.classList.add('visible');
        console.debug('[showProposalInfo] Panel made visible');
    } else {
        console.warn('[showProposalInfo] Proposal details panel element not found');
    }
    document.body.classList.add('proposal-details-open');
    console.debug('[showProposalInfo] Body class added, proposal details should now be visible');
    // Close on Escape when this panel is the active proposal surface
    installProposalDetailsEscapeHandler();

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

function resolveProposalForBoost(idOrHash) {
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.findProposalByIdOrHash === 'function') {
        const found = proposalStorage.findProposalByIdOrHash(idOrHash);
        if (found) return found;
    }
    if (window.currentlyHighlightedProposal) return window.currentlyHighlightedProposal;
    return null;
}

function openProposalBoostDialog(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const existing = document.getElementById('proposalBoostOverlay');
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }

    const boostKey = proposal.proposalId || proposal.proposalId || '';
    const overlay = document.createElement('div');
    overlay.id = 'proposalBoostOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeProposalBoostDialog();
        }
    });

    const modalTitle = tProposalUI('panel.proposal.boost.title', 'Boost the proposal');
    const modalCloseLabel = tProposalUI('panel.proposal.boost.closeLabel', 'Close boost dialog');
    const modalCopy = tProposalUI('panel.proposal.boost.copy', 'The proposal creator, but also anyone else, can boost any proposal by sending money to it. If the proposal expires before executing the donations will be refunded.');
    const sendLabel = tProposalUI('panel.proposal.boost.send', 'Send');
    const expiryLabel = tProposalUI('panel.proposal.boost.expiryLabel', 'Boost expiry timestamp (optional)');
    const expiryPlaceholder = tProposalUI('panel.proposal.boost.expiryPlaceholder', 'YYYY-MM-DDTHH:MM:SSZ or epoch seconds');
    const expiryHint = tProposalUI('panel.proposal.boost.expiryHint', 'Optional: add a timestamp after which this boost should expire.');
    const cityTokenLabel = tProposalUI('panel.proposal.boost.cityTokenLabel', 'City Meme Token');

    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true">
            <div class="proposal-boost-header">
                <h3>${modalTitle}</h3>
                <button type="button" class="proposal-boost-close" aria-label="${modalCloseLabel}" onclick="closeProposalBoostDialog()">×</button>
            </div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">${modalCopy}</p>
                <div class="proposal-offer-row proposal-boost-row" style="display:flex; gap:8px; align-items:center;">
                    <input type="text" id="proposalBoostAmount" placeholder="0" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                    <select id="proposalBoostCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                        <option value="CITY">${cityTokenLabel}</option>
                        <option value="ETH">ETH</option>
                        <option value="USDC">USDC</option>
                        <option value="USDT">USDT</option>
                        <option value="EUR">EUR</option>
                        <option value="USD">USD</option>
                        <option value="ARS">ARS</option>
                    </select>
                </div>
                <div class="proposal-boost-row proposal-boost-expiry">
                    <label for="proposalBoostExpiry" class="proposal-boost-expiry-label">${expiryLabel}</label>
                    <input type="text" id="proposalBoostExpiry" placeholder="${expiryPlaceholder}" autocomplete="off" inputmode="text">
                    <div class="proposal-boost-expiry-hint">${expiryHint}</div>
                </div>
                <div class="proposal-boost-actions" style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                    <button type="button" class="btn proposal-boost-send" style="min-width:100px; width:120px;" onclick="submitProposalBoost('${boostKey}')">${sendLabel}</button>
                    <div class="proposal-boost-status" id="proposalBoostStatus" aria-live="polite" style="font-size:12px; text-align:center; min-height:18px;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const currencySelect = overlay.querySelector('#proposalBoostCurrency');
    const defaultCurrency = proposal.offerCurrency || 'CITY';
    if (currencySelect) {
        const optionExists = Array.from(currencySelect.options).some(opt => opt.value === defaultCurrency);
        if (optionExists) {
            currencySelect.value = defaultCurrency;
        } else {
            currencySelect.value = 'CITY';
        }
    }
    if (currencySelect && !currencySelect.value) {
        currencySelect.value = 'CITY';
    }

    const amountInput = overlay.querySelector('#proposalBoostAmount');
    if (amountInput) {
        amountInput.focus();
        if (typeof amountInput.select === 'function') {
            amountInput.select();
        }
    }
}

function closeProposalBoostDialog() {
    const overlay = document.getElementById('proposalBoostOverlay');
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

function normalizeChainIdForBoost(chainIdInput) {
    if (chainIdInput === undefined || chainIdInput === null) return null;
    try {
        if (typeof chainIdInput === 'bigint') return chainIdInput.toString();
        if (typeof chainIdInput === 'number') {
            if (!Number.isFinite(chainIdInput)) return null;
            return Math.trunc(chainIdInput).toString();
        }
        if (typeof chainIdInput === 'string') {
            const trimmed = chainIdInput.trim();
            if (!trimmed) return null;
            if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
                return BigInt(trimmed).toString();
            }
            const num = Number(trimmed);
            if (Number.isFinite(num)) {
                return Math.trunc(num).toString();
            }
            return trimmed;
        }
    } catch (_) {
        return null;
    }
    return null;
}

async function submitProposalBoost(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const amountInput = document.getElementById('proposalBoostAmount');
    const currencySelect = document.getElementById('proposalBoostCurrency');
    const expiryInput = document.getElementById('proposalBoostExpiry');
    const statusEl = document.getElementById('proposalBoostStatus');
    const setBoostStatus = (text = '') => {
        if (statusEl) {
            statusEl.textContent = text;
        }
    };
    setBoostStatus('');
    const rawAmount = amountInput ? amountInput.value : '';
    const amount = typeof parseProposalOfferValue === 'function'
        ? parseProposalOfferValue(rawAmount)
        : 0;

    if (!amount || amount <= 0) {
        showProposalAlertMessage('please_enter_a_valid_boost_amount', 'Please enter a valid boost amount.');
        return;
    }

    const currency = (currencySelect && currencySelect.value) ? currencySelect.value : 'USDT';
    const rawBoostExpiry = expiryInput ? expiryInput.value.trim() : '';
    const boostExpiryTimestamp = rawBoostExpiry ? parseBoostExpiryInput(rawBoostExpiry) : null;
    if (rawBoostExpiry && !boostExpiryTimestamp) {
        showProposalAlertMessage('please_enter_a_valid_boost_expiry', 'Please enter a valid boost expiry timestamp.');
        return;
    }

    const supportedBoostCurrencies = ['CITY', 'ETH'];
    if (!supportedBoostCurrencies.includes(currency)) {
        showProposalAlertMessage('proposal_boost_failed', 'Currency currently not supported [OK]');
        return;
    }

    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const nftInfo = getProposalNftInfo(proposal);
    if (!nftInfo || !nftInfo.tokenId) {
        showProposalAlertMessage('proposal_boost_not_minted', 'This proposal is not on-chain yet. Mint it before boosting.');
        return;
    }

    if (!window.walletManager || typeof window.walletManager.getState !== 'function') {
        showProposalAlertMessage('proposal_boost_wallet_required', 'Connect a wallet to boost this proposal.');
        if (typeof handleWalletButtonClick === 'function') {
            handleWalletButtonClick();
        }
        return;
    }

    const walletState = window.walletManager.getState();
    const isConnected = walletState && walletState.status === 'connected' && walletState.accounts && walletState.accounts.length > 0;
    if (!isConnected) {
        showProposalAlertMessage('proposal_boost_wallet_required', 'Connect a wallet to boost this proposal.');
        if (typeof handleWalletButtonClick === 'function') {
            handleWalletButtonClick();
        }
        return;
    }

    const targetChainId = normalizeChainIdForBoost(nftInfo.chain || walletState.chainId || window.DEFAULT_CHAIN_ID || null);
    const contractAddress = nftInfo.contract || null;

    if (!targetChainId || !contractAddress) {
        showProposalAlertMessage('proposal_boost_contract_missing', 'Proposal contract address is not configured for this network.');
        return;
    }

    const walletChainId = normalizeChainIdForBoost(walletState.chainId);
    if (walletChainId && walletChainId !== targetChainId && window.walletManager && typeof window.walletManager.switchChain === 'function') {
        try {
            await window.walletManager.switchChain(targetChainId);
        } catch (switchError) {
            console.warn('Boost: network switch rejected or failed', switchError);
            showProposalAlertMessage('proposal_boost_switch_network', 'Switch your wallet to network {{chainId}} to boost this proposal.', { chainId: targetChainId });
            return;
        }
    }

    if (!window.ProposalChainBridge || typeof window.ProposalChainBridge.contributeToProposal !== 'function') {
        showProposalAlertMessage('proposal_boost_failed', 'Boost transaction failed: blockchain bridge unavailable.');
        return;
    }

    const handleStatusUpdate = status => {
        if (status === 'approve') {
            setBoostStatus('Waiting for approve confirmation...');
        } else if (status === 'transfer') {
            setBoostStatus('Waiting for transfer confirmation...');
        }
    };

    if (currency === 'CITY') {
        setBoostStatus('You will be asked for two transactions, Approve and Transfer');
    } else {
        setBoostStatus('Waiting for transfer confirmation...');
    }

    let txResult = null;
    try {
        txResult = await window.ProposalChainBridge.contributeToProposal({
            proposalId: nftInfo.tokenId,
            chainId: targetChainId,
            contractAddress,
            currency,
            amount,
            onStatus: handleStatusUpdate
        });
    } catch (error) {
        setBoostStatus('');
        const code = error && error.code;
        if (code === 'CITY_TOKEN_MISSING') {
            showProposalAlertMessage('proposal_boost_missing_token', 'City Meme Token address is not configured for the connected network.');
            return;
        }
        if (code === 'CONTRACT_MISSING' || code === 'CONTRACT_NOT_FOUND' || code === 'CONTRACT_INVALID') {
            showProposalAlertMessage('proposal_boost_contract_missing', 'Proposal contract address is not configured for this network.');
            return;
        }
        if (code === 'WALLET_NOT_CONNECTED' || code === 'WALLET_NOT_READY') {
            showProposalAlertMessage('proposal_boost_wallet_required', 'Connect a wallet to boost this proposal.');
            if (typeof handleWalletButtonClick === 'function') {
                handleWalletButtonClick();
            }
            return;
        }
        if (code === 'WRONG_NETWORK') {
            showProposalAlertMessage('proposal_boost_switch_network', 'Switch your wallet to network {{chainId}} to boost this proposal.', { chainId: targetChainId });
            return;
        }
        if (code === 'UNSUPPORTED_CURRENCY') {
            showProposalAlertMessage('proposal_boost_failed', 'Currency currently not supported [OK]');
            return;
        }

        const reason = error && (error.reason || error.shortMessage || error.message) ? (error.reason || error.shortMessage || error.message) : 'Unknown error';
        showProposalAlertMessage('proposal_boost_failed', `Boost transaction failed: ${reason}`, { reason });
        return;
    }

    const baseOffer = typeof proposal.offer === 'number'
        ? proposal.offer
        : parseProposalOfferValue(proposal.offer);
    const updatedOffer = (baseOffer || 0) + amount;

    const updatedProposal = {
        ...proposal,
        offer: updatedOffer,
        offerCurrency: currency,
        lastBoostExpiryTimestamp: boostExpiryTimestamp || null,
        updatedAt: new Date().toISOString(),
        proposalId: proposal.proposalId || idOrHash
    };

    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(updatedProposal);
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
    }

    window.currentlyHighlightedProposal = updatedProposal;

    closeProposalBoostDialog();

    const txLink = txResult && txResult.explorerUrl
        ? txResult.explorerUrl
        : '';
    const amountDisplay = typeof rawAmount === 'string' && rawAmount.trim() ? rawAmount.trim() : String(amount);
    const alertOptions = txLink
        ? { linkUrl: txLink, linkText: 'See transaction on Etherscan' }
        : {};

    showProposalAlertMessage(
        'proposal_boost_success',
        'Success! Thank you for boosting this proposal with {{amount}} of {{currency}}. This could help it happen 🤞 See transaction {{txLink}}',
        { amount: amountDisplay, currency, txLink: txLink },
        alertOptions
    );

    try {
        showProposalInfo(updatedProposal, window.selectedParcelInProposal);
    } catch (error) {
        console.warn('Failed to refresh proposal details after boost', error);
    }

    if (typeof refreshProposalsLayer === 'function') {
        try { refreshProposalsLayer(); } catch (_) { }
    }

    function parseBoostExpiryInput(rawValue) {
        if (!rawValue) return null;

        // Accept epoch seconds/milliseconds
        const numeric = Number(rawValue);
        if (!Number.isNaN(numeric) && numeric > 0) {
            const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
            const numericDate = new Date(milliseconds);
            return Number.isNaN(numericDate.getTime()) ? null : numericDate.toISOString();
        }

        // Accept ISO 8601 or other date-compatible strings
        const date = new Date(rawValue);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
}


function focusParcelInMap(parcelId) {
    if (!parcelId || typeof map === 'undefined' || !map) return;
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) return;

    try {
        const layer = multiParcelSelection.findParcelById(parcelId);
        if (!layer) return;

        if (!isCameraMovementSuppressed() && typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
                return;
            }
        }

        if (!isCameraMovementSuppressed() && typeof layer.getLatLng === 'function') {
            map.panTo(layer.getLatLng());
        }
    } catch (error) {
        console.warn('focusParcelInMap: unable to focus parcel', parcelId, error);
    }
}

function handleDescendantItemHover(element) {
    if (!element) return;
    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalId = element.getAttribute('data-proposal-id');
        if (proposalId) {
            highlightProposalHoverById(proposalId, {
                color: '#4DB6AC',
                weight: 4,
                dashArray: '4 4',
                showLabels: true,
                includeParents: false
            });
        }
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (parcelId) {
            highlightParcelHover(parcelId, {
                color: '#FFEB3B',
                weight: 6,
                dashArray: '10 8',
                showLabels: true
            });
        }
    }
}

function handleDescendantItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalIdAttr = element.getAttribute('data-proposal-id');
        if (!proposalIdAttr) return;
        const descendantProposal = getProposalByIdOrHash(proposalIdAttr);
        if (!descendantProposal) return;
        const parentIds = Array.isArray(descendantProposal.parentParcelIds) ? descendantProposal.parentParcelIds : [];
        const fallbackParcel = parentIds[0] || null;
        selectAndHighlightProposal(getProposalKey(descendantProposal) || proposalIdAttr, fallbackParcel, true);
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (!parcelId) return;
        focusParcelInMap(parcelId);
        highlightParcelHover(parcelId, {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true
        });
    }
}

function handleAncestorItemHover(element) {
    if (!element) return;
    const proposalId = element.getAttribute('data-proposal-id');
    if (!proposalId) return;
    highlightProposalHoverById(proposalId, {
        color: '#FFB74D',
        weight: 4,
        dashArray: '6 3',
        showLabels: true,
        includeParents: false
    });
}

function handleAncestorItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const proposalIdAttr = element.getAttribute('data-proposal-id');
    if (!proposalIdAttr) return;
    const ancestorProposal = getProposalByIdOrHash(proposalIdAttr);
    if (!ancestorProposal) return;
    const parentIds = Array.isArray(ancestorProposal.parentParcelIds) ? ancestorProposal.parentParcelIds : [];
    const fallbackParcel = parentIds[0] || null;
    selectAndHighlightProposal(getProposalKey(ancestorProposal) || proposalIdAttr, fallbackParcel, true);
}



function openProposalLens(proposalIdOrHash) {
    try {
        if (!proposalIdOrHash || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
            return;
        }
        const proposal = getProposalByIdOrHash(proposalIdOrHash);
        if (!proposal) return;
        const entries = getProposalLensEntries(proposal, { fallbackToGlobal: false });
        if (!entries.length) {
            return;
        }
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        const translate = (key, fallback) => {
            if (i18nApi && typeof i18nApi.t === 'function') {
                const value = i18nApi.t(key);
                if (value && value !== key) return value;
            }
            return fallback;
        };
        if (typeof showLensModal !== 'function') {
            return;
        }
        showLensModal({
            subtitle: translate('modal.lens.readOnlySubtitle', 'Saved with this proposal; editing is disabled.'),
            readOnly: true,
            entries: entries
        });
    } catch (error) {
        console.error('[openProposalLens] Error opening proposal lens:', error);
    }
}

function handleProposalParcelClick(parcelId, event) {
    // Handle case where event is not provided (legacy call)
    if (!event) {
        // Clear any currently selected single parcel to avoid conflicts
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.clearSingleParcelSelection === 'function') {
            multiParcelSelection.clearSingleParcelSelection();
        }

        let proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
        if (proposals.length === 0) {
            proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
        }

        if (proposals.length === 1) {
            const proposal = proposals[0];
            selectAndHighlightProposal(getProposalKey(proposal), parcelId, true);
        } else if (proposals.length > 1) {
            // If there are multiple proposals, show a simple choice modal
            showProposalChoiceModal(proposals, parcelId);
        }
        return;
    }

    // Handle event-based call (from proposal details modal)
    let node = event.target || event.srcElement || null;
    if (node && node.nodeType === Node.TEXT_NODE) {
        node = node.parentElement;
    }

    let hasOwnerAcceptanceTarget = false;
    while (node && node !== event.currentTarget) {
        if (node.classList && (
            node.classList.contains('owner-acceptance-row') ||
            node.classList.contains('owner-acceptance-list') ||
            node.classList.contains('owner-actions') ||
            node.classList.contains('owner-share') ||
            node.classList.contains('owner-identity') ||
            node.classList.contains('parcel-owner-acceptance')
        )) {
            hasOwnerAcceptanceTarget = true;
            break;
        }
        node = node.parentElement;
    }

    if (hasOwnerAcceptanceTarget) {
        event.stopPropagation();
        event.preventDefault();
        return false;
    }

    event.stopPropagation();
    event.preventDefault();

    // Check if this is a removed ancestor parcel
    const parcelItem = event.currentTarget;
    const isRemoved = parcelItem && parcelItem.getAttribute('data-parcel-removed') === 'true';

    if (isRemoved) {
        // Focus on the location where the parcel was, but don't try to select it
        focusOnRemovedParcelLocation(parcelId, parcelItem);
        return false;
    }

    returnToParcelInfo(parcelId, event);
    return false;
}

function focusOnRemovedParcelLocation(parcelId, parcelItem) {
    if (!parcelId || typeof map === 'undefined' || !map) return;

    let geometry = null;
    let feature = null;

    // Try to get geometry from data attribute first
    if (parcelItem) {
        try {
            const geometryAttr = parcelItem.getAttribute('data-parcel-geometry');
            if (geometryAttr) {
                geometry = JSON.parse(geometryAttr);
            }
        } catch (_) { }
    }

    // If not found, try to get from parentFeatures in the current proposal
    if (!geometry && !feature) {
        try {
            const proposalDetailsContent = document.getElementById('proposal-details-content');
            if (proposalDetailsContent) {
                // Try to find proposal id from any element with data-proposal-id attribute
                const proposalIdElement = proposalDetailsContent.querySelector('[data-proposal-id]');
                if (proposalIdElement) {
                    const proposalId = proposalIdElement.getAttribute('data-proposal-id');
                    if (proposalId && typeof proposalStorage !== 'undefined') {
                        const proposal = proposalStorage.getProposal(proposalId);
                        if (proposal) {
                            // Fetch by ID - no parentFeatures cache
                            // Parent parcels are fetched by ID when needed
                            // Building proposals typically don't store parentFeatures, but we can still try PersistentStorage
                            // which is already handled below
                        }
                    }
                }
            }
        } catch (_) { }
    }

    // If still not found, try PersistentStorage
    if (!geometry && !feature) {
        try {
            const record = readPersistedParcelRecord(parcelId);
            if (record && record.geometry && record.properties) {
                geometry = record.geometry;
                const properties = record.properties;
                feature = ensureParcelIdOnFeature({
                    type: 'Feature',
                    properties,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [geometry]
                    }
                });
            }
        } catch (_) { }
    }

    // Create bounds from geometry and focus map
    if (feature && feature.geometry && typeof L !== 'undefined') {
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [50, 50] });
                    return;
                }
            }
        } catch (error) {
            console.warn('focusOnRemovedParcelLocation: failed to focus on removed parcel', parcelId, error);
        }
    } else if (geometry && Array.isArray(geometry) && geometry.length > 0 && typeof L !== 'undefined') {
        // Try to create bounds from raw geometry coordinates
        try {
            // Geometry is expected to be an array of [lng, lat] pairs
            const coords = geometry;
            if (coords.length > 0) {
                const latlngs = coords.map(coord => [coord[1], coord[0]]); // Convert [lng, lat] to [lat, lng]
                const polygon = L.polygon(latlngs);
                const bounds = polygon.getBounds();
                if (bounds && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [50, 50] });
                    return;
                }
            }
        } catch (error) {
            console.warn('focusOnRemovedParcelLocation: failed to focus on removed parcel from geometry', parcelId, error);
        }
    }
}

function returnToParcelInfo(parcelId, event) {
    // Prevent event bubbling to avoid triggering parcel click handlers
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    // 1) Close Proposal UI (details/modal/list) and leave proposal mode
    if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true);
    if (typeof closeProposalList === 'function') closeProposalList();
    if (typeof hideProposalCompareModal === 'function') hideProposalCompareModal();
    if (typeof closeProposalInfoDialog === 'function') closeProposalInfoDialog();

    // 2) Disable proposal mode by unchecking the checkbox and updating layers immediately
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    // 3) Exit Parcel Block mode fully (uncheck, collapse, and clear related UI)
    const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
    if (parcelBlocksCheckbox && parcelBlocksCheckbox.checked) {
        parcelBlocksCheckbox.checked = false;
        if (typeof toggleBlocksVisibility === 'function') {
            toggleBlocksVisibility();
        } else {
            if (typeof hideBlocksList === 'function') hideBlocksList();
            if (typeof hideBlockInfo === 'function') hideBlockInfo();
            if (typeof updateBlockLayer === 'function') updateBlockLayer();
        }
    }

    // 4) Select the parcel and show Parcel Info immediately (switch to parcel mode)
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
    }
}

// Make returnToParcelInfo globally available
window.returnToParcelInfo = returnToParcelInfo;

/**
 * Hide the proposal details panel
 */
function hideProposalDetailsPanel(clearHighlights = false) {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel) {
        proposalPanel.classList.remove('visible');
    }
    document.body.classList.remove('proposal-details-open');
    teardownProposalDetailsEscapeHandler();

    // Clear hover overlay when closing
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    // Clear any proposal highlights when closing
    if (clearHighlights && typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }
}

// Make hideProposalDetailsPanel globally available
window.hideProposalDetailsPanel = hideProposalDetailsPanel;
let proposalDetailsEscapeHandler = null;

function installProposalDetailsEscapeHandler() {
    if (proposalDetailsEscapeHandler) return;
    proposalDetailsEscapeHandler = (event) => {
        if (event.key !== 'Escape') return;
        const panel = document.getElementById('proposal-details-panel');
        const isActive = panel && panel.classList.contains('visible') && document.body.classList.contains('proposal-details-open');
        if (!isActive) return;
        hideProposalDetailsPanel(true);
    };
    document.addEventListener('keydown', proposalDetailsEscapeHandler);
}

function teardownProposalDetailsEscapeHandler() {
    if (!proposalDetailsEscapeHandler) return;
    document.removeEventListener('keydown', proposalDetailsEscapeHandler);
    proposalDetailsEscapeHandler = null;
}

const DEFAULT_PROPOSAL_TYPE = 'Square';
let currentProposalTool = null;
let currentGeometryGoal = null;
let proposalGeometrySubmitted = false;
let proposalAcquisitionLabels = {
    full: 'Full acquisition',
    partial: 'Partial acquisition',
    partialPreferred: 'Partial acquisition preferred'
};
let currentOwnershipMode = 'multiple';
// Stored screenshot data URL captured when proposal modal opens
let proposalModalScreenshotDataUrl = null;

function getSelectedProposalTool() {
    return currentProposalTool;
}

function setProposalModalDimmed(dimmed) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    if (dimmed) {
        modal.classList.add('dimmed-behind-overlay');
    } else {
        modal.classList.remove('dimmed-behind-overlay');
    }
}

function setGeometryStatus(text, { submitted = false } = {}) {
    const statusEl = document.getElementById('proposalGeometryStatus');
    if (statusEl) {
        statusEl.textContent = text || '';
        statusEl.dataset.submitted = submitted ? 'true' : 'false';
    }
    proposalGeometrySubmitted = !!submitted;
    updateCreateProposalSubmitState();
}

function goalRequiresGeometry(goalKey) {
    if (!goalKey) return false;
    const key = goalKey.toString().toLowerCase();
    return key === 'single'
        || key === 'road-track'
        || key === 'urban-rule'
        || key === 'reparcellization';
}

function updateCreateProposalSubmitState() {
    const btn = document.getElementById('createProposalSubmitButton');
    const hint = document.getElementById('proposalGeometryRequirementHint');
    const goalKey = currentGeometryGoal || getSelectedProposalTool();
    const needsGeometry = goalRequiresGeometry(goalKey);
    const hasGeometry = proposalGeometrySubmitted || !needsGeometry;

    if (btn) {
        btn.disabled = !hasGeometry;
    }
    if (hint) {
        hint.textContent = (!hasGeometry) ? 'Please add a geometry first.' : '';
    }
}

function renderGeometrySection(goalKey) {
    const group = document.getElementById('proposalGeometryGroup');
    const buttonsRow = document.getElementById('proposalGeometryButtons');
    if (!group || !buttonsRow) return;

    const t = getProposalI18nHelper();
    const label = {
        geometry: t('modal.createProposal.geometry.label', 'Geometry'),
        edit: t('modal.createProposal.geometry.buttons.edit', 'Edit'),
        upload: t('modal.createProposal.geometry.buttons.upload', 'Upload'),
        noGeometry: t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry'),
        submitted: t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted'),
        auto: t('modal.createProposal.geometry.status.auto', 'Algorithmic geometry will be generated')
    };

    currentGeometryGoal = goalKey;
    proposalGeometrySubmitted = false;
    buttonsRow.innerHTML = '';
    buttonsRow.style.display = 'grid';
    buttonsRow.style.gap = '8px';

    // Default hidden
    group.style.display = 'none';
    setGeometryStatus('', { submitted: false });

    const makeButton = (actionKey, text, { disabled = false, selected = false }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-action';
        if (selected) btn.classList.add('selected');
        if (disabled) btn.setAttribute('disabled', 'disabled');
        btn.dataset.geometryAction = actionKey;
        btn.textContent = text;
        btn.addEventListener('click', () => handleGeometryAction(actionKey));
        return btn;
    };

    const showGroup = () => {
        group.style.display = '';
        const labelEl = group.querySelector('label');
        if (labelEl) labelEl.textContent = label.geometry;
    };

    if (goalKey === 'decide-later') {
        updateCreateProposalSubmitState();
        return; // No geometry section shown
    }

    if (goalKey === 'square' || goalKey === 'park' || goalKey === 'lake') {
        showGroup();
        setGeometryStatus(label.auto, { submitted: true });
        buttonsRow.appendChild(makeButton('edit', label.edit, { disabled: true }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'single') {
        showGroup();
        setGeometryStatus(label.noGeometry, { submitted: false });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'road-track') {
        showGroup();
        setGeometryStatus(label.noGeometry, { submitted: false });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'reparcellization') {
        showGroup();
        setGeometryStatus(label.noGeometry, { submitted: false });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'urban-rule') {
        showGroup();
        setGeometryStatus(label.noGeometry, { submitted: false });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    updateCreateProposalSubmitState();
}

function openUrbanRuleGeometry() {
    const selectedBtn = document.querySelector('.proposal-typology-button.selected');
    const selectedKey = selectedBtn ? selectedBtn.getAttribute('data-proposal-typology') : null;

    // Prefer selected typology when enabled; otherwise fall back to the first enabled typology.
    let typologyKey = null;
    if (selectedBtn && !selectedBtn.disabled && selectedKey) {
        typologyKey = selectedKey;
    } else {
        const firstEnabledBtn = Array.from(document.querySelectorAll('.proposal-typology-button'))
            .find(btn => !btn.disabled && btn.getAttribute('data-proposal-typology'));
        typologyKey = firstEnabledBtn
            ? firstEnabledBtn.getAttribute('data-proposal-typology')
            : (selectedKey || 'block');
    }

    handleUrbanRuleTypologyClick(typologyKey || 'block');
}

function handleGeometryAction(actionKey) {
    const t = getProposalI18nHelper();
    const tCorridor = getConstrainedCorridorTranslator(t);
    const label = {
        submitted: t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
    };

    switch (actionKey) {
        case 'edit':
            if (currentGeometryGoal === 'reparcellization') {
                handleReparcellizationAlgorithmClick('sweep-line');
            }
            if (currentGeometryGoal === 'single') {
                launchSingleBuildingToolForSelection();
            } else if (currentGeometryGoal === 'road-track') {
                if (typeof openConstrainedCorridorModal === 'function') {
                    openConstrainedCorridorModal();
                } else if (typeof updateStatus === 'function') {
                    updateStatus(tCorridor('statusUnavailable', 'Constrained corridor modal is not available yet.'));
                }
            } else if (currentGeometryGoal === 'urban-rule') {
                openUrbanRuleGeometry();
            }
            setGeometryStatus(label.submitted, { submitted: true });
            break;
        default:
            break;
    }

    updateCreateProposalSubmitState();
}

const DEFAULT_CORRIDOR_WIDTHS = {
    road: 7.5,
    track: 3.0
};

let pendingConstrainedCorridor = null;
let constrainedCorridorState = null;

function openConstrainedCorridorModal() {
    const selection = (typeof getCurrentParcelSelectionContext === 'function')
        ? getCurrentParcelSelectionContext()
        : { layers: [], ids: [] };
    const parcelIds = Array.isArray(selection.ids) ? selection.ids.filter(Boolean) : [];
    const parcels = Array.isArray(selection.layers) ? selection.layers.filter(Boolean) : [];
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const tCorridor = getConstrainedCorridorTranslator(t);

    if (!parcels.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusSelectParcels', 'Select parcels before opening the constrained corridor tool.'));
        }
        return;
    }

    const contiguity = (typeof areParcelsContiguous === 'function')
        ? areParcelsContiguous(parcels)
        : { contiguous: true };

    if (!contiguity.contiguous) {
        const message = (typeof t === 'function')
            ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
            : tCorridor('statusContiguity', 'Parcels must be contiguous to draw a constrained corridor.');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('parcels_not_contiguous', message);
        } else if (typeof alert === 'function') {
            alert(message);
        }
        return;
    }

    const superGeometry = (typeof buildGeometryFromParcels === 'function')
        ? buildGeometryFromParcels(parcels)
        : null;

    if (!superGeometry) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusBoundaryFailed', 'Could not build a corridor boundary from the selected parcels.'));
        }
        return;
    }

    const superFeature = { type: 'Feature', properties: {}, geometry: superGeometry };
    const superTurfFeature = (typeof turf !== 'undefined' && turf.feature)
        ? turf.feature(superGeometry)
        : superFeature;

    // Clone parcel features to avoid mutating the live map layers
    const parcelFeatures = parcels
        .map(layer => {
            const feature = layer?.feature;
            if (!feature || !feature.geometry) return null;
            try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
        })
        .filter(Boolean);

    if (!parcelFeatures.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusGeometryFailed', 'Could not resolve parcel geometries for the constrained corridor modal.'));
        }
        return;
    }

    // Remove any existing modal before opening a new one
    if (constrainedCorridorState && constrainedCorridorState.close) {
        constrainedCorridorState.close();
    }

    const overlay = document.createElement('div');
    overlay.className = 'constrained-corridor-overlay';

    const mapId = `constrained-corridor-map-${Date.now()}`;
    const corridorText = {
        ariaLabel: tCorridor('ariaLabel', 'Constrained corridor'),
        title: tCorridor('title', 'Constrained corridor'),
        closeLabel: tCorridor('closeLabel', 'Close'),
        mapAriaLabel: tCorridor('mapAriaLabel', 'Constrained corridor map'),
        modeAriaLabel: tCorridor('modeAriaLabel', 'Corridor mode'),
        modeFull: tCorridor('modeFull', 'Full parcel'),
        modeDraw: tCorridor('modeDraw', 'Draw'),
        typeAriaLabel: tCorridor('typeAriaLabel', 'Corridor type'),
        typeRoad: tCorridor('typeRoad', 'Road'),
        typeTrack: tCorridor('typeTrack', 'Track'),
        panelHeader: tCorridor('panelHeader', 'Road Info'),
        undo: tCorridor('undo', '(U)ndo'),
        finish: tCorridor('finish', '(F)inish'),
        metricLength: tCorridor('metricLength', 'Length'),
        metricArea: tCorridor('metricArea', 'Area'),
        hintFullMode: tCorridor('hintFullMode', 'Full parcel mode will use the merged parcel outline as the corridor geometry.'),
        done: tCorridor('done', 'Done')
    };

    overlay.innerHTML = `
        <div class="constrained-corridor-modal" role="dialog" aria-modal="true" aria-label="${corridorText.ariaLabel}">
            <div class="corridor-header">
                <div class="corridor-title">${corridorText.title}</div>
                <button type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${corridorText.closeLabel}" data-corridor-close>&times;</button>
            </div>
            <div class="corridor-layout">
                <div class="corridor-map-panel">
                    <div id="${mapId}" class="corridor-map" aria-label="${corridorText.mapAriaLabel}"></div>
                </div>
                <div class="corridor-sidebar">
                    <div class="corridor-toggle-row" role="group" aria-label="${corridorText.modeAriaLabel}">
                        <button type="button" class="btn proposal-type-button selected" data-corridor-mode="full">${corridorText.modeFull}</button>
                        <button type="button" class="btn proposal-type-button" data-corridor-mode="draw">${corridorText.modeDraw}</button>
                    </div>
                    <div class="corridor-draw-controls" data-corridor-draw-controls>
                        <div class="corridor-toggle-row" role="group" aria-label="${corridorText.typeAriaLabel}">
                            <button type="button" class="btn proposal-type-button selected" data-corridor-type="road">${corridorText.typeRoad}</button>
                            <button type="button" class="btn proposal-type-button" data-corridor-type="track">${corridorText.typeTrack}</button>
                        </div>
                        <div class="corridor-panel">
                            <div class="corridor-panel__header">${corridorText.panelHeader}</div>
                            <div class="corridor-undo-row">
                                <button type="button" class="btn btn-secondary" data-corridor-undo disabled>${corridorText.undo}</button>
                                <button type="button" class="btn btn-secondary" data-corridor-finish disabled>${corridorText.finish}</button>
                            </div>
                            <div class="corridor-metrics" aria-live="polite">
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricLength}</div>
                                    <div class="corridor-metric__value" data-corridor-length>0 m</div>
                                </div>
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricArea}</div>
                                    <div class="corridor-metric__value" data-corridor-area>0 m²</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="corridor-hint" data-corridor-hint>${corridorText.hintFullMode}</div>
                    <div class="corridor-actions">
                        <button type="button" class="btn btn-proposal" data-corridor-done>${corridorText.done}</button>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    const map = (typeof L !== 'undefined' && L.map) ? L.map(mapId, { zoomControl: true, scrollWheelZoom: true }) : null;
    if (!map) {
        overlay.remove();
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusMapUnavailable', 'Map library unavailable.'));
        }
        return;
    }

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const parcelLayer = L.geoJSON(parcelFeatures, {
        style: () => ({
            color: '#1f2937',
            weight: 1.4,
            fillColor: '#e5e7eb',
            fillOpacity: 0.12
        })
    }).addTo(map);

    const boundaryLayer = L.geoJSON(superFeature, {
        style: () => ({
            color: '#0f172a',
            weight: 6,
            dashArray: '8 6',
            fillOpacity: 0
        })
    }).addTo(map);

    const bounds = parcelLayer.getBounds();
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1));
    }

    let drawMode = 'full';
    let corridorType = 'road';
    let corridorWidth = DEFAULT_CORRIDOR_WIDTHS.road;
    const drawnPoints = [];
    let drawingFinalized = false;
    let lineLayer = null;
    let polygonLayer = null;
    let previewLine = null;
    let previewPolygon = null;

    const drawControls = overlay.querySelector('[data-corridor-draw-controls]');
    const modeButtons = overlay.querySelectorAll('[data-corridor-mode]');
    const typeButtons = overlay.querySelectorAll('[data-corridor-type]');
    const undoButton = overlay.querySelector('[data-corridor-undo]');
    const finishButton = overlay.querySelector('[data-corridor-finish]');
    const doneButton = overlay.querySelector('[data-corridor-done]');
    const lengthEl = overlay.querySelector('[data-corridor-length]');
    const areaEl = overlay.querySelector('[data-corridor-area]');
    const hintEl = overlay.querySelector('[data-corridor-hint]');

    const closeModal = () => {
        map.off('click', handleMapClick);
        map.off('mousemove', handleMouseMove);
        if (lineLayer) map.removeLayer(lineLayer);
        if (polygonLayer) map.removeLayer(polygonLayer);
        if (previewLine) map.removeLayer(previewLine);
        if (previewPolygon) map.removeLayer(previewPolygon);
        map.removeLayer(parcelLayer);
        map.removeLayer(boundaryLayer);
        map.remove();
        overlay.removeEventListener('click', handleOverlayClick);
        overlay.removeEventListener('keydown', handleKeydown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        constrainedCorridorState = null;
    };

    constrainedCorridorState = {
        close: closeModal,
        overlay
    };

    function applyMode(mode) {
        drawMode = mode;
        modeButtons.forEach(btn => {
            const isActive = btn.getAttribute('data-corridor-mode') === mode;
            btn.classList.toggle('selected', isActive);
        });
        if (drawControls) {
            drawControls.style.display = mode === 'draw' ? 'flex' : 'none';
        }
        if (hintEl) {
            hintEl.textContent = mode === 'draw'
                ? 'Draw a road or track inside the merged parcels.'
                : 'Full parcel mode will use the merged parcel outline as the corridor geometry.';
        }
        const mapContainer = map.getContainer();
        if (mapContainer) {
            mapContainer.style.cursor = mode === 'draw' ? 'crosshair' : '';
            mapContainer.classList.toggle('corridor-draw-mode', mode === 'draw');
        }
        drawingFinalized = false;
        if (mode === 'full') {
            clearDrawnGeometry();
        }
        updateButtons();
    }

    function applyType(type) {
        corridorType = type === 'track' ? 'track' : 'road';
        corridorWidth = corridorType === 'track'
            ? (Number.isFinite(trackWidth) ? trackWidth : DEFAULT_CORRIDOR_WIDTHS.track)
            : (Number.isFinite(roadWidth) ? roadWidth : DEFAULT_CORRIDOR_WIDTHS.road);
        typeButtons.forEach(btn => {
            const active = btn.getAttribute('data-corridor-type') === corridorType;
            btn.classList.toggle('selected', active);
        });
        updatePreview();
    }

    function handleOverlayClick(event) {
        if (event.target && event.target.matches('[data-corridor-close]')) {
            closeModal();
        }
    }

    function handleKeydown(event) {
        const targetTag = (event.target?.tagName || '').toLowerCase();
        const isFormField = targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select';
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (isFormField) return;
        if ((event.key === 'u' || event.key === 'U') && !undoButton?.disabled) {
            event.preventDefault();
            handleUndo();
        }
        if ((event.key === 'f' || event.key === 'F') && !finishButton?.disabled) {
            event.preventDefault();
            finalizeCorridorDrawing();
        }
    }

    function pointInsideSuperparcel(latlng) {
        if (!latlng) return false;
        if (typeof turf === 'undefined') return true;
        try {
            return turf.booleanPointInPolygon(turf.point([latlng.lng, latlng.lat]), superTurfFeature);
        } catch (_) {
            return true;
        }
    }

    function clearDrawnGeometry() {
        drawnPoints.length = 0;
        drawingFinalized = false;
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        setMetrics(0, 0);
    }

    function handleMapClick(event) {
        if (drawMode !== 'draw' || !event || !event.latlng) return;
        if (drawingFinalized) {
            clearDrawnGeometry();
        }
        if (!pointInsideSuperparcel(event.latlng)) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_point_outside', 'Clicks must stay within the selected parcels.');
            }
            return;
        }
        drawnPoints.push(event.latlng);
        updatePreview();
    }

    function handleMouseMove(event) {
        if (drawMode !== 'draw' || drawingFinalized || !event || !event.latlng) return;
        updatePreview(event.latlng);
    }

    function toClosedRing(latlngs) {
        if (!Array.isArray(latlngs) || !latlngs.length) return [];
        const ring = latlngs.map(pt => [pt.lng, pt.lat]);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            ring.push([first[0], first[1]]);
        }
        return ring;
    }

    function computeMetrics(points, polygonLatLngs) {
        let length = 0;
        let area = 0;
        if (typeof turf !== 'undefined') {
            if (points && points.length >= 2) {
                try {
                    const line = turf.lineString(points.map(pt => [pt.lng, pt.lat]));
                    length = turf.length(line, { units: 'kilometers' }) * 1000;
                } catch (_) { }
            }
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                try {
                    const ring = toClosedRing(polygonLatLngs);
                    if (ring.length >= 4) {
                        const poly = turf.polygon([ring]);
                        area = turf.area(poly);
                    }
                } catch (_) { }
            }
        }
        return { length, area };
    }

    function setMetrics(length, area) {
        if (lengthEl) lengthEl.textContent = `${length.toFixed(1)} m`;
        if (areaEl) areaEl.textContent = `${area.toFixed(1)} m²`;
    }

    function updatePreview(hoverPoint) {
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }

        const points = drawnPoints.slice();
        const useHover = hoverPoint && !drawingFinalized;
        if (useHover) points.push(hoverPoint);

        if (!points.length) {
            setMetrics(0, 0);
            updateButtons();
            return;
        }

        const line = L.polyline(points, { color: '#2563eb', weight: 3 }).addTo(map);
        if (drawingFinalized) {
            lineLayer = line;
        } else {
            previewLine = line;
        }

        let polygonLatLngs = null;
        if (points.length >= 2) {
            polygonLatLngs = (typeof calculateRoadPolygon === 'function')
                ? calculateRoadPolygon(points, corridorWidth)
                : null;
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                const polygon = L.polygon(polygonLatLngs, {
                    color: '#34d399',
                    weight: 2,
                    fillColor: '#34d399',
                    fillOpacity: 0.25
                }).addTo(map);
                if (drawingFinalized) {
                    polygonLayer = polygon;
                } else {
                    previewPolygon = polygon;
                }
            }
        }

        const metrics = computeMetrics(points, polygonLatLngs);
        setMetrics(metrics.length, metrics.area);
        updateButtons();
    }

    function updateButtons() {
        const hasLine = drawnPoints.length >= 2;
        const drawDisabled = drawMode !== 'draw';
        if (undoButton) {
            undoButton.disabled = drawnPoints.length === 0 || drawDisabled;
        }
        if (finishButton) {
            finishButton.disabled = !hasLine || drawDisabled;
        }
        if (doneButton) {
            doneButton.disabled = (drawMode === 'draw' && !hasLine);
        }
    }

    function handleUndo() {
        if (!drawnPoints.length || drawMode !== 'draw') return;
        drawnPoints.pop();
        drawingFinalized = false;
        updatePreview();
    }

    function finalizeCorridorDrawing() {
        if (drawMode !== 'draw' || drawnPoints.length < 2) return;
        drawingFinalized = true;
        updatePreview();
    }

    function persistGeometryAndClose() {
        if (drawMode === 'full') {
            pendingConstrainedCorridor = {
                mode: 'full',
                type: corridorType,
                width: corridorWidth,
                parentParcelIds: parcelIds.slice(),
                superGeometry: superGeometry,
                polygon: superGeometry,
                centerline: []
            };
            if (typeof window !== 'undefined') {
                window.pendingConstrainedCorridor = pendingConstrainedCorridor;
            }
            if (typeof setGeometryStatus === 'function') {
                const submittedLabel = (typeof t === 'function')
                    ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                    : '✔️ geometry submitted';
                setGeometryStatus(submittedLabel, { submitted: true });
            }
            closeModal();
            return;
        }

        if (drawnPoints.length < 2) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_draw_more_points', 'Add at least two points to draw a corridor.');
            }
            return;
        }

        const polygonLatLngs = (typeof calculateRoadPolygon === 'function')
            ? calculateRoadPolygon(drawnPoints, corridorWidth)
            : null;

        if (!polygonLatLngs || !polygonLatLngs.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        const ring = toClosedRing(polygonLatLngs);
        if (!ring.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        if (typeof turf !== 'undefined') {
            try {
                const corridorPoly = turf.polygon([ring]);
                const within = turf.booleanWithin(corridorPoly, superTurfFeature);
                if (!within) {
                    if (typeof showProposalAlertMessage === 'function') {
                        showProposalAlertMessage('corridor_outside_bounds', 'The corridor must stay within the selected parcels.');
                    }
                    return;
                }
            } catch (_) { /* best effort */ }
        }

        const geoPolygon = { type: 'Polygon', coordinates: [ring] };
        const centerline = drawnPoints.map(pt => [pt.lng, pt.lat]);

        pendingConstrainedCorridor = {
            mode: 'draw',
            type: corridorType,
            width: corridorWidth,
            parentParcelIds: parcelIds.slice(),
            superGeometry: superGeometry,
            polygon: geoPolygon,
            centerline
        };

        if (typeof window !== 'undefined') {
            window.pendingConstrainedCorridor = pendingConstrainedCorridor;
        }

        if (typeof setGeometryStatus === 'function') {
            const submittedLabel = (typeof t === 'function')
                ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                : '✔️ geometry submitted';
            setGeometryStatus(submittedLabel, { submitted: true });
        }

        closeModal();
    }

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyMode(btn.getAttribute('data-corridor-mode') === 'draw' ? 'draw' : 'full'));
    });

    typeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyType(btn.getAttribute('data-corridor-type')));
    });

    if (undoButton) {
        undoButton.addEventListener('click', handleUndo);
    }

    if (finishButton) {
        finishButton.addEventListener('click', finalizeCorridorDrawing);
    }

    if (doneButton) {
        doneButton.addEventListener('click', persistGeometryAndClose);
    }

    if (map) {
        map.on('click', handleMapClick);
        map.on('mousemove', handleMouseMove);
    }

    overlay.addEventListener('click', handleOverlayClick);
    overlay.addEventListener('keydown', handleKeydown, true);

    // Initialize state
    applyMode('full');
    applyType('road');
    setTimeout(() => {
        try { map.invalidateSize(); } catch (_) { }
    }, 50);
}

if (typeof window !== 'undefined') {
    window.openConstrainedCorridorModal = openConstrainedCorridorModal;
}

function setProposalAcquisitionMode(mode = 'full') {
    const normalized = mode === 'partial-preferred' ? 'partial' : (mode || 'full');
    const buttons = document.querySelectorAll('.proposal-acquisition-button');
    buttons.forEach(btn => {
        const btnMode = btn.getAttribute('data-acquisition-mode');
        if (btnMode === normalized) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
    const input = document.getElementById('proposalAcquisitionMode');
    if (input) {
        input.value = mode || 'full';
    }
}

function setProposalBoundaryMode(mode = 'multiple', options = {}) {
    const normalized = mode || 'multiple';
    const lockSelection = options.lock === true;
    const unlockSelection = options.unlock === true;
    const buttons = document.querySelectorAll('.proposal-boundary-button');
    buttons.forEach(btn => {
        const btnMode = btn.getAttribute('data-boundary-mode');
        const isSelected = btnMode === normalized;
        if (isSelected) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
        if (lockSelection) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
        } else if (unlockSelection) {
            btn.disabled = false;
            btn.removeAttribute('aria-disabled');
        }
    });
    const input = document.getElementById('proposalBoundaryMode');
    if (input) {
        input.value = normalized;
        if (lockSelection) {
            input.setAttribute('data-ownership-locked', 'true');
        } else if (unlockSelection) {
            input.removeAttribute('data-ownership-locked');
        }
    }
    currentOwnershipMode = normalized;
}

async function resolveSingleOwnerLabelForSelection(selection) {
    if (!selection || !Array.isArray(selection.layers) || !selection.layers.length) return null;
    if (typeof ensureParcelOwnerSlots !== 'function') return null;

    const firstFeature = selection.layers[0]?.feature;
    const parcelId = getParcelIdFromFeature(firstFeature);
    if (!parcelId) return null;

    try {
        const slots = await ensureParcelOwnerSlots(parcelId);
        if (!Array.isArray(slots) || !slots.length) return null;
        const chosen = slots.find(slot => slot?.displayName) || slots[0];
        const label = chosen?.displayName || chosen?.ownerKey || chosen?.name;
        return label ? String(label).trim() : null;
    } catch (error) {
        console.warn('Failed to resolve single-owner label for selection', error);
        return null;
    }
}

function computeOwnershipStatsFromSelection(selection) {
    const result = {
        ownerKeys: new Set(),
        ownerCount: 0,
        mode: 'multiple'
    };
    const layers = selection && Array.isArray(selection.layers) ? selection.layers : [];

    if (!layers.length) {
        return result;
    }

    layers.forEach((parcel, index) => {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        let addedOwnerForParcel = false;

        if (parcelId && typeof getParcelOwnerSlots === 'function') {
            try {
                const slots = getParcelOwnerSlots(String(parcelId));
                if (Array.isArray(slots) && slots.length) {
                    slots.forEach(slot => {
                        const key = slot && (slot.key || slot.ownerKey || slot.displayName || slot.name);
                        if (key) {
                            result.ownerKeys.add(String(key));
                            addedOwnerForParcel = true;
                        }
                    });
                }
            } catch (error) {
                console.warn('Failed to resolve owner slots for parcel', parcelId, error);
            }
        }

        if (!addedOwnerForParcel) {
            const fallbackKey = parcelId ? `parcel:${parcelId}:owner` : `parcel:index:${index}`;
            result.ownerKeys.add(fallbackKey);
        }
    });

    result.ownerCount = result.ownerKeys.size;
    result.mode = result.ownerCount <= 1 ? 'single' : 'multiple';
    return result;
}

function updateGoalDependentSections(toolKey) {
    const acquisitionGroup = document.getElementById('proposalAcquisitionGroup');
    const typologyGroup = document.getElementById('proposalTypologyGroup');
    const boundaryGroup = document.getElementById('proposalBoundaryGroup');
    const partialButton = document.querySelector('.proposal-acquisition-button[data-acquisition-mode="partial"]');

    const isUrbanRule = toolKey === 'urban-rule';
    const isReparcellization = toolKey === 'reparcellization';
    const isRoad = toolKey === 'road-track';

    if (acquisitionGroup) {
        acquisitionGroup.style.display = (isUrbanRule || isReparcellization) ? 'none' : '';
    }
    if (typologyGroup) {
        typologyGroup.style.display = isUrbanRule ? '' : 'none';
    }
    if (boundaryGroup) {
        boundaryGroup.style.display = isReparcellization ? '' : 'none';
    }

    if (partialButton) {
        partialButton.textContent = isRoad ? proposalAcquisitionLabels.partialPreferred : proposalAcquisitionLabels.partial;
    }

    if (isUrbanRule) {
        setProposalMainType('Urban Rule');
        handleUrbanRuleTypologyClick('block', { skipLaunch: true });
    } else if (isReparcellization) {
        setProposalMainType('Reparcellization', { skipReparcelLaunch: true });
        const selection = getCurrentParcelSelectionContext();
        const ownershipStats = computeOwnershipStatsFromSelection(selection);
        setProposalBoundaryMode(ownershipStats.mode, { lock: true });
    } else {
        setProposalMainType('Purchase');
        const acquisitionMode = isRoad ? 'partial-preferred' : 'full';
        setProposalAcquisitionMode(acquisitionMode);
        setProposalBoundaryMode('multiple', { unlock: true });
    }

    renderGeometrySection(toolKey);
}

function setProposalCreateButtonState(isCreating) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const createButton = document.getElementById('createProposalSubmitButton')
        || modal.querySelector('.proposal-actions-block .btn-proposal')
        || modal.querySelector('.proposal-modal-footer .btn-proposal');
    if (!createButton) return;
    const t = getProposalI18nHelper();
    const creatingLabel = t('modal.createProposal.creating', 'Creating...');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    if (isCreating) {
        if (!createButton.dataset.originalText) {
            createButton.dataset.originalText = createButton.textContent || submitLabel;
        }
        createButton.textContent = creatingLabel;
        createButton.disabled = true;
        createButton.classList.add('is-creating');
    } else {
        const originalText = createButton.dataset.originalText || submitLabel;
        createButton.textContent = originalText;
        createButton.disabled = false;
        createButton.classList.remove('is-creating');
        delete createButton.dataset.originalText;
    }
}

function setProposalModalInteractivity(enabled) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const controls = modal.querySelectorAll('input, textarea, select, button');

    controls.forEach(control => {
        const isCloseButton = control.classList && control.classList.contains('proposal-modal-close');
        if (enabled) {
            if (control.dataset.disabledByCreate === '1') {
                control.disabled = false;
                delete control.dataset.disabledByCreate;
            }
        } else {
            if (!isCloseButton && !control.disabled) {
                control.dataset.disabledByCreate = '1';
                control.disabled = true;
            }
        }
    });

    modal.classList.toggle('proposal-modal-disabled', !enabled);
}

function showProposalWaitingPopup(message = 'Waiting for transaction...') {
    let popup = document.getElementById('proposal-waiting-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'proposal-waiting-popup';
        popup.style.position = 'fixed';
        popup.style.inset = '0';
        popup.style.zIndex = '12050';
        popup.style.display = 'flex';
        popup.style.alignItems = 'center';
        popup.style.justifyContent = 'center';
        popup.style.pointerEvents = 'none';

        const card = document.createElement('div');
        card.style.background = '#0d3b66';
        card.style.color = '#fff';
        card.style.padding = '12px 16px';
        card.style.borderRadius = '12px';
        card.style.boxShadow = '0 12px 36px rgba(0,0,0,0.25)';
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.gap = '10px';
        card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        card.style.fontSize = '14px';
        card.style.pointerEvents = 'none';

        const indicator = document.createElement('span');
        indicator.textContent = '⏳';
        indicator.style.fontSize = '16px';
        indicator.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'proposal-waiting-text';
        text.textContent = message;

        card.appendChild(indicator);
        card.appendChild(text);
        popup.appendChild(card);
        document.body.appendChild(popup);
    } else {
        popup.style.display = 'flex';
    }

    const textEl = popup.querySelector('.proposal-waiting-text');
    if (textEl) {
        textEl.textContent = message;
    }
}

function hideProposalWaitingPopup() {
    const popup = document.getElementById('proposal-waiting-popup');
    if (popup && popup.parentNode) {
        popup.parentNode.removeChild(popup);
    }
}

function showProposalWaitingPopupTemporary(message = 'Transaction rejected', duration = 2000) {
    showProposalWaitingPopup(message);
    setTimeout(() => {
        hideProposalWaitingPopup();
    }, Math.max(500, duration));
}

function getCurrentParcelSelectionContext() {
    const context = { layers: [], ids: [] };
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0) {
            context.ids = Array.from(multiParcelSelection.selectedParcels).map(id => id.toString());
            if (typeof multiParcelSelection.getSelectedParcels === 'function') {
                context.layers = (multiParcelSelection.getSelectedParcels() || []).filter(Boolean);
            } else if (typeof multiParcelSelection.findParcelById === 'function') {
                context.layers = context.ids.map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
            }
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId && currentParcel && currentParcel.layer) {
            context.ids = [selectedParcelId.toString()];
            context.layers = [currentParcel.layer];
        }
    } catch (e) {
        console.warn('Failed to resolve parcel selection context', e);
    }
    return context;
}

function formatParcelSelectionLabel(parcelIds = []) {
    if (!parcelIds || parcelIds.length === 0) return 'Selected Parcels';
    if (parcelIds.length === 1) {
        return `Parcel ${parcelIds[0]}`;
    }
    return `${parcelIds.length} Parcels`;
}

function setProposalType(type) {
    const effectiveType = type || DEFAULT_PROPOSAL_TYPE;
    const input = document.getElementById('proposalType');
    if (input) {
        input.value = effectiveType;
    }
    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const buttons = document.querySelectorAll('.proposal-tool-button, .proposal-type-button[data-proposal-tool]');
    let resolvedTool = null;
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-type');
        if (btnType === effectiveType) {
            btn.classList.add('selected');
            resolvedTool = btn.getAttribute('data-proposal-tool') || null;
        } else {
            btn.classList.remove('selected');
        }
    });
    currentProposalTool = resolvedTool;

    // Update description with default text if empty
    updateProposalDescription(effectiveType);
}

let reparcellizationModulePromise = null;

function ensureReparcellizationModuleLoaded() {
    if (typeof openReparcellizationModal === 'function') {
        return Promise.resolve(true);
    }
    if (reparcellizationModulePromise) {
        return reparcellizationModulePromise;
    }
    reparcellizationModulePromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'js/reparcellization.js';
        script.async = true;
        script.onload = () => resolve(typeof openReparcellizationModal === 'function');
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
    return reparcellizationModulePromise;
}

function setProposalMainType(type, options = {}) {
    const skipReparcelLaunch = options.skipReparcelLaunch === true;
    const buttons = document.querySelectorAll('.proposal-type-button[data-proposal-main-type]');
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-main-type');
        if (btnType === type) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    const input = document.getElementById('proposalMainType');
    if (input) {
        input.value = type || 'Purchase';
    }

    const algorithmGroup = document.getElementById('reparcellizationAlgorithmGroup');
    if (algorithmGroup) {
        algorithmGroup.style.display = 'none';
    }

    const isReparcellization = type === 'Reparcellization';
    const isUrbanRule = type === 'Urban Rule';

    if (isReparcellization) {
        currentProposalTool = 'reparcellization';
        const typeInput = document.getElementById('proposalType');
        if (typeInput) {
            typeInput.value = 'Reparcellization';
        }
        if (!skipReparcelLaunch) {
            handleReparcellizationAlgorithmClick('sweep-line');
        }
    } else if (isUrbanRule) {
        currentProposalTool = 'urban-rule';
        setProposalType('Urban Rule');
    } else {
        if (currentProposalTool === 'buildings') {
            currentProposalTool = null;
        }
        if (!currentProposalTool) {
            setProposalType(DEFAULT_PROPOSAL_TYPE);
        }
    }
}

async function handleReparcellizationAlgorithmClick(algorithmKey = 'sweep-line') {
    const normalizedKey = algorithmKey || 'sweep-line';
    const ownershipModeInput = document.getElementById('proposalBoundaryMode');
    const ownershipMode = ownershipModeInput && ownershipModeInput.value ? ownershipModeInput.value : (currentOwnershipMode || 'multiple');

    const selection = (typeof getCurrentParcelSelectionContext === 'function')
        ? getCurrentParcelSelectionContext()
        : null;
    let singleOwnerLabel = null;
    if (ownershipMode === 'single') {
        singleOwnerLabel = await resolveSingleOwnerLabelForSelection(selection);
        if (!singleOwnerLabel) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot open single-owner reparcellization without an explicit owner.');
            }
            return false;
        }
    }

    currentProposalTool = 'reparcellization';
    const typeInput = document.getElementById('proposalType');
    if (typeInput) {
        typeInput.value = 'Reparcellization';
    }

    const openModal = async () => {
        if (typeof openReparcellizationModal === 'function') {
            openReparcellizationModal({ algorithm: normalizedKey, ownershipMode, singleOwnerLabel });
            return true;
        }
        if (typeof updateStatus === 'function') {
            updateStatus('Loading reparcellization tools...');
        }
        const loaded = await ensureReparcellizationModuleLoaded();
        if (loaded && typeof openReparcellizationModal === 'function') {
            openReparcellizationModal({ algorithm: normalizedKey, ownershipMode, singleOwnerLabel });
            return true;
        }
        console.warn('Reparcellization modal is not yet available.');
        if (typeof showEphemeralMessage === 'function') {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const message = t
                ? t('ephemeral.messages.reparcellization_tools_failed_to_load', 'Reparcellization tools failed to load.')
                : 'Reparcellization tools failed to load.';
            showEphemeralMessage(message, 5000, 'error');
        }
        return false;
    };

    return openModal();
}

function resolveProposalAuthorName() {
    let authorName = '';
    if (typeof getCurrentUsername === 'function') {
        try {
            authorName = getCurrentUsername() || '';
        } catch (e) {
            console.warn('Failed to resolve username for proposal author', e);
        }
    }
    if (!authorName && typeof getCurrentUserAgent === 'function') {
        try {
            const agent = getCurrentUserAgent();
            if (agent && agent.name) {
                authorName = agent.name;
            }
        } catch (e) {
            console.warn('Failed to resolve agent for proposal author', e);
        }
    }
    return authorName;
}

function populateProposalAuthorUI({ inputId = 'proposalAuthor', avatarId = 'proposalAuthorAvatar' } = {}) {
    const input = document.getElementById(inputId);
    const avatarImg = document.getElementById(avatarId);
    const authorName = resolveProposalAuthorName();

    if (input) {
        input.value = authorName;
        input.disabled = true;
    }

    if (avatarImg) {
        let avatarApplied = false;
        if (typeof getCurrentUserAgent === 'function' && typeof getAvatarImagePath === 'function') {
            try {
                const agent = getCurrentUserAgent();
                if (agent && typeof agent.avatarIndex !== 'undefined') {
                    const src = getAvatarImagePath(agent.avatarIndex);
                    if (src) {
                        avatarImg.src = src;
                        avatarImg.alt = `${agent.name || authorName || 'Author'} avatar`;
                        avatarImg.style.display = 'block';
                        avatarApplied = true;
                    }
                }
            } catch (e) {
                console.warn('Failed to set proposal author avatar', e);
            }
        }
        if (!avatarApplied) {
            avatarImg.style.display = 'none';
        }
    }

    return authorName;
}

function getProposalAuthorValue(inputId = 'proposalAuthor') {
    const input = document.getElementById(inputId);
    const value = (input && typeof input.value === 'string') ? input.value.trim() : '';
    return value || resolveProposalAuthorName();
}

function buildProposalScreenshotContext(parcelLayers = []) {
    if (!Array.isArray(parcelLayers) || parcelLayers.length === 0) return null;

    const parcelPolygons = [];
    parcelLayers.forEach(layer => {
        const geom = layer?.feature?.geometry;
        if (!geom || !geom.coordinates) return;
        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
            parcelPolygons.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
            geom.coordinates.forEach(poly => {
                if (Array.isArray(poly)) {
                    parcelPolygons.push(poly);
                }
            });
        }
    });

    let polygon = null;
    const geometry = buildGeometryFromParcels(parcelLayers);
    if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
        polygon = geometry.coordinates;
    } else if (parcelPolygons.length) {
        polygon = parcelPolygons[0];
    }

    let bounds = null;
    if (typeof L !== 'undefined' && L.latLngBounds) {
        parcelLayers.forEach(layer => {
            try {
                if (layer && typeof layer.getBounds === 'function') {
                    const layerBounds = layer.getBounds();
                    if (layerBounds && typeof layerBounds.isValid === 'function' && layerBounds.isValid()) {
                        if (!bounds) {
                            bounds = layerBounds.clone ? layerBounds.clone() : L.latLngBounds(layerBounds);
                        } else {
                            bounds.extend(layerBounds);
                        }
                    }
                }
            } catch (err) {
                console.warn('Failed to extend screenshot bounds from parcel layer', err);
            }
        });
    }

    if (!polygon) return null;
    return { polygon, parcelPolygons, bounds };
}

function buildGeometryFromParcels(parcelLayers = []) {
    if (!parcelLayers.length) return null;

    const parcelFeatures = parcelLayers
        .map(layer => {
            const feature = layer?.feature;
            if (!feature || !feature.geometry) return null;
            try {
                return JSON.parse(JSON.stringify(feature));
            } catch (_) {
                return feature;
            }
        })
        .filter(Boolean);

    let mergedFeature = null;

    // Prefer a plain turf union to avoid the small buffer used by robustUnion, which can seal holes.
    if (parcelFeatures.length && typeof turf !== 'undefined') {
        try {
            let merged = null;
            parcelFeatures.forEach(feature => {
                merged = merged ? (turf.union(merged, feature) || merged) : feature;
            });
            mergedFeature = merged;
        } catch (e) {
            console.warn('turf.union failed for parcel selection geometry, falling back to raw coordinates', e);
        }
    }

    // After union, detect any internal gaps (areas enclosed by the union but not covered by any parcel)
    // and carve them out as holes
    if (mergedFeature && mergedFeature.geometry && typeof turf !== 'undefined' && turf.difference) {
        try {
            // Get the outer shell of the merged geometry (no holes)
            const extractOuterShell = (geom) => {
                if (!geom || !geom.coordinates) return null;
                if (geom.type === 'Polygon') {
                    return { type: 'Polygon', coordinates: [geom.coordinates[0]] };
                }
                if (geom.type === 'MultiPolygon') {
                    return {
                        type: 'MultiPolygon',
                        coordinates: geom.coordinates.map(poly => [poly[0]])
                    };
                }
                return null;
            };

            const outerShell = extractOuterShell(mergedFeature.geometry);
            if (outerShell) {
                const shellFeature = { type: 'Feature', properties: {}, geometry: outerShell };

                // Subtract all original parcels from the shell to find gaps
                let gaps = shellFeature;
                for (const parcel of parcelFeatures) {
                    if (!gaps) break;
                    try {
                        gaps = turf.difference(gaps, parcel);
                    } catch (_) { /* ignore */ }
                }

                // If there are gaps, they represent internal holes that should be preserved
                if (gaps && gaps.geometry && gaps.geometry.coordinates) {
                    const gapGeom = gaps.geometry;
                    const holeRings = [];

                    const collectRings = (geom) => {
                        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates[0])) {
                            holeRings.push(geom.coordinates[0]);
                        } else if (geom.type === 'MultiPolygon') {
                            geom.coordinates.forEach(poly => {
                                if (Array.isArray(poly[0])) holeRings.push(poly[0]);
                            });
                        }
                    };
                    collectRings(gapGeom);

                    // Add the gap rings as holes to the merged geometry
                    if (holeRings.length > 0) {
                        const addHolesToGeometry = (geom, holes) => {
                            if (geom.type === 'Polygon') {
                                return {
                                    type: 'Polygon',
                                    coordinates: [geom.coordinates[0], ...holes]
                                };
                            }
                            if (geom.type === 'MultiPolygon') {
                                // Add holes to the largest polygon
                                let largestIdx = 0;
                                let largestArea = -Infinity;
                                geom.coordinates.forEach((poly, idx) => {
                                    try {
                                        const area = turf.area(turf.polygon([poly[0]]));
                                        if (area > largestArea) {
                                            largestArea = area;
                                            largestIdx = idx;
                                        }
                                    } catch (_) { }
                                });
                                const newCoords = geom.coordinates.map((poly, idx) => {
                                    if (idx === largestIdx) {
                                        return [poly[0], ...holes];
                                    }
                                    return poly;
                                });
                                return { type: 'MultiPolygon', coordinates: newCoords };
                            }
                            return geom;
                        };

                        mergedFeature = {
                            type: 'Feature',
                            properties: mergedFeature.properties || {},
                            geometry: addHolesToGeometry(mergedFeature.geometry, holeRings)
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to detect/preserve internal gaps in parcel selection', e);
        }
    }

    if (mergedFeature && mergedFeature.geometry) {
        if (mergedFeature.geometry.type === 'Polygon') {
            return { type: 'MultiPolygon', coordinates: [mergedFeature.geometry.coordinates] };
        }
        if (mergedFeature.geometry.type === 'MultiPolygon') {
            return { type: 'MultiPolygon', coordinates: mergedFeature.geometry.coordinates };
        }
    }

    const multiCoords = [];
    parcelLayers.forEach(layer => {
        const geom = layer?.feature?.geometry;
        if (!geom || !geom.coordinates) return;
        if (geom.type === 'Polygon') {
            multiCoords.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(rings => multiCoords.push(rings));
        }
    });
    return multiCoords.length ? { type: 'MultiPolygon', coordinates: multiCoords } : null;
}

function areParcelsContiguous(parcels = [], options = {}) {
    const bufferMeters = typeof options.bufferMeters === 'number' ? Math.max(0, options.bufferMeters) : 0.5;
    const features = parcels
        .map(p => (p && p.feature) ? p.feature : p)
        .filter(f => f && f.geometry && f.geometry.coordinates);
    if (features.length <= 1) {
        return { contiguous: features.length === 1, components: features.length };
    }
    if (typeof turf === 'undefined') {
        return { contiguous: true, components: features.length };
    }

    const buffered = features.map(raw => {
        const base = raw.type === 'Feature' ? raw : { type: 'Feature', geometry: raw.geometry || raw, properties: raw.properties || {} };
        try {
            return bufferMeters > 0 ? (turf.buffer(base, bufferMeters, { units: 'meters', steps: 12 }) || base) : base;
        } catch (_) {
            return base;
        }
    });

    const bboxes = buffered.map(f => {
        try { return turf.bbox(f); } catch (_) { return null; }
    });

    const intersects = (a, b, idxA, idxB) => {
        if (!a || !b) return false;
        const bboxA = bboxes[idxA];
        const bboxB = bboxes[idxB];
        if (bboxA && bboxB) {
            const disjoint = bboxA[2] < bboxB[0] || bboxB[2] < bboxA[0] || bboxA[3] < bboxB[1] || bboxB[3] < bboxA[1];
            if (disjoint) return false;
        }
        try { return turf.booleanIntersects(a, b); } catch (_) { }
        try { return !turf.booleanDisjoint(a, b); } catch (_) { }
        return false;
    };

    const visited = new Set([0]);
    const queue = [0];
    while (queue.length) {
        const i = queue.shift();
        for (let j = 0; j < buffered.length; j++) {
            if (visited.has(j)) continue;
            if (intersects(buffered[i], buffered[j], i, j)) {
                visited.add(j);
                queue.push(j);
            }
        }
    }

    return { contiguous: visited.size === buffered.length, components: buffered.length, connectedCount: visited.size };
}

if (typeof window !== 'undefined') {
    window.areParcelsContiguous = areParcelsContiguous;
}

function launchStructureToolForSelection(kind) {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the structure tool.');
        return;
    }
    if (kind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            } else if (typeof alert === 'function') {
                alert('Parcels not contiguous');
            }
            return;
        }
    }
    const geometry = buildGeometryFromParcels(selection.layers);
    if (!geometry) {
        updateStatus('Could not build geometry for the selected parcels.');
        return;
    }
    if (typeof showStructureProposalDialog !== 'function') {
        updateStatus('Structure proposal dialog is unavailable.');
        return;
    }
    closeProposalDialog();
    showStructureProposalDialog({
        kind,
        parcelIds: selection.ids,
        geometry,
        blockName: formatParcelSelectionLabel(selection.ids)
    });
}

function launchUrbanRuleToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the urban rule tool.');
        return;
    }
    if (typeof openUrbanRuleForParcels !== 'function' && typeof openBlockifyForParcels !== 'function') {
        updateStatus('Urban rule generator is unavailable.');
        return;
    }
    const opener = (typeof openUrbanRuleForParcels === 'function') ? openUrbanRuleForParcels : openBlockifyForParcels;
    opener({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

// Backward compatibility alias
function launchBlockifyToolForSelection() {
    return launchUrbanRuleToolForSelection();
}

function launchSingleBuildingToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the single building tool.');
        return;
    }
    if (typeof openSingleBuildingForParcels !== 'function') {
        updateStatus('Single building tool is unavailable.');
        return;
    }
    openSingleBuildingForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

function launchRowHouseToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the row house tool.');
        return;
    }
    if (typeof openRowHouseForParcels !== 'function') {
        updateStatus('Row house tool is unavailable.');
        return;
    }
    openRowHouseForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

function launchParcelBasedToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the parcel-based tool.');
        return;
    }
    if (typeof openParcelBasedForParcels !== 'function') {
        updateStatus('Parcel-based tool is unavailable.');
        return;
    }
    openParcelBasedForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

function generateDefaultProposalName(proposalType) {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const normalizedType = (proposalType || '').toString().trim();
    const typeTranslationKeys = {
        'residences': 'modal.createProposal.goalOptions.buildings',
        'single building': 'modal.createProposal.goalOptions.single',
        'building(s)': 'modal.createProposal.goalOptions.single',
        'park': 'modal.createProposal.goalOptions.park',
        'square': 'modal.createProposal.goalOptions.square',
        'lake': 'modal.createProposal.goalOptions.lake',
        'road/track': 'modal.createProposal.goalOptions.roadTrack',
        'decide later': 'modal.createProposal.goalOptions.decideLater',
        'reparcellization': 'modal.createProposal.proposalTypeOptions.reparcellization',
        'urban rule': 'modal.createProposal.proposalTypeOptions.urbanRule',
        'joint investment': 'modal.createProposal.proposalTypeOptions.jointInvestment',
        'purchase': 'modal.createProposal.proposalTypeOptions.purchase'
    };
    let localizedType = normalizedType;
    if (t && normalizedType) {
        const translationKey = typeTranslationKeys[normalizedType.toLowerCase()];
        if (translationKey) {
            localizedType = t(translationKey, normalizedType);
        } else if (typeof getProposalTypeLabel === 'function') {
            localizedType = getProposalTypeLabel(normalizedType);
        }
    }

    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${localizedType} ${day}${month}-${hour}${minute}`;
}

function generateDefaultProposalDescription(proposalType, proposalName) {
    const authorName = resolveProposalAuthorName() || 'User';
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const normalizedType = (proposalType || '').toString().trim();
    const typeTranslationKeys = {
        'residences': 'modal.createProposal.goalOptions.buildings',
        'single building': 'modal.createProposal.goalOptions.single',
        'building(s)': 'modal.createProposal.goalOptions.single',
        'park': 'modal.createProposal.goalOptions.park',
        'square': 'modal.createProposal.goalOptions.square',
        'lake': 'modal.createProposal.goalOptions.lake',
        'road/track': 'modal.createProposal.goalOptions.roadTrack',
        'decide later': 'modal.createProposal.goalOptions.decideLater',
        'reparcellization': 'modal.createProposal.proposalTypeOptions.reparcellization',
        'urban rule': 'modal.createProposal.proposalTypeOptions.urbanRule',
        'joint investment': 'modal.createProposal.proposalTypeOptions.jointInvestment',
        'purchase': 'modal.createProposal.proposalTypeOptions.purchase'
    };
    let localizedType = normalizedType;
    if (t && normalizedType) {
        const translationKey = typeTranslationKeys[normalizedType.toLowerCase()];
        if (translationKey) {
            localizedType = t(translationKey, normalizedType);
        } else if (typeof getProposalTypeLabel === 'function') {
            localizedType = getProposalTypeLabel(normalizedType);
        }
    }

    const name = proposalName || generateDefaultProposalName(proposalType);
    return `A new ${localizedType} by ${authorName}, ${name}`;
}

function updateProposalNameAndDescription(proposalType, forceUpdate = false) {
    const nameInput = document.getElementById('proposalName');
    const descriptionInput = document.getElementById('proposalDescription');

    if (nameInput) {
        if (forceUpdate || !nameInput.value.trim()) {
            nameInput.value = generateDefaultProposalName(proposalType);
        }
    }

    if (descriptionInput) {
        if (forceUpdate || !descriptionInput.value.trim()) {
            const proposalName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : generateDefaultProposalName(proposalType);
            descriptionInput.value = generateDefaultProposalDescription(proposalType, proposalName);
        }
    }
}

function updateProposalDescription(proposalType, forceUpdate = false) {
    // Legacy function - redirect to new function
    updateProposalNameAndDescription(proposalType, forceUpdate);
}

function handleProposalToolButton(toolKey) {
    if (toolKey === 'lake') {
        const selection = getCurrentParcelSelectionContext();
        if (!selection.layers.length) {
            updateStatus('Select parcels before launching the structure tool.');
            return;
        }
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            } else if (typeof alert === 'function') {
                alert('Parcels not contiguous');
            }
            return;
        }
    }
    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const button = document.querySelector(`.proposal-tool-button[data-proposal-tool="${toolKey}"], .proposal-type-button[data-proposal-tool="${toolKey}"]`);
    const mappedType = button ? button.getAttribute('data-proposal-type') : null;
    const effectiveType = mappedType || DEFAULT_PROPOSAL_TYPE;
    setProposalType(effectiveType);

    // Update secondary sections (acquisition/typology/boundary) based on goal
    updateGoalDependentSections(toolKey);

    // Update name and description with default text (force update when button is clicked)
    updateProposalNameAndDescription(effectiveType, true);

    switch (toolKey) {
        case 'buildings':
            break;
        case 'single':
            break;
        case 'urban-rule':
            // Typology defaults handled in updateGoalDependentSections; defer launching until typology click
            break;
        case 'reparcellization':
            // Boundary adjustment handled in updateGoalDependentSections; avoid immediate launch
            break;
        default:
            break;
    }
}

let teardownProposalBalanceWatcher = null;
let proposalBalanceRequestSeq = 0;
let addressesJsonCache = null;
let addressesJsonPromise = null;

function clearProposalBalanceWatcher() {
    if (typeof teardownProposalBalanceWatcher === 'function') {
        try { teardownProposalBalanceWatcher(); } catch (_) { }
    }
    teardownProposalBalanceWatcher = null;
    proposalBalanceRequestSeq++;
}

function getProposalBalanceChainContext() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const walletManager = globalScope && globalScope.walletManager;
    const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
    let chainId = (walletState && walletState.chainId !== undefined && walletState.chainId !== null)
        ? walletState.chainId
        : null;
    if (!chainId && globalScope) {
        if (globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
            chainId = globalScope.DEFAULT_CHAIN_ID;
        } else {
            const env = globalScope.current_environment || 'production';
            chainId = env === 'development' ? '31337' : '84532';
        }
    }
    const normalizedChainId = typeof normalizeChainIdValue === 'function'
        ? normalizeChainIdValue(chainId)
        : (chainId !== undefined && chainId !== null ? String(chainId) : null);
    const chainSlug = typeof resolveChainSlug === 'function'
        ? resolveChainSlug(normalizedChainId)
        : null;

    return { chainId: normalizedChainId, chainSlug, walletState, walletManager };
}

function readEnvLikeValue(key) {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !key) return null;
    const sources = [
        globalScope,
        globalScope.process && globalScope.process.env,
        globalScope.ENV,
        globalScope.env,
        globalScope.CONFIG,
        globalScope.config
    ];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
            const value = source[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
            } else {
                return String(value);
            }
        }
    }
    return null;
}

async function loadAddressesJson() {
    if (addressesJsonCache) return addressesJsonCache;
    if (addressesJsonPromise) return addressesJsonPromise;
    addressesJsonPromise = (async () => {
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                addressesJsonCache = data || {};
                return addressesJsonCache;
            }
        } catch (error) {
            console.warn('Failed to load addresses.json', error);
        }
        addressesJsonCache = {};
        return addressesJsonCache;
    })();
    return addressesJsonPromise;
}

async function resolveErc20AddressForCurrency(currency, options = {}) {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const code = currency ? currency.toString().trim().toUpperCase() : '';
    if (!globalScope || !code) return null;

    const chainIdRaw = options.chainId || (options.walletState && options.walletState.chainId);
    const normalizedChainId = typeof normalizeChainIdValue === 'function'
        ? normalizeChainIdValue(chainIdRaw)
        : (chainIdRaw !== undefined && chainIdRaw !== null ? String(chainIdRaw) : null);
    const chainSlug = options.chainSlug || (typeof resolveChainSlug === 'function' ? resolveChainSlug(normalizedChainId) : null);
    const variants = new Set();

    const addVariant = (value) => {
        if (!value && value !== 0) return;
        const str = String(value).trim();
        if (str) {
            variants.add(str);
            variants.add(str.replace(/[^a-zA-Z0-9]/g, '_'));
        }
    };

    addVariant(chainSlug);
    if (normalizedChainId !== undefined && normalizedChainId !== null) {
        addVariant(normalizedChainId);
        const numeric = Number(normalizedChainId);
        if (Number.isFinite(numeric)) {
            const hex = '0x' + Math.trunc(numeric).toString(16);
            addVariant(hex);
            addVariant(hex.toUpperCase());
        }
    }

    // 1) ContractsLoader (contracts.json) if available
    if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
        try {
            const addr = await globalScope.ContractsLoader.getContractAddress(normalizedChainId, code);
            if (addr) return addr;
        } catch (err) {
            console.warn('ContractsLoader token lookup failed', err);
        }
    }

    // 2) addresses.json fallback (same file used for other settings)
    try {
        const data = await loadAddressesJson();
        if (data && normalizedChainId && data[normalizedChainId] && data[normalizedChainId][code]) {
            return data[normalizedChainId][code];
        }
    } catch (err) {
        console.warn('addresses.json token lookup failed', err);
    }

    // 3) environment-like variables
    const keys = [];
    Array.from(variants).forEach(variant => {
        const cleaned = String(variant).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
        if (cleaned) {
            keys.push(`${code}_ERC20_ADDRESS_${cleaned}`);
        }
    });

    for (const key of keys) {
        const value = readEnvLikeValue(key);
        if (value) return value;
    }

    // 4) global maps
    const maps = [
        globalScope.ERC20_ADDRESSES,
        globalScope.erc20Addresses,
        globalScope.tokenAddresses,
        globalScope.TOKEN_ADDRESSES
    ];
    for (const map of maps) {
        if (!map || typeof map !== 'object') continue;
        const entry = map[code] || map[code.toLowerCase()] || map[code.toUpperCase()];
        if (!entry) continue;
        if (typeof entry === 'string' && entry.trim()) {
            return entry.trim();
        }
        if (typeof entry === 'object') {
            for (const variant of variants) {
                const candidates = [
                    entry[variant],
                    entry[String(variant).toLowerCase()],
                    entry[String(variant).toUpperCase()],
                    entry[String(variant).replace(/[^a-zA-Z0-9]/g, '_')],
                    entry[String(variant).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()]
                ];
                const found = candidates.find(value => typeof value === 'string' && value.trim());
                if (found) return found.trim();
            }
        }
    }

    return null;
}

function formatProposalBalanceText(key, params = {}) {
    const t = getProposalI18nHelper();
    const valueMap = {
        placeholder: t('modal.createProposal.balance.placeholder', '--'),
        notOnChain: t('modal.createProposal.balance.notOnChain', 'not on-chain'),
        connectWallet: t('modal.createProposal.balance.connectWallet', 'Connect wallet'),
        unavailable: t('modal.createProposal.balance.unavailable', 'unavailable'),
        missingTokenAddress: t('modal.createProposal.balance.missingTokenAddress', 'token address missing')
    };

    let value;
    if (key === 'value') {
        const amount = params.amount !== undefined && params.amount !== null ? String(params.amount) : '--';
        const currency = params.currency ? String(params.currency) : '';
        value = t('modal.createProposal.balance.value', '{{amount}} {{currency}}', { amount, currency: currency.trim() });
    } else {
        value = valueMap[key] || params.custom || valueMap.placeholder;
    }

    return t('modal.createProposal.balance.label', 'Balance: {{value}}', { value });
}

function ensureProposalOfferBalanceElement() {
    let hint = document.getElementById('proposalOfferBalanceHint');
    if (hint) return hint;
    const offerInput = document.getElementById('proposalOffer');
    const formGroup = offerInput ? offerInput.closest('.form-group') : null;
    if (!formGroup) return null;
    hint = document.createElement('div');
    hint.id = 'proposalOfferBalanceHint';
    hint.className = 'proposal-offer-balance';
    hint.textContent = formatProposalBalanceText('placeholder');
    formGroup.appendChild(hint);
    return hint;
}

async function refreshProposalBalanceDisplay() {
    const balanceEl = ensureProposalOfferBalanceElement();
    const currencySelect = document.getElementById('proposalCurrency');
    const currency = currencySelect && currencySelect.value ? currencySelect.value.toUpperCase() : 'USDT';
    if (!balanceEl) return;
    const requestId = ++proposalBalanceRequestSeq;
    const tBalance = (statusKey, valueParams = {}) => formatProposalBalanceText(statusKey, valueParams);
    const setText = (text) => {
        if (requestId === proposalBalanceRequestSeq && balanceEl) {
            balanceEl.textContent = text;
        }
    };

    if (!currency) {
        setText(tBalance('placeholder'));
        return;
    }

    if (['EUR', 'USD', 'ARS'].includes(currency)) {
        setText(tBalance('notOnChain'));
        return;
    }

    const { chainId, chainSlug, walletState, walletManager } = getProposalBalanceChainContext();
    const account = walletState && Array.isArray(walletState.accounts) && walletState.accounts.length > 0
        ? walletState.accounts[0]
        : null;

    if (!walletManager || !account || typeof walletManager.getProvider !== 'function') {
        setText(tBalance('connectWallet'));
        return;
    }
    const provider = walletManager.getProvider();
    if (!provider || !window.ethers || !window.ethers.BrowserProvider || !window.ethers.Contract) {
        setText(tBalance('unavailable'));
        return;
    }

    try {
        const browserProvider = new window.ethers.BrowserProvider(provider);

        if (currency === 'ETH') {
            const wei = await browserProvider.getBalance(account);
            const ethAmount = Number(window.ethers.formatEther(wei));
            const valueText = Number.isFinite(ethAmount)
                ? ethAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })
                : window.ethers.formatEther(wei);
            setText(tBalance('value', { amount: valueText, currency: 'ETH' }));
            return;
        }

        const tokenAddress = await resolveErc20AddressForCurrency(currency, { chainId, chainSlug, walletState });
        if (!tokenAddress) {
            setText(tBalance('missingTokenAddress'));
            return;
        }

        const abi = [
            'function balanceOf(address) view returns (uint256)',
            'function decimals() view returns (uint8)'
        ];
        const contract = new window.ethers.Contract(tokenAddress, abi, browserProvider);
        const [rawBalance, decimals] = await Promise.all([
            contract.balanceOf(account),
            typeof contract.decimals === 'function' ? contract.decimals().catch(() => null) : Promise.resolve(null)
        ]);
        const decimalsNum = Number(decimals);
        const appliedDecimals = Number.isFinite(decimalsNum) && decimalsNum >= 0 ? decimalsNum : 18;
        const formatted = window.ethers.formatUnits(rawBalance, appliedDecimals);
        const numeric = Number(formatted);
        const pretty = Number.isFinite(numeric)
            ? numeric.toLocaleString(undefined, { maximumFractionDigits: 4 })
            : formatted;
        setText(tBalance('value', { amount: pretty, currency }));
    } catch (error) {
        console.warn('Failed to fetch proposal currency balance', { currency, error });
        setText(tBalance('unavailable'));
    }
}

function attachProposalCurrencyHandlers() {
    const currencySelect = document.getElementById('proposalCurrency');
    if (!currencySelect) {
        clearProposalBalanceWatcher();
        return;
    }

    clearProposalBalanceWatcher();

    const hasUsdtOption = Array.from(currencySelect.options || []).some(opt => opt && opt.value === 'USDT');
    if (hasUsdtOption) {
        currencySelect.value = 'USDT';
    }

    const balanceEl = ensureProposalOfferBalanceElement();
    if (!balanceEl) return;

    const refreshBalance = () => refreshProposalBalanceDisplay();
    currencySelect.addEventListener('change', refreshBalance);

    const { walletManager } = getProposalBalanceChainContext();
    let detachWalletListeners = null;
    if (walletManager && typeof walletManager.on === 'function') {
        const offState = walletManager.on('stateChanged', refreshBalance);
        const offConnect = walletManager.on('connect', refreshBalance);
        const offDisconnect = walletManager.on('disconnect', refreshBalance);
        const offChain = walletManager.on('chainChanged', refreshBalance);
        const offAccounts = walletManager.on('accountsChanged', refreshBalance);
        detachWalletListeners = () => {
            offState && offState();
            offConnect && offConnect();
            offDisconnect && offDisconnect();
            offChain && offChain();
            offAccounts && offAccounts();
        };
    }

    teardownProposalBalanceWatcher = () => {
        currencySelect.removeEventListener('change', refreshBalance);
        if (typeof detachWalletListeners === 'function') {
            detachWalletListeners();
        }
        teardownProposalBalanceWatcher = null;
    };

    refreshBalance();
}

// Show proposal creation dialog
function showProposalDialog() {
    // Gate: require personalized profile to create proposals
    if (requirePersonalizedUser()) {
        return;
    }

    const t = getProposalI18nHelper();
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const noParcelsMessage = t(
        'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
        'Please select at least one parcel to create a proposal.'
    );
    const modalTitle = t('modal.createProposal.title', 'Create Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const proposalTypeLabel = t('modal.createProposal.proposalTypeLabel', 'Proposal Type:');
    const proposalGoalLabel = t('modal.createProposal.proposalGoalLabel', 'Proposal Goal:');
    const proposalTypologyLabel = t('modal.createProposal.typologyLabel', 'Typology');
    const acquisitionLabel = t('modal.createProposal.acquisitionLabel', 'Acquisition strategy');
    const acquisitionOptions = {
        full: t('modal.createProposal.acquisitionOptions.full', 'Full acquisition'),
        partial: t('modal.createProposal.acquisitionOptions.partial', 'Partial acquisition'),
        partialPreferred: t('modal.createProposal.acquisitionOptions.partialPreferred', 'Partial acquisition preferred')
    };
    const ownershipLabel = t('modal.createProposal.ownershipLabel', 'Ownership');
    const ownershipOptions = {
        single: t('modal.createProposal.ownershipOptions.single', 'Single owner'),
        multiple: t('modal.createProposal.ownershipOptions.multiple', 'Multiple owners')
    };
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const namePlaceholder = t('modal.createProposal.namePlaceholderProposal', 'Proposal name');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const unknownOwnerLabel = t('modal.createProposal.ownerUnknown', 'Unknown');
    const formatOwnerTooltip = (name) => t('modal.createProposal.ownerTooltip', 'Owner: {{name}}', { name });
    const proposalTypeLabels = {
        Purchase: t('modal.createProposal.proposalTypeOptions.purchase', 'Purchase'),
        'Urban Rule': t('modal.createProposal.proposalTypeOptions.urbanRule', 'Urban Rule'),
        Reparcellization: t('modal.createProposal.proposalTypeOptions.reparcellization', 'Reparcellization'),
        'Joint Investment': t('modal.createProposal.proposalTypeOptions.jointInvestment', 'Joint Investment')
    };
    const goalLabels = {
        buildings: t('modal.createProposal.goalOptions.buildings', 'Buildings'),
        single: t('modal.createProposal.goalOptions.single', 'Building(s)'),
        park: t('modal.createProposal.goalOptions.park', 'Park'),
        square: t('modal.createProposal.goalOptions.square', 'Square'),
        lake: t('modal.createProposal.goalOptions.lake', 'Lake'),
        roadTrack: t('modal.createProposal.goalOptions.roadTrack', 'Road/Track'),
        decideLater: t('modal.createProposal.goalOptions.decideLater', 'Decide later'),
        urbanRule: t('modal.createProposal.goalOptions.urbanRule', 'Urban Rule'),
        reparcellization: t('modal.createProposal.goalOptions.reparcellization', 'Reparcellization')
    };
    proposalAcquisitionLabels = {
        full: acquisitionOptions.full,
        partial: acquisitionOptions.partial,
        partialPreferred: acquisitionOptions.partialPreferred
    };
    const typologyOptions = {
        block: t('modal.createProposal.typologyOptions.block', 'Block'),
        row: t('modal.createProposal.typologyOptions.row', 'Row'),
        parcelBased: t('modal.createProposal.typologyOptions.parcelBased', 'Parcel-based')
    };
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholder', 'Describe your proposal...');
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    const conditionalLabel = t('modal.createProposal.options.conditional', 'Conditional');
    const conditionalHelperOnText = t('modal.createProposal.options.conditionalHelperOn', 'Pay reward only if/when all owners accept');
    const conditionalHelperOffText = t('modal.createProposal.options.conditionalHelperOff', 'Payout only when all parcels accept');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryTitle = t('modal.createProposal.summary.title', 'Proposal Summary');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summaryOwnersLabel = t('modal.createProposal.summary.owners', 'Total owners:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const similarTitle = t('modal.createProposal.similar.title', 'Similar proposals:');
    const similarUnknownTitle = t('modal.createProposal.similar.unknownTitle', 'Untitled proposal');
    const similarUnknownAuthor = t('modal.createProposal.similar.unknownAuthor', 'Unknown');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const selection = getCurrentParcelSelectionContext();
    const selectedParcels = selection.layers;
    const parcelIds = selection.ids;
    const isSingleParcelSelection = selectedParcels.length === 1;
    const screenshotContext = buildProposalScreenshotContext(selectedParcels);

    currentProposalTool = null;

    if (!selectedParcels.length) {
        updateStatus(noParcelsMessage);
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    const ownershipStats = computeOwnershipStatsFromSelection(selection);
    const totalOwners = ownershipStats.ownerCount || selectedParcels.length;
    const ownershipMode = ownershipStats.mode;
    currentOwnershipMode = ownershipMode;

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId || unknownParcelLabel) || unknownParcelLabel;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    const ownerName = owner.name || unknownOwnerLabel;
                    const ownerTooltip = formatOwnerTooltip(ownerName);
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 20px; height: 20px; border-radius: 50%; border: 2px solid #007bff; margin-right: 6px;" title="${ownerTooltip}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item" style="display: flex; align-items: center;">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">${parcelLabel} ${parcelNumber}</span>
                </div>
            </div>
        `;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                ${screenshotContext ? '<div class="form-group" id="proposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                <div class="form-group">
                    <div class="proposal-author-row">
                        <label for="proposalAuthor">${authorLabel}</label>
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                        <input type="text" id="proposalAuthor" placeholder="${authorPlaceholder}" disabled>
                    </div>
                </div>
                <div class="form-group" id="proposalMainTypeGroup" style="display:none;">
                    <label>${proposalTypeLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button selected" data-proposal-main-type="Purchase" onclick="setProposalMainType('Purchase')">${proposalTypeLabels.Purchase}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Urban Rule" onclick="handleUrbanRuleMainTypeClick()">${proposalTypeLabels['Urban Rule']}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Reparcellization" onclick="setProposalMainType('Reparcellization')">${proposalTypeLabels.Reparcellization}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Joint Investment" disabled>${proposalTypeLabels['Joint Investment']}</button>
                    </div>
                </div>
                <input type="hidden" id="proposalMainType" value="Purchase">
                <div class="form-group" id="proposalGoalGroup">
                    <label>${proposalGoalLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="square" data-proposal-type="Square" onclick="handleProposalToolButton('square')">${goalLabels.square}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="park" data-proposal-type="Park" onclick="handleProposalToolButton('park')">${goalLabels.park}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="lake" data-proposal-type="Lake" onclick="handleProposalToolButton('lake')">${goalLabels.lake}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="single" data-proposal-type="Building(s)" onclick="handleProposalToolButton('single')">${goalLabels.single}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="road-track" data-proposal-type="Road/Track" onclick="handleProposalToolButton('road-track')">${goalLabels.roadTrack}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="decide-later" data-proposal-type="Decide later" onclick="handleProposalToolButton('decide-later')">${goalLabels.decideLater}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="urban-rule" data-proposal-type="Urban Rule" onclick="handleProposalToolButton('urban-rule')">${goalLabels.urbanRule}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="reparcellization" data-proposal-type="Reparcellization" onclick="handleProposalToolButton('reparcellization')">${goalLabels.reparcellization}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalAcquisitionGroup">
                    <label>${acquisitionLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-acquisition-button" data-acquisition-mode="full" onclick="setProposalAcquisitionMode('full')">${acquisitionOptions.full}</button>
                        <button type="button" class="btn proposal-type-button proposal-acquisition-button" data-acquisition-mode="partial" onclick="setProposalAcquisitionMode('partial')">${acquisitionOptions.partial}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalTypologyGroup" style="display:none;">
                    <label>${proposalTypologyLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="block" onclick="handleUrbanRuleTypologyClick('block', { skipLaunch: true })">${typologyOptions.block}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="row" onclick="handleUrbanRuleTypologyClick('row', { skipLaunch: true })">${typologyOptions.row}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="parcelBased" onclick="handleUrbanRuleTypologyClick('parcelBased', { skipLaunch: true })">${typologyOptions.parcelBased}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalBoundaryGroup" style="display:none;">
                    <label>${ownershipLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-boundary-button" data-boundary-mode="single" onclick="setProposalBoundaryMode('single')">${ownershipOptions.single}</button>
                        <button type="button" class="btn proposal-type-button proposal-boundary-button" data-boundary-mode="multiple" onclick="setProposalBoundaryMode('multiple')">${ownershipOptions.multiple}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalGeometryGroup" style="display:none;">
                    <label>${t('modal.createProposal.geometry.label', 'Geometry')}</label>
                    <div id="proposalGeometryStatus" class="proposal-geometry-status" style="font-size:12px; color:#4b5563; margin-bottom:6px;">${t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry')}</div>
                    <div class="proposal-type-group proposal-geometry-buttons" id="proposalGeometryButtons" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px;"></div>
                </div>
                <input type="hidden" id="proposalType" value="">
                <input type="hidden" id="proposalAcquisitionMode" value="full">
                <input type="hidden" id="proposalBoundaryMode" value="multiple">
                <div class="form-group">
                    <label for="proposalName" style="display: flex; align-items: center; gap: 8px;">
                        <span>${nameLabel}</span>
                        <input type="text" id="proposalName" style="flex: 1;" placeholder="${namePlaceholder}">
                    </label>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <input type="text" id="proposalDescription" class="proposal-description-input" placeholder="${descriptionPlaceholder}">
                </div>
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>${optionsLabel}</label>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalConditionalCheckbox" checked>
                            <label for="proposalConditionalCheckbox" style="margin:0; cursor:pointer;">${conditionalLabel}</label>
                        </div>
                        <div id="proposalConditionalHelperText" style="${optionHelperStyle} flex:1;">
                            ${conditionalHelperOnText}
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary collapsible collapsed" id="proposalSummarySection">
                    <div class="collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalSummaryContent" onclick="(function(e){
                        var section = document.getElementById('proposalSummarySection');
                        var content = document.getElementById('proposalSummaryContent');
                        var icon = document.getElementById('proposalSummaryChevron');
                        var expanded = section.classList.toggle('collapsed');
                        if (section.classList.contains('collapsed')) {
                            content.style.display = 'none';
                            icon.classList.remove('fa-chevron-up');
                            icon.classList.add('fa-chevron-down');
                            section.setAttribute('aria-expanded', 'false');
                        } else {
                            content.style.display = '';
                            icon.classList.remove('fa-chevron-down');
                            icon.classList.add('fa-chevron-up');
                            section.setAttribute('aria-expanded', 'true');
                        }
                    })(event)">
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">${summaryTitle}</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                            <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong>${summaryOwnersLabel}</strong> ${totalOwners}</p>
                        </div>
                        <div class="parcel-list">
                            <h4>${summarySelectedLabel}</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
                <div class="proposal-similar-section" id="proposalSimilarSection" style="margin-top:12px; display:none;">
                    <h4 style="margin-bottom:6px;">${similarTitle}</h4>
                    <div id="proposalSimilarList" class="proposal-similar-list" style="display:flex; flex-direction:column; gap:6px;"></div>
                </div>
            </div>
            <div class="proposal-modal-footer lens-footer-layout">
                <div class="lens-footer-row">
                    <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; width:100%;">
                    <button id="createProposalSubmitButton" class="btn btn-proposal" onclick="createProposal()">${submitLabel}</button>
                    <div id="proposalGeometryRequirementHint" style="font-size:11px; color:#c00; min-height:14px; text-align:right;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Reset stored screenshot
    proposalModalScreenshotDataUrl = null;

    if (screenshotContext && screenshotContext.polygon && window.MapScreenshot && typeof window.MapScreenshot.renderPolygonPreview === 'function') {
        const screenshotContainer = modal.querySelector('#proposalScreenshotContainer');
        if (screenshotContainer) {
            (async () => {
                try {
                    const previewWrapper = document.createElement('div');
                    previewWrapper.className = 'map-screenshot-container';
                    previewWrapper.style.margin = '0 auto';
                    screenshotContainer.appendChild(previewWrapper);

                    window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                        polygon: screenshotContext.polygon,
                        bounds: screenshotContext.bounds || null,
                        padding: 0.05,
                        parcelPolygons: screenshotContext.parcelPolygons
                    });

                    // Capture the screenshot after tiles have loaded and store it for minting
                    const captureScreenshot = async () => {
                        if (!previewWrapper._leafletPreviewMap) {
                            console.warn('[proposal-modal] Preview map not ready for capture');
                            return;
                        }
                        try {
                            let dataUrl = null;
                            // First try leaflet-image capture from preview
                            if (window.MapScreenshot.captureFromPreview) {
                                dataUrl = await window.MapScreenshot.captureFromPreview(previewWrapper);
                            }

                            // Validate the screenshot
                            let byteSize = 0;
                            if (dataUrl && dataUrl.startsWith('data:image/')) {
                                const base64Part = dataUrl.split(',')[1];
                                byteSize = base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                            }

                            // If capture succeeded and is large enough, store it
                            if (byteSize >= 10000) {
                                proposalModalScreenshotDataUrl = dataUrl;
                                console.debug('[proposal-modal] Screenshot captured and stored', { bytes: byteSize });
                                return;
                            }

                            // Fallback: try tile stitching
                            console.warn('[proposal-modal] Screenshot too small (' + byteSize + ' bytes), trying tile stitch fallback');
                            if (window.MapScreenshot.captureViaTileStitch && screenshotContext && screenshotContext.polygon) {
                                try {
                                    dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                        polygon: screenshotContext.polygon,
                                        parcelPolygons: screenshotContext.parcelPolygons || [],
                                        bounds: screenshotContext.bounds || null,
                                        padding: 0.12,
                                        zoom: 19
                                    });
                                    console.debug('[proposal-modal] Tile stitch returned, checking result...');
                                    console.debug('[proposal-modal] dataUrl type:', typeof dataUrl, 'length:', dataUrl?.length);
                                    console.debug('[proposal-modal] starts with data:image:', dataUrl?.startsWith?.('data:image/'));
                                    if (dataUrl && dataUrl.startsWith('data:image/')) {
                                        const base64Part = dataUrl.split(',')[1];
                                        byteSize = base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                                        console.debug('[proposal-modal] Computed byteSize:', byteSize);
                                        if (byteSize >= 5000) {
                                            proposalModalScreenshotDataUrl = dataUrl;
                                            console.debug('[proposal-modal] Tile stitch screenshot captured and stored', { bytes: byteSize });

                                            // Overlay the stitched image on top of the Leaflet preview
                                            // DON'T remove the map - leaflet-image might still be using it
                                            if (previewWrapper) {
                                                // Create an overlay image instead of replacing
                                                const existingOverlay = previewWrapper.querySelector('.tile-stitch-overlay');
                                                if (existingOverlay) {
                                                    existingOverlay.remove();
                                                }
                                                const img = document.createElement('img');
                                                img.className = 'tile-stitch-overlay';
                                                img.src = dataUrl;
                                                img.style.position = 'absolute';
                                                img.style.top = '0';
                                                img.style.left = '0';
                                                img.style.width = '100%';
                                                img.style.height = '100%';
                                                img.style.objectFit = 'contain';
                                                img.style.borderRadius = '8px';
                                                img.style.zIndex = '1000';
                                                img.style.pointerEvents = 'none';
                                                // Make container relative for absolute positioning
                                                previewWrapper.style.position = 'relative';
                                                previewWrapper.appendChild(img);
                                                console.debug('[proposal-modal] Overlay image added on top of preview');
                                            }
                                            return;
                                        }
                                    }
                                    console.warn('[proposal-modal] Tile stitch also produced small image:', byteSize, 'bytes');
                                } catch (stitchErr) {
                                    console.error('[proposal-modal] Tile stitch fallback failed:', stitchErr);
                                }
                            }
                        } catch (err) {
                            console.warn('[proposal-modal] Failed to capture screenshot for storage:', err);
                        }
                    };

                    // Wait for map to be ready and tiles to load
                    const waitForMapAndCapture = () => {
                        const map = previewWrapper._leafletPreviewMap;
                        if (!map) {
                            // Map not set yet, try again shortly
                            setTimeout(waitForMapAndCapture, 100);
                            return;
                        }

                        // Find tile layer and wait for it to load
                        let tileLayer = null;
                        map.eachLayer(layer => {
                            if (layer._url && !tileLayer) {
                                tileLayer = layer;
                            }
                        });

                        if (tileLayer) {
                            // Listen for tile load completion
                            let captured = false;
                            const onLoad = () => {
                                if (captured) return;
                                captured = true;
                                tileLayer.off('load', onLoad);
                                // Small delay after load event to ensure rendering is complete
                                setTimeout(captureScreenshot, 300);
                            };
                            tileLayer.on('load', onLoad);
                            // Timeout fallback - capture after 4 seconds regardless
                            setTimeout(() => {
                                if (!captured) {
                                    captured = true;
                                    tileLayer.off('load', onLoad);
                                    captureScreenshot();
                                }
                            }, 4000);
                        } else {
                            // No tile layer found, just wait and capture
                            setTimeout(captureScreenshot, 2000);
                        }
                    };

                    // Start waiting for map
                    setTimeout(waitForMapAndCapture, 50);
                } catch (error) {
                    console.warn('Failed to render proposal screenshot preview', error);
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

    // Lock secondary selectors that are derived from the selected goal.
    // Urban Rule typology is a user choice and must remain selectable because the Geometry → Edit action
    // opens different modals depending on the selected typology (block/row/parcelBased).
    const lockSecondarySelectors = () => {
        const secondaryGroupIds = ['proposalAcquisitionGroup', 'proposalBoundaryGroup'];
        secondaryGroupIds.forEach(groupId => {
            const groupEl = modal.querySelector(`#${groupId}`);
            if (!groupEl) return;
            groupEl.classList.add('proposal-secondary-locked');
            const buttons = groupEl.querySelectorAll('.proposal-type-button');
            buttons.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('proposal-selection-static');
                btn.setAttribute('aria-disabled', 'true');
            });
        });
    };

    lockSecondarySelectors();

    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    // Default to Square goal on open (force-select)
    handleProposalToolButton('square');
    setProposalType(DEFAULT_PROPOSAL_TYPE);
    setProposalAcquisitionMode('full');
    setProposalBoundaryMode(ownershipMode || 'multiple', { lock: true });

    // Check contiguity and disable buttons that require contiguous parcels
    applyContiguityConstraints();

    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    const conditionalHelper = document.getElementById('proposalConditionalHelperText');
    const conditionalRow = conditionalCheckbox ? conditionalCheckbox.closest('.proposal-option-row') : null;
    const updateConditionalHelper = () => {
        if (!conditionalHelper || !conditionalCheckbox) return;
        conditionalHelper.textContent = conditionalCheckbox.checked
            ? conditionalHelperOnText
            : conditionalHelperOffText;
    };
    if (conditionalCheckbox) {
        const disableConditional = isSingleParcelSelection;
        conditionalCheckbox.checked = !disableConditional;
        conditionalCheckbox.disabled = disableConditional;
        if (conditionalRow) {
            conditionalRow.style.opacity = disableConditional ? '0.6' : '';
            conditionalRow.style.cursor = '';
        }
        conditionalCheckbox.addEventListener('change', updateConditionalHelper);
    }
    updateConditionalHelper();

    // Pre-fill the offer amount with a random value between 1 and 1,000,000 EUR
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1;
        const maxOfferEur = 1000000;
        const randomOffer = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
        offerInput.value = window.formatProposalOfferValue(randomOffer);
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Pre-fill name and description with default text based on default proposal type
    updateProposalNameAndDescription(DEFAULT_PROPOSAL_TYPE);

    // Update description when name changes
    const nameInput = document.getElementById('proposalName');
    const descriptionInput = document.getElementById('proposalDescription');
    if (nameInput && descriptionInput) {
        nameInput.addEventListener('input', () => {
            const proposalType = document.getElementById('proposalType')?.value || DEFAULT_PROPOSAL_TYPE;
            const proposalName = nameInput.value.trim() || generateDefaultProposalName(proposalType);
            descriptionInput.value = generateDefaultProposalDescription(proposalType, proposalName);
        });
    }

    attachProposalCurrencyHandlers();

    // Focus the default Square goal button to avoid triggering mobile keyboards
    const squareButton = modal.querySelector('.proposal-type-button[data-proposal-tool="square"]');
    if (squareButton) {
        squareButton.focus();
    }

    updateCreateProposalSubmitState();

    // Show similar proposals for the selected parcel set
    const similarSection = document.getElementById('proposalSimilarSection');
    const similarList = document.getElementById('proposalSimilarList');
    if (similarSection && similarList && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getSimilarProposalsByParcelIds === 'function') {
        const similarProposals = proposalStorage.getSimilarProposalsByParcelIds(parcelIds);
        if (similarProposals && similarProposals.length > 0) {
            similarSection.style.display = '';
            const itemsHtml = similarProposals.map(p => {
                const proposalId = p.proposalId || '';
                const title = typeof escapeHtml === 'function' ? escapeHtml(p.title || similarUnknownTitle) : (p.title || similarUnknownTitle);
                const author = typeof escapeHtml === 'function' ? escapeHtml(p.author || similarUnknownAuthor) : (p.author || similarUnknownAuthor);
                const typeLabel = typeof formatProposalTypeLabel === 'function'
                    ? formatProposalTypeLabel(getProposalLifecycleKey ? getProposalLifecycleKey(p) : (p.type || 'parcel'))
                    : (p.type || 'parcel');
                const createdDate = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
                return `
                    <div class="proposal-similar-item" data-proposal-id="${proposalId}" style="display:flex; flex-direction:column; gap:2px; padding:8px; border:1px solid #ddd; border-radius:6px; cursor:pointer; background:#fafafa;">
                        <span style="font-weight:600;">${title}</span>
                        <span style="font-size:12px; color:#555;">${author}${createdDate ? ` • ${createdDate}` : ''}</span>
                        <span style="font-size:12px; color:#555;">${typeLabel}</span>
                    </div>
                `;
            }).join('');
            similarList.innerHTML = itemsHtml;
            similarList.querySelectorAll('.proposal-similar-item').forEach(item => {
                const proposalId = item.getAttribute('data-proposal-id');
                item.addEventListener('click', () => {
                    if (proposalId && typeof openProposalFromList === 'function') {
                        openProposalFromList(proposalId, {
                            closeProposalList: false,
                            closeParcelInfo: false,
                            collapseSidebar: false
                        });
                    }
                });
            });
        } else {
            similarSection.style.display = 'none';
        }
    }
}

// Close proposal dialog
function closeProposalDialog() {
    clearProposalBalanceWatcher();
    const modal = document.querySelector('.create-proposal-modal');
    if (modal) {
        modal.remove();
    }
    currentProposalTool = null;
    proposalModalScreenshotDataUrl = null; // Clear stored screenshot
    setProposalModalDimmed(false);
    if (typeof setPendingBuildingProposalContext === 'function') {
        setPendingBuildingProposalContext(null);
    } else if (typeof window !== 'undefined') {
        window.pendingBuildingProposalContext = null;
        window.pendingBuildingFromBlockify = null;
    }
    if (typeof window !== 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    if (typeof clearSingleBuildingPendingState === 'function') {
        clearSingleBuildingPendingState();
    } else if (typeof window !== 'undefined') {
        window.pendingSingleBuildingFeature = null;
        window.pendingSingleBuildingFeatures = null;
    }
}

// Toggle expiry time input when checkbox is changed
function toggleExpiryInput() {
    const checkbox = document.getElementById('proposalExpireCheckbox');
    const timeInput = document.getElementById('proposalExpiryTime');
    if (checkbox && timeInput) {
        timeInput.disabled = !checkbox.checked;
        if (checkbox.checked) {
            timeInput.focus();
            timeInput.select();
        }
    }
}

// Toggle decay inputs when checkbox is changed
function toggleDecayInput() {
    const checkbox = document.getElementById('proposalDecayCheckbox');
    const percentInput = document.getElementById('proposalDecayPercent');
    const timeInput = document.getElementById('proposalDecayTime');
    if (checkbox && percentInput && timeInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        timeInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

// Toggle deposit input when checkbox is changed
function toggleDepositInput() {
    const checkbox = document.getElementById('proposalDepositCheckbox');
    const percentInput = document.getElementById('proposalDepositPercent');
    if (checkbox && percentInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

// Calculate current offer amount considering decay
function calculateDecayedOffer(proposal) {
    if (!proposal || !proposal.offer) return proposal?.offer || 0;
    if (!proposal.decayEnabled || !proposal.decayPercent || !proposal.decayDurationMs) {
        return proposal.offer;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return proposal.offer;
    if (elapsed >= proposal.decayDurationMs) {
        // Decay complete - return minimum amount
        const decayAmount = (proposal.offer * proposal.decayPercent) / 100;
        return proposal.offer - decayAmount;
    }

    // Linear decay over time
    const progress = elapsed / proposal.decayDurationMs;
    const decayAmount = (proposal.offer * proposal.decayPercent * progress) / 100;
    return proposal.offer - decayAmount;
}

// Get decay progress (0 to 1) for visual representation
function getDecayProgress(proposal) {
    if (!proposal || !proposal.decayEnabled || !proposal.decayDurationMs) {
        return 0;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return 0;
    if (elapsed >= proposal.decayDurationMs) return 1;

    return elapsed / proposal.decayDurationMs;
}

// Parse expiry time string (format: XXh:YYm:ZZs) and return milliseconds
function parseExpiryTime(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/^(\d{1,2})h:(\d{1,2})m:(\d{1,2})s$/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10) || 0;
    const minutes = parseInt(match[2], 10) || 0;
    const seconds = parseInt(match[3], 10) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

// Check if a proposal has expired based on its expiresAt timestamp
function isProposalExpired(proposal) {
    if (!proposal || !proposal.expiresAt) return false;
    const status = (proposal.status || '').toLowerCase();
    if (status === 'executed') return false; // Executed proposals no longer expire
    return new Date(proposal.expiresAt).getTime() <= Date.now();
}

// Update proposal status to Expired if it has expired
function checkAndUpdateProposalExpiry(proposal) {
    if (!proposal) return proposal;
    if (isProposalExpired(proposal)) {
        const currentStatus = (proposal.status || '').toLowerCase();
        if (currentStatus !== 'expired' && currentStatus !== 'executed') {
            proposal.status = 'Expired';
            proposal.updatedAt = new Date().toISOString();
            if (proposal.proposalId && typeof proposalStorage !== 'undefined') {
                proposalStorage.updateProposalStatus(proposal.proposalId, 'Expired');
                proposalStorage.save();
            }
        }
    }
    return proposal;
}

// Store the interval ID for the expiry countdown so we can clear it
let expiryCountdownInterval = null;

// Format remaining time as XXh:YYm:ZZs
function formatRemainingTime(ms) {
    if (ms <= 0) return '00h:00m:00s';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}h:${String(minutes).padStart(2, '0')}m:${String(seconds).padStart(2, '0')}s`;
}

// Initialize expiry countdown timer in the proposal details panel
function initializeExpiryCountdown() {
    // Clear any existing interval
    if (expiryCountdownInterval) {
        clearInterval(expiryCountdownInterval);
        expiryCountdownInterval = null;
    }

    const countdownEl = document.querySelector('.proposal-expiry-countdown[data-expires-at]');
    if (!countdownEl) return;

    const expiresAtStr = countdownEl.getAttribute('data-expires-at');
    const proposalId = countdownEl.getAttribute('data-proposal-id');
    if (!expiresAtStr) return;

    // If proposal is executed, do not start countdown
    if (proposalId && typeof proposalStorage !== 'undefined') {
        const p = proposalStorage.getProposal(proposalId);
        const status = (p && p.status ? p.status : '').toLowerCase();
        if (status === 'executed') {
            return;
        }
    }

    const expiresAt = new Date(expiresAtStr).getTime();
    const timerEl = countdownEl.querySelector('.expiry-timer');
    const labelEl = countdownEl.querySelector('.expiry-label');

    function updateCountdown() {
        const now = Date.now();
        const remaining = expiresAt - now;

        if (remaining <= 0) {
            // Proposal has expired
            if (expiryCountdownInterval) {
                clearInterval(expiryCountdownInterval);
                expiryCountdownInterval = null;
            }

            // Update the countdown display to show expired
            countdownEl.classList.add('expired');
            countdownEl.style.background = '#f8d7da';
            countdownEl.style.borderColor = '#f5c6cb';
            if (labelEl) {
                labelEl.textContent = 'Proposal Expired';
                labelEl.style.color = '#721c24';
            }
            if (timerEl) {
                timerEl.style.display = 'none';
            }
            const iconEl = countdownEl.querySelector('i');
            if (iconEl) {
                iconEl.className = 'fas fa-clock';
                iconEl.style.color = '#721c24';
            }

            // Update proposal status in storage
            if (proposalId && typeof proposalStorage !== 'undefined') {
                const proposal = proposalStorage.getProposal(proposalId);
                if (proposal) {
                    checkAndUpdateProposalExpiry(proposal);
                    // Refresh the UI
                    updateProposalList();
                    // Re-render the proposal info to update buttons
                    showProposalInfo(proposal);
                }
            }
        } else {
            // Update the timer display
            if (timerEl) {
                timerEl.textContent = formatRemainingTime(remaining);
            }

            // Change color to red when less than 1 minute remaining
            if (remaining < 60000) {
                countdownEl.style.background = '#f8d7da';
                countdownEl.style.borderColor = '#f5c6cb';
                if (labelEl) labelEl.style.color = '#721c24';
                if (timerEl) timerEl.style.color = '#721c24';
                const iconEl = countdownEl.querySelector('i');
                if (iconEl) iconEl.style.color = '#721c24';
            }
        }
    }

    // Run immediately and then every second
    updateCountdown();
    expiryCountdownInterval = setInterval(updateCountdown, 1000);
}

// Interval for decay countdown
let decayCountdownInterval = null;

// Initialize decay countdown animation for the offer bar
function initializeDecayCountdown() {
    // Clear any existing interval
    if (decayCountdownInterval) {
        clearInterval(decayCountdownInterval);
        decayCountdownInterval = null;
    }

    const offerBar = document.querySelector('.proposal-offer-bar.with-decay[data-proposal-id]');
    if (!offerBar) return;

    const proposalId = offerBar.getAttribute('data-proposal-id');
    const originalOffer = parseFloat(offerBar.getAttribute('data-original-offer'));
    const decayPercent = parseFloat(offerBar.getAttribute('data-decay-percent'));
    const decayDurationMs = parseFloat(offerBar.getAttribute('data-decay-duration'));
    const createdAtStr = offerBar.getAttribute('data-created-at');

    if (!originalOffer || !decayPercent || !decayDurationMs || !createdAtStr) return;

    const createdAt = new Date(createdAtStr).getTime();
    const proposal = proposalId && typeof proposalStorage !== 'undefined'
        ? proposalStorage.getProposal(proposalId)
        : { offer: originalOffer, decayEnabled: true, decayPercent, decayDurationMs, createdAt: createdAtStr, offerCurrency: 'USDT' };

    const remainingBar = offerBar.querySelector('.offer-bar-remaining');
    const decayedBar = offerBar.querySelector('.offer-bar-decayed');
    const amountEl = offerBar.querySelector('.offer-amount');
    const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
    const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';

    function updateDecay() {
        const now = Date.now();
        const elapsed = now - createdAt;

        let progress = 0;
        if (elapsed >= decayDurationMs) {
            progress = 1;
        } else if (elapsed > 0) {
            progress = elapsed / decayDurationMs;
        }

        const decayedPercent = decayPercent * progress;
        const remainingPercent = 100 - decayedPercent;
        const currentOffer = originalOffer - (originalOffer * decayedPercent / 100);

        if (remainingBar) remainingBar.style.width = remainingPercent + '%';
        if (decayedBar) decayedBar.style.width = decayedPercent + '%';
        if (amountEl) amountEl.textContent = currencySymbol + Math.round(currentOffer).toLocaleString('hr-HR') + currencySuffix;

        // Stop interval once fully decayed
        if (progress >= 1 && decayCountdownInterval) {
            clearInterval(decayCountdownInterval);
            decayCountdownInterval = null;
        }
    }

    // Run immediately and then every second
    updateDecay();
    decayCountdownInterval = setInterval(updateDecay, 1000);
}

// Utilities for random names
function _randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function generateStructureName(kind) {
    const adj = ['Green', 'Sunny', 'Central', 'Liberty', 'Unity', 'Riverside', 'Grand', 'Heritage', 'Harmony', 'Oak'];
    const nounPark = ['Park', 'Garden', 'Commons', 'Meadow', 'Grove'];
    const nounSquare = ['Square', 'Plaza', 'Forum', 'Court', 'Terrace'];
    const nounLake = ['Lake', 'Lagoon', 'Harbor', 'Bay', 'Pond'];
    const noun = kind === 'square' ? nounSquare : (kind === 'lake' ? nounLake : nounPark);
    return `${_randomFrom(adj)} ${_randomFrom(noun)}`;
}

// Show proposal dialog for structures (Park/Square) with provided parcelIds and geometry
function showStructureProposalDialog({ kind, parcelIds, geometry, blockName }) {
    const t = getProposalI18nHelper();
    const parcelLookupError = t('modal.createProposal.errors.couldNotDetermineParcels', 'Could not determine parcels for this block.');
    const parcelsNotContiguous = t('modal.createProposal.errors.parcelsNotContiguous', 'Parcels not contiguous');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const validKind = (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square';
    const selectedParcels = (parcelIds || []).map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
    if (selectedParcels.length === 0) {
        updateStatus(parcelLookupError);
        return;
    }

    if (validKind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selectedParcels) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', parcelsNotContiguous);
            } else {
                updateStatus(parcelsNotContiguous);
            }
            return;
        }
    }

    const totalArea = selectedParcels.reduce((sum, layer) => sum + (layer?.feature?.properties?.calculatedArea || 0), 0);
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const parcelListHTML = selectedParcels.map(parcel => {
        const number = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, unknownParcelLabel) || unknownParcelLabel;
        const area = Math.round(parcel.feature?.properties?.calculatedArea || 0).toLocaleString('hr-HR');
        return `<div class="proposal-parcel-item"><span class="parcel-number">${parcelLabel} ${number}</span> <span class="parcel-area">(${area} m²)</span></div>`;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    const modalTitle = validKind === 'park'
        ? t('modal.createProposal.titlePark', 'Create Park Proposal')
        : validKind === 'square'
            ? t('modal.createProposal.titleSquare', 'Create Square Proposal')
            : t('modal.createProposal.titleLake', 'Create Lake Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const typeLabel = t('modal.createProposal.typeLabel', 'Type:');
    const typeDisplay = validKind === 'park'
        ? t('modal.createProposal.typePark', 'Park')
        : validKind === 'square'
            ? t('modal.createProposal.typeSquare', 'Square')
            : t('modal.createProposal.typeLake', 'Lake');
    const namePlaceholder = t('modal.createProposal.namePlaceholder', 'Name your {{kind}}', { kind: typeDisplay.toLowerCase() });
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholderStructure', 'Describe your {{kind}}...', { kind: typeDisplay.toLowerCase() });
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    const defaultName = generateStructureName(validKind);
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <div class="proposal-author-row">
                        <label for="proposalAuthor">${authorLabel}</label>
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                        <input type="text" id="proposalAuthor" placeholder="${authorPlaceholder}" disabled>
                    </div>
                </div>
                <div class="form-group">
                    <label for="proposalName">${nameLabel}</label>
                    <input type="text" id="proposalName" value="${defaultName}" placeholder="${namePlaceholder}">
                </div>
                <div class="form-group">
                    <label for="proposalType">${typeLabel}</label>
                    <input type="text" id="proposalType" value="${typeDisplay}" disabled>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <textarea id="proposalDescription" class="proposal-description-input" rows="2" placeholder="${descriptionPlaceholder}"></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>${optionsLabel}</label>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary">
                    <div class="summary-stats">
                        <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                        <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                    </div>
                    <div class="parcel-list">
                        <h4>${summarySelectedLabel}</h4>
                        ${parcelListHTML}
                    </div>
                </div>
                <div class="proposal-actions-block">
                    <div class="lens-inline-control lens-footer-control lens-footer-row">
                        <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                    </div>
                    <button type="button" class="btn btn-proposal" id="create-structure-proposal-btn">${submitLabel}</button>
                </div>
            </div>
        </div>`;

    document.body.appendChild(modal);
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }

    // Prefill author and random offer
    populateProposalAuthorUI();

    // Pre-fill description with default text
    const proposalTypeName = typeDisplay;
    updateProposalDescription(proposalTypeName);
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1000, maxOfferEur = 100000;
        offerInput.value = window.formatProposalOfferValue(Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur);
    }
    attachProposalCurrencyHandlers();
    document.getElementById('proposalName').focus();

    const confirmButton = document.getElementById('create-structure-proposal-btn');
    if (confirmButton) {
        confirmButton.addEventListener('click', () => {
            createStructureProposalFromDialog(
                validKind,
                Array.isArray(parcelIds) ? parcelIds : [],
                geometry || null,
                blockName || ''
            );
        });
    }
}

const LAKE_GRAPHICS_VERSION = 3;
const LAKE_SHORE_TARGET_RATIO = 0.2;

function computeLakeZonesForGeometry(baseFeature, options = {}) {
    const targetRatio = typeof options.targetShoreRatio === 'number'
        ? Math.max(0.05, Math.min(0.45, options.targetShoreRatio))
        : LAKE_SHORE_TARGET_RATIO;
    const baseArea = Math.max(0, turf.area(baseFeature) || 0);
    if (!baseArea) return null;

    let bbox = null;
    try { bbox = turf.bbox(baseFeature); } catch (_) { bbox = null; }
    const [minLng, minLat, maxLng, maxLat] = Array.isArray(bbox) && bbox.length === 4 ? bbox : [0, 0, 0, 0];
    let widthMeters = 0;
    let heightMeters = 0;
    try { widthMeters = turf.distance([minLng, minLat], [maxLng, minLat], { units: 'meters' }); } catch (_) { widthMeters = 0; }
    try { heightMeters = turf.distance([minLng, minLat], [minLng, maxLat], { units: 'meters' }); } catch (_) { heightMeters = 0; }
    const minDim = Math.max(1, Math.min(Math.max(widthMeters, 0), Math.max(heightMeters, 0)));
    const minWidth = 0.5;
    const maxWidth = Math.max(minWidth, minDim * 0.45);
    const areaGuess = Math.sqrt(baseArea / Math.PI) * 0.105;
    const widthHint = Math.max(minWidth, Math.min(maxWidth, typeof options.widthHintMeters === 'number' ? options.widthHintMeters : areaGuess));
    let low = minWidth;
    let high = maxWidth;
    let best = null;
    let bestBelow = null;

    for (let i = 0; i < 7; i++) {
        const width = (i === 0) ? widthHint : (low + high) / 2;
        let water = null;
        try { water = turf.buffer(baseFeature, -width, { units: 'meters', steps: 32 }); } catch (_) { water = null; }
        if (!water || !water.geometry || !water.geometry.coordinates || !water.geometry.coordinates.length) {
            high = Math.max(minWidth, width * 0.8);
            continue;
        }
        const waterArea = Math.max(0, turf.area(water) || 0);
        if (!waterArea) {
            high = Math.max(minWidth, width * 0.8);
            continue;
        }
        let shore = null;
        try { shore = turf.difference(baseFeature, water); } catch (_) { shore = null; }
        if (!shore) shore = baseFeature;
        const ratio = Math.max(0, Math.min(1, (baseArea - waterArea) / baseArea));
        const delta = Math.abs(ratio - targetRatio);
        const current = { water, shore, width, ratio, delta };
        if (ratio <= targetRatio && (!bestBelow || ratio > bestBelow.ratio)) bestBelow = current;
        if (!best || delta < best.delta) best = current;
        if (ratio > targetRatio) {
            high = width;
        } else {
            low = width;
        }
    }

    const chosen = bestBelow || best;
    if (!chosen) return null;

    let transition = null;
    try {
        const outerWidth = Math.max(minWidth, chosen.width * 0.55);
        const outer = turf.buffer(baseFeature, -outerWidth, { units: 'meters', steps: 32 });
        if (outer && outer.geometry && chosen.water && chosen.water.geometry) {
            try { transition = turf.difference(outer, chosen.water); } catch (_) { transition = null; }
        }
    } catch (_) { transition = null; }

    return {
        water: chosen.water,
        shore: chosen.shore,
        transition,
        width: chosen.width,
        ratio: chosen.ratio
    };
}

function buildLakeGraphicsFromGeometry(geometry, options = {}) {
    if (!geometry || !geometry.type || !geometry.coordinates || typeof turf === 'undefined') return null;
    const polygons = [];
    try {
        if (geometry.type === 'Polygon') {
            polygons.push(turf.polygon(geometry.coordinates));
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(rings => polygons.push(turf.polygon(rings)));
        }
    } catch (_) { }
    if (!polygons.length) return null;

    let merged = polygons[0];
    for (let i = 1; i < polygons.length; i++) {
        try {
            const next = turf.union(merged, polygons[i]);
            if (next && next.geometry) merged = next;
        } catch (_) { /* keep best-so-far */ }
    }
    const base = merged && merged.geometry ? merged : polygons[0];

    const zones = computeLakeZonesForGeometry(base, {
        targetShoreRatio: LAKE_SHORE_TARGET_RATIO,
        widthHintMeters: typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : null
    }) || null;
    const shore = zones && zones.shore ? zones.shore : base;
    const water = zones && zones.water ? zones.water : null;
    const transition = zones && zones.transition ? zones.transition : null;
    const shoreWidth = zones && zones.width ? zones.width : (typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : 6);

    const fish = [];
    const fishArea = water && water.geometry ? water : base;
    try {
        const bbox = turf.bbox(fishArea);
        const desired = Math.max(2, Math.min(8, Math.round((turf.area(fishArea) || 0) / 8000)));
        const candidates = turf.randomPoint(desired * 3, { bbox });
        candidates.features.forEach(pt => {
            try {
                if (turf.booleanPointInPolygon(pt, fishArea) && fish.length < desired) {
                    fish.push(pt.geometry.coordinates);
                }
            } catch (_) { /* skip invalid */ }
        });
    } catch (_) { }

    return {
        geometry: base.geometry || geometry,
        shore: shore && shore.geometry ? shore.geometry : (shore.geometry ? shore.geometry : shore),
        water: water && water.geometry ? water.geometry : null,
        transition: transition && transition.geometry ? transition.geometry : null,
        fish,
        version: LAKE_GRAPHICS_VERSION,
        shoreWidthMeters: shoreWidth,
        shoreRatio: zones && typeof zones.ratio === 'number' ? zones.ratio : null
    };
}

async function createStructureProposalFromDialog(kind, parcelIds, geometry, blockName) {
    const author = getProposalAuthorValue();
    const title = (document.getElementById('proposalName')?.value || '').trim();
    const description = (document.getElementById('proposalDescription')?.value || '').trim();
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer')?.value) || 0;
    const offerCurrency = document.getElementById('proposalCurrency')?.value || 'USDT';
    if (!author || !title || offer <= 0) {
        showProposalAlertMessage('please_provide_author_name_and_a_valid_offer', 'Please provide author, name, and a valid offer.');
        return;
    }
    if (!Array.isArray(parcelIds) || parcelIds.length === 0 || !geometry) {
        showProposalAlertMessage('missing_parcels_or_geometry_for_this_proposal', 'Missing parcels or geometry for this proposal.');
        return;
    }

    // Check for expiry option
    const expireCheckbox = document.getElementById('proposalExpireCheckbox');
    const expiryTimeInput = document.getElementById('proposalExpiryTime');
    let expiresAt = null;
    if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
        const expiryMs = parseExpiryTime(expiryTimeInput.value);
        if (expiryMs > 0) {
            expiresAt = new Date(Date.now() + expiryMs).toISOString();
        }
    }

    // Check for decay option
    const decayCheckbox = document.getElementById('proposalDecayCheckbox');
    const decayPercentInput = document.getElementById('proposalDecayPercent');
    const decayTimeInput = document.getElementById('proposalDecayTime');
    let decayEnabled = false;
    let decayPercent = 0;
    let decayDurationMs = 0;
    if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
        decayEnabled = true;
        decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
        decayDurationMs = parseExpiryTime(decayTimeInput.value);
    }

    // Check for deposit option
    const depositCheckbox = document.getElementById('proposalDepositCheckbox');
    const depositPercentInput = document.getElementById('proposalDepositPercent');
    let depositEnabled = false;
    let depositPercent = 0;
    if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
        depositEnabled = true;
        // Clamp between 10% and 200%
        depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
    }

    let lakeGraphics = null;
    let structureGeometry = geometry;
    if (kind === 'lake') {
        lakeGraphics = buildLakeGraphicsFromGeometry(geometry);
        if (!lakeGraphics || !lakeGraphics.geometry) {
            showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            return;
        }
        structureGeometry = lakeGraphics.geometry || geometry;
    }

    const parentParcelIds = normalizeParcelIdList(parcelIds || []);

    const proposal = {
        author,
        title,
        name: title,
        proposalName: title,
        description: description || title,
        offer,
        offerCurrency,
        budget: offer,
        budgetCurrency: offerCurrency,
        parentParcelIds,
        type: 'structure',
        structureProposal: {
            kind: (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square',
            status: 'unapplied',
            geometry: structureGeometry,
            parentParcelIds,
            blockName: blockName || null,
            lakeGraphics: lakeGraphics || null
        },
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt,
        decayEnabled: decayEnabled,
        decayPercent: decayPercent,
        decayDurationMs: decayDurationMs,
        depositEnabled: depositEnabled,
        depositPercent: depositPercent
    };

    const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
    if (lensSnapshot.length) {
        proposal.lens = lensSnapshot;
    }

    const proposalId = proposalStorage.addProposal(proposal);
    if (!proposalId) {
        showProposalAlertMessage('an_identical_proposal_already_exists', 'An identical proposal already exists.');
        return;
    }
    const primaryParcelId = parentParcelIds.length ? parentParcelIds[0] : null;
    // Link proposal to ancestors
    try { if (typeof ProposalManager !== 'undefined' && ProposalManager._linkProposalToAncestors) ProposalManager._linkProposalToAncestors(proposalId, parentParcelIds); } catch (_) { }

    // Close and update UI
    closeProposalDialog();
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof enableShowProposalsMode === 'function') enableShowProposalsMode(); } catch (_) { }

    let applied = false;
    if (typeof applyProposalToMap === 'function') {
        applied = (await applyProposalToMap(proposalId, { parcelId: primaryParcelId, centerOnProposal: true })) !== false;
    } else if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            applied = (await ProposalManager.applyProposal(proposalId)) !== false;
        } catch (_) {
            applied = false;
        }
    }

    if (!applied && typeof focusProposalDetails === 'function') {
        focusProposalDetails(proposalId, { parcelId: primaryParcelId, centerOnProposal: true });
    }
}

// Expose helpers
window.showStructureProposalDialog = showStructureProposalDialog;
window.handleProposalToolButton = handleProposalToolButton;
window.setProposalType = setProposalType;
window.setProposalMainType = setProposalMainType;
window.setProposalAcquisitionMode = setProposalAcquisitionMode;
window.setProposalBoundaryMode = setProposalBoundaryMode;
window.handleUrbanRuleMainTypeClick = handleUrbanRuleMainTypeClick;
window.handleUrbanRuleTypologyClick = handleUrbanRuleTypologyClick;
window.handleReparcellizationAlgorithmClick = handleReparcellizationAlgorithmClick;
window.applyContiguityConstraints = applyContiguityConstraints;
window.populateProposalAuthorUI = populateProposalAuthorUI;
window.getProposalAuthorValue = getProposalAuthorValue;
window.getSelectedProposalTool = getSelectedProposalTool;
window.buildGeometryFromParcels = buildGeometryFromParcels;
window.getCurrentParcelSelectionContext = getCurrentParcelSelectionContext;

document.addEventListener('blockifyModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('blockifyModalClosed', () => setProposalModalDimmed(false));
document.addEventListener('urbanRuleModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('urbanRuleModalClosed', () => setProposalModalDimmed(false));

/**
 * Find the visible descendant proposal by traversing down from a proposal
 * until we find one whose child parcels are actually visible on the map
 * (i.e., they have no further descendant proposal markers).
 * 
 * @param {string} proposalId - The starting proposal ID
 * @returns {string|null} - The proposal ID whose children are visible, or the original if none found
 */
function findVisibleDescendant(proposalId) {
    if (!proposalId) return null;
    if (typeof proposalStorage === 'undefined' || !proposalStorage) return proposalId;

    const visited = new Set();
    let currentId = proposalId;

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);

        const proposal = getProposalByIdOrHash(currentId);
        if (!proposal) {
            console.debug('[findVisibleDescendant] No proposal found for', currentId);
            break;
        }

        // Get child parcel IDs for this proposal
        const childParcelIds = [];
        const addIds = (list) => {
            (Array.isArray(list) ? list : []).forEach(id => {
                const val = id && id.toString ? id.toString() : String(id || '');
                if (val) childParcelIds.push(val);
            });
        };
        addIds(proposal.childParcelIds);
        addIds(proposal?.roadProposal?.childParcelIds);
        addIds(proposal?.reparcellization?.childParcelIds);
        addIds(proposal?.decideLaterProposal?.childParcelIds);
        addIds(proposal?.structureProposal?.childParcelIds);

        if (childParcelIds.length === 0) {
            // No children, this is a leaf - return it
            console.debug('[findVisibleDescendant] No children for', currentId, '- returning it');
            return currentId;
        }

        // Check if any child parcel has a descendantProposal marker
        let descendantProposalId = null;
        for (const childId of childParcelIds) {
            // Check in layer index first
            let layer = null;
            if (typeof resolveParcelLayerById === 'function') {
                layer = resolveParcelLayerById(childId);
            }

            const props = layer?.feature?.properties || layer?.options || null;
            if (props) {
                const marker = props.descendantProposal || props.descendantProposals;
                if (marker) {
                    // Found a descendant - continue traversing
                    descendantProposalId = Array.isArray(marker) ? marker[0] : marker;
                    console.debug('[findVisibleDescendant] Child', childId, 'has descendant marker:', descendantProposalId);
                    break;
                }
            }

            // Also check in storage
            if (!descendantProposalId && typeof readPersistedParcelRecord === 'function') {
                const record = readPersistedParcelRecord(childId);
                if (record && record.properties) {
                    const marker = record.properties.descendantProposal || record.properties.descendantProposals;
                    if (marker) {
                        descendantProposalId = Array.isArray(marker) ? marker[0] : marker;
                        console.debug('[findVisibleDescendant] Child', childId, 'has descendant marker in storage:', descendantProposalId);
                        break;
                    }
                }
            }
        }

        if (!descendantProposalId) {
            // No descendants found - this proposal's children are visible
            console.debug('[findVisibleDescendant] No descendant markers found for', currentId, '- returning it');
            return currentId;
        }

        // Continue traversing to the descendant
        currentId = descendantProposalId;
    }

    // If we exhausted the loop (cycle or end), return the last valid ID
    console.debug('[findVisibleDescendant] Exhausted traversal, returning', currentId || proposalId);
    return currentId || proposalId;
}

/**
 * Calculate and return bounds for the visible descendant of a proposal.
 * Simply uses the child parcels of the visible descendant - no recursive collection.
 * @param {string} proposalId - The proposal ID to calculate bounds for
 * @returns {L.LatLngBounds|null} Leaflet bounds or null
 */
function calculateBoundsForLastAppliedProposal(proposalId) {
    if (!proposalId) return null;
    if (typeof proposalStorage === 'undefined' || !proposalStorage) return null;

    // Find the visible descendant - this is the proposal whose children are actually on the map
    const visibleDescendantId = findVisibleDescendant(proposalId);
    const proposal = getProposalByIdOrHash(visibleDescendantId);
    if (!proposal) return null;

    console.debug('[calculateBoundsForLastAppliedProposal] Using visible descendant:', visibleDescendantId);

    // Just get the child parcel IDs of this proposal directly
    let parcelIdsForBounds = [];
    const addAll = (list) => {
        (Array.isArray(list) ? list : []).forEach(id => {
            const val = id && id.toString ? id.toString() : String(id || '');
            if (val) parcelIdsForBounds.push(val);
        });
    };

    addAll(proposal.childParcelIds);
    addAll(proposal?.roadProposal?.childParcelIds);
    addAll(proposal?.reparcellization?.childParcelIds);
    addAll(proposal?.decideLaterProposal?.childParcelIds);
    addAll(proposal?.structureProposal?.childParcelIds);

    console.debug('[calculateBoundsForLastAppliedProposal] Child parcels:', parcelIdsForBounds.length);

    // If no children, fall back to parents
    if (!parcelIdsForBounds.length) {
        parcelIdsForBounds = ensureArrayOfStrings(proposal.parentParcelIds || []);
    }

    // First try parcel-based bounds (descendants preferred). Do not fall back to parents if descendants exist.
    if (parcelIdsForBounds.length > 0) {
        const bounds = calculateProposalBounds(parcelIdsForBounds, { proposal });
        if (bounds) {
            try {
                if (typeof L !== 'undefined' && L && typeof L.latLngBounds === 'function') {
                    return L.latLngBounds(
                        [bounds.south, bounds.west],
                        [bounds.north, bounds.east]
                    );
                }
            } catch (_) { /* ignore */ }
            return null;
        }
    }

    // If no parcels or they are unavailable, fall back to proposal geometries
    const geometryBounds = calculateProposalGeometryBounds(proposal);
    if (geometryBounds) return geometryBounds;

    return null;
}

function calculateProposalGeometryBounds(proposal) {
    if (!proposal) return null;

    const geometries = [];
    const addGeom = (geom) => {
        if (geom && geom.type && Array.isArray(geom.coordinates)) {
            geometries.push({ type: 'Feature', geometry: geom, properties: {} });
        }
    };
    const addFeatureGeom = (feature) => {
        if (feature && feature.geometry) addGeom(feature.geometry);
    };

    try {
        if (proposal.geometry) {
            addGeom(proposal.geometry.roadGeometry || proposal.geometry.roadPlan || proposal.geometry.structureGeometry || proposal.geometry.structure || proposal.geometry.parcelGeometry || proposal.geometry.parcel);
            if (Array.isArray(proposal.geometry.buildings)) {
                proposal.geometry.buildings.forEach(addFeatureGeom);
            }
        }
        if (proposal.roadProposal && proposal.roadProposal.geometry) {
            addGeom(proposal.roadProposal.geometry);
        }
        if (proposal.structureProposal && proposal.structureProposal.geometry) {
            addGeom(proposal.structureProposal.geometry);
        }
        if (proposal.decideLaterProposal && proposal.decideLaterProposal.geometry) {
            addGeom(proposal.decideLaterProposal.geometry);
        }
    } catch (_) { /* best-effort */ }

    if (!geometries.length) return null;

    try {
        if (typeof L !== 'undefined' && L && typeof L.geoJSON === 'function') {
            const bounds = L.geoJSON({ type: 'FeatureCollection', features: geometries }).getBounds();
            if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
                return bounds;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

function calculateProposalBounds(parcelIds, options = {}) {
    if (!parcelIds || parcelIds.length === 0) return null;

    const proposal = options.proposal || null;
    const cache = proposal ? buildProposalFeatureCache(proposal) : null;

    const positions = [];
    const missingParcels = [];

    parcelIds.forEach(rawParcelId => {
        const parcelId = rawParcelId && rawParcelId.toString ? rawParcelId.toString() : (rawParcelId ? String(rawParcelId) : null);
        if (!parcelId) {
            return;
        }

        let center = null;

        if (cache && cache.parcelsById && cache.parcelsById.has(parcelId)) {
            const cachedFeature = cache.parcelsById.get(parcelId);
            if (cachedFeature && cachedFeature.geometry) {
                try {
                    const boundsFromFeature = L.geoJSON(cachedFeature).getBounds();
                    if (boundsFromFeature && typeof boundsFromFeature.getCenter === 'function' && boundsFromFeature.isValid && boundsFromFeature.isValid()) {
                        center = boundsFromFeature.getCenter();
                    }
                } catch (e) {
                    console.warn(`calculateProposalBounds: failed to compute bounds from cached feature for ${parcelId}`, e);
                }
            }
        }

        if (!center && typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
            const parcelLayer = multiParcelSelection.findParcelById(parcelId);
            if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
                try {
                    const bounds = parcelLayer.getBounds();
                    if (bounds && typeof bounds.getCenter === 'function') {
                        const candidateCenter = bounds.getCenter();
                        if (candidateCenter && !isNaN(candidateCenter.lat) && !isNaN(candidateCenter.lng)) {
                            center = candidateCenter;
                        }
                    }
                } catch (e) {
                    console.warn(`Error getting bounds for parcel ${parcelId}:`, e);
                }
            }
        }

        if (center) {
            positions.push(center);
        } else {
            missingParcels.push(parcelId);
        }
    });

    if (positions.length === 0) {
        console.warn('Cannot calculate bounds - no valid parcel positions found');
        return null;
    }

    // Calculate bounding box
    let north = positions[0].lat;
    let south = positions[0].lat;
    let east = positions[0].lng;
    let west = positions[0].lng;

    positions.forEach(pos => {
        north = Math.max(north, pos.lat);
        south = Math.min(south, pos.lat);
        east = Math.max(east, pos.lng);
        west = Math.min(west, pos.lng);
    });

    // Calculate center
    const centerLat = (north + south) / 2;
    const centerLng = (east + west) / 2;

    const bounds = {
        center: { lat: centerLat, lng: centerLng },
        north: north,
        south: south,
        east: east,
        west: west,
        calculatedAt: new Date().toISOString(),
        parcelCount: positions.length,
        totalParcels: parcelIds.length
    };

    if (missingParcels.length > 0) {
        bounds.missingParcels = missingParcels;
        console.warn(`Bounds calculated from ${positions.length}/${parcelIds.length} parcels. Missing: ${missingParcels.join(', ')}`);
    }

    return bounds;
}

// Check if parcels have NFTs on-chain
async function checkParcelsHaveNFTs(parcelIds, chainId) {
    if (!parcelIds || parcelIds.length === 0) {
        return { allHaveNFTs: true, missingParcels: [], chainId: null, chainName: null };
    }

    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.ethers) {
        // If blockchain library is not available, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId: null, chainName: null };
    }

    // Normalize chainId to string
    let normalizedChainId = chainId;
    if (typeof chainId === 'bigint') {
        normalizedChainId = chainId.toString();
    } else if (typeof chainId === 'number') {
        normalizedChainId = String(Math.trunc(chainId));
    } else if (typeof chainId === 'string' && chainId.startsWith('0x')) {
        try {
            normalizedChainId = BigInt(chainId).toString();
        } catch (_) { }
    }

    try {
        // Resolve ParcelNFT contract address - check addresses.json first
        let contractAddress = null;

        // 1) Try addresses.json directly
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                if (data && data[normalizedChainId] && data[normalizedChainId].ParcelNFT) {
                    contractAddress = data[normalizedChainId].ParcelNFT;
                }
            }
        } catch (err) {
            console.warn('Failed to load ParcelNFT from addresses.json:', err);
        }

        // 2) Try ContractsLoader
        if (!contractAddress && globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                contractAddress = await globalScope.ContractsLoader.getContractAddress(normalizedChainId, 'ParcelNFT');
            } catch (error) {
                console.warn('Failed to load ParcelNFT address from ContractsLoader:', error);
            }
        }

        // 3) Try global resolveParcelNftAddress
        if (!contractAddress && typeof globalScope.resolveParcelNftAddress === 'function') {
            contractAddress = await globalScope.resolveParcelNftAddress(normalizedChainId);
        }

        if (!contractAddress) {
            // Can't check, assume they don't have NFTs
            console.warn('[checkParcelsHaveNFTs] No ParcelNFT contract address found for chain', normalizedChainId);
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
        }

        console.debug('[checkParcelsHaveNFTs] Using ParcelNFT contract:', contractAddress, 'on chain', normalizedChainId);

        // Get provider
        let provider = null;
        const walletManager = globalScope.walletManager;
        const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;

        if (walletProvider) {
            try {
                provider = new globalScope.ethers.BrowserProvider(walletProvider);
            } catch (error) {
                console.warn('Failed to create browser provider:', error);
            }
        }

        // Fallback to RPC provider
        // Only use RPC provider if wallet is connected, or if it's a non-local RPC URL
        // For local RPC URLs without a wallet, skip to avoid pinging unavailable local nodes
        if (!provider) {
            const rpcUrl = typeof globalScope.resolveRpcUrlForChain === 'function' ? globalScope.resolveRpcUrlForChain(normalizedChainId) : null;
            if (rpcUrl) {
                // Check if it's a local RPC URL
                const isLocal = rpcUrl && (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1'));

                // For local RPC URLs without a wallet, only create provider if isLocalNodeAvailable confirms it's available
                // This prevents JsonRpcProvider from retrying every second when the local node is not running
                if (isLocal) {
                    // Check if local node is available before creating provider
                    if (globalScope.isLocalNodeAvailable && typeof globalScope.isLocalNodeAvailable === 'function') {
                        const localNodeAvailable = await globalScope.isLocalNodeAvailable();
                        if (!localNodeAvailable) {
                            console.warn('Local node not available and no wallet connected, skipping RPC provider creation');
                            // Don't create provider for local RPC when node is unavailable
                        } else {
                            // Local node is available, safe to create provider
                            try {
                                const numericChainId = Number(normalizedChainId);
                                provider = Number.isFinite(numericChainId)
                                    ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                                    : new globalScope.ethers.JsonRpcProvider(rpcUrl);
                            } catch (error) {
                                console.warn('Failed to create RPC provider:', error);
                            }
                        }
                    } else {
                        // No isLocalNodeAvailable function - skip local RPC to avoid retries when no wallet
                        console.warn('No wallet connected and local RPC URL detected, skipping RPC provider creation to avoid connection retries');
                    }
                } else {
                    // Non-local RPC URL - safe to use even without wallet (read-only operations)
                    try {
                        const numericChainId = Number(normalizedChainId);
                        provider = Number.isFinite(numericChainId)
                            ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                            : new globalScope.ethers.JsonRpcProvider(rpcUrl);
                    } catch (error) {
                        console.warn('Failed to create RPC provider:', error);
                    }
                }
            }
        }

        if (!provider) {
            console.warn('[checkParcelsHaveNFTs] No provider available for chain', normalizedChainId);
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
        }

        // Create contract instance
        const PARCEL_NFT_ABI = [
            'function tokenIdForParcelId(string parcelId) public view returns (uint256)'
        ];
        const contract = new globalScope.ethers.Contract(contractAddress, PARCEL_NFT_ABI, provider);

        // Check each parcel
        const missingParcels = [];
        const checkPromises = parcelIds.map(async (parcelId) => {
            try {
                const tokenId = await contract.tokenIdForParcelId(parcelId);
                // If we get a result, the parcel has an NFT
                if (tokenId !== null && tokenId !== undefined) {
                    return { parcelId, hasNFT: true };
                }
                return { parcelId, hasNFT: false };
            } catch (error) {
                // Check if it's a "parcel does not exist" error (expected for unminted parcels)
                if (typeof globalScope.isParcelTokenMissingError === 'function' && globalScope.isParcelTokenMissingError(error)) {
                    return { parcelId, hasNFT: false };
                }

                // Handle RPC errors - MetaMask wraps revert errors in RPC error format
                const errorCode = error?.code || error?.data?.code;
                let errorMessage = error?.message || error?.data?.message || String(error);

                // For RPC errors (code -32603), check the data field for the actual revert reason
                if (errorCode === -32603 && error?.data) {
                    // MetaMask wraps contract reverts in RPC errors
                    // Check if the data contains the actual revert message
                    const dataMessage = error.data?.message || error.data?.originalError?.message ||
                        error.data?.data?.message || error.data?.originalError?.data?.message;
                    if (dataMessage) {
                        errorMessage = dataMessage;
                    }

                    // Check if the wrapped error indicates parcel doesn't exist
                    const dataMessageLower = String(dataMessage || '').toLowerCase();
                    if (dataMessageLower.includes('parcel does not exist')) {
                        return { parcelId, hasNFT: false };
                    }
                }

                // Check if error message indicates parcel doesn't exist
                const errorStr = String(errorMessage).toLowerCase();
                if (errorStr.includes('parcel does not exist') ||
                    errorStr.includes('nonexistent token') ||
                    (errorStr.includes('revert') && !errorStr.includes('internal json-rpc'))) {
                    return { parcelId, hasNFT: false };
                }

                // For RPC errors that don't indicate a missing parcel, log and assume no NFT
                // This is safer than assuming it does have one
                if (errorCode === -32603 || errorCode === -32602 || errorCode === -32000) {
                    console.warn(`RPC error checking parcel ${parcelId} (assuming not minted):`, {
                        code: errorCode,
                        message: errorMessage,
                        data: error?.data
                    });
                    return { parcelId, hasNFT: false, error: 'RPC_ERROR' };
                }

                // For other errors, log and assume no NFT (safer default)
                console.warn(`Unexpected error checking parcel ${parcelId}:`, {
                    code: errorCode,
                    message: errorMessage,
                    error
                });
                return { parcelId, hasNFT: false, error: 'UNKNOWN_ERROR' };
            }
        });

        const results = await Promise.all(checkPromises);
        results.forEach(result => {
            if (!result.hasNFT) {
                missingParcels.push(result.parcelId);
            }
        });

        const chainName = typeof globalScope.resolveChainSlug === 'function' ? globalScope.resolveChainSlug(normalizedChainId) : normalizedChainId;

        console.debug('[checkParcelsHaveNFTs] Result:', { allHaveNFTs: missingParcels.length === 0, missingCount: missingParcels.length, total: parcelIds.length });

        return {
            allHaveNFTs: missingParcels.length === 0,
            missingParcels,
            chainId: normalizedChainId,
            chainName: chainName || normalizedChainId
        };
    } catch (error) {
        console.error('Error checking parcel NFTs:', error);
        // On error, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
    }
}

// Show modal for wallet not connected
async function showWalletNotConnectedModal() {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);
        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        // Ensure this modal sits above the create proposal modal
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '30000';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';
        dialog.style.zIndex = '30001';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const introMessage = t(
            'modal.createProposal.walletNotConnected.message',
            'You are not connected with a wallet, so you can\'t mint proposals on chain.'
        );
        const proceedPrompt = t(
            'modal.createProposal.walletNotConnected.proceedQuestion',
            'Proceed to create an in-memory proposal?'
        );

        message.innerHTML = `
            <p style="margin-bottom: 12px;">${introMessage}</p>
            <p style="margin-top: 12px;">${proceedPrompt}</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('modal.createProposal.walletNotConnected.cancel', 'Cancel');

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'btn btn-action';
        createBtn.textContent = t('modal.createProposal.walletNotConnected.confirm', 'Create');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        createBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup(false);
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(createBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// Show modal for missing parcel NFTs
async function showMissingParcelsModal(missingParcels, chainName) {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        // Must sit above create-proposal-modal (z-index 11000)
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '50000';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';
        dialog.style.position = 'relative';
        dialog.style.zIndex = '50001';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const chainDisplay = chainName || t('modal.createProposal.missingParcels.defaultChain', 'the blockchain');
        const overflowLabel = missingParcels.length > 10
            ? t('modal.createProposal.missingParcels.more', ', and {{count}} more...', {
                count: missingParcels.length - 10
            })
            : '';
        const parcelList = missingParcels.length > 10
            ? `${missingParcels.slice(0, 10).join(', ')}${overflowLabel}`
            : missingParcels.join(', ');
        const messageKey = missingParcels.length === 1 ? 'messageSingle' : 'messagePlural';
        const introMessage = t(
            `modal.createProposal.missingParcels.${messageKey}`,
            missingParcels.length === 1
                ? 'The following parcel is not represented as an NFT on <strong>{{chain}}</strong>, so a proposal for it cannot be minted on-chain:'
                : 'The following parcels are not represented as NFTs on <strong>{{chain}}</strong>, so a proposal for them cannot be minted on-chain:',
            { chain: chainDisplay }
        );
        const proceedPrompt = t(
            'modal.createProposal.missingParcels.proceedQuestion',
            'Proceed to create an in-memory proposal?'
        );
        const explainerText = t(
            'modal.createProposal.missingParcels.explainer',
            'You can mint parcels yourself. To do it, click on a parcel, go to the Tools tab and click the mint button.'
        );

        message.innerHTML = `
            <p style="margin-bottom: 12px;">${introMessage}</p>
            <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px;">
                ${parcelList}
            </div>
            <p style="margin-top: 12px; margin-bottom: 12px; padding: 12px; background: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px; color: #1565c0;">
                ${explainerText}
            </p>
            <p style="margin-top: 12px;">${proceedPrompt}</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const createInMemoryBtn = document.createElement('button');
        createInMemoryBtn.type = 'button';
        createInMemoryBtn.className = 'btn btn-secondary';
        createInMemoryBtn.textContent = t('modal.createProposal.missingParcels.createInMemory', 'Create in memory');

        const mintPrereqBtn = document.createElement('button');
        mintPrereqBtn.type = 'button';
        mintPrereqBtn.className = 'btn btn-action';
        mintPrereqBtn.textContent = t('modal.createProposal.missingParcels.mintPrerequisites', 'Mint the prerequisites');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        createInMemoryBtn.addEventListener('click', () => cleanup('memory'));
        mintPrereqBtn.addEventListener('click', () => cleanup('mint'));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup('cancel');
            }
        });

        buttons.appendChild(createInMemoryBtn);
        buttons.appendChild(mintPrereqBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// Show modal when on-chain minting fails and ask whether to proceed in-memory
async function showOnchainMintFailedModal(reason) {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '50010';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '620px';
        dialog.style.position = 'relative';
        dialog.style.zIndex = '50011';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '16px';
        message.textContent = t('modal.createProposal.onchainMintFailed.message', 'On-chain mint failed for reason:');

        const reasonBox = document.createElement('div');
        reasonBox.style.background = '#fff7ed';
        reasonBox.style.border = '1px solid #fdba74';
        reasonBox.style.color = '#7c2d12';
        reasonBox.style.padding = '12px';
        reasonBox.style.borderRadius = '6px';
        reasonBox.style.fontFamily = 'monospace';
        reasonBox.style.fontSize = '12px';
        reasonBox.style.marginBottom = '18px';
        reasonBox.textContent = reason && reason.toString ? reason.toString() : t('modal.createProposal.onchainMintFailed.unknown', 'Unknown error');

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('modal.createProposal.onchainMintFailed.cancel', 'Cancel');

        const createInMemoryBtn = document.createElement('button');
        createInMemoryBtn.type = 'button';
        createInMemoryBtn.className = 'btn btn-action';
        createInMemoryBtn.textContent = t('modal.createProposal.onchainMintFailed.createInMemory', 'Create in memory');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup('cancel'));
        createInMemoryBtn.addEventListener('click', () => cleanup('memory'));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup('cancel');
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(createInMemoryBtn);
        dialog.appendChild(message);
        dialog.appendChild(reasonBox);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// Create proposal from dialog
async function createProposal() {
    console.debug('[createProposal] START - Create proposal button clicked');
    const startTime = performance.now();
    const t = getProposalI18nHelper();
    const selectedTool = getSelectedProposalTool();
    if (!selectedTool) {
        showProposalAlertMessage('select_a_proposal_goal_before_creating_a_proposal', 'Select a proposal goal before creating a proposal.');
        return;
    }
    if (goalRequiresGeometry(selectedTool) && !proposalGeometrySubmitted) {
        showProposalAlertMessage('please_add_a_geometry_first', 'Please add a geometry first.');
        updateCreateProposalSubmitState();
        return;
    }
    console.debug('[createProposal] Selected tool:', selectedTool);

    // All proposal types are handled uniformly below.
    // Building/urban-rule geometry is expected in pendingBuildingProposalContext (set by geometry tools).

    const author = getProposalAuthorValue();
    const proposalTypeInput = document.getElementById('proposalType');
    const proposalType = proposalTypeInput && proposalTypeInput.value ? proposalTypeInput.value : DEFAULT_PROPOSAL_TYPE;
    const proposalMainTypeInput = document.getElementById('proposalMainType');
    const proposalMainType = proposalMainTypeInput && proposalMainTypeInput.value ? proposalMainTypeInput.value : 'Purchase';
    const pendingReparcelPlan = (typeof window !== 'undefined') ? window.pendingReparcellizationPlan : null;
    if (proposalMainType === 'Reparcellization') {
        if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.polygons) || pendingReparcelPlan.polygons.length === 0) {
            showProposalAlertMessage('run_the_reparcellization_algorithm_and_click_done_before_creating_this_proposal', 'Run the reparcellization algorithm and click Done before creating this proposal.');
            return;
        }
    }
    const proposalName = (document.getElementById('proposalName') && document.getElementById('proposalName').value || '').trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer').value) || 0;
    const offerCurrencySelect = document.getElementById('proposalCurrency');
    const offerCurrency = offerCurrencySelect && offerCurrencySelect.value ? offerCurrencySelect.value : 'USDT';
    const acquisitionInput = document.getElementById('proposalAcquisitionMode');
    const acquisitionMode = acquisitionInput && acquisitionInput.value ? acquisitionInput.value : null;
    const boundaryInput = document.getElementById('proposalBoundaryMode');
    const boundaryMode = boundaryInput && boundaryInput.value ? boundaryInput.value : null;

    // Validation
    if (!author) {
        showProposalAlertMessage('please_enter_an_author_name', 'Please enter an author name.');
        return;
    }
    if (!description) {
        showProposalAlertMessage('please_enter_a_description', 'Please enter a description.');
        return;
    }
    if (offer <= 0) {
        showProposalAlertMessage('please_enter_a_valid_offer_amount', 'Please enter a valid offer amount.');
        return;
    }

    // Lock UI while creating
    console.debug('[createProposal] Locking UI and starting proposal creation');
    setProposalCreateButtonState(true);
    setProposalModalInteractivity(false);
    let waitingPopupVisible = false;
    const hideWaitingPopupSafe = () => {
        if (waitingPopupVisible) {
            hideProposalWaitingPopup();
            waitingPopupVisible = false;
        }
        setProposalModalDimmed(false);
    };

    try {
        // Get the parcelIds that were determined in showProposalDialog
        console.debug('[createProposal] Collecting parcel IDs');
        let finalParcelIds = [];

        const createdFromMultiSelect = multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 1;

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        console.debug('[createProposal] Final parcel IDs:', finalParcelIds.length, 'parcels');
        if (finalParcelIds.length === 0) {
            showProposalAlertMessage('no_parcels_selected_please_select_parcels_before_creating_a_proposal', 'No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // Check if parcels have NFTs on-chain before proceeding
        console.debug('[createProposal] Checking blockchain support and wallet connection');
        const blockchainSupported = typeof window.ProposalChainBridge !== 'undefined'
            && window.ProposalChainBridge.isSupported();

        // First check if wallet is connected - skip all NFT checking if not connected
        let walletManager = window.walletManager;
        let isWalletConnected = false;
        if (walletManager && typeof walletManager.getState === 'function') {
            const walletState = walletManager.getState();
            isWalletConnected = walletState && walletState.status === 'connected'
                && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
        }

        console.debug('[createProposal] Blockchain supported:', blockchainSupported, 'Wallet connected:', isWalletConnected);
        let shouldMintOnchain = blockchainSupported && finalParcelIds.length > 0 && isWalletConnected;

        // Use the parent parcel IDs directly - these are what the proposal references
        const parcelIds = finalParcelIds.map(id => (id && id.toString ? id.toString() : String(id))).filter(Boolean);

        // Build a feature map for parcels (used when minting prerequisites to get parcel names)
        const parcelFeatureById = new Map();
        for (const parcelId of parcelIds) {
            let parcelLayer = null;
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                parcelLayer = multiParcelSelection.findParcelById(parcelId);
            }
            if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                parcelLayer = resolveParcelLayerById(parcelId);
            }
            if (parcelLayer && parcelLayer.feature) {
                parcelFeatureById.set(parcelId, parcelLayer.feature);
            }
        }

        if (shouldMintOnchain) {
            // Get chain ID from wallet or use default
            let chainId = null;
            if (walletManager && typeof walletManager.getState === 'function') {
                const walletState = walletManager.getState();
                chainId = walletState?.chainId || null;
            }

            // If no chain ID from wallet, try to get from default
            if (!chainId) {
                const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                    chainId = globalScope.DEFAULT_CHAIN_ID;
                } else {
                    const env = globalScope?.current_environment || 'production';
                    chainId = env === 'development' ? '31337' : '84532';
                }
            }

            // Check if parent parcels have NFTs on-chain
            console.debug('[createProposal] Checking if parcels have NFTs on-chain, parcel count:', parcelIds.length);
            const nftCheckStartTime = performance.now();
            updateStatus('Checking if parcels have NFTs on-chain...');
            const parcelCheckResult = await checkParcelsHaveNFTs(parcelIds, chainId);
            console.debug('[createProposal] NFT check took:', (performance.now() - nftCheckStartTime).toFixed(2), 'ms');

            if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                // Some parcels don't have NFTs - show modal
                const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                const action = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay);

                if (action === 'mint') {
                    const mintableParcels = parcelCheckResult.missingParcels.map((parcelId) => {
                        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                        const feature = parcelFeatureById.get(idStr) || null;
                        const props = feature && feature.properties ? feature.properties : {};
                        const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${idStr}`;
                        return { parcelId: idStr, parcelName, feature };
                    });

                    try {
                        await openParcelMintModal({
                            parcels: mintableParcels,
                            onExit: () => {
                                updateStatus('Mint the prerequisite parcel NFTs, then click Create again.');
                            }
                        });
                        updateStatus('Mint the prerequisite parcel NFTs, then click Create again.');
                    } catch (mintModalError) {
                        console.error('Unable to open mint modal for missing parcels', mintModalError);
                        updateStatus('Unable to open mint modal. Please mint parcels before creating the proposal.');
                    }
                    return;
                }

                if (action !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    return;
                }

                // User chose to proceed with local-only proposal
                shouldMintOnchain = false;
                updateStatus('Creating in-memory proposal (not minted on-chain)...');
            } else if (parcelCheckResult.allHaveNFTs) {
                // All parcels have NFTs - proceed silently with on-chain minting
                updateStatus('All parcels have NFTs. Proceeding with on-chain proposal...');
            }
        }

        // Calculate bounds for the proposal (for reliable positioning)
        console.debug('[createProposal] Calculating proposal bounds');
        const boundsStartTime = performance.now();
        const bounds = calculateProposalBounds(finalParcelIds);
        console.debug('[createProposal] Bounds calculation took:', (performance.now() - boundsStartTime).toFixed(2), 'ms');

        // Check for expiry option
        const expireCheckbox = document.getElementById('proposalExpireCheckbox');
        const expiryTimeInput = document.getElementById('proposalExpiryTime');
        let expiresAt = null;
        if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
            const expiryMs = parseExpiryTime(expiryTimeInput.value);
            if (expiryMs > 0) {
                expiresAt = new Date(Date.now() + expiryMs).toISOString();
            }
        }

        // Check for decay option
        const decayCheckbox = document.getElementById('proposalDecayCheckbox');
        const decayPercentInput = document.getElementById('proposalDecayPercent');
        const decayTimeInput = document.getElementById('proposalDecayTime');
        let decayEnabled = false;
        let decayPercent = 0;
        let decayDurationMs = 0;
        if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
            decayEnabled = true;
            decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
            decayDurationMs = parseExpiryTime(decayTimeInput.value);
        }

        // Check for deposit option
        const depositCheckbox = document.getElementById('proposalDepositCheckbox');
        const depositPercentInput = document.getElementById('proposalDepositPercent');
        let depositEnabled = false;
        let depositPercent = 0;
        if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
            depositEnabled = true;
            // Clamp between 10% and 200%
            depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
        }

        // Check for conditional proposal option (default to false if not available)
        const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
        const isConditional = conditionalCheckbox ? conditionalCheckbox.checked : false;

        const normalizedParentParcelIds = finalParcelIds.map(id => id && id.toString ? id.toString() : String(id));

        const proposal = {
            author,
            title: proposalName || proposalType, // Keep a stable human-readable title
            name: proposalName || proposalType,
            proposalName: proposalName || proposalType,
            description: description || proposalName || proposalType,
            offer,
            offerCurrency,
            budget: offer, // Add budget field - initially same as offer
            budgetCurrency: offerCurrency,
            acquisitionMode: acquisitionMode,
            boundaryAdjustment: boundaryMode,
            parentParcelIds: normalizedParentParcelIds,
            primaryType: proposalMainType,
            goal: selectedTool,
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            ownerAcceptances: {},
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString(), // Add creation timestamp
            expiresAt: expiresAt, // Expiry timestamp (null if no expiry)
            decayEnabled: decayEnabled, // Whether amount decay is enabled
            decayPercent: decayPercent, // Percentage of offer that decays (e.g., 50 means 50%)
            decayDurationMs: decayDurationMs, // Duration over which decay happens (in ms)
            depositEnabled: depositEnabled, // Whether deposit is enabled
            depositPercent: depositPercent, // Percentage of offer deposited (10-200%)
            isConditional: isConditional,
            disbursementMode: isConditional ? 'conditional' : 'partial' // conditional = all must accept; partial = per-acceptance payouts
        };

        if (selectedTool === 'decide-later') {
            proposal.decideLaterProposal = {
                parentParcelIds: normalizedParentParcelIds.slice(),
                childParcelIds: [],
                status: 'unapplied'
            };
        }

        // Auto-tag structure proposals (park/square/lake) created from Purchase flow so they carry geometry and parent ids
        if (proposalMainType === 'Purchase' && (selectedTool === 'park' || selectedTool === 'square' || selectedTool === 'lake')) {
            const kind = selectedTool;
            let structureGeometry = null;
            try {
                if (typeof buildGeometryFromParcels === 'function') {
                    const layers = finalParcelIds.map(id => {
                        if (multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
                            const layer = multiParcelSelection.findParcelById(id);
                            if (layer && layer.feature) return layer;
                        }
                        if (typeof resolveParcelLayerById === 'function') {
                            const layer = resolveParcelLayerById(id);
                            if (layer && layer.feature) return layer;
                        }
                        return null;
                    }).filter(Boolean);
                    if (layers.length) {
                        structureGeometry = buildGeometryFromParcels(layers);
                    }
                }
            } catch (_) { /* geometry rebuild best-effort */ }

            proposal.structureProposal = {
                kind,
                status: 'unapplied',
                geometry: structureGeometry || null,
                parentParcelIds: normalizedParentParcelIds,
                blockName: formatParcelSelectionLabel(normalizedParentParcelIds)
            };
        }

        // Road/track proposals created through the constrained corridor modal
        if (selectedTool === 'road-track') {
            const corridor = pendingConstrainedCorridor || (typeof window !== 'undefined' ? window.pendingConstrainedCorridor : null);
            if (!corridor) {
                const tCorridor = getCorridorI18nHelper();
                showProposalAlertMessage('corridor_missing', tCorridor('statusMissing', 'Open the constrained corridor tool and click Done before creating a road/track proposal.'));
                return;
            }

            const corridorParents = (Array.isArray(corridor.parentParcelIds) ? corridor.parentParcelIds : normalizedParentParcelIds)
                .map(id => id && id.toString ? id.toString() : String(id))
                .filter(Boolean);
            const polygonGeometry = corridor.polygon || corridor.superGeometry || null;
            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };
            const centerlinePoints = Array.isArray(corridor.centerline)
                ? corridor.centerline.map(pair => {
                    if (!Array.isArray(pair) || pair.length < 2) return null;
                    const lng = Number(pair[0]);
                    const lat = Number(pair[1]);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                    return { lat, lng };
                }).filter(Boolean)
                : [];
            const fallbackWidth = corridor.type === 'track' ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road;
            const roadDefinition = {
                points: centerlinePoints,
                width: Number.isFinite(corridor.width) ? corridor.width : fallbackWidth,
                polygon: polygonGeometry ? safeClone(polygonGeometry) : null,
                metadata: {
                    mode: corridor.mode || 'draw',
                    type: corridor.type || 'road',
                    isTrack: corridor.type === 'track',
                    source: 'constrained-corridor'
                }
            };

            proposal.primaryType = 'Road';
            proposal.goal = 'road-track';
            proposal.definition = roadDefinition;
            proposal.parentParcelIds = corridorParents;

            if (!proposal.geometry) proposal.geometry = {};
            proposal.geometry.roadPlan = safeClone(roadDefinition);
            if (polygonGeometry && polygonGeometry.type) {
                proposal.geometry.roadGeometry = { polygon: safeClone(polygonGeometry) };
            }

            proposal.roadProposal = {
                definition: safeClone(roadDefinition),
                parentParcelIds: corridorParents.slice(),
                childParcelIds: [],
                status: 'unapplied',
                mode: corridor.mode || 'draw'
            };

            // Clear the pending corridor so it isn't reused accidentally
            pendingConstrainedCorridor = null;
            if (typeof window !== 'undefined') {
                window.pendingConstrainedCorridor = null;
            }
        }

        console.debug('[createProposal] Building proposal object complete, adding lens data');
        const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
        if (lensSnapshot.length) {
            proposal.lens = lensSnapshot;
        }
        console.debug('[createProposal] Proposal object ready, shouldMintOnchain:', shouldMintOnchain);

        // Duplicate pre-check temporarily disabled (false positives were blocking creation)
        // try {
        //     if (proposalStorage && typeof proposalStorage._buildHashSeed === 'function' && typeof proposalStorage._findDuplicateBySeed === 'function') {
        //         const duplicateSeed = proposalStorage._buildHashSeed(proposal);
        //         const duplicate = proposalStorage._findDuplicateBySeed(duplicateSeed);
        //         if (duplicate) {
        //             hideWaitingPopupSafe();
        //             setProposalModalInteractivity(true);
        //             setProposalCreateButtonState(false);
        //             showProposalAlertMessage('this_exact_proposal_already_exists', 'This exact proposal already exists');
        //             return;
        //         }
        //     }
        // } catch (dupCheckError) {
        //     console.warn('Duplicate proposal pre-check failed', dupCheckError);
        // }

        if (proposalMainType === 'Reparcellization') {
            if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.parcelIds)) {
                showProposalAlertMessage('reparcellization_plan_is_missing_please_rerun_the_algorithm', 'Reparcellization plan is missing. Please rerun the algorithm.');
                return;
            }
            const planParcelSet = new Set((pendingReparcelPlan.parcelIds || []).map(id => id && id.toString()));
            const finalParcelSet = new Set(finalParcelIds.map(id => id && id.toString()));
            const parcelsMatch = planParcelSet.size === finalParcelSet.size && Array.from(planParcelSet).every(id => finalParcelSet.has(id));
            if (!parcelsMatch) {
                showProposalAlertMessage('selected_parcels_changed_after_running_reparcellization_please_rerun_the_algorithm', 'Selected parcels changed after running reparcellization. Please rerun the algorithm.');
                return;
            }
            proposal.goal = 'reparcellization';
            proposal.reparcellization = JSON.parse(JSON.stringify(pendingReparcelPlan));
            proposal.reparcellization.parcelIds = finalParcelIds.slice();
        }

        // Building/urban-rule proposals: consume pendingBuildingProposalContext
        const pendingBuildingContext = (typeof window !== 'undefined' ? window.pendingBuildingProposalContext : null)
            || (typeof pendingBuildingProposalContext !== 'undefined' ? pendingBuildingProposalContext : null);
        if (selectedTool === 'buildings' || selectedTool === 'row' || selectedTool === 'parcelBased' || selectedTool === 'single') {
            if (!pendingBuildingContext || !pendingBuildingContext.parcelIds || !pendingBuildingContext.parcelIds.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };

            const rawBuildings = (pendingBuildingContext.buildings && pendingBuildingContext.buildings.length)
                ? pendingBuildingContext.buildings
                : (pendingBuildingContext.buildingFeature ? [pendingBuildingContext.buildingFeature] : []);
            const buildingFeatures = rawBuildings.map(safeClone).filter(f => f && f.geometry);

            if (!buildingFeatures.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const resolvedTypology = (pendingBuildingContext.parameters && pendingBuildingContext.parameters.typology)
                ? String(pendingBuildingContext.parameters.typology)
                : (selectedTool === 'row' ? 'row' : (selectedTool === 'parcelBased' ? 'parcelBased' : 'block'));

            const primaryBuildingFeature = buildingFeatures[0];
            const buildingGeometry = primaryBuildingFeature ? primaryBuildingFeature.geometry : null;
            const buildingProperties = primaryBuildingFeature && primaryBuildingFeature.properties ? { ...primaryBuildingFeature.properties } : {};

            const parentDetails = Array.isArray(pendingBuildingContext.parentDetails) && pendingBuildingContext.parentDetails.length
                ? pendingBuildingContext.parentDetails.map(detail => ({ id: detail.id, number: detail.number || detail.id }))
                : normalizedParentParcelIds.map(id => ({ id, number: id }));
            const ancestorKey = normalizedParentParcelIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

            proposal.primaryType = 'Urban Rule';
            proposal.goal = selectedTool === 'single' ? 'single' : 'buildings';
            proposal.typologyType = resolvedTypology;
            proposal.buildingGeometry = buildingGeometry;
            proposal.buildingProperties = buildingProperties;
            proposal.properties = { ...buildingProperties };
            proposal.tags = ['buildings'];

            if (!proposal.geometry) proposal.geometry = {};
            proposal.geometry.buildings = buildingFeatures;

            proposal.buildingProposal = {
                parentParcelIds: normalizedParentParcelIds.slice(),
                parentParcelNumbers: parentDetails,
                status: 'unapplied',
                createdFrom: resolvedTypology === 'row' ? 'rowHouse' : (resolvedTypology === 'parcelBased' ? 'parcelBased' : 'blockify'),
                blockName: pendingBuildingContext.blockName || formatParcelSelectionLabel(normalizedParentParcelIds),
                parameters: safeClone(pendingBuildingContext.parameters) || {},
                buildingFeature: primaryBuildingFeature,
                buildings: buildingFeatures,
                ancestorKey
            };

            // Clear the pending context so it isn't reused accidentally
            if (typeof window !== 'undefined') {
                window.pendingBuildingProposalContext = null;
                window.pendingBuildingFromBlockify = null;
            }
            if (typeof setPendingBuildingProposalContext === 'function') {
                setPendingBuildingProposalContext(null);
            }
        }

        let hash = null;

        // Try to mint on-chain if blockchain is available and parcels have NFTs
        let onchainResult = null;
        // walletManager already declared above
        let hasWalletProvider = walletManager && walletManager.getProvider();

        // If blockchain is supported but wallet is not connected, prompt user to connect
        if (shouldMintOnchain && !hasWalletProvider) {
            if (walletManager && typeof walletManager.openConnectorModal === 'function') {
                updateStatus('Please connect your wallet to mint the proposal on blockchain...');

                // Open wallet connection modal and wait for connection
                walletManager.openConnectorModal();

                // Wait for wallet connection with a timeout
                const connectionPromise = new Promise((resolve) => {
                    let resolved = false;
                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection timeout.');
                            resolve(false);
                        }
                    }, 60000); // 60 second timeout

                    const handleConnect = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connected! Proceeding with blockchain minting...');
                            resolve(true);
                        }
                    };

                    const handleError = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection cancelled.');
                            resolve(false);
                        }
                    };

                    const handleDisconnect = () => {
                        // If disconnected while waiting, treat as cancellation
                        handleError();
                    };

                    walletManager.on('connect', handleConnect);
                    walletManager.on('error', handleError);
                    walletManager.on('disconnect', handleDisconnect);
                });

                const connected = await connectionPromise;
                if (!connected) {
                    // User cancelled or timeout - cancel creation entirely, keep modal filled
                    updateStatus('Proposal creation cancelled.');
                    hideWaitingPopupSafe();
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    return;
                } else {
                    // Wallet connected - check provider again
                    hasWalletProvider = walletManager && walletManager.getProvider();
                }
            } else {
                // Fallback: show alert if wallet manager is not available
                const walletPrompt = t('alerts.messages.blockchain_mint_wallet_prompt', 'Blockchain minting is available but no wallet is connected. Would you like to connect a wallet to mint this proposal on-chain?');
                const connectWallet = confirm(walletPrompt);
                if (connectWallet && walletManager && typeof walletManager.openConnectorModal === 'function') {
                    walletManager.openConnectorModal();
                    return; // User will need to click Create Proposal again after connecting
                }
            }
        }

        if (shouldMintOnchain && hasWalletProvider) {
            try {
                console.debug('[createProposal] Starting on-chain minting process');
                const mintStartTime = performance.now();
                updateStatus('Preparing proposal for blockchain minting...');

                // Get parcel features for screenshot generation
                console.debug('[createProposal] Loading parcel data for screenshot generation');
                const parcelDataStartTime = performance.now();
                updateStatus('Loading parcel data...');
                showProposalWaitingPopup('Loading parcel data...');
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
                const parcelFeatures = [];
                const parcelPolygons = [];
                console.debug('[proposal-mint] Building parcel polygons for proposal', {
                    parcelIds: finalParcelIds.slice(0, 10),
                    parcelCount: finalParcelIds.length
                });

                const pushParcelPolygons = (coords) => {
                    if (!Array.isArray(coords) || !coords.length) return;
                    // Polygon: [rings]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && typeof coords[0][0][0] === 'number') {
                        parcelPolygons.push(coords);
                        return;
                    }
                    // MultiPolygon: [ [rings], [rings], ... ]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
                        coords.forEach(poly => {
                            if (Array.isArray(poly) && poly.length) {
                                parcelPolygons.push(poly);
                            }
                        });
                    }
                };

                for (const parcelId of finalParcelIds) {
                    let parcelLayer = null;
                    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                        parcelLayer = multiParcelSelection.findParcelById(parcelId);
                    }
                    if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                        parcelLayer = resolveParcelLayerById(parcelId);
                    }
                    // If still not resolved, fetch it to ensure geometry is available
                    if (!parcelLayer && typeof fetchSingleParcelById === 'function') {
                        try {
                            parcelLayer = await fetchSingleParcelById(parcelId, { forceRefresh: false });
                        } catch (err) {
                            console.warn(`[proposal-mint] Unable to fetch parcel ${parcelId} for proposal minting:`, err);
                        }
                    }
                    if (parcelLayer && parcelLayer.feature) {
                        const normalizedFeature = ensureParcelIdOnFeature(parcelLayer.feature);
                        parcelFeatures.push(normalizedFeature);
                        // Extract coordinates for polygon
                        if (parcelLayer.feature.geometry && parcelLayer.feature.geometry.coordinates) {
                            pushParcelPolygons(parcelLayer.feature.geometry.coordinates);
                        }
                    } else {
                        console.warn('[proposal-mint] Missing parcel layer or feature for', parcelId);
                    }
                }

                console.debug('[createProposal] Parcel data loading took:', (performance.now() - parcelDataStartTime).toFixed(2), 'ms');
                console.debug('[proposal-mint] Parcel polygon collection result', {
                    parcelFeaturesCount: parcelFeatures.length,
                    parcelPolygonsCount: parcelPolygons.length,
                    firstPolygonSample: parcelPolygons[0]
                });

                if (parcelFeatures.length === 0) {
                    console.warn('No parcel features found for screenshot generation');
                    hideWaitingPopupSafe();
                } else {
                    // Use the parent parcel IDs from earlier - these are what the proposal references
                    let parcelIdsForMinting = proposal.parentParcelIds;
                    if (!parcelIdsForMinting || parcelIdsForMinting.length === 0) {
                        // Derive parcel IDs in the format expected by the contract
                        parcelIdsForMinting = parcelFeatures
                            .map(feature => {
                                if (window.ProposalChainBridge && window.ProposalChainBridge.deriveParcelIdFromFeature) {
                                    return window.ProposalChainBridge.deriveParcelIdFromFeature(feature);
                                }
                                // Fallback: try to format from properties
                                const props = feature.properties || {};
                                const canonicalId = getParcelIdFromFeature(feature);
                                if (canonicalId) return canonicalId.toString();
                                if (props.MATICNI_BROJ_KO && props.BROJ_CESTICE) {
                                    return window.ProposalChainBridge ?
                                        window.ProposalChainBridge.formatParcelId(props.MATICNI_BROJ_KO, props.BROJ_CESTICE) :
                                        `HR-${props.MATICNI_BROJ_KO}-${props.BROJ_CESTICE}`;
                                }
                                return null;
                            })
                            .filter(Boolean);
                    }

                    if (parcelIdsForMinting.length === 0) {
                        console.warn('Could not derive formatted parcel IDs for on-chain minting');
                        hideWaitingPopupSafe();
                    } else {
                        // Verify required services are available
                        if (!window.MapScreenshot) {
                            throw new Error('Map screenshot capture is not available.');
                        }
                        if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                            throw new Error('Asset upload service is not available.');
                        }

                        // Build combined polygon from all parcels for screenshot
                        console.debug('[createProposal] Preparing proposal geometry for screenshot');
                        const geometryStartTime = performance.now();
                        updateStatus('Preparing proposal geometry...');
                        showProposalWaitingPopup('Preparing proposal geometry...');
                        const combinedPolygon = [];
                        let minLat = Infinity;
                        let maxLat = -Infinity;
                        let minLng = Infinity;
                        let maxLng = -Infinity;

                        const addPoint = (lat, lng) => {
                            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                                return;
                            }
                            combinedPolygon.push([lat, lng]);
                            minLat = Math.min(minLat, lat);
                            maxLat = Math.max(maxLat, lat);
                            minLng = Math.min(minLng, lng);
                            maxLng = Math.max(maxLng, lng);
                        };

                        const addCoords = (segment) => {
                            if (!Array.isArray(segment)) return;
                            // If this looks like a point [lng, lat]
                            if (segment.length === 2 && Number.isFinite(segment[0]) && Number.isFinite(segment[1])) {
                                const lat = Math.abs(segment[0]) <= 90 ? segment[0] : segment[1];
                                const lng = Math.abs(segment[0]) <= 90 ? segment[1] : segment[0];
                                addPoint(lat, lng);
                                return;
                            }
                            // If this is a ring or nested array, recurse
                            segment.forEach(inner => addCoords(inner));
                        };

                        parcelPolygons.forEach(poly => addCoords(poly));

                        if (combinedPolygon.length < 3) {
                            // Derive a rectangle from min/max if we collected any coords
                            if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                                console.warn('[proposal-mint] Fallback rectangle from min/max bounds', { minLat, maxLat, minLng, maxLng });
                                combinedPolygon.length = 0;
                                combinedPolygon.push([minLat, minLng]);
                                combinedPolygon.push([minLat, maxLng]);
                                combinedPolygon.push([maxLat, maxLng]);
                                combinedPolygon.push([maxLat, minLng]);
                                combinedPolygon.push([minLat, minLng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            // Fallback: use map bounds if available
                            if (bounds && typeof bounds.getSouthWest === 'function') {
                                const sw = bounds.getSouthWest();
                                const ne = bounds.getNorthEast();
                                console.warn('[proposal-mint] Fallback rectangle from map bounds', { sw, ne });
                                combinedPolygon.push([sw.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, sw.lng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            console.error('[proposal-mint] Unable to derive proposal polygon', {
                                parcelIds: finalParcelIds.slice(0, 10),
                                parcelPolygonsCount: parcelPolygons.length
                            });
                            throw new Error('Unable to derive proposal polygon for NFT metadata.');
                        }

                        const buildBoundsFromParcelPolygons = (polys, fallbackBounds) => {
                            if (fallbackBounds && typeof fallbackBounds.isValid === 'function' && fallbackBounds.isValid()) {
                                return fallbackBounds;
                            }
                            if (!Array.isArray(polys) || typeof L === 'undefined' || !L || typeof L.latLngBounds !== 'function') return null;
                            try {
                                const latLngs = [];
                                polys.forEach(poly => {
                                    const collect = (node) => {
                                        if (!Array.isArray(node)) return;
                                        if (node.length && Array.isArray(node[0]) && typeof node[0][0] === 'number' && typeof node[0][1] === 'number') {
                                            node.forEach(pair => {
                                                if (Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                                                    // GeoJSON order is [lng, lat]
                                                    latLngs.push(L.latLng(pair[1], pair[0]));
                                                }
                                            });
                                            return;
                                        }
                                        node.forEach(collect);
                                    };
                                    collect(poly);
                                });
                                return latLngs.length ? L.latLngBounds(latLngs) : null;
                            } catch (err) {
                                console.warn('[proposal-mint] Failed to derive bounds from parcel polygons', err);
                                return null;
                            }
                        };

                        const screenshotBounds = buildBoundsFromParcelPolygons(parcelPolygons, bounds);

                        console.debug('[createProposal] Geometry preparation took:', (performance.now() - geometryStartTime).toFixed(2), 'ms');

                        // Capture screenshot from the preview
                        updateStatus('Capturing proposal image...');
                        showProposalWaitingPopup('Capturing proposal image...');

                        let screenshotDataUrl = proposalModalScreenshotDataUrl;
                        let captureError = null;

                        // If no stored screenshot, capture from the preview now
                        if (!screenshotDataUrl) {
                            console.debug('[createProposal] No stored screenshot, attempting capture from preview');
                            const screenshotContainer = document.getElementById('proposalScreenshotContainer');
                            const previewWrapper = screenshotContainer?.querySelector('.map-screenshot-container');

                            console.debug('[createProposal] Screenshot container:', !!screenshotContainer);
                            console.debug('[createProposal] Preview wrapper:', !!previewWrapper);
                            console.debug('[createProposal] Preview map:', !!previewWrapper?._leafletPreviewMap);
                            console.debug('[createProposal] MapScreenshot available:', !!window.MapScreenshot?.captureFromPreview);

                            if (!previewWrapper) {
                                captureError = 'Preview container not found in modal.';
                            } else if (!previewWrapper._leafletPreviewMap) {
                                captureError = 'Preview map not initialized.';
                            } else if (!window.MapScreenshot?.captureFromPreview) {
                                captureError = 'Screenshot capture function not available.';
                            } else {
                                try {
                                    screenshotDataUrl = await window.MapScreenshot.captureFromPreview(previewWrapper);
                                    console.debug('[createProposal] Capture succeeded, data length:', screenshotDataUrl?.length);
                                } catch (previewErr) {
                                    console.error('[createProposal] Failed to capture from preview:', previewErr);
                                    captureError = previewErr.message || 'Capture failed';
                                }
                            }
                        } else {
                            console.debug('[createProposal] Using stored screenshot, length:', screenshotDataUrl.length);
                        }

                        // Validate screenshot - check it's not blank/white
                        if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image/')) {
                            const base64Part = screenshotDataUrl.split(',')[1];
                            if (base64Part) {
                                const byteSize = Math.ceil(base64Part.length * 3 / 4);
                                console.debug('[createProposal] Screenshot size:', byteSize, 'bytes');
                                // Lowered threshold - even a small map tile should be > 2KB
                                if (byteSize < 2000) {
                                    console.warn('[createProposal] Screenshot appears to be blank (too small):', byteSize, 'bytes');
                                    captureError = `Screenshot too small (${byteSize} bytes), likely blank.`;
                                    screenshotDataUrl = null;
                                }
                            }
                        }

                        // Fallback: if the preview capture failed or is blank, try tile stitching approach
                        if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) {
                            console.debug('[createProposal] Fallback to tile stitch capture', {
                                hasCaptureViaTileStitch: !!window.MapScreenshot?.captureViaTileStitch,
                                parcelPolygonsCount: parcelPolygons.length,
                                combinedPolygonLength: combinedPolygon.length,
                                boundsPresent: !!screenshotBounds
                            });
                            try {
                                if (window.MapScreenshot?.captureViaTileStitch) {
                                    screenshotDataUrl = await window.MapScreenshot.captureViaTileStitch({
                                        polygon: combinedPolygon,
                                        parcelPolygons: parcelPolygons,
                                        padding: 0.12,
                                        bounds: screenshotBounds,
                                        zoom: 19
                                    });
                                    console.debug('[createProposal] Tile stitch capture succeeded, length:', screenshotDataUrl?.length);
                                } else {
                                    // Ultimate fallback: old offscreen Leaflet capture
                                    screenshotDataUrl = await window.MapScreenshot.capturePolygonImage({
                                        polygon: combinedPolygon,
                                        parcelPolygons: parcelPolygons,
                                        padding: 0.05,
                                        size: 600,
                                        bounds: screenshotBounds
                                    });
                                    console.debug('[createProposal] Leaflet offscreen capture length:', screenshotDataUrl?.length);
                                }
                            } catch (fallbackErr) {
                                console.error('[createProposal] Fallback capture failed:', fallbackErr);
                                captureError = captureError || fallbackErr.message || 'Offscreen capture failed';
                                screenshotDataUrl = null;
                            }
                        }

                        if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) {
                            const errorDetail = captureError ? `: ${captureError}` : '';
                            throw new Error(`Unable to capture proposal screenshot${errorDetail}`);
                        }

                        console.debug('[createProposal] Using screenshot:', { length: screenshotDataUrl.length });

                        // Convert offer to ETH amount
                        // If currency is ETH, use the offer amount directly (will be converted to Wei by mintProposal)
                        // Otherwise, set to 0 (no ETH funding, but proposal can still be minted)
                        const ethAmount = offerCurrency === 'ETH' ? offer : 0;

                        console.debug('[createProposal] Uploading proposal image to IPFS');
                        const ipfsStartTime = performance.now();
                        updateStatus('Uploading proposal image to IPFS...');
                        showProposalWaitingPopup('Uploading proposal image to IPFS...');
                        const createdAtIso = proposal.createdAt || new Date().toISOString();
                        proposal.createdAt = createdAtIso;

                        const lensEntriesForMint = getProposalLensEntries(proposal, { fallbackToGlobal: true });
                        const lensAddressesForMint = lensEntriesForMint
                            .filter(entry => entry && entry.address && entry.address.trim())
                            .map(entry => entry.address.trim());
                        if (!lensAddressesForMint.length) {
                            throw new Error('Cannot mint proposal: lens list is empty. Set your lens before minting.');
                        }

                        const goalKey = resolveProposalGoalKey(proposal, null) || proposalType || 'proposal';
                        const goalLabel = goalKey.replace(/-/g, ' ');
                        const metadataPayload = {
                            name: `${goalLabel} Proposal`,
                            description: description,
                            image: '', // populated after image upload
                            attributes: [
                                {
                                    trait_type: 'Goal',
                                    value: goalLabel
                                },
                                {
                                    trait_type: 'Conditional',
                                    value: isConditional ? 'Yes' : 'No'
                                },
                                {
                                    trait_type: 'Parcel Count',
                                    value: parcelIdsForMinting.length
                                },
                                {
                                    trait_type: 'Author',
                                    value: author
                                },
                                {
                                    trait_type: 'Offer',
                                    value: `${offer} ${offerCurrency}`
                                }
                            ],
                            properties: {
                                proposalId: proposal.proposalId || hash || '',
                                goal: goalKey,
                                parcelIds: parcelIdsForMinting,
                                conditional: isConditional,
                                lens: lensAddressesForMint,
                                offer: {
                                    amount: offer,
                                    currency: offerCurrency
                                },
                                ethAmount: ethAmount,
                                createdAt: createdAtIso,
                                author,
                                description
                            }
                        };

                        const fileNameBase = `proposal-${Date.now()}`;
                        const uploadChainId = (walletManager && typeof walletManager.getState === 'function')
                            ? walletManager.getState()?.chainId
                            : null;
                        const assetUploadResult = await window.AssetService.uploadProposalAssets({
                            imageData: screenshotDataUrl,
                            metadata: metadataPayload,
                            fileName: fileNameBase,
                            chainId: uploadChainId,
                            target: 'auto'
                        });
                        console.debug('[createProposal] IPFS upload took:', (performance.now() - ipfsStartTime).toFixed(2), 'ms');
                        const metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';

                        if (!metadataUri) {
                            throw new Error('Metadata URI missing from asset upload response.');
                        }

                        console.debug('[createProposal] Minting proposal on blockchain');
                        const mintTxStartTime = performance.now();
                        showProposalWaitingPopup('Waiting for transaction...');
                        waitingPopupVisible = true;
                        setProposalModalDimmed(true);
                        updateStatus('Minting proposal on blockchain...');

                        onchainResult = await window.ProposalChainBridge.mintProposal({
                            parcelIds: parcelIdsForMinting,
                            isConditional: isConditional,
                            ethAmount: ethAmount,
                            tokenAmount: 0n,
                            imageURI: metadataUri,
                            lens: lensAddressesForMint
                        });
                        console.debug('[createProposal] Blockchain minting took:', (performance.now() - mintTxStartTime).toFixed(2), 'ms');
                        console.debug('[createProposal] Total on-chain minting process took:', (performance.now() - mintStartTime).toFixed(2), 'ms');
                        hideWaitingPopupSafe();

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
                        proposal.nft = {
                            chain: onchainResult.chainId || chainId || null,
                            contract: onchainResult.contractAddress || null,
                            tokenId: onchainResult.proposalId != null ? onchainResult.proposalId.toString() : null
                        };

                        // Update stored proposal with on-chain data
                        const stored = proposalStorage.getProposal(proposal.proposalId || proposal.proposalId);
                        if (stored) {
                            stored.onchain = { ...proposal.onchain };
                            stored.nft = { ...proposal.nft };
                            stored.proposalId = stored.proposalId || hash || stored.proposalId;
                            if (typeof proposalStorage._indexProposal === 'function') {
                                proposalStorage._indexProposal(stored);
                            }
                            if (typeof proposalStorage.save === 'function') {
                                proposalStorage.save();
                            }
                        }

                        updateStatus(`Proposal minted on blockchain! Transaction: ${onchainResult.transactionHash.substring(0, 10)}...`);
                    }
                }
            } catch (error) {
                hideWaitingPopupSafe();
                console.error('On-chain mint failed:', error);

                const isUserCancelled = (err) => {
                    const code = err && (err.code || err.error?.code || err.data?.code || err.info?.error?.code);
                    const rawMessage = err && (err.message || err.error?.message || err.data?.message || err.shortMessage || err.info?.error?.message || '');
                    const message = (rawMessage || '').toLowerCase();
                    return code === 4001
                        || code === 'ACTION_REJECTED'
                        || code === 'TRANSACTION_REJECTED'
                        || message.includes('user rejected')
                        || message.includes('user denied')
                        || message.includes('user canceled')
                        || message.includes('user cancelled')
                        || message.includes('rejected by user')
                        || message.includes('transaction was rejected')
                        || message.includes('transaction rejected')
                        || message.includes('request rejected');
                };

                if (isUserCancelled(error)) {
                    showProposalWaitingPopupTemporary('Transaction rejected', 2000);
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    return;
                }

                const failureReason = error?.message
                    || error?.error?.message
                    || error?.data?.message
                    || error?.details
                    || t('modal.createProposal.onchainMintFailed.unknown', 'Unknown error');

                const decision = await showOnchainMintFailedModal(failureReason);
                if (decision !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    return;
                }

                updateStatus('Creating in-memory proposal (on-chain mint skipped).');
                shouldMintOnchain = false;
                onchainResult = null;
            }
        }

        // Persist proposal after on-chain handling (or local-only)
        console.debug('[createProposal] Saving proposal to storage');
        const saveStartTime = performance.now();
        updateStatus('Saving proposal...');
        if (!waitingPopupVisible) {
            showProposalWaitingPopup('Saving proposal...');
            waitingPopupVisible = true;
            setProposalModalDimmed(true);
        }
        const proposalId = proposalStorage.addProposal(proposal);
        console.debug('[createProposal] Proposal save took:', (performance.now() - saveStartTime).toFixed(2), 'ms');
        if (proposalId === null) {
            hideWaitingPopupSafe();
            updateStatus('Unable to save proposal.');
            setProposalModalInteractivity(true);
            setProposalCreateButtonState(false);
            return;
        }
        const storedForOnchain = proposalStorage.getProposal(proposalId);
        const storedProposalId = storedForOnchain?.proposalId || proposal.proposalId || proposalId;

        // Update stored proposal with on-chain data if available
        if (onchainResult) {
            const stored = storedForOnchain;
            if (stored) {
                stored.onchain = { ...(stored.onchain || {}), ...(proposal.onchain || {}) };
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(stored);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }

        // Update the show proposals button count
        console.debug('[createProposal] Updating UI and logging user action');
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
                ? proposalStorage.getProposal(proposalId)
                : null;
            const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(storedProposalId);
            const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(proposalId);
            const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;
            const budgetCurrencyLabel = offerCurrency || 'USDT';
            const onchainNote = onchainResult ? ' (on-chain)' : '';
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> created a ${proposalType} proposal${onchainNote} (${proposalLinkHtml}) for ${proposal.parentParcelIds.length} parcel(s) with budget ${offer} ${budgetCurrencyLabel}.`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(proposalId)) {
                userAgent.proposalsCreated.push(proposalId);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Enable show proposals mode and clear multi-selection
        console.debug('[createProposal] Enabling show proposals mode and cleaning up UI');
        enableShowProposalsMode();

        // Hide parcel info panel if needed
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        const statusMessage = onchainResult
            ? `Proposal "${proposalType}" created and minted on blockchain with ${proposal.parentParcelIds.length} parcels.`
            : `Proposal "${proposalType}" created successfully with ${proposal.parentParcelIds.length} parcels.`;
        updateStatus(statusMessage);

        if (proposalMainType === 'Reparcellization' && typeof window !== 'undefined') {
            window.pendingReparcellizationPlan = null;
        }

        if (typeof multiParcelSelection !== 'undefined') {
            if (createdFromMultiSelect && multiParcelSelection.isActive) {
                multiParcelSelection.toggle({ restoreSingleSelection: false });
            } else if (multiParcelSelection.selectedParcels) {
                multiParcelSelection.selectedParcels.clear();
                multiParcelSelection.lastSelectedParcelId = null;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        const focusParcelId = proposal.parentParcelIds[0] || null;
        const openProposalDetails = () => {
            if (!waitingPopupVisible) {
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
            }
            if (typeof selectAndHighlightProposal === 'function') {
                // Do not refocus map when opening details immediately after creation
                selectAndHighlightProposal(proposalId, focusParcelId, false, true);
            } else if (typeof showProposalDetailsModal === 'function') {
                showProposalDetailsModal(proposalId);
            }
            // Hide popup after a short delay to allow panel to render
            setTimeout(() => {
                hideWaitingPopupSafe();
            }, 500);
        };

        console.debug('[createProposal] All proposal creation steps complete, opening details. Total elapsed:', (performance.now() - startTime).toFixed(2), 'ms');
        if (onchainResult) {
            showProposalMintSuccessModal({
                proposalId: onchainResult.proposalId,
                proposalId: hash,
                txHash: onchainResult.transactionHash,
                chainId: onchainResult.chainId,
                onClose: openProposalDetails
            });
        } else {
            openProposalDetails();
        }

    } catch (error) {
        console.error('Error creating proposal:', error);
        const fallback = t('alerts.messages.failed_to_create_proposal', 'Failed to create proposal.');
        const message = (error && error.message) ? error.message : fallback;
        if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
            window.showStyledAlert(message);
        } else {
            alert(message);
        }
    } finally {
        hideWaitingPopupSafe();
        setProposalModalInteractivity(true);
        setProposalCreateButtonState(false);
    }
}

const proposalListState = {
    activeTab: 'active',
    filterType: 'all',
    authorFilter: '',
    searchText: '',
    sortKey: 'created-desc',
    selectedId: null
};

const PROPOSAL_SORT_OPTIONS = [
    { value: 'created-desc', label: 'Created (newest first)' },
    { value: 'created-asc', label: 'Created (oldest first)' },
    { value: 'acceptance-desc', label: 'Acceptance (high to low)' },
    { value: 'acceptance-asc', label: 'Acceptance (low to high)' },
    { value: 'value-desc', label: 'Offer (high to low)' },
    { value: 'value-asc', label: 'Offer (low to high)' },
    { value: 'parcels-desc', label: 'Parcels (many to few)' },
    { value: 'parcels-asc', label: 'Parcels (few to many)' },
    { value: 'area-desc', label: 'Area (large to small)' },
    { value: 'area-asc', label: 'Area (small to large)' },
    { value: 'author-asc', label: 'Author (A → Z)' },
    { value: 'author-desc', label: 'Author (Z → A)' }
];

const PROPOSAL_SORT_I18N_KEYS = {
    'created-desc': 'createdDesc',
    'created-asc': 'createdAsc',
    'acceptance-desc': 'acceptanceDesc',
    'acceptance-asc': 'acceptanceAsc',
    'value-desc': 'valueDesc',
    'value-asc': 'valueAsc',
    'parcels-desc': 'parcelsDesc',
    'parcels-asc': 'parcelsAsc',
    'area-desc': 'areaDesc',
    'area-asc': 'areaAsc',
    'author-asc': 'authorAsc',
    'author-desc': 'authorDesc'
};

const PROPOSAL_TYPE_FILTERS = [
    { value: 'all', label: 'All types' },
    { value: 'road', label: 'Roads' },
    { value: 'building', label: 'Buildings' },
    { value: 'park', label: 'Parks' },
    { value: 'lake', label: 'Lakes' },
    { value: 'square', label: 'Squares' },
    { value: 'structure', label: 'Other structures' },
    { value: 'reparcellization', label: 'Reparcellization' },
    { value: 'parcel', label: 'Parcel proposals' },
    { value: 'other', label: 'Other' }
];

const PROPOSAL_TYPE_FILTER_I18N_KEYS = {
    all: 'all',
    road: 'road',
    building: 'building',
    park: 'park',
    lake: 'lake',
    square: 'square',
    structure: 'structure',
    reparcellization: 'reparcellization',
    parcel: 'parcel',
    other: 'other'
};

const PROPOSAL_TYPE_LABELS = {
    road: 'Road',
    building: 'Building',
    park: 'Park',
    square: 'Square',
    lake: 'Lake',
    'decide later': 'Decide later',
    structure: 'Structure',
    reparcellization: 'Reparcellization',
    parcel: 'Parcel',
    other: 'Other'
};

function getLocalizedProposalSortOptions() {
    const t = getProposalI18nHelper();
    return PROPOSAL_SORT_OPTIONS.map(option => {
        const i18nKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.sort.${i18nKey}`, option.label)
        };
    });
}

function getLocalizedProposalTypeFilters() {
    const t = getProposalI18nHelper();
    return PROPOSAL_TYPE_FILTERS.map(option => {
        const i18nKey = PROPOSAL_TYPE_FILTER_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.filters.types.${i18nKey}`, option.label)
        };
    });
}

function getProposalTypeLabel(typeKey) {
    const t = getProposalI18nHelper();
    const normalizedKey = (typeKey || 'other').toLowerCase();
    const fallback = PROPOSAL_TYPE_LABELS[normalizedKey]
        || (normalizedKey ? normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1) : '');
    return t(`modal.roadWidth.proposalList.typeLabels.${normalizedKey}`, fallback);
}

function resolveStructureProposal(proposal, options = {}) {
    if (!proposal) return null;
    if (proposal.structureProposal && typeof proposal.structureProposal === 'object') {
        return proposal.structureProposal;
    }

    const fallbackToStorage = options && Object.prototype.hasOwnProperty.call(options, 'fallbackToStorage')
        ? options.fallbackToStorage !== false
        : true;
    if (!fallbackToStorage) {
        return null;
    }

    if (!proposal.proposalId || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
        return null;
    }

    try {
        const stored = proposalStorage.getProposal(proposal.proposalId);
        if (stored && stored.structureProposal && typeof stored.structureProposal === 'object') {
            return stored.structureProposal;
        }
    } catch (_) { }
    return null;
}

if (typeof window !== 'undefined') {
    window.resolveStructureProposal = resolveStructureProposal;
}

function computeProposalCategoryFlags(proposal, options = {}) {
    const fallback = options && options.fallbackProposal ? options.fallbackProposal : null;
    const subject = proposal || fallback || {};
    const goalKey = resolveProposalGoalKey(subject, fallback) || '';

    let structureProposal = resolveStructureProposal(subject, { fallbackToStorage: options.fallbackToStorage !== false });
    if (!structureProposal && fallback && fallback !== subject) {
        structureProposal = resolveStructureProposal(fallback, { fallbackToStorage: options.fallbackToStorage !== false });
    }
    if (!structureProposal && subject.structureProposal) {
        structureProposal = subject.structureProposal;
    }
    if (!structureProposal && fallback && fallback.structureProposal) {
        structureProposal = fallback.structureProposal;
    }

    const hasStructureProposal = !!structureProposal;
    const structureKind = ((structureProposal && structureProposal.kind) || (subject.structureProposal && subject.structureProposal.kind) || (fallback && fallback.structureProposal && fallback.structureProposal.kind) || '').toLowerCase();
    const isRoadProposal = goalKey === 'road-track';
    const isReparcellizationProposal = goalKey === 'reparcellization' || !!subject.reparcellization || !!(fallback && fallback.reparcellization);
    const isBuildingGoal = ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey);
    const isStructureGoal = ['park', 'square', 'lake'].includes(goalKey) || ['park', 'square', 'lake'].includes(structureKind);
    const isBuildingProposal = (!isRoadProposal) && (isBuildingGoal || !!subject.buildingProposal || !!subject.buildingGeometry || !!(fallback && (fallback.buildingProposal || fallback.buildingGeometry)));
    const isStructureProposal = (!isRoadProposal) && (!isBuildingProposal) && (isStructureGoal || hasStructureProposal);

    const supportsMapToggle = isRoadProposal || isBuildingProposal || isStructureProposal || isReparcellizationProposal;

    return {
        structureProposal: structureProposal || null,
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        supportsMapToggle
    };
}

function getProposalDisplayType(proposal) {
    if (!proposal) return 'other';

    const goalKey = resolveProposalGoalKey(proposal, null);

    if (goalKey === 'road-track') {
        return 'road';
    }

    if (goalKey === 'buildings' || goalKey === 'single' || goalKey === 'row' || goalKey === 'parcelBased') {
        return 'building';
    }

    if (goalKey === 'park' || goalKey === 'square' || goalKey === 'lake') {
        return goalKey;
    }

    if (goalKey === 'reparcellization') {
        return 'reparcellization';
    }

    if (goalKey === 'decide-later') {
        return 'decide later';
    }

    return 'other';
}

function formatProposalTypeLabel(typeKey) {
    return getProposalTypeLabel(typeKey);
}

function isProposalApplied(proposal) {
    if (!proposal) return false;

    const structureData = resolveStructureProposal(proposal);
    const goalKey = resolveProposalGoalKey(proposal, null);
    const hasSpatialComponent = Boolean(
        goalKey === 'road-track'
        || goalKey === 'buildings'
        || goalKey === 'single'
        || goalKey === 'row'
        || goalKey === 'parcelBased'
        || goalKey === 'park'
        || goalKey === 'square'
        || goalKey === 'lake'
        || goalKey === 'reparcellization'
        || goalKey === 'decide-later'
        || (proposal.roadProposal && proposal.roadProposal.roadGeometry)
        || proposal.roadGeometry
        || proposal.buildingProposal
        || proposal.buildingGeometry
        || structureData
        || proposal.reparcellization
        || proposal.decideLaterProposal
    );

    const globalStatus = (proposal.status || '').toLowerCase();
    if (hasSpatialComponent && (globalStatus === 'applied' || globalStatus === 'executed')) {
        return true;
    }

    const roadStatus = (proposal.roadProposal && proposal.roadProposal.status) ? proposal.roadProposal.status.toLowerCase() : '';
    if (roadStatus === 'applied' || roadStatus === 'executed') {
        return true;
    }

    const buildingStatus = (proposal.buildingProposal && proposal.buildingProposal.status)
        ? proposal.buildingProposal.status.toLowerCase()
        : '';
    if (buildingStatus === 'applied' || buildingStatus === 'executed') {
        return true;
    }

    const structureStatus = structureData && structureData.status
        ? structureData.status.toLowerCase()
        : '';
    if (structureStatus === 'applied' || structureStatus === 'executed') {
        return true;
    }

    const reparcelStatus = (proposal.reparcellization && proposal.reparcellization.status)
        ? proposal.reparcellization.status.toLowerCase()
        : '';
    if (reparcelStatus === 'applied' || reparcelStatus === 'executed') {
        return true;
    }

    const decideLaterStatus = (proposal.decideLaterProposal && proposal.decideLaterProposal.status)
        ? proposal.decideLaterProposal.status.toLowerCase()
        : '';
    if (decideLaterStatus === 'applied' || decideLaterStatus === 'executed') {
        return true;
    }

    return false;
}

const PROPOSAL_INACTIVE_STATUSES = new Set([
    'inactive',
    'expired',
    'cancelled',
    'canceled',
    'rejected',
    'declined',
    'void',
    'archived'
]);

function getProposalLifecycleKey(proposal) {
    if (!proposal) return 'active';
    const lifecycleField = (proposal.lifecycleStatus || proposal.status || '').toLowerCase();
    if (lifecycleField === 'executed') return 'executed';
    if (lifecycleField === 'expired') return 'expired';
    if (PROPOSAL_INACTIVE_STATUSES.has(lifecycleField)) return 'inactive';
    return 'active';
}

function getProposalLifecycleLabel(key) {
    const t = getProposalI18nHelper();
    switch (key) {
        case 'executed':
            return t('panel.proposal.lifecycle.executed', 'Executed');
        case 'expired':
            return t('panel.proposal.lifecycle.expired', 'Expired');
        case 'inactive':
            return t('panel.proposal.lifecycle.inactive', 'Inactive');
        default:
            return t('panel.proposal.lifecycle.active', 'Active');
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'executed':
            return 'executed';
        case 'expired':
            return 'expired';
        case 'inactive':
            return 'inactive';
        default:
            return 'active';
    }
}

if (typeof window !== 'undefined') {
    window.getProposalLifecycleKey = getProposalLifecycleKey;
    window.getProposalLifecycleLabel = getProposalLifecycleLabel;
    window.getProposalLifecycleClass = getProposalLifecycleClass;
    window.getParcelAreaById = getParcelAreaById;
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
    let area = 0;
    let source = 'none';

    try {
        const layer = typeof resolveParcelLayerById === 'function'
            ? resolveParcelLayerById(parcelId)
            : (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function'
                ? multiParcelSelection.findParcelById(parcelId)
                : null);
        if (layer && layer.feature?.properties && Number.isFinite(layer.feature.properties.calculatedArea)) {
            area = Number(layer.feature.properties.calculatedArea) || 0;
            source = 'resolveParcelLayerById';
        }
    } catch (err) {
        console.warn('[getParcelAreaById] resolveParcelLayerById error:', err);
    }

    if (!area) {
        try {
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                parcelLayer.eachLayer(l => {
                    if (area) return;
                    const candidate = getParcelIdFromFeature(l?.feature);
                    if (candidate !== undefined && candidate !== null && candidate.toString() === parcelId.toString()) {
                        const maybeArea = l.feature?.properties?.calculatedArea;
                        if (Number.isFinite(maybeArea)) {
                            area = Number(maybeArea) || 0;
                            source = 'parcelLayer.eachLayer';
                        }
                    }
                });
            }
        } catch (err) {
            console.warn('[getParcelAreaById] parcelLayer.eachLayer error:', err);
        }
    }

    if (!area) {
        try {
            const record = readPersistedParcelRecord(parcelId);
            const props = record?.properties;
            if (props && Number.isFinite(props.calculatedArea)) {
                area = Number(props.calculatedArea) || 0;
                source = 'PersistentStorage';
            }
        } catch (_) {
            // ignore storage issues
        }
    }

    return area;
}

function computeProposalArea(proposal) {
    if (!proposal) return 0;

    if (Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0) {
        return proposal.parentParcelIds.reduce((sum, id) => sum + getParcelAreaById(id), 0);
    }

    try {
        if (proposal.structureProposal?.geometry && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.structureProposal.geometry);
        }
        if (proposal.buildingProposal?.buildingFeature && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.buildingProposal.buildingFeature);
        }
    } catch (_) {
        // fall back silently when turf measurement fails
    }

    return 0;
}

function computeProposalMetrics(proposal) {
    const createdAt = Date.parse(proposal.createdAt) || 0;
    const executedAt = proposal.executedAt ? (Date.parse(proposal.executedAt) || 0) : 0;
    const parcelCount = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds.length : 0;
    const acceptedCount = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0;
    const acceptanceRatio = parcelCount > 0 ? acceptedCount / parcelCount : 0;
    const offerValue = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : 0);
    const area = computeProposalArea(proposal);
    const typeKey = getProposalDisplayType(proposal);
    const author = (proposal.author || '').trim();
    const title = (proposal.title || '').trim();

    return {
        createdAt,
        executedAt,
        parcelCount,
        acceptedCount,
        acceptanceRatio,
        acceptancePercent: acceptanceRatio * 100,
        offerValue,
        area,
        typeKey,
        author,
        authorLower: author.toLowerCase(),
        titleLower: title.toLowerCase(),
        isApplied: isProposalApplied(proposal)
    };
}

function formatAreaMetric(area) {
    if (!Number.isFinite(area) || area <= 0) {
        return '—';
    }
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}

function formatCurrencyMetric(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return '—';
    }
    return `€${Math.round(value).toLocaleString('hr-HR')}`;
}

function applyProposalListFilters(dataset) {
    const typeFilter = proposalListState.filterType;
    const authorFilter = proposalListState.authorFilter.trim().toLowerCase();
    const searchFilter = proposalListState.searchText.trim().toLowerCase();

    return dataset.filter(entry => {
        const { metrics } = entry;
        if (typeFilter !== 'all' && metrics.typeKey !== typeFilter) {
            return false;
        }

        if (authorFilter && !metrics.authorLower.includes(authorFilter)) {
            return false;
        }

        if (searchFilter) {
            const haystack = `${metrics.authorLower} ${metrics.titleLower}`;
            if (!haystack.includes(searchFilter)) {
                return false;
            }
        }

        return true;
    });
}

function sortProposalDataset(dataset) {
    const sortKey = proposalListState.sortKey || 'created-desc';

    const sorted = dataset.slice();
    sorted.sort((a, b) => {
        const am = a.metrics;
        const bm = b.metrics;

        switch (sortKey) {
            case 'created-asc':
                return am.createdAt - bm.createdAt;
            case 'acceptance-desc':
                return bm.acceptanceRatio - am.acceptanceRatio;
            case 'acceptance-asc':
                return am.acceptanceRatio - bm.acceptanceRatio;
            case 'value-desc':
                return bm.offerValue - am.offerValue;
            case 'value-asc':
                return am.offerValue - bm.offerValue;
            case 'parcels-desc':
                return bm.parcelCount - am.parcelCount;
            case 'parcels-asc':
                return am.parcelCount - bm.parcelCount;
            case 'area-desc':
                return bm.area - am.area;
            case 'area-asc':
                return am.area - bm.area;
            case 'author-asc':
                return am.authorLower.localeCompare(bm.authorLower);
            case 'author-desc':
                return bm.authorLower.localeCompare(am.authorLower);
            case 'created-desc':
            default:
                return bm.createdAt - am.createdAt;
        }
    });

    return sorted;
}

function buildProposalActionButtons(proposal, isExecuted = false) {
    // Action buttons (Apply to map / Remove from map) are now only available in proposal details modal
    // Removed from proposal list cards to simplify the UI
    return '';
}

function buildProposalListItemsHtml(dataset) {
    const t = getProposalI18nHelper();
    const metaLabels = {
        author: t('modal.roadWidth.proposalList.meta.author', 'Author:'),
        created: t('modal.roadWidth.proposalList.meta.created', 'Created:'),
        acceptance: t('modal.roadWidth.proposalList.meta.acceptance', 'Acceptance:'),
        parcels: t('modal.roadWidth.proposalList.meta.parcels', 'Parcels:'),
        area: t('modal.roadWidth.proposalList.meta.area', 'Area:'),
        offer: t('modal.roadWidth.proposalList.meta.offer', 'Offer:'),
        applied: t('modal.roadWidth.proposalList.meta.applied', 'Applied:'),
        disbursement: t('modal.roadWidth.proposalList.meta.disbursement', 'Disbursement:'),
        minted: t('modal.roadWidth.proposalList.meta.minted', 'Minted:')
    };
    const emptyText = t('modal.roadWidth.proposalList.empty', 'No proposals match the current filters.');
    const untitledLabel = t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
    const unknownAuthor = t('common.unknown', 'Unknown');
    const deleteTooltip = t('modal.roadWidth.proposalList.deleteTooltip', 'Delete proposal');

    if (!dataset || dataset.length === 0) {
        return `<p class="empty-proposals">${escapeHtml(emptyText)}</p>`;
    }

    return dataset.map(entry => {
        const { proposal, metrics } = entry;
        const proposalId = getProposalKey(proposal);
        const color = typeof getProposalColor === 'function' ? getProposalColor(proposalId || '') : '#007bff';
        const lifecycleKey = getProposalLifecycleKey(proposal);
        const statusLabel = escapeHtml(getProposalLifecycleLabel(lifecycleKey));
        const statusClass = getProposalLifecycleClass(lifecycleKey);
        const typeLabel = escapeHtml(formatProposalTypeLabel(metrics.typeKey));
        const acceptanceText = metrics.parcelCount > 0
            ? `${metrics.acceptedCount}/${metrics.parcelCount} (${Math.round(metrics.acceptancePercent)}%)`
            : '—';
        const areaText = formatAreaMetric(metrics.area);
        const offerText = formatCurrencyMetric(metrics.offerValue);
        const createdDate = metrics.createdAt ? new Date(metrics.createdAt).toLocaleDateString() : '—';
        const isExecuted = (proposal.status || '').toLowerCase() === 'executed';
        const classes = ['proposal-list-item'];

        if (metrics.isApplied) classes.push('is-applied');
        if (isExecuted) classes.push('is-executed');
        if (proposalHighlightState.activeProposalId === proposalId || proposalListState.selectedId === proposalId) {
            classes.push('is-selected');
        }
        if (currentProposalPreviewId === proposalId) classes.push('is-previewing');

        const classAttr = classes.join(' ');
        const safeTitle = escapeHtml(proposal.title || untitledLabel);
        const safeAuthor = escapeHtml(metrics.author || unknownAuthor);

        // Determine applied status
        const appliedState = typeof isProposalApplied === 'function' ? isProposalApplied(proposal) : metrics.isApplied;
        const appliedLabel = appliedState
            ? t('modal.roadWidth.proposalList.labels.applied', 'Applied')
            : t('modal.roadWidth.proposalList.labels.notApplied', 'Not Applied');
        const appliedClass = appliedState ? 'applied' : 'not-applied';

        // Determine disbursement mode (conditional/partial)
        const disbursementModeRaw = (proposal.disbursementMode || '').toLowerCase();
        const isConditional = proposal.isConditional === true || disbursementModeRaw === 'conditional';
        const disbursementLabel = isConditional
            ? t('modal.roadWidth.proposalList.labels.conditional', 'Conditional')
            : t('modal.roadWidth.proposalList.labels.partial', 'Partial payouts');

        // Determine minted status
        const isMinted = isProposalMinted(proposal);
        const mintedLabel = isMinted
            ? t('panel.proposal.lifecycle.minted', 'Minted')
            : t('panel.proposal.lifecycle.inMemory', 'In-memory');

        return `
            <div class="${classAttr}" data-proposal-id="${proposalId}" style="border-left: 4px solid ${color};">
                <div class="proposal-list-header">
                    <div class="proposal-color-dot" style="background-color: ${color};"></div>
                    <span class="proposal-list-title">${safeTitle}</span>
                    <span class="proposal-type-pill">${typeLabel}</span>
                    ${buildProposalActionButtons(proposal, isExecuted)}
                    <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                    <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${proposalId}')" title="${escapeHtml(deleteTooltip)}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
                <div class="proposal-list-meta">
                    <span><strong>${escapeHtml(metaLabels.author)}</strong> <span class="proposal-meta-value">${safeAuthor}</span></span>
                    <span><strong>${escapeHtml(metaLabels.created)}</strong> <span class="proposal-meta-value">${escapeHtml(createdDate)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.acceptance)}</strong> <span class="proposal-meta-value">${escapeHtml(acceptanceText)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.parcels)}</strong> <span class="proposal-meta-value">${escapeHtml(String(metrics.parcelCount))}</span></span>
                    <span><strong>${escapeHtml(metaLabels.offer)}</strong> <span class="proposal-meta-value">${escapeHtml(offerText)}</span></span>
                </div>
                <div class="proposal-list-badges" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center;">
                    <div class="proposal-application-status ${appliedClass}">${escapeHtml(appliedLabel)}</div>
                    <div class="proposal-conditionality ${isConditional ? 'conditional' : 'partial'}">${escapeHtml(disbursementLabel)}</div>
                    <div class="proposal-mint-state" style="
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 2px 6px;
                        border-radius: 10px;
                        font-size: 11px;
                        font-weight: 500;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        color: ${isMinted ? '#065f46' : '#7a6000'};
                        background: ${isMinted ? '#d1fae5' : '#fff7d6'};
                        border: 1px solid ${isMinted ? '#34d399' : '#ffe08a'};
                    ">
                        ${escapeHtml(mintedLabel)}
                    </div>
                </div>
                ${proposal.description ? `<div class="proposal-list-description">${escapeHtml(proposal.description)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function refreshProposalOwnerAcceptanceUI(proposal, parcelId) {
    if (!proposal) return;

    const parcelStatusHtml = buildParcelAcceptanceStatusHtml(proposal);
    const parcelStatusContainer = document.querySelector('.proposal-acceptance-status:not(.owner)');
    if (parcelStatusContainer) {
        if (parcelStatusHtml) {
            const temp = document.createElement('div');
            temp.innerHTML = parcelStatusHtml.trim();
            parcelStatusContainer.replaceWith(temp.firstElementChild);
        } else {
            parcelStatusContainer.remove();
        }
    } else if (parcelStatusHtml) {
        const ownerStatusContainer = document.querySelector('.proposal-acceptance-status.owner');
        if (ownerStatusContainer && ownerStatusContainer.parentNode) {
            const temp = document.createElement('div');
            temp.innerHTML = parcelStatusHtml.trim();
            ownerStatusContainer.parentNode.insertBefore(temp.firstElementChild, ownerStatusContainer);
        }
    }

    // Update owner acceptance summary
    const summaryHtml = buildOwnerAcceptanceStatusHtml(proposal);
    const summaryContainer = document.querySelector('.proposal-acceptance-status.owner');
    if (summaryContainer) {
        if (summaryHtml) {
            const temp = document.createElement('div');
            temp.innerHTML = summaryHtml.trim();
            summaryContainer.replaceWith(temp.firstElementChild);
        } else {
            summaryContainer.remove();
        }
    } else if (summaryHtml) {
        const reference = document.querySelector('.proposal-acceptance-status');
        if (reference && reference.parentNode) {
            const temp = document.createElement('div');
            temp.innerHTML = summaryHtml.trim();
            reference.parentNode.insertBefore(temp.firstElementChild, reference.nextSibling);
        }
    }

    const parcelIdStr = parcelId != null ? parcelId.toString() : '';
    const parcelItem = document.querySelector(`.proposal-parcel-item[data-parcel-id="${parcelIdStr}"]`);
    if (!parcelItem) {
        return;
    }

    const hasAccepted = Array.isArray(proposal.acceptedParcelIds) &&
        proposal.acceptedParcelIds.includes(parcelIdStr);

    const statusSpan = parcelItem.querySelector('.parcel-status');
    if (statusSpan) {
        statusSpan.textContent = hasAccepted ? '✓ Accepted' : 'Pending';
        statusSpan.classList.toggle('parcel-status-accepted', hasAccepted);
        statusSpan.classList.toggle('parcel-status-pending', !hasAccepted);
        statusSpan.style.color = hasAccepted ? '#28a745' : '#666';
        statusSpan.style.fontWeight = hasAccepted ? '500' : '';
    }

    const acceptanceHtml = buildOwnerAcceptanceSectionHtml(proposal, parcelId, { compact: true, skipParcelPanelFocus: true });
    let acceptanceContainer = parcelItem.querySelector('.parcel-owner-acceptance');

    if (acceptanceHtml) {
        if (!acceptanceContainer) {
            acceptanceContainer = document.createElement('div');
            acceptanceContainer.className = 'parcel-owner-acceptance';
            acceptanceContainer.setAttribute('onclick', 'event.stopPropagation(); event.preventDefault(); return false;');
            parcelItem.appendChild(acceptanceContainer);
        }
        acceptanceContainer.innerHTML = acceptanceHtml;
    } else if (acceptanceContainer) {
        acceptanceContainer.remove();
    }
}

function renderProposalListModal() {
    // If i18n is present but not yet ready, wait for it before rendering to avoid key flicker
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (api && api.ready && typeof api.ready.then === 'function' && !api.__proposalListWaited) {
            api.__proposalListWaited = true;
            return api.ready.then(() => renderProposalListModal()).catch(() => renderProposalListModal());
        }
    } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    // Ensure proposal list translations are loaded from JSON; if newly hydrated, re-render once.
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        const currentLang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
        ensureProposalListTranslations(currentLang).then(hydrated => {
            if (hydrated) {
                // Avoid infinite loop: only re-render on the first hydration per language
                renderProposalListModal();
            }
        });
    } catch (_) { }

    const t = getProposalI18nHelper();

    const modalStrings = {
        title: t('modal.roadWidth.proposalList.title', 'Proposals'),
        closeAria: t('modal.roadWidth.proposalList.closeAria', 'Close proposals list'),
        tabs: {
            active: t('modal.roadWidth.proposalList.tabs.active', 'Active'),
            executed: t('modal.roadWidth.proposalList.tabs.executed', 'Executed')
        },
        filters: {
            type: t('modal.roadWidth.proposalList.filters.type', 'Type'),
            author: t('modal.roadWidth.proposalList.filters.author', 'Author'),
            search: t('modal.roadWidth.proposalList.filters.search', 'Search'),
            sort: t('modal.roadWidth.proposalList.filters.sort', 'Sort by'),
            authorPlaceholder: t('modal.roadWidth.proposalList.filters.authorPlaceholder', 'All authors'),
            searchPlaceholder: t('modal.roadWidth.proposalList.filters.searchPlaceholder', 'Search title or author'),
            reset: t('modal.roadWidth.proposalList.filters.reset', 'Reset'),
            resetTooltip: t('modal.roadWidth.proposalList.filters.resetTooltip', 'Reset filters')
        }
    };

    const typeOptions = getLocalizedProposalTypeFilters();
    const sortOptions = getLocalizedProposalSortOptions();

    const scrollPositions = {
        active: 0,
        executed: 0
    };

    const existingActiveTab = modal.querySelector('#active-proposals-tab');
    if (existingActiveTab) {
        scrollPositions.active = existingActiveTab.scrollTop;
    }

    const existingExecutedTab = modal.querySelector('#executed-proposals-tab');
    if (existingExecutedTab) {
        scrollPositions.executed = existingExecutedTab.scrollTop;
    }

    const allProposals = proposalStorage.getAllProposals();

    // Check and update expiry status for all proposals
    allProposals.forEach(proposal => {
        checkAndUpdateProposalExpiry(proposal);
    });

    const augmented = allProposals.map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));

    const activeDataset = augmented.filter(entry => (entry.proposal.status || '').toLowerCase() !== 'executed');
    const executedDataset = augmented.filter(entry => (entry.proposal.status || '').toLowerCase() === 'executed');

    const filteredActive = applyProposalListFilters(activeDataset);
    const filteredExecuted = applyProposalListFilters(executedDataset);

    const sortedActive = sortProposalDataset(filteredActive);
    const sortedExecuted = sortProposalDataset(filteredExecuted);

    const selectedId = proposalListState.selectedId;
    if (selectedId) {
        const isSelectedVisible = sortedActive.some(entry => getProposalKey(entry.proposal) === selectedId)
            || sortedExecuted.some(entry => getProposalKey(entry.proposal) === selectedId);
        if (!isSelectedVisible) {
            proposalListState.selectedId = null;
        }
    }

    const controlsHtml = `
        <div class="proposal-list-controls">
            <div class="proposal-filter-group">
                <label for="proposal-filter-type" data-i18n-key="modal.roadWidth.proposalList.filters.type">${escapeHtml(modalStrings.filters.type)}</label>
                <select id="proposal-filter-type">
                    ${typeOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.types.${option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-author" data-i18n-key="modal.roadWidth.proposalList.filters.author">${escapeHtml(modalStrings.filters.author)}</label>
                <input type="text" id="proposal-filter-author" placeholder="${escapeHtml(modalStrings.filters.authorPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.authorPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.authorFilter)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-search" data-i18n-key="modal.roadWidth.proposalList.filters.search">${escapeHtml(modalStrings.filters.search)}</label>
                <input type="text" id="proposal-filter-search" placeholder="${escapeHtml(modalStrings.filters.searchPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.searchPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.searchText)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-sort" data-i18n-key="modal.roadWidth.proposalList.filters.sort">${escapeHtml(modalStrings.filters.sort)}</label>
                <select id="proposal-sort">
                    ${sortOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.sortKey ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.sort.${PROPOSAL_SORT_I18N_KEYS[option.value] || option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
        </div>
    `;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2 data-i18n-key="modal.roadWidth.proposalList.title">${escapeHtml(modalStrings.title)}</h2>
                <button type="button" class="proposal-list-modal-close close-circle-btn close-circle-btn--lg" aria-label="${escapeHtml(modalStrings.closeAria)}" data-i18n-key="modal.roadWidth.proposalList.closeAria" data-i18n-attr="aria-label" onclick="closeProposalList()">&times;</button>
            </div>
            ${controlsHtml}
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'active' ? 'active' : ''}" data-tab="active" data-i18n-key="modal.roadWidth.proposalList.tabs.active">
                    ${escapeHtml(modalStrings.tabs.active)} (${filteredActive.length}${filteredActive.length !== activeDataset.length ? `/${activeDataset.length}` : ''})
                </button>
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'executed' ? 'active' : ''}" data-tab="executed" data-i18n-key="modal.roadWidth.proposalList.tabs.executed">
                    ${escapeHtml(modalStrings.tabs.executed)} (${filteredExecuted.length}${filteredExecuted.length !== executedDataset.length ? `/${executedDataset.length}` : ''})
                </button>
            </div>
            <div class="proposal-list-modal-body">
                <div id="active-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'active' ? 'active' : ''}">
                    ${buildProposalListItemsHtml(sortedActive)}
                </div>
                <div id="executed-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'executed' ? 'active' : ''}">
                    ${buildProposalListItemsHtml(sortedExecuted)}
                </div>
            </div>
        </div>
    `;

    // Run DOM-based translations to mirror agent modal behavior
    try {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
            window.i18n.applyTranslations(modal);
        }
    } catch (_) { }

    // Fix any nodes that still show raw keys by falling back to the strings we already resolved
    try {
        const fallbackMap = new Map();
        fallbackMap.set('modal.roadWidth.proposalList.title', modalStrings.title);
        fallbackMap.set('modal.roadWidth.proposalList.closeAria', modalStrings.closeAria);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.active', modalStrings.tabs.active);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.executed', modalStrings.tabs.executed);
        fallbackMap.set('modal.roadWidth.proposalList.filters.type', modalStrings.filters.type);
        fallbackMap.set('modal.roadWidth.proposalList.filters.author', modalStrings.filters.author);
        fallbackMap.set('modal.roadWidth.proposalList.filters.search', modalStrings.filters.search);
        fallbackMap.set('modal.roadWidth.proposalList.filters.sort', modalStrings.filters.sort);
        fallbackMap.set('modal.roadWidth.proposalList.filters.authorPlaceholder', modalStrings.filters.authorPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.filters.searchPlaceholder', modalStrings.filters.searchPlaceholder);
        // Type options
        typeOptions.forEach(option => {
            const key = `modal.roadWidth.proposalList.filters.types.${option.value}`;
            fallbackMap.set(key, option.label);
        });
        // Sort options
        sortOptions.forEach(option => {
            const mapKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
            const key = `modal.roadWidth.proposalList.sort.${mapKey}`;
            fallbackMap.set(key, option.label);
        });

        const nodes = modal.querySelectorAll('[data-i18n-key]');
        nodes.forEach(node => {
            const key = node.getAttribute('data-i18n-key') || '';
            if (!key) return;
            const currentText = node.textContent ? node.textContent.trim() : '';
            if (currentText === key && fallbackMap.has(key)) {
                node.textContent = fallbackMap.get(key);
            }
            const attrList = (node.getAttribute('data-i18n-attr') || '').split(',').map(s => s.trim()).filter(Boolean);
            attrList.forEach(attr => {
                if (node.getAttribute && node.getAttribute(attr) === key && fallbackMap.has(key)) {
                    node.setAttribute(attr, fallbackMap.get(key));
                }
            });
        });
    } catch (_) { }

    const typeSelect = modal.querySelector('#proposal-filter-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', event => {
            proposalListState.filterType = event.target.value;
            renderProposalListModal();
        });
    }

    const authorInput = modal.querySelector('#proposal-filter-author');
    if (authorInput) {
        authorInput.addEventListener('input', event => {
            proposalListState.authorFilter = event.target.value;
            renderProposalListModal();
        });
    }

    const searchInput = modal.querySelector('#proposal-filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            proposalListState.searchText = event.target.value;
            renderProposalListModal();
        });
    }

    const sortSelect = modal.querySelector('#proposal-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', event => {
            proposalListState.sortKey = event.target.value;
            renderProposalListModal();
        });
    }

    modal.querySelectorAll('.proposal-tab-btn').forEach(button => {
        button.addEventListener('click', event => {
            const tab = event.currentTarget.getAttribute('data-tab');
            if (tab && proposalListState.activeTab !== tab) {
                proposalListState.activeTab = tab;
                renderProposalListModal();
            }
        });
    });

    modal.querySelectorAll('.proposal-list-item').forEach(item => {
        item.addEventListener('click', handleProposalListItemClick);
    });

    const activeTabEl = modal.querySelector('#active-proposals-tab');
    if (activeTabEl) {
        activeTabEl.scrollTop = scrollPositions.active;
    }

    const executedTabEl = modal.querySelector('#executed-proposals-tab');
    if (executedTabEl) {
        executedTabEl.scrollTop = scrollPositions.executed;
    }

    if (proposalListState.selectedId) {
        const selectedEl = modal.querySelector(`.proposal-list-item[data-proposal-id="${proposalListState.selectedId}"]`);
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}

function resetParcelSelectionForProposalListInteraction() {
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            if (typeof multiParcelSelection.clearSingleParcelSelection === 'function') {
                multiParcelSelection.clearSingleParcelSelection();
            }
        }
    } catch (_) { }

    try {
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        } else {
            const panel = document.getElementById('parcel-info-panel');
            if (panel) {
                panel.classList.remove('visible');
            }
        }
    } catch (_) { }

    try {
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
    } catch (_) { }
}

function handleProposalListItemClick(event) {
    const item = event.currentTarget;
    if (!item) return;

    const proposalIdAttr = item.getAttribute('data-proposal-id');
    if (!proposalIdAttr) return;

    const proposal = getProposalByIdOrHash(proposalIdAttr);
    if (!proposal) {
        updateStatus('Proposal not found');
        return;
    }

    const resolvedId = getProposalKey(proposal) || proposalIdAttr;
    proposalListState.selectedId = resolvedId;

    resetParcelSelectionForProposalListInteraction();
    openProposalFromList(resolvedId, {
        proposal,
        closeProposalList: true,
        closeParcelInfo: true,
        closeAgentDialog: false,
        collapseSidebar: true
    });
}

function showProposalDetailsModal(proposalId, options = {}) {
    if (!proposalId) return;
    openProposalFromList(proposalId, options);
}

// Show proposal list dialog
function showAllProposalsModal() {
    resetParcelSelectionForProposalListInteraction();
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    modal.style.display = 'block';
    renderProposalListModal();
}

// Switch between proposal tabs (legacy helper retained for backwards compatibility)
function switchProposalTab(clickedTabOrName, maybeTabName) {
    const tabName = typeof maybeTabName === 'string'
        ? maybeTabName
        : (typeof clickedTabOrName === 'string' ? clickedTabOrName : null);

    if (!tabName) return;

    if (proposalListState.activeTab !== tabName) {
        proposalListState.activeTab = tabName;
        renderProposalListModal();
    }
}

// Close proposal list dialog
function closeProposalList(options = {}) {
    const normalized = options && typeof options === 'object' ? options : {};
    const clearHighlights = normalized.clearHighlights !== false;
    const modal = document.querySelector('.proposal-list-modal');
    if (modal) {
        modal.style.display = 'none';
        // When the Proposal List closes, clear any proposal-specific overlays/highlights
        try { clearProposalInfoHoverOverlay(); } catch (_) { }
        if (clearHighlights) {
            try { clearProposalHighlights(); } catch (_) { }
        }
        proposalListState.selectedId = null;
    }
}

// Update proposal list (if open)
function updateProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal && modal.style.display === 'block') {
        showAllProposalsModal();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Update the "Proposals List" button text with current count
function updateShowProposalsButton() {
    const button = document.getElementById('showProposalsButton');
    if (button) {
        const totalProposals = proposalStorage.getAllProposals().length;
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        button.setAttribute('data-i18n-key', 'sidebar.proposals.listButton');
        button.setAttribute('data-i18n-params', JSON.stringify({ count: totalProposals }));
        if (i18nApi && typeof i18nApi.t === 'function') {
            button.textContent = i18nApi.t('sidebar.proposals.listButton', { count: totalProposals });
        } else {
            button.textContent = `Proposals List (${totalProposals})`;
        }
    }

    const sharePlanButton = document.getElementById('shareAppliedProposalsButton');
    if (sharePlanButton) {
        const appliedCount = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied).length;
        sharePlanButton.disabled = appliedCount === 0;
    }

    // Also sync the proposals presence indicator
    if (typeof syncProposalsIndicator === 'function') {
        syncProposalsIndicator();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Proposals section no longer has a checkbox - this function is kept for compatibility
// but does nothing since proposals are always shown
function syncProposalsIndicator() {
    // Proposals are always shown now, no checkbox to sync
    // Reset any previously set opacity on the Proposals header to keep it consistent
    const sections = document.querySelectorAll('.accordion-section[data-section="proposals"]');
    sections.forEach(section => {
        const header = section.querySelector('.accordion-header');
        if (header) {
            header.style.opacity = ''; // Clear inline opacity
        }
    });
}

function getExplorerBaseUrlForChain(chainId) {
    const id = chainId ? chainId.toString() : '';
    switch (id) {
        case '1':
            return 'https://etherscan.io';
        case '11155111':
            return 'https://sepolia.etherscan.io';
        case '8453':
            return 'https://basescan.org';
        case '84532':
        case '0x14a34':
            return 'https://sepolia.basescan.org';
        default:
            return null; // No explorer known (e.g., hardhat)
    }
}

function showProposalMintSuccessModal({ proposalId, txHash, chainId, onClose }) {
    try {
        const existing = document.getElementById('proposal-mint-success-modal');
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        const overlay = document.createElement('div');
        overlay.id = 'proposal-mint-success-modal';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '12000';

        const card = document.createElement('div');
        card.style.background = '#fff';
        card.style.borderRadius = '12px';
        card.style.padding = '20px 24px';
        card.style.maxWidth = '340px';
        card.style.width = '90%';
        card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
        card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        const title = document.createElement('h3');
        title.textContent = 'Success!';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '20px';
        title.style.fontWeight = '700';
        card.appendChild(title);

        const body = document.createElement('p');
        const label = proposalId ? `Proposal ${proposalId}` : 'Proposal';
        body.textContent = `${label} has been minted!`;
        body.style.margin = '0 0 12px 0';
        body.style.fontSize = '14px';
        card.appendChild(body);

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.flexDirection = 'column';
        buttons.style.gap = '10px';
        buttons.style.marginTop = '12px';

        const explorerBase = getExplorerBaseUrlForChain(chainId);
        const hasExplorer = explorerBase && txHash;
        const viewBtn = document.createElement('button');
        viewBtn.textContent = hasExplorer ? 'View on Etherscan' : 'View transaction';
        viewBtn.style.padding = '10px 12px';
        viewBtn.style.border = '1px solid #0d3b66';
        viewBtn.style.borderRadius = '8px';
        viewBtn.style.background = hasExplorer ? '#0d3b66' : '#cbd5e0';
        viewBtn.style.color = '#fff';
        viewBtn.style.cursor = hasExplorer ? 'pointer' : 'not-allowed';
        viewBtn.disabled = !hasExplorer;
        viewBtn.style.width = '100%';
        if (hasExplorer) {
            viewBtn.addEventListener('click', () => {
                const url = `${explorerBase}/tx/${txHash}`;
                window.open(url, '_blank', 'noopener,noreferrer');
            });
        }

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '10px 12px';
        okBtn.style.border = 'none';
        okBtn.style.borderRadius = '8px';
        okBtn.style.background = '#0d3b66';
        okBtn.style.color = '#fff';
        okBtn.style.cursor = 'pointer';
        okBtn.style.width = '100%';
        okBtn.addEventListener('click', () => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (_) { }
            } else if (proposalId && typeof showProposalDetailsModal === 'function') {
                try {
                    showProposalDetailsModal(proposalId);
                } catch (_) { }
            }
        });

        buttons.appendChild(viewBtn);
        buttons.appendChild(okBtn);
        card.appendChild(buttons);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    } catch (err) {
        console.warn('Failed to show proposal mint success modal:', err);
    }
}

function buildProposalNftExplorerUrl(proposal) {
    const info = getProposalNftInfo(proposal);
    if (!info) return null;
    const base = getExplorerBaseUrlForChain(info.chain);
    if (!base || !info.contract || !info.tokenId) return null;
    return `${base}/token/${encodeURIComponent(info.contract)}?a=${encodeURIComponent(info.tokenId)}`;
}

function showMintedShareModal(proposal, mintedExplorerUrl) {
    const tShare = getShareI18nHelper();
    const tProposal = getProposalI18nHelper();
    const explorerUrl = mintedExplorerUrl || buildProposalNftExplorerUrl(proposal);
    const fallbackText = explorerUrl || tShare('noExplorer', 'Explorer link not available for this chain.');

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '12px';

    const infoText = document.createElement('p');
    infoText.textContent = tProposal('panel.proposal.lifecycle.minted', 'Minted');
    infoText.style.margin = '0';
    body.appendChild(infoText);

    const linkRow = document.createElement('div');
    linkRow.style.display = 'flex';
    linkRow.style.gap = '8px';
    linkRow.style.alignItems = 'center';

    const linkDisplay = document.createElement('input');
    linkDisplay.type = 'text';
    linkDisplay.readOnly = true;
    linkDisplay.value = fallbackText;
    linkDisplay.style.flex = '1';
    linkDisplay.style.padding = '8px 10px';
    linkDisplay.style.border = '1px solid #d8ddf0';
    linkDisplay.style.borderRadius = '8px';
    linkDisplay.style.fontSize = '13px';
    linkDisplay.style.background = '#f7f8fb';
    linkDisplay.style.color = '#212744';
    linkRow.appendChild(linkDisplay);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-modal-secondary';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.style.whiteSpace = 'nowrap';
    copyButton.addEventListener('click', async () => {
        const value = linkDisplay.value;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                linkDisplay.focus();
                linkDisplay.select();
                document.execCommand('copy');
            }
            copyButton.textContent = tShare('copySuccess', 'Copied!');
            setTimeout(() => {
                copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
            }, 1200);
        } catch (err) {
            console.warn('Copy failed', err);
            linkDisplay.focus();
            linkDisplay.select();
        }
    });
    linkRow.appendChild(copyButton);

    if (explorerUrl) {
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'btn share-modal-primary';
        openButton.textContent = tShare('viewOnExplorer', 'View on Etherscan');
        openButton.style.whiteSpace = 'nowrap';
        openButton.addEventListener('click', () => {
            window.open(explorerUrl, '_blank', 'noopener,noreferrer');
        });
        linkRow.appendChild(openButton);
    }

    body.appendChild(linkRow);

    showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body
    });
}

// Determine if proposal-specific UI is active (Proposal List open or Parcel Details showing a proposal)
function isProposalUIActive() {
    try {
        const list = document.querySelector('.proposal-list-modal');
        const listOpen = !!(list && list.style && list.style.display === 'block');
        if (listOpen) return true;
        const detailsPanel = document.getElementById('proposal-details-panel');
        if (detailsPanel && detailsPanel.classList.contains('visible')) {
            return true;
        }
        const panel = document.getElementById('parcel-info-panel');
        if (panel && panel.classList.contains('visible')) {
            const titleEl = panel.querySelector('h3');
            const title = titleEl ? titleEl.textContent : '';
            if (title && title.trim() === 'Proposal Details') return true;
        }
    } catch (_) { }
    return false;
}

// Expose helper
window.isProposalUIActive = isProposalUIActive;

// Delete a single proposal
function deleteProposal(proposalId) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            updateStatus('Error: Proposal not found');
            return;
        }

        const goalKey = resolveProposalGoalKey(proposal, null);
        const managedByProposalManager = (
            goalKey === 'road-track'
            || goalKey === 'buildings'
            || goalKey === 'single'
            || goalKey === 'row'
            || goalKey === 'parcelBased'
            || goalKey === 'park'
            || goalKey === 'square'
            || goalKey === 'lake'
            || goalKey === 'reparcellization'
            || goalKey === 'decide-later'
            || !!proposal.roadProposal
            || !!proposal.buildingProposal
            || !!proposal.structureProposal
            || !!proposal.reparcellization
            || !!proposal.decideLaterProposal
        );
        if (managedByProposalManager && typeof ProposalManager !== 'undefined' && ProposalManager.deleteProposal) {
            ProposalManager.deleteProposal(proposalId);
            return;
        }

        // Remove the proposal from storage
        proposalStorage.removeProposal(proposalId);

        // Clear any proposal highlights if this was the currently highlighted proposal
        if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalId === proposalId) {
            clearProposalHighlights();
        }

        // Update the proposal layer to remove visual representation
        updateProposalLayer();

        // Update the proposal list if it's open
        updateProposalList();

        // Update the show proposals button count
        updateShowProposalsButton();

        // Hide proposal info panel if it's showing the deleted proposal
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                hideParcelInfoPanel();
            }
        }

        updateStatus(`Proposal "${proposal.title}" deleted`);

    } catch (error) {
        console.error('Error deleting proposal:', error);
        updateStatus('Error deleting proposal. Please try again.');
    }
}

// Center map on proposal (unified function)
function centerOnProposal(proposalIdOrHash) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) return;

    // Use the first parcel as the selected parcel for highlighting
    const firstParcelId = proposal.parentParcelIds[0];
    if (!firstParcelId) return;

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, firstParcelId, true);
}

// Clear all proposals from PersistentStorage
function clearLocalProposalData() {
    try {
        // Get count of proposals before clearing
        const proposalCount = proposalStorage.getAllProposals().length;

        // Clear all proposals from storage
        proposalStorage.clear();

        // Clear any proposal highlights
        clearProposalHighlights();

        // Hide and clear the proposal layer
        if (proposalLayer) {
            map.removeLayer(proposalLayer);
            proposalLayer = null;
        }

        // Uncheck the show proposals checkbox
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox) {
            showProposalsCheckbox.checked = false;
        }

        // Hide any open proposal info panel
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                } else {
                    // Fallback manual hiding
                    parcelInfoPanel.classList.remove('visible');
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';
                }
            }
        }

        // Close proposal list modal if open
        closeProposalList();

        // Update status
        updateStatus(`Cleared ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} from local storage`);

        // Update the show proposals button count
        updateShowProposalsButton();

    } catch (error) {
        console.error('Error clearing proposal data:', error);
        updateStatus('Error clearing proposal data. Please try again.');
    }
}

function initialiseProposalStorage() {
    proposalStorage.load();
    // Update the button count after loading proposals
    if (typeof updateShowProposalsButton === 'function') {
        updateShowProposalsButton();
    }
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseProposalStorage);
} else {
    initialiseProposalStorage();
}

// Re-render proposal list when language or translations load so modal text updates live
function rerenderProposalListIfOpen() {
    try {
        const modal = document.querySelector('.proposal-list-modal');
        if (modal && modal.style.display === 'block' && typeof renderProposalListModal === 'function') {
            renderProposalListModal();
        }
    } catch (_) { }
}

try {
    if (typeof window !== 'undefined') {
        if (window.i18n && typeof window.i18n.onChange === 'function') {
            window.i18n.onChange(rerenderProposalListIfOpen);
        }
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('i18n:translationsLoaded', rerenderProposalListIfOpen);
        }
    }
} catch (_) { }

/**
 * Handle multi-select checkbox change with mutual exclusivity
 */
function handleMultiSelectChange(checked, source) {
    const desiredState = typeof checked === 'boolean'
        ? checked
        : !!(document.getElementById('multiSelectCheckbox') && document.getElementById('multiSelectCheckbox').checked);

    syncMultiSelectCheckboxes(desiredState);

    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (desiredState && showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        updateProposalLayer();
    }

    if (!!multiParcelSelection.isActive !== desiredState) {
        if (desiredState) {
            const preserveSelected = source === 'tools' || source === 'info';
            multiParcelSelection.toggle({ preserveSelectedParcel: preserveSelected });
        } else {
            multiParcelSelection.toggle();
        }
    }
}

/**
 * Handle show proposals checkbox change with mutual exclusivity
 */
function handleShowProposalsChange() {
    // No-op: proposal mode removed
}

/**
 * Helper function to enable show proposals mode and clear multi-selection
 * This ensures consistent behavior across all places that enable show proposals
 */
function enableShowProposalsMode() {
    // No-op retained for backward compatibility
}

// Sharing via query params is limited by nginx's default 8 KB request line limit.
// Keep shareable links comfortably under that threshold to avoid HTTP 414 errors.
const SHARE_URL_MAX_LENGTH = 7500;
const SHARE_PAYLOAD_VERSION = 1;
const SHARE_ENCODING_PREFIX_COMPRESSED = 'z.';
const SHARE_ENCODING_PREFIX_RAW = 'u.';
const SHARE_BASE64_ALLOWED = /^[A-Za-z0-9_-]+$/;

function findParcelLayerById(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : parcelId;
    if (!normalized) return null;
    try {
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
            const found = multiParcelSelection.findParcelById(normalized);
            if (found) return found;
        }
    } catch (_) { }
    try {
        const layerGroup = window.parcelLayer;
        if (layerGroup && typeof layerGroup.eachLayer === 'function') {
            let match = null;
            layerGroup.eachLayer(layer => {
                if (match || !layer || !layer.feature || !layer.feature.properties) return;
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layerId && layerId.toString() === normalized) {
                    match = layer;
                }
            });
            if (match) return match;
        }
    } catch (error) {
        console.warn('findParcelLayerById failed', error);
    }
    return null;
}

function base64UrlEncodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return '';
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input) {
    let working = input || '';
    working = working.replace(/-/g, '+').replace(/_/g, '/');
    while (working.length % 4 !== 0) {
        working += '=';
    }
    const binary = atob(working);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function compressBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        return { bytes, compressed: false };
    }
    if (typeof pako === 'undefined' || typeof pako.deflate !== 'function') {
        return { bytes, compressed: false };
    }
    try {
        const compressedBytes = pako.deflate(bytes, { level: 9 });
        return { bytes: compressedBytes, compressed: true };
    } catch (error) {
        console.warn('pako.deflate failed, falling back to raw payload', error);
        return { bytes, compressed: false };
    }
}

function inflateBytes(bytes, { strict = false } = {}) {
    if (typeof pako === 'undefined' || typeof pako.inflate !== 'function') {
        if (strict) {
            throw new Error('Compressed share links require compression support.');
        }
        return null;
    }
    try {
        return pako.inflate(bytes);
    } catch (error) {
        if (strict) {
            throw error;
        }
        console.warn('pako.inflate failed, falling back to raw payload', error);
        return null;
    }
}

function decodeBytesToJson(bytes) {
    if (typeof TextDecoder !== 'undefined') {
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(binary));
}

function computeBoundsFromGeoJSONFeatures(features) {
    if (typeof L === 'undefined' || !Array.isArray(features) || features.length === 0) {
        return null;
    }
    let combined = null;
    features.forEach(feature => {
        if (!feature) return;
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    combined = combined ? combined.extend(bounds) : bounds;
                }
            }
        } catch (error) {
            console.warn('computeBoundsFromGeoJSONFeatures skipped feature', error);
        }
    });
    return combined;
}

function buildLeafletBoundsFromArray(bboxArray) {
    if (!Array.isArray(bboxArray) || bboxArray.length !== 4 || typeof L === 'undefined') {
        return null;
    }
    const [minX, minY, maxX, maxY] = bboxArray.map(Number);
    if (![minX, minY, maxX, maxY].every(v => Number.isFinite(v))) {
        return null;
    }
    try {
        return L.latLngBounds([minY, minX], [maxY, maxX]);
    } catch (error) {
        console.warn('buildLeafletBoundsFromArray failed', error, bboxArray);
        return null;
    }
}

function focusMapOnSharedProposal(proposal, payload) {
    if (!proposal || typeof map === 'undefined' || !map) {
        return false;
    }

    const restoreSuppression = (() => {
        const wasSuppressed = isCameraMovementSuppressed();
        if (wasSuppressed) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
        return () => {
            if (wasSuppressed) {
                try { window.suppressCameraMoves = true; } catch (_) { }
            }
        };
    })();

    const applyBounds = (bounds, padding = [120, 120]) => {
        if (!bounds || !bounds.isValid()) return false;
        try {
            map.fitBounds(bounds, { padding, maxZoom: 16 });
            return true;
        } catch (error) {
            console.warn('focusMapOnSharedProposal fitBounds failed', error);
            return false;
        }
    };

    try {
        if (payload && payload.camera && Number.isFinite(payload.camera.lat) && Number.isFinite(payload.camera.lng)) {
            const zoom = Number.isFinite(payload.camera.zoom) ? payload.camera.zoom : map.getZoom();
            map.setView([payload.camera.lat, payload.camera.lng], zoom);
            return true;
        }

        // Prefer explicit bounds from payload/proposal (already in WGS84)
        const candidateBounds = buildLeafletBoundsFromArray(payload && payload.bbox ? payload.bbox : null)
            || buildLeafletBoundsFromArray(proposal.bounds)
            || buildLeafletBoundsFromArray(proposal.roadProposal && proposal.roadProposal.bounds);
        if (candidateBounds && applyBounds(candidateBounds, [100, 100])) {
            return true;
        }

        const geometryFeatures = [];
        if (proposal.roadProposal) {
            const childIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature && feature.geometry) {
                    geometryFeatures.push(feature);
                }
            });
        }
        if (proposal.buildingProposal && proposal.buildingProposal.buildingFeature) {
            geometryFeatures.push(proposal.buildingProposal.buildingFeature);
        }
        if (proposal.structureProposal && proposal.structureProposal.geometry) {
            geometryFeatures.push({ type: 'Feature', geometry: proposal.structureProposal.geometry });
        }
        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons)) {
            proposal.reparcellization.polygons.forEach(polygon => {
                if (polygon && polygon.geometry) {
                    geometryFeatures.push({ type: 'Feature', geometry: polygon.geometry });
                }
            });
        }

        if (geometryFeatures.length) {
            const geoBounds = computeBoundsFromGeoJSONFeatures(geometryFeatures);
            if (applyBounds(geoBounds)) {
                return true;
            }
        }

        const parcelLayers = ensureArrayOfStrings(proposal.parentParcelIds)
            .map(id => findParcelLayerById(id))
            .filter(layer => layer && typeof layer.getBounds === 'function');
        if (parcelLayers.length) {
            let bounds = null;
            parcelLayers.forEach(layer => {
                const layerBounds = layer.getBounds();
                if (layerBounds && layerBounds.isValid()) {
                    bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
                }
            });
            if (applyBounds(bounds)) {
                return true;
            }
        }

        if (payload && payload.bbox) {
            const sharedBounds = buildBoundsFromSharedPayload(payload);
            if (applyBounds(sharedBounds, [120, 120])) {
                return true;
            }
        }
    } finally {
        restoreSuppression();
    }

    return false;
}

function getShareI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.share';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function getSharedInspectorI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.sharedInspector';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function collectProposalParentParcelIdsForShare(proposal) {
    const ids = new Set();
    const normalize = (value) => {
        if (value === undefined || value === null) return null;
        const str = value && value.toString ? value.toString() : String(value);
        return str.trim() || null;
    };
    const addValue = (value) => {
        const normalized = normalize(value);
        if (normalized) ids.add(normalized);
    };
    const addMany = (list) => {
        if (!list) return;
        (Array.isArray(list) ? list : [list]).forEach(addValue);
    };

    if (!proposal) return [];

    addMany(proposal.parentParcelIds);

    if (proposal.roadProposal) {
        addMany(proposal.roadProposal.parentParcelIds);
    }

    if (proposal.buildingProposal) {
        addMany(proposal.buildingProposal.parentParcelIds);
    }

    if (proposal.structureProposal) {
        addMany(proposal.structureProposal.parentParcelIds);
    }

    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parcelIds)) {
        addMany(proposal.reparcellization.parcelIds);
    }

    if (ids.size === 0) {
        addMany(proposal.parentParcelIds);
    }

    return Array.from(ids);
}

function checkParcelsOriginal(parcelList) {
    const nonOriginal = [];
    const seen = new Set();
    if (!parcelList) return nonOriginal;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            nonOriginal.push(normalized);
        }
    });

    return nonOriginal;
}

function collectParcelProposalPairs(parcelList) {
    const pairs = [];
    const seen = new Set();
    if (!parcelList) return pairs;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            // Get the first ancestor proposal ID (or all if multiple)
            ancestors.forEach(ancestorProposalId => {
                pairs.push({
                    parcelId: normalized,
                    proposalId: ancestorProposalId
                });
            });
        }
    });

    return pairs;
}

function showNonOriginalParcelShareBlockedModal(proposal, parcelList) {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    const pairs = collectParcelProposalPairs(parcelList);

    const container = document.createElement('div');
    const message = document.createElement('p');
    message.setAttribute('data-i18n-key', 'modal.roadWidth.share.ancestorNote');
    message.textContent = tShare('ancestorNote', 'Note: this proposal includes parcels created by other proposals. For it to be applied on a target map the ancestor proposals will have to be applied first. Instead of sharing this one proposal you might want to share the entire plan using "Share entire plan" button in the Proposals section of the sidebar. The parcel list:');
    container.appendChild(message);

    const listWrapper = document.createElement('div');
    listWrapper.style.maxHeight = '240px';
    listWrapper.style.overflowY = 'auto';
    listWrapper.style.border = '1px solid #d8ddf0';
    listWrapper.style.borderRadius = '8px';
    listWrapper.style.padding = '8px';
    listWrapper.style.background = '#f9fafb';

    // Create table with two columns
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.margin = '0';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.borderBottom = '1px solid #d8ddf0';

    const headerParcel = document.createElement('th');
    headerParcel.setAttribute('data-i18n-key', 'modal.roadWidth.share.parcelIdHeader');
    headerParcel.textContent = tShare('parcelIdHeader', 'Parcel ID');
    headerParcel.style.padding = '6px 8px';
    headerParcel.style.textAlign = 'left';
    headerParcel.style.fontWeight = '600';
    headerRow.appendChild(headerParcel);

    const headerProposal = document.createElement('th');
    headerProposal.setAttribute('data-i18n-key', 'modal.roadWidth.share.proposalIdHeader');
    headerProposal.textContent = tShare('proposalIdHeader', 'Proposal ID');
    headerProposal.style.padding = '6px 8px';
    headerProposal.style.textAlign = 'left';
    headerProposal.style.fontWeight = '600';
    headerRow.appendChild(headerProposal);

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    pairs.forEach(pair => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid #f0f0f0';

        const cellParcel = document.createElement('td');
        cellParcel.textContent = pair.parcelId;
        cellParcel.style.padding = '6px 8px';
        row.appendChild(cellParcel);

        const cellProposal = document.createElement('td');
        cellProposal.textContent = pair.proposalId || '?';
        cellProposal.style.padding = '6px 8px';
        row.appendChild(cellProposal);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    listWrapper.appendChild(table);
    container.appendChild(listWrapper);

    // Apply translations
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        window.i18n.applyTranslations(container);
    }

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: container,
        actions: [
            {
                label: tShare('ancestorUploadButton', 'Upload'),
                primary: true,
                onClick: () => {
                    if (proposal) {
                        showUploadProposalModal(proposal);
                    }
                }
            }
        ]
    });
}

if (typeof window !== 'undefined') {
    window.checkParcelsOriginal = checkParcelsOriginal;
}

function getServerProposalId(proposal) {
    if (!proposal) return null;
    const candidates = [proposal.serverProposalId, proposal.proposalId, proposal.id];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const id = String(candidate);
        // Local proposals are not shareable via server links.
        // Example: local-0, local-1
        if (/^local-\d+$/i.test(id)) return null;
        return id;
    }
    return null;
}

/**
 * Get the serial ID (numeric database ID) for a proposal, if available.
 * Returns null if only a hash is available (hashes should not be used in share links).
 */
function getSerialProposalId(proposal) {
    if (!proposal) return null;
    // Prefer serverProposalId if it's numeric (serial ID)
    if (proposal.serverProposalId) {
        const id = String(proposal.serverProposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if proposalId is numeric
    if (proposal.proposalId) {
        const id = String(proposal.proposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if id is numeric
    if (proposal.id) {
        const id = String(proposal.id);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    return null;
}

function sortProposalIdsForShare(ids) {
    return ids.slice().sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const aNum = Number.isFinite(na);
        const bNum = Number.isFinite(nb);
        if (aNum && bNum) return na - nb;
        if (aNum && !bNum) return -1;
        if (!aNum && bNum) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
}

function shareAppliedProposals() {
    showSharePlanModal();
}

function showSharePlanModal() {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (typeof proposalStorage === 'undefined') return;
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        if (applied.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.no_applied_proposals_to_share_yet', 'No applied proposals to share yet.'));
            }
            return;
        }

        const proposalsByHash = new Map();
        applied.forEach(proposal => {
            const key = proposal.proposalId || getProposalKey(proposal);
            if (!key) return;
            proposalsByHash.set(String(key), proposal);
        });
        if (proposalsByHash.size === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposals_for_sharing', 'Unable to prepare proposals for sharing.'), 5000, 'error');
            }
            return;
        }

        const selected = new Set(proposalsByHash.keys());
        const uploadState = new Map(); // key -> { uploaded, uploading, serverId }
        const rowControls = new Map();

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        const totalInPlan = proposalsByHash.size;
        const countLine = document.createElement('div');
        countLine.style.fontSize = '13px';
        countLine.style.color = '#475569';
        countLine.textContent = tShare('plan.countHeading', 'There are {{count}} proposal{{suffix}} in the current plan', {
            count: totalInPlan,
            suffix: totalInPlan === 1 ? '' : 's'
        });
        container.appendChild(countLine);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '320px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.border = '1px solid #d8ddf0';
        listWrap.style.borderRadius = '8px';
        listWrap.style.padding = '8px';
        listWrap.style.background = '#f9fafb';
        container.appendChild(listWrap);

        const shareArea = document.createElement('div');
        shareArea.style.display = 'flex';
        shareArea.style.flexDirection = 'column';
        shareArea.style.gap = '8px';
        shareArea.style.marginTop = '4px';

        const linkRow = document.createElement('div');
        linkRow.style.display = 'flex';
        linkRow.style.alignItems = 'center';
        linkRow.style.gap = '8px';

        const linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.readOnly = true;
        linkInput.className = 'share-modal-link';
        linkInput.style.flex = '1';
        linkInput.style.padding = '0.5rem 0.75rem';
        linkInput.style.border = '1px solid #d8ddf0';
        linkInput.style.borderRadius = '8px';
        linkInput.style.background = '#f7f8fb';
        linkInput.style.fontSize = '13px';
        linkInput.style.color = '#212744';
        linkInput.style.boxSizing = 'border-box';
        linkInput.style.height = 'auto';
        linkInput.style.minHeight = '38px';
        linkRow.appendChild(linkInput);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn share-modal-secondary';
        copyBtn.textContent = tShare('copyUrlButton', 'Copy URL');
        copyBtn.addEventListener('click', () => {
            if (!linkInput.value) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(linkInput.value).then(() => {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                    }
                }).catch(() => {
                    linkInput.focus();
                    linkInput.select();
                });
            } else {
                linkInput.focus();
                linkInput.select();
            }
        });
        linkRow.appendChild(copyBtn);

        shareArea.appendChild(linkRow);
        container.appendChild(shareArea);

        const setStatus = (message) => {
            statusLine.textContent = message || '';
        };

        const getDescendantsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findDescendantTree !== 'function') return [];
            const nodes = ProposalManager.findDescendantTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
        };

        const getAncestorsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function') return [];
            const nodes = ProposalManager.findAncestorTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
        };

        const updateShareUrl = () => {
            const hasSelection = selected.size > 0;
            if (!hasSelection) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.selectHint', 'Select at least one proposal to share.'));
                return;
            }

            const selectedKeys = Array.from(selected);
            const selectedProposals = selectedKeys.map(key => proposalsByHash.get(key)).filter(Boolean);

            const selectedStates = selectedKeys
                .map(key => uploadState.get(key))
                .filter(Boolean);

            const anyUploading = selectedStates.some(s => !!s.uploading);
            if (anyUploading) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.checkingHint', 'Checking upload status…'));
                return;
            }

            const uploadedIds = selectedKeys
                .map(key => uploadState.get(key))
                .filter(state => state && state.uploaded && state.serverId)
                .map(state => state.serverId)
                .filter(id => {
                    // Only include numeric serial IDs, never hashes
                    return id && /^\d+$/.test(String(id));
                });

            if (uploadedIds.length !== selectedKeys.length) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                const anyUploaded = uploadedIds.length > 0;
                setStatus(anyUploaded
                    ? tShare('plan.uploadHint', 'Upload all selected proposals to enable sharing, or deselect some.')
                    : tShare('plan.noUploadedHint', 'Upload at least one proposal to enable sharing.')
                );
                return;
            }

            const sortedIds = sortProposalIdsForShare(uploadedIds);
            const cityParam = buildCityQueryParam();
            const queryJoiner = cityParam ? '&' : '?';
            const shareUrl = `${resolveFrontendBaseUrl()}/proposals/${sortedIds.join(',')}${cityParam}${queryJoiner}3d`;
            linkInput.value = shareUrl;
            linkRow.style.display = 'flex';
            setStatus('');
        };

        const updateRowState = (key) => {
            const controls = rowControls.get(key);
            const state = uploadState.get(key) || { uploaded: false, uploading: false };
            if (!controls) return;
            if (state.uploaded) {
                controls.uploadBtn.style.display = 'none';
                controls.uploadedLabel.style.display = 'inline-flex';
                controls.uploadedLabel.textContent = tShare('plan.uploaded', 'Uploaded');
            } else {
                controls.uploadedLabel.style.display = 'none';
                controls.uploadBtn.style.display = 'inline-flex';
                controls.uploadBtn.disabled = state.uploading;
                controls.uploadBtn.textContent = state.uploading
                    ? tShare('plan.uploading', 'Uploading…')
                    : tShare('plan.upload', 'Upload');
            }
            controls.checkbox.checked = selected.has(key);
        };

        const toggleCheckbox = (key, checked) => {
            const controls = rowControls.get(key);
            if (controls) {
                controls.checkbox.checked = checked;
            }
        };

        const onCheckboxChange = (key, checked) => {
            if (checked) {
                const ancestors = getAncestorsInPlan(key);
                const added = [];
                selected.add(key);
                ancestors.forEach(hash => {
                    if (!selected.has(hash)) added.push(hash);
                    selected.add(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, true));
                if (added.length > 0) {
                    const summary = added.slice(0, 5).join(', ');
                    setStatus(tShare('plan.addedAncestors', 'Also added {{count}} ancestor proposals: {{list}}', {
                        count: added.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            } else {
                const descendants = getDescendantsInPlan(key);
                const removed = [];
                selected.delete(key);
                descendants.forEach(hash => {
                    if (selected.delete(hash)) removed.push(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, selected.has(hash)));
                toggleCheckbox(key, false);
                descendants.forEach(hash => toggleCheckbox(hash, false));
                if (removed.length > 0) {
                    const summary = removed.slice(0, 5).join(', ');
                    setStatus(tShare('plan.removedDescendants', 'Also removed {{count}} descendant proposals: {{list}}', {
                        count: removed.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            }
            updateShareUrl();
        };

        const attachRow = (proposal, key) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '6px 4px';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '8px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('change', () => onCheckboxChange(key, checkbox.checked));
            left.appendChild(checkbox);

            const title = document.createElement('div');
            title.style.display = 'flex';
            title.style.flexDirection = 'column';
            title.style.gap = '2px';

            const name = document.createElement('span');
            name.textContent = proposal.title || proposal.name || tShare('untitled', '(Untitled)');
            name.style.fontWeight = '600';
            name.style.fontSize = '13px';
            title.appendChild(name);

            const meta = document.createElement('span');
            meta.style.fontSize = '12px';
            meta.style.color = '#475569';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            title.appendChild(meta);

            left.appendChild(title);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            right.style.gap = '8px';

            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn share-modal-secondary';
            uploadBtn.textContent = tShare('plan.upload', 'Upload');

            const uploadedLabel = document.createElement('span');
            uploadedLabel.style.fontSize = '12px';
            uploadedLabel.style.color = '#0f766e';
            uploadedLabel.style.display = 'none';

            uploadBtn.addEventListener('click', async () => {
                const gate = await ensureAncestorProposalsUploaded(proposal);
                if (!gate.ok) {
                    const missingList = gate.missing.map(entry => entry.id || (entry.hash ? entry.hash.slice(0, 8) : '?')).filter(Boolean);
                    setStatus(tShare('plan.uploadAncestorsMissing', 'Upload ancestor proposals first: {{list}}', {
                        list: missingList.join(', ')
                    }));
                    return;
                }

                uploadState.set(key, { uploaded: false, uploading: true, serverId: getServerProposalId(proposal) });
                updateRowState(key);
                try {
                    const result = await uploadProposalToServer(proposal);
                    if (!result.ok) {
                        throw new Error(result.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                    }
                    // Always use the serial ID (numeric) from the server response, never a hash
                    const serverId = result.id ? String(result.id) : (result.proposalId ? String(result.proposalId) : null);
                    if (!serverId || !/^\d+$/.test(serverId)) {
                        throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
                    }

                    // syncProposalWithServerId updates the stored proposal with serverProposalId.
                    // Keep using the local proposal key for UI/state to avoid collisions with on-chain numeric ids.
                    const updatedProposal = proposalStorage.getProposal(key) || proposal;

                    // Update the proposal in our map with fresh data
                    proposalsByHash.set(key, updatedProposal);

                    // Update the meta display with new ID
                    const controls = rowControls.get(key);
                    if (controls && controls.meta) {
                        const displayId = updatedProposal.proposalId || getProposalKey(updatedProposal) || 'local';
                        controls.meta.textContent = `${displayId} · ${(resolveProposalGoalKey(updatedProposal) || 'proposal')}`;
                    }

                    uploadState.set(key, { uploaded: true, uploading: false, serverId });
                    updateRowState(key);
                    updateShareUrl();
                } catch (error) {
                    console.error('plan upload failed', error);
                    uploadState.set(key, { uploaded: false, uploading: false, serverId: getServerProposalId(proposal) });
                    updateRowState(key);
                    setStatus(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                }
            });

            right.appendChild(uploadBtn);
            right.appendChild(uploadedLabel);

            row.appendChild(left);
            row.appendChild(right);

            listWrap.appendChild(row);
            rowControls.set(key, { checkbox, uploadBtn, uploadedLabel, meta });
        };

        proposalsByHash.forEach(attachRow);

        const refreshUploadState = async (key, proposal) => {
            const serverId = getServerProposalId(proposal);
            if (!serverId) {
                uploadState.set(key, { uploaded: false, uploading: false, serverId: null });
                updateRowState(key);
                return;
            }
            uploadState.set(key, { uploaded: false, uploading: true, serverId });
            updateRowState(key);
            const exists = await headProposalExists(serverId, proposal.city, proposal);

            // After headProposalExists, the proposal may have been synced with serverProposalId
            // Get the serial ID (numeric) if available
            // headProposalExists syncs the proposal when checking by hash, so refresh our reference
            const refreshedProposal = proposalStorage.getProposal(key) || proposal;
            let serialId = getSerialProposalId(refreshedProposal);

            // If proposal exists but we still don't have serial ID, try fetching it directly
            if (!serialId && exists) {
                const isNumericId = /^\d+$/.test(String(serverId));
                if (!isNumericId) {
                    // We checked by hash, need to fetch the full proposal to get serial ID
                    try {
                        const backendBase = resolveBackendBaseUrl();
                        const cityId = proposal.city || (typeof getCurrentCityId === 'function' ? getCurrentCityId() : null) || 'city';
                        const url = `${backendBase}/proposals/city/${encodeURIComponent(serverId)}?city=${encodeURIComponent(cityId)}`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const payload = await response.json();
                            if (payload && payload.id) {
                                serialId = String(payload.id);
                                // Sync the proposal with the serial ID
                                syncProposalWithServerId(refreshedProposal, serialId);
                            }
                        }
                    } catch (error) {
                        console.warn('Failed to fetch serial ID for proposal', serverId, error);
                    }
                } else {
                    // serverId is already numeric, use it
                    serialId = String(serverId);
                }
            }

            // Only use serial ID for share links, never hashes
            const shareId = serialId && /^\d+$/.test(serialId) ? serialId : null;
            uploadState.set(key, { uploaded: !!exists, uploading: false, serverId: shareId });
            updateRowState(key);
            updateShareUrl();
        };

        const initializeUploadChecks = async () => {
            for (const [key, proposal] of proposalsByHash.entries()) {
                await refreshUploadState(key, proposal);
            }
            updateShareUrl();
        };

        showSimpleShareModal({
            title: tShare('plan.title', 'Share Plan'),
            body: container
        });

        initializeUploadChecks();
    } catch (error) {
        console.error('showSharePlanModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'), 5000, 'error');
        }
    }
}

function shareSingleProposal(proposalId) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (!proposalId || typeof proposalStorage === 'undefined') {
            return;
        }
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.'), 4000, 'error');
            }
            return;
        }

        // If the proposal is already minted, offer direct explorer sharing
        const nftInfo = getProposalNftInfo(proposal);
        const mintedExplorerUrl = nftInfo ? buildProposalNftExplorerUrl(proposal) : null;
        if (mintedExplorerUrl) {
            showMintedShareModal(proposal, mintedExplorerUrl);
            return;
        }

        const parentParcelIdsForShare = collectProposalParentParcelIdsForShare(proposal);
        const nonOriginalParcels = checkParcelsOriginal(parentParcelIdsForShare);
        if (nonOriginalParcels.length > 0) {
            showNonOriginalParcelShareBlockedModal(proposal, parentParcelIdsForShare);
            return;
        }

        showUploadProposalModal(proposal);
    } catch (error) {
        console.error('shareSingleProposal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.unable_to_generate_share_link', 'Unable to generate share link.'), 5000, 'error');
        }
    }
}

function isProposalCurrentlyApplied(proposal) {
    if (!proposal) return false;
    const isAppliedLike = (value) => {
        const normalized = (value || '').toString().toLowerCase();
        return normalized === 'applied' || normalized === 'executed';
    };

    // Executed proposals are considered immutable and should be skipped for re-apply.
    if (isAppliedLike(proposal.status)) return true;
    if (proposal.roadProposal && isAppliedLike(proposal.roadProposal.status)) return true;
    if (proposal.buildingProposal && isAppliedLike(proposal.buildingProposal.status)) return true;
    if (proposal.structureProposal && isAppliedLike(proposal.structureProposal.status)) return true;
    if (proposal.reparcellization && isAppliedLike(proposal.reparcellization.status)) return true;
    if (proposal.decideLaterProposal && isAppliedLike(proposal.decideLaterProposal.status)) return true;
    return false;
}

function buildSharedProposalsPayload(appliedProposals) {
    if (!Array.isArray(appliedProposals) || appliedProposals.length === 0) {
        return null;
    }

    const featuresForBounds = [];
    const sanitized = appliedProposals.map(proposal => {
        const parentIdsSet = new Set();

        const goalKey = resolveProposalGoalKey(proposal) || null;

        const sanitizedProposal = {
            proposalId: proposal.proposalId,
            goal: goalKey,
            title: proposal.title || '',
            description: proposal.description || '',
            author: proposal.author || '',
            createdAt: proposal.createdAt || new Date().toISOString(),
            updatedAt: proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
            offer: typeof proposal.offer === 'number' ? proposal.offer : (proposal.offer || null),
            parcelIds: ensureArrayOfStrings(proposal.parentParcelIds),
            acceptedParcelIds: ensureArrayOfStrings(proposal.acceptedParcelIds),
            color: proposal.color || null,
            status: 'Applied',
            minted: isProposalMinted(proposal),
            onchain: proposal.onchain ? {
                transactionHash: proposal.onchain.transactionHash || null,
                proposalId: proposal.onchain.proposalId || null,
                chainId: proposal.onchain.chainId || null,
                contractAddress: proposal.onchain.contractAddress || null,
                metadataUri: proposal.onchain.metadataUri || null,
                metadataUrl: proposal.onchain.metadataUrl || null,
                imageUri: proposal.onchain.imageUri || null,
                imageUrl: proposal.onchain.imageUrl || null
            } : null
        };

        // Ancestors will be computed per proposal type below (prefer true parents)
        const lensEntries = normalizeLensEntries(proposal.lens || proposal.lensEntries || proposal.lensAddresses);
        if (lensEntries.length) {
            sanitizedProposal.lens = lensEntries;
        }

        if (proposal.roadProposal) {
            const childParcelIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childParcelIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature) featuresForBounds.push(feature);
            });

            // Extract parent parcel IDs (not full geometries)
            const parentIds = (function () {
                if (Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    return ensureArrayOfStrings(proposal.roadProposal.parentParcelIds);
                }
                return [];
            })();
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.roadProposal = {
                definition: deepClone(proposal.roadProposal.definition),
                childParcelIds,
                roadGeometry: deepClone(proposal.roadProposal.roadGeometry),
                metadata: deepClone(proposal.roadProposal.metadata),
                id: proposal.roadProposal.id || proposal.roadProposal.proposalId || undefined,
                parentParcelIds: parentIds // IDs only, not full geometries
                // Note: parentFeatures is intentionally excluded - will be fetched on load
            };
        }

        if (proposal.buildingProposal) {
            const buildingFeature = proposal.buildingProposal.buildingFeature
                ? deepClone(proposal.buildingProposal.buildingFeature)
                : null;
            if (buildingFeature) {
                featuresForBounds.push(buildingFeature);
            }

            const parentIds = ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.buildingProposal = {
                parameters: deepClone(proposal.buildingProposal.parameters) || {},
                parentParcelIds: parentIds,
                parentParcelNumbers: deepCloneArray(proposal.buildingProposal.parentParcelNumbers),
                ancestorKey: proposal.buildingProposal.ancestorKey || parentIds.join('|'),
                buildingFeature,
                metadata: deepClone(proposal.buildingProposal.metadata)
            };
        } else if (proposal.buildingGeometry) {
            const buildingFeature = {
                type: 'Feature',
                geometry: deepClone(proposal.buildingGeometry),
                properties: deepClone(proposal.buildingProperties) || {}
            };
            featuresForBounds.push(buildingFeature);
            const parentIds = ensureArrayOfStrings(proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));
            sanitizedProposal.buildingProposal = {
                parameters: {},
                parentParcelIds: parentIds,
                parentParcelNumbers: [],
                ancestorKey: parentIds.join('|'),
                buildingFeature
            };
        }

        // Structure proposals
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            // Collect for bounds
            if (sp.geometry) {
                try { featuresForBounds.push({ type: 'Feature', geometry: deepClone(sp.geometry), properties: { structureKind: sp.kind || 'square' } }); } catch (_) { }
            }
            // Parents
            const parentIds = ensureArrayOfStrings(sp.parentParcelIds && sp.parentParcelIds.length ? sp.parentParcelIds : proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.structureProposal = {
                kind: sp.kind || 'square',
                geometry: deepClone(sp.geometry),
                blockName: sp.blockName || null,
                parentParcelIds: parentIds
            };
        }

        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length > 0) {
            const reparcelParcelIds = ensureArrayOfStrings(proposal.reparcellization.parcelIds && proposal.reparcellization.parcelIds.length > 0
                ? proposal.reparcellization.parcelIds
                : proposal.parentParcelIds);
            reparcelParcelIds.forEach(id => parentIdsSet.add(id));

            const clonedOwnerShares = deepCloneArray(proposal.reparcellization.ownerShares);
            const clonedPolygons = deepCloneArray(proposal.reparcellization.polygons);

            sanitizedProposal.goal = 'reparcellization';
            sanitizedProposal.reparcellization = {
                algorithm: proposal.reparcellization.algorithm || 'sweep-line',
                generatedAt: proposal.reparcellization.generatedAt || proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
                parcelIds: reparcelParcelIds.slice(),
                totalArea: Number.isFinite(Number(proposal.reparcellization.totalArea))
                    ? Number(proposal.reparcellization.totalArea)
                    : null,
                ownerShares: clonedOwnerShares,
                polygons: clonedPolygons,
                status: 'unapplied'
            };

            clonedPolygons.forEach(slice => {
                if (!slice || !slice.geometry) return;
                try {
                    featuresForBounds.push({
                        type: 'Feature',
                        properties: {
                            ownerKey: slice.ownerKey || null,
                            displayName: slice.displayName || null,
                            color: slice.color || null,
                            percent: slice.percent || null
                        },
                        geometry: deepClone(slice.geometry)
                    });
                } catch (err) {
                    console.warn('Failed to include reparcellization slice in shared payload bounds', err);
                }
            });
        }

        // If no explicit parents were collected, fall back to this proposal's parentParcelIds
        if (parentIdsSet.size === 0) {
            ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => parentIdsSet.add(id));
        }
        const parentIds = Array.from(parentIdsSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        sanitizedProposal.parentParcelIds = parentIds;

        return sanitizedProposal;
    });

    const camera = (typeof map !== 'undefined' && map && typeof map.getCenter === 'function')
        ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }
        : null;

    const bbox = computeSharedBoundingBoxFromFeatures(featuresForBounds) || (function () {
        if (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') {
            const bounds = map.getBounds();
            return {
                west: bounds.getWest(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                north: bounds.getNorth()
            };
        }
        return null;
    })();

    return {
        version: SHARE_PAYLOAD_VERSION,
        generatedAt: new Date().toISOString(),
        author: (typeof getCurrentUsername === 'function' && getCurrentUsername())
            ? getCurrentUsername()
            : (appliedProposals[0]?.author || 'Unknown'),
        proposals: sanitized,
        bbox,
        camera
    };
}

function deepClone(value) {
    try {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return null;
    }
}

function deepCloneArray(values) {
    if (!Array.isArray(values)) return [];
    return values.map(item => deepClone(item));
}

function ensureArrayOfStrings(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(value => {
            if (value === null || value === undefined) return '';
            try {
                return value.toString();
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean);
}

// Note: Do not normalize parcel IDs here; suffixes carry semantic meaning in this dataset

// Simple HTML escape to safely insert dynamic strings into innerHTML
function escapeHtml(str) {
    try {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    } catch (_) {
        return '';
    }
}

const PARCEL_NUMBER_PROPERTY_CANDIDATES = [
    'BROJ_CESTICE',
    'smp',
    'SMP',
    'parcelNumber',
    'parcel_number',
    'parcel',
    'parcelNo',
    'parcel_no',
    'parcelId',
    'parcel_id'
];

function getParcelDisplayNumberFromProperties(properties, fallback = '') {
    if (properties) {
        for (const key of PARCEL_NUMBER_PROPERTY_CANDIDATES) {
            const value = properties[key];
            if (value !== undefined && value !== null) {
                const text = value.toString().trim();
                if (text) {
                    return text;
                }
            }
        }
        const fallbackId = getParcelIdFromProperties(properties);
        if (fallbackId !== undefined && fallbackId !== null) {
            const candidate = fallbackId.toString().trim();
            if (candidate) {
                return candidate;
            }
        }
    }
    return fallback ? fallback.toString() : '';
}

function getParcelDisplayNumberFromFeature(feature, fallback = '') {
    if (!feature || typeof feature !== 'object') {
        return fallback ? fallback.toString() : '';
    }
    const properties = feature.properties || feature;
    return getParcelDisplayNumberFromProperties(properties, fallback);
}

function decodeSharedPayload(encoded) {
    if (!encoded) return null;
    let working = encoded.trim();
    let compressionMode = 'legacy';
    if (working.startsWith(SHARE_ENCODING_PREFIX_COMPRESSED)) {
        compressionMode = 'compressed';
        working = working.slice(SHARE_ENCODING_PREFIX_COMPRESSED.length);
    } else if (working.startsWith(SHARE_ENCODING_PREFIX_RAW)) {
        compressionMode = 'raw';
        working = working.slice(SHARE_ENCODING_PREFIX_RAW.length);
    }
    try {
        if (SHARE_BASE64_ALLOWED.test(working)) {
            const bytes = base64UrlDecodeToBytes(working);
            let decodedBytes = bytes;
            if (compressionMode === 'compressed') {
                decodedBytes = inflateBytes(bytes, { strict: true });
            } else if (compressionMode === 'legacy') {
                const inflated = inflateBytes(bytes, { strict: false });
                if (inflated && inflated.length) {
                    decodedBytes = inflated;
                }
            }
            const json = decodeBytesToJson(decodedBytes);
            return JSON.parse(json);
        }

        if (compressionMode === 'compressed') {
            throw new Error('Compressed shared payload is not base64 encoded.');
        }

        const json = decodeURIComponent(working);
        return JSON.parse(json);
    } catch (error) {
        console.error('decodeSharedPayload failed', error);
        throw error;
    }
}

function computeSharedBoundingBoxFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return null;
    }

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;

    features.forEach(feature => {
        if (!feature) return;
        const geometry = feature.type === 'Feature' ? feature.geometry : feature;
        collectCoordinatesFromGeometry(geometry, (lng, lat) => {
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            if (lng < west) west = lng;
            if (lng > east) east = lng;
            if (lat < south) south = lat;
            if (lat > north) north = lat;
        });
    });

    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
        return null;
    }

    const padding = 0.0005;
    return {
        west: west - padding,
        south: south - padding,
        east: east + padding,
        north: north + padding
    };
}

function collectCoordinatesFromGeometry(geometry, visitor) {
    if (!geometry || typeof visitor !== 'function') return;
    const { type, coordinates } = geometry;
    if (!type) return;

    switch (type) {
        case 'Point':
            if (Array.isArray(coordinates)) {
                visitor(coordinates[0], coordinates[1]);
            }
            break;
        case 'MultiPoint':
        case 'LineString':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(coord => {
                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                });
            }
            break;
        case 'MultiLineString':
        case 'Polygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(ring => {
                    if (Array.isArray(ring)) {
                        ring.forEach(coord => {
                            if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                        });
                    }
                });
            }
            break;
        case 'MultiPolygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(polygon => {
                    if (Array.isArray(polygon)) {
                        polygon.forEach(ring => {
                            if (Array.isArray(ring)) {
                                ring.forEach(coord => {
                                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                                });
                            }
                        });
                    }
                });
            }
            break;
        case 'GeometryCollection':
            if (Array.isArray(geometry.geometries)) {
                geometry.geometries.forEach(inner => collectCoordinatesFromGeometry(inner, visitor));
            }
            break;
        default:
            break;
    }
}

function showShareLinkModal(shareUrl, payload, options = {}) {
    if (typeof document === 'undefined') return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
    const proposalCount = proposals.length;
    const proposalSuffix = proposalCount === 1 ? '' : 's';
    const fragment = document.createDocumentFragment();

    if (options && options.nearLimit) {
        const warning = document.createElement('p');
        warning.style.color = '#b00020';
        warning.style.fontWeight = '600';
        warning.textContent = tShare('sizeWarning', 'Warning: This link is close to the maximum size the server accepts. Consider sharing fewer parcels if it fails.');
        fragment.appendChild(warning);
    }

    const intro = document.createElement('p');
    const introParams = (options && options.introParams) || { count: proposalCount, suffix: proposalSuffix };
    intro.innerHTML = (options && options.introHtml)
        ? options.introHtml
        : tShare('defaultIntro', 'Share this link to load {{count}} applied proposal{{suffix}}.', introParams);
    fragment.appendChild(intro);

    const textarea = document.createElement('textarea');
    textarea.className = 'share-modal-link';
    textarea.value = shareUrl;
    textarea.setAttribute('readonly', 'readonly');
    fragment.appendChild(textarea);

    const info = document.createElement('p');
    const unknownText = t('common.unknown', 'Unknown');
    const zoomValue = payload?.camera && typeof payload.camera.zoom === 'number'
        ? payload.camera.zoom
        : unknownText;
    const encodedLength = (options && typeof options.encodedLength === 'number') ? options.encodedLength : null;
    const contentLabel = tShare('stats.contentLabel', 'Content:');
    const sizeLabel = tShare('stats.sizeLabel', 'Size:');
    const authorLabel = tShare('authorLabel', 'Author:');
    const cameraLabel = tShare('cameraLabel', 'Camera zoom:');
    const proposalsLabel = tShare('proposalsLabel', 'Proposals:');
    const sizeStats = (function () {
        try {
            const totalProposals = proposalCount;
            const roadCount = proposals.filter(p => p.roadProposal).length;
            const buildingCount = proposals.filter(p => p.buildingProposal).length;
            const parcelCount = proposals.reduce((sum, p) => sum + (Array.isArray(p.parentParcelIds) ? p.parentParcelIds.length : 0), 0);
            const estimatedBytes = encodedLength !== null
                ? encodedLength
                : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(JSON.stringify(payload)).length : JSON.stringify(payload).length);
            const kb = (estimatedBytes / 1024).toFixed(1);
            const maxKb = (SHARE_URL_MAX_LENGTH / 1024).toFixed(1);
            const contentSummary = tShare('stats.contentSummary', '{{total}} proposals • {{roads}} roads • {{buildings}} buildings • {{parcels}} parcels', {
                total: totalProposals,
                roads: roadCount,
                buildings: buildingCount,
                parcels: parcelCount
            });
            const sizeSummary = tShare('stats.sizeSummary', '~{{kb}} KB of encoded link (server limit ~{{maxKb}} KB)', {
                kb,
                maxKb
            });
            return `<br><strong>${contentLabel}</strong> ${contentSummary}` +
                `<br><strong>${sizeLabel}</strong> ${sizeSummary}`;
        } catch (_) { return ''; }
    })();
    const authorText = payload?.author || unknownText;
    const safeAuthor = typeof escapeHtml === 'function' ? escapeHtml(authorText) : authorText;
    info.innerHTML = `<strong>${authorLabel}</strong> ${safeAuthor}<br><strong>${cameraLabel}</strong> ${zoomValue}<br><strong>${proposalsLabel}</strong> ${proposalCount}${sizeStats}`;
    fragment.appendChild(info);

    const note = document.createElement('p');
    note.style.color = '#555';
    note.innerHTML = tShare('note', 'Server-backed sharing is coming soon. JSON export is provided for archival/manual sharing; future compatibility is not guaranteed.');
    fragment.appendChild(note);

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: fragment,
        actions: [
            {
                label: tShare('saveJson', 'Save as JSON'),
                onClick: () => {
                    try { savePlanPayloadAsJson(payload); } catch (e) { console.warn('Save JSON failed', e); }
                }
            },
            {
                label: tShare('copyLink', 'Copy Link'),
                primary: true,
                onClick: () => {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(shareUrl).then(() => {
                            if (typeof showEphemeralMessage === 'function') {
                                showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                            }
                        }).catch(() => {
                            textarea.focus();
                            textarea.select();
                        });
                    } else {
                        textarea.focus();
                        textarea.select();
                    }
                }
            }
        ]
    });

    if (modal && textarea) {
        setTimeout(() => {
            textarea.focus();
            textarea.select();
        }, 75);
    }
}

function showShareTooLargeModal() {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    showSimpleShareModal({
        title: tShare('tooLargeTitle', 'Proposal Set Too Large'),
        body: `<p>${tShare('tooLargeBody', 'Links are limited to roughly 7.5 KB on the server, so this proposal set cannot be embedded in the URL. Reduce the number of parcels/proposals or use the JSON export while we finish server-side sharing.')}</p>`,
        actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
    });
}

function resolveBackendBaseUrl() {
    if (typeof global !== 'undefined' && typeof global.getBackendBase === 'function') {
        return global.getBackendBase();
    }
    if (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') {
        return window.getBackendBase();
    }
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname)
        ? window.location.hostname.toLowerCase()
        : '';
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

function resolveFrontendBaseUrl() {
    if (typeof window === 'undefined' || !window.location) {
        return 'https://urbangametheory.xyz';
    }
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return `${window.location.protocol}//${window.location.host}`;
    }
    return 'https://urbangametheory.xyz';
}

function buildCityQueryParam() {
    const mgr = (typeof window !== 'undefined') ? window.CityConfigManager : null;
    if (!mgr) return '';

    // Get current city config
    const cfg = mgr.getCurrentCityConfig && typeof mgr.getCurrentCityConfig === 'function' ? mgr.getCurrentCityConfig() : null;
    if (!cfg || !cfg.id) return '';

    // Get city code from city config manager
    const getCityCode = mgr.getCityCodeForCityId && typeof mgr.getCityCodeForCityId === 'function' ? mgr.getCityCodeForCityId : null;
    if (!getCityCode) return '';

    const code = getCityCode(cfg.id);
    if (!code) return '';

    return `?city=${encodeURIComponent(code)}`;
}

function migrateRoadAssetsToNewId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.clearRoadAssets === 'function') {
        proposalStorage.clearRoadAssets(oldId);
        proposalStorage.clearRoadAssets(newId);
    }
}

function buildUploadReadyProposal(proposal) {
    if (!proposal) return null;
    const uploadProposal = { ...proposal };

    const currentCityId = typeof getCurrentCityId === 'function'
        ? getCurrentCityId()
        : (typeof window !== 'undefined' && window.getCurrentCityId && typeof window.getCurrentCityId === 'function' ? window.getCurrentCityId() : 'city');
    uploadProposal.city = uploadProposal.city || currentCityId;

    // Remove parentFeatures - we only upload IDs, not full geometries
    if (uploadProposal.parentFeatures) {
        delete uploadProposal.parentFeatures;
    }
    if (uploadProposal.roadProposal) {
        if (uploadProposal.roadProposal.parentFeatures) {
            delete uploadProposal.roadProposal.parentFeatures;
        }
        // Remove childFeatures - child parcel geometries are fetched by ID when needed
        if (uploadProposal.roadProposal.childFeatures) {
            delete uploadProposal.roadProposal.childFeatures;
        }
        // Ensure parentParcelIds are set (for fetching ancestors on load)
        if (!uploadProposal.roadProposal.parentParcelIds || uploadProposal.roadProposal.parentParcelIds.length === 0) {
            const parentIds = uploadProposal.parentParcelIds || [];
            uploadProposal.roadProposal.parentParcelIds = ensureArrayOfStrings(parentIds);
        }
    }
    return uploadProposal;
}

function syncProposalWithServerId(proposal, serverProposalId) {
    if (!serverProposalId || typeof proposalStorage === 'undefined') return null;
    const oldProposalId = proposal.proposalId;
    const proposalId = proposal.proposalId;
    let storedProposal = oldProposalId ? proposalStorage.getProposal(oldProposalId) : null;
    if (!storedProposal && proposalId) {
        storedProposal = proposalStorage.getProposal(proposalId);
    }
    if (!storedProposal) return null;

    // Preserve local proposalId; store server reference separately
    storedProposal.serverProposalId = String(serverProposalId);
    storedProposal.id = storedProposal.id || storedProposal.proposalId;

    // Older versions indexed the same proposal under the server id key, which caused duplicates in getAllProposals().
    // We resolve server ids via proposalStorage._resolveProposalId now, so ensure any legacy alias entry is removed.
    if (proposalStorage.proposals) {
        const serverKey = String(serverProposalId);
        const canonicalKey = storedProposal.proposalId ? String(storedProposal.proposalId) : null;
        if (serverKey && canonicalKey && serverKey !== canonicalKey) {
            const aliased = proposalStorage.proposals.get(serverKey);
            if (aliased === storedProposal) {
                proposalStorage.proposals.delete(serverKey);
            }
        }
    }

    migrateRoadAssetsToNewId(oldProposalId, serverProposalId);

    if (typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(storedProposal);
    }

    if (typeof proposalStorage.save === 'function') {
        proposalStorage.save();
    }

    return storedProposal;
}

async function uploadProposalToServer(proposal) {
    const uploadProposal = buildUploadReadyProposal(proposal);
    if (!uploadProposal) {
        return { ok: false, message: 'Invalid proposal.' };
    }

    const backendBase = resolveBackendBaseUrl();
    try {
        const response = await fetch(`${backendBase}/proposals/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uploadProposal)
        });

        let errorBody = null;
        if (!response.ok) {
            try { errorBody = await response.json(); } catch (_) { }

            if (response.status === 409 && errorBody && errorBody.id) {
                const serverProposalId = errorBody.id ? String(errorBody.id) : (errorBody.proposalId ? String(errorBody.proposalId) : null);
                if (serverProposalId) {
                    syncProposalWithServerId(proposal, serverProposalId);
                }
                return { ok: true, id: errorBody.id, proposalId: serverProposalId || errorBody.id };
            }

            const errorMessage = errorBody && errorBody.error
                ? errorBody.error
                : 'Failed to upload proposal. Please try again.';
            return { ok: false, message: errorMessage };
        }

        const result = await response.json();
        const serverProposalId = result && result.id ? String(result.id) : String(result.proposalId);
        syncProposalWithServerId(proposal, serverProposalId);
        return { ok: true, id: result.id, proposalId: serverProposalId };
    } catch (error) {
        console.error('uploadProposalToServer failed', error);
        return { ok: false, message: error.message || 'Upload failed.' };
    }
}

async function headProposalExists(proposalId, city, proposalForSync) {
    if (!proposalId) return false;
    const backendBase = resolveBackendBaseUrl();
    const id = String(proposalId).trim();
    const isNumericId = /^\d+$/.test(id);
    const cityId = city
        || (typeof getCurrentCityId === 'function' ? getCurrentCityId() : null);

    const url = isNumericId
        ? `${backendBase}/proposals/${id}`
        : `${backendBase}/proposals/city/${encodeURIComponent(id)}?city=${encodeURIComponent(cityId)}`;

    try {
        const response = await fetch(url, { method: isNumericId ? 'HEAD' : 'GET' });
        if (response.ok) {
            if (!isNumericId && proposalForSync) {
                try {
                    const payload = await response.clone().json();
                    const serverDbId = payload && payload.id ? String(payload.id) : null;
                    if (serverDbId && !isLocalProposalId(serverDbId)) {
                        syncProposalWithServerId(proposalForSync, serverDbId);
                    }
                } catch (_) { /* ignore json parse */ }
            }
            return true;
        }
        if (response.status === 404) return false;
    } catch (error) {
        console.warn('headProposalExists failed', error);
    }
    return false;
}

async function ensureAncestorProposalsUploaded(proposal) {
    const missing = [];
    if (!proposal || typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function' || typeof proposalStorage === 'undefined') {
        return { ok: true, missing };
    }

    const proposalKey = getProposalKey(proposal) || proposal.proposalId;
    if (!proposalKey) {
        return { ok: true, missing };
    }

    let ancestorNodes = [];
    try {
        ancestorNodes = ProposalManager.findAncestorTree(String(proposalKey), { depthLimit: 32 }) || [];
    } catch (error) {
        console.warn('ensureAncestorProposalsUploaded: failed to compute ancestor tree', error);
        return { ok: true, missing };
    }

    const ancestorHashes = Array.from(new Set(ancestorNodes.map(n => n.proposalId).filter(Boolean)));
    if (!ancestorHashes.length) {
        return { ok: true, missing };
    }

    const checks = await Promise.all(ancestorHashes.map(async hash => {
        const ancestor = proposalStorage.getProposal(hash);
        if (!ancestor) {
            return { hash, reason: 'missing-local', id: null };
        }
        const serverId = getServerProposalId(ancestor);
        if (!serverId) {
            return { hash, reason: 'local-only', id: null };
        }
        const exists = await headProposalExists(serverId, ancestor.city || proposal.city, ancestor);
        return exists ? null : { hash, reason: 'not-found', id: serverId };
    }));

    checks.filter(Boolean).forEach(entry => missing.push(entry));
    return { ok: missing.length === 0, missing };
}

function showUploadProposalModal(proposal) {
    if (typeof document === 'undefined' || !proposal) return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    // Get frontend base URL (urbangametheory.xyz or localhost)
    const fragment = document.createDocumentFragment();

    const uploadExplainerText = tShare('uploadExplainer', 'To share a proposal with others you first have to upload it to the server');
    const uploadSuccessText = tShare('uploadSuccess', 'Proposal uploaded! You can now share it with others');

    // Explainer text
    const explainer = document.createElement('p');
    explainer.textContent = uploadExplainerText;
    explainer.style.marginBottom = '1.5rem';
    fragment.appendChild(explainer);

    // Upload button container
    const uploadContainer = document.createElement('div');
    uploadContainer.style.marginBottom = '1.5rem';

    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'btn share-modal-primary';
    const uploadButtonLabel = tShare('uploadButton', 'Upload proposal');
    uploadButton.textContent = uploadButtonLabel;
    uploadButton.style.width = '100%';
    uploadContainer.appendChild(uploadButton);

    const uploadStatus = document.createElement('div');
    uploadStatus.style.marginTop = '0.4rem';
    uploadStatus.style.fontSize = '12px';
    uploadStatus.style.color = '#b3261e';
    uploadStatus.style.lineHeight = '1.4';
    uploadContainer.appendChild(uploadStatus);
    fragment.appendChild(uploadContainer);

    // URL container (initially hidden)
    const urlContainer = document.createElement('div');
    urlContainer.style.display = 'none';
    urlContainer.style.marginTop = '1.5rem';

    const urlLabel = document.createElement('label');
    urlLabel.textContent = tShare('shareUrlLabel', 'Share URL:');
    urlLabel.style.display = 'block';
    urlLabel.style.marginBottom = '0.5rem';
    urlLabel.style.fontWeight = '600';
    urlContainer.appendChild(urlLabel);

    const urlInputContainer = document.createElement('div');
    urlInputContainer.style.display = 'flex';
    urlInputContainer.style.gap = '0.5rem';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.className = 'share-modal-link';
    urlInput.style.flex = '1';
    urlInput.style.padding = '0.5rem 0.75rem';
    urlInput.style.border = '1px solid #d8ddf0';
    urlInput.style.borderRadius = '8px';
    urlInput.style.height = 'auto';
    urlInput.style.lineHeight = '1.5';
    urlInput.style.minHeight = '38px';
    urlInput.style.maxHeight = '38px';
    urlInput.style.fontSize = '13px';
    urlInput.style.fontFamily = 'inherit';
    urlInput.style.background = '#f7f8fb';
    urlInput.style.color = '#212744';
    urlInput.style.boxSizing = 'border-box';
    urlInputContainer.appendChild(urlInput);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-modal-secondary';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.style.height = '38px';
    copyButton.style.minHeight = '38px';
    copyButton.style.maxHeight = '38px';
    copyButton.style.padding = '0.5rem 1rem';
    copyButton.style.lineHeight = '1.5';
    copyButton.style.whiteSpace = 'nowrap';
    copyButton.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(urlInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });
    urlInputContainer.appendChild(copyButton);

    urlContainer.appendChild(urlInputContainer);
    fragment.appendChild(urlContainer);

    const shareActionsContainer = document.createElement('div');
    shareActionsContainer.className = 'share-modal-share-actions';
    shareActionsContainer.style.display = 'none';
    shareActionsContainer.style.marginTop = '1rem';
    shareActionsContainer.style.width = '100%';

    const shareLabel = document.createElement('div');
    shareLabel.textContent = tShare('shareViaLabel', 'Share via');
    shareLabel.style.fontWeight = '600';
    shareLabel.style.marginBottom = '0.5rem';
    shareActionsContainer.appendChild(shareLabel);

    const shareButtonsRow = document.createElement('div');
    shareButtonsRow.style.display = 'flex';
    shareButtonsRow.style.gap = '0.5rem';
    shareButtonsRow.style.flexWrap = 'wrap';
    shareButtonsRow.style.width = '100%';

    const tweetButton = document.createElement('button');
    tweetButton.type = 'button';
    tweetButton.className = 'btn share-modal-secondary';
    tweetButton.textContent = tShare('tweetButton', 'Tweet this proposal');
    tweetButton.style.flex = '1 1 0';
    tweetButton.style.minWidth = '0';
    tweetButton.addEventListener('click', () => {
        const urlToShare = urlInput.value || '';
        if (!urlToShare) return;
        const tweetText = tShare('tweetText', 'I have created a new urban proposal!');
        const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(urlToShare)}`;
        window.open(tweetUrl, '_blank', 'noopener,noreferrer');
    });
    shareButtonsRow.appendChild(tweetButton);

    const nativeShareButton = document.createElement('button');
    nativeShareButton.type = 'button';
    nativeShareButton.className = 'btn share-modal-secondary';
    nativeShareButton.textContent = tShare('nativeShareButton', 'Share...');
    nativeShareButton.style.flex = '1 1 0';
    nativeShareButton.style.minWidth = '0';
    nativeShareButton.addEventListener('click', async () => {
        const urlToShare = urlInput.value || '';
        const shareText = tShare('tweetText', 'I have created a new urban proposal!');
        if (navigator.share && urlToShare) {
            try {
                await navigator.share({
                    title: tShare('title', 'Share Proposal'),
                    text: shareText,
                    url: urlToShare
                });
            } catch (err) {
                console.warn('Native share failed', err);
            }
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText && urlToShare) {
            navigator.clipboard.writeText(urlToShare).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });
    shareButtonsRow.appendChild(nativeShareButton);

    shareActionsContainer.appendChild(shareButtonsRow);
    fragment.appendChild(shareActionsContainer);

    let uploadedId = null;
    const cityQueryParam = buildCityQueryParam();

    async function enforceUploadAncestryGate() {
        try {
            const gate = await ensureAncestorProposalsUploaded(proposal);
            if (!gate.ok) {
                const ancestorList = gate.missing.map(item => item.id || (item.hash ? item.hash.slice(0, 8) : '?')).filter(Boolean);
                const suffix = ancestorList.length === 1 ? '' : 's';
                uploadButton.disabled = true;
                uploadButton.classList.add('disabled');
                uploadButton.title = tShare('uploadAncestorsMissingTitle', 'Upload ancestor proposals first.');
                uploadStatus.textContent = tShare('uploadAncestorsMissing', 'Upload ancestor proposal{{suffix}} first: {{list}}', {
                    suffix,
                    list: ancestorList.join(', ')
                });
            } else {
                uploadButton.disabled = false;
                uploadButton.classList.remove('disabled');
                uploadButton.title = '';
                uploadStatus.textContent = '';
            }
        } catch (error) {
            console.warn('Failed to enforce upload ancestor gate', error);
            uploadButton.disabled = true;
            uploadButton.classList.add('disabled');
            uploadStatus.textContent = tShare('uploadAncestorsCheckFailed', 'Could not verify ancestor uploads. Please retry.');
        }
    }

    enforceUploadAncestryGate();

    // Upload handler
    uploadButton.addEventListener('click', async () => {
        if (uploadButton.disabled) return;

        uploadButton.disabled = true;
        uploadButton.textContent = tShare('uploading', 'Uploading...');
        uploadButton.style.opacity = '0.7';
        uploadButton.style.cursor = 'not-allowed';

        try {
            const uploadProposal = buildUploadReadyProposal(proposal);

            console.log('[showUploadProposalModal] Proposal before upload:', {
                hasRoadProposal: !!uploadProposal?.roadProposal,
                proposalId: uploadProposal?.proposalId,
                city: uploadProposal?.city
            });

            const uploadResult = await uploadProposalToServer(uploadProposal);

            if (!uploadResult.ok) {
                throw new Error(uploadResult.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
            }

            // Always use the serial ID (numeric) from the server response, never a hash
            uploadedId = uploadResult.id ? String(uploadResult.id) : (uploadResult.proposalId ? String(uploadResult.proposalId) : null);
            if (!uploadedId || !/^\d+$/.test(uploadedId)) {
                throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
            }
            explainer.textContent = uploadSuccessText;
            const shareUrl = `${resolveFrontendBaseUrl()}/proposals/${uploadedId}${cityQueryParam}`;
            urlInput.value = shareUrl;

            // Show URL container
            urlContainer.style.display = 'block';

            // Show social share options
            shareActionsContainer.style.display = 'block';

            // Hide upload button
            uploadContainer.style.display = 'none';

            // --- NEW: Update details panel and state after upload ---
            // Do not select by numeric server id here (it can collide with on-chain token ids).
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const newProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (newProposal) {
                    // Use the first parent parcel for context; no child fallback
                    const firstParcelId = Array.isArray(newProposal.parentParcelIds) && newProposal.parentParcelIds.length > 0
                        ? newProposal.parentParcelIds[0]
                        : null;
                    const proposalKey = (typeof getProposalKey === 'function' ? getProposalKey(newProposal) : null) || newProposal.proposalId || localKey;
                    if (typeof selectAndHighlightProposal === 'function') {
                        selectAndHighlightProposal(proposalKey, firstParcelId, true, true);
                    } else if (typeof showProposalInfo === 'function') {
                        showProposalInfo(newProposal, firstParcelId);
                    }
                }
            }
            // --- END NEW ---

        } catch (error) {
            console.error('Upload failed:', error);
            uploadButton.disabled = false;
            uploadButton.textContent = uploadButtonLabel;
            uploadButton.style.opacity = '1';
            uploadButton.style.cursor = 'pointer';

            enforceUploadAncestryGate();

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'), 5000, 'error');
            }
        }
    });

    const modal = showSimpleShareModal({
        title: 'Share one proposal',
        body: fragment,
        actions: [
            {
                label: t('modal.common.cancel', 'Cancel'),
                onClick: () => { }
            },
            {
                label: t('modal.common.ok', 'OK'),
                primary: true,
                onClick: () => { }
            }
        ]
    });
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined') return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');

    const overlay = document.createElement('div');
    overlay.className = 'share-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'share-modal';

    const header = document.createElement('div');
    header.className = 'share-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'share-modal-title';
    titleEl.textContent = options.title || '';
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'share-modal-close close-circle-btn close-circle-btn--lg';
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'share-modal-body';

    if (Array.isArray(options.body)) {
        options.body.forEach(node => appendModalBody(bodyContainer, node));
    } else if (options.body) {
        appendModalBody(bodyContainer, options.body);
    }

    modal.appendChild(bodyContainer);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'share-modal-actions';

    const actions = Array.isArray(options.actions) ? options.actions : [];

    let didClose = false;
    const modalApi = {
        close: closeModal,
        overlay,
        modal,
        body: bodyContainer,
        getActionButton: (id) => {
            try { return actionsContainer.querySelector(`button[data-action-id="${id}"]`); } catch (_) { return null; }
        }
    };

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${action.primary ? 'share-modal-primary' : 'share-modal-secondary'}`;
        button.textContent = action.label || closeLabel;
        if (action && action.id) {
            button.setAttribute('data-action-id', String(action.id));
        }
        if (action && action.disabled) {
            button.disabled = true;
            button.classList.add('disabled');
        }
        button.addEventListener('click', (e) => {
            // If disabled, do nothing
            if (button.disabled || button.classList.contains('disabled')) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            closeModal();
            if (typeof action.onClick === 'function') {
                action.onClick();
            }
        });
        actionsContainer.appendChild(button);
    });

    if (actions.length > 0) {
        modal.appendChild(actionsContainer);
    }
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
        if (didClose) return;
        didClose = true;
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }

        try {
            if (typeof options.onClose === 'function') {
                options.onClose();
            }
        } catch (_) { }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);

    return modalApi;
}

function appendModalBody(container, content) {
    if (!container || !content) return;
    if (content instanceof Node) {
        container.appendChild(content);
    } else if (typeof content === 'string') {
        const paragraph = document.createElement('p');
        paragraph.innerHTML = content;
        container.appendChild(paragraph);
    }
}

// URL-driven 3D mode (e.g. ?mode3d or ?3d=1). We keep it here (near share/deep-link handlers)
// so proposal-loading flows can enter 3D after the map has been focused.
let url3DModeHandled = false;

function isTruthyUrlFlag(params, key) {
    try {
        if (!params || typeof params.has !== 'function') return false;
        if (!params.has(key)) return false;
        const raw = params.get(key);
        if (raw === null || raw === undefined) return false;
        const value = String(raw).trim().toLowerCase();
        if (value === '') return true; // e.g. ?mode3d
        if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
        if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
        // Any other value: presence is treated as enabled.
        return true;
    } catch (_) {
        return false;
    }
}

function is3DModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        return isTruthyUrlFlag(p, 'mode3d') || isTruthyUrlFlag(p, '3d');
    } catch (_) {
        return false;
    }
}

function roughlyEqualLatLng(a, b, eps = 1e-12) {
    try {
        if (!a || !b) return false;
        return Math.abs(a.lat - b.lat) <= eps && Math.abs(a.lng - b.lng) <= eps;
    } catch (_) {
        return false;
    }
}

function createLeafletViewSettlePromise(beforeCenter, beforeZoom) {
    return new Promise(resolve => {
        try {
            if (typeof map === 'undefined' || !map || typeof map.once !== 'function') {
                resolve();
                return;
            }

            let settled = false;
            const timeoutId = setTimeout(() => {
                // Safety net: if we missed moveend (e.g., listener attached too late), do not hang.
                done();
            }, 1200);
            const done = () => {
                if (settled) return;
                settled = true;
                try { map.off('moveend', done); } catch (_) { }
                try { clearTimeout(timeoutId); } catch (_) { }
                resolve();
            };

            // Subscribe before the view change so we don't miss immediate (non-animated) updates.
            try { map.once('moveend', done); } catch (_) { /* ignore */ }

            // If there's no actual view change, Leaflet may not emit moveend; settle on the next frame.
            requestAnimationFrame(() => {
                if (settled) return;
                try {
                    const afterCenter = map.getCenter();
                    const afterZoom = map.getZoom();
                    if (Number.isFinite(beforeZoom) && beforeCenter) {
                        const unchanged = (afterZoom === beforeZoom) && roughlyEqualLatLng(afterCenter, beforeCenter);
                        if (unchanged) done();
                    }
                } catch (_) {
                    done();
                }
            });
        } catch (_) {
            resolve();
        }
    });
}

function tryEnterThreeMode(options = {}) {
    try {
        if (typeof window !== 'undefined' && typeof window.enterThreeMode === 'function') {
            window.enterThreeMode(options);
            return true;
        }
    } catch (_) { }
    return false;
}

async function focusMapThenMaybeEnter3D(focusFn) {
    const params = (() => {
        try { return new URLSearchParams(window.location.search || ''); } catch (_) { return null; }
    })();

    // Always perform the focus action (unless caller passes a non-function).
    const doFocus = () => {
        try { typeof focusFn === 'function' && focusFn(); } catch (_) { }
    };

    const wants3D = is3DModeRequestedFromUrl(params);
    if (!wants3D || url3DModeHandled) {
        doFocus();
        return false;
    }

    let beforeCenter = null;
    let beforeZoom = null;
    try {
        if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
            beforeCenter = map.getCenter();
        }
        if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') {
            beforeZoom = map.getZoom();
        }
    } catch (_) { }

    const settlePromise = (beforeCenter && Number.isFinite(beforeZoom))
        ? createLeafletViewSettlePromise(beforeCenter, beforeZoom)
        : Promise.resolve();

    doFocus();
    await settlePromise;

    const entered = tryEnterThreeMode({ fromUrl: true });
    if (entered) {
        url3DModeHandled = true;
    }
    return entered;
}

let singleProposalShareHandled = false;
let sharedProposalsHandled = false;

function handleSingleProposalShareFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (singleProposalShareHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('proposalShare');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSingleProposalShareFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (_) {
            showSimpleShareModal({
                title: tShare('invalidTitle', 'Invalid Share Link'),
                body: `<p>${tShare('invalidBody', 'We could not decode this shared proposal link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('proposalShare');
            cleanSharedQuery(params);
            singleProposalShareHandled = true;
            return;
        }

        params.delete('proposalShare');
        cleanSharedQuery(params);
        singleProposalShareHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('emptyTitle', 'No Proposal Found'),
                body: `<p>${tShare('emptyBody', 'The shared link did not contain a proposal to load.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        const sharedProposal = payload.proposals[0];

        // Update Open Graph metadata for social sharing
        if (typeof updateProposalOGMetadata === 'function') {
            updateProposalOGMetadata(sharedProposal);
        }

        (async () => {
            try {
                await loadSharedProposalFromLink(sharedProposal, payload);
            } catch (error) {
                const message = error && error.message
                    ? escapeHtml(error.message)
                    : tShare('unknownError', 'An unknown error occurred while loading the shared proposal.');
                showSimpleShareModal({
                    title: tShare('failureTitle', 'Unable to Load Shared Proposal'),
                    body: `<p>${message}</p>`,
                    actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
                });
            }
        })();
    } catch (error) {
        console.error('handleSingleProposalShareFromUrl failed', error);
    }
}

async function loadSharedProposalFromLink(sharedProposal, payload) {
    if (!sharedProposal) {
        throw new Error('Shared proposal data is missing.');
    }

    let suppressedHere = false;
    if (!isCameraMovementSuppressed()) {
        try {
            window.suppressCameraMoves = true;
            suppressedHere = true;
        } catch (_) { }
    }

    try {
        const normalized = prepareProposalForImport(sharedProposal);
        if (!normalized) {
            throw new Error('Unable to normalise shared proposal data.');
        }

        // Ensure parent parcels are fetched (this replaces the old stageSharedProposalDependencies logic)
        const fetchedParentIds = await ensureParentParcelsFetched(sharedProposal, normalized);

        // For road proposals, resolve and store parentFeatures (needed for rebuilding road geometry)
        if (normalized.roadProposal && !resolveRoadParentFeatures(sharedProposal, normalized, fetchedParentIds)) {
            throw new Error('Missing parcel geometry required for this proposal.');
        }

        normalized.status = 'Active';
        normalized.acceptedParcelIds = [];

        const targetHash = normalized.proposalId || sharedProposal.proposalId || `shared_${Date.now()}`;
        normalized.proposalId = targetHash;

        let stored = proposalStorage.getProposal(targetHash);
        if (!stored) {
            const imported = proposalStorage.importProposal(normalized, { overwrite: false, preserveStatus: true });
            stored = imported || proposalStorage.getProposal(targetHash);
        }

        if (!stored) {
            const addedId = proposalStorage.addProposal({ ...normalized, proposalId: undefined });
            stored = addedId ? proposalStorage.getProposal(addedId) : null;
        }

        if (!stored) {
            throw new Error('Failed to store the shared proposal locally.');
        }

        if (normalized.roadProposal && stored.proposalId) {
            stored.roadProposal = stored.roadProposal || {};
            // Only store parentParcelIds - geometries fetched when needed
            if (normalized.roadProposal.parentParcelIds) {
                stored.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            } else if (normalized.roadProposal.parentFeatures) {
                // Legacy: extract IDs from parentFeatures if they exist (from old data)
                stored.roadProposal.parentParcelIds = ensureArrayOfStrings(normalized.roadProposal.parentFeatures.map(feature => getParcelIdFromFeature(feature)));
            }
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(stored);
            }
            proposalStorage.save();
        }

        if (suppressedHere) {
            try {
                window.suppressCameraMoves = false;
                suppressedHere = false;
            } catch (_) { }
        }

        await preloadProposalParcelOwners(stored.parentParcelIds, { forceRefresh: true });

        const focusParcelId = Array.isArray(stored.parentParcelIds) ? stored.parentParcelIds[0] : null;
        const storedKey = getProposalKey(stored);
        selectAndHighlightProposal(storedKey, focusParcelId, true);
        showProposalInfo(stored, focusParcelId);
        const panel = document.getElementById('proposal-details-panel');
        if (panel) {
            panel.classList.add('visible');
            document.body.classList.add('proposal-details-open');
        }
        await focusMapThenMaybeEnter3D(() => focusMapOnSharedProposal(stored, payload));
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.shared_proposal_loaded', 'Shared proposal loaded.'));
        }
    } finally {
        if (suppressedHere) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
    }
}

async function ensureParentParcelsLoaded(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const missing = findMissingParentParcels(parcelIds);
    if (!missing.length) {
        if (options.preloadOwners) {
            await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
        }
        return;
    }

    await fetchParcelsForIds(missing, {
        forceRefresh: options.forceRefreshParcels,
        onProgress: options.onProgress
    });

    const stillMissing = findMissingParentParcels(parcelIds);
    if (stillMissing.length && typeof fetchSingleParcelById === 'function') {
        await Promise.allSettled(stillMissing.map(id => fetchSingleParcelById(id)));
    }

    const finalMissing = findMissingParentParcels(parcelIds);
    if (!finalMissing.length && options.preloadOwners) {
        await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
    }
}

async function waitForParcelLayersReady(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) return;
    const cityId = options.cityId
        || (typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentCityId ? CityConfigManager.getCurrentCityId() : null);
    const scopedIds = ids.filter(id => isInCity(id, cityId));
    if (!scopedIds.length) {
        console.debug('[waitForParcelLayersReady] All parcel IDs filtered out for city', cityId);
        return;
    }
    if (scopedIds.length !== ids.length) {
        console.debug('[waitForParcelLayersReady] Filtering parcels to current city', {
            cityId,
            total: ids.length,
            filtered: scopedIds.length
        });
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 120;

    // Ensure parcelLayer exists and is attached before we start polling; shared route loads can run
    // before map-core wires the layer to the map.
    if (typeof ensureParcelLayerInitialized === 'function') {
        ensureParcelLayerInitialized();
    }
    if (typeof addParcelLayerToMapIfAppropriate === 'function') {
        addParcelLayerToMapIfAppropriate();
    }

    // Try to rehydrate missing parcels from storage BEFORE polling
    // This prevents stalls when parcels exist in storage but not in the layer index
    const missingFromIndex = scopedIds.filter(id => !isParcelLayerReady(id));
    if (missingFromIndex.length > 0) {
        const rehydrated = [];
        for (const id of missingFromIndex) {
            if (typeof readPersistedParcelRecord === 'function') {
                const record = readPersistedParcelRecord(id);
                if (record && record.geometry && record.properties) {
                    rehydrated.push({
                        type: 'Feature',
                        geometry: record.geometry,
                        properties: Object.assign({}, record.properties, { parcelId: id })
                    });
                }
            }
        }
        if (rehydrated.length > 0 && typeof ingestParcelFeatures === 'function') {
            try {
                await ingestParcelFeatures(rehydrated, { replaceExisting: false });
                console.debug(`[waitForParcelLayersReady] Rehydrated ${rehydrated.length} parcels from storage`);
            } catch (e) {
                console.warn('[waitForParcelLayersReady] Failed to ingest rehydrated parcels:', e);
            }
        }
    }

    const pending = new Set(scopedIds);
    const start = Date.now();
    while (pending.size && (Date.now() - start) < timeoutMs) {
        for (const id of Array.from(pending)) {
            if (isParcelLayerReady(id)) {
                pending.delete(id);
            }
        }
        if (!pending.size) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    if (pending.size) {
        console.warn('waitForParcelLayersReady timed out for parcels', Array.from(pending));
    }
}

function isParcelLayerReady(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : '';
    if (!normalized) {
        return false;
    }
    if (typeof resolveParcelLayerById === 'function') {
        return !!resolveParcelLayerById(normalized);
    }
    try {
        if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
            return false;
        }
        let found = false;
        parcelLayer.eachLayer(layer => {
            if (found) {
                return;
            }
            const candidate = getParcelIdFromFeature(layer?.feature);
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalized) {
                found = true;
            }
        });
        return found;
    } catch (_) {
        return false;
    }
}

async function stageSharedProposalDependencies(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) {
        return;
    }
    const suppressStatus = options && options.suppressStatus === true;
    const label = (options && options.label) ? options.label : 'shared proposal';
    const updateStageStatus = (message) => {
        if (options && typeof options.onStatusUpdate === 'function') {
            options.onStatusUpdate(message);
        } else if (!suppressStatus && typeof updateStatus === 'function' && message) {
            updateStatus(message);
        }
    };

    updateStageStatus(`Fetching parent parcels for ${label}…`);
    await ensureParentParcelsLoaded(ids, {
        preloadOwners: false,
        forceRefreshParcels: !!(options && options.forceRefreshParcels),
        onProgress: (current, total) => {
            updateStageStatus(`Fetching parent parcels for ${label} (${current}/${total})…`);
        }
    });
    await waitForParcelLayersReady(ids, {
        timeoutMs: options && Number.isFinite(options.renderTimeoutMs) ? options.renderTimeoutMs : undefined
    });

    updateStageStatus(`Fetching parcel owners for ${label}…`);
    await preloadProposalParcelOwners(ids, { forceRefresh: !!(options && options.forceOwnerRefresh) });

    updateStageStatus(`Parents ready for ${label}.`);
}

async function fetchParcelsForIds(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const unique = Array.from(new Set(parcelIds.map(id => id && id.toString ? id.toString() : id).filter(Boolean)));
    if (!unique.length) return;

    if (typeof fetchParcelsByIds === 'function') {
        await fetchParcelsByIds(unique, {
            forceRefresh: !!options.forceRefresh,
            onProgress: options.onProgress
        });
        return;
    }

    if (typeof fetchSingleParcelById === 'function') {
        await Promise.allSettled(unique.map(id => fetchSingleParcelById(id)));
        return;
    }

    if (typeof fetchParcelData === 'function') {
        try {
            await fetchParcelData();
        } catch (error) {
            console.warn('fetchParcelsForIds fallback fetchParcelData failed', error);
        }
    }
}

async function preloadProposalParcelOwners(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return;
    }
    if (typeof ensureParcelOwnerSlots !== 'function') {
        return;
    }
    const forceRefresh = options && options.forceRefresh === true;
    const uniqueIds = Array.from(new Set(
        parcelIds
            .map(id => (id && id.toString ? id.toString() : id))
            .filter(Boolean)
    ));
    if (!uniqueIds.length) {
        return;
    }

    await Promise.allSettled(uniqueIds.map(async parcelId => {
        try {
            await ensureParcelOwnerSlots(parcelId, { forceRefresh });
        } catch (error) {
            console.warn('preloadProposalParcelOwners: failed to fetch owners for', parcelId, error);
        }
    }));
}

function buildBoundsFromSharedPayload(payload) {
    try {
        if (payload && payload.bbox && typeof L !== 'undefined' && L && typeof L.latLngBounds === 'function') {
            const { south, west, north, east } = payload.bbox;
            if ([south, west, north, east].every(value => Number.isFinite(value))) {
                return L.latLngBounds([
                    [south, west],
                    [north, east]
                ]);
            }
        }
    } catch (_) { }
    return null;
}

function handleSharedProposalsFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (sharedProposalsHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('shared');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSharedProposalsFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (error) {
            showSimpleShareModal({
                title: tShare('invalidBulkTitle', 'Invalid Shared Proposals Link'),
                body: `<p>${tShare('invalidBulkBody', 'We could not decode the shared proposals link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('shared');
            cleanSharedQuery(params);
            sharedProposalsHandled = true;
            return;
        }

        params.delete('shared');
        cleanSharedQuery(params);
        sharedProposalsHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('noBulkTitle', 'No Proposals Found'),
                body: `<p>${tShare('noBulkBody', 'The shared link did not contain any proposals to apply.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        // Update Open Graph metadata for social sharing (use first proposal or create summary)
        if (typeof updateProposalOGMetadata === 'function' && payload.proposals.length > 0) {
            const firstProposal = payload.proposals[0];
            // Enhance with summary info if multiple proposals
            if (payload.proposals.length > 1) {
                const summaryProposal = {
                    ...firstProposal,
                    title: `${firstProposal.title || 'Proposal'} (+${payload.proposals.length - 1} more)`,
                    description: `A collection of ${payload.proposals.length} proposals shared on Consensus Builder. ${firstProposal.description || ''}`
                };
                updateProposalOGMetadata(summaryProposal);
            } else {
                updateProposalOGMetadata(firstProposal);
            }
        }

        // Before applying anything, show a full payload inspector with per-proposal checkboxes
        ; (async () => {
            try {
                const selected = await showSharedPayloadInspector(payload);
                if (!selected || !(selected instanceof Set)) {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('importCancelled', 'Shared proposal import cancelled.'));
                    }
                    return;
                }
                await applySharedProposalsFromPayload(payload, selected);
            } catch (e) {
                console.error('Shared payload inspector error:', e);
            }
        })();
    } catch (error) {
        console.error('handleSharedProposalsFromUrl failed', error);
    }
}

function cleanSharedQuery(params) {
    try {
        const entries = params.toString();
        const newUrl = `${window.location.origin}${window.location.pathname}${entries ? `?${entries}` : ''}${window.location.hash || ''}`;
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState({}, document.title, newUrl);
        }
    } catch (error) {
        console.warn('Failed to clean shared query params', error);
    }
}

async function applySharedProposalsFromPayload(payload, selectedIds) {
    try {
        // Suppress camera moves for the duration of shared apply
        try { window.suppressCameraMoves = true; } catch (_) { }
        let proposals = Array.isArray(payload.proposals) ? payload.proposals.slice() : [];
        if (selectedIds && selectedIds.size >= 0) {
            proposals = proposals.filter(p => selectedIds.has(getProposalKey(p)));
        }
        if (proposals.length === 0) return;

        if (typeof updateStatus === 'function') {
            updateStatus(`Applying ${proposals.length} shared proposal${proposals.length === 1 ? '' : 's'}...`);
        }

        // Do not move camera; if bbox is provided, fetch parcels for that area explicitly
        if (typeof fetchParcelData === 'function') {
            const bounds = (function () {
                try {
                    if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                        return L.latLngBounds([
                            [payload.bbox.south, payload.bbox.west],
                            [payload.bbox.north, payload.bbox.east]
                        ]);
                    }
                } catch (_) { }
                return null;
            })();
            await fetchParcelData(bounds || undefined);
        }

        // No global ancestor pre-check; proceed proposal by proposal

        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        const sorted = proposals.slice().sort((a, b) => {
            // Extract numeric ID from proposalId (e.g., "58" or "local-3" -> 3)
            const extractNumericId = (proposal) => {
                if (!proposal || !proposal.proposalId) return null;
                const str = String(proposal.proposalId);
                if (/^\d+$/.test(str)) {
                    return parseInt(str, 10);
                }
                const match = str.match(/^local-(\d+)$/);
                if (match) {
                    return parseInt(match[1], 10);
                }
                return null;
            };
            const aId = extractNumericId(a);
            const bId = extractNumericId(b);
            const aHasId = aId !== null && Number.isFinite(aId);
            const bHasId = bId !== null && Number.isFinite(bId);
            if (aHasId && bHasId) {
                return aId - bId; // includes 0
            }
            if (aHasId && !bHasId) return -1;
            if (!aHasId && bHasId) return 1;
            const aRaw = new Date(a.createdAt || 0).getTime();
            const bRaw = new Date(b.createdAt || 0).getTime();
            const aTime = Number.isFinite(aRaw) ? aRaw : 0;
            const bTime = Number.isFinite(bRaw) ? bRaw : 0;
            return aTime - bTime;
        });

        const actuallyApplied = [];
        const skipped = [];
        const failures = [];
        const blockedAncestors = new Map();
        let lastLoadedProposalIdFor3D = null;

        let pending = sorted.slice();
        const maxPasses = 8;
        let pass = 0;

        while (pending.length && pass < maxPasses) {
            pass += 1;
            let progress = false;
            const nextPending = [];

            for (const proposal of pending) {
                try {
                    if (typeof updateStatus === 'function') {
                        const displayId = proposal.proposalId ? String(proposal.proposalId) : '?';
                        updateStatus(t('status.messages.applying_specific_shared_proposal', `Applying shared proposal ${proposal.title || ''} #${displayId}...`, {
                            title: proposal.title || '',
                            id: displayId
                        }));
                    }
                } catch (_) { }

                const result = await importAndApplySharedProposal(proposal);
                const proposalId = (result && result.proposalId) || getProposalKey(proposal) || proposal.proposalId;

                if (result && result.skipped) {
                    skipped.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    continue;
                }

                if (result && result.applied) {
                    actuallyApplied.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    await new Promise(res => setTimeout(res, 3000));
                    continue;
                }

                const ancestryCheck = (proposalId && typeof ProposalManager !== 'undefined' && typeof ProposalManager.canApplyProposal === 'function')
                    ? ProposalManager.canApplyProposal(proposalId)
                    : { ok: true, missing: [] };

                if (!ancestryCheck.ok && ancestryCheck.missing.length) {
                    blockedAncestors.set(proposalId || proposal.title || `pending-${pass}-${nextPending.length}`, {
                        missing: ancestryCheck.missing.slice(),
                        proposal
                    });
                    nextPending.push(proposal);
                    continue;
                }

                failures.push(proposalId || proposal.proposalId || '');
                progress = true;
            }

            pending = nextPending;
            if (!progress) break;
        }

        pending.forEach(proposal => {
            const hash = getProposalKey(proposal) || proposal.proposalId || proposal.title || 'unknown';
            if (!blockedAncestors.has(hash)) {
                blockedAncestors.set(hash, { missing: [], proposal });
            }
        });

        if (actuallyApplied.length > 0 || skipped.length > 0 || failures.length > 0 || blockedAncestors.size > 0) {
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }

            // Center map on the last applied proposal's descendant parcels
            const lastProposalId = lastLoadedProposalIdFor3D
                || (actuallyApplied.length > 0 ? actuallyApplied[actuallyApplied.length - 1] : null)
                || (skipped.length > 0 ? skipped[skipped.length - 1] : null);
            if (lastProposalId && typeof map !== 'undefined' && map) {
                try {
                    const bounds = calculateBoundsForLastAppliedProposal(lastProposalId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                } catch (error) {
                    console.warn('Failed to center map on last applied proposal:', error);
                }
            }

            // Do not auto-enable proposals mode; keep interactions normal
            const bodyLines = [];
            const authorName = payload.author || t('common.userFallback', 'User');
            bodyLines.push(`<p>${tShare('summary.appliedFrom', 'Applied proposals from {{author}}.', { author: escapeHtml(authorName) })}</p>`);
            if (actuallyApplied.length > 0) {
                bodyLines.push(`<p>${tShare('summary.appliedCount', '{{count}} applied.', {
                    count: actuallyApplied.length,
                    suffix: actuallyApplied.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (skipped.length > 0) {
                bodyLines.push(`<p>${tShare('summary.skippedCount', 'Skipped {{count}} duplicate proposal{{suffix}} (already present).', {
                    count: skipped.length,
                    suffix: skipped.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (failures.length > 0) {
                bodyLines.push(`<p>${tShare('summary.failedCount', '{{count}} failed.', {
                    count: failures.length,
                    suffix: failures.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (blockedAncestors.size > 0) {
                const blockedList = Array.from(blockedAncestors.entries());
                const limitedBlocked = blockedList.slice(0, 5);
                const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
                bodyLines.push(`<p>${tShare('summary.blockedAncestors', 'Blocked by missing applied ancestors:')}</p><ul>${limitedBlocked.map(([hash, info]) => {
                    const label = info && info.proposal && info.proposal.title
                        ? `${escape(info.proposal.title)}${hash ? ` (${escape(hash)})` : ''}`
                        : escape(hash || '');
                    const missingList = info && info.missing && info.missing.length ? escape(info.missing.join(', ')) : '';
                    return `<li>${label}${missingList ? ` · ${missingList}` : ''}</li>`;
                }).join('')}${blockedList.length > limitedBlocked.length ? '<li>…</li>' : ''}</ul>`);
            }
            showSimpleShareModal({
                title: tShare('summary.title', 'Applied Shared Proposals'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: tShare('summary.unapplyApplied', 'Unapply applied'),
                        onClick: () => {
                            try {
                                const hasFamilyUnapply = typeof ProposalManager !== 'undefined' && typeof ProposalManager.unapplyWholeFamily === 'function';
                                actuallyApplied.forEach(hash => {
                                    try {
                                        if (hasFamilyUnapply) {
                                            ProposalManager.unapplyWholeFamily(hash);
                                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                                            ProposalManager.unapplyProposal(hash, { skipConfirm: true });
                                        }
                                    } catch (_) { }
                                });
                                // Refresh UI once after all bulk unapplies
                                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                                    ProposalManager._refreshUIAfterProposalChange(null);
                                }
                            } catch (_) { }
                        }
                    }] : [])
                ]
            });

            // Firmly return to parcel-mode hover/leave behavior
            try { clearProposalInfoHoverOverlay(); } catch (_) { }
            try { clearProposalHighlights(); } catch (_) { }
            try { if (typeof setParcelNumberLabelFilter === 'function') setParcelNumberLabelFilter(null); } catch (_) { }
        }

        if ((failures.length > 0 || blockedAncestors.size > 0) && typeof showEphemeralMessage === 'function') {
            const blockedCount = blockedAncestors.size;
            const failureCount = failures.length;
            const total = failureCount + blockedCount;
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals_summary', `Unable to apply ${total} shared proposal${total === 1 ? '' : 's'} (missing ancestors or errors).`, {
                count: total,
                suffix: total === 1 ? '' : 's'
            }), 6000, 'error');
        }

        // Optional URL-driven 3D mode: after shared apply completes, center on all proposals then enter 3D.
        try {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                // Wait for map centering to complete (if we centered on proposals above)
                const allProposalIds = [...actuallyApplied, ...skipped].filter(Boolean);
                if (allProposalIds.length > 0) {
                    await createLeafletViewSettlePromise(null, null);
                }
                // Enter 3D mode - camera will rotate around the current map center (which is the center of proposals)
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        } catch (_) { }
    } catch (error) {
        console.error('applySharedProposalsFromPayload failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals', 'Failed to apply shared proposals.'), 6000, 'error');
        }
    } finally {
        // Re-enable camera moves after shared apply completes
        try { window.suppressCameraMoves = false; } catch (_) { }
    }
}

function computeRequiredParentIdsForSharedProposal(sp) {
    if (!sp || typeof sp !== 'object') return [];
    if (sp.reparcellization && Array.isArray(sp.reparcellization.polygons) && sp.reparcellization.polygons.length > 0) {
        // Reparcellization plans render their own geometry and do not depend on ancestor parcels being present locally.
        return [];
    }
    if (sp.roadProposal && Array.isArray(sp.roadProposal.parentParcelIds) && sp.roadProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.roadProposal.parentParcelIds);
    }
    if (sp.buildingProposal && Array.isArray(sp.buildingProposal.parentParcelIds) && sp.buildingProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.buildingProposal.parentParcelIds);
    }
    if (Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.parentParcelIds);
    }
    return [];
}

// Show a modal that displays the fully decoded shared payload and allows selecting proposals to apply
function showSharedPayloadInspector(payload) {
    return new Promise(resolve => {
        try {
            const t = getProposalI18nHelper();
            const tShare = getShareI18nHelper();
            const tShared = getSharedInspectorI18nHelper();
            const unknownText = t('common.unknown', 'Unknown');
            const container = document.createElement('div');
            container.className = 'shared-payload-inspector';

            // Summary
            const summary = document.createElement('div');
            summary.className = 'spi-summary';
            const total = Array.isArray(payload.proposals) ? payload.proposals.length : 0;
            const bytes = (() => { try { return new TextEncoder().encode(JSON.stringify(payload)).length; } catch (_) { return 0; } })();
            const kb = (bytes / 1024).toFixed(1);
            summary.innerHTML = `
                <p><strong>${tShared('author', 'Author:')}</strong> ${escapeHtml(payload.author || unknownText)}
                &nbsp;•&nbsp;<strong>${tShared('version', 'Version:')}</strong> ${String(payload.version ?? '')}
                &nbsp;•&nbsp;<strong>${tShared('generated', 'Generated:')}</strong> ${escapeHtml(payload.generatedAt || '')}
                &nbsp;•&nbsp;<strong>${tShared('count', 'Proposals:')}</strong> ${total}
                &nbsp;•&nbsp;<strong>${tShared('payload', 'Payload:')}</strong> ~${kb} KB</p>
            `;
            container.appendChild(summary);

            // Full JSON view (collapsible)
            const detailsWrap = document.createElement('details');
            const detailsSum = document.createElement('summary');
            detailsSum.textContent = tShared('viewJson', 'View full decoded payload JSON');
            detailsWrap.appendChild(detailsSum);
            const pre = document.createElement('pre');
            pre.style.maxHeight = '240px';
            pre.style.overflow = 'auto';
            pre.textContent = (() => { try { return JSON.stringify(payload, null, 2); } catch (_) { return '[unserializable]'; } })();
            detailsWrap.appendChild(pre);
            container.appendChild(detailsWrap);

            // Proposal selection list
            const list = document.createElement('div');
            list.className = 'spi-proposal-list';
            const selected = new Set();
            (payload.proposals || []).forEach((p, idx) => {
                const item = document.createElement('div');
                item.className = 'spi-proposal-item';
                item.style.border = '1px solid #ddd';
                item.style.borderRadius = '6px';
                item.style.padding = '8px';
                item.style.marginBottom = '8px';

                const id = `spi-prop-${idx}-${(p.proposalId || '').slice(0, 8)}`;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = id;
                checkbox.checked = true;
                checkbox.dataset.hash = p.proposalId || '';
                checkbox.addEventListener('change', () => {
                    const h = checkbox.dataset.hash;
                    if (!h) return;
                    if (checkbox.checked) selected.add(h); else selected.delete(h);
                });

                // Default add to selection
                if (p.proposalId) selected.add(p.proposalId);

                const label = document.createElement('label');
                label.setAttribute('for', id);
                const displayId = p.proposalId ? String(p.proposalId) : '';
                const title = `${p.title || tShare('untitled', '(Untitled)')}${displayId ? ` (ID #${displayId})` : ''}`;
                label.innerHTML = `<strong>${escapeHtml(title)}</strong> • ${escapeHtml(p.type || 'parcel')} • ${escapeHtml(p.proposalId || '')}`;

                const meta = document.createElement('div');
                meta.className = 'spi-proposal-meta';
                const parentIdsDisplay = Array.isArray(p.parentParcelIds) ? p.parentParcelIds.join(', ') : '';
                const roadParents = (p.roadProposal && Array.isArray(p.roadProposal.parentParcelIds)) ? p.roadProposal.parentParcelIds.join(', ') : '';
                const buildingParents = (p.buildingProposal && Array.isArray(p.buildingProposal.parentParcelIds)) ? p.buildingProposal.parentParcelIds.join(', ') : '';
                meta.innerHTML = `
                    <small>
                        ${tShared('ancestorIds', 'Parent Parcel IDs:')} ${escapeHtml(parentIdsDisplay)}<br>
                        ${tShared('roadParents', 'Road parents:')} ${escapeHtml(roadParents)}<br>
                        ${tShared('buildingParents', 'Building parents:')} ${escapeHtml(buildingParents)}
                    </small>
                `;

                const propDetails = document.createElement('details');
                const propSummary = document.createElement('summary');
                propSummary.textContent = tShared('details', 'Details');
                propDetails.appendChild(propSummary);
                const propPre = document.createElement('pre');
                propPre.style.maxHeight = '180px';
                propPre.style.overflow = 'auto';
                try { propPre.textContent = JSON.stringify(p, null, 2); } catch (_) { propPre.textContent = '[unserializable]'; }
                propDetails.appendChild(propPre);

                item.appendChild(checkbox);
                item.appendChild(label);
                item.appendChild(meta);
                item.appendChild(propDetails);
                list.appendChild(item);
            });
            container.appendChild(list);

            const modal = showSimpleShareModal({
                title: tShared('title', 'Review Shared Proposals'),
                body: container,
                actions: [
                    {
                        label: t('modal.common.cancel', 'Cancel'),
                        onClick: () => resolve(null)
                    },
                    {
                        id: 'apply',
                        label: tShared('loading', 'Parcels still loading...'),
                        primary: true,
                        disabled: true,
                        onClick: () => resolve(selected)
                    }
                ]
            });

            // Extra safety: ensure button starts disabled right after modal mount
            try {
                const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                if (applyBtn) {
                    applyBtn.disabled = true;
                    applyBtn.classList.add('disabled');
                    applyBtn.textContent = tShared('loading', 'Parcels still loading...');
                }
            } catch (_) { }

            // Kick off parcel fetching for bbox only (no camera move); enable Apply once done
            (async () => {
                try {
                    try { window.suppressCameraMoves = true; } catch (_) { }
                    if (typeof fetchParcelData === 'function') {
                        const bounds = (function () {
                            try {
                                if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                                    return L.latLngBounds([
                                        [payload.bbox.south, payload.bbox.west],
                                        [payload.bbox.north, payload.bbox.east]
                                    ]);
                                }
                            } catch (_) { }
                            return null;
                        })();
                        await fetchParcelData(bounds || undefined);
                    }
                } catch (e) {
                    console.warn('Prefetch parcels for shared payload failed (continuing):', e);
                } finally {
                    try {
                        const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                        if (applyBtn) {
                            applyBtn.disabled = false;
                            applyBtn.classList.remove('disabled');
                            applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                        }
                    } catch (_) { }
                    try { window.suppressCameraMoves = false; } catch (_) { }
                }
            })();

            // As a fallback, also enable on parcelDataLoaded event (in case of cached data or fast path)
            const onParcelLoaded = () => {
                try {
                    const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                    if (applyBtn) {
                        applyBtn.disabled = false;
                        applyBtn.classList.remove('disabled');
                        applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                    }
                } catch (_) { }
                try { window.removeEventListener('parcelDataLoaded', onParcelLoaded); } catch (_) { }
            };
            try { window.addEventListener('parcelDataLoaded', onParcelLoaded, { once: true }); } catch (_) { }
        } catch (e) {
            console.error('showSharedPayloadInspector failed', e);
            resolve(null);
        }
    });
}

function savePlanPayloadAsJson(payload) {
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `consensus-plan-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Failed to save plan JSON', e);
        try {
            const tShare = getShareI18nHelper();
            const message = tShare('saveJsonError', 'Failed to save JSON.');
            const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
            if (typeof alertFn === 'function') {
                alertFn(message);
            }
        } catch (_) {
            const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
            if (typeof alertFn === 'function') {
                alertFn('Failed to save JSON.');
            }
        }
    }
}

function gatherParentParcelIdsFromSharedProposals(proposals) {
    // Only use the explicit parentParcelIds field from each proposal
    const ids = new Set();
    proposals.forEach(p => {
        const list = Array.isArray(p.parentParcelIds) ? p.parentParcelIds : [];
        ensureArrayOfStrings(list).forEach(id => ids.add(id));
    });
    return ids;
}

function findMissingParentParcels(parentIds) {
    if (!Array.isArray(parentIds) || parentIds.length === 0) return [];

    // Check if parcelLayer is available before checking for missing parcels
    // This prevents warnings when the layer isn't ready yet
    const isParcelLayerReady = (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') ||
        (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function');

    if (!isParcelLayerReady) {
        // If parcel layer isn't ready, assume all parcels are missing (they'll be loaded)
        return parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean);
    }

    const missing = [];
    parentIds.forEach(id => {
        const parcelId = id && id.toString ? id.toString() : String(id);
        if (!parcelId) return;
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(parcelId)
            : null;
        if (!layer || !layer.feature) {
            missing.push(parcelId);
        }
    });
    return missing;
}

// Intentionally a no-op to avoid camera movement during shared apply
async function focusMapForSharedPayload(_payload) { return; }

function waitForMapIdle() {
    return new Promise(resolve => {
        if (typeof map === 'undefined' || !map || typeof map.once !== 'function') {
            resolve();
            return;
        }
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve();
            }
        }, 800);
        map.once('moveend', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve();
            }
        });
    });
}

function promptMissingParentParcelsModal(missing, author, problem) {
    return new Promise(resolve => {
        const limited = missing.slice(0, 8);
        const listHtml = limited.length > 0
            ? `<ul>${limited.map(id => `<li>${id}</li>`).join('')}${missing.length > limited.length ? '<li>…</li>' : ''}</ul>`
            : '';
        const modal = showSimpleShareModal({
            title: 'Missing Parent Parcels',
            body: `<p>We could not find ${missing.length} parent parcel${missing.length === 1 ? '' : 's'} required to apply the shared proposals${author ? ` from ${author}` : ''}.</p>${problem ? `<p><strong>Problem proposal:</strong> ${problem.title ? escapeHtml(problem.title) : '(Untitled)'}${problem.proposalId ? ` (ID #${escapeHtml(String(problem.proposalId))})` : ''}</p>` : ''}<p>You can cancel loading or refresh parcel data (this will clear local work) and try again.</p>${listHtml}`,
            actions: [
                {
                    label: 'Cancel load',
                    onClick: () => resolve('cancel')
                },
                {
                    label: 'Lose local work, refresh & apply',
                    primary: true,
                    onClick: () => resolve('refresh')
                }
            ]
        });

        if (!modal) {
            const confirmRefresh = confirm('Missing parent parcels are required to load shared proposals. Refresh parcel data (clears local work)?');
            resolve(confirmRefresh ? 'refresh' : 'cancel');
        }
    });
}

function prepareProposalForImport(sharedProposal) {
    if (!sharedProposal || typeof sharedProposal !== 'object') return null;

    const parentIds = ensureArrayOfStrings(sharedProposal.parentParcelIds);
    const inferredGoal = (() => {
        try {
            const explicit = normalizeProposalGoalKey(sharedProposal.goal);
            if (explicit) return explicit;
            if (sharedProposal.decideLaterProposal) return 'decide-later';
            if (sharedProposal.roadProposal) return 'road-track';
            if (sharedProposal.reparcellization) return 'reparcellization';
            if (sharedProposal.structureProposal && sharedProposal.structureProposal.kind) {
                const kind = normalizeProposalGoalKey(sharedProposal.structureProposal.kind);
                if (kind === 'park' || kind === 'square' || kind === 'lake') return kind;
            }
            if (sharedProposal.buildingProposal || (sharedProposal.geometry && Array.isArray(sharedProposal.geometry.buildings) && sharedProposal.geometry.buildings.length)) {
                return 'buildings';
            }
            return 'parcel';
        } catch (_) {
            return 'parcel';
        }
    })();

    const isDecideLater = inferredGoal === 'decide-later';

    // Preserve server ID for lookup by URL parameter later.
    const serverId = sharedProposal.id || sharedProposal.proposalId || sharedProposal.proposal_id;
    const serverProposalId = (serverId && /^\d+$/.test(String(serverId))) ? String(serverId) : (sharedProposal.serverProposalId || null);

    const base = {
        proposalId: sharedProposal.proposalId || sharedProposal.proposal_id || sharedProposal.id || null,
        serverProposalId,
        title: sharedProposal.title || sharedProposal.name || null,
        goal: inferredGoal,
        acceptedParcelIds: ensureArrayOfStrings(sharedProposal.acceptedParcelIds),
        author: sharedProposal.author || sharedProposal.createdBy || sharedProposal.owner || null,
        description: typeof sharedProposal.description === 'string' ? sharedProposal.description : '',
        offer: (typeof sharedProposal.offer === 'number') ? sharedProposal.offer : (sharedProposal.offer || null),
        createdAt: sharedProposal.createdAt || new Date().toISOString(),
        updatedAt: sharedProposal.updatedAt || sharedProposal.createdAt || new Date().toISOString(),
        status: sharedProposal.status || 'Active',
        color: sharedProposal.color || null,
        parentParcelIds: parentIds
    };
    const lensEntries = normalizeLensEntries(sharedProposal.lens || sharedProposal.lensEntries || sharedProposal.lensAddresses);
    if (lensEntries.length) {
        base.lens = lensEntries;
    }

    // Decide-later proposals intentionally have no uploaded geometry.
    // They are applied by deriving geometry from parent parcels on the target.
    if (isDecideLater) {
        const raw = sharedProposal.decideLaterProposal && typeof sharedProposal.decideLaterProposal === 'object'
            ? sharedProposal.decideLaterProposal
            : {};
        const parentParcelIds = ensureArrayOfStrings(raw.parentParcelIds && raw.parentParcelIds.length ? raw.parentParcelIds : base.parentParcelIds);
        const childParcelIds = ensureArrayOfStrings(raw.childParcelIds || sharedProposal.childParcelIds || []);
        base.decideLaterProposal = {
            ...deepClone(raw),
            parentParcelIds,
            childParcelIds,
            status: raw.status || base.status || 'Active'
        };
        if (base.parentParcelIds.length === 0 && parentParcelIds.length > 0) {
            base.parentParcelIds = parentParcelIds.slice();
        }
    }

    if (sharedProposal.roadProposal) {
        const childParcelIds = ensureArrayOfStrings(sharedProposal.roadProposal.childParcelIds || []);
        base.roadProposal = {
            definition: deepClone(sharedProposal.roadProposal.definition),
            childParcelIds,
            roadGeometry: deepClone(sharedProposal.roadProposal.roadGeometry),
            metadata: deepClone(sharedProposal.roadProposal.metadata),
            status: 'unapplied',
            parentFeatures: [],
            parentParcelIds: ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        };
    }

    if (sharedProposal.buildingProposal) {
        const bp = sharedProposal.buildingProposal;
        const buildingFeatures = (() => {
            const features = [];
            if (sharedProposal.geometry && Array.isArray(sharedProposal.geometry.buildings)) {
                deepCloneArray(sharedProposal.geometry.buildings)
                    .filter(feature => feature && feature.geometry)
                    .forEach(feature => features.push(feature));
            }
            if (!features.length && Array.isArray(bp.buildings)) {
                bp.buildings
                    .map(entry => entry && entry.feature ? deepClone(entry.feature) : null)
                    .filter(feature => feature && feature.geometry)
                    .forEach(feature => features.push(feature));
            }
            return features;
        })();

        base.buildingProposal = {
            parameters: deepClone(bp.parameters) || {},
            parentParcelIds: ensureArrayOfStrings(bp.parentParcelIds),
            parentParcelNumbers: deepCloneArray(bp.parentParcelNumbers),
            ancestorKey: bp.ancestorKey || ensureArrayOfStrings(bp.parentParcelIds).join('|'),
            status: 'unapplied'
        };
        if (base.buildingProposal.parentParcelIds.length === 0) {
            base.buildingProposal.parentParcelIds = base.parentParcelIds.slice();
        }
        if (buildingFeatures.length) {
            base.geometry = base.geometry || {};
            base.geometry.buildings = deepCloneArray(buildingFeatures);
        }
    }

    // Structure proposals (parks/squares)
    if (sharedProposal.structureProposal && !isDecideLater) {
        base.structureProposal = {
            kind: (sharedProposal.structureProposal.kind === 'park' || sharedProposal.structureProposal.kind === 'square' || sharedProposal.structureProposal.kind === 'lake') ? sharedProposal.structureProposal.kind : 'square',
            geometry: deepClone(sharedProposal.structureProposal.geometry),
            blockName: sharedProposal.structureProposal.blockName || null,
            parentParcelIds: ensureArrayOfStrings(sharedProposal.structureProposal.parentParcelIds && sharedProposal.structureProposal.parentParcelIds.length ? sharedProposal.structureProposal.parentParcelIds : base.parentParcelIds)
        };
        base.goal = normalizeProposalGoalKey(base.structureProposal.kind) || base.goal;
    }

    if (sharedProposal.reparcellization && Array.isArray(sharedProposal.reparcellization.polygons) && sharedProposal.reparcellization.polygons.length > 0) {
        const reparcelParcelIds = (sharedProposal.reparcellization.parcelIds && sharedProposal.reparcellization.parcelIds.length > 0)
            ? ensureArrayOfStrings(sharedProposal.reparcellization.parcelIds)
            : (base.parentParcelIds.length > 0 ? base.parentParcelIds.slice() : []);
        const ownerShares = deepCloneArray(sharedProposal.reparcellization.ownerShares);
        const polygons = deepCloneArray(sharedProposal.reparcellization.polygons);

        base.goal = 'reparcellization';
        base.reparcellization = {
            algorithm: sharedProposal.reparcellization.algorithm || 'sweep-line',
            generatedAt: sharedProposal.reparcellization.generatedAt || sharedProposal.generatedAt || new Date().toISOString(),
            parcelIds: reparcelParcelIds.slice(),
            totalArea: Number.isFinite(Number(sharedProposal.reparcellization.totalArea))
                ? Number(sharedProposal.reparcellization.totalArea)
                : null,
            ownerShares,
            polygons,
            status: 'unapplied'
        };

        if (base.parentParcelIds.length === 0 && reparcelParcelIds.length > 0) {
            base.parentParcelIds = reparcelParcelIds.slice();
        }
    }

    return base;
}

/**
 * Ensures ancestor parcels are fetched and available for a proposal.
 * This is needed for ALL proposal types, not just roads.
 * Returns the list of ancestor parcel IDs that were fetched.
 */
async function ensureParentParcelsFetched(sharedProposal, normalized) {
    const parentIds = computeRequiredParentIdsForSharedProposal(sharedProposal);
    if (parentIds.length === 0) {
        return [];
    }

    // Check which parcels are missing and fetch them
    const missingIds = [];
    parentIds.forEach(id => {
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(id)
            : null;
        if (!layer || !layer.feature) {
            missingIds.push(id);
        }
    });

    if (missingIds.length > 0) {
        // Fetch missing parcels from server/local storage
        try {
            await fetchParcelsForIds(missingIds, { forceRefresh: false });
        } catch (error) {
            console.warn('Failed to fetch ancestor parcels for proposal', sharedProposal.proposalId, error);
            throw error;
        }
    }

    return parentIds;
}

/**
 * Ensures parentParcelIds are set on road proposals.
 * The geometries will be fetched by ID when needed by the reconstruction algorithm.
 */
function ensureRoadParentParcelIds(sharedProposal, normalized, parentIds) {
    if (!normalized.roadProposal) return true;

    // Prefer explicit parentParcelIds from shared payload; fallback to ancestor/parcel ids
    let candidateIds = [];
    const explicitParents = sharedProposal.roadProposal && Array.isArray(sharedProposal.roadProposal.parentParcelIds)
        ? ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        : [];
    if (explicitParents.length > 0) {
        candidateIds = explicitParents;
    }
    if (candidateIds.length === 0) {
        candidateIds = parentIds.length > 0 ? parentIds : [];
    }

    if (candidateIds.length === 0) {
        console.warn('No parent parcel IDs found for road proposal', sharedProposal.proposalId);
        return false;
    }

    // Just store the IDs - geometries will be fetched when needed
    normalized.roadProposal.parentParcelIds = candidateIds;
    return true;
}

async function importAndApplySharedProposal(sharedProposal, options = {}) {
    const fallbackHash = sharedProposal ? (sharedProposal.proposalId || getProposalKey(sharedProposal)) : null;
    if (!sharedProposal || !sharedProposal.proposalId) return { applied: false, skipped: false, proposalId: fallbackHash, reason: 'Missing proposal payload' };

    const normalized = prepareProposalForImport(sharedProposal);
    const proposalId = normalized?.proposalId || fallbackHash;
    if (!normalized) return { applied: false, skipped: false, proposalId, reason: 'Unable to normalize shared proposal' };

    // If this proposal is already present and already applied/executed, do not fetch parcels or touch map state.
    // This keeps /proposals/:id1,id2 "apply plan" idempotent and prevents ancestor parcel redraw side effects.
    const existing = proposalStorage.getProposal(normalized.proposalId);
    if (existing) {
        const alreadyApplied = isProposalCurrentlyApplied(existing) || existing.status === 'Executed';
        if (alreadyApplied) {
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            return { applied: false, skipped: true, proposalId, reason: 'Already applied' };
        }
    }

    const skipDependencyFetch = options && options.skipDependencyFetch === true;
    const applyOptions = skipDependencyFetch ? { suppressMissingParentAlerts: true } : {};

    // Some flows (notably /proposals/:id1,id2,...) want to apply a queue where missing parcels
    // are expected to appear after other proposals apply. In that case do NOT fetch parcels here;
    // let ProposalManager apply or throw, and let the caller requeue.
    let parentIds = [];
    if (!skipDependencyFetch) {
        try {
            parentIds = await ensureParentParcelsFetched(sharedProposal, normalized);
        } catch (error) {
            console.warn('Failed to fetch parent parcels for shared proposal', sharedProposal.proposalId, error);
            return { applied: false, skipped: false, proposalId, reason: `Failed to fetch parent parcels: ${error && error.message ? error.message : 'unknown error'}` };
        }
    } else {
        try {
            parentIds = ensureArrayOfStrings(computeRequiredParentIdsForSharedProposal(sharedProposal));
        } catch (_) {
            parentIds = [];
        }
    }

    // For road proposals: ensure parentParcelIds are set
    // (geometries will be fetched by ID when needed for reconstruction)
    if (normalized.roadProposal) {
        if (!ensureRoadParentParcelIds(sharedProposal, normalized, parentIds)) {
            console.warn('Missing parent parcel IDs for road proposal', sharedProposal.proposalId);
            return { applied: false, skipped: false, proposalId, reason: 'Missing parent parcel IDs for road proposal' };
        }
    }

    if (existing) {
        // Try applying existing without re-importing (idempotent)
        // For roads, ensure parent features exist on stored object
        if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
            existing.roadProposal = existing.roadProposal || {};
            existing.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(existing);
            }
            proposalStorage.save();
        }
        const appliedExisting = await ProposalManager.applyProposal(existing.proposalId, applyOptions);
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        if (appliedExisting) {
            return { applied: true, skipped: false, proposalId };
        }

        if (skipDependencyFetch) {
            try {
                const last = (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager.getLastApplyFailure === 'function')
                    ? ProposalManager.getLastApplyFailure(existing.proposalId)
                    : null;
                if (last) {
                    return { applied: false, skipped: false, proposalId, reason: last };
                }
            } catch (_) { }
        }

        // If apply failed and we *did* do dependency fetch, provide a reason that upstream
        // can treat as retryable. (When skipDependencyFetch=true, caller will handle via thrown errors.)
        if (!skipDependencyFetch) {
            try {
                const required = ensureArrayOfStrings(parentIds);
                const missing = findMissingParentParcels(required);
                if (missing && missing.length > 0) {
                    const sample = missing.slice(0, 10).join(', ');
                    const suffix = missing.length > 10 ? '…' : '';
                    return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
                }
            } catch (_) { }
        }

        return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
    }

    // Fresh import then apply
    const imported = proposalStorage.importProposal(normalized, { overwrite: true });
    if (!imported) {
        return { applied: false, skipped: false, proposalId, reason: 'Failed to import proposal' };
    }

    if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
        imported.roadProposal = imported.roadProposal || {};
        imported.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(imported);
        }
        proposalStorage.save();
    }

    const applied = await ProposalManager.applyProposal(normalized.proposalId, applyOptions);
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
    if (applied) {
        return { applied: true, skipped: false, proposalId };
    }

    if (skipDependencyFetch) {
        try {
            const last = (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager.getLastApplyFailure === 'function')
                ? ProposalManager.getLastApplyFailure(normalized.proposalId)
                : null;
            if (last) {
                return { applied: false, skipped: false, proposalId, reason: last };
            }
        } catch (_) { }
    }

    if (!skipDependencyFetch) {
        try {
            const required = ensureArrayOfStrings(parentIds);
            const missing = findMissingParentParcels(required);
            if (missing && missing.length > 0) {
                const sample = missing.slice(0, 10).join(', ');
                const suffix = missing.length > 10 ? '…' : '';
                return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
            }
        } catch (_) { }
    }

    return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
}

// Make functions available globally
window.requirePersonalizedUser = requirePersonalizedUser;
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.switchProposalTab = switchProposalTab;
window.closeProposalList = closeProposalList;
window.showProposalDetailsModal = showProposalDetailsModal;
window.updateShowProposalsButton = updateShowProposalsButton;
window.updateProposalLayer = updateProposalLayer;
window.toggleExpiryInput = toggleExpiryInput;
window.toggleDecayInput = toggleDecayInput;
window.calculateDecayedOffer = calculateDecayedOffer;
window.getDecayProgress = getDecayProgress;
window.initializeDecayCountdown = initializeDecayCountdown;
window.isProposalExpired = isProposalExpired;
window.checkAndUpdateProposalExpiry = checkAndUpdateProposalExpiry;
window.initializeExpiryCountdown = initializeExpiryCountdown;
window.clearLocalProposalData = clearLocalProposalData;
window.centerOnProposal = centerOnProposal;
window.reapplyProposalHighlights = reapplyProposalHighlights;
window.selectProposalFromList = selectProposalFromList;
window.cancelMultiParcelSelection = cancelMultiParcelSelection;
window.deleteProposal = deleteProposal;
window.handleMultiSelectChange = handleMultiSelectChange;
window.handleShowProposalsChange = handleShowProposalsChange;
window.enableShowProposalsMode = enableShowProposalsMode;
window.refreshProposalData = refreshProposalData;
window.selectAndHighlightProposal = selectAndHighlightProposal;
window.calculateProposalBounds = calculateProposalBounds;
window.shareAppliedProposals = shareAppliedProposals;

let proposalLoadOverlay = null;
let proposalLoadStatusEl = null;
let proposalLoadTitleEl = null;
let proposalLoadBytesEl = null;
let proposalLoadBytes = 0;
let proposalLoadProgressTextEl = null;
let proposalLoadProgressBarEl = null;
let proposalLoadProgressFillEl = null;
let proposalLoadProgressDone = 0;
let proposalLoadProgressTotal = 0;

function ensureProposalLoadOverlay() {
    if (proposalLoadOverlay) return proposalLoadOverlay;

    const styleId = 'proposal-load-overlay-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            @keyframes proposal-load-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .proposal-load-spinner { width: 28px; height: 28px; border: 3px solid #d0d7de; border-top-color: #0d3b66; border-radius: 50%; animation: proposal-load-spin 0.9s linear infinite; margin-bottom: 12px; }
        `;
        document.head.appendChild(style);
    }

    proposalLoadOverlay = document.createElement('div');
    proposalLoadOverlay.style.position = 'fixed';
    proposalLoadOverlay.style.inset = '0';
    proposalLoadOverlay.style.background = 'rgba(0,0,0,0.35)';
    proposalLoadOverlay.style.zIndex = '12050';
    proposalLoadOverlay.style.display = 'none';
    proposalLoadOverlay.style.alignItems = 'center';
    proposalLoadOverlay.style.justifyContent = 'center';

    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.borderRadius = '12px';
    card.style.padding = '20px 22px';
    card.style.width = '320px';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
    card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    card.style.textAlign = 'center';

    proposalLoadTitleEl = document.createElement('div');
    const initialTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    proposalLoadTitleEl.textContent = initialTitle;
    proposalLoadTitleEl.style.fontWeight = '700';
    proposalLoadTitleEl.style.fontSize = '16px';
    proposalLoadTitleEl.style.marginBottom = '6px';

    const spinner = document.createElement('div');
    spinner.className = 'proposal-load-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    proposalLoadStatusEl = document.createElement('div');
    proposalLoadStatusEl.style.fontSize = '13px';
    proposalLoadStatusEl.style.color = '#334155';
    proposalLoadStatusEl.style.marginBottom = '6px';
    proposalLoadStatusEl.textContent = 'Preparing…';

    proposalLoadBytesEl = document.createElement('div');
    proposalLoadBytesEl.style.fontSize = '12px';
    proposalLoadBytesEl.style.color = '#64748b';
    proposalLoadBytesEl.textContent = '0.00 MB';

    proposalLoadProgressTextEl = document.createElement('div');
    proposalLoadProgressTextEl.style.fontSize = '12px';
    proposalLoadProgressTextEl.style.color = '#334155';
    proposalLoadProgressTextEl.style.marginTop = '8px';
    proposalLoadProgressTextEl.textContent = '';

    const progressBar = document.createElement('div');
    progressBar.style.position = 'relative';
    progressBar.style.height = '8px';
    progressBar.style.background = '#e5e7eb';
    progressBar.style.borderRadius = '999px';
    progressBar.style.overflow = 'hidden';
    progressBar.style.marginTop = '6px';
    progressBar.style.display = 'none';

    const progressFill = document.createElement('div');
    progressFill.style.position = 'absolute';
    progressFill.style.left = '0';
    progressFill.style.top = '0';
    progressFill.style.height = '100%';
    progressFill.style.width = '0%';
    progressFill.style.background = '#0d3b66';
    progressFill.style.transition = 'width 0.2s ease';

    progressBar.appendChild(progressFill);
    proposalLoadProgressBarEl = progressBar;
    proposalLoadProgressFillEl = progressFill;

    card.appendChild(proposalLoadTitleEl);
    card.appendChild(spinner);
    card.appendChild(proposalLoadStatusEl);
    card.appendChild(proposalLoadBytesEl);
    card.appendChild(proposalLoadProgressTextEl);
    card.appendChild(progressBar);
    proposalLoadOverlay.appendChild(card);
    document.body.appendChild(proposalLoadOverlay);

    return proposalLoadOverlay;
}

function renderProposalLoadProgress() {
    if (!proposalLoadProgressBarEl || !proposalLoadProgressFillEl) return;
    const total = Number(proposalLoadProgressTotal) || 0;
    const done = Number(proposalLoadProgressDone) || 0;
    if (total <= 0) {
        proposalLoadProgressBarEl.style.display = 'none';
        proposalLoadProgressFillEl.style.width = '0%';
        if (proposalLoadProgressTextEl) proposalLoadProgressTextEl.textContent = '';
        return;
    }
    const ratio = Math.max(0, Math.min(1, done / total));
    proposalLoadProgressBarEl.style.display = 'block';
    proposalLoadProgressFillEl.style.width = `${(ratio * 100).toFixed(1)}%`;
    if (proposalLoadProgressTextEl) {
        proposalLoadProgressTextEl.textContent = `${done} / ${total}`;
    }
}

function showProposalLoadOverlay(status, options = {}) {
    ensureProposalLoadOverlay();
    const defaultTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    const titleText = (options && typeof options.title === 'string' && options.title.trim())
        ? options.title.trim()
        : defaultTitle;
    if (proposalLoadTitleEl) proposalLoadTitleEl.textContent = titleText;
    proposalLoadBytes = 0;
    if (proposalLoadStatusEl) proposalLoadStatusEl.textContent = status || 'Loading…';
    if (proposalLoadBytesEl) proposalLoadBytesEl.textContent = '0.00 MB';
    const total = (options && Number.isFinite(Number(options.total))) ? Number(options.total) : 0;
    proposalLoadProgressTotal = total > 0 ? total : 0;
    proposalLoadProgressDone = 0;
    renderProposalLoadProgress();
    if (proposalLoadOverlay) proposalLoadOverlay.style.display = 'flex';
}

function updateProposalLoadOverlay(options = {}) {
    if (!proposalLoadOverlay) return;
    if (options.status && proposalLoadStatusEl) {
        proposalLoadStatusEl.textContent = options.status;
    }
    if (Number.isFinite(options.bytesDelta) && options.bytesDelta > 0) {
        proposalLoadBytes += options.bytesDelta;
        if (proposalLoadBytesEl) {
            proposalLoadBytesEl.textContent = `${(proposalLoadBytes / (1024 * 1024)).toFixed(2)} MB`;
        }
    }
    if (options.progress) {
        if (Number.isFinite(options.progress.total)) {
            proposalLoadProgressTotal = Math.max(0, Number(options.progress.total));
        }
        if (Number.isFinite(options.progress.done)) {
            proposalLoadProgressDone = Math.max(0, Number(options.progress.done));
        }
        renderProposalLoadProgress();
    }
}

function hideProposalLoadOverlay(finalStatus) {
    if (proposalLoadOverlay) {
        proposalLoadOverlay.style.display = 'none';
    }
    if (finalStatus && typeof updateStatus === 'function') {
        updateStatus(finalStatus);
    }
}

async function addResponseBytes(response) {
    if (!response) return;
    try {
        const lenHeader = response.headers ? response.headers.get('content-length') : null;
        if (lenHeader && Number.isFinite(Number(lenHeader))) {
            updateProposalLoadOverlay({ bytesDelta: Number(lenHeader) });
            return;
        }
        const clone = response.clone();
        const buf = await clone.arrayBuffer();
        updateProposalLoadOverlay({ bytesDelta: buf.byteLength });
    } catch (_) { /* ignore */ }
}

function formatSharedProposalLabel(proposal, fallbackId) {
    const title = proposal && proposal.title ? String(proposal.title) : '';
    const pid = proposal && proposal.proposalId
        ? String(proposal.proposalId)
        : (fallbackId !== undefined && fallbackId !== null ? String(fallbackId) : '');
    if (title && pid) return `${title} (#${pid})`;
    if (title) return title;
    if (pid) return `#${pid}`;
    return 'proposal';
}

function formatSharedProposalTypeLabel(proposal) {
    try {
        if (!proposal) return '';
        return resolveProposalGoalKey(proposal, null);
    } catch (_) {
        return '';
    }
}

async function handleSharedPlanRoute(idParts, attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        console.log('[handleSharedPlanRoute] Starting with IDs:', idParts, 'attempt:', attempt);

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                console.log('[handleSharedPlanRoute] Map not ready, retrying... attempt:', attempt);
                setTimeout(() => handleSharedPlanRoute(idParts, attempt + 1), 400);
            } else {
                console.error('[handleSharedPlanRoute] Map not ready after 15 attempts');
            }
            return;
        }

        const skipWelcomeGate = typeof window.shouldSkipWelcomeForProposalLink === 'function'
            ? window.shouldSkipWelcomeForProposalLink()
            : false;

        if (!skipWelcomeGate) {
            const welcomeModal = document.getElementById('welcome-modal');
            const isWelcomeModalVisible = welcomeModal && welcomeModal.style.display !== 'none';
            const hasUserAgent = typeof currentUserAgent !== 'undefined' && currentUserAgent !== null;

            console.log('[handleSharedPlanRoute] Welcome gate check:', {
                skipWelcomeGate,
                isWelcomeModalVisible,
                hasUserAgent
            });

            if (isWelcomeModalVisible || !hasUserAgent) {
                console.log('[handleSharedPlanRoute] Waiting for welcome modal to complete...');
                await new Promise((resolve) => {
                    if (!isWelcomeModalVisible && hasUserAgent) {
                        resolve();
                        return;
                    }
                    const onWelcomeComplete = () => {
                        console.log('[handleSharedPlanRoute] Welcome modal completed');
                        window.removeEventListener('welcomeModalComplete', onWelcomeComplete);
                        resolve();
                    };
                    window.addEventListener('welcomeModalComplete', onWelcomeComplete, { once: true });
                });
            }
        }

        // Apply many proposals robustly:
        // - descendant-only prerequisites: do NOT fetch, just requeue until available
        // - base-only prerequisites: fetch base parcels before applying
        // - mixed base + descendant prerequisites: kick off base fetch, then requeue
        const normalizeId = (raw) => {
            const s = (raw !== undefined && raw !== null) ? String(raw).trim() : '';
            return s;
        };

        const totalProposals = Array.from(new Set(idParts.map(normalizeId).filter(Boolean))).length;

        console.log('[handleSharedPlanRoute] Showing load overlay and fetching proposals...', { totalProposals });
        showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
            total: totalProposals,
            title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        });

        const backendBase = resolveBackendBaseUrl();
        const applied = [];
        const skipped = [];
        const failed = [];
        let lastLoadedProposalIdFor3D = null;

        const fetchProgressIds = new Set();
        const markFetchProgress = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized || fetchProgressIds.has(normalized)) return;
            fetchProgressIds.add(normalized);
            updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        };
        const getFetchOrdinal = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized) return fetchProgressIds.size + 1;
            return fetchProgressIds.has(normalized) ? fetchProgressIds.size : fetchProgressIds.size + 1;
        };
        const extractMissingParcelId = (value) => {
            const msg = (value && value.message) ? String(value.message)
                : (typeof value === 'string' ? value : '');
            if (!msg) return null;
            const match = msg.match(/Missing\s+parcel\s+([^\s]+)\s+in\s+parcelLayerById/i);
            return match && match[1] ? String(match[1]) : null;
        };
        const isDerivedParcelId = (parcelId) => {
            const s = parcelId ? String(parcelId) : '';
            return s.includes('#p-');
        };

        const getPrerequisiteParcelIdsForProposal = (proposal) => {
            try {
                // Keep this minimal: only consult explicit parentParcelIds fields.
                // Do NOT attempt parcel feature resolution here.
                const ids = [];
                const computed = (typeof computeRequiredParentIdsForSharedProposal === 'function')
                    ? computeRequiredParentIdsForSharedProposal(proposal)
                    : [];
                ensureArrayOfStrings(computed).forEach(id => ids.push(id));

                // Some payloads keep ids under nested objects; include them defensively.
                if (proposal && proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.roadProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.structureProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.decideLaterProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && Array.isArray(proposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => ids.push(id));
                }

                return Array.from(new Set(ids.map(x => String(x)).filter(Boolean)));
            } catch (_) {
                return [];
            }
        };

        const splitBaseAndDerivedIds = (ids) => {
            const baseIds = [];
            const derivedIds = [];
            (Array.isArray(ids) ? ids : []).forEach(id => {
                const s = id && id.toString ? id.toString() : String(id || '');
                if (!s) return;
                (isDerivedParcelId(s) ? derivedIds : baseIds).push(s);
            });
            return {
                baseIds: Array.from(new Set(baseIds)),
                derivedIds: Array.from(new Set(derivedIds))
            };
        };
        const isDependencyFailure = (value) => {
            const msg = (value && value.message) ? String(value.message)
                : (typeof value === 'string' ? value : '');
            if (!msg) return false;
            // Typical failure when parcels aren't yet available in parcelLayerById / cache.
            if (/Missing\s+parcel\s+.+\s+in\s+parcelLayerById/i.test(msg)) return true;
            if (/missing\s+in\s+parcelLayerById/i.test(msg)) return true;
            if (/prerequisite\s+parcels\s+are\s+missing/i.test(msg)) return true;
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parent\s+parcel\s+geometries/i.test(msg)) return true;
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parcel\s+geometries/i.test(msg)) return true;
            return false;
        };

        let queue = idParts.map(normalizeId).filter(Boolean);
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        const loadedById = new Map();
        const proposalTypeById = new Map();
        const basePrereqIdsById = new Map();
        const lastUnfetchedBasePrereqIdsById = new Map();
        const prereqIdsById = new Map();
        const lastMissingPrereqsById = new Map();
        const attemptById = new Map();
        const lastReasonById = new Map();
        const fetchedBaseParcels = new Set();
        const baseParcelFetchInFlight = new Map();
        const maxAttemptsPerId = 120;
        let stepsSinceProgress = 0;
        const attemptedSinceProgress = new Set();

        // Wait for PersistentStorage to be ready before checking local proposals.
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
            await new Promise(resolve => PersistentStorage.ensureReady(resolve));
        }

        const urlRequests3D = is3DModeRequestedFromUrl();

        // Analyze what's currently applied vs what's incoming
        const incomingIds = new Set(queue.map(normalizeId).filter(Boolean));
        let allAppliedProposals = [];
        let incomingAlreadyApplied = [];
        let otherAppliedProposals = [];

        console.log('[handleSharedPlanRoute] Incoming IDs from URL:', Array.from(incomingIds));

        if (typeof proposalStorage !== 'undefined' && proposalStorage) {
            const allProposals = proposalStorage.getAllProposals() || [];
            allAppliedProposals = allProposals.filter(p => isProposalCurrentlyApplied(p));

            // Categorize applied proposals
            allAppliedProposals.forEach(p => {
                const serverId = p.serverProposalId ? String(p.serverProposalId) : null;
                const hashId = p.proposalId ? String(p.proposalId) : null;
                // Also check using getServerProposalId helper which may extract from nested structures
                const extractedServerId = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;

                const isIncoming = (serverId && incomingIds.has(serverId))
                    || (hashId && incomingIds.has(hashId))
                    || (extractedServerId && incomingIds.has(String(extractedServerId)));

                console.log('[handleSharedPlanRoute] Checking applied proposal:',
                    'serverId=' + serverId,
                    'hashId=' + hashId,
                    'extractedServerId=' + extractedServerId,
                    'isIncoming=' + isIncoming
                );

                if (isIncoming) {
                    incomingAlreadyApplied.push(p);
                } else {
                    otherAppliedProposals.push(p);
                }
            });
        }

        const allIncomingApplied = incomingAlreadyApplied.length === totalProposals;
        const hasOtherApplied = otherAppliedProposals.length > 0;
        const noProposalsApplied = allAppliedProposals.length === 0;

        console.log('[handleSharedPlanRoute] Conflict analysis:',
            'totalProposals=' + totalProposals,
            'incomingAlreadyApplied=' + incomingAlreadyApplied.length,
            'otherApplied=' + otherAppliedProposals.length,
            'allIncomingApplied=' + allIncomingApplied,
            'hasOtherApplied=' + hasOtherApplied
        );

        // Helper: focus on applied proposals
        const focusOnAppliedProposals = async (proposalIdToFocus) => {
            hideProposalLoadOverlay();
            if (proposalIdToFocus && typeof map !== 'undefined' && map) {
                try {
                    const bounds = calculateBoundsForLastAppliedProposal(proposalIdToFocus);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to focus on applied proposal:', err);
                }
            }
            if (urlRequests3D) {
                try { tryEnterThreeMode({ fromUrl: true }); } catch (_) { }
            }
        };

        // Helper: unapply all applied proposals
        const unapplyAllProposals = async () => {
            if (allAppliedProposals.length === 0) return;
            console.log('[handleSharedPlanRoute] Unapplying all', allAppliedProposals.length, 'applied proposals...');
            if (typeof ProposalManager !== 'undefined') {
                for (const p of allAppliedProposals) {
                    const pid = p.proposalId || p.serverProposalId;
                    if (!pid) continue;
                    try {
                        console.info('[handleSharedPlanRoute] Unapplying proposal', pid);
                        if (typeof ProposalManager.unapplyWholeFamily === 'function') {
                            await ProposalManager.unapplyWholeFamily(pid);
                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                            await ProposalManager.unapplyProposal(pid, { skipConfirm: true });
                        }
                        console.info('[handleSharedPlanRoute] Unapplied proposal', pid);
                    } catch (err) {
                        console.warn('[handleSharedPlanRoute] Failed to unapply proposal:', pid, err);
                    }
                }
                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                    ProposalManager._refreshUIAfterProposalChange(null);
                }
            }
            console.log('[handleSharedPlanRoute] Finished unapplying all proposals');
        };

        // Scenario 1: Plan already fully applied, no other proposals
        // → "Plan Already Applied [Show me] [OK]"
        if (allIncomingApplied && !hasOtherApplied) {
            hideProposalLoadOverlay();
            const firstApplied = incomingAlreadyApplied[0];
            const focusId = firstApplied ? (firstApplied.proposalId || firstApplied.serverProposalId) : null;
            await new Promise(resolve => {
                showSimpleShareModal({
                    title: tShare('plan.alreadyAppliedTitle', 'Plan Already Applied'),
                    body: `<p>${tShare('plan.alreadyAppliedMessage', 'This shared plan is already applied to the map.')}</p>`,
                    actions: [
                        {
                            label: tShare('plan.showMe', 'Show me'),
                            primary: true,
                            onClick: async () => {
                                await focusOnAppliedProposals(focusId);
                                resolve();
                            }
                        },
                        {
                            label: t('modal.common.ok', 'OK'),
                            primary: false,
                            onClick: () => resolve()
                        }
                    ]
                });
            });
            return;
        }

        // Scenario 2: Some incoming proposals are already applied OR other proposals exist
        // → Show dialog with scrollable list and ask user what to do
        const someIncomingApplied = incomingAlreadyApplied.length > 0 && incomingAlreadyApplied.length < totalProposals;
        if (someIncomingApplied || hasOtherApplied) {
            hideProposalLoadOverlay();

            // Build scrollable list of already-applied proposals
            const appliedListItems = [...incomingAlreadyApplied, ...otherAppliedProposals].map(p => {
                const title = p.title || p.proposalId || p.serverProposalId || 'Untitled';
                const serverId = p.serverProposalId || (typeof getServerProposalId === 'function' ? getServerProposalId(p) : null);
                const idSuffix = serverId ? ` (#${serverId})` : '';
                return `<li>${title}${idSuffix}</li>`;
            }).join('');

            const listHtml = `
                <p>${tShare('plan.someAlreadyAppliedMessage', 'Some proposals are already applied on the map:')}</p>
                <ul class="applied-proposals-list" style="max-height: 120px; overflow-y: auto; margin: 8px 0; padding-left: 20px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; background: var(--bg-secondary, #f5f5f5);">
                    ${appliedListItems}
                </ul>
                <p>${tShare('plan.whatToDo', 'What would you like to do?')}</p>
            `;

            const userChoice = await new Promise(resolve => {
                showSimpleShareModal({
                    title: tShare('plan.someAlreadyAppliedTitle', 'Some Proposals Already Applied'),
                    body: listHtml,
                    actions: [
                        {
                            label: tShare('plan.applyRemaining', 'Apply remaining'),
                            primary: true,
                            onClick: () => resolve('apply-remaining')
                        },
                        {
                            label: tShare('plan.unapplyThenApply', 'Unapply existing, then apply'),
                            primary: false,
                            onClick: () => resolve('unapply')
                        }
                    ]
                });
            });

            if (userChoice === 'unapply') {
                await unapplyAllProposals();
                // After unapply, reset the already-applied tracking since we cleared them
                incomingAlreadyApplied = [];
            }

            // Re-show loading overlay and continue with applying
            showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
                total: totalProposals,
                title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
            });
        }

        // Scenario 3: No proposals on map → proceed silently (no dialog needed)

        // Build set of already-applied server IDs to exclude from queue
        const alreadyAppliedServerIds = new Set();
        incomingAlreadyApplied.forEach(p => {
            if (p.serverProposalId) alreadyAppliedServerIds.add(String(p.serverProposalId));
            const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
            if (extracted) alreadyAppliedServerIds.add(String(extracted));
        });

        // Queue only proposals that are NOT already applied (deduplicated)
        queue = Array.from(new Set(idParts.map(normalizeId).filter(id => {
            if (!id) return false;
            if (alreadyAppliedServerIds.has(id)) {
                console.log('[handleSharedPlanRoute] Skipping already-applied proposal:', id);
                return false;
            }
            return true;
        })));

        console.log('[handleSharedPlanRoute] Queue after filtering out already-applied:', queue.length, 'of', totalProposals);
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });

        // If nothing left to apply after filtering, focus on what's already applied and we're done
        if (queue.length === 0) {
            console.log('[handleSharedPlanRoute] All proposals already applied, focusing on them');
            const firstApplied = incomingAlreadyApplied[0];
            const focusId = firstApplied ? (firstApplied.proposalId || firstApplied.serverProposalId) : null;
            await focusOnAppliedProposals(focusId);
            return;
        }

        const startFetchBaseParcels = async (parcelIds, options = {}) => {
            const ids = ensureArrayOfStrings(parcelIds);
            if (!ids.length) return { attempted: [], missingAfter: [] };

            const unique = Array.from(new Set(ids));
            const toFetch = [];
            unique.forEach(id => {
                if (!id) return;
                if (fetchedBaseParcels.has(id)) return;
                if (baseParcelFetchInFlight.has(id)) return;
                toFetch.push(id);
            });

            // If nothing new to fetch, optionally await any in-flight fetches for these ids.
            if (!toFetch.length) {
                if (options.await === true) {
                    const inflight = unique.map(id => baseParcelFetchInFlight.get(id)).filter(Boolean);
                    if (inflight.length) {
                        await Promise.allSettled(inflight);
                    }
                }
                const missingAfter = unique.filter(id => !(typeof isParcelLayerReady === 'function' ? isParcelLayerReady(id) : false));
                return { attempted: [], missingAfter };
            }

            // Bulk fetch (per proposal): one request chain for the full list.
            const batchPromise = (async () => {
                try {
                    if (typeof fetchParcelsForIds === 'function') {
                        await fetchParcelsForIds(toFetch, { forceRefresh: true });
                    } else if (typeof ensureParentParcelsLoaded === 'function') {
                        await ensureParentParcelsLoaded(toFetch, { forceRefreshParcels: true });
                    }
                    if (typeof waitForParcelLayersReady === 'function') {
                        await waitForParcelLayersReady(toFetch, { timeoutMs: 15000, pollIntervalMs: 200 });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to bulk fetch base parcels for apply plan', { ids: toFetch, err });
                } finally {
                    toFetch.forEach(id => baseParcelFetchInFlight.delete(id));
                }
            })();

            // Track per-id promise for this batch so later proposals can await without duplicating work.
            toFetch.forEach(id => baseParcelFetchInFlight.set(id, batchPromise));

            if (options.await === true) {
                await Promise.allSettled([batchPromise]);
            }

            // Mark fetched ids that are now ready.
            toFetch.forEach(id => {
                try {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) {
                        fetchedBaseParcels.add(id);
                    }
                } catch (_) { }
            });

            const missingAfter = unique.filter(id => {
                try {
                    return !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(id));
                } catch (_) {
                    return true;
                }
            });

            return { attempted: toFetch, missingAfter };
        };

        while (queue.length > 0) {
            const id = queue.shift();
            try { attemptedSinceProgress.add(normalizeId(id)); } catch (_) { }
            const priorAttempts = attemptById.get(id) || 0;
            attemptById.set(id, priorAttempts + 1);

            // Hard stop for a single proposal to avoid infinite loops.
            if (attemptById.get(id) > maxAttemptsPerId) {
                const cachedProposal = loadedById.get(id) || null;
                const cachedType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal);
                const key = String(id);

                const missingPrereqs = (() => {
                    try {
                        const explicitMissing = lastMissingPrereqsById.get(key) || lastUnfetchedBasePrereqIdsById.get(key);
                        if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                        const basePrereqs = basePrereqIdsById.get(key) || [];
                        return ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        const cached = lastReasonById.get(key);
                        if (cached) return String(cached);
                        const pmReason = (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager.getLastApplyFailure === 'function')
                            ? ProposalManager.getLastApplyFailure(key)
                            : '';
                        return pmReason ? String(pmReason) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [];
                if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                const reason = reasonParts.length
                    ? reasonParts.join(' · ') + ` (too many retries: ${maxAttemptsPerId})`
                    : tShare('plan.applyUnknownFailure', 'Unknown error while applying.') + ` (too many retries: ${maxAttemptsPerId})`;

                console.warn('[handleSharedPlanRoute] Giving up after max retries', { id, reason, missingPrereqs });

                failed.push({
                    id,
                    label: formatSharedProposalLabel(cachedProposal, id),
                    type: cachedType,
                    missingPrereqs,
                    reason
                });
                stepsSinceProgress += 1;
                continue;
            }

            try {
                let proposal = loadedById.get(id);
                if (!proposal) {
                    const baseStatus = tShare('plan.fetching', 'Fetching proposal #{{id}}…', { id });
                    const ordinal = getFetchOrdinal(id);
                    const fetchingStatus = (totalProposals > 0)
                        ? `${baseStatus} (${ordinal}/${totalProposals})`
                        : baseStatus;
                    updateProposalLoadOverlay({
                        status: fetchingStatus,
                        progress: { done: fetchProgressIds.size, total: totalProposals }
                    });
                    const response = await fetch(`${backendBase}/proposals/${encodeURIComponent(id)}`);
                    await addResponseBytes(response);
                    if (!response.ok) {
                        let reason;
                        if (response.status === 404) {
                            reason = tShare('plan.notFoundOnServer', 'Not found on server');
                        } else {
                            reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim();
                        }
                        failed.push({ id, label: formatSharedProposalLabel(null, id), reason });
                        markFetchProgress(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                    proposal = await response.json();
                    loadedById.set(id, proposal);
                    try {
                        const inferredType = formatSharedProposalTypeLabel(proposal);
                        if (inferredType) proposalTypeById.set(id, inferredType);
                    } catch (_) { }
                }

                markFetchProgress(id);

                // Decide whether to fetch base parcels before applying.
                // - only base prerequisites: fetch and wait, then apply now
                // - mixed base+derived: kick off base fetch, then requeue without applying
                // - only derived: do not fetch; attempt apply
                const prereqIds = getPrerequisiteParcelIdsForProposal(proposal);
                const { baseIds, derivedIds } = splitBaseAndDerivedIds(prereqIds);
                try {
                    const queueKey = String(id);
                    const payloadKey = (proposal && proposal.proposalId) ? String(proposal.proposalId) : '';

                    prereqIdsById.set(queueKey, prereqIds);
                    basePrereqIdsById.set(queueKey, baseIds);
                    if (payloadKey) {
                        prereqIdsById.set(payloadKey, prereqIds);
                        basePrereqIdsById.set(payloadKey, baseIds);
                    }
                } catch (_) { }

                const computeMissingParentsNow = () => {
                    try {
                        const unique = Array.from(new Set(ensureArrayOfStrings(prereqIds)));
                        return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                };

                const parseMissingFromString = (text) => {
                    try {
                        if (!text || typeof text !== 'string') return [];
                        const match = text.match(/missing[^:]*:\s*(.+)$/i);
                        if (match && match[1]) {
                            return match[1].split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
                        }
                        return [];
                    } catch (_) { return []; }
                };

                if (baseIds.length > 0 && derivedIds.length > 0) {
                    // Mixed: fetch base parents and wait once before deciding whether to apply or requeue.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                    } catch (_) { }

                    try {
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);

                        const baseMissingNow = baseIds.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                        const derivedMissingNow = derivedIds.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                        const hint = baseMissingNow.length
                            ? `Waiting for base prerequisites (${baseMissingNow.slice(0, 6).join(', ')}${baseMissingNow.length > 6 ? ', …' : ''})`
                            : (derivedMissingNow.length
                                ? `Waiting for derived prerequisites (${derivedMissingNow.slice(0, 6).join(', ')}${derivedMissingNow.length > 6 ? ', …' : ''})`
                                : 'Waiting for prerequisites (mixed base + derived).');
                        lastReasonById.set(String(id), hint);
                        if (proposal && proposal.proposalId) lastReasonById.set(String(proposal.proposalId), hint);

                        // If base parents are still missing, requeue (do not apply yet).
                        if (baseMissingNow.length > 0) {
                            queue.push(id);
                            stepsSinceProgress += 1;
                            continue;
                        }
                        // Base parents are present; proceed to apply now (derived can still cause requeue on failure).
                    } catch (_) {
                        queue.push(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                }
                if (baseIds.length > 0 && derivedIds.length === 0) {
                    // Base-only: fetch before attempting apply.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);
                    } catch (_) { }
                }

                updateProposalLoadOverlay({ status: tShare('plan.applying', 'Applying proposal #{{id}}…', { id }) });
                let result;
                try {
                    // For /proposals/:id1,id2,… we intentionally do NOT fetch/resolve parcels here.
                    // Missing parcels are expected to be created by earlier applies.
                    result = await importAndApplySharedProposal(proposal, { skipDependencyFetch: true });
                } catch (err) {
                    // Convert thrown dependency errors into retryable results.
                    if (isDependencyFailure(err)) {
                        result = { applied: false, skipped: false, proposalId: proposal?.proposalId || id, reason: err.message || String(err) };
                    } else {
                        throw err;
                    }
                }

                const proposalId = (result && result.proposalId) || proposal?.proposalId || id;
                const label = formatSharedProposalLabel(proposal, proposalId);
                try {
                    const inferredType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(proposal);
                    if (inferredType) {
                        proposalTypeById.set(id, inferredType);
                        if (proposalId) proposalTypeById.set(String(proposalId), inferredType);
                    }
                } catch (_) { }

                // Ensure prereq maps are also keyed by the final resolved proposal id.
                try {
                    const pidKey = proposalId ? String(proposalId) : '';
                    if (pidKey && prereqIds && Array.isArray(prereqIds)) {
                        prereqIdsById.set(pidKey, prereqIds);
                        basePrereqIdsById.set(pidKey, baseIds);
                        const baseMissing = lastUnfetchedBasePrereqIdsById.get(String(id))
                            || lastUnfetchedBasePrereqIdsById.get((proposal && proposal.proposalId) ? String(proposal.proposalId) : '')
                            || [];
                        if (Array.isArray(baseMissing) && baseMissing.length) {
                            lastUnfetchedBasePrereqIdsById.set(pidKey, baseMissing);
                        }
                    }
                } catch (_) { }

                if (result && result.skipped) {
                    skipped.push({ id: proposalId, label });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                if (result && result.applied) {
                    applied.push({ id: proposalId, label });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                const reason = (result && result.reason) || tShare('plan.applyUnknownFailure', 'Unknown error while applying.');
                try { if (proposalId) lastReasonById.set(String(proposalId), String(reason || '')); } catch (_) { }
                if (isDependencyFailure(reason)) {
                    // If the dependency is a *base* parcel (no #p- suffix), try fetching it once.
                    const missingParcelId = extractMissingParcelId(reason);
                    if (missingParcelId && !isDerivedParcelId(missingParcelId) && !fetchedBaseParcels.has(missingParcelId)) {
                        fetchedBaseParcels.add(missingParcelId);
                        try {
                            const fetchResult = await startFetchBaseParcels([missingParcelId], { await: true });
                            try {
                                const key = String(proposalId || id);
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missingNow = Array.from(new Set([...(fetchResult.missingAfter || []), ...basePrereqs]))
                                    .filter(pid => pid && !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                lastUnfetchedBasePrereqIdsById.set(key, missingNow);
                            } catch (_) { }
                        } catch (fetchErr) {
                            // Best-effort only; still requeue.
                            console.warn('[handleSharedPlanRoute] Failed to fetch missing base parcel for apply plan', { missingParcelId, fetchErr });
                        }
                    }

                    // Bump to end of queue and try others; a later proposal may load required parcels.
                    try {
                        const missingNow = (() => {
                            try {
                                const full = prereqIdsById.get(String(id)) || prereqIdsById.get(String(proposalId)) || [];
                                const unique = Array.from(new Set(ensureArrayOfStrings(full)));
                                return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                            } catch (_) { return []; }
                        })();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposalId) lastMissingPrereqsById.set(String(proposalId), missingNow);
                    } catch (_) { }
                    queue.push(id);
                    stepsSinceProgress += 1;
                } else {
                    failed.push({
                        id: proposalId,
                        label,
                        type: (proposalTypeById.get(String(proposalId)) || proposalTypeById.get(String(id)) || formatSharedProposalTypeLabel(proposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(proposalId || id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                    stepsSinceProgress += 1;
                }
            } catch (error) {
                console.error('apply plan item failed', id, error);
                const reason = (error && error.message) ? error.message : 'Unexpected error';
                try { lastReasonById.set(String(id), String(reason || '')); } catch (_) { }
                if (isDependencyFailure(error) || isDependencyFailure(reason)) {
                    queue.push(id);
                } else {
                    const cachedProposal = loadedById.get(id) || null;
                    failed.push({
                        id,
                        label: formatSharedProposalLabel(cachedProposal, id),
                        type: (proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                }
                markFetchProgress(id);
                stepsSinceProgress += 1;
            }

            // If we've attempted every remaining unique id since last progress and still made no progress,
            // stop to avoid an infinite loop. (This also ensures we capture at least one failure reason per id.)
            if (queue.length > 0) {
                const remainingUnique = new Set(queue.map(normalizeId).filter(Boolean));
                let allAttempted = true;
                for (const rem of remainingUnique) {
                    if (!attemptedSinceProgress.has(rem)) {
                        allAttempted = false;
                        break;
                    }
                }
                if (allAttempted && stepsSinceProgress >= remainingUnique.size) {
                    break;
                }
            }
        }

        // Anything left in the queue after the loop is considered blocked.
        if (queue.length > 0) {
            const seen = new Set();
            queue.forEach(id => {
                const norm = normalizeId(id);
                if (!norm || seen.has(norm)) return;
                seen.add(norm);
                const cachedProposal = loadedById.get(norm) || null;
                const cachedType = proposalTypeById.get(norm) || formatSharedProposalTypeLabel(cachedProposal);
                const missingPrereqs = (() => {
                    try {
                        const combined = new Set();
                        const explicitMissing = lastMissingPrereqsById.get(norm) || lastUnfetchedBasePrereqIdsById.get(norm);
                        ensureArrayOfStrings(explicitMissing).forEach(id => combined.add(id));

                        const basePrereqs = basePrereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const allPrereqs = prereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(allPrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const fallback = (() => {
                            try {
                                const reason = lastReasonById.get(norm) || fallbackReason;
                                return parseMissingFromString(reason);
                            } catch (_) { return []; }
                        })();
                        ensureArrayOfStrings(fallback).forEach(id => combined.add(id));

                        return Array.from(combined);
                    } catch (_) {
                        return [];
                    }
                })();
                const lastReason = (() => {
                    try {
                        const cached = lastReasonById.get(norm);
                        return cached ? String(cached) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        if (lastReason) return '';
                        const last = (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager.getLastApplyFailure === 'function')
                            ? ProposalManager.getLastApplyFailure(norm)
                            : null;
                        return last ? String(last) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [tShare('plan.applyBlockedByDependencies', 'Blocked: dependencies not satisfied after retries.')];
                if (lastReason) reasonParts.push(lastReason);
                else if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) {
                    reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                }

                failed.push({
                    id: norm,
                    label: formatSharedProposalLabel(cachedProposal, norm),
                    type: cachedType,
                    missingPrereqs,
                    reason: reasonParts.join(' · ')
                });
            });
        }

        hideProposalLoadOverlay();

        const newUrl = window.location.pathname.replace(/\/proposals\/[^/?#]+$/, '') + window.location.search + window.location.hash;
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState({}, document.title, newUrl);
        }

        const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
        const renderList = (items, formatter) => {
            const content = items.map(formatter).join('');
            return `<div class="shared-plan-list" style="max-height: 320px; overflow-y: auto; padding-right: 4px;"><ul style="margin: 0; padding-left: 18px;">${content}</ul></div>`;
        };

        const bodyLines = [];
        if (applied.length > 0) {
            const appliedItems = renderList(applied, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.appliedCountDetailed', 'Applied {{count}} proposal{{suffix}}:', {
                count: applied.length,
                suffix: applied.length === 1 ? '' : 's'
            })}</p>${appliedItems}`);
        }
        if (skipped.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const skippedItems = renderList(skipped, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.skippedCountDetailed', 'Skipped {{count}} duplicate proposal{{suffix}} (already present):', {
                count: skipped.length,
                suffix: skipped.length === 1 ? '' : 's'
            })}</p>${skippedItems}`);
        }
        if (failed.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const failedItems = renderList(failed, item => {
                const label = escape(item.label || formatSharedProposalLabel(null, item.id));
                const type = item.type ? ` (${escape(item.type)})` : '';
                const reason = item.reason ? ` · ${escape(item.reason)}` : '';
                const missing = ensureArrayOfStrings(item.missingPrereqs || []);
                const missingBlock = missing.length
                    ? `<ul style="margin: 4px 0 0 16px; padding-left: 16px; list-style-type: circle;">
                        ${missing.map(pid => `<li>${escape(pid)}</li>`).join('')}
                    </ul>`
                    : '';
                return `<li>${label}${type}${reason}${missingBlock}</li>`;
            });
            bodyLines.push(`<p>${tShare('plan.failedCountDetailed', 'Failed to apply {{count}} proposal{{suffix}}:', {
                count: failed.length,
                suffix: failed.length === 1 ? '' : 's'
            })}</p>${failedItems}`);
        }

        const wants3DFromUrl = (!url3DModeHandled && is3DModeRequestedFromUrl());

        if (applied.length > 0) {
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
            if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
        }

        // Center map on the visible descendant of the last proposal
        // (traverse down until we find a proposal whose children are actually on the map)
        const rawLastProposalId = lastLoadedProposalIdFor3D
            || (applied.length > 0 ? applied[applied.length - 1].id : null)
            || (skipped.length > 0 ? skipped[skipped.length - 1].id : null);
        const lastProposalId = rawLastProposalId ? findVisibleDescendant(rawLastProposalId) : null;
        console.log('[handleSharedPlanRoute] Centering on proposal:', rawLastProposalId, '→ visible descendant:', lastProposalId);

        if (lastProposalId && typeof map !== 'undefined' && map) {
            try {
                const beforeCenter = (typeof map.getCenter === 'function') ? map.getCenter() : null;
                const beforeZoom = (typeof map.getZoom === 'function') ? map.getZoom() : null;
                const settlePromise = createLeafletViewSettlePromise(beforeCenter, beforeZoom);
                const bounds = calculateBoundsForLastAppliedProposal(lastProposalId);
                if (bounds && bounds.isValid && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                }
                await settlePromise;
            } catch (error) {
                console.warn('Failed to center map on last applied proposal:', error);
            }
        }

        let planSummaryModal = null;
        if (bodyLines.length > 0) {
            planSummaryModal = showSimpleShareModal({
                title: tShare('plan.summary', 'Shared Plan Result'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true }
                ],
                onClose: () => {
                    // URL-driven 3D mode: only enter after the user dismisses the results dialog.
                    try {
                        if (wants3DFromUrl && !url3DModeHandled) {
                            const entered = tryEnterThreeMode({ fromUrl: true });
                            if (entered) url3DModeHandled = true;
                        }
                    } catch (_) { }
                }
            });
        }

        // No dialog shown -> honor URL-driven 3D immediately after focusing.
        if (!planSummaryModal) {
            try {
                if (wants3DFromUrl && !url3DModeHandled) {
                    const entered = tryEnterThreeMode({ fromUrl: true });
                    if (entered) url3DModeHandled = true;
                }
            } catch (_) { }
        }
    } catch (error) {
        console.error('handleSharedPlanRoute failed', error);
        hideProposalLoadOverlay();
    } finally {
        if (typeof window !== 'undefined') {
            window.skipParcelFetchUntilProposalLoaded = false;
        }
    }
}

async function handleProposalRouteFromUrl(attempt = 0) {
    try {
        const pathname = window.location.pathname || '';
        const isProposalPath = pathname.startsWith('/proposals/');

        // Ignore non-proposal routes entirely
        if (!isProposalPath) {
            return;
        }

        // Check if URL matches /proposals/:id or comma-separated ids
        const pathMatch = pathname.match(/^\/proposals\/([0-9,]+)$/);
        if (!pathMatch) {
            console.debug('[handleProposalRouteFromUrl] Proposal path did not match expected pattern:', pathname);
            return;
        }
        console.log('[handleProposalRouteFromUrl] Matched path:', pathMatch[1], 'attempt:', attempt);

        const idSegment = pathMatch[1];
        const idParts = idSegment.split(',').map(v => v.trim()).filter(Boolean);
        if (idParts.length === 0) {
            console.log('[handleProposalRouteFromUrl] No valid ID parts found');
            return;
        }

        // Single proposal is just an array of one - use the same handler
        console.log('[handleProposalRouteFromUrl] Delegating to handleSharedPlanRoute:', idParts);
        await handleSharedPlanRoute(idParts);
    } catch (error) {
        console.error('handleProposalRouteFromUrl failed:', error);
    }
}

function handleStandalone3DModeFromUrl(attempt = 0) {
    try {
        if (url3DModeHandled) return;
        const wants3D = is3DModeRequestedFromUrl();
        if (!wants3D) return;

        // Check if there are proposal-related URL params - if so, let proposal handlers deal with 3D
        const params = new URLSearchParams(window.location.search || '');
        const hasProposalParams = params.has('proposalShare') || params.has('shared') || window.location.pathname.startsWith('/proposals/');
        if (hasProposalParams) {
            // Proposal handlers will handle 3D mode, so we don't need to do anything here
            return;
        }

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleStandalone3DModeFromUrl(attempt + 1), 400);
            }
            return;
        }

        // No proposal params, so enter 3D mode directly after map is ready
        // Wait a short moment to ensure map is fully initialized
        setTimeout(() => {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        }, 300);
    } catch (error) {
        console.error('handleStandalone3DModeFromUrl failed', error);
    }
}

window.addEventListener('load', () => {
    setTimeout(() => handleProposalRouteFromUrl(), 100);
    setTimeout(() => handleSingleProposalShareFromUrl(), 200);
    setTimeout(() => handleSharedProposalsFromUrl(), 250);
    setTimeout(() => handleStandalone3DModeFromUrl(), 500);
    // Initialize proposals indicator at startup
    setTimeout(() => { try { syncProposalsIndicator(); } catch (_) { } }, 300);
});

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalIdOrHash, parcelId) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, parcelId, true);
}

// Cancel multi-parcel selection
function cancelMultiParcelSelection() {
    // Clear selection first
    multiParcelSelection.clearSelection();

    // Exit multi-select mode if it's active
    if (multiParcelSelection.isActive) {
        multiParcelSelection.toggle({ restoreSingleSelection: false });
    }

    // Update checkboxes to reflect that multi-select is off
    syncMultiSelectCheckboxes(false);

    updateStatus('Multi-parcel selection cleared');
}

// Set up map event listeners to reapply multi-parcel highlights after move/zoom
function setupMultiParcelHighlightListeners() {
    if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
        map.on('moveend zoomend', function () {
            if (multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 0) {
                multiParcelSelection.reapplyMultiParcelHighlights();
            }
        });
        return true;
    }
    return false;
}

// Try to set up listeners immediately, or retry until map is available
if (!setupMultiParcelHighlightListeners()) {
    document.addEventListener('DOMContentLoaded', function () {
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(() => {
            if (setupMultiParcelHighlightListeners() || ++attempts > maxAttempts) {
                clearInterval(interval);
            }
        }, 200);
    });
}

// Accept proposal function (for specific parcel) - pure data function
function acceptProposal(proposalId, parcelId, ownerKey, metadata = {}) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        const parcelIds = (proposal.parentParcelIds || []).map(id => normalizeParcelId(id));
        if (!parcelIds.includes(normalizedParcelId)) {
            showProposalAlertMessage('this_parcel_is_not_part_of_the_proposal', 'This parcel is not part of the proposal.');
            return null;
        }

        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);

        const ownerSlots = getOwnerSlotsForParcel(normalizedParcelId);
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
        if (!entry) {
            showProposalAlertMessage('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
            return null;
        }

        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey) {
            if (entry.ownerOrder.length === 1) {
                effectiveOwnerKey = entry.ownerOrder[0];
            } else {
                showProposalAlertMessage('select_which_owner_share_you_are_accepting_for', 'Select which owner share you are accepting for.');
                return null;
            }
        }

        if (entry.acceptedOwnerKeys.includes(effectiveOwnerKey)) {
            showProposalAlertMessage('this_owner_has_already_accepted_the_proposal', 'This owner has already accepted the proposal.');
            return null;
        }

        entry.acceptedOwnerKeys.push(effectiveOwnerKey);
        entry.acceptedBy[effectiveOwnerKey] = {
            agentId: metadata.acceptedByAgentId || null,
            username: metadata.acceptedByName || null,
            acceptedAt: new Date().toISOString()
        };

        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : entry.acceptedOwnerKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => entry.acceptedOwnerKeys.includes(key))
            : entry.acceptedOwnerKeys.length > 0;

        if (parcelFullyAccepted) {
            if (!proposal.acceptedParcelIds.includes(normalizedParcelId)) {
                proposal.acceptedParcelIds.push(normalizedParcelId);
            }
        } else {
            proposal.acceptedParcelIds = proposal.acceptedParcelIds.filter(id => id !== normalizedParcelId);
        }

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
        proposalStorage.save();

        const parcelLayer = multiParcelSelection.findParcelById(normalizedParcelId);
        const parcelNumber = parcelLayer?.feature?.properties?.BROJ_CESTICE || normalizedParcelId;

        let proposalExecuted = false;
        if (proposal.acceptedParcelIds.length === parcelIds.length && parcelIds.length > 0) {
            proposal.status = 'Executed';
            proposal.executedAt = new Date().toISOString();
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposal);
            }
            proposalStorage.save();
            updateShowProposalsButton();

            autoApplyExecutedProposalToMap(proposal);

            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const executedMessage = (() => {
                const fullId = proposal.proposalId;
                const parcelCount = proposal.parentParcelIds.length;
                const fallback = `Proposal ${fullId} executed! All ${parcelCount} parcels accepted`;
                if (t) {
                    return t(
                        'ephemeral.messages.proposal_executed_all_parcels',
                        'Proposal {{hash}} executed! All {{count}} parcels accepted.',
                        { hash: fullId, count: parcelCount }
                    );
                }
                return fallback;
            })();

            if (resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadGeometry) {
                const affectedParcels = parcelIds.map(id => {
                    const layer = multiParcelSelection.findParcelById(id);
                    return {
                        id,
                        number: layer?.feature?.properties?.BROJ_CESTICE || id,
                        layer
                    };
                });

                if (proposal.roadGeometry.polygon && proposal.roadGeometry.polygon.coordinates) {
                    const coordinates = proposal.roadGeometry.polygon.coordinates[0];
                    const roadPolygon = coordinates.map(coord => ({ lat: coord[1], lng: coord[0] }));
                    const roadName = proposal.roadGeometry.name || 'New Road';
                    if (typeof updateParcelsWithRoad === 'function') {
                        updateParcelsWithRoad(roadPolygon, affectedParcels, roadName);
                    }
                }
                showEphemeralMessage(executedMessage);
            } else if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon' || proposal.buildingGeometry.type === 'Feature')) {
                if (proposal.buildingProposal) {
                    proposal.buildingProposal.status = 'executed';
                }
                if (typeof markProposedBuildingState === 'function') {
                    markProposedBuildingState(proposal.proposalId, 'executed', { updateLayer: true, save: true });
                } else if (typeof saveExecutedBuildingsToStorage === 'function') {
                    saveExecutedBuildingsToStorage();
                }
                showEphemeralMessage(executedMessage);
            } else if (proposal.structureProposal && (proposal.structureProposal.kind === 'park' || proposal.structureProposal.kind === 'square' || proposal.structureProposal.kind === 'lake')) {
                if (proposal.structureProposal) {
                    proposal.structureProposal.status = 'executed';
                }
                showEphemeralMessage(executedMessage);
            }
            proposalExecuted = true;
        }

        return {
            ownerAccepted: true,
            parcelAccepted: parcelFullyAccepted,
            proposalExecuted,
            parcelNumber
        };
    } catch (error) {
        console.error('Error accepting proposal:', error);
        showProposalAlertMessage('error_accepting_proposal_please_try_again', 'Error accepting proposal. Please try again.');
        return null;
    }
}

function restoreProposalDetailsScroll(preserveState) {
    if (!preserveState) return;

    const { scrollTop, anchorKey, anchorOffset, parcelId } = preserveState;

    const resolvePanelBody = () => {
        const panel = document.getElementById('proposal-details-panel');
        return panel ? panel.querySelector('.panel-body') : null;
    };

    const apply = () => {
        const panelBody = resolvePanelBody();
        if (!panelBody) return;

        if (anchorKey && typeof anchorOffset === 'number') {
            const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
            if (ownerRow) {
                const bodyRect = panelBody.getBoundingClientRect();
                const rowRect = ownerRow.getBoundingClientRect();
                const delta = (rowRect.top - bodyRect.top) - anchorOffset;
                if (!Number.isNaN(delta)) {
                    panelBody.scrollTop += delta;
                    return;
                }
            }
        }

        if (parcelId) {
            const parcelRow = panelBody.querySelector(`.proposal-parcel-item[data-parcel-id="${parcelId}"]`);
            if (parcelRow && typeof parcelRow.scrollIntoView === 'function') {
                parcelRow.scrollIntoView({ block: 'nearest' });
            }
        }

        if (typeof scrollTop === 'number') {
            panelBody.scrollTop = scrollTop;
        }
    };

    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 0);
    setTimeout(apply, 30);
    setTimeout(apply, 120);
}

// Accept proposal function (for specific parcel)
function handleUserAcceptProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_accept_proposals', 'You must be logged in to accept proposals.');
        return;
    }

    // Get the proposal to check stored owner acceptance data
    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const normalizedParcelId = normalizeParcelId(parcelId);
    if (!normalizedParcelId) {
        showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
        return;
    }

    // Ensure owner acceptance entry exists and get owner slots
    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
    if (!entry) {
        showProposalAlertMessage('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
        return;
    }

    // Determine the effective owner key
    let effectiveOwnerKey = ownerKey;
    let targetSlot = null;

    if (effectiveOwnerKey) {
        // If ownerKey is provided, check if it exists in the proposal's stored owner data
        if (entry.owners[effectiveOwnerKey]) {
            // Found in stored data, try to find in current slots for display, but use stored data if not found
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || entry.owners[effectiveOwnerKey];
        } else if (entry.ownerOrder.includes(effectiveOwnerKey)) {
            // Key exists in ownerOrder but not in owners, use it anyway
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
        } else {
            // Key not found in stored data, try to find in current slots
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey);
            if (targetSlot) {
                // Found in current slots, add to stored data
                entry.owners[effectiveOwnerKey] = {
                    key: targetSlot.key,
                    displayName: targetSlot.displayName || `Owner`,
                    shareText: targetSlot.shareText || '',
                    shareDetail: targetSlot.shareDetail || '',
                    type: targetSlot.type || 'unknown',
                    agentId: targetSlot.agentId || null
                };
            }
        }
    } else if (ownerSlots.length === 1) {
        // No ownerKey provided, but only one slot available
        targetSlot = ownerSlots[0];
        effectiveOwnerKey = targetSlot.key;
    } else if (entry.ownerOrder.length === 1) {
        // No ownerKey provided, but only one owner in stored data
        effectiveOwnerKey = entry.ownerOrder[0];
        targetSlot = entry.owners[effectiveOwnerKey] || ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
    }

    if (!targetSlot || !effectiveOwnerKey) {
        showProposalAlertMessage('please_choose_which_owner_share_you_are_accepting_for', 'Please choose which owner share you are accepting for.');
        return;
    }

    // Validate ownership for agent-type slots
    if (targetSlot.type === 'agent' && targetSlot.agentId && targetSlot.agentId !== userAgent.id) {
        showProposalAlertMessage('you_can_only_accept_proposals_for_parcels_you_own', 'You can only accept proposals for parcels you own.');
        return;
    }

    const result = acceptProposal(proposalId, parcelId, effectiveOwnerKey, {
        acceptedByAgentId: userAgent.id,
        acceptedByName: userAgent.name
    });

    if (!result) {
        return;
    }

    const ownerLabel = targetSlot.shareText
        ? `${targetSlot.displayName} (${targetSlot.shareText})`
        : targetSlot.displayName;

    const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(proposalId)
        : null;
    const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;

    if (result.proposalExecuted) {
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const message = t
            ? t('ephemeral.messages.proposal_executed', 'Proposal {{hash}} executed!', { hash: proposalIdForLog })
            : `Proposal ${proposalIdForLog} executed!`;
        showEphemeralMessage(message);
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal ${proposalLinkHtml} after confirming acceptance for ${ownerLabel}.`);
        }
        if (!userAgent.proposalsExecuted) {
            userAgent.proposalsExecuted = [];
        }
        if (!userAgent.proposalsExecuted.includes(proposalId)) {
            userAgent.proposalsExecuted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsExecuted: userAgent.proposalsExecuted });
        }
    } else {
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> recorded acceptance from ${ownerLabel} for parcel ${result.parcelNumber || parcelId} (${proposalLinkHtml}).`);
        }
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalId)) {
            userAgent.proposalsAccepted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsAccepted: userAgent.proposalsAccepted });
        }
    }

    // Preserve exact scroll/anchor position BEFORE any updates
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    const scrollTop = panelBody ? panelBody.scrollTop : 0;
    const anchorKey = effectiveOwnerKey || targetSlot.key || ownerKey || null;
    let anchorOffset = null;
    if (panelBody && anchorKey) {
        const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
        if (ownerRow) {
            const bodyRect = panelBody.getBoundingClientRect();
            const rowRect = ownerRow.getBoundingClientRect();
            anchorOffset = rowRect.top - bodyRect.top;
        }
    }

    const updatedProposal = proposalStorage.getProposal(proposalId);
    if (updatedProposal) {
        const preserveState = {
            scrollTop,
            anchorKey,
            anchorOffset,
            parcelId: normalizedParcelId
        };

        if (typeof updateAgentDialogAfterAcceptance === 'function') {
            updateAgentDialogAfterAcceptance(proposalId);
        }

        refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
        restoreProposalDetailsScroll(preserveState);

        if (typeof renderProposalListModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                renderProposalListModal();
            }
        }

        if (typeof refreshProposalsLayer === 'function') {
            refreshProposalsLayer();
        }
    }
}

// Reject proposal function (for specific parcel)
function handleUserRejectProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_undo_an_acceptance', 'You must be logged in to undo an acceptance.');
        return;
    }

    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    // Check if proposal is executed and has descendants
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposalStatus === 'executed') {
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
            const descendants = ProposalManager._getProposalDescendants(proposalId);
            if (descendants && descendants.length > 0) {
                showProposalAlertMessage('cannot_undo_acceptance_from_an_executed_proposal_that_has_descendant_parcels', 'Cannot undo acceptance from an executed proposal that has descendant parcels.');
                return;
            }
        }
    }

    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId);
    if (!acceptanceState.entries.length) {
        showProposalAlertMessage('no_recorded_owner_acceptance_to_undo', 'No recorded owner acceptance to undo.');
        return;
    }

    let targetEntry = acceptanceState.entries.find(entry => entry.key === ownerKey);
    if (!targetEntry) {
        targetEntry = acceptanceState.entries.find(entry => entry.accepted && entry.acceptedByAgentId === userAgent.id);
    }

    if (!targetEntry) {
        showProposalAlertMessage('unable_to_determine_which_acceptance_to_undo', 'Unable to determine which acceptance to undo.');
        return;
    }

    if (targetEntry.acceptedByAgentId && targetEntry.acceptedByAgentId !== userAgent.id) {
        showProposalAlertMessage('only_the_user_who_recorded_this_acceptance_can_undo_it', 'Only the user who recorded this acceptance can undo it.');
        return;
    }

    const result = rejectProposal(proposalId, parcelId, targetEntry.key);
    if (!result) {
        return;
    }

    const ownerLabel = targetEntry.shareText
        ? `${targetEntry.displayName} (${targetEntry.shareText})`
        : targetEntry.displayName;

    if (typeof addUserActionToGameLog === 'function') {
        addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> revoked acceptance recorded for ${ownerLabel} on parcel ${parcelId}.`);
    }

    if (typeof updateStatus === 'function') {
        updateStatus(`Revoked acceptance for ${ownerLabel} on parcel ${parcelId}.`);
    }

    // Preserve exact scroll/anchor position before update
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    const scrollTop = panelBody ? panelBody.scrollTop : 0;
    const anchorKey = targetEntry.key || ownerKey || null;
    let anchorOffset = null;
    if (panelBody && anchorKey) {
        const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
        if (ownerRow) {
            const bodyRect = panelBody.getBoundingClientRect();
            const rowRect = ownerRow.getBoundingClientRect();
            anchorOffset = rowRect.top - bodyRect.top;
        }
    }

    const preserveState = {
        scrollTop,
        anchorKey,
        anchorOffset,
        parcelId: parcelId ? parcelId.toString() : null
    };

    setTimeout(() => {
        const updatedProposal = proposalStorage.getProposal(proposalId);
        if (updatedProposal) {
            refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
            restoreProposalDetailsScroll(preserveState);
        }
    }, 0);
}

function rejectProposal(proposalId, parcelId, ownerKey = null) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, getOwnerSlotsForParcel(normalizedParcelId), { syncWithParcelAcceptance: false });
        if (!entry || !entry.acceptedOwnerKeys || entry.acceptedOwnerKeys.length === 0) {
            showProposalAlertMessage('this_parcel_has_not_accepted_the_proposal_yet', 'This parcel has not accepted the proposal yet.');
            return null;
        }

        let targetOwnerKey = ownerKey;
        if (!targetOwnerKey) {
            if (entry.acceptedOwnerKeys.length === 1) {
                targetOwnerKey = entry.acceptedOwnerKeys[0];
            } else {
                showProposalAlertMessage('please_specify_which_owner_acceptance_to_undo', 'Please specify which owner acceptance to undo.');
                return null;
            }
        }

        if (!entry.acceptedOwnerKeys.includes(targetOwnerKey)) {
            showProposalAlertMessage('this_owner_has_not_accepted_the_proposal_yet', 'This owner has not accepted the proposal yet.');
            return null;
        }

        entry.acceptedOwnerKeys = entry.acceptedOwnerKeys.filter(key => key !== targetOwnerKey);
        if (entry.acceptedBy && entry.acceptedBy[targetOwnerKey]) {
            delete entry.acceptedBy[targetOwnerKey];
        }
        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : entry.acceptedOwnerKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => entry.acceptedOwnerKeys.includes(key))
            : entry.acceptedOwnerKeys.length > 0;

        if (!parcelFullyAccepted) {
            proposal.acceptedParcelIds = normalizeParcelIdList((proposal.acceptedParcelIds || []).filter(id => id !== normalizedParcelId));
        }

        // If proposal was executed and now has no descendants, change status back to Active
        const proposalStatus = (proposal.status || '').toLowerCase();
        if (proposalStatus === 'executed') {
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
                const descendants = ProposalManager._getProposalDescendants(proposalId);
                if (!descendants || descendants.length === 0) {
                    proposal.status = 'Active';
                    delete proposal.executedAt;
                }
            }
        }

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
        proposalStorage.save();

        setTimeout(() => {
            if (typeof applyProposalHighlights === 'function') {
                applyProposalHighlights();
            }
        }, 10);

        return { ownerKey: targetOwnerKey, parcelAccepted: parcelFullyAccepted };
    } catch (error) {
        console.error('Error rejecting proposal:', error);
        showProposalAlertMessage('error_rejecting_proposal_please_try_again', 'Error rejecting proposal. Please try again.');
        return null;
    }
}

// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Proposals are always shown now, no checkbox event listener needed

    // Initialize the show proposals button count
    updateShowProposalsButton();
});

// Helper function to check if the active element is an editable field (input, textarea, etc.)
function isEditableElement(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || tagName === 'OPTION';
}

// Keyboard shortcut handler for 'C' key to open Create Proposal modal
let createProposalHotkeyAttached = false;

function handleCreateProposalHotkey(event) {
    if (!event) return;
    // Don't trigger if modifier keys are pressed
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Don't trigger if typing in an input field
    if (isEditableElement(event.target)) return;
    // Only respond to 'C' key
    if (event.key !== 'c' && event.key !== 'C') return;

    // Check if a modal is already open (don't open another one)
    const existingModal = document.querySelector('.create-proposal-modal');
    if (existingModal) return;

    // Check if there are any parcels selected (single or multi-selection)
    const selection = getCurrentParcelSelectionContext();
    if (!selection || !selection.ids || selection.ids.length === 0) {
        // No parcels selected, show a status message
        if (typeof updateStatus === 'function') {
            const t = getProposalI18nHelper();
            const noParcelsMessage = t(
                'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
                'Please select at least one parcel to create a proposal.'
            );
            updateStatus(noParcelsMessage);
        }
        return;
    }

    // Open the Create Proposal dialog
    event.preventDefault();
    showProposalDialog();
}

function attachCreateProposalHotkey() {
    if (createProposalHotkeyAttached) return;
    document.addEventListener('keydown', handleCreateProposalHotkey);
    createProposalHotkeyAttached = true;
}

// Attach the 'C' key shortcut on DOM ready
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachCreateProposalHotkey, { once: true });
    } else {
        attachCreateProposalHotkey();
    }
}

// Make objects globally available
window.proposalStorage = proposalStorage;
window.multiParcelSelection = multiParcelSelection;
window.getProposalOwnerAcceptanceState = getProposalOwnerAcceptanceState;
window.buildOwnerAcceptanceSectionHtml = buildOwnerAcceptanceSectionHtml;
window.handleUserRejectProposal = handleUserRejectProposal;
window.handleProposalParcelClick = handleProposalParcelClick;
window.openProposalBoostDialog = openProposalBoostDialog;
window.submitProposalBoost = submitProposalBoost;
window.closeProposalBoostDialog = closeProposalBoostDialog;

// Ensure count is correct once DOM is ready
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
    });
}

// --- Cross-module coordination ---
// When fresh parcel data arrive, restore whichever visual layers are currently active
window.addEventListener('parcelDataLoaded', async () => {
    // 1) Auto-apply executed and applied proposals to ensure parent parcels are removed and child parcels are clickable
    // This is critical: without this, parent parcels remain on the map and block child parcel clicks
    // applyProposal is idempotent - it checks roadProposal.status === 'applied' and returns early if already applied
    if (typeof proposalStorage !== 'undefined' && typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            const allProposals = proposalStorage.getAllProposals();
            const isAppliedLike = (p) => {
                const status = (p.status || '').toLowerCase();
                const roadStatus = (p.roadProposal && p.roadProposal.status) ? p.roadProposal.status.toLowerCase() : '';
                const structureStatus = (p.structureProposal && p.structureProposal.status) ? p.structureProposal.status.toLowerCase() : '';
                const buildingStatus = (p.buildingProposal && p.buildingProposal.status) ? p.buildingProposal.status.toLowerCase() : '';
                const reparcelStatus = (p.reparcellization && p.reparcellization.status) ? p.reparcellization.status.toLowerCase() : '';
                const decideLaterStatus = (p.decideLaterProposal && p.decideLaterProposal.status) ? p.decideLaterProposal.status.toLowerCase() : '';
                return status === 'executed' || status === 'applied'
                    || roadStatus === 'applied' || roadStatus === 'executed'
                    || structureStatus === 'applied' || structureStatus === 'executed'
                    || buildingStatus === 'applied' || buildingStatus === 'executed'
                    || reparcelStatus === 'applied' || reparcelStatus === 'executed'
                    || decideLaterStatus === 'applied' || decideLaterStatus === 'executed';
            };

            // Filter for both executed and applied proposals
            const proposalsToRestore = allProposals.filter(p => {
                const status = (p.status || '').toLowerCase();
                const roadStatus = (p.roadProposal && p.roadProposal.status) ? p.roadProposal.status.toLowerCase() : '';
                const structureStatus = (p.structureProposal && p.structureProposal.status) ? p.structureProposal.status.toLowerCase() : '';
                const buildingStatus = (p.buildingProposal && p.buildingProposal.status) ? p.buildingProposal.status.toLowerCase() : '';
                const reparcelStatus = (p.reparcellization && p.reparcellization.status) ? p.reparcellization.status.toLowerCase() : '';
                const decideLaterStatus = (p.decideLaterProposal && p.decideLaterProposal.status) ? p.decideLaterProposal.status.toLowerCase() : '';
                // Include executed proposals and applied proposals (for roads, buildings, structures, reparcellizations, etc.)
                return status === 'executed' || status === 'applied'
                    || roadStatus === 'applied' || roadStatus === 'executed'
                    || structureStatus === 'applied' || structureStatus === 'executed'
                    || buildingStatus === 'applied' || buildingStatus === 'executed'
                    || reparcelStatus === 'applied' || reparcelStatus === 'executed'
                    || decideLaterStatus === 'applied' || decideLaterStatus === 'executed';
            });

            // Drop ancestor proposals when any of their children are already applied/executed in the same restore set
            const proposalsById = new Map();
            proposalsToRestore.forEach(p => {
                const key = getProposalKey(p);
                if (!key) return;
                proposalsById.set(String(key), p);
            });

            const restoreCandidates = proposalsToRestore.filter(p => {
                const id = getProposalKey(p);
                if (!id) return false;
                const children = Array.isArray(p.childProposalIds)
                    ? p.childProposalIds.map(c => String(c)).filter(c => proposalsById.has(c))
                    : [];
                const hasAppliedChild = children.some(childId => {
                    const child = proposalsById.get(childId);
                    return child && isAppliedLike(child);
                });
                return !hasAppliedChild;
            });

            const toposortAppliedProposals = (list) => {
                const proposalMap = new Map();
                const indegree = new Map();
                const edges = new Map();

                list.forEach(p => {
                    const key = getProposalKey(p);
                    if (!key) return;
                    const id = String(key);
                    proposalMap.set(id, p);
                    if (!indegree.has(id)) indegree.set(id, 0);
                });

                // Skip ancestors that already have an applied/executed descendant in the same set
                const idSet = new Set(proposalMap.keys());
                const memoHasDesc = new Map();
                const hasAppliedDescendant = (id, visiting = new Set()) => {
                    if (!id || visiting.has(id)) return false;
                    if (memoHasDesc.has(id)) return memoHasDesc.get(id);
                    visiting.add(id);
                    const proposal = proposalMap.get(id);
                    const children = Array.isArray(proposal?.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => idSet.has(c))
                        : [];
                    const result = children.some(childId => isAppliedLike(proposalMap.get(childId))
                        || hasAppliedDescendant(childId, visiting));
                    visiting.delete(id);
                    memoHasDesc.set(id, result);
                    return result;
                };

                Array.from(proposalMap.keys()).forEach(id => {
                    if (hasAppliedDescendant(id)) {
                        proposalMap.delete(id);
                        indegree.delete(id);
                    }
                });

                proposalMap.forEach((proposal, id) => {
                    const children = Array.isArray(proposal.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => proposalMap.has(c))
                        : [];
                    edges.set(id, children);
                    children.forEach(child => indegree.set(child, (indegree.get(child) || 0) + 1));
                });

                const queue = Array.from(indegree.entries())
                    .filter(([, deg]) => deg === 0)
                    .map(([id]) => id);
                const orderedIds = [];

                while (queue.length) {
                    const id = queue.shift();
                    orderedIds.push(id);
                    (edges.get(id) || []).forEach(child => {
                        const next = (indegree.get(child) || 0) - 1;
                        indegree.set(child, next);
                        if (next === 0) queue.push(child);
                    });
                }

                const unresolved = Array.from(proposalMap.keys()).filter(id => !orderedIds.includes(id));
                const finalOrder = orderedIds.concat(unresolved);
                return finalOrder.map(id => proposalMap.get(id)).filter(Boolean);
            };

            const orderedProposals = toposortAppliedProposals(restoreCandidates);

            let appliedCount = 0;
            for (const proposal of orderedProposals) {
                if (proposal && proposal.proposalId) {
                    try {
                        // This will remove parent parcels if they exist and add child parcels, ensuring everything is restored correctly
                        const result = await ProposalManager.applyProposal(proposal.proposalId);
                        if (result !== false) {
                            appliedCount++;
                        }
                    } catch (error) {
                        console.warn('Failed to auto-apply proposal on parcel data load:', proposal.proposalId, error);
                    }
                }
            }

            if (appliedCount > 0) {
                setTimeout(() => {
                    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                        parcelLayer.eachLayer(layer => {
                            if (!layer || !layer.feature || !layer.feature.properties) return;
                            const parcelId = getParcelIdFromFeature(layer.feature);
                            if (!parcelId) return;

                            const hasClickHandler = layer._events && layer._events.click && layer._events.click.length > 0;
                            if (!hasClickHandler && typeof window.onEachFeature === 'function') {
                                try {
                                    window.onEachFeature(layer.feature, layer);
                                } catch (error) {
                                    console.warn('Failed to attach handlers to parcel after proposal apply:', parcelId, error);
                                }
                            }

                            if (layer.options) {
                                layer.options.interactive = true;
                            }
                            if (typeof layer.setInteractive === 'function') {
                                layer.setInteractive(true);
                            }
                            if (typeof layer.bringToFront === 'function') {
                                layer.bringToFront();
                            }
                        });

                        if (typeof parcelLayer.bringToFront === 'function') {
                            parcelLayer.bringToFront();
                        }
                    }
                }, 100);
            }
        } catch (error) {
            console.warn('Error auto-applying executed proposals on parcel data load:', error);
        }
    }

    // 2) Proposals are always shown now, so always update proposal layer
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    // 3) If a single parcel is selected (parcel mode), restore its highlight
    if (window.selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
        const layer = parcelLayer.getLayers().find(l => {
            const candidateId = getParcelIdFromFeature(l?.feature);
            return candidateId && candidateId.toString() === window.selectedParcelId.toString();
        });
        if (layer && typeof selectedParcelStyle !== 'undefined') {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
        }
    }

    // 4) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
});

// Proposal Info hover overlay helpers
function showProposalInfoHoverOverlay(parcelId) {
    try {
        if (!parcelId) return;
        if (typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            // Proposal UI is not active; do not show proposal-style hover
            return;
        }
        highlightParcelHover(parcelId, {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true
        });
    } catch (error) {
        console.warn('showProposalInfoHoverOverlay failed', error);
    }
}

function clearProposalInfoHoverOverlay() {
    try {
        clearProposalHoverLayers();
    } catch (error) {
        console.warn('clearProposalInfoHoverOverlay failed', error);
    }
}
// Offer formatting helpers
function formatProposalOfferValue(value) {
    if (value === undefined || value === null || value === '') return '';
    const cleanValue = value.toString().replace(/\D/g, '');
    if (!cleanValue) return '';
    const number = parseInt(cleanValue, 10);
    return number.toLocaleString('hr-HR');
}

function handleProposalOfferInput(input) {
    const originalValue = input.value;
    const formatted = formatProposalOfferValue(originalValue);

    if (input.value !== formatted) {
        input.value = formatted;
    }
}

function parseProposalOfferValue(value) {
    if (!value) return 0;
    const cleanValue = value.toString().replace(/\D/g, '');
    return parseInt(cleanValue, 10) || 0;
}

window.formatProposalOfferValue = formatProposalOfferValue;
window.handleProposalOfferInput = handleProposalOfferInput;
window.parseProposalOfferValue = parseProposalOfferValue;
