// proposals/dialog-upload.js — extracted from proposals.js (behavior-preserving relocation).

function updateProposalScreenshotGoalIcon(toolKey) {
    const container = document.querySelector('#proposalScreenshotContainer .map-screenshot-container');
    if (!container) return;

    const iconConfig = getProposalGoalBadge(toolKey);

    let badge = container.querySelector('.proposal-goal-badge');
    if (!iconConfig) {
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '';
            badge.removeAttribute('aria-label');
            badge.removeAttribute('title');
        }
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'proposal-goal-badge';
        container.appendChild(badge);
    }

    badge.style.display = 'flex';
    badge.textContent = iconConfig.text;
    badge.setAttribute('aria-label', iconConfig.label);
    badge.setAttribute('title', iconConfig.label);
}

function shouldSkipProposalScreenshot(proposal) {
    if (!proposal) return true;
    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || proposal.type || '');
    return PROPOSAL_SCREENSHOT_SKIP_GOALS.has(goalKey);
}

// Proposal thumbnails are rendered SERVER-SIDE at upload (backend/thumbnails/), not in the browser.
// The client-side capture pipeline that used to live here — reconstructProposalScreenshotDataUrl,
// captureAndPersistProposalScreenshot, the /assets/upload + PATCH /proposals/:id/screenshot dance and
// the click-to-generate placeholder — is gone: it only ever ran for whoever happened to have the
// proposal open in the right city with tiles loaded, which is why almost no proposal had a thumbnail.
//
// What remains below is the CREATE-modal preview context (buildProposalScreenshotContext), which
// feeds the live preview map in the create dialog and the image the mint flow puts on-chain.

function buildProposalScreenshotContext(parcelLayers = [], options = {}) {
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext]', {
            parcelLayersCount: parcelLayers?.length,
            options: { goal: options.goal, hasRoadContext: !!options.roadContext }
        });
    }
    const goalKey = (typeof normalizeGoalKey === 'function') ? normalizeGoalKey(options.goal) : (options.goal || '');
    const roadContext = options.roadContext || null;
    const parcelIds = Array.isArray(parcelLayers)
        ? parcelLayers.map(layer => window.ParcelPresenter?.getIdForLayer?.(layer)).filter(Boolean).map(String)
        : [];
    const parcelFeatures = parcelIds.map(id => window.LiveParcelFabric?.get?.(id)).filter(Boolean);
    const hasParcels = parcelIds.length > 0 && parcelFeatures.length === parcelIds.length;
    if (!hasParcels && !roadContext) {
        return null;
    }

    const parcelPolygons = [];
    // Every source below is GeoJSON [lng, lat] (live fabric features, unions, road geometry), so the
    // order is stated, never guessed: the capture refuses a bbox it cannot trust.
    let polygonOrder = 'lnglat';
    let parcelPolygonOrder = 'lnglat';
    if (hasParcels) {
        parcelFeatures.forEach(feature => {
            const geom = feature.geometry;
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
    }

    let polygon = null;
    const geometry = hasParcels ? buildGeometryFromParcels(parcelIds) : null;
    if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
        polygon = geometry.coordinates;
    } else if (parcelPolygons.length) {
        polygon = parcelPolygons[0];
    }

    let bounds = null;
    if (hasParcels && typeof L !== 'undefined' && L.latLngBounds) {
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

    let fitToPolygonOnly = false;

    if (goalKey === 'road-track' && roadContext) {
        // roadContext.polygon is a GeoJSON object with coordinates in [lng, lat] order
        // Use it directly - no conversion needed
        const roadPolygon = roadContext.polygon || roadContext.superGeometry || roadContext.geometry || null;

        if (roadPolygon && roadPolygon.coordinates) {
            // GeoJSON polygon - coordinates are already in [lng, lat] order
            polygon = roadPolygon.coordinates;
            // Use explicit order from roadContext if provided, otherwise assume GeoJSON standard
            polygonOrder = roadContext.polygonOrder || 'lnglat';
            fitToPolygonOnly = true;

            // Build bounds from GeoJSON coordinates [lng, lat]
            const flatCoords = Array.isArray(roadPolygon.coordinates[0]) && Array.isArray(roadPolygon.coordinates[0][0])
                ? roadPolygon.coordinates[0] // Polygon: [[ring]]
                : roadPolygon.coordinates;   // Simple array
            if (Array.isArray(flatCoords) && flatCoords.length > 0) {
                let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                flatCoords.forEach(coord => {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        // GeoJSON order: [lng, lat]
                        const lng = coord[0], lat = coord[1];
                        if (Number.isFinite(lng) && Number.isFinite(lat)) {
                            if (lng < minLng) minLng = lng;
                            if (lng > maxLng) maxLng = lng;
                            if (lat < minLat) minLat = lat;
                            if (lat > maxLat) maxLat = lat;
                        }
                    }
                });
                if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                    bounds = L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
                }
            }
            parcelPolygonOrder = 'lnglat';

            if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                console.debug('[buildProposalScreenshotContext] road polygon resolved', {
                    type: roadPolygon.type,
                    coordsLength: roadPolygon.coordinates?.[0]?.length,
                    firstCoord: roadPolygon.coordinates?.[0]?.[0],
                    polygonOrder,
                    expectedForZagreb: 'firstCoord should be [lng ~15.97, lat ~45.80]',
                    bounds: bounds ? { sw: bounds.getSouthWest(), ne: bounds.getNorthEast() } : null
                });
            }
        }
    }

    // If the road/track flow did not seed parcel outlines, explicitly expand its cadastral anchors
    // through the committed live fabric. Leaflet remains a screenshot renderer, never a data source.
    if (goalKey === 'road-track' && roadContext && parcelPolygons.length === 0 && Array.isArray(roadContext.parcelIds) && roadContext.parcelIds.length) {
        const ids = roadContext.parcelIds
            .map(id => (id ? id.toString() : null))
            .filter(Boolean);

        const layers = window.ParcelPresenter?.resolveLiveLayers?.(ids, { includeCorridors: true }) || [];
        layers.forEach(layer => {
            try {
                const liveId = window.ParcelPresenter?.getIdForLayer?.(layer);
                const geom = liveId ? window.LiveParcelFabric?.get?.(liveId)?.geometry : null;
                if (geom?.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                    parcelPolygons.push(geom.coordinates);
                } else if (geom?.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(coords => {
                        if (Array.isArray(coords)) parcelPolygons.push(coords);
                    });
                }

                if (!bounds && typeof layer.getBounds === 'function') {
                    const b = layer.getBounds();
                    if (b && typeof b.isValid === 'function' && b.isValid()) {
                        bounds = b.clone ? b.clone() : b;
                    }
                }
            } catch (err) {
                console.warn('Failed to derive parcel outline for road/track screenshot', err);
            }
        });
    }
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext] summary', {
            hasPolygon: !!polygon,
            polygonLength: polygon?.length || polygon?.[0]?.length,
            parcelPolygonsCount: parcelPolygons.length,
            hasBounds: !!bounds,
            polygonOrder,
            parcelPolygonOrder,
            fitToPolygonOnly
        });
    }

    const appendParcelsFromFabric = (target = [], targetBounds = null, limit = 150) => {
        const fabric = window.LiveParcelFabric;
        if (!fabric || !targetBounds || typeof fabric.queryBounds !== 'function') return target;
        const features = fabric.queryBounds(targetBounds, { includeCorridors: true });
        for (const feature of features) {
            if (target.length >= limit) break;
            const geom = feature?.geometry;
            if (!geom || !geom.coordinates) continue;
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                target.push(geom.coordinates);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(poly => {
                    if (Array.isArray(poly)) target.push(poly);
                });
            }
        }
        return target;
    };

    // If we have a road geometry but no parcel outlines yet, pull nearby parcels from the current layer so borders are visible.
    if (fitToPolygonOnly && parcelPolygons.length === 0 && bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        appendParcelsFromFabric(parcelPolygons, bounds, 200);
    }

    if (!polygon) return null;

    // Compute neighbour polygons from the committed live fabric.
    let neighbours = [];
    if (hasParcels && typeof window.findNeighbourPolygonsFromLiveFabric === 'function') {
        const selectedIds = new Set(parcelIds);
        selectedIds.forEach(parcelId => {
            const found = window.findNeighbourPolygonsFromLiveFabric(parcelId);
            if (Array.isArray(found)) {
                found.forEach(ring => neighbours.push(ring));
            }
        });
    }

    // For road geometry we convert to [lat, lng] pairs; otherwise let downstream normalize
    return { polygon, parcelPolygons, neighbours, bounds, fitToPolygonOnly, polygonOrder, parcelPolygonOrder };
}

