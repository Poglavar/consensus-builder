let statusHighlightTimeout = null;
let statusLog = [];
let isStatusExpanded = false;

// The report form is a satellite page; this link stays available alongside the app's contacts.
document.addEventListener('DOMContentLoaded', () => {
    const contact = document.querySelector('[data-i18n-key="sidebar.info.contactTitle"]')?.parentElement;
    if (!contact || contact.querySelector('[data-feedback-link]')) return;
    import('./feedback-translations.js').then(() => {
        const link = document.createElement('a');
        link.className = 'btn btn-quiet'; link.dataset.feedbackLink = '';
        link.dataset.i18nKey = 'feedback.open'; link.href = '/feedback.html';
        link.addEventListener('click', () => {
            const target = new URL('/feedback.html', window.location.origin);
            target.searchParams.set('page', window.location.origin + window.location.pathname);
            target.searchParams.set('lang', window.i18n.getLocale());
            link.href = target.href;
        });
        contact.appendChild(link); window.i18n.applyTranslations(contact);
    }).catch(error => console.error('Feedback link could not load', error));
});

// How much of the session the log remembers.
//
// It was 100, which a batch outruns in seconds: applying a hundred block rules writes several
// hundred lines, so by the time the run finished the beginning of it — including anything that went
// wrong early — had already been dropped. The entries are two short strings each, so a few thousand
// costs a few hundred kilobytes and buys the whole run.
const STATUS_LOG_MAX_ENTRIES = 2000;

// The strip under the status bar is a PREVIEW, and this is how much of one. It is rebuilt on every
// message, so it stays small on purpose; the pop-out dialog is where the whole log lives.
const STATUS_LOG_PREVIEW_ENTRIES = 50;

function updateStatus(message, options = {}) {
    const statusSpan = document.getElementById('status');
    if (statusSpan) {
        // Live counters update the status without filling the session log with every tick.
        if (!options.transient) {
            // Add the message to the log
            const timestamp = CbFormat.formatTime(new Date());
            // A line about a proposal remembers WHICH one, so the log can offer to go there. Kept as a
            // field rather than recovered from the sentence: titles are not unique, are translated, and
            // are written by users.
            const proposalId = options && options.proposalId ? String(options.proposalId) : null;
            statusLog.push({ message, timestamp, proposalId });

            if (statusLog.length > STATUS_LOG_MAX_ENTRIES) {
                statusLog.splice(0, statusLog.length - STATUS_LOG_MAX_ENTRIES);
            }

            // Update expanded view if it's currently shown
            updateExpandedStatusView();
            appendToStatusLogDialog();
        }
        // Update the display with the latest message
        statusSpan.textContent = message;
    }

    // Also update floating status (visible when sidebar is closed). A notice logs here but does
    // not take over the status line: the two would say the same thing top and bottom at once.
    const floatingStatusText = options.floating === false ? null : document.getElementById('floating-status-text');
    if (floatingStatusText) {
        floatingStatusText.textContent = message;
        floatingStatusText.parentElement?.classList.toggle('has-progress', options.transient === true);
        touchFloatingStatus();
    }
}

function statusLogEntries() {
    return statusLog.slice();
}

function previewStatusLogEntries() {
    return statusLog.slice(-STATUS_LOG_PREVIEW_ENTRIES);
}

// Every line as plain text, timestamp first — the form you paste into a bug report.
function statusLogText() {
    return statusLog.map(entry => `${entry.timestamp}\t${entry.message}`).join('\n');
}

// "Copy all" means ALL of it, not the fifty on screen. The strip is a preview and a preview is not
// what you want in a bug report; the feedback names the count, so a copy of 312 lines from a strip
// showing 50 cannot be mistaken for a copy of 50.
async function copyStatusLog() {
    if (!statusLog.length) return false;
    const copied = await copyTextWithFeedback(statusLogText());
    if (!copied) return false;
    const template = window.i18n?.t ? window.i18n.t('hud.statusLinesCopied', { count: statusLog.length }) : '';
    const message = (template && template !== 'hud.statusLinesCopied')
        ? template
        : `${statusLog.length} line${statusLog.length === 1 ? '' : 's'} copied`;
    showCopyFeedback(message);
    return true;
}

