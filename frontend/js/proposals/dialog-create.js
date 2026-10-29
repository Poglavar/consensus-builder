// proposals/dialog-create.js — extracted from proposals.js (behavior-preserving relocation).

// How long the create dialog's preview may take to load its tiles before that is reported as a
// failure (the screenshot capture then proceeds anyway; it fetches its own tiles).
const PROPOSAL_PREVIEW_TILE_TIMEOUT_MS = 10000;

function clearProposalPreviewLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) groups.preview.clearLayers();
    if (groups.border) groups.border.clearLayers();
    if (groups.buildingPreview) groups.buildingPreview.clearLayers();
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

    // Check if this is a corridor proposal, to style its geometry differently. Track-ness is a fact
    // about the cross-section (does it carry rail lanes), not a flag on the proposal.
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;
    const corridorDefinition = proposal?.roadProposal?.definition;
    const isTrack = isRoadProposal && typeof corridorIsTrack === 'function' && corridorIsTrack(corridorDefinition);

    // CRITICAL: Check zoom level before rendering parcel features
    // When zoomed out (below parcel display threshold), we should NOT render individual parcel outlines
    const isZoomWithinRange = isTrack
        ? true // Always show parcel outlines for tracks so borders are visible in preview
        : (typeof window !== 'undefined' && typeof window.isZoomWithinParcelRange === 'function')
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
    const primaryStyle = isTrack ? {
        color: '#FF8A00',
        weight: 4,
        opacity: 0.95,
        dashArray: '8 6',
        fillOpacity: 0,
        className: 'proposal-preview-track-outline'
    } : isRoadProposal ? {
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

    // A previewed corridor lays one pair of rails per RAIL LANE of its cross-section — the same rule
    // the map itself uses, so a proposed tram street shows its rails here too, not just a track.
    if (isRoadProposal && typeof renderCorridorRails === 'function') {
        const profile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(corridorDefinition) : null;
        const centerlines = (typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(corridorDefinition) : [];
        if (profile && centerlines.length) {
            renderCorridorRails(centerlines, profile, groups.preview, {
                // The road's own metric frame (projections.md §2), the one it is drawn in on the map.
                frame: window.__corridorFootprint.frameForDefinition(corridorDefinition),
                railColor: '#FF8A00',
                sleeperColor: '#FFC266',
                pane: groups.preview?.__paneName || (window.__proposalHighlightPanes && window.__proposalHighlightPanes.preview) || undefined
            });
        }
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

    if (!bounds && Array.isArray(proposal.cadastreParcelIds) && proposal.cadastreParcelIds.length > 0) {
        const calculated = calculateProposalBounds(proposal.cadastreParcelIds, { proposal });
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
        // Frame the preview in the VISIBLE map, clear of the open list panel (pad its footprint out).
        // animate:false — instant, and avoids requestAnimationFrame, which is throttled to a standstill
        // when the tab isn't actively rendering (an animated fit would then silently no-op).
        const previewPadding = (typeof getProposalPanelFitPadding === 'function')
            ? getProposalPanelFitPadding(40)
            : { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] };
        try {
            window.suppressCameraMoves = true;
            map.fitBounds(bounds, { ...previewPadding, maxZoom: 19, animate: false });
        } finally {
            window.suppressCameraMoves = false;
        }
    } else if (proposal.bounds && proposal.bounds.center) {
        const { lat, lng } = proposal.bounds.center;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            try {
                window.suppressCameraMoves = true;
                map.setView([lat, lng], map.getZoom(), { animate: false });
            } finally {
                window.suppressCameraMoves = false;
            }
        }
    }
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

// Designating existing parcels as road land.
//
// This is NOT a drawing tool. It does not lay out a road — it DECLARES that the parcels the user has
// already selected are road land, and hands that to the proposal so it can be offered for, argued over
// and recorded. Nothing is designed, so there is no centerline, no cross-section, no width to pick and
// no road/track choice to make: the geometry is simply the parcels, merged.
//
// It exists because "give up this land for a road" is a different act from "design a road here", and
// because a parcel's road status has to come from somewhere accountable. It used to come from a
// checkbox in the parcel panel that wrote the shared road-parcel store behind the lifecycle's back;
// this replaces it, and unapplying the proposal gives the land back.
//
// A road you actually design is drawn with the corridor tool (js/road-drawing.js) — one tool, which
// also owns the cross-section, the rails, the junctions and the 3D.
function openRoadDesignationModal() {
    const selection = (typeof getCurrentParcelSelectionContext === 'function')
        ? getCurrentParcelSelectionContext()
        : { layers: [], ids: [] };
    const parcelIds = Array.isArray(selection.ids) ? selection.ids.filter(Boolean) : [];
    const parcels = Array.isArray(selection.layers) ? selection.layers.filter(Boolean) : [];
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const tCorridor = getRoadDesignationTranslator(t);

    if (!parcels.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusSelectParcels', 'Select the parcels to designate as road land.'));
        }
        return;
    }

    // The designation becomes ONE parcel, so the land it names has to be one piece.
    const contiguity = (typeof areParcelsContiguous === 'function')
        ? areParcelsContiguous(parcelIds)
        : { contiguous: true };

    if (!contiguity.contiguous) {
        const message = (typeof t === 'function')
            ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
            : tCorridor('statusContiguity', 'Parcels must be contiguous to designate them as road land.');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('parcels_not_contiguous', message);
        } else {
            window.CbDialog.alert(message);
        }
        return;
    }

    const superGeometry = (typeof buildGeometryFromParcels === 'function')
        ? buildGeometryFromParcels(parcelIds)
        : null;

    if (!superGeometry) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusBoundaryFailed', 'Could not build a boundary from the selected parcels.'));
        }
        return;
    }

    // The designation becomes ONE parcel, and the child-feature builder keeps only the largest part of
    // the geometry it is given. So a merge that comes back in several pieces would quietly drop land —
    // refuse it instead. (A single-part MultiPolygon is just how the union is shaped; that is fine.)
    if (superGeometry.type === 'MultiPolygon' && (superGeometry.coordinates?.length || 0) > 1) {
        const message = tCorridor('statusContiguity', 'Parcels must be contiguous to designate them as road land.');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('parcels_not_contiguous', message);
        }
        console.error('[road-designation] merged parcels came back in several pieces — refusing', superGeometry.coordinates.length);
        return;
    }

    const superFeature = { type: 'Feature', properties: {}, geometry: superGeometry };

    // Clone committed parcel features so the preview cannot mutate the live fabric.
    const parcelFeatures = parcelIds
        .map(id => window.LiveParcelFabric?.get?.(String(id)))
        .map(feature => {
            if (!feature?.geometry) return null;
            try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
        })
        .filter(Boolean);

    if (!parcelFeatures.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusGeometryFailed', 'Could not resolve the selected parcels.'));
        }
        return;
    }

    if (constrainedCorridorState && constrainedCorridorState.close) {
        constrainedCorridorState.close();
    }

    const mapId = `road-designation-map-${Date.now()}`;
    const text = {
        title: tCorridor('designationTitle', 'Designate as road land'),
        hint: tCorridor('designationHint', 'The selected parcels, merged, become road land. Nothing is designed — to lay out a road with lanes, draw it with the road tool instead.'),
        closeLabel: tCorridor('closeLabel', 'Close'),
        mapAriaLabel: tCorridor('mapAriaLabel', 'Designation map'),
        done: tCorridor('done', 'Done'),
        cancel: (typeof t === 'function') ? t('common.cancel', 'Cancel') : 'Cancel'
    };

    // The shared dialog (js/ui/dialogs.js), on the rung above the create dialog it is opened from.
    // .constrained-corridor-overlay / -modal stay as its identity for the inner rules and the specs;
    // Done keeps its data-corridor-done hook. Closing it (×, Cancel, Escape, the backdrop or Done)
    // tears the preview map down.
    let map = null;
    const dialogApi = window.CbDialog.open({
        title: text.title,
        size: 'xl',
        top: true,
        className: 'constrained-corridor-modal',
        overlayClassName: 'constrained-corridor-overlay',
        closeLabel: text.closeLabel,
        body: `
            <p class="corridor-hint">${text.hint}</p>
            <div id="${mapId}" class="corridor-map" aria-label="${text.mapAriaLabel}"></div>`,
        actions: [
            { id: 'cancel', label: text.cancel, role: 'secondary' },
            { id: 'done', label: text.done, role: 'primary', keepOpen: true, onClick: () => persistGeometryAndClose() }
        ],
        onClose: () => {
            if (map) map.remove();
            constrainedCorridorState = null;
        }
    });
    if (!dialogApi) return;
    dialogApi.getActionButton('done').setAttribute('data-corridor-done', '');
    const closeModal = () => dialogApi.close(null);
    constrainedCorridorState = { close: closeModal, overlay: dialogApi.overlay };

    map = (typeof L !== 'undefined' && L.map) ? L.map(mapId, { zoomControl: true, scrollWheelZoom: true }) : null;
    if (!map) {
        closeModal();
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
        style: () => ({ color: '#1f2937', weight: 1.4, fillColor: '#e5e7eb', fillOpacity: 0.12 })
    }).addTo(map);

    // The merged outline IS the geometry being designated — so it is what the preview shows, filled.
    L.geoJSON(superFeature, {
        style: () => ({ color: '#0f172a', weight: 4, fillColor: '#6b7280', fillOpacity: 0.35 })
    }).addTo(map);

    const bounds = parcelLayer.getBounds();
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1));
    }

    // A designation has no centerline — that absence is what says it was never designed, and it is what
    // corridorIsDesignation() reads to keep the cross-section editor and the strip renderer away from it.
    function persistGeometryAndClose() {
        pendingConstrainedCorridor = {
            mode: 'full',
            type: 'road',
            width: DEFAULT_CORRIDOR_WIDTHS.road,
            parcelIds: parcelIds.slice(),
            superGeometry: superGeometry,
            polygon: superGeometry,
            centerline: []
        };
        if (typeof window !== 'undefined') {
            window.pendingConstrainedCorridor = pendingConstrainedCorridor;
        }
        if (typeof setGeometryStatus === 'function') {
            const submittedLabel = (typeof t === 'function')
                ? t('modal.createProposal.geometry.status.submitted', 'Geometry submitted')
                : 'Geometry submitted';
            setGeometryStatus(submittedLabel, { submitted: true });
        }
        closeModal();
    }

    setTimeout(() => {
        try { map.invalidateSize(); } catch (_) { }
    }, 50);
}