// options.anchors: Solana v2, where a missing parcel means a missing ownerless parcel anchor, not
// a certificate someone owns; the wording and the action button say so.
// The shared dialog (js/ui/dialogs.js) on the confirm rung, over the create dialog it is asked
// from. Resolves 'memory', 'mint' or 'cancel' (the close button, Escape, the backdrop).
async function showMissingParcelsModal(missingParcels, chainName, options = {}) {
    const t = getProposalI18nHelper();
    setProposalModalDimmed(true);

    const message = document.createElement('div');
    message.className = 'missing-parcels-message';

    const chainDisplay = chainName || t('modal.createProposal.missingParcels.defaultChain', 'the blockchain');
    const overflowLabel = missingParcels.length > 10
        ? t('modal.createProposal.missingParcels.more', ', and {{count}} more...', {
            count: missingParcels.length - 10
        })
        : '';
    const parcelList = missingParcels.length > 10
        ? `${missingParcels.slice(0, 10).join(', ')}${overflowLabel}`
        : missingParcels.join(', ');
    const anchors = options && options.anchors === true;
    const single = missingParcels.length === 1;
    const introMessage = anchors
        ? t(
            `modal.createProposal.missingParcels.${single ? 'anchorMessageSingle' : 'anchorMessagePlural'}`,
            single
                ? 'The following parcel has no parcel anchor on <strong>{{chain}}</strong> yet, so a proposal for it cannot be minted on-chain:'
                : 'The following parcels have no parcel anchor on <strong>{{chain}}</strong> yet, so a proposal for them cannot be minted on-chain:',
            { chain: chainDisplay }
        )
        : t(
            `modal.createProposal.missingParcels.${single ? 'messageSingle' : 'messagePlural'}`,
            single
                ? 'The following parcel is not represented as an NFT on <strong>{{chain}}</strong>, so a proposal for it cannot be minted on-chain:'
                : 'The following parcels are not represented as NFTs on <strong>{{chain}}</strong>, so a proposal for them cannot be minted on-chain:',
            { chain: chainDisplay }
        );
    const proceedPrompt = t(
        'modal.createProposal.missingParcels.proceedQuestion',
        'Proceed to create an in-memory proposal?'
    );
    const explainerText = anchors
        ? t(
            'modal.createProposal.missingParcels.anchorExplainer',
            "A parcel anchor is the parcel's on-chain identity. Nobody owns it and creating it confers no ownership; you only pay its rent. Ownership reaches the chain separately, as a lens member's attestation. You can also create anchors from the Parcel Info panel's Tools tab."
        )
        : t(
            'modal.createProposal.missingParcels.explainer',
            "You can create an in-memory proposal or proceed to mint the prerequisite parcels. Minting does not confer ownership, it only creates an on-chain representation. Anyone can mint any parcel to onboard it onto the platform. You can also mint them from the Parcel Info panel's Tools tab."
        );

    message.innerHTML = `
        <p>${introMessage}</p>
        <div class="missing-parcels-list">${parcelList}</div>
        <p class="missing-parcels-explainer">${explainerText}</p>
        <p>${proceedPrompt}</p>
    `;

    const mintLabel = anchors
        ? (single
            ? t('modal.createProposal.missingParcels.createAnchor', 'Create the parcel anchor')
            : t('modal.createProposal.missingParcels.createAnchors', 'Create the parcel anchors'))
        : t('modal.createProposal.missingParcels.mintPrerequisites', 'Mint the prerequisites');
    const dialogApi = window.CbDialog.open({
        title: anchors
            ? t('modal.createProposal.missingParcels.anchorTitle', 'Parcel anchors missing')
            : t('modal.createProposal.missingParcels.title', 'Parcels not on the chain yet'),
        size: 'md',
        confirm: true,
        className: 'missing-parcels-dialog',
        closeLabel: t('modal.createProposal.walletNotConnected.cancel', 'Cancel'),
        body: message,
        actions: [
            { id: 'memory', label: t('modal.createProposal.missingParcels.createInMemory', 'Create in memory'), role: 'secondary' },
            { id: 'mint', label: mintLabel, role: 'primary' }
        ]
    });
    const result = dialogApi ? await dialogApi.closed : null;
    setProposalModalDimmed(false);
    return result === 'memory' || result === 'mint' ? result : 'cancel';
}

