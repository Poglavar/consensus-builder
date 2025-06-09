/**
 * Agent Bubble System - Shows agent avatars at map edges when they interact with objects
 */

class AgentBubbleManager {
    constructor() {
        this.bubbles = new Map(); // Map<bubbleId, bubbleData>
        this.bubbleContainer = null;
        this.map = null;
        this.initialized = false;
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
        this.bubbleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            pointer-events: none;
            z-index: 1000;
        `;

        // Add to map container
        const mapContainer = document.getElementById('map');
        if (mapContainer) {
            mapContainer.appendChild(this.bubbleContainer);
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
    }

    /**
     * Add a bubble for an agent interaction
     * @param {Object} params - Bubble parameters
     * @param {string} params.agentId - Agent ID
     * @param {string} params.agentName - Agent name
     * @param {number} params.avatarIndex - Agent avatar index
     * @param {string} params.objectType - 'parcel' or 'proposal'
     * @param {string} params.objectId - Object ID (parcel ID or proposal hash)
     * @param {L.LatLng} params.objectPosition - Object position on map
     * @param {string} params.action - Action description
     */
    addBubble(params) {
        if (!this.initialized || !this.map) return;

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
        this.bubbleContainer.appendChild(bubbleData.element);

        // Store bubble data
        this.bubbles.set(bubbleId, bubbleData);

        // Position the bubble
        this.updateBubblePosition(bubbleData);

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
        bubble.style.cssText = `
            position: absolute;
            width: 50px;
            height: 50px;
            background: white;
            border: 3px solid #007bff;
            border-radius: 50%;
            cursor: pointer;
            pointer-events: auto;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            transition: transform 0.2s ease, z-index 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1001;
        `;

        // Add avatar image
        const avatar = document.createElement('img');
        avatar.src = getAvatarImagePath(bubbleData.avatarIndex);
        avatar.style.cssText = `
            width: 40px;
            height: 40px;
            border-radius: 50%;
            object-fit: cover;
        `;
        bubble.appendChild(avatar);

        // Add pointed tip (arrow)
        const tip = document.createElement('div');
        tip.className = 'bubble-tip';
        tip.style.cssText = `
            position: absolute;
            width: 0;
            height: 0;
            border: 8px solid transparent;
            border-top-color: #007bff;
            z-index: 1002;
        `;
        bubble.appendChild(tip);

        // Add click handler
        bubble.addEventListener('click', () => {
            this.onBubbleClick(bubbleData);
        });

        // Add hover effects
        bubble.addEventListener('mouseenter', () => {
            bubble.style.transform = 'scale(1.1)';
            bubble.style.zIndex = '1010';
            this.showBubbleTooltip(bubbleData, bubble);
        });

        bubble.addEventListener('mouseleave', () => {
            bubble.style.transform = 'scale(1)';
            bubble.style.zIndex = '1001';
            this.hideBubbleTooltip();
        });

        return bubble;
    }

    /**
     * Update bubble position based on map view and object location
     * @param {Object} bubbleData - Bubble data
     */
    updateBubblePosition(bubbleData) {
        if (!this.map || !bubbleData.element) return;

        const mapContainer = this.map.getContainer();
        const mapBounds = mapContainer.getBoundingClientRect();
        const mapCenter = this.map.getCenter();
        const objectPosition = bubbleData.objectPosition;

        // Check if sidebar is collapsed
        const sidebar = document.getElementById('sidebar');
        const sidebarWidth = sidebar && !sidebar.classList.contains('collapsed') ? 320 : 0;

        // Adjust map bounds to exclude sidebar area
        const visibleMapWidth = mapBounds.width - sidebarWidth;
        const visibleMapLeft = sidebarWidth;

        // Convert object position to screen coordinates
        const objectPoint = this.map.latLngToContainerPoint(objectPosition);
        const centerPoint = this.map.latLngToContainerPoint(mapCenter);

        // Calculate direction from center to object
        const dx = objectPoint.x - centerPoint.x;
        const dy = objectPoint.y - centerPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance === 0) {
            // Object is at center, place bubble at top of visible map area
            bubbleData.element.style.left = `${visibleMapLeft + visibleMapWidth / 2 - 25}px`;
            bubbleData.element.style.top = `10px`;
            this.updateBubbleTip(bubbleData.element, Math.PI / 2); // Point down
            return;
        }

        // Normalize direction
        const dirX = dx / distance;
        const dirY = dy / distance;

        // Find intersection with map edges
        const margin = 35; // Distance from edge
        let edgeX, edgeY;

        // Calculate intersection with map boundaries
        const halfHeight = mapBounds.height / 2;

        // Calculate time to reach each edge
        let tLeft = Infinity, tRight = Infinity, tTop = Infinity, tBottom = Infinity;

        if (dirX < 0) {
            // Going left - check intersection with left edge (accounting for sidebar)
            tLeft = (visibleMapLeft + margin - centerPoint.x) / dirX;
        } else if (dirX > 0) {
            // Going right - check intersection with right edge (full screen width)
            tRight = (mapBounds.width - margin - centerPoint.x) / dirX;
        }

        if (dirY < 0) {
            // Going up
            tTop = (margin - centerPoint.y) / dirY;
        } else if (dirY > 0) {
            // Going down
            tBottom = (mapBounds.height - margin - centerPoint.y) / dirY;
        }

        // Find the closest intersection
        const t = Math.min(tLeft, tRight, tTop, tBottom);

        edgeX = centerPoint.x + dirX * t;
        edgeY = centerPoint.y + dirY * t;

        // Ensure bubble stays within bounds (redundant safety check)
        edgeX = Math.max(visibleMapLeft + margin, Math.min(mapBounds.width - margin, edgeX));
        edgeY = Math.max(margin, Math.min(mapBounds.height - margin, edgeY));

        // Position bubble (offset by half bubble size to center it)
        bubbleData.element.style.left = `${edgeX - 25}px`;
        bubbleData.element.style.top = `${edgeY - 25}px`;

        // Calculate angle for tip pointing toward object
        const angle = Math.atan2(dy, dx);
        this.updateBubbleTip(bubbleData.element, angle);
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

        // Position tip on edge of circle pointing outward
        const tipDistance = 22; // Distance from center to tip
        const tipX = Math.cos(angle) * tipDistance;
        const tipY = Math.sin(angle) * tipDistance;

        tip.style.left = `${25 + tipX - 8}px`; // 25 is bubble center, -8 is half tip width
        tip.style.top = `${25 + tipY - 8}px`;
        tip.style.transform = `rotate(${degrees}deg)`;
    }

    /**
 * Handle bubble click - zoom to object
 * @param {Object} bubbleData - Bubble data
 */
    onBubbleClick(bubbleData) {
        if (!this.map) return;

        // Mark this bubble as moving so it won't be repositioned by map events
        bubbleData.isMoving = true;

        // Zoom to object with gentle animation
        this.map.flyTo(bubbleData.objectPosition, Math.max(this.map.getZoom(), 16), {
            duration: 1.5,
            easeLinearity: 0.25
        });

        // Move bubble to object position after zoom completes
        setTimeout(() => {
            this.moveBubbleToObject(bubbleData);
        }, 1500);

        // If this is a proposal, auto-select it after bubble starts moving
        if (bubbleData.objectType === 'proposal') {
            setTimeout(() => {
                this.autoSelectProposal(bubbleData.objectId);
            }, 1600);
        }

        // Remove bubble after it fully arrives at destination and stays briefly
        setTimeout(() => {
            this.removeBubble(bubbleData.id);
        }, 4500); // 1.5s zoom + 0.8s movement + 2.2s at destination
    }

    /**
 * Move bubble from edge to object position
 * @param {Object} bubbleData - Bubble data
 */
    moveBubbleToObject(bubbleData) {
        if (!this.map || !bubbleData.element) return;

        // Get the object position in container coordinates
        const objectPoint = this.map.latLngToContainerPoint(bubbleData.objectPosition);

        // Clear any existing transitions first
        bubbleData.element.style.transition = 'none';

        // Force a reflow to ensure the transition clear takes effect
        bubbleData.element.offsetHeight;

        // Set the transition and move to object position
        bubbleData.element.style.transition = 'left 0.8s ease, top 0.8s ease';
        bubbleData.element.style.left = `${objectPoint.x - 25}px`;
        bubbleData.element.style.top = `${objectPoint.y - 25}px`;

        // Hide tip when at object
        const tip = bubbleData.element.querySelector('.bubble-tip');
        if (tip) {
            tip.style.opacity = '0';
        }
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
        tooltip.style.cssText = `
            position: absolute;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            white-space: nowrap;
            z-index: 1020;
            pointer-events: none;
        `;
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
        this.bubbles.forEach(bubbleData => {
            // Skip repositioning if bubble is currently moving to object
            if (!bubbleData.isMoving) {
                this.updateBubblePosition(bubbleData);
            }
        });
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
     * Remove all bubbles for a specific agent
     * @param {string} agentId - Agent ID
     */
    removeBubblesByAgent(agentId) {
        const toRemove = [];
        this.bubbles.forEach((bubbleData, bubbleId) => {
            if (bubbleData.agentId === agentId) {
                toRemove.push(bubbleId);
            }
        });
        toRemove.forEach(bubbleId => this.removeBubble(bubbleId));
    }

    /**
     * Clear all bubbles
     */
    clearAllBubbles() {
        this.bubbles.forEach((bubbleData, bubbleId) => {
            this.removeBubble(bubbleId);
        });
    }

    /**
     * Auto-select a proposal when arriving via bubble click
     * @param {string} proposalHash - Proposal hash to select
     */
    autoSelectProposal(proposalHash) {
        try {
            // First, ensure the show proposals checkbox is checked
            const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
            if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
                showProposalsCheckbox.checked = true;
                // Trigger the change event to update the proposal layer
                if (typeof updateProposalLayer === 'function') {
                    updateProposalLayer();
                }
            }

            // Wait a moment for the proposals to render, then select the specific proposal
            setTimeout(() => {
                if (typeof selectProposalFromList === 'function') {
                    // Get the first parcel ID from the proposal for the selection
                    if (typeof proposalStorage !== 'undefined') {
                        const proposal = proposalStorage.getProposal(proposalHash);
                        if (proposal && proposal.parcelIds && proposal.parcelIds.length > 0) {
                            selectProposalFromList(proposalHash, proposal.parcelIds[0]);
                        }
                    }
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
     * @param {string} objectType - 'parcel' or 'proposal'
     * @param {string} objectId - Object ID
     * @returns {L.LatLng|null} Object position
     */
    getObjectPosition(objectType, objectId) {
        if (objectType === 'parcel') {
            return this.getParcelPosition(objectId);
        } else if (objectType === 'proposal') {
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
            if (parcel && parcel.getBounds) {
                return parcel.getBounds().getCenter();
            }
        }
        return null;
    }

    /**
     * Get proposal center position (center of all involved parcels)
     * @param {string} proposalHash - Proposal hash
     * @returns {L.LatLng|null} Proposal center position
     */
    getProposalPosition(proposalHash) {
        if (typeof proposalStorage !== 'undefined') {
            const proposal = proposalStorage.getProposal(proposalHash);
            if (proposal && proposal.parcelIds && proposal.parcelIds.length > 0) {
                const positions = [];

                proposal.parcelIds.forEach(parcelId => {
                    const pos = this.getParcelPosition(parcelId);
                    if (pos) positions.push(pos);
                });

                if (positions.length > 0) {
                    // Calculate center of all parcel positions
                    const avgLat = positions.reduce((sum, pos) => sum + pos.lat, 0) / positions.length;
                    const avgLng = positions.reduce((sum, pos) => sum + pos.lng, 0) / positions.length;
                    return L.latLng(avgLat, avgLng);
                }
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