function setProposalModalInteractivity(enabled) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const controls = modal.querySelectorAll('input, textarea, select, button');

    controls.forEach(control => {
        // The × and Cancel stay live while a proposal is being created: both only close the dialog.
        const isCloseButton = !!control.classList && (control.classList.contains('close-circle-btn')
            || control.dataset.actionId === 'cancel');
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

function showProposalDialog(overrides = null) {
    // No guest gate here: creating stays on this device (guest-policy.js). Minting, publishing and
    // sharing ask for a profile name.

    // Stash overrides for this session
    proposalDialogOverrides = overrides || null;

    // Lineage for "Copy into new proposal". Set (or cleared) on every dialog open, so a plain
    // create can never inherit a stale source from an earlier copy.
    if (typeof window !== 'undefined') {
        window.pendingProposalCopySource = (overrides && overrides.copySource) ? overrides.copySource : null;
    }

    // Remove any existing create-proposal modal so re-opening the dialog (e.g. after editing a
    // proposal's geometry, which calls showProposalDialog() again) replaces it instead of stacking
    // a second modal on top of the first. A replaced dialog closes as 'replaced', which skips the
    // close cleanup: the proposal state it was opened for carries over to the new one.
    document.querySelectorAll('.create-proposal-modal').forEach(existing => {
        if (existing.__proposalDialog) existing.__proposalDialog.close('replaced');
        else existing.remove();
    });

    const t = getProposalI18nHelper();
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const noParcelsMessage = t(
        'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
        'Please select at least one parcel to create a proposal.'
    );
    // Editing a proposal already on the map (opened via its "Details" button) reuses this same
    // full-property dialog, only reframed: the source id is staged in pendingProposalReplacementSource.
    const isEditingExisting = !!(typeof window !== 'undefined' && window.pendingProposalReplacementSource && window.pendingProposalReplacementSource.proposalId);
    const modalTitle = isEditingExisting
        ? t('modal.createProposal.editTitle', 'Design')
        : t('modal.createProposal.title', 'Create design');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close design dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const proposalTypeLabel = t('modal.createProposal.proposalTypeLabel', 'Design type');
    const proposalGoalLabel = t('modal.createProposal.proposalGoalLabel', 'Design goal');
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
    const nameLabel = t('modal.createProposal.nameLabel', 'Name');
    const namePlaceholder = t('modal.createProposal.namePlaceholderProposal', 'Design name');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const unknownOwnerLabel = t('modal.createProposal.ownerUnknown', 'Unknown');
    const formatOwnerTooltip = (name) => t('modal.createProposal.ownerTooltip', 'Owner: {{name}}', { name });
    const proposalTypeLabels = {
        Purchase: t('modal.createProposal.proposalTypeOptions.purchase', 'Purchase'),
        'Urban Rule': t('modal.createProposal.proposalTypeOptions.urbanRule', 'Urban Rule'),
        'Joint Investment': t('modal.createProposal.proposalTypeOptions.jointInvestment', 'Joint Investment')
    };
    const goalLabels = {
        buildings: t('modal.createProposal.goalOptions.buildings', 'Buildings'),
        single: t('modal.createProposal.goalOptions.single', 'Building(s)'),
        park: t('modal.createProposal.goalOptions.park', 'Park'),
        square: t('modal.createProposal.goalOptions.square', 'Square'),
        lake: t('modal.createProposal.goalOptions.lake', 'Lake'),
        roadTrack: t('modal.createProposal.goalOptions.roadTrack', 'Road/Track'),
        urbanRule: t('modal.createProposal.goalOptions.urbanRule', 'Urban Rule'),
        ownershipTransfer: t('modal.createProposal.goalOptions.ownershipTransfer', 'Ownership transfer')
    };
    const goalSectionLabels = {
        landUse: t('modal.createProposal.goalSections.landUse', 'Land use'),
        parcels: t('modal.createProposal.goalSections.parcels', 'Parcels'),
        ownership: t('modal.createProposal.goalSections.ownership', 'Ownership')
    };
    const asIsLandUseLabel = t('modal.createProposal.goalOptions.asIs', 'As is');
    const parcelsOptions = {
        asIs: t('modal.createProposal.parcelsOptions.asIs', 'As is')
    };
    const ownershipRecipients = {
        noChange: t('modal.createProposal.ownershipRecipients.noChange', 'No change'),
        toMe: t('modal.createProposal.ownershipRecipients.toMe', 'To me'),
        toCity: t('modal.createProposal.ownershipRecipients.toCity', 'To city'),
        thirdParty: t('modal.createProposal.ownershipRecipients.thirdParty', 'Third party')
    };
    const recipientPlaceholder = t('modal.createProposal.recipientPlaceholder', 'Recipient name or 0x address');
    const recipientScopeLabels = {
        specific: t('modal.createProposal.recipientScope.specific', 'Specific address'),
        any: t('modal.createProposal.recipientScope.any', 'Anyone')
    };
    const ownershipTransferLabels = {
        toMe: t('modal.createProposal.ownershipTransfer.toMe', 'To me'),
        fromMe: t('modal.createProposal.ownershipTransfer.fromMe', 'From me')
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
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholder', 'Describe your design…');
    // Title for the collapsible "Options" section: the site tolerance, the summary and similar proposals.
    const optionsSectionTitle = t('modal.createProposal.optionsSectionTitle', 'Options');
    const summaryTitle = t('modal.createProposal.summary.title', 'Design summary');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summaryOwnersLabel = t('modal.createProposal.summary.owners', 'Total owners:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const similarTitle = t('modal.createProposal.similar.title', 'Similar designs:');
    const similarUnknownTitle = t('modal.createProposal.similar.unknownTitle', 'Untitled design');
    const similarUnknownAuthor = t('modal.createProposal.similar.unknownAuthor', 'Unknown');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = isEditingExisting
        ? window.ProposalLineage.forkSubmitLabel(window.pendingProposalReplacementSource.proposalId,
            { fork: window.pendingProposalReplacementSource.fork === true })
        : t('modal.createProposal.submit', 'Create design');
    const cancelLabel = t('common.cancel', 'Cancel');

    const overrideGoal = normalizeGoalKey(proposalDialogOverrides?.goal) || null;
    const overrideAcquisition = proposalDialogOverrides?.acquisitionMode || null;
    const overridePrefill = proposalDialogOverrides?.prefill || {};
    const overrideSummaryStats = proposalDialogOverrides?.summaryStats || null;
    const overrideGeometryPreset = proposalDialogOverrides?.geometryPreset || null;
    const goalLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockGoal);
    const acquisitionLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockAcquisition);

    const selection = getCurrentParcelSelectionContext();
    const parcelIds = selection.ids;
    const selectedFeatures = parcelIds.map(id => window.LiveParcelFabric?.get?.(String(id))).filter(Boolean);
    const selectedParcels = selection.layers;
    const roadScreenshotContext = ((typeof window !== 'undefined' && window.pendingRoadDrawingProposal)
        ? window.pendingRoadDrawingProposal
        : pendingRoadDrawingProposal) || null;
    // The preview context is expensive to build (it walks the parcel cache for neighbour outlines), and
    // it is only needed to draw a thumbnail. Building it here would hold the dialog closed while the
    // user waits, so it is deferred until after the modal has painted; the container is reserved now and
    // removed later if there turns out to be nothing to preview.
    const hasScreenshotCandidate = selectedParcels.length > 0 || !!roadScreenshotContext;

    currentProposalTool = null;

    // A site-first proposal (js/site-drawing.js) carries its ground as a site and its declaration
    // as the binding, possibly empty on bare ground: no live selection is needed.
    const siteContext = (proposalDialogOverrides && proposalDialogOverrides.siteContext
        && proposalDialogOverrides.siteContext.site) ? proposalDialogOverrides.siteContext : null;
    window.pendingProposalSiteContext = siteContext;
    if (!siteContext && (!selectedParcels.length || selectedFeatures.length !== parcelIds.length)) {
        updateStatus(noParcelsMessage);
        return;
    }

    const siteArea = siteContext && window.__siteDraft ? window.__siteDraft.siteAreaM2(siteContext.site) : 0;
    const siteParcelIds = siteContext ? (siteContext.cadastreParcelIds || []) : [];
    const sourceAreas = selectedFeatures.map(feature => window.ProposalArea.sourceAreaM2(feature,
        geometry => turf.area({ type: 'Feature', properties: {}, geometry })));
    const totalArea = siteContext ? siteArea : sourceAreas.every(Number.isFinite)
        ? sourceAreas.reduce((sum, area) => sum + area, 0) : null;

    const ownershipStats = computeOwnershipStatsFromSelection(selection);
    const totalOwners = !siteContext && Number.isFinite(ownershipStats.ownerCount)
        ? ownershipStats.ownerCount : t('common.unknown', 'Unknown');
    const siteSummaryHtml = siteContext ? `<p class="proposal-site-summary">${siteParcelIds.length
        ? t('modal.createProposal.site.bound', 'Site of {{area}} m², bound parcels: {{count}}. Publishing checks the binding against the full cadastre.', { area: CbFormat.formatNumber(siteArea, { maxFractionDigits: 0 }), count: siteParcelIds.length })
        : t('modal.createProposal.site.unbound', 'Site of {{area}} m² without bound parcel records. Ownership is unknown. On-chain execution requires an authority verdict.', { area: CbFormat.formatNumber(siteArea, { maxFractionDigits: 0 }) })}</p>` : '';
    const toleranceLabel = t('modal.createProposal.tolerance.label', 'Parcel intrusion tolerance (m)');
    const toleranceHelp = t('modal.createProposal.tolerance.help', 'A parcel joins the design when the site reaches into it by more than this width (linear, not area). In cities keep 0: you cannot take any of a neighbour\'s parcel. Use it only for measurement error; max 1 m.');
    const toleranceValue = siteContext && Number(siteContext.toleranceM) > 0 ? Number(siteContext.toleranceM) : 0;
    const ownershipMode = ownershipStats.mode;
    currentOwnershipMode = ownershipMode;
    // Create parcel list HTML with error handling
    const parcelListHTML = selectedFeatures.map(feature => {
        const parcelId = getParcelIdFromFeature(feature);
        const parcelNumber = getParcelDisplayNumberFromProperties(feature.properties, parcelId || unknownParcelLabel) || unknownParcelLabel;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    const ownerName = owner.name || unknownOwnerLabel;
                    const ownerTooltip = formatOwnerTooltip(ownerName);
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" title="${ownerTooltip}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">${parcelLabel} ${parcelNumber}</span>
                </div>
            </div>
        `;
    }).join('');

    // The dialog body. Its chrome (title, close, footer actions, focus trap, phone bottom sheet) is
    // CbDialog's; the ids and radio names below are what the facet, geometry and create scripts
    // read. The facets are native radios in cb-segmented rows (.proposal-radio is the hook core.js
    // reads a choice's label from), the typology a cb-tiles grid; the hidden main-type and
    // transfer-direction rows are cb-segmented buttons. Selected is :checked or aria-pressed.
    const bodyHtml = `
                ${siteSummaryHtml}
                ${hasScreenshotCandidate ? '<div class="form-group proposal-screenshot-loading" id="proposalScreenshotContainer"><div class="proposal-screenshot-spinner" aria-label="Preparing preview"></div></div>' : ''}
                <div class="form-group proposal-author-row">
                    <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                    <input type="text" id="proposalAuthor" class="proposal-author-name" placeholder="${authorPlaceholder}" disabled>
                </div>
                <div class="proposal-design-fields">
                    <div class="proposal-choices" id="proposalMainTypeGroup" hidden>
                        <div class="cb-kicker" id="proposalMainTypeHeading">${proposalTypeLabel}</div>
                        <div class="cb-segmented" role="group" aria-labelledby="proposalMainTypeHeading">
                            <button type="button" class="cb-segmented__option" aria-pressed="true" data-proposal-main-type="Purchase" onclick="setProposalMainType('Purchase')">${proposalTypeLabels.Purchase}</button>
                            <button type="button" class="cb-segmented__option" aria-pressed="false" data-proposal-main-type="Urban Rule" onclick="handleUrbanRuleMainTypeClick()">${proposalTypeLabels['Urban Rule']}</button>
                            <button type="button" class="cb-segmented__option" aria-pressed="false" data-proposal-main-type="Joint Investment" disabled>${proposalTypeLabels['Joint Investment']}</button>
                        </div>
                    </div>
                    <input type="hidden" id="proposalMainType" value="Purchase">
                    <div class="proposal-choices" id="proposalGoalGroup">
                        <div class="proposal-goal-section" data-goal-section="land-use">
                            <div class="cb-kicker" id="proposalLandUseHeading">${goalSectionLabels.landUse}</div>
                            <div class="cb-segmented" role="radiogroup" aria-labelledby="proposalLandUseHeading" id="proposalLandUseGroup">
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="as-is" checked onchange="onProposalLandUseChange()"><span>${asIsLandUseLabel}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="square" onchange="onProposalLandUseChange()"><i class="fa-solid fa-chess-board" aria-hidden="true"></i><span>${goalLabels.square}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="park" onchange="onProposalLandUseChange()"><i class="fa-solid fa-tree" aria-hidden="true"></i><span>${goalLabels.park}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="lake" onchange="onProposalLandUseChange()"><i class="fa-solid fa-water" aria-hidden="true"></i><span>${goalLabels.lake}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="single" onchange="onProposalLandUseChange()"><i class="fa-solid fa-building" aria-hidden="true"></i><span>${goalLabels.single}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="road-track" onchange="onProposalLandUseChange()"><i class="fa-solid fa-road" aria-hidden="true"></i><span>${goalLabels.roadTrack}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalLandUse" value="urban-rule" onchange="onProposalLandUseChange()"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>${goalLabels.urbanRule}</span></label>
                            </div>
                        </div>
                        <div class="proposal-goal-section" data-goal-section="parcels">
                            <div class="cb-kicker" id="proposalParcelsHeading">${goalSectionLabels.parcels}</div>
                            <div class="cb-segmented" role="radiogroup" aria-labelledby="proposalParcelsHeading" id="proposalParcelsGroup">
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalParcelsMode" value="as-is" checked onchange="onProposalParcelsChange()"><span>${parcelsOptions.asIs}</span></label>
                            </div>
                            <div class="proposal-facet-static" id="proposalParcelsStatic" style="display:none;"></div>
                        </div>
                        <div class="proposal-goal-section" data-goal-section="ownership">
                            <div class="cb-kicker" id="proposalOwnershipHeading">${goalSectionLabels.ownership}</div>
                            <div class="cb-segmented" role="radiogroup" aria-labelledby="proposalOwnershipHeading" id="proposalOwnershipGroup">
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalOwnership" value="no-change" checked onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.noChange}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalOwnership" value="to-me" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toMe}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalOwnership" value="to-city" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toCity}</span></label>
                                <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalOwnership" value="third-party" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.thirdParty}</span></label>
                            </div>
                            <div class="proposal-facet-static" id="proposalOwnershipStatic" style="display:none;"></div>
                            <div class="proposal-inset" id="proposalRecipientOptions" style="display:none;">
                                <div class="cb-segmented" role="radiogroup" aria-label="${ownershipRecipients.thirdParty}">
                                    <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalRecipientScope" value="any" checked onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.any}</span></label>
                                    <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalRecipientScope" value="specific" onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.specific}</span></label>
                                </div>
                                <input type="text" id="proposalRecipientAddress" class="proposal-recipient-input" placeholder="${recipientPlaceholder}" oninput="onProposalOwnershipChange()">
                            </div>
                        </div>
                    </div>
                    <div class="proposal-choices" id="proposalOwnershipTransferGroup" style="display:none;">
                        <div class="cb-kicker" id="proposalTransferHeading">${t('modal.createProposal.ownershipTransfer.label', 'Transfer direction')}</div>
                        <div class="cb-segmented" role="group" aria-labelledby="proposalTransferHeading">
                            <button type="button" class="cb-segmented__option proposal-ownership-transfer-button" aria-pressed="true" data-transfer-direction="to-me" onclick="setOwnershipTransferDirection('to-me')">${ownershipTransferLabels.toMe}</button>
                            <button type="button" class="cb-segmented__option proposal-ownership-transfer-button" aria-pressed="false" data-transfer-direction="from-me" onclick="setOwnershipTransferDirection('from-me')">${ownershipTransferLabels.fromMe}</button>
                        </div>
                    </div>
                    <div class="proposal-choices" id="proposalAcquisitionGroup">
                        <div class="cb-kicker" id="proposalAcquisitionHeading">${acquisitionLabel}</div>
                        <div class="cb-segmented" role="radiogroup" aria-labelledby="proposalAcquisitionHeading">
                            <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalAcquisition" value="full" checked onchange="setProposalAcquisitionMode('full')"><span>${acquisitionOptions.full}</span></label>
                            <label class="cb-segmented__option proposal-radio"><input type="radio" name="proposalAcquisition" value="partial" onchange="setProposalAcquisitionMode('partial')"><span class="proposal-acquisition-partial-label">${acquisitionOptions.partial}</span></label>
                        </div>
                    </div>
                    <div class="form-group proposal-inset" id="proposalTypologyGroup" style="display:none;">
                        <div class="cb-kicker" id="proposalTypologyHeading">${proposalTypologyLabel}</div>
                        <div class="cb-tiles" role="group" aria-labelledby="proposalTypologyHeading">
                            <button type="button" class="cb-tile proposal-typology-button" aria-pressed="false" data-proposal-typology="block" onclick="handleUrbanRuleTypologyClick('block', { skipLaunch: true })"><i class="cb-tile__icon fa-solid fa-city" aria-hidden="true"></i><span class="cb-tile__label">${typologyOptions.block}</span></button>
                            <button type="button" class="cb-tile proposal-typology-button" aria-pressed="false" data-proposal-typology="row" onclick="handleUrbanRuleTypologyClick('row', { skipLaunch: true })"><i class="cb-tile__icon fa-solid fa-grip" aria-hidden="true"></i><span class="cb-tile__label">${typologyOptions.row}</span></button>
                            <button type="button" class="cb-tile proposal-typology-button" aria-pressed="false" data-proposal-typology="parcelBased" onclick="handleUrbanRuleTypologyClick('parcelBased', { skipLaunch: true })"><i class="cb-tile__icon fa-solid fa-house" aria-hidden="true"></i><span class="cb-tile__label">${typologyOptions.parcelBased}</span></button>
                        </div>
                    </div>
                    <div class="form-group proposal-inset" id="proposalGeometryGroup" style="display:none;">
                        <div id="proposalGeometryStatus" class="proposal-geometry-status">${t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry')}</div>
                        <div class="proposal-geometry-buttons" id="proposalGeometryButtons"></div>
                    </div>
                </div>
                <input type="hidden" id="proposalType" value="">
                <input type="hidden" id="proposalAcquisitionMode" value="full">
                <input type="hidden" id="proposalBoundaryMode" value="multiple">
                <hr class="proposal-section-divider">
                <div class="form-group">
                    <label for="proposalName" class="proposal-inline-field">
                        <span>${nameLabel}</span>
                        <input type="text" id="proposalName" placeholder="${namePlaceholder}">
                    </label>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <input type="text" id="proposalDescription" class="proposal-description-input" placeholder="${descriptionPlaceholder}">
                </div>
                <div class="proposal-similar-section" id="proposalSimilarSection" style="display:none;">
                    <h4>${similarTitle}</h4>
                    <div id="proposalSimilarList" class="proposal-similar-list"></div>
                </div>
                <div class="proposal-options-collapsible collapsible collapsed" id="proposalOptionsSection">
                    <div class="collapsible-header proposal-collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalOptionsContent" onclick="(function(){
                        var section = document.getElementById('proposalOptionsSection');
                        var content = document.getElementById('proposalOptionsContent');
                        var icon = document.getElementById('proposalOptionsChevron');
                        section.classList.toggle('collapsed');
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
                    })()">
                        <h3 class="proposal-collapsible-title">${optionsSectionTitle}</h3>
                        <i id="proposalOptionsChevron" class="fas fa-chevron-down proposal-collapsible-chevron" aria-hidden="true"></i>
                    </div>
                    <div id="proposalOptionsContent" style="display:none;">
                        <div class="form-group proposal-options-section">
                            <div class="proposal-tolerance-row" id="proposalToleranceRow">
                                <label for="proposalToleranceM">${toleranceLabel}</label>
                                <input type="number" id="proposalToleranceM" min="0" max="1" step="0.01" value="${toleranceValue}" inputmode="decimal">
                                <p class="proposal-tolerance-help">${toleranceHelp}</p>
                            </div>
                        </div>
                        <div class="proposal-summary collapsible collapsed" id="proposalSummarySection">
                            <div class="collapsible-header proposal-collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalSummaryContent" onclick="(function(e){
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
                                <h3 class="proposal-collapsible-title">${summaryTitle}</h3>
                                <i id="proposalSummaryChevron" class="fas fa-chevron-down proposal-collapsible-chevron" aria-hidden="true"></i>
                            </div>
                            <div id="proposalSummaryContent" style="display:none;">
                                <div class="summary-stats">
                                    <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                                    <p><strong>${summaryAreaLabel}</strong> ${CbFormat.formatArea(totalArea, { missing: t('common.unknown', 'Unknown') })}</p>
                                    <p><strong>${summaryOwnersLabel}</strong> ${totalOwners}</p>
                                </div>
                                <div class="parcel-list">
                                    <h4>${summarySelectedLabel}</h4>
                                    ${parcelListHTML}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
    `;

    // The dialog on the shared chrome (js/ui/dialogs.js). The overlay keeps the .create-proposal-modal
    // identity every script finds the dialog by, the card .proposal-modal-content and the footer
    // .proposal-modal-footer. The backdrop does not close it (a stray click must not drop a
    // half-filled form); the ×, Cancel and Escape run the close cleanup through onClose.
    const dialogApi = window.CbDialog.open({
        title: modalTitle,
        className: 'proposal-modal-content',
        overlayClassName: 'create-proposal-modal',
        footerClassName: 'proposal-modal-footer',
        closeLabel: closeAriaLabel,
        closeOnBackdrop: false,
        autofocus: false,
        body: bodyHtml,
        actions: [
            { id: 'cancel', label: cancelLabel, role: 'secondary' },
            { id: 'create', label: submitLabel, role: 'primary', keepOpen: true, onClick: () => createProposal() }
        ],
        onClose: onProposalDialogClosed
    });
    if (!dialogApi) return;
    const modal = dialogApi.overlay;
    modal.__proposalDialog = dialogApi;
    decorateProposalDialogChrome(dialogApi, {
        submitId: 'createProposalSubmitButton',
        lensTooltip,
        hintId: 'proposalGeometryRequirementHint'
    });

    // Reset stored screenshot
    proposalModalScreenshotDataUrl = null;
    proposalModalScreenshotPromise = null;

    // Deliberately a timeout rather than requestAnimationFrame: rAF does not fire while the tab is not
    // rendering, and the preview would then never appear.
    if (hasScreenshotCandidate) setTimeout(() => renderProposalScreenshotPreview(modal, selectedParcels, overrideGoal, roadScreenshotContext), 0);

    function renderProposalScreenshotPreview(modal, selectedParcels, overrideGoal, roadScreenshotContext) {
        const screenshotContainer = modal.querySelector('#proposalScreenshotContainer');
        if (!screenshotContainer) return;

        const screenshotContext = buildProposalScreenshotContext(selectedParcels, {
            goal: overrideGoal,
            roadContext: roadScreenshotContext
        });

        if (!screenshotContext || !screenshotContext.polygon
            || !window.MapScreenshot || typeof window.MapScreenshot.renderPolygonPreview !== 'function') {
            screenshotContainer.remove(); // nothing to preview after all
            return;
        }

        screenshotContainer.classList.remove('proposal-screenshot-loading');
        screenshotContainer.innerHTML = '';

        {
            (async () => {
                try {
                    const previewWrapper = document.createElement('div');
                    previewWrapper.className = 'map-screenshot-container';
                    screenshotContainer.appendChild(previewWrapper);

                    const resolveGoalBadge = () => getProposalGoalBadge(currentProposalTool || 'square');
                    updateProposalScreenshotGoalIcon(currentProposalTool || 'square');

                    window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                        polygon: screenshotContext.polygon,
                        bounds: screenshotContext.bounds || null,
                        padding: 0.05,
                        parcelPolygons: screenshotContext.parcelPolygons,
                        neighbours: screenshotContext.neighbours || [],
                        fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly,
                        polygonOrder: screenshotContext.polygonOrder || 'auto',
                        parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto'
                    });

                    // Capture the screenshot after tiles have loaded and store it for minting
                    const captureScreenshot = () => {
                        if (proposalModalScreenshotPromise) return proposalModalScreenshotPromise;
                        if (!previewWrapper._leafletPreviewMap) {
                            console.warn('[proposal-modal] Preview map not ready for capture');
                            return null;
                        }
                        if (!window.MapScreenshot.captureViaTileStitch || !screenshotContext?.polygon) {
                            console.warn('[proposal-modal] Tile stitch capture unavailable; skipping preview capture');
                            return null;
                        }

                        if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                            console.debug('[proposal-modal] capturing screenshot', {
                                polygonLength: screenshotContext.polygon?.length,
                                parcelPolygonsCount: screenshotContext.parcelPolygons?.length,
                                hasBounds: !!screenshotContext.bounds,
                                fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                            });
                        }

                        const stitchStart = (performance && performance.now) ? performance.now() : Date.now();
                        const capturePromise = (async () => {
                            try {
                                const dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                    polygon: screenshotContext.polygon,
                                    parcelPolygons: screenshotContext.parcelPolygons || [],
                                    neighbours: screenshotContext.neighbours || [],
                                    bounds: screenshotContext.bounds || null,
                                    padding: 0.12,
                                    zoom: 19,
                                    badge: resolveGoalBadge(),
                                    polygonOrder: screenshotContext.polygonOrder || 'auto',
                                    parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto',
                                    fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                                });
                                const stitchMs = ((performance && performance.now ? performance.now() : Date.now()) - stitchStart).toFixed(1);

                                let byteSize = 0;
                                if (dataUrl && dataUrl.startsWith('data:image/')) {
                                    const base64Part = dataUrl.split(',')[1];
                                    byteSize = base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                                }

                                if (byteSize >= 5000) {
                                    proposalModalScreenshotDataUrl = dataUrl;
                                    console.debug('[proposal-modal] Tile stitch captured', { byteSize, stitchMs });
                                    return dataUrl;
                                }

                                console.warn('[proposal-modal] Tile stitch produced small image:', byteSize, 'bytes');
                                return null;
                            } catch (err) {
                                console.warn('[proposal-modal] Failed to capture screenshot for storage:', err);
                                return null;
                            }
                        })();

                        proposalModalScreenshotPromise = capturePromise;
                        return capturePromise;
                    };

                    // Capture once the preview's tiles have loaded. renderPolygonPreview builds
                    // its Leaflet map synchronously, so the map either exists now or never will;
                    // the capture itself stitches tiles independently of the preview DOM, so the
                    // tile layer's own `load` event is the only readiness signal worth waiting on.
                    const previewMap = previewWrapper._leafletPreviewMap;
                    let tileLayer = null;
                    if (previewMap) {
                        previewMap.eachLayer(layer => {
                            if (layer._url && !tileLayer) tileLayer = layer;
                        });
                    } else {
                        console.error(`[${new Date().toISOString()}] [proposal-modal] Preview map was not created; screenshot not captured.`);
                    }
                    if (previewMap && !tileLayer) {
                        captureScreenshot();
                    } else if (tileLayer && typeof tileLayer.isLoading === 'function' && !tileLayer.isLoading()
                        && Object.keys(tileLayer._tiles || {}).length > 0) {
                        captureScreenshot();
                    } else if (tileLayer) {
                        let settled = false;
                        let stallTimer = null;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            tileLayer.off('load', finish);
                            if (stallTimer !== null) clearTimeout(stallTimer);
                            captureScreenshot();
                        };
                        tileLayer.on('load', finish);
                        // Loud failure only: tiles that never finish loading are reported, then
                        // the capture (which fetches its own tiles) is attempted anyway.
                        stallTimer = setTimeout(() => {
                            if (settled) return;
                            console.error(`[${new Date().toISOString()}] [proposal-modal] Preview tiles did not finish loading within ${PROPOSAL_PREVIEW_TILE_TIMEOUT_MS} ms; capturing anyway.`);
                            finish();
                        }, PROPOSAL_PREVIEW_TILE_TIMEOUT_MS);
                    }
                } catch (error) {
                    console.warn('Failed to render proposal screenshot preview', error);
                    screenshotContainer.innerHTML = '';
                    const fallbackDiv = document.createElement('div');
                    fallbackDiv.className = 'map-screenshot-container proposal-screenshot-unavailable';
                    fallbackDiv.textContent = 'Preview unavailable';
                    screenshotContainer.appendChild(fallbackDiv);
                }
            })();
        }
    }

    // Lock secondary selectors that are derived from the selected goal (a disabled choice reads as
    // inert from its own :disabled look).
    // Urban Rule typology is a user choice and must remain selectable because the Geometry → Edit action
    // opens different modals depending on the selected typology (block/row/parcelBased).
    const lockSecondarySelectors = () => {
        const secondaryGroupIds = ['proposalAcquisitionGroup', 'proposalBoundaryGroup'];
        secondaryGroupIds.forEach(groupId => {
            const groupEl = modal.querySelector(`#${groupId}`);
            if (!groupEl) return;
            const buttons = groupEl.querySelectorAll('button, input[type="radio"]');
            buttons.forEach(btn => {
                btn.disabled = true;
                btn.setAttribute('aria-disabled', 'true');
            });
        });
    };

    lockSecondarySelectors();

    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    const initialGoal = overrideGoal || 'as-is';
    // Initialize the three facets (Land use / Parcels / Ownership). Defaults to
    // As is / As is / No change unless a goal was preset (e.g. from a road drawing).
    // This drives the legacy goal-key machinery via syncProposalFacets().
    initProposalFacets(overrideGoal);
    setProposalAcquisitionMode(overrideAcquisition || 'full', { force: true });
    setProposalBoundaryMode(ownershipMode || 'multiple', { lock: true });

    if (goalLocked) {
        // The three facets are now radio groups; lock them all to the preset selection.
        modal.querySelectorAll('#proposalGoalGroup input[type="radio"]').forEach(r => {
            r.disabled = true;
            r.setAttribute('aria-disabled', 'true');
        });
    }

    if (acquisitionLocked) {
        const desired = overrideAcquisition === 'partial-preferred' ? 'partial' : (overrideAcquisition || null);
        modal.querySelectorAll('#proposalAcquisitionGroup input[type="radio"]').forEach(radio => {
            if (desired) radio.checked = (radio.value === desired);
            radio.disabled = true;
            radio.setAttribute('aria-disabled', 'true');
        });
        if (overrideAcquisition === 'partial-preferred') {
            const partialLabel = modal.querySelector('.proposal-acquisition-partial-label');
            if (partialLabel) partialLabel.textContent = proposalAcquisitionLabels.partialPreferred || partialLabel.textContent;
        }
        const acquisitionInput = document.getElementById('proposalAcquisitionMode');
        if (acquisitionInput) {
            acquisitionInput.value = overrideAcquisition || acquisitionInput.value || 'full';
        }
    }

    if (isEditingExisting && !goalLocked) {
        // Editing a proposal already on the map reuses this dialog, but its land use, parcels mode
        // and type are what MAKE it that proposal — changing them would not edit it, it would destroy
        // it into a completely different proposal. So they lock (greyed) to the current preset, which
        // initProposalFacets() already selected above. Ownership and acquisition stay live.
        modal.querySelectorAll('[data-goal-section="land-use"] input[type="radio"], [data-goal-section="parcels"] input[type="radio"]').forEach(radio => {
            radio.disabled = true;
            radio.setAttribute('aria-disabled', 'true');
        });
        modal.querySelectorAll('[data-goal-section="land-use"], [data-goal-section="parcels"]')
            .forEach(section => section.classList.add('proposal-goal-section--locked'));
        modal.querySelectorAll('#proposalMainTypeGroup [data-proposal-main-type]').forEach(button => {
            button.disabled = true;
        });
    }

    // Check contiguity and disable buttons that require contiguous parcels
    applyContiguityConstraints();

    if (overrideGeometryPreset) {
        const geometryStatusText = overrideGeometryPreset.statusText
            || (t ? t('modal.createProposal.geometry.status.drawing', 'Geometry created by drawing') : 'Geometry created by drawing');
        // Ensure geometry is treated as submitted when coming from a preset (e.g. road drawing)
        proposalGeometrySubmitted = overrideGeometryPreset.submitted !== false;
        setGeometryStatus(geometryStatusText, { submitted: proposalGeometrySubmitted });
        const buttonsRow = document.getElementById('proposalGeometryButtons');
        if (buttonsRow) {
            const preferredAction = overrideGeometryPreset.selectedAction || 'upload';
            const disableButtons = overrideGeometryPreset.disableButtons !== false;
            buttonsRow.querySelectorAll('button').forEach(btn => {
                const action = btn.getAttribute('data-geometry-action') || btn.dataset.geometryAction;
                // The action that produced the preset geometry reads as the pressed one.
                btn.setAttribute('aria-pressed', String(action === preferredAction));
                if (disableButtons) {
                    btn.disabled = true;
                    btn.setAttribute('aria-disabled', 'true');
                }
            });
            // Locked for good: buttons a later facet change re-renders here take no clicks either.
            if (disableButtons) buttonsRow.dataset.locked = 'true';
        }
        // Re-run submit state guard after presetting geometry to avoid stale "No geometry" hint
        updateCreateProposalSubmitState();
    }

    if (overrideSummaryStats) {
        const summarySection = document.getElementById('proposalSummarySection');
        const summaryContent = document.getElementById('proposalSummaryContent');
        if (summarySection && summaryContent) {
            summarySection.classList.remove('collapsed');
            summaryContent.style.display = '';
            const chevron = document.getElementById('proposalSummaryChevron');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-up');
            }

            const labelMap = {
                individual: 'Individuals',
                company: 'Companies',
                government: 'Government',
                institution: 'Institutions',
                mixed: 'Mixed'
            };
            const formatNumber = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? CbFormat.formatNumber(num, { maxFractionDigits: 0 }) : value;
            };
            // The road tool's market price is in the city's currency (road-drawing.js, city-money.js).
            const marketCurrency = window.CityMoney.currentCurrency();

            const lines = [];
            if (overrideSummaryStats.ownerEntryCount !== null && overrideSummaryStats.ownerEntryCount !== undefined) {
                lines.push(`<p><strong>Listed owner entries:</strong> ${formatNumber(overrideSummaryStats.ownerEntryCount)}</p>`);
            }
            const counts = overrideSummaryStats.ownershipCounts || {};
            const countEntries = Object.entries(counts).filter(([, value]) => value !== null && value !== undefined);
            if (countEntries.length) {
                const countText = countEntries
                    .map(([key, value]) => `${labelMap[key] || key}: ${formatNumber(value)}`)
                    .join(' • ');
                lines.push(`<p><strong>Parcel category counts:</strong> ${countText}</p>`);
            }
            if (Number.isFinite(overrideSummaryStats.totalMarketPrice) && overrideSummaryStats.currency) {
                lines.push(`<p><strong>Estimated parcel value:</strong> ${CbFormat.formatMoney(Number(overrideSummaryStats.totalMarketPrice), overrideSummaryStats.currency, { maxFractionDigits: 0 })}</p>`);
            }
            if (overrideSummaryStats.totalAcquiringDifficulty !== null && overrideSummaryStats.totalAcquiringDifficulty !== undefined) {
                lines.push(`<p><strong>Modeled acquisition score:</strong> ${formatNumber(overrideSummaryStats.totalAcquiringDifficulty)}</p>`);
            }

            if (lines.length) {
                const statsBlock = document.createElement('div');
                statsBlock.className = 'proposal-summary-extra';
                statsBlock.innerHTML = `
                    <div class="summary-stats">
                        <h4>Ownership & Acquisition Stats</h4>
                        ${lines.join('')}
                    </div>
                `;
                summaryContent.appendChild(statsBlock);
            }
        }
    }

    // Apply user-provided defaults when available
    const authorInput = document.getElementById('proposalAuthor');
    if (authorInput && overridePrefill.author) {
        authorInput.value = overridePrefill.author;
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Pre-fill name and description with default text (facets already set it for a chosen goal;
    // this only fills the empty do-nothing default).
    updateProposalNameAndDescription(DEFAULT_PROPOSAL_TYPE);

    const nameInputEl = document.getElementById('proposalName');
    const descriptionInputEl = document.getElementById('proposalDescription');
    if (nameInputEl && overridePrefill.name) {
        nameInputEl.value = overridePrefill.name;
        nameInputEl.dataset.titleOrigin = overridePrefill.titleOrigin === 'generated' ? 'generated' : 'user';
    }
    if (descriptionInputEl && overridePrefill.description) {
        descriptionInputEl.value = overridePrefill.description;
        descriptionInputEl.dataset.descriptionOrigin = 'user';
    }

    // Update description when name changes
    const nameInputField = document.getElementById('proposalName');
    const descriptionInputField = document.getElementById('proposalDescription');
    if (nameInputField && descriptionInputField) {
        nameInputField.addEventListener('input', () => {
            if (descriptionInputField.dataset.descriptionOrigin !== 'generated') return;
            const proposalType = document.getElementById('proposalType')?.value || DEFAULT_PROPOSAL_TYPE;
            const proposalName = nameInputField.value.trim() || generateDefaultProposalName(proposalType);
            descriptionInputField.value = generateDefaultProposalDescription(proposalType, proposalName);
        });
    }

    // Focus the default Land use radio (not a text input) to avoid triggering mobile keyboards
    const defaultLandUseRadio = modal.querySelector('input[name="proposalLandUse"]:checked')
        || modal.querySelector('input[name="proposalLandUse"]');
    if (defaultLandUseRadio) {
        defaultLandUseRadio.focus();
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
                const goalKey = ProposalDesignGoals.keyOf(p) || 'other';
                const typeLabel = typeof formatProposalTypeLabel === 'function'
                    ? formatProposalTypeLabel(goalKey)
                    : (goalKey || '');
                const createdDate = p.createdAt ? CbFormat.formatDate(p.createdAt) : '';
                // A selectable row (cb-option) that opens the similar proposal.
                return `
                    <button type="button" class="cb-option proposal-similar-item" data-proposal-id="${proposalId}">
                        <span class="cb-option__text">
                            <span class="cb-option__title">${title}</span>
                            <span class="cb-option__desc">${author}${createdDate ? ` • ${createdDate}` : ''}</span>
                            <span class="cb-option__desc">${typeLabel}</span>
                        </span>
                    </button>
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
                            closeSheets: false
                        });
                    }
                });
            });
        } else {
            similarSection.style.display = 'none';
        }
    }
}

// The create dialogs' chrome around CbDialog's: the submit action's id (the scripts that relabel and
// disable it look it up), the lens swatch left of Cancel and the submit action, the line under them
// that says why the submit is disabled (main dialog), and the close control's old hook class for the
// scripts and specs that find it.
function decorateProposalDialogChrome(dialogApi, { submitId, lensTooltip, hintId = null }) {
    const submit = dialogApi.getActionButton('create');
    if (submit) submit.id = submitId;
    const close = dialogApi.header ? dialogApi.header.querySelector('.close-circle-btn') : null;
    if (close) close.classList.add('proposal-modal-close');
    if (!dialogApi.footer) return;
    const lens = document.createElement('button');
    lens.type = 'button';
    lens.className = 'btn btn-icon btn-sm lens-pattern-button';
    lens.setAttribute('data-lens-pattern', '');
    lens.title = lensTooltip;
    lens.setAttribute('aria-label', lensTooltip);
    lens.innerHTML = '<i class="fa-solid fa-glasses" aria-hidden="true"></i>';
    lens.addEventListener('click', () => { if (typeof showLensModal === 'function') showLensModal(); });
    dialogApi.footer.prepend(lens);
    if (hintId) {
        const hint = document.createElement('p');
        hint.id = hintId;
        hint.className = 'proposal-geometry-hint';
        hint.setAttribute('aria-live', 'polite');
        dialogApi.footer.appendChild(hint);
    }
}

// CbDialog's onClose for both create dialogs. A re-open replaces the box ('replaced') and keeps the
// state it was opened for; every other close (×, Cancel, Escape, closeProposalDialog) runs the
// cleanup. CbDialog swallows what onClose throws, so a failure is logged here.
function onProposalDialogClosed(result) {
    if (result === 'replaced') return;
    try {
        finishProposalDialogClose();
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [proposal-dialog] cleanup after closing the dialog failed`, error);
    }
}