function showUploadProposalModal(proposal) {
    if (typeof document === 'undefined' || !proposal) return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    // Get frontend base URL (urbangametheory.xyz or localhost)
    const fragment = document.createDocumentFragment();

    const uploadSuccessText = tShare('uploadSuccess', 'Proposal uploaded! You can now share it with others');
    const uploadButtonLabel = tShare('uploadButton', 'Upload');
    const connectWalletLabel = tShare('connectWalletButton', 'Connect Wallet');
    const mintActionLabel = tShare('mintButton', 'Mint');
    const downloadButtonLabel = tShare('downloadButton', 'Download');

    // Rows container for stable layout. Looks and layout live in css/modals.css (.share-proposal-*);
    // the rows' parts are shown and hidden by the state code below (style.display).
    const rowsContainer = document.createElement('div');
    rowsContainer.className = 'share-proposal-rows';

    // Upload row
    const uploadRow = document.createElement('div');
    uploadRow.className = 'share-proposal-row';

    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'btn btn-primary share-proposal-row__main';
    uploadButton.textContent = uploadButtonLabel;
    uploadRow.appendChild(uploadButton);

    const uploadLinkGroup = document.createElement('div');
    uploadLinkGroup.className = 'share-proposal-link-group';
    uploadLinkGroup.style.display = 'none';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.className = 'share-modal-link share-proposal-link';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-proposal-copy';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
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

    uploadLinkGroup.appendChild(urlInput);
    uploadLinkGroup.appendChild(copyButton);
    uploadRow.appendChild(uploadLinkGroup);
    rowsContainer.appendChild(uploadRow);

    // Mint row
    const mintRow = document.createElement('div');
    mintRow.className = 'share-proposal-row';

    const mintButton = document.createElement('button');
    mintButton.type = 'button';
    mintButton.className = 'btn btn-primary share-proposal-row__main';
    mintRow.appendChild(mintButton);

    const mintedLinkGroup = document.createElement('div');
    mintedLinkGroup.className = 'share-proposal-link-group';
    mintedLinkGroup.style.display = 'none';

    const mintedLinkInput = document.createElement('input');
    mintedLinkInput.type = 'text';
    mintedLinkInput.readOnly = true;
    mintedLinkInput.className = 'share-modal-link share-proposal-link';

    const mintedCopyButton = document.createElement('button');
    mintedCopyButton.type = 'button';
    mintedCopyButton.className = 'btn share-proposal-copy';
    mintedCopyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    mintedCopyButton.addEventListener('click', () => {
        if (!mintedLinkInput.value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(mintedLinkInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                mintedLinkInput.focus();
                mintedLinkInput.select();
            });
        } else {
            mintedLinkInput.focus();
            mintedLinkInput.select();
        }
    });

    mintedLinkGroup.appendChild(mintedLinkInput);
    mintedLinkGroup.appendChild(mintedCopyButton);
    mintRow.appendChild(mintedLinkGroup);
    rowsContainer.appendChild(mintRow);

    // Download row
    const downloadRow = document.createElement('div');
    downloadRow.className = 'share-proposal-row';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'btn share-proposal-row__main';
    downloadButton.textContent = downloadButtonLabel;
    downloadRow.appendChild(downloadButton);

    rowsContainer.appendChild(downloadRow);

    // Say WHAT is being shared: name, type and the stored screenshot (when one exists) sit at
    // the top of the modal, so the link is never anonymous.
    const identity = document.createElement('div');
    identity.className = 'share-modal-identity';
    const identityThumb = (typeof buildProposalThumbHtml === 'function') ? buildProposalThumbHtml(proposal) : '';
    const identityName = String(proposal.title || proposal.name || proposal.proposalName || '').trim()
        || tShare('untitledProposal', 'Untitled proposal');
    const identityType = (typeof getProposalDisplayTypeLabel === 'function') ? getProposalDisplayTypeLabel(proposal) : '';
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : (value => String(value));
    identity.innerHTML = `
        ${identityThumb}
        <div class="share-modal-identity-text">
            <strong>${esc(identityName)}</strong>
            ${identityType ? `<span>${esc(identityType)}</span>` : ''}
        </div>
    `;
    fragment.appendChild(identity);

    fragment.appendChild(rowsContainer);

    // Escape hatch to the multi-proposal flow: share EVERYTHING currently applied as one plan.
    const sharePlanButton = document.createElement('button');
    sharePlanButton.type = 'button';
    sharePlanButton.className = 'btn btn-block share-modal-plan-btn';
    sharePlanButton.textContent = tShare('sharePlanButton', 'Share the whole plan instead (all applied proposals)…');
    sharePlanButton.addEventListener('click', () => {
        // The dialog STAYS UP until the plan panel behind it is built and the map framed. Closing
        // first is what made this feel broken: the modal vanished instantly and left the user on a
        // bare map for as long as three hundred rows and a map fit take, with nothing saying why.
        // So the wait is shown where the click happened, and the dialog is the thing that hides it.
        sharePlanButton.disabled = true;
        sharePlanButton.textContent = '';
        const spinner = document.createElement('i');
        spinner.className = 'fas fa-spinner fa-spin';
        spinner.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = tShare('preparingPlan', 'Preparing plan...');
        sharePlanButton.appendChild(spinner);
        sharePlanButton.appendChild(label);

        // THIS dialog, not every share modal on the page. The old code closed them all, which was
        // harmless when the gap was two frames; now it is however long the panel takes, which is
        // long enough for the user to dismiss this one and open another — and closing that one for
        // them would look like the app losing its place. Resolved at click time, since the button
        // lives in a fragment until the modal is mounted.
        const ownOverlay = typeof sharePlanButton.closest === 'function'
            ? sharePlanButton.closest('.share-modal-overlay')
            : null;
        const closeThisDialog = () => {
            try {
                // Already gone (Escape, ×, overlay click) — nothing to close, and nothing to steal.
                if (!ownOverlay || !ownOverlay.isConnected) return;
                // The share dialog's own close button (the shared dialog's header).
                const closeButton = ownOverlay.querySelector('.cb-dialog__header .close-circle-btn');
                if (closeButton) closeButton.click();
            } catch (_) { }
        };

        const go = () => {
            if (typeof shareAppliedProposals !== 'function') { closeThisDialog(); return; }
            // The panel counts its own rows; show that instead of an unchanging spinner, because
            // "Listing 40/299" is the difference between waiting and wondering if it hung.
            const ready = shareAppliedProposals({
                onProgress: (text) => { if (text) label.textContent = text; }
            });
            // Close on success AND on failure: a panel that never becomes ready must not trap the
            // user behind a dialog whose only other exit is the close button they cannot see past.
            if (ready && typeof ready.then === 'function') ready.then(closeThisDialog, closeThisDialog);
            else closeThisDialog();
        };
        // One frame to apply the spinner, one to be sure it painted, before the work starts.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(go));
        } else {
            go();
        }
    });
    fragment.appendChild(sharePlanButton);

    // Status message container: the error tone until a message says otherwise (setStatusTone).
    const uploadStatus = document.createElement('div');
    uploadStatus.className = 'share-proposal-status is-error';
    fragment.appendChild(uploadStatus);
    const setStatusTone = isError => uploadStatus.classList.toggle('is-error', Boolean(isError));

    const shareActionsContainer = document.createElement('div');
    shareActionsContainer.className = 'share-modal-share-actions';
    shareActionsContainer.style.display = 'none';

    const shareLabel = document.createElement('div');
    shareLabel.className = 'share-proposal-label';
    shareLabel.textContent = tShare('shareViaLabel', 'Share via');
    shareActionsContainer.appendChild(shareLabel);

    const shareButtonsRow = document.createElement('div');
    shareButtonsRow.className = 'share-proposal-row';

    const tweetButton = document.createElement('button');
    tweetButton.type = 'button';
    tweetButton.className = 'btn share-proposal-row__main';
    tweetButton.textContent = tShare('tweetButton', 'Tweet this proposal');
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
    nativeShareButton.className = 'btn share-proposal-row__main';
    nativeShareButton.textContent = tShare('nativeShareButton', 'Share...');
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

    const cityQueryParam = buildCityQueryParam(proposal && proposal.city);
    let uploadedId = null;
    let shareUrl = null;
    let mintedExplorerUrl = null;

    const isWalletConnected = () => {
        if (!window.walletManager || typeof window.walletManager.getState !== 'function') return false;
        const walletState = window.walletManager.getState();
        return walletState && walletState.status === 'connected'
            && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
    };

    const computeShareUrlFromProposal = () => {
        try {
            // Prefer the serial (numeric) id: getServerProposalId returns the first non-local
            // candidate, which for a downloaded proposal can be the uploader's local id. Falling
            // back to it would hide the share link and offer to re-upload something already there.
            const serialId = typeof getSerialProposalId === 'function' ? getSerialProposalId(proposal) : null;
            const serverId = serialId || (typeof getServerProposalId === 'function'
                ? getServerProposalId(proposal)
                : (proposal && (proposal.serverProposalId || proposal.id)));
            if (serverId && /^\d+$/.test(String(serverId))) {
                const joiner = cityQueryParam ? '&' : '?';
                return `${resolveFrontendBaseUrl()}/proposals/${serverId}${cityQueryParam}${joiner}3d${shareLangParam()}`;
            }
            // Minted but NOT uploaded → share the on-chain LOCATION. The recipient reconstructs the
            // proposal from the NFT + its metadata (no server upload needed). This is the blockchain
            // share path: it carries only the location, not a geometry blob.
            const chainRefApi = window.ChainProposalRef;
            const ref = (chainRefApi && typeof chainRefApi.chainRefFromProposal === 'function')
                ? chainRefApi.chainRefFromProposal(proposal)
                : null;
            const chainPath = (ref && typeof chainRefApi.buildChainProposalPath === 'function')
                ? chainRefApi.buildChainProposalPath(ref)
                : null;
            if (chainPath) {
                const joiner = cityQueryParam ? '&' : '?';
                return `${resolveFrontendBaseUrl()}${chainPath}${cityQueryParam}${joiner}3d${shareLangParam()}`;
            }
            return null;
        } catch (err) {
            console.warn('Failed to compute share URL', err);
            return null;
        }
    };

    const updateUploadRowUi = () => {
        shareUrl = computeShareUrlFromProposal() || shareUrl;
        const hasShareUrl = !!shareUrl;
        uploadButton.style.display = hasShareUrl ? 'none' : 'inline-flex';
        uploadLinkGroup.style.display = hasShareUrl ? 'flex' : 'none';
        urlInput.value = shareUrl || '';
        shareActionsContainer.style.display = hasShareUrl ? 'block' : 'none';
    };

    const refreshMintRowUi = () => {
        const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
        const hasMinted = existingNft && existingNft.tokenId;
        if (hasMinted) {
            mintedExplorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : '';
            const fallbackLink = existingNft && existingNft.tokenId ? String(existingNft.tokenId) : '';
            mintedLinkInput.value = mintedExplorerUrl || fallbackLink;
            mintButton.style.display = 'none';
            mintedLinkGroup.style.display = 'flex';
            mintButton.disabled = true;
            return;
        }

        mintedExplorerUrl = null;
        mintedLinkInput.value = '';
        mintButton.style.display = 'inline-flex';
        mintedLinkGroup.style.display = 'none';
        mintButton.disabled = false;

        const connected = isWalletConnected();
        mintButton.textContent = connected
            ? tShare('mintButton', 'Mint')
            : tShare('connectWalletButton', 'Connect Wallet');
    };

    refreshMintRowUi();
    updateUploadRowUi();

    // Keep mint button label in sync with wallet state (only if not minted)
    let detachWalletStateListener = null;
    let lastWalletConnected = isWalletConnected();
    const handleWalletStateChange = () => {
        const connected = isWalletConnected();
        const justConnected = connected && !lastWalletConnected;
        lastWalletConnected = connected;
        refreshMintRowUi();
        if (justConnected && uploadStatus) {
            setStatusTone(false);
            uploadStatus.textContent = tShare('walletConnectedStatus', 'Wallet connected. You can proceed to mint the proposal');
        }
    };
    if (window.walletManager && typeof window.walletManager.on === 'function') {
        detachWalletStateListener = window.walletManager.on('stateChanged', () => handleWalletStateChange());
    }


    // Upload handler
    uploadButton.addEventListener('click', async () => {
        if (uploadButton.disabled) return;

        uploadButton.disabled = true;
        uploadButton.textContent = tShare('uploading', 'Uploading...');

        try {
            const uploadProposal = window.ChainProposalRef?.chainRefFromProposal(proposal)
                ? proposal : buildUploadReadyProposal(proposal);

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
            uploadStatus.textContent = uploadSuccessText;
            setStatusTone(false); // Success: dark text instead of red
            const shareUrlJoiner = cityQueryParam ? '&' : '?';
            shareUrl = `${resolveFrontendBaseUrl()}/proposals/${uploadedId}${cityQueryParam}${shareUrlJoiner}3d${shareLangParam()}`;
            proposal.serverProposalId = uploadedId;

            if (typeof proposalStorage !== 'undefined') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (storedProposal) {
                    storedProposal.serverProposalId = uploadedId;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            urlInput.value = shareUrl;
            updateUploadRowUi();

            // --- NEW: Update details panel and state after upload ---
            // Do not select by numeric server id here (it can collide with on-chain token ids).
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const newProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (newProposal) {
                    const proposalKey = (typeof getProposalKey === 'function' ? getProposalKey(newProposal) : null) || newProposal.proposalId || localKey;
                    if (typeof selectAndHighlightProposal === 'function') {
                        selectAndHighlightProposal(proposalKey, null, false, true);
                    } else if (typeof showProposalInfo === 'function') {
                        showProposalInfo(newProposal, null);
                    }
                }
            }
            // --- END NEW ---

        } catch (error) {
            console.error('Upload failed:', error);
            uploadButton.disabled = false;
            uploadButton.textContent = uploadButtonLabel;

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'), 5000, 'error');
            }
        }
    });

    // Download JSON handler
    downloadButton.addEventListener('click', () => {
        try {
            const proposalData = buildUploadReadyProposal(proposal);
            if (!proposalData) {
                throw new Error(tShare('downloadError', 'Failed to download proposal'));
            }

            const jsonString = JSON.stringify(proposalData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const downloadLink = document.createElement('a');
            downloadLink.href = url;

            // Generate filename
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const proposalId = proposal.proposalId || 'proposal';
            downloadLink.download = `proposal-${proposalId}-${timestamp}.json`;

            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(tShare('downloadSuccess', 'Proposal downloaded as JSON'), 3000, 'success');
            }
        } catch (error) {
            console.error('Download failed:', error);
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('downloadError', 'Failed to download proposal'), 5000, 'error');
            }
        }
    });

    // Mint / Connect wallet handler
    mintButton.addEventListener('click', async () => {
        try {
            // If already minted, block re-mint and surface link
            const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
            if (existingNft && existingNft.tokenId) {
                refreshMintRowUi();
                mintButton.disabled = true;
                mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                if (uploadStatus) {
                    setStatusTone(false);
                    uploadStatus.innerHTML = explorerUrl
                        ? `${tShare('alreadyMinted', 'Already minted')}. <a class="cb-link cb-link--external" href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewOnExplorer', 'View on explorer')}</a>`
                        : tShare('alreadyMinted', 'Already minted');
                }
                return;
            }

            const setMintStatus = (message, opts = {}) => {
                if (!uploadStatus) return;
                const { isError = false, html = false } = opts;
                setStatusTone(isError);
                if (html) {
                    uploadStatus.innerHTML = message;
                } else {
                    uploadStatus.textContent = message;
                }
            };

            const walletManager = window.walletManager;

            // Check wallet connection
            const walletConnected = isWalletConnected();

            if (!walletConnected) {
                // Show wallet selector modal (same flow as Agent Details)
                if (window.walletManager && typeof window.walletManager.openConnectorModal === 'function') {
                    window.walletManager.openConnectorModal();
                } else if (typeof showWalletConnectModal === 'function') {
                    showWalletConnectModal();
                } else if (window.walletManager && typeof window.walletManager.connect === 'function') {
                    await window.walletManager.connect();
                } else {
                    throw new Error('Wallet connection functionality not available');
                }
                return;
            }

            // An approval setup (abstract rights, signed owner decisions) mints only through an
            // adapter that commits it and anchors decisions (Solana, land-readjustmend.md §20).
            // Others stop here, before any upload; the proposal can still be uploaded off-chain.
            const approvalSetup = window.ProposalApprovalRuntime?.uses(proposal) === true;
            if (approvalSetup && window.ProposalChainBridge?.supportsProposalApproval?.('proposal-approval/v1') !== true) {
                const translate = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
                const message = translate
                    ? translate('proposalApproval.chainUnsupported', 'This approval setup is not supported by the current chain adapter.')
                    : 'This approval setup is not supported by the current chain adapter.';
                if (uploadStatus) {
                    setStatusTone(false);
                    uploadStatus.textContent = message;
                }
                return;
            }

            // Resolve lens list for minting; rely solely on the current proposal's lens data
            const lensEntries = getProposalLensEntries(proposal, { fallbackToGlobal: false });
            const lensAddresses = lensEntries.map(e => e && e.address).filter(addr => typeof addr === 'string' && addr.trim().length > 0);
            if (!lensAddresses.length) {
                throw new Error('Lens list is required for minting proposals on-chain.');
            }

            // Persist lens on proposal and storage copy
            proposal.lens = lensEntries;
            proposal.lensAddresses = lensAddresses;
            if (typeof proposalStorage !== 'undefined') {
                const key = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                const stored = key ? proposalStorage.getProposal(key) : null;
                if (stored) {
                    stored.lens = lensEntries;
                    stored.lensAddresses = lensAddresses;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            // Like Create Proposal, mint a local record; server publication is an optional mirror
            // of what the chain and IPFS contain, independent of a preparation or signing key.
            setMintStatus(tShare('mintPreparing', 'Checking which parcels the proposal takes...'));
            const mintRecord = await window.__mintBinding.prepareForMint(proposal);
            window.__mintBinding.adoptMintRecord(proposal, mintRecord);
            if (typeof proposalStorage !== 'undefined') {
                const key = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                const stored = key ? proposalStorage.getProposal(key) : null;
                if (stored && stored !== proposal) window.__mintBinding.adoptMintRecord(stored, mintRecord);
                if (typeof proposalStorage.save === 'function') proposalStorage.save();
            }

            // Trigger the same mint flow as "Create Proposal" button
            // We need to get the parcel IDs from the proposal
            const parcelIds = proposal.cadastreParcelIds || [];
            if (parcelIds.length === 0) {
                // This dialog uses the deployed EVM bridge, whose mint requires a parcel.
                throw new Error('No parcels associated with this proposal');
            }

            // Build a feature map for parcels (used when minting prerequisites to get parcel names)
            const parcelFeatureById = new Map();
            for (const parcelId of parcelIds) {
                const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                const feature = window.CadastralParcelRepository?.get?.(idStr) || null;
                if (feature) parcelFeatureById.set(idStr, feature);
            }

            // Check prerequisite parcel NFTs before minting (mirrors Create Proposal flow)
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                let chainId = null;
                if (walletManager && typeof walletManager.getState === 'function') {
                    const walletState = walletManager.getState();
                    chainId = walletState?.chainId || null;
                }

                if (!chainId) {
                    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                    if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                        chainId = globalScope.DEFAULT_CHAIN_ID;
                    } else {
                        const env = globalScope?.current_environment || 'production';
                        chainId = env === 'development' ? '31337' : '84532';
                    }
                }

                try {
                    setMintStatus(tShare('checkingPrereqParcels', 'Checking prerequisite parcels on-chain...'));
                    const parcelCheckResult = await checkParcelsHaveNFTs(parcelIds, chainId);

                    if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
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
                                        setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                                    }
                                });
                                setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                            } catch (mintModalError) {
                                console.error('Unable to open mint modal for missing parcels', mintModalError);
                                setMintStatus(tShare('mintPrereqModalFailed', 'Could not open parcel minting. Please mint prerequisites first.'), { isError: true });
                            }
                        } else if (action === 'memory') {
                            setMintStatus(tShare('mintSkippedInMemory', 'Mint skipped. Proposal remains in memory.'), { isError: true });
                        } else {
                            setMintStatus(tShare('mintCancelled', 'Mint cancelled.'), { isError: true });
                        }
                        return;
                    }
                } catch (checkError) {
                    console.error('Failed to verify prerequisite parcel NFTs', checkError);
                    setMintStatus(tShare('mintPrereqCheckFailed', 'Could not verify parcel NFTs. Mint cancelled.'), { isError: true });
                    return;
                }
            }

            // Call the blockchain minting function
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                // Set up the proposal for minting - full flow like Create Proposal
                const blockchainSupported = window.ProposalChainBridge.isSupported();

                if (blockchainSupported) {
                    try {
                        // Step 1: Capture screenshot for the proposal
                        setMintStatus(tShare('mintCapturingImage', 'Capturing proposal image...'));
                        console.log('[shareMint] Starting screenshot capture for proposal:', proposal.proposalId);

                        let screenshotDataUrl = null;

                        // Check if we have a cached screenshot on the proposal
                        if (proposal.screenshotDataUrl && proposal.screenshotDataUrl.startsWith('data:image/')) {
                            screenshotDataUrl = proposal.screenshotDataUrl;
                            console.log('[shareMint] Using cached screenshot from proposal, size:', screenshotDataUrl.length);
                        }

                        // If no cached screenshot, try to capture one
                        if (!screenshotDataUrl) {
                            // Screenshot geometry is read from the same repository that loaded the
                            // proposal's cadastral ground; proposal snapshots and map layers are not
                            // alternate geometry stores.
                            const parentFeatures = proposal.site
                                ? [{ type: 'Feature', properties: {}, geometry: proposal.site }]
                                : (window.CadastralParcelRepository?.getMany?.(parcelIds) || []);

                            console.log('[shareMint] Final parentFeatures count:', parentFeatures.length);

                            if (parentFeatures.length > 0 && window.MapScreenshot?.captureViaTileStitch) {
                                // Build combined polygon for screenshot
                                let combinedPolygon = null;
                                const parcelPolygons = [];
                                for (const feature of parentFeatures) {
                                    if (feature && feature.geometry && feature.geometry.coordinates) {
                                        const coords = feature.geometry.coordinates;
                                        if (feature.geometry.type === 'Polygon' && coords[0]) {
                                            parcelPolygons.push(coords[0].map(c => [c[1], c[0]])); // [lat, lng]
                                        } else if (feature.geometry.type === 'MultiPolygon') {
                                            for (const poly of coords) {
                                                if (poly[0]) {
                                                    parcelPolygons.push(poly[0].map(c => [c[1], c[0]]));
                                                }
                                            }
                                        }
                                    }
                                }
                                if (parcelPolygons.length > 0) {
                                    combinedPolygon = parcelPolygons.flat();
                                }

                                if (combinedPolygon && combinedPolygon.length > 0) {
                                    const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                                    const goalBadge = goalKey.replace(/-/g, ' ');
                                    try {
                                        screenshotDataUrl = await window.MapScreenshot.captureViaTileStitch({
                                            polygon: combinedPolygon,
                                            parcelPolygons: parcelPolygons,
                                            padding: 0.12,
                                            zoom: 19,
                                            badge: goalBadge,
                                            // Both were flipped to [lat, lng] just above.
                                            polygonOrder: 'latlng',
                                            parcelPolygonOrder: 'latlng'
                                        });
                                        console.log('[shareMint] Screenshot captured, size:', screenshotDataUrl?.length || 0);
                                    } catch (captureErr) {
                                        console.warn('[shareMint] Screenshot capture failed:', captureErr);
                                    }
                                }
                            }
                        } // end of: if (!screenshotDataUrl)

                        // Step 2: Build metadata and upload to the configured storage backend
                        const shareStorageLabel = (typeof window.getStorageProviderLabel === 'function') ? window.getStorageProviderLabel() : 'decentralized storage';
                        setMintStatus(tShare('mintUploadingStorage', `Uploading to ${shareStorageLabel}...`));
                        console.log(`[shareMint] Building metadata for ${shareStorageLabel} upload`);

                        const createdAtIso = proposal.createdAt || new Date().toISOString();
                        const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                        const goalLabel = goalKey.replace(/-/g, ' ');
                        const proposalName = proposal.name || proposal.title || `${goalLabel} Proposal`;
                        const proposalDescription = proposal.description || '';
                        // Minting leaves the device: this profile's own draft carries its current name.
                        const proposalAuthor = stampCurrentAuthor(proposal).author || '';
                        const isConditional = Boolean(proposal.conditional || proposal.isConditional);

                        // Carry the full immutable record, matching Create Proposal, so chain +
                        // IPFS can reconstruct it without a server row or this browser's storage.
                        const metadataPayload = {
                            name: proposalName,
                            title: proposalName,
                            description: proposalDescription,
                            image: '', // populated after image upload
                            attributes: [
                                { trait_type: 'Goal', value: goalLabel },
                                { trait_type: 'Conditional', value: isConditional ? 'Yes' : 'No' },
                                { trait_type: 'Parcel Count', value: parcelIds.length },
                                { trait_type: 'Author', value: proposalAuthor },
                                ...(proposal.city ? [{ trait_type: 'City', value: proposal.city }] : [])
                            ],
                            properties: window.__chainRecord.metadataProperties({ ...proposal,
                                type: mapGoalToBackendType(goalKey) || 'parcel',
                                createdAt: createdAtIso, author: proposalAuthor, lens: lensAddresses, isConditional })
                        };

                        let metadataUri = '';
                        let assetUploadResult = null;

                        // Metadata is the portable proposal. A failed upload must stop the mint;
                        // otherwise the chain would contain a paid-for, unreconstructable token.
                        if (screenshotDataUrl && window.AssetService && typeof window.AssetService.uploadProposalAssets === 'function') {
                            const fileNameBase = `proposal-${Date.now()}`;
                            const uploadChainId = (window.walletManager && typeof window.walletManager.getState === 'function')
                                ? window.walletManager.getState()?.chainId
                                : null;

                            assetUploadResult = await window.AssetService.uploadProposalAssets({
                                imageData: screenshotDataUrl,
                                metadata: metadataPayload,
                                fileName: fileNameBase,
                                chainId: uploadChainId,
                                target: 'auto'
                            });
                            metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
                            console.log('[shareMint] IPFS upload result:', { metadataUri, imageUri: assetUploadResult?.imageUri });
                        } else if (!screenshotDataUrl) {
                            throw new Error(tShare('mintNoImage', 'Could not capture the proposal image. Minting stopped before signing.'));
                        } else {
                            throw new Error(tShare('mintStorageUnavailable', 'Proposal storage is unavailable. Minting stopped before signing.'));
                        }
                        if (!metadataUri) throw new Error(tShare('mintMetadataMissing', 'The upload returned no metadata URI. Minting stopped before signing.'));

                        // Step 3: Mint on blockchain
                        setMintStatus(tShare('mintWaitingSignature', 'Waiting for wallet signature...'));
                        console.log('[shareMint] Calling mintProposal with metadataUri:', metadataUri);

                        const mintResult = await window.ProposalChainBridge.mintProposal({
                            parcelIds: parcelIds,
                            isConditional: isConditional,
                            ethAmount: 0,
                            tokenAmount: 0n,
                            imageURI: metadataUri,
                            lens: lensAddresses,
                            approvalSetup,
                            onSubmitted: (tx) => {
                                const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(tx?.chainId) : null;
                                const txUrl = baseUrl && tx?.hash ? `${baseUrl}/tx/${tx.hash}` : null;
                                setMintStatus(txUrl
                                    ? `${tShare('mintingOnChain', 'Minting on chain...')} <a class="cb-link cb-link--external" href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                    : tShare('mintingOnChain', 'Minting on chain...'), { html: true });
                            }
                        });

                        const txHash = mintResult && mintResult.transactionHash ? mintResult.transactionHash : null;
                        const chainId = mintResult && mintResult.chainId ? mintResult.chainId : null;
                        const contractAddress = mintResult && mintResult.contractAddress ? mintResult.contractAddress : null;
                        const tokenId = mintResult && mintResult.proposalId != null ? String(mintResult.proposalId) : null;

                        // Update proposal with on-chain data including IPFS metadata URIs
                        proposal.onchain = proposal.onchain || {};
                        proposal.onchain.transactionHash = txHash || proposal.onchain.transactionHash || null;
                        proposal.onchain.proposalId = tokenId || proposal.onchain.proposalId || null;
                        proposal.onchain.chainId = chainId || proposal.onchain.chainId || null;
                        proposal.onchain.contractAddress = contractAddress || proposal.onchain.contractAddress || null;
                        proposal.onchain.metadataUri = metadataUri || proposal.onchain.metadataUri || null;
                        proposal.onchain.metadataUrl = assetUploadResult?.metadataGatewayUrl || proposal.onchain.metadataUrl || null;
                        proposal.onchain.imageUri = assetUploadResult?.imageUri || proposal.onchain.imageUri || null;
                        proposal.onchain.imageUrl = assetUploadResult?.imageGatewayUrl || proposal.onchain.imageUrl || null;

                        proposal.nft = {
                            chain: chainId || null,
                            contract: contractAddress || null,
                            tokenId: tokenId || null
                        };

                        const chainProposalIdValue = (typeof buildChainProposalId === 'function')
                            ? buildChainProposalId(chainId, contractAddress, tokenId)
                            : null;
                        proposal.chainProposalId = chainProposalIdValue || proposal.chainProposalId || null;
                        if (proposal.onchain) {
                            proposal.onchain.chainProposalId = proposal.onchain.chainProposalId || chainProposalIdValue || null;
                        }

                        if (typeof proposalStorage !== 'undefined') {
                            const localKey = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                            const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                            if (storedProposal) {
                                storedProposal.onchain = { ...proposal.onchain };
                                storedProposal.nft = { ...proposal.nft };
                                storedProposal.chainProposalId = chainProposalIdValue || storedProposal.chainProposalId || null;
                                storedProposal.tokenId = storedProposal.tokenId || tokenId;
                                if (typeof proposalStorage._indexProposal === 'function') {
                                    proposalStorage._indexProposal(storedProposal);
                                }
                                if (typeof proposalStorage.save === 'function') {
                                    proposalStorage.save();
                                }
                            }
                        }

                        // Mirror the chain + IPFS record for server-backed discovery and ENS.
                        // A failed mirror leaves the independent chain proposal intact.
                        if (tokenId) {
                            try {
                                setMintStatus(tShare('mintSavingServer', 'Saving proposal to server...'));
                                const persistResult = await uploadProposalToServer(proposal);
                                if (!persistResult || !persistResult.ok) {
                                    throw new Error((persistResult && persistResult.message) || 'server save failed');
                                }
                            } catch (persistErr) {
                                console.error('[shareMint] Server persist after mint failed:', persistErr);
                                if (typeof showEphemeralMessage === 'function') {
                                    showEphemeralMessage(tShare('mintSavedChainOnly', 'Minted on-chain, but saving to the server failed — the ENS link may not resolve until you retry.'), 8000, 'error');
                                }
                            }
                        }

                        // Status updates in modal
                        const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                        if (txHash) {
                            const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(chainId) : null;
                            const txUrl = baseUrl && txHash ? `${baseUrl}/tx/${txHash}` : null;
                            setMintStatus(txUrl
                                ? `${tShare('minting', 'Minting...')} <a class="cb-link cb-link--external" href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                : tShare('minting', 'Minting...'), { html: true });
                        }

                        setMintStatus(explorerUrl
                            ? `${tShare('mintSuccess', 'Success! You can see the proposal minted')} <a class="cb-link cb-link--external" href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('here', 'here')}</a>`
                            : tShare('mintSuccess', 'Success! Proposal minted.'), { html: true });

                        mintedExplorerUrl = explorerUrl || mintedExplorerUrl;
                        mintedLinkInput.value = mintedExplorerUrl || '';
                        refreshMintRowUi();

                        mintButton.disabled = true;
                        mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage(tShare('mintSuccess', 'Proposal minted successfully!'), 5000, 'success');
                        }

                        // Update currentProposalDetailsContext so Share button uses updated NFT data
                        if (typeof currentProposalDetailsContext !== 'undefined' && currentProposalDetailsContext) {
                            currentProposalDetailsContext.nft = { ...proposal.nft };
                            currentProposalDetailsContext.onchain = { ...proposal.onchain };
                            currentProposalDetailsContext.chainProposalId = proposal.chainProposalId;
                        }
                    } catch (mintError) {
                        console.error('Minting failed:', mintError);
                        throw mintError;
                    }
                }
            } else {
                throw new Error('Blockchain functionality not available');
            }
        } catch (error) {
            console.error('Mint action failed:', error);
            if (uploadStatus) {
                uploadStatus.textContent = error.message || tShare('mintError', 'Failed to mint proposal');
                setStatusTone(true);
            }
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('mintError', 'Failed to mint proposal'), 5000, 'error');
            }
        }
    });

    const modal = showSimpleShareModal({
        title: tShare('shareModalTitle', 'Share one proposal'),
        body: fragment,
        actions: [],
        closeOnOverlay: false,
        closeOnEscape: false,
        autoCloseActions: false
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
                    keepOpen: true,
                    onClick: dialog => { resolve('cancel'); dialog.close(); }
                },
                {
                    label: 'Lose local work, refresh & apply',
                    primary: true,
                    keepOpen: true,
                    onClick: dialog => { resolve('refresh'); dialog.close(); }
                }
            ],
            // The close button, Escape and the backdrop cancel too; an action has answered first,
            // and a promise keeps its first answer.
            onClose: () => resolve('cancel')
        });

        if (!modal) resolve('cancel');
    });
}
