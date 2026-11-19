/**
 * Agent Bubble System - Shows agent avatars at map edges when they interact with objects.
 * The same bubbles serve the 2D map and both 3D views: each one is placed from its design's screen
 * position (agent-bubble-placement.js), projected through the Leaflet map or the 3D camera.
 */

class AgentBubbleManager {
    constructor() {
        this.bubbles = new Map(); // Map<bubbleId, bubbleData>
        this.bubbleContainer = null;
        this.map = null;
        this.initialized = false;
        this.glideFrame = null;      // the running 3D camera glide, if any
        this.frameHook = () => {
            if (this.bubbles.size) this.updateAllBubblePositions();
            return false; // nothing of its own to animate
        };
    }

    /**
     * Initialize the bubble system
     * @param {L.Map} leafletMap - The Leaflet map instance
     */
    initialize(leafletMap) {
        this.map = leafletMap;
        this.createBubbleContainer();
        this.setupMapEventListeners();
        this.initialized = true;
    }

    /**
     * Create the container for bubbles
     */
    createBubbleContainer() {
        this.bubbleContainer = document.createElement('div');
        this.bubbleContainer.id = 'agent-bubbles-container';

        // Beside the 2D map and the 3D view rather than inside the Leaflet map, which 3D hides.
        const host = document.getElementById('map-container') || document.getElementById('map');
        if (host) {
            host.appendChild(this.bubbleContainer);
        }
    }

    /**
     * Setup event listeners for map view changes
     */
    setupMapEventListeners() {
        if (!this.map) return;

        // Recalculate bubble positions when map view changes
        this.map.on('moveend zoomend resize', () => {
            this.updateAllBubblePositions();
        });

        // Any user click outside an agent bubble dismisses pinned bubbles.
        // This includes clicks on the map tiles and on parcel polygons —
        // both eventually bubble up through the map container, since parcel
        // click handlers don't stopPropagation here. The 3D view's clicks do the same.
        const mapContainer = this.map.getContainer && this.map.getContainer();
        const threeContainer = document.getElementById('three-container');
        [mapContainer, threeContainer].filter(Boolean).forEach(container => {
            container.addEventListener('click', (event) => {
                if (event.target && event.target.closest && event.target.closest('.agent-bubble')) {
                    return; // bubble click is handled by onBubbleClick
                }
                this.dismissPinnedBubbles();
            });
        });
        // A hand on the 3D camera ends a glide towards a bubble, as a drag ends a 2D flyTo.
        if (threeContainer) {
            const stopGlide = () => this.cancelGlide();
            threeContainer.addEventListener('pointerdown', stopGlide, { capture: true, passive: true });
            threeContainer.addEventListener('wheel', stopGlide, { capture: true, passive: true });
        }

        // In 3D the bubbles follow the camera frame by frame; back in 2D the map's own events do.
        window.addEventListener('mapmodechange', () => this.watchThreeCamera());
        this.watchThreeCamera();
    }

    watchThreeCamera() {
        if (typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()
            && typeof window.registerThreeModeFrameHook === 'function') {
            window.registerThreeModeFrameHook(this.frameHook);
        }
        this.updateAllBubblePositions();
    }

    // The scene's internals while a 3D view is up, else null (the 2D map is in charge).
    threeInternals() {
        if (typeof window.isThreeModeActive !== 'function' || !window.isThreeModeActive()) return null;
        return typeof window.getThreeModeInternals === 'function' ? window.getThreeModeInternals() : null;
    }

    // The rim ring's inset, raised above the simulation bar while it is shown (on a phone it is two
    // rows tall and reaches above the default ring).
    ringInset() {
        const inset = window.AgentBubblePlacement.DEFAULT_INSET;
        const bar = document.getElementById('simulation-bar');
        if (!bar || bar.hidden || !this.bubbleContainer) return inset;
        const barTop = bar.getBoundingClientRect().top - this.bubbleContainer.getBoundingClientRect().top;
        const clearance = this.bubbleContainer.clientHeight - barTop + window.AgentBubblePlacement.BUBBLE_RADIUS + 12;
        return clearance > inset.bottom ? { ...inset, bottom: clearance } : inset;
    }