function closeProposalDialog() {
    // The open create dialog closes through CbDialog, whose onClose runs the cleanup. With no
    // create dialog open (or only a box another script built) the cleanup still runs.
    const modal = document.querySelector('.create-proposal-modal');
    if (modal && modal.__proposalDialog) {
        modal.__proposalDialog.close(null);
        return;
    }
    if (modal) modal.remove();
    finishProposalDialogClose();
}

// What closing the create dialog undoes: the pending proposal state it was opened for.
function finishProposalDialogClose() {
    const closingDraftId = (typeof window !== 'undefined' && window.pendingProposalDraftId)
        ? String(window.pendingProposalDraftId)
        : null;
    // The site this dialog was opened on belongs to it alone.
    if (typeof window !== 'undefined') window.pendingProposalSiteContext = null;
    // If this dialog seeded multi-select for its parcel context, disarm it — a cancelled
    // Propose must not leave the "Multiparcel selection" panel armed for later clicks.
    try { if (typeof window !== 'undefined') window.releaseEditorSeededMultiSelection?.(); } catch (_) { }
    currentProposalTool = null;
    proposalModalScreenshotDataUrl = null; // Clear stored screenshot
    proposalModalScreenshotPromise = null;
    // Drop the "Copy into new proposal" lineage once the dialog is gone. createProposal() has
    // already stamped it by this point (it closes the dialog only after building the proposal).
    if (typeof window !== 'undefined') {
        window.pendingProposalCopySource = null;
        if (closingDraftId && window.proposalDraftStore?.getDraft?.(closingDraftId)) {
            const draft = window.proposalDraftStore.getDraft(closingDraftId);
            if (draft.state !== 'publishing' && draft.state !== 'error') {
                window.proposalDraftStore.setDraftState(closingDraftId, 'review');
            }
        }
        window.pendingProposalDraftId = null;
        window.pendingProposalReplacementSource = null;
    }

    // If this was a road/track proposal, the multi-parcel selection was seeded just for the modal;
    // disable it now so we don't leave the UI stuck in multi-select mode.
    const wasRoadTrackProposal = !!pendingRoadDrawingProposal || !!(typeof window !== 'undefined' && window.pendingRoadDrawingProposal);
    if (wasRoadTrackProposal && typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.isActive) {
        try {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            multiParcelSelection.isActive = false;
            if (typeof multiParcelSelection.updateUI === 'function') {
                multiParcelSelection.updateUI();
            }
            if (typeof syncMultiSelectControls === 'function') {
                syncMultiSelectControls(false);
            }
        } catch (_) { /* ignore */ }
    }

    proposalDialogOverrides = null;
    pendingRoadDrawingProposal = null;
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = null;
    }
    setProposalModalDimmed(false);
    if (typeof setPendingBuildingProposalContext === 'function') {
        setPendingBuildingProposalContext(null);
    } else if (typeof window !== 'undefined') {
        window.pendingBuildingProposalContext = null;
        window.pendingBuildingFromBlockify = null;
    }
    if (typeof clearSingleBuildingPendingState === 'function') {
        clearSingleBuildingPendingState();
    } else if (typeof window !== 'undefined') {
        window.pendingSingleBuildingFeature = null;
        window.pendingSingleBuildingFeatures = null;
    }
}