// One row. textContent, never innerHTML: a status line carries proposal titles, parcel ids and
// error text — none of it ours to trust, all of it going into the page.
function statusLogRow(entry, isCurrent) {
    const row = document.createElement('div');
    row.className = 'status-log-entry' + (isCurrent ? ' current-status' : '');
    const time = document.createElement('span');
    time.className = 'status-log-time';
    time.textContent = entry.timestamp;
    // A line that knows its proposal becomes a way to GET to it. Rendered as a real <button>, not a
    // styled span: it is an action, so it must be reachable by keyboard and announce itself as one.
    // Still textContent, never innerHTML — a status line carries titles, parcel ids and error text.
    const message = document.createElement(entry.proposalId ? 'button' : 'span');
    message.className = 'status-log-message';
    message.textContent = entry.message;
    if (entry.proposalId) {
        message.type = 'button';
        message.classList.add('is-linked');
        message.title = window.i18n?.t ? window.i18n.t('hud.showThisProposal') : 'Show this design';
        message.addEventListener('click', (event) => {
            event.stopPropagation();   // the bar's own click toggles the log; this is not that click
            goToProposalFromStatusLog(entry.proposalId);
        });
    }
    row.appendChild(time);
    row.appendChild(message);
    return row;
}

// The log is inside the app, so this needs no URL: selectAndHighlightProposal is the same entry
// point the proposals list, the map and the details panel all use. (There is no id-based deep link
// to reuse — a share URL carries the whole proposal payload inline, not a reference to one.)
function goToProposalFromStatusLog(proposalId) {
    if (!proposalId) return;
    if (typeof window.selectAndHighlightProposal !== 'function') return;
    try {
        closeStatusLogDialog();
    } catch (_) { }
    try {
        window.selectAndHighlightProposal(String(proposalId), null, true, true);
    } catch (error) {
        console.warn('status log: could not show proposal', proposalId, error);
    }
}

function fillStatusLogList(container, entries, emptyText) {
    container.innerHTML = '';
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'status-log-entry';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }
    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => fragment.appendChild(statusLogRow(entry, index === entries.length - 1)));
    container.appendChild(fragment);
}

function statusLogEmptyText() {
    const label = window.i18n?.t ? window.i18n.t('hud.statusLogEmpty') : '';
    return (label && label !== 'hud.statusLogEmpty') ? label : 'No status messages yet';
}

function updateExpandedStatusView() {
    const expandedView = document.getElementById('status-log-expanded');
    if (!expandedView || !isStatusExpanded) return;

    // Store current scroll position to maintain it
    const currentScrollTop = expandedView.scrollTop;
    const currentScrollHeight = expandedView.scrollHeight;

    fillStatusLogList(expandedView, previewStatusLogEntries(), statusLogEmptyText());

    // Auto-scroll to bottom when new content is added, unless user was scrolling up
    const isScrolledToBottom = currentScrollTop >= currentScrollHeight - expandedView.clientHeight - 10;
    if (isScrolledToBottom || currentScrollHeight === 0) {
        expandedView.scrollTop = expandedView.scrollHeight;
    }
}

// The whole log, in a window you can scroll, select and copy from.
//
// The strip under the status bar shows the last fifty and is rebuilt on every message, so it cannot
// grow without making a busy run janky. This is the other end: opened on demand, filled once, and
// then APPENDED to as messages arrive — so a run emitting hundreds of lines costs one row each
// rather than a full rebuild each.
let statusLogDialogRendered = 0;

function statusLogDialogElements() {
    const overlay = document.getElementById('status-log-modal');
    if (!overlay) return null;
    return {
        overlay,
        list: overlay.querySelector('#status-log-modal-list'),
        count: overlay.querySelector('#status-log-modal-count')
    };
}

// #status-log-modal is the shared dialog's overlay (index.html); it is shown through [hidden].
function statusLogDialogIsOpen() {
    const parts = statusLogDialogElements();
    return !!(parts && !parts.overlay.hidden);
}

function updateStatusLogDialogCount(parts) {
    if (!parts || !parts.count) return;
    const template = window.i18n?.t ? window.i18n.t('hud.statusLogCount', { count: statusLog.length }) : '';
    parts.count.textContent = (template && template !== 'hud.statusLogCount')
        ? template
        : `${statusLog.length} line${statusLog.length === 1 ? '' : 's'}`;
}

// A single new row rather than a rebuild. Falls back to a full render if the log has been trimmed
// under us, so the view cannot silently drift from the log it claims to show.
function appendToStatusLogDialog() {
    if (!statusLogDialogIsOpen()) return;
    const parts = statusLogDialogElements();
    if (!parts || !parts.list) return;
    if (statusLogDialogRendered > statusLog.length) {
        renderStatusLogDialog();
        return;
    }
    const atBottom = parts.list.scrollTop >= parts.list.scrollHeight - parts.list.clientHeight - 10;
    const previous = parts.list.querySelector('.current-status');
    if (previous) previous.classList.remove('current-status');
    for (let i = statusLogDialogRendered; i < statusLog.length; i += 1) {
        parts.list.appendChild(statusLogRow(statusLog[i], i === statusLog.length - 1));
    }
    statusLogDialogRendered = statusLog.length;
    updateStatusLogDialogCount(parts);
    if (atBottom) parts.list.scrollTop = parts.list.scrollHeight;
}