    // A design's position on screen, in the bubble container's pixels, through whichever view is up.
    projectPosition(latLng) {
        const three = this.threeInternals();
        const width = this.bubbleContainer ? this.bubbleContainer.clientWidth : 0;
        const height = this.bubbleContainer ? this.bubbleContainer.clientHeight : 0;
        if (three) {
            const xy = three.latLngToXY(latLng.lat, latLng.lng);
            if (!xy || typeof THREE === 'undefined') return null;
            const camera = three.camera;
            camera.updateMatrixWorld();
            const world = new THREE.Vector3(xy[0], xy[1], 0);
            const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
            const ndc = world.clone().project(camera);
            return window.AgentBubblePlacement.fromCameraSpace({ view, ndc, near: camera.near, width, height });
        }
        if (!this.map) return null;
        const point = this.map.latLngToContainerPoint(latLng);
        return { behind: false, x: point.x, y: point.y };
    }

    /**
     * Add a bubble for an agent interaction
     * @param {Object} params - Bubble parameters
     * @param {string} params.agentId - Agent ID
     * @param {string} params.agentName - Agent name
     * @param {number} params.avatarIndex - Agent avatar index
     * @param {string} params.objectType - 'proposal'
    * @param {string} params.objectId - Object ID (proposal id)
     * @param {L.LatLng} params.objectPosition - Object position on map
     * @param {string} params.action - Action description
     */
    addBubble(params) {
        if (!this.initialized || !this.map) return;

        // Safety check: validate position before creating bubble
        if (!params.objectPosition ||
            isNaN(params.objectPosition.lat) ||
            isNaN(params.objectPosition.lng) ||
            Math.abs(params.objectPosition.lat) > 90 ||
            Math.abs(params.objectPosition.lng) > 180) {

            console.warn('Skipping bubble creation due to invalid position:', {
                agentName: params.agentName,
                action: params.action,
                objectId: params.objectId,
                objectPosition: params.objectPosition
            });
            return;
        }

        const bubbleId = `${params.agentId}_${params.objectId}_${Date.now()}`;

        // Remove existing bubble for this agent if it exists
        this.removeBubblesByAgent(params.agentId);

        const bubbleData = {
            id: bubbleId,
            agentId: params.agentId,
            agentName: params.agentName,
            avatarIndex: params.avatarIndex,
            objectType: params.objectType,
            objectId: params.objectId,
            objectPosition: params.objectPosition,
            action: params.action,
            element: null,
            createdAt: Date.now()
        };

        // Create bubble element
        bubbleData.element = this.createBubbleElement(bubbleData);

        // Store bubble data
        this.bubbles.set(bubbleId, bubbleData);

        // Avatars load when a bubble first needs one (not at boot: bubbles are rare). The bubble
        // joins the map once its image is decoded, so it never paints as a blank disc; a failed
        // image still shows the bubble. A bubble removed meanwhile stays out.
        const show = () => {
            if (this.bubbles.get(bubbleId) !== bubbleData) return;
            this.bubbleContainer.appendChild(bubbleData.element);
            this.updateBubblePosition(bubbleData);
        };
        const avatar = bubbleData.element.querySelector('img');
        if (avatar && typeof avatar.decode === 'function') avatar.decode().then(show, show);
        else show();

        // Note: Bubbles will only be removed on click or when game state updates
    }