// The walk view (three-mode.js) loads published designs by their CID, so every applied design is
// published first: one row per unpublished design, "Publish all" the dialog's primary action. A design
// that cannot be published (ProposalPublishTerms.publishRefusal: invalid or too large) shows why on
// its row and the walk goes on without it. onComplete runs once nothing publishable is left.
function showWalkUploadGateModal(options = {}) {
    try {
        if (typeof proposalStorage === 'undefined' || typeof showSimpleShareModal !== 'function') return null;
        const onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
        const t = getProposalI18nHelper();

        const isPublished = proposal => !!window.DesignSync.publishedCid(proposal);
        const refusalOf = proposal => window.ProposalPublishTerms.publishRefusal(proposal);

        const unpublished = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied).filter(p => !isPublished(p));
        if (!unpublished.some(p => !refusalOf(p))) {
            if (onComplete) { try { onComplete(); } catch (_) { } }
            return null;
        }

        const proposalsByKey = new Map();
        unpublished.forEach(p => {
            const key = (p && p.proposalId) ? String(p.proposalId) : getProposalKey(p);
            if (!key) return;
            proposalsByKey.set(String(key), p);
        });

        // The body: why, the last publish error, and one row per design still to publish.
        const container = document.createElement('div');
        container.className = 'walk-upload-gate';

        const intro = document.createElement('p');
        intro.className = 'walk-upload-gate__intro';
        intro.textContent = t('threeMode.walkGate.intro', 'These applied designs are not published yet. The walk view loads published designs only, so they are published first. The dialog closes and the walk starts as soon as all of them are published.');
        container.appendChild(intro);

        const statusLine = document.createElement('p');
        statusLine.className = 'walk-upload-gate__status';
        statusLine.setAttribute('aria-live', 'polite');
        container.appendChild(statusLine);
        const setStatus = (msg) => { statusLine.textContent = msg || ''; };

        const listWrap = document.createElement('div');
        listWrap.className = 'walk-upload-gate__list';
        container.appendChild(listWrap);

        const modalApi = showSimpleShareModal({
            title: t('threeMode.walkGate.title', 'Publish before walking'),
            body: container,
            actions: [{ id: 'upload-all', label: t('threeMode.walkGate.publishAll', 'Publish all'), primary: true, keepOpen: true, onClick: () => uploadAll() }]
        });
        const uploadAllBtn = modalApi && typeof modalApi.getActionButton === 'function'
            ? modalApi.getActionButton('upload-all')
            : null;

        const rowControls = new Map(); // key -> { row, uploadBtn }
        const rowState = new Map();    // key -> { uploading, uploaded } for the rows that can be published

        const checkAllUploaded = () => {
            const remaining = Array.from(rowState.values()).filter(s => !s.uploaded);
            if (remaining.length === 0) {
                if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                if (onComplete) {
                    try { onComplete(); } catch (e) { console.warn('walk gate onComplete failed', e); }
                }
            }
        };

        const updateRowVisual = (key) => {
            const ctrl = rowControls.get(key);
            const state = rowState.get(key) || {};
            if (!ctrl) return;
            if (state.uploaded) {
                ctrl.row.dataset.uploaded = 'true';
                ctrl.uploadBtn.disabled = true;
                ctrl.uploadBtn.textContent = t('proposals.share.panel.published', 'Published');
                return;
            }
            ctrl.uploadBtn.disabled = !!state.uploading;
            ctrl.uploadBtn.textContent = state.uploading
                ? t('proposals.share.panel.publishing', 'Publishing…')
                : t('proposals.share.panel.publish', 'Publish');
        };

        // Resolves 'published', 'failed', or 'name-needed' when a guest is asked for a profile name
        // first (GuestPolicy 'publish'): "Publish all" then stops instead of asking again per row.
        const uploadOne = async (key) => {
            const proposal = proposalsByKey.get(key);
            const state = rowState.get(key);
            if (!proposal || !state) return 'failed';
            if (state.uploaded) return 'published';
            if (state.uploading) return 'failed';

            rowState.set(key, { uploading: true, uploaded: false });
            updateRowVisual(key);
            try {
                await window.DesignSync.publishDesign(proposal);
                rowState.set(key, { uploading: false, uploaded: true });
                updateRowVisual(key);
                setStatus('');
                return 'published';
            } catch (error) {
                if (!error || !error.cancelled) console.error('walk gate publish failed', error);
                rowState.set(key, { uploading: false, uploaded: false });
                updateRowVisual(key);
                setStatus((error && error.message) || t('proposals.share.errors.failed', 'The design could not be published.'));
                return error && error.cancelled ? 'name-needed' : 'failed';
            }
        };

        const renderRow = (key, proposal) => {
            const row = document.createElement('div');
            row.className = 'walk-upload-gate__row';

            const left = document.createElement('div');
            left.className = 'walk-upload-gate__info';
            const title = document.createElement('div');
            title.className = 'walk-upload-gate__title';
            title.textContent = proposal.name || proposal.title || (proposal.proposalId || key);
            left.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'walk-upload-gate__meta';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            left.appendChild(meta);
            row.appendChild(left);

            // A design that cannot be published: the row says why and has nothing to press.
            const refusal = refusalOf(proposal);
            if (refusal) {
                row.dataset.skipped = 'true';
                const note = document.createElement('div');
                note.className = 'walk-upload-gate__meta';
                note.textContent = refusal.message;
                left.appendChild(note);
                listWrap.appendChild(row);
                return;
            }

            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn btn-sm';
            uploadBtn.textContent = t('proposals.share.panel.publish', 'Publish');
            uploadBtn.addEventListener('click', async () => {
                if (await uploadOne(key) === 'published') checkAllUploaded();
            });

            row.appendChild(uploadBtn);
            listWrap.appendChild(row);

            rowControls.set(key, { row, uploadBtn });
            rowState.set(key, { uploading: false, uploaded: false });
        };

        proposalsByKey.forEach((p, k) => renderRow(k, p));

        const uploadAll = async () => {
            if (uploadAllBtn) uploadAllBtn.disabled = true;
            try {
                const pending = Array.from(rowState.entries())
                    .filter(([, s]) => !s.uploaded && !s.uploading)
                    .map(([k]) => k);
                for (const key of pending) {
                    if (rowState.get(key).uploaded) continue;
                    if (await uploadOne(key) === 'name-needed') break;
                }
            } finally {
                if (uploadAllBtn) uploadAllBtn.disabled = false;
            }
            checkAllUploaded();
        };

        return modalApi;
    } catch (error) {
        console.error('showWalkUploadGateModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(getProposalI18nHelper()('threeMode.walkGate.openFailed', 'The publish dialog could not open.'), 5000, 'error');
        }
        return null;
    }
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
