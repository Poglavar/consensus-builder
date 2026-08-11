let statusHighlightTimeout = null;
let copyFeedbackTimeout = null;
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

// What "Copy all" copies, and what the expanded view shows — one definition, so the button can
// never hand over something other than what is on screen.
const STATUS_LOG_VISIBLE_ENTRIES = 50;

function visibleStatusLogEntries() {
    return statusLog.slice(-STATUS_LOG_VISIBLE_ENTRIES);
}

// Every visible line as plain text, timestamp first — the form you paste into a bug report.
function visibleStatusLogText() {
    return visibleStatusLogEntries().map(entry => `${entry.timestamp}\t${entry.message}`).join('\n');
}

async function copyStatusLog() {
    const entries = visibleStatusLogEntries();
    if (!entries.length) return false;
    const copied = await copyTextWithFeedback(visibleStatusLogText());
    if (!copied) return false;
    const template = window.i18n?.t ? window.i18n.t('hud.statusLinesCopied', { count: entries.length }) : '';
    const message = (template && template !== 'hud.statusLinesCopied')
        ? template
        : `${entries.length} line${entries.length === 1 ? '' : 's'} copied`;
    showCopyFeedback(message);
    return true;
}

function updateExpandedStatusView() {
    const expandedView = document.getElementById('status-log-expanded');
    if (!expandedView || !isStatusExpanded) return;

    // Show more entries (up to 50) in chronological order (oldest to newest)
    const entriesToShow = visibleStatusLogEntries();
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

// A spinner in the status bar, for work that outlives its own message.
//
// A status line is superseded within a second on a busy reload, so by the time you look at the bar
// the six seconds of ground-loading has already been replaced by something else and there is nothing
// left to say the app is still working. The spinner is the part that persists: it turns while
// anything holds it and stops when the last holder lets go.
//
// Ref-counted, because several things overlap during a replay and each must be able to say "I am
// busy" without knowing whether anything else is.
let statusActivityHolders = 0;

function statusActivitySpinner() {
    const statusBar = document.querySelector('.status-bar');
    if (!statusBar) return null;
    let spinner = statusBar.querySelector('.status-activity-spinner');
    if (!spinner) {
        spinner = document.createElement('span');
        spinner.className = 'status-activity-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        statusBar.insertBefore(spinner, statusBar.firstChild);
    }
    return spinner;
}

function beginStatusActivity() {
    statusActivityHolders += 1;
    const spinner = statusActivitySpinner();
    if (spinner) spinner.classList.add('is-active');
    return () => endStatusActivity();
}

function endStatusActivity() {
    statusActivityHolders = Math.max(0, statusActivityHolders - 1);
    if (statusActivityHolders > 0) return;
    const spinner = statusActivitySpinner();
    if (spinner) spinner.classList.remove('is-active');
}

// The Copy all button, created on first expand and reused. Built here rather than in index.html so
// the collapsed bar carries nothing it cannot use.
function ensureStatusCopyAllButton(statusBar) {
    if (!statusBar || statusBar.querySelector('[data-status-copy-all]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'status-log-copy-all';
    button.setAttribute('data-status-copy-all', '');
    const label = window.i18n?.t ? window.i18n.t('hud.copyStatusLog') : '';
    button.textContent = (label && label !== 'hud.copyStatusLog') ? label : 'Copy all';
    button.setAttribute('data-i18n-key', 'hud.copyStatusLog');
    button.setAttribute('data-i18n-attr', 'text');
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        copyStatusLog();
    });
    statusBar.appendChild(button);
}

function toggleStatusExpanded() {
    const statusBar = document.querySelector('.status-bar');
    const expandedView = document.getElementById('status-log-expanded');

    if (!statusBar || !expandedView) return;

    isStatusExpanded = !isStatusExpanded;

    if (isStatusExpanded) {
        statusBar.classList.add('expanded');
        expandedView.style.display = 'block';
        ensureStatusCopyAllButton(statusBar);
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
    // An ephemeral message fades out and is gone. That is fine for a confirmation, and wrong for
    // anything the user may need to read twice — "4 proposals removed: …" names records that are no
    // longer on the map, and if you looked away you cannot get the list back. So every ephemeral
    // message also goes through the status bar, which keeps the last 100 entries and can be
    // expanded. The toast stays the thing that catches the eye; the log is what survives.
    try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }

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

function showCopyFeedback(message) {
    let feedback = document.getElementById('copy-feedback-toast');
    if (!feedback) {
        feedback = document.createElement('div');
        feedback.id = 'copy-feedback-toast';
        feedback.className = 'copy-feedback-toast';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        feedback.setAttribute('aria-atomic', 'true');
        document.body.appendChild(feedback);
    }

    feedback.textContent = message;
    feedback.classList.remove('visible');
    requestAnimationFrame(() => feedback.classList.add('visible'));

    if (copyFeedbackTimeout) clearTimeout(copyFeedbackTimeout);
    copyFeedbackTimeout = setTimeout(() => {
        feedback.classList.remove('visible');
        copyFeedbackTimeout = null;
    }, 1100);
}

function fallbackCopyText(value) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } finally {
        textarea.remove();
    }
    return copied;
}

async function copyTextWithFeedback(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (!text) return false;

    try {
        let copied = false;
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (_) {
                // A browser can expose Clipboard API while refusing it outside a secure context.
            }
        }
        if (!copied) copied = fallbackCopyText(text);
        if (!copied) throw new Error('Clipboard write was rejected');

        const key = 'common.copied';
        const translated = window.i18n?.t ? window.i18n.t(key) : '';
        showCopyFeedback(translated && translated !== key ? translated : 'Copied');
        return true;
    } catch (error) {
        console.warn('Copy failed', error);
        return false;
    }
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

    // Expanding is a CLICK on the summary line. Three things it must not be:
    //
    //   * the mouseup that ends a text selection — the log is there to be read and copied out, and
    //     collapsing the moment you release the drag made selecting anything impossible;
    //   * a click inside the expanded log itself — that is where the text is;
    //   * a click on the Copy all button.
    //
    // A drag is told from a click by how far the pointer moved, so a selection that happens to end
    // where it started (a double-click on one word) is caught by the selection check instead.
    if (statusBar) {
        let pressedAt = null;
        statusBar.addEventListener('mousedown', (e) => { pressedAt = { x: e.clientX, y: e.clientY }; });
        statusBar.addEventListener('click', (e) => {
            e.stopPropagation();
            const start = pressedAt;
            pressedAt = null;
            if (e.target.closest('#status-log-expanded')) return;
            if (e.target.closest('[data-status-copy-all]')) return;
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
            try {
                const selection = window.getSelection();
                if (selection && !selection.isCollapsed && String(selection).trim()) return;
            } catch (_) { }
            toggleStatusExpanded();
        });
    }

    // Clicking outside collapses — unless the click is releasing a selection that STARTED in the
    // log and was dragged out of it, which is the ordinary way to select the last line.
    document.addEventListener('click', (e) => {
        if (!isStatusExpanded || statusBar.contains(e.target)) return;
        try {
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && String(selection).trim()
                && statusBar.contains(selection.anchorNode)) return;
        } catch (_) { }
        collapseStatus();
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
        window.beginStatusActivity = beginStatusActivity;
        window.endStatusActivity = endStatusActivity;
        window.toggleStatusExpanded = toggleStatusExpanded;
        window.collapseStatus = collapseStatus;
        window.showEphemeralMessage = showEphemeralMessage;
        window.copyTextWithFeedback = copyTextWithFeedback;
        window.runWithButtonBusyState = runWithButtonBusyState;
    }
} catch (_) { }