function renderStatusLogDialog() {
    const parts = statusLogDialogElements();
    if (!parts || !parts.list) return;
    fillStatusLogList(parts.list, statusLogEntries(), statusLogEmptyText());
    statusLogDialogRendered = statusLog.length;
    updateStatusLogDialogCount(parts);
    parts.list.scrollTop = parts.list.scrollHeight;
}

function openStatusLogDialog() {
    const parts = statusLogDialogElements();
    if (!parts) return;
    parts.overlay.hidden = false;
    parts.overlay.__unregisterEscape?.();
    parts.overlay.__unregisterEscape = window.ModalEscape?.register(parts.overlay, closeStatusLogDialog);
    renderStatusLogDialog();
}

function closeStatusLogDialog() {
    const parts = statusLogDialogElements();
    if (!parts) return;
    parts.overlay.hidden = true;
    parts.overlay.__unregisterEscape?.();
    parts.overlay.__unregisterEscape = null;
    statusLogDialogRendered = 0;
}

function initStatusLogDialog() {
    const parts = statusLogDialogElements();
    if (!parts) return;
    // Close twice over: the header's close circle and the footer's Close button.
    parts.overlay.querySelectorAll('#status-log-modal-close, [data-status-log-close]')
        .forEach(button => button.addEventListener('click', closeStatusLogDialog));
    const copyButton = parts.overlay.querySelector('#status-log-modal-copy');
    if (copyButton) copyButton.addEventListener('click', copyStatusLog);
    parts.overlay.addEventListener('click', event => {
        if (event.target === parts.overlay) closeStatusLogDialog();
    });
}

if (typeof window !== 'undefined') {
    window.openStatusLogDialog = openStatusLogDialog;
    window.closeStatusLogDialog = closeStatusLogDialog;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initStatusLogDialog);
    } else {
        initStatusLogDialog();
    }
}

// Give the browser a turn.
//
// `await` on a promise that is already settled schedules a MICROTASK, and microtasks run before the
// browser gets to paint or handle input — so a loop of a hundred `await`ed applies whose data is
// already cached never yields at all, and the map is frozen for the whole run even though every
// function in the chain is async. Only a macrotask (or scheduler.yield) actually hands control back.
function yieldToBrowser() {
    return new Promise(resolve => {
        try {
            if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
                scheduler.yield().then(resolve, () => resolve());
                return;
            }
        } catch (_) { }
        setTimeout(resolve, 0);
    });
}

if (typeof window !== 'undefined') window.yieldToBrowser = yieldToBrowser;

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

// The floating status line (ephemerals.md): the latest line, a spinner while anything is busy, and
// gone on its own once nothing has been said for a while and nothing is running.
const STATUS_IDLE_MS = 8000;
let statusIdleTimer = null;

function floatingStatusHost() {
    const text = document.getElementById('floating-status-text');
    const host = text && text.parentElement;
    return host && host.classList && typeof host.classList.add === 'function' ? host : null;
}

function touchFloatingStatus() {
    const host = floatingStatusHost();
    if (!host) return;
    host.classList.remove('is-idle');
    if (statusIdleTimer && typeof clearTimeout === 'function') { clearTimeout(statusIdleTimer); statusIdleTimer = null; }
    if (statusActivityHolders > 0 || typeof setTimeout !== 'function') return;
    statusIdleTimer = setTimeout(() => {
        statusIdleTimer = null;
        if (statusActivityHolders === 0) host.classList.add('is-idle');
    }, STATUS_IDLE_MS);
}

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
    const host = floatingStatusHost();
    if (host) host.classList.add('is-busy');
    touchFloatingStatus();
    return () => endStatusActivity();
}

function endStatusActivity() {
    statusActivityHolders = Math.max(0, statusActivityHolders - 1);
    if (statusActivityHolders > 0) return;
    const spinner = statusActivitySpinner();
    if (spinner) spinner.classList.remove('is-active');
    const host = floatingStatusHost();
    if (host) host.classList.remove('is-busy');
    touchFloatingStatus();
}

// The Copy all and Open log buttons, created on first expand and reused. Built here rather than in
// index.html so the collapsed bar carries nothing it cannot use.
// One row for both, so a longer translation of either cannot push them on top of each other.
function statusBarActions(statusBar) {
    let actions = statusBar.querySelector('.status-log-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'status-log-actions';
        statusBar.appendChild(actions);
    }
    return actions;
}