    /**
     * Create the visual bubble element
     * @param {Object} bubbleData - Bubble data
     * @returns {HTMLElement} Bubble element
     */
    createBubbleElement(bubbleData) {
        const bubble = document.createElement('div');
        bubble.className = 'agent-bubble';

        // Add avatar image
        const avatar = document.createElement('img');
        avatar.src = getAvatarImagePath(bubbleData.avatarIndex);
        bubble.appendChild(avatar);

        // Add pointed tip (arrow)
        const tip = document.createElement('div');
        tip.className = 'bubble-tip';
        bubble.appendChild(tip);

        // Add click handler
        bubble.addEventListener('click', () => {
            this.onBubbleClick(bubbleData);
        });

        // Add hover effects
        bubble.addEventListener('mouseenter', () => {
            bubble.classList.add('is-hovered');
            this.showBubbleTooltip(bubbleData, bubble);
        });

        bubble.addEventListener('mouseleave', () => {
            bubble.classList.remove('is-hovered');
            this.hideBubbleTooltip();
        });

        return bubble;
    }

    /**
     * Place a bubble from its design's screen position: on the rim ring pointing at the design, or
     * over the design once the camera has gone there (bubbleData.atObject).
     * @param {Object} bubbleData - Bubble data
     */
    updateBubblePosition(bubbleData) {
        if (!bubbleData.element || !this.bubbleContainer) return;

        const objectPosition = bubbleData.objectPosition;
        // Near 0,0 means a missing position, not a design in the Gulf of Guinea.
        if (!objectPosition || isNaN(objectPosition.lat) || isNaN(objectPosition.lng)
            || (Math.abs(objectPosition.lat) < 0.01 && Math.abs(objectPosition.lng) < 0.01)) {
            console.warn(`updateBubblePosition: Invalid object position for ${bubbleData.objectType} ${bubbleData.objectId}:`, objectPosition);
            bubbleData.element.hidden = true;
            return;
        }

        let placement = null;
        try {
            placement = window.AgentBubblePlacement.placeBubble({
                projected: this.projectPosition(objectPosition),
                width: this.bubbleContainer.clientWidth,
                height: this.bubbleContainer.clientHeight,
                atObject: !!bubbleData.atObject,
                inset: this.ringInset()
            });
        } catch (e) {
            console.error(`updateBubblePosition: Error projecting ${bubbleData.objectType} ${bubbleData.objectId}:`, e);
        }
        // No placement yet (the 3D scene is still being set up, or the map has no size): hide until
        // the next update can place it.
        bubbleData.element.hidden = !placement;
        if (!placement) return;

        bubbleData.element.style.left = `${placement.left}px`;
        bubbleData.element.style.top = `${placement.top}px`;
        bubbleData.element.classList.toggle('is-at-object', !placement.docked);
        if (placement.docked) this.updateBubbleTip(bubbleData.element, placement.angle);
    }

    /**
     * Update bubble tip direction
     * @param {HTMLElement} bubbleElement - Bubble element
     * @param {number} angle - Angle in radians pointing toward object
     */
    updateBubbleTip(bubbleElement, angle) {
        const tip = bubbleElement.querySelector('.bubble-tip');
        if (!tip) return;

        // Convert angle to rotation and position
        const degrees = (angle * 180 / Math.PI) + 90; // Adjust for tip orientation

        // Position tip outside of circle border pointing outward
        const tipDistance = 34; // Distance from center to tip (25px radius + 3px border + 2px gap)
        const tipX = Math.cos(angle) * tipDistance;
        const tipY = Math.sin(angle) * tipDistance;

        tip.style.left = `${25 + tipX - 8}px`; // 25 is bubble center, -8 is half tip width
        tip.style.top = `${25 + tipY - 8}px`;
        tip.style.transform = `rotate(${degrees}deg)`;
    }

    /**
     * Handle bubble click - go to the design and select it
     * @param {Object} bubbleData - Bubble data
     */
    onBubbleClick(bubbleData) {
        // Fold away an open sheet so the map is clear for the fly-to
        if (window.MapShell) window.MapShell.closeSheets();
        this.focusBubble(bubbleData);
    }

