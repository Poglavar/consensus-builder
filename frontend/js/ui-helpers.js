let statusHighlightTimeout = null;
// Array to store status log entries (max 100)
let statusLog = [];
let isStatusExpanded = false;

function updateStatus(message) {
    const statusSpan = document.getElementById('status');
    if (statusSpan) {
        // Add the message to the log
        const timestamp = new Date().toLocaleTimeString();
        statusLog.push({ message, timestamp });

        // Keep only the last 100 entries
        if (statusLog.length > 100) {
            statusLog.shift();
        }

        // Update the display with the latest message
        statusSpan.textContent = message;

        // Update expanded view if it's currently shown
        updateExpandedStatusView();
    }
}

function updateExpandedStatusView() {
    const expandedView = document.getElementById('status-log-expanded');
    if (!expandedView || !isStatusExpanded) return;

    // Show more entries (up to 50) in chronological order (oldest to newest)
    const entriesToShow = statusLog.slice(-50); // Show last 50 entries
    expandedView.innerHTML = '';

    if (entriesToShow.length === 0) {
        expandedView.innerHTML = '<div class="status-log-entry">No status messages yet</div>';
        return;
    }

    // Store current scroll position to maintain it
    const currentScrollTop = expandedView.scrollTop;
    const currentScrollHeight = expandedView.scrollHeight;

    entriesToShow.forEach((entry, index) => {
        const entryDiv = document.createElement('div');
        entryDiv.className = 'status-log-entry';

        // Highlight the most recent entry (last one)
        if (index === entriesToShow.length - 1) {
            entryDiv.classList.add('current-status');
        }

        entryDiv.innerHTML = `
            <span class="status-log-time">${entry.timestamp}</span>
            <span class="status-log-message">${entry.message}</span>
        `;
        expandedView.appendChild(entryDiv);
    });

    // Auto-scroll to bottom when new content is added, unless user was scrolling up
    const isScrolledToBottom = currentScrollTop >= currentScrollHeight - expandedView.clientHeight - 10;
    if (isScrolledToBottom || currentScrollHeight === 0) {
        expandedView.scrollTop = expandedView.scrollHeight;
    }
}

function toggleStatusExpanded() {
    const statusBar = document.querySelector('.status-bar');
    const expandedView = document.getElementById('status-log-expanded');

    if (!statusBar || !expandedView) return;

    isStatusExpanded = !isStatusExpanded;

    if (isStatusExpanded) {
        statusBar.classList.add('expanded');
        expandedView.style.display = 'block';
        updateExpandedStatusView();

        // Scroll to bottom after a brief delay to ensure content is rendered
        setTimeout(() => {
            expandedView.scrollTop = expandedView.scrollHeight;
        }, 10);
    } else {
        statusBar.classList.remove('expanded');
        expandedView.style.display = 'none';
    }
}

function collapseStatus() {
    if (isStatusExpanded) {
        const statusBar = document.querySelector('.status-bar');
        const expandedView = document.getElementById('status-log-expanded');

        if (statusBar && expandedView) {
            isStatusExpanded = false;
            statusBar.classList.remove('expanded');
            expandedView.style.display = 'none';
        }
    }
}

function applyStatusBarHighlight() {
    const statusBarDiv = document.querySelector('.status-bar');
    if (statusBarDiv) {
        // Clear any existing timeout to prevent premature removal of the class
        if (statusHighlightTimeout) {
            clearTimeout(statusHighlightTimeout);
        }

        statusBarDiv.classList.add('status-highlight');

        // Remove the highlight class after 1.5 seconds
        statusHighlightTimeout = setTimeout(() => {
            statusBarDiv.classList.remove('status-highlight');
            statusHighlightTimeout = null; // Reset timeout tracker
        }, 1500);
    }
}

function showEphemeralMessage(message, duration = 5000) {
    let container = document.getElementById('ephemeral-message-container');

    // Create container if it doesn't exist
    if (!container) {
        container = document.createElement('div');
        container.id = 'ephemeral-message-container';

        const mapContainer = document.getElementById('map-container');
        if (mapContainer) {
            mapContainer.appendChild(container);
        } else {
            document.body.appendChild(container);
        }
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'ephemeral-message';
    messageEl.textContent = message;

    // Add to container
    container.appendChild(messageEl);

    // Animate in by adding the 'visible' class after a short delay
    requestAnimationFrame(() => {
        messageEl.classList.add('visible');
    });

    // Set timeout to animate out and remove
    setTimeout(() => {
        messageEl.classList.remove('visible');

        // Remove the element from DOM after the transition ends
        messageEl.addEventListener('transitionend', (e) => {
            // Check to ensure the element is still in the DOM and the event is for opacity
            if (e.propertyName === 'opacity' && messageEl.parentNode) {
                messageEl.remove();
            }
        });
    }, duration);
}

document.addEventListener('DOMContentLoaded', () => {
    const statusSpan = document.getElementById('status');
    const statusBar = document.querySelector('.status-bar');

    if (!statusSpan) {
        console.error('Status span element (#status) not found for MutationObserver.');
        return;
    }

    // Add click handler to status span for expanding
    if (statusBar) {
        statusBar.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStatusExpanded();
        });
    }

    // Add click handler to document for collapsing when clicking outside
    document.addEventListener('click', (e) => {
        if (isStatusExpanded && !statusBar.contains(e.target)) {
            collapseStatus();
        }
    });

    const observer = new MutationObserver((mutationsList, observer) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'characterData' || mutation.type === 'childList') {
                applyStatusBarHighlight();
                break;
            }
        }
    });

    observer.observe(statusSpan, {
        characterData: true,
        childList: true,
        subtree: true
    });
}); 