function ensureStatusBarButton(statusBar, marker, key, fallback, onClick) {
    if (!statusBar || statusBar.querySelector(`[${marker}]`)) return;
    const button = document.createElement('button');
    button.type = 'button';
    // The shared small button (css/primitives.css); status-log-copy-all stays as the hook.
    button.className = 'btn btn-sm status-log-copy-all';
    button.setAttribute(marker, '');
    const label = window.i18n?.t ? window.i18n.t(key) : '';
    button.textContent = (label && label !== key) ? label : fallback;
    button.setAttribute('data-i18n-key', key);
    button.setAttribute('data-i18n-attr', 'text');
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    statusBarActions(statusBar).appendChild(button);
}

function ensureStatusCopyAllButton(statusBar) {
    ensureStatusBarButton(statusBar, 'data-status-copy-all', 'hud.copyStatusLog', 'Copy all', copyStatusLog);
    ensureStatusBarButton(statusBar, 'data-status-open-log', 'hud.openStatusLog', 'Open log', openStatusLogDialog);
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

// ---- Notices (ephemerals.md) ----
// A notice announces an outcome and goes away: one pill at a time, top centre, the look of
// .cb-toast with a variant per type. It is also written to the status LOG (not the status line):
// "4 proposals removed: …" names records that are no longer on the map, and if you looked away you
// cannot get the list back from a pill that has gone; the log keeps it.
const NOTICE_VARIANTS = { info: 'notice', success: 'success', warning: 'warning', error: 'error' };
const NOTICE_EXIT_MS = 400;
let noticeQueue = null;

function noticeContainer() {
    let container = document.getElementById('ephemeral-message-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'ephemeral-message-container';
        container.setAttribute('aria-live', 'polite');
        const mapContainer = document.getElementById('map-container');
        (mapContainer || document.body).appendChild(container);
    }
    return container;
}

function presentNotice(entry) {
    const variant = NOTICE_VARIANTS[entry.type] || NOTICE_VARIANTS.info;
    const messageEl = document.createElement('div');
    messageEl.className = `ephemeral-message cb-toast cb-toast--${variant}`;
    messageEl.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    messageEl.textContent = entry.message;
    noticeContainer().appendChild(messageEl);
    requestAnimationFrame(() => messageEl.classList.add('visible'));
    return messageEl;
}

function retireNotice(messageEl) {
    if (!messageEl) return;
    messageEl.classList.remove('visible');
    // Gone after its exit transition; the timer covers a reduced-motion page where none runs.
    setTimeout(() => { if (messageEl.parentNode) messageEl.remove(); }, NOTICE_EXIT_MS);
}

function showEphemeralMessage(message, duration = 5000, type = 'info') {
    try { if (typeof updateStatus === 'function') updateStatus(message, { floating: false }); } catch (_) { }
    const entry = { message, duration, type };
    if (!noticeQueue && typeof __NoticeQueue !== 'undefined' && typeof __NoticeQueue.createNoticeQueue === 'function') {
        noticeQueue = __NoticeQueue.createNoticeQueue({ show: presentNotice, hide: retireNotice });
    }
    if (noticeQueue) return noticeQueue.push(entry);
    const messageEl = presentNotice(entry);
    setTimeout(() => retireNotice(messageEl), duration);
    return true;
}

// "Copied": a short notice, the same pill as every other outcome.
function showCopyFeedback(message) {
    showEphemeralMessage(message, 1400);
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
    // The label is restored as markup, not text: sheet buttons carry an icon and a translatable
    // <span data-i18n-key>, and restoring textContent dropped both (the label then no longer
    // followed a language switch).
    const originalHtml = button.innerHTML;
    const wasDisabled = button.disabled;
    const busyClass = opts.busyClass;
    const hadBusyClass = busyClass ? button.classList.contains(busyClass) : false;

    // busyLabel is plain text, or { key, fallback } translated through window.i18n.
    let busyText = busyLabel;
    if (busyLabel && typeof busyLabel === 'object') {
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        const translated = i18nApi && typeof i18nApi.t === 'function' ? i18nApi.t(busyLabel.key) : null;
        busyText = (typeof translated === 'string' && translated && translated !== busyLabel.key) ? translated : busyLabel.fallback;
    }
    if (busyText !== undefined && busyText !== null) {
        button.textContent = busyText;
    }
    button.disabled = true;
    if (busyClass) {
        button.classList.add(busyClass);
    }

    const restore = () => {
        if (opts.restoreText !== undefined) {
            button.textContent = opts.restoreText;
        } else if (!opts.preserveText) {
            button.innerHTML = originalHtml;
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
            // The action buttons stop propagation themselves, but a click that lands on the row
            // AROUND them is still a click on the bar — and collapsing the log out from under the
            // button you were reaching for is the same annoyance as collapsing it mid-selection.
            if (e.target.closest('.status-log-actions')) return;
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
