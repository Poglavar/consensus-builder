// Username management system
let currentUsername = null;

// Check for username on page load and show welcome modal if needed
function initializeUser() {
    const storedUsername = localStorage.getItem('userName');
    if (storedUsername) {
        currentUsername = storedUsername;
        updateUsernameDisplay();
    } else {
        showWelcomeModal();
    }
}

// Show welcome modal for new users
function showWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.style.display = 'flex';

    // Focus on the input field
    setTimeout(() => {
        document.getElementById('username-input').focus();
    }, 100);
}

// Hide welcome modal
function hideWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.style.display = 'none';
}

// Handle username form submission
function submitUsername(event) {
    event.preventDefault();

    const usernameInput = document.getElementById('username-input');
    const username = usernameInput.value.trim();

    if (username) {
        // Store username in localStorage
        localStorage.setItem('userName', username);
        currentUsername = username;

        // Update the display
        updateUsernameDisplay();

        // Hide the modal
        hideWelcomeModal();

        // Show a welcome message
        if (typeof updateStatus === 'function') {
            updateStatus(`Welcome, ${username}! You can now start using Consensus Builder.`);
        }
    }
}

// Update the username display in the top right corner
function updateUsernameDisplay() {
    const usernameText = document.getElementById('username-text');
    if (usernameText && currentUsername) {
        usernameText.textContent = currentUsername;
    }
}

// Get current username (for use in other parts of the app)
function getCurrentUsername() {
    return currentUsername || localStorage.getItem('userName') || '';
}

// Make functions globally available
window.initializeUser = initializeUser;
window.showWelcomeModal = showWelcomeModal;
window.hideWelcomeModal = hideWelcomeModal;
window.submitUsername = submitUsername;
window.updateUsernameDisplay = updateUsernameDisplay;
window.getCurrentUsername = getCurrentUsername; 