    /**
     * Move the camera of the view in use to a bubble's design, then land the bubble on the design
     * and select it. The bubble is pinned meanwhile, so newer actions do not remove it under the user.
     * @param {Object} bubbleData - Bubble data
     * @returns {boolean} whether the camera set off
     */
    focusBubble(bubbleData) {
        // Safety check: validate coordinates before flying to prevent world map disaster
        if (!bubbleData.objectPosition ||
            isNaN(bubbleData.objectPosition.lat) ||
            isNaN(bubbleData.objectPosition.lng) ||
            Math.abs(bubbleData.objectPosition.lat) > 90 ||
            Math.abs(bubbleData.objectPosition.lng) > 180) {

            // Show user-friendly error and don't fly
            this.handleInvalidBubblePosition(bubbleData);
            return false;
        }

        // Pin the bubble: subsequent turns / new same-agent actions must not
        // yank it out from under the user mid-flight.
        bubbleData.pinned = true;
        // Switching focus: clear any other pinned bubble before pinning this one.
        this.dismissPinnedBubbles(bubbleData.id);

        let arrived = false;
        const onArrive = () => {
            if (arrived) return;
            arrived = true;
            if (!this.bubbles.has(bubbleData.id)) return; // bubble was already removed
            this.landBubble(bubbleData);
            if (bubbleData.objectType === 'proposal') {
                this.autoSelectProposal(bubbleData.objectId);
            }
        };

        if (this.threeInternals()) return this.glide3D(bubbleData.objectPosition, onArrive);
        if (!this.map) return false;

        // Zoom in far enough that parcel borders are actually visible — the
        // bubble is meaningless if it lands you on the city outline. Each city
        // config declares the zoom at which parcels start rendering; never
        // settle below that floor.
        const parcelZoomRange = (typeof window !== 'undefined' && window.CityConfigManager
                && typeof window.CityConfigManager.getParcelZoomRange === 'function')
            ? window.CityConfigManager.getParcelZoomRange()
            : null;
        const parcelMinZoom = (parcelZoomRange && Number.isFinite(parcelZoomRange.min))
            ? parcelZoomRange.min
            : 15;
        const targetZoom = Math.max(this.map.getZoom(), parcelMinZoom);

        const FLY_DURATION_S = 1.5;

        this.map.flyTo(bubbleData.objectPosition, targetZoom, {
            duration: FLY_DURATION_S,
            easeLinearity: 0.25
        });

        // Hang the follow-up sequence off the actual `moveend` so a user
        // interrupting the flight (pan/zoom) collapses the timeline instead
        // of letting hardcoded setTimeouts fire against a stale map view.
        // Fallback timer guards against environments where moveend doesn't
        // arrive (e.g., map removed mid-flight). The bubble itself is *not*
        // auto-removed — it persists as a focus indicator until the user
        // takes another action (see dismissPinnedBubbles).
        this.map.once('moveend', onArrive);
        // Safety net: if moveend never fires, still progress after the flight
        // duration with a small buffer.
        setTimeout(onArrive, FLY_DURATION_S * 1000 + 300);
        return true;
    }

    /**
     * Glide the 3D camera's target to a position, keeping its heading, tilt and distance.
     * @param {L.LatLng} latLng - Where to go
     * @param {Function} onArrive - Called once the camera is there
     * @returns {boolean} whether the camera set off
     */
    glide3D(latLng, onArrive) {
        const from = typeof window.getThree3DGeoView === 'function' ? window.getThree3DGeoView() : null;
        if (!from || typeof window.applyThree3DGeoView !== 'function') return false;
        this.cancelGlide();
        const place = share => {
            window.applyThree3DGeoView({
                ...from,
                targetLat: from.targetLat + (latLng.lat - from.targetLat) * share,
                targetLng: from.targetLng + (latLng.lng - from.targetLng) * share
            });
            window.invalidateThreeView?.();
        };
        if (window.__reducedMotion) {
            place(1);
            onArrive();
            return true;
        }
        const start = performance.now();
        const duration = 1500;
        const step = now => {
            const t = Math.min(1, (now - start) / duration);
            place(t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t); // easeInOutQuad
            if (t < 1) {
                this.glideFrame = requestAnimationFrame(step);
            } else {
                this.glideFrame = null;
                onArrive();
            }
        };
        this.glideFrame = requestAnimationFrame(step);
        return true;
    }

