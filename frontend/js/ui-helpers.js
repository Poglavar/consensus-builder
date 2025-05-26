let statusHighlightTimeout = null;

function updateStatus(message) {
    const statusSpan = document.getElementById('status');
    if (statusSpan) {
        statusSpan.textContent = message;
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

document.addEventListener('DOMContentLoaded', () => {
    const statusSpan = document.getElementById('status');

    if (!statusSpan) {
        console.error('Status span element (#status) not found for MutationObserver.');
        return;
    }

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