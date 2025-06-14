// Username management system
let currentUsername = null;

// Check for username on page load and show welcome modal if needed
function initializeUser() {
    const storedUsername = localStorage.getItem('userName');
    if (storedUsername) {
        currentUsername = storedUsername;
        updateUsernameDisplay();
        // Auto-start game for returning users
        autoStartGame();
    } else {
        showWelcomeModal();
    }
}

// Auto-start game functionality
function autoStartGame() {
    // Wait a moment for all systems to initialize
    setTimeout(() => {
        if (typeof gameState !== 'undefined' && typeof initializeGame === 'function' && typeof startGameLoop === 'function') {

            // Expand the Game section and check its checkbox
            const gameCheckbox = document.getElementById('gameCheckbox');
            if (gameCheckbox && !gameCheckbox.checked) {
                gameCheckbox.checked = true;
                // Use toggleAccordion if available to properly expand the section
                if (typeof toggleAccordion === 'function') {
                    toggleAccordion(gameCheckbox);
                }
            }

            if (!gameState.isInitialized) {
                // Initialize game if not already initialized
                initializeGame();
                // Wait for initialization to complete, then start
                setTimeout(() => {
                    if (gameState.isInitialized && !gameState.isRunning) {
                        startGameLoop();
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage('Game auto-started!');
                        }
                    }
                }, 1000);
            } else if (!gameState.isRunning) {
                // Just start the game if already initialized
                startGameLoop();
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Game auto-started!');
                }
            }
        }
    }, 2000); // Give time for all modules to load
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

        // Auto-start game for new users
        autoStartGame();
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
window.autoStartGame = autoStartGame;
window.showWelcomeModal = showWelcomeModal;
window.hideWelcomeModal = hideWelcomeModal;
window.submitUsername = submitUsername;
window.updateUsernameDisplay = updateUsernameDisplay;
window.getCurrentUsername = getCurrentUsername; 