    cancelGlide() {
        if (this.glideFrame) cancelAnimationFrame(this.glideFrame);
        this.glideFrame = null;
    }

    /**
     * Remove every pinned bubble, optionally except the one currently being
     * (re)pinned. Called when the user signals "move on" — by clicking on the
     * map, on a parcel, or on another agent's bubble.
     */
    dismissPinnedBubbles(exceptId = null) {
        const toRemove = [];
        this.bubbles.forEach((bubbleData, bubbleId) => {
            if (bubbleData.pinned && bubbleId !== exceptId) {
                toRemove.push(bubbleId);
            }
        });
        toRemove.forEach(id => this.removeBubble(id));
    }

    /**
     * Handle invalid bubble position gracefully
     * @param {Object} bubbleData - Bubble data with invalid position
     */
    handleInvalidBubblePosition(bubbleData) {
        console.warn('Invalid bubble position detected:', bubbleData);

        // Show user-friendly notification
        this.showBubbleErrorNotification(bubbleData);

        // Try to recover the position
        this.attemptPositionRecovery(bubbleData);

        // Remove the bubble since we can't navigate to it
        setTimeout(() => {
            this.removeBubble(bubbleData.id);
        }, 3000);
    }

    /**
     * Show user-friendly error notification
     * @param {Object} bubbleData - Bubble data
     */
    showBubbleErrorNotification(bubbleData) {
        // An error notice like every other (design-language.md, Messages): the parcel data behind the bubble's
        // location is not loaded yet, which happens right after a reload.
        const key = 'ephemeral.messages.agent_location_unavailable';
        const params = { agent: bubbleData.agentName, action: bubbleData.action };
        const translated = typeof window.i18n?.t === 'function' ? window.i18n.t(key, params) : null;
        const text = translated && translated !== key ? translated
            : `Cannot go to ${bubbleData.agentName}'s ${bubbleData.action}: the parcel data is not loaded yet.`;
        if (typeof window.showEphemeralMessage === 'function') window.showEphemeralMessage(text, 5000, 'error');
        else console.warn(`[${new Date().toISOString()}] [agent-bubbles] ${text}`);
    }

    /**
     * Attempt to recover position for a proposal
     * @param {Object} bubbleData - Bubble data
     */
    attemptPositionRecovery(bubbleData) {
        if (bubbleData.objectType === 'proposal' && bubbleData.objectId) {
            // Try to get fresh position
            const recoveredPosition = this.getProposalPosition(bubbleData.objectId);
            if (recoveredPosition) {
                console.log('Successfully recovered position for proposal:', bubbleData.objectId);
                // Update the bubble data and try again
                bubbleData.objectPosition = recoveredPosition;
                // Retry the click after a short delay
                setTimeout(() => {
                    this.onBubbleClick(bubbleData);
                }, 1000);
                return true;
            }
        }
        return false;
    }

    /**
     * Land a bubble on its design: it slides from the rim onto the design and stays there while
     * the design is on screen, through later camera moves (a slide in CSS, .is-landing).
     * @param {Object} bubbleData - Bubble data
     */
    landBubble(bubbleData) {
        if (!bubbleData.element) return;
        const element = bubbleData.element;
        element.classList.add('is-landing');
        element.addEventListener('transitionend', () => element.classList.remove('is-landing'), { once: true });
        bubbleData.atObject = true;
        this.updateBubblePosition(bubbleData);
    }

