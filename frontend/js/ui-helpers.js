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

    // Also update floating status (visible when sidebar is closed)
    const floatingStatusText = document.getElementById('floating-status-text');
    if (floatingStatusText) {
        floatingStatusText.textContent = message;
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

// Utility to lock a button while running a potentially long task
function runWithButtonBusyState(button, busyLabel, task, options) {
    if (typeof task !== 'function') {
        throw new Error('runWithButtonBusyState requires a task function');
    }

    if (!button) {
        return task();
    }

    const opts = options || {};
    const originalText = opts.restoreText !== undefined ? opts.restoreText : button.textContent;
    const wasDisabled = button.disabled;
    const busyClass = opts.busyClass;
    const hadBusyClass = busyClass ? button.classList.contains(busyClass) : false;

    if (busyLabel !== undefined && busyLabel !== null) {
        button.textContent = busyLabel;
    }
    button.disabled = true;
    if (busyClass) {
        button.classList.add(busyClass);
    }

    const restore = () => {
        if (!opts.preserveText) {
            button.textContent = originalText;
        }
        button.disabled = wasDisabled;
        if (busyClass && !hadBusyClass) {
            button.classList.remove(busyClass);
        }
        if (opts.restoreFocus) {
            try { button.focus(); } catch (_) { }
        }
    };

    try {
        const result = task();
        if (result && typeof result.then === 'function') {
            return result.finally(restore);
        }
        restore();
        return result;
    } catch (error) {
        restore();
        throw error;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const statusSpan = document.getElementById('status');
    const statusBar = document.querySelector('.status-bar');

    if (!statusSpan) {
        console.error('Status span element (#status) not found for MutationObserver.');
        return;
    }

    // Initialize floating status with current status message
    const floatingStatusText = document.getElementById('floating-status-text');
    if (floatingStatusText && statusSpan.textContent) {
        floatingStatusText.textContent = statusSpan.textContent;
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

try {
    if (typeof window !== 'undefined') {
        window.updateStatus = updateStatus;
        window.toggleStatusExpanded = toggleStatusExpanded;
        window.collapseStatus = collapseStatus;
        window.showEphemeralMessage = showEphemeralMessage;
        window.runWithButtonBusyState = runWithButtonBusyState;
    }
} catch (_) { }