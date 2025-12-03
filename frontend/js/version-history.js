(function () {
    const STORAGE_KEY = 'versions_read';
    let unreadQueue = [];
    let readSet = new Set();
    let modalElement = null;
    let numberElement = null;
    let dateElement = null;
    let textElement = null;
    let nextButton = null;
    let closeButton = null;
    let currentIndex = 0;
    const VERSION_MODAL_ENABLED = false;

    function parseStoredValues(raw) {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    function loadReadSet() {
        const stored = PersistentStorage.getItem(STORAGE_KEY);
        const parsed = parseStoredValues(stored);
        readSet = new Set(parsed);
    }

    function persistReadSet() {
        try {
            PersistentStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(readSet)));
        } catch (error) {
            console.warn('Unable to persist versions_read to PersistentStorage', error);
        }
    }

    function normaliseVersionEntry(entry) {
        if (!entry) return null;
        const number = entry.version_number || entry.versionNumber || entry.number;
        const datetime = entry.version_datetime || entry.versionDatetime || entry.datetime;
        const text = entry.version_text || entry.versionText || entry.text;
        if (!number || !datetime) {
            return null;
        }
        return {
            number: String(number),
            datetime: datetime,
            text: text ? String(text) : ''
        };
    }

    function sortVersionsAscending(versions) {
        return versions.sort((a, b) => {
            const aTime = new Date(a.datetime).getTime();
            const bTime = new Date(b.datetime).getTime();
            if (isNaN(aTime) && isNaN(bTime)) return 0;
            if (isNaN(aTime)) return 1;
            if (isNaN(bTime)) return -1;
            if (aTime === bTime) {
                return a.number.localeCompare(b.number, undefined, { numeric: true });
            }
            return aTime - bTime;
        });
    }

    function prepareUnreadQueue() {
        const source = Array.isArray(window.APP_VERSIONS) ? window.APP_VERSIONS : [];
        const normalised = source
            .map(normaliseVersionEntry)
            .filter(Boolean);
        const uniqueByNumber = new Map();
        normalised.forEach(entry => {
            if (!uniqueByNumber.has(entry.number)) {
                uniqueByNumber.set(entry.number, entry);
            }
        });
        const sorted = sortVersionsAscending(Array.from(uniqueByNumber.values()));
        unreadQueue = sorted.filter(entry => !readSet.has(entry.number));
    }

    function formatDatetime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (isNaN(date.getTime())) {
            return value;
        }
        return date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function updateModalContent() {
        if (!modalElement || unreadQueue.length === 0) return;
        const current = unreadQueue[currentIndex];
        numberElement.textContent = `Version ${current.number}`;
        dateElement.textContent = formatDatetime(current.datetime);
        textElement.innerHTML = current.text.replace(/\n/g, '<br>');
        if (unreadQueue.length === 1) {
            nextButton.textContent = 'Close';
        } else if (currentIndex === unreadQueue.length - 1) {
            nextButton.textContent = 'Close';
        } else {
            nextButton.textContent = 'Next';
        }
    }

    function closeModal() {
        if (modalElement) {
            modalElement.classList.remove('visible');
            modalElement.setAttribute('aria-hidden', 'true');
        }
    }

    function advanceModal() {
        const current = unreadQueue[currentIndex];
        if (current) {
            readSet.add(current.number);
            persistReadSet();
        }
        currentIndex += 1;
        if (currentIndex >= unreadQueue.length) {
            closeModal();
            return;
        }
        updateModalContent();
    }

    function showModal() {
        if (!modalElement || unreadQueue.length === 0) return;
        currentIndex = 0;
        updateModalContent();
        modalElement.classList.add('visible');
        modalElement.setAttribute('aria-hidden', 'false');
        modalElement.focus({ preventScroll: true });
    }

    function setupModalElements() {
        modalElement = document.getElementById('version-modal');
        if (!modalElement) return false;
        numberElement = modalElement.querySelector('[data-version-number]');
        dateElement = modalElement.querySelector('[data-version-datetime]');
        textElement = modalElement.querySelector('[data-version-text]');
        nextButton = modalElement.querySelector('[data-version-next]');
        closeButton = modalElement.querySelector('[data-version-close]');

        if (!numberElement || !dateElement || !textElement || !nextButton || !closeButton) {
            return false;
        }

        nextButton.addEventListener('click', advanceModal);
        closeButton.addEventListener('click', () => {
            // Mark current as read before closing
            const current = unreadQueue[currentIndex];
            if (current) {
                readSet.add(current.number);
                persistReadSet();
            }
            closeModal();
        });

        modalElement.addEventListener('click', (event) => {
            if (event.target === modalElement) {
                const current = unreadQueue[currentIndex];
                if (current) {
                    readSet.add(current.number);
                    persistReadSet();
                }
                closeModal();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (!modalElement.classList.contains('visible')) return;
            if (event.key === 'Escape') {
                const current = unreadQueue[currentIndex];
                if (current) {
                    readSet.add(current.number);
                    persistReadSet();
                }
                closeModal();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                advanceModal();
            }
        });

        return true;
    }

    function initializeVersionHistory() {
        if (!VERSION_MODAL_ENABLED) return;
        if (window.__versionHistoryInitialized) return;
        window.__versionHistoryInitialized = true;

        loadReadSet();
        prepareUnreadQueue();
        const modalReady = setupModalElements();
        if (!modalReady || unreadQueue.length === 0) {
            return;
        }
        showModal();
    }

    window.initializeVersionHistory = initializeVersionHistory;
})();