    /**
     * Show tooltip with bubble information
     * @param {Object} bubbleData - Bubble data
     * @param {HTMLElement} bubbleElement - Bubble element
     */
    showBubbleTooltip(bubbleData, bubbleElement) {
        this.hideBubbleTooltip(); // Remove any existing tooltip

        const tooltip = document.createElement('div');
        tooltip.className = 'agent-bubble-tooltip';
        tooltip.textContent = `${bubbleData.agentName}: ${bubbleData.action}`;

        // Add to container temporarily to measure dimensions
        this.bubbleContainer.appendChild(tooltip);
        const tooltipRect = tooltip.getBoundingClientRect();
        const tooltipWidth = tooltipRect.width;
        const tooltipHeight = tooltipRect.height;

        // Get bubble and container positions
        const bubbleRect = bubbleElement.getBoundingClientRect();
        const containerRect = this.bubbleContainer.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Calculate bubble position relative to container
        const bubbleX = bubbleRect.left - containerRect.left;
        const bubbleY = bubbleRect.top - containerRect.top;
        const bubbleCenterX = bubbleX + 25; // 25 is half bubble width
        const bubbleCenterY = bubbleY + 25; // 25 is half bubble height

        // Determine best position based on available space
        const margin = 10; // Space between bubble and tooltip
        let tooltipX, tooltipY;

        // Check distances to edges (using absolute screen coordinates)
        const distanceToTop = bubbleRect.top;
        const distanceToBottom = viewportHeight - bubbleRect.bottom;
        const distanceToLeft = bubbleRect.left;
        const distanceToRight = viewportWidth - bubbleRect.right;

        // Choose position based on which edge has most space
        if (distanceToTop >= tooltipHeight + margin && distanceToTop >= distanceToBottom) {
            // Position above bubble
            tooltipX = bubbleCenterX - tooltipWidth / 2;
            tooltipY = bubbleY - tooltipHeight - margin;
        } else if (distanceToBottom >= tooltipHeight + margin) {
            // Position below bubble
            tooltipX = bubbleCenterX - tooltipWidth / 2;
            tooltipY = bubbleY + 50 + margin; // 50 is bubble height
        } else if (distanceToRight >= tooltipWidth + margin && distanceToRight >= distanceToLeft) {
            // Position to the right of bubble
            tooltipX = bubbleX + 50 + margin; // 50 is bubble width
            tooltipY = bubbleCenterY - tooltipHeight / 2;
        } else {
            // Position to the left of bubble
            tooltipX = bubbleX - tooltipWidth - margin;
            tooltipY = bubbleCenterY - tooltipHeight / 2;
        }

        // Ensure tooltip stays within container bounds
        tooltipX = Math.max(5, Math.min(containerRect.width - tooltipWidth - 5, tooltipX));
        tooltipY = Math.max(5, Math.min(containerRect.height - tooltipHeight - 5, tooltipY));

        // Apply final position
        tooltip.style.left = `${tooltipX}px`;
        tooltip.style.top = `${tooltipY}px`;
    }

    /**
     * Hide bubble tooltip
     */
    hideBubbleTooltip() {
        const tooltip = this.bubbleContainer.querySelector('.agent-bubble-tooltip');
        if (tooltip) {
            tooltip.remove();
        }
    }

    /**
     * Update positions of all bubbles
     */
    updateAllBubblePositions() {
        this.bubbles.forEach(bubbleData => this.updateBubblePosition(bubbleData));
    }

    /**
     * Remove a specific bubble
     * @param {string} bubbleId - Bubble ID
     */
    removeBubble(bubbleId) {
        const bubbleData = this.bubbles.get(bubbleId);
        if (bubbleData && bubbleData.element) {
            bubbleData.element.remove();
            this.bubbles.delete(bubbleId);
        }
    }

    /**
     * Remove all bubbles for a specific agent. A pinned bubble (one the user
     * is actively flying to / focusing on) is *not* removed — it just gets
     * dimmed to grayscale so the user can see that a newer same-agent action
     * has come in without losing the one they clicked.
     * @param {string} agentId - Agent ID
     */
    removeBubblesByAgent(agentId) {
        const toRemove = [];
        this.bubbles.forEach((bubbleData, bubbleId) => {
            if (bubbleData.agentId !== agentId) return;
            if (bubbleData.pinned) {
                this._markBubbleStale(bubbleData);
                return;
            }
            toRemove.push(bubbleId);
        });
        toRemove.forEach(bubbleId => this.removeBubble(bubbleId));
    }

    /**
     * Clear all bubbles. Pinned bubbles survive — same rationale as
     * removeBubblesByAgent — and get grayscaled so the user knows a new
     * turn arrived but their focused bubble is still on its way.
     */
    clearAllBubbles() {
        const toRemove = [];
        this.bubbles.forEach((bubbleData, bubbleId) => {
            if (bubbleData.pinned) {
                this._markBubbleStale(bubbleData);
                return;
            }
            toRemove.push(bubbleId);
        });
        toRemove.forEach(bubbleId => this.removeBubble(bubbleId));
    }

    _markBubbleStale(bubbleData) {
        if (!bubbleData || !bubbleData.element || bubbleData.staleApplied) return;
        bubbleData.staleApplied = true;
        bubbleData.element.classList.add('is-stale');
    }

    /**
     * Auto-select and highlight a proposal when arriving via bubble click
     * without opening proposal details automatically.
     * @param {string} proposalId - Proposal id to select
     */
    autoSelectProposal(proposalId) {
        try {
            // Wait a moment for the proposals to render, then select the specific proposal
            setTimeout(() => {
                if (typeof proposalStorage === 'undefined') {
                    console.debug('[AgentBubble] proposalStorage unavailable; skipping auto-select', { proposalId });
                    return;
                }

                const proposal = proposalStorage.getProposal(proposalId);
                const parcels = Array.isArray(proposal?.cadastreParcelIds)
                    ? proposal.cadastreParcelIds
                    : [];

                if (!proposal || parcels.length === 0) {
                    console.debug('[AgentBubble] proposal/parcels unavailable for auto-select', {
                        proposalId,
                        hasProposal: !!proposal,
                        parcelCount: parcels.length
                    });
                    return;
                }

                if (typeof selectAndHighlightProposal === 'function') {
                    const proposalKey = (typeof getProposalKey === 'function')
                        ? (getProposalKey(proposal) || proposalId)
                        : proposalId;
                    console.debug('[AgentBubble] selecting proposal without opening details', {
                        proposalId: proposalKey,
                        parcelId: parcels[0]
                    });
                    selectAndHighlightProposal(proposalKey, parcels[0], false, false, true);
                    return;
                }

                if (typeof selectProposalFromList === 'function') {
                    console.debug('[AgentBubble] fallback selectProposalFromList used (may open details)', {
                        proposalId,
                        parcelId: parcels[0]
                    });
                    selectProposalFromList(proposalId, parcels[0]);
                }
            }, 200);
        } catch (error) {
            console.warn('Could not auto-select proposal:', error);
        }
    }

    /**
     * Clear bubbles when game state updates (called by game loop)
     */
    onGameStateUpdate() {
        this.clearAllBubbles();
    }

    /**
     * Get object position based on type and ID
     * @param {string} objectType - 'proposal'
    * @param {string} objectId - Object ID (proposal id)
     * @returns {L.LatLng|null} Object position
     */
    getObjectPosition(objectType, objectId) {
        if (objectType === 'proposal') {
            return this.getProposalPosition(objectId);
        }
        return null;
    }

    /**
     * Get parcel center position
     * @param {string} parcelId - Parcel ID
     * @returns {L.LatLng|null} Parcel center position
     */
    getParcelPosition(parcelId) {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
            const parcel = multiParcelSelection.findParcelById(parcelId);
            if (parcel && typeof parcel.getBounds === 'function') {
                try {
                    const bounds = parcel.getBounds();
                    if (bounds && typeof bounds.getCenter === 'function') {
                        const center = bounds.getCenter();
                        if (center && !isNaN(center.lat) && !isNaN(center.lng)) {
                            return center;
                        }
                        // Bad geometry on a parcel that *is* on the map is worth flagging.
                        console.warn(`getParcelPosition: Invalid center coordinates for parcel ${parcelId}:`, center);
                    } else {
                        console.warn(`getParcelPosition: Invalid bounds for parcel ${parcelId}:`, bounds);
                    }
                } catch (e) {
                    console.error(`getParcelPosition: Error getting bounds for parcel ${parcelId}:`, e);
                }
            } else {
                // Routine: the parcel just isn't on the map right now (pan, zoom,
                // or it's a child of a proposal whose parents have been re-shown).
                // Caller handles a null return by skipping the bubble.
                console.debug(`getParcelPosition: Parcel ${parcelId} not currently on the map`);
            }
        }
        return null;
    }

    /**
     * Get proposal center position (center of all involved parcels)
     * @param {string} proposalId - Proposal id
     * @returns {L.LatLng|null} Proposal center position
     */
    getProposalPosition(proposalId) {
        if (typeof proposalStorage !== 'undefined') {
            const proposal = proposalStorage.getProposal(proposalId);
            const parcels = Array.isArray(proposal?.cadastreParcelIds)
                ? proposal.cadastreParcelIds
                : [];
            if (proposal && parcels.length > 0) {

                // Strategy 1: Try stored bounds first (most reliable)
                if (proposal.bounds && proposal.bounds.center) {
                    const center = proposal.bounds.center;
                    if (center.lat && center.lng &&
                        !isNaN(center.lat) && !isNaN(center.lng) &&
                        Math.abs(center.lat) <= 90 && Math.abs(center.lng) <= 180) {
                        return L.latLng(center.lat, center.lng);
                    }
                }

                // Strategy 2: Calculate from stored bounds if available
                if (proposal.bounds && proposal.bounds.north && proposal.bounds.south &&
                    proposal.bounds.east && proposal.bounds.west) {
                    try {
                        const centerLat = (proposal.bounds.north + proposal.bounds.south) / 2;
                        const centerLng = (proposal.bounds.east + proposal.bounds.west) / 2;
                        if (!isNaN(centerLat) && !isNaN(centerLng) &&
                            Math.abs(centerLat) <= 90 && Math.abs(centerLng) <= 180) {
                            return L.latLng(centerLat, centerLng);
                        }
                    } catch (e) {
                        console.warn('Error calculating center from stored bounds:', e);
                    }
                }

                // Strategy 3: Calculate from current parcel positions (dynamic fallback)
                const positions = [];
                let missingParcels = [];

                parcels.forEach(parcelId => {
                    const pos = this.getParcelPosition(parcelId);
                    if (pos) {
                        positions.push(pos);
                    } else {
                        missingParcels.push(parcelId);
                    }
                });

                if (positions.length > 0) {
                    // We have at least some parcels, calculate center
                    const avgLat = positions.reduce((sum, pos) => sum + pos.lat, 0) / positions.length;
                    const avgLng = positions.reduce((sum, pos) => sum + pos.lng, 0) / positions.length;

                    if (missingParcels.length > 0) {
                        console.debug(`Proposal ${proposalId.substring(0, 8)}: Using ${positions.length}/${parcels.length} parcels for position. Missing: ${missingParcels.join(', ')}`);
                    }

                    return L.latLng(avgLat, avgLng);
                }

                // Strategy 4: no parcels visible. This is a routine condition
                // (off-screen pan, child parcels of an unapplied parent, etc.)
                // and the caller already skips the bubble when we return null,
                // so keep this at debug level instead of error.
                console.debug(`Proposal ${proposalId.substring(0, 8)}: Cannot determine position - all ${parcels.length} parcels currently off-map`);
            }
        }
        return null;
    }
}

// Create global instance
window.agentBubbleManager = new AgentBubbleManager();

// Initialize when DOM is ready and map is available
document.addEventListener('DOMContentLoaded', () => {
    // Wait for map to be available
    const checkMapInterval = setInterval(() => {
        if (typeof map !== 'undefined' && map) {
            window.agentBubbleManager.initialize(map);
            clearInterval(checkMapInterval);
        }
    }, 100);
});
