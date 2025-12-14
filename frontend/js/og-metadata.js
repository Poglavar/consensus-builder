/**
 * Open Graph (OG) metadata management for social media sharing
 * Updates meta tags dynamically when proposals are loaded
 */

(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.document) {
        return;
    }

    const DEFAULT_TITLE = 'Consensus Builder';
    const DEFAULT_DESCRIPTION = 'Help communities reach consensus on future development of their settlement.';
    const DEFAULT_IMAGE = '/images/consensus-builder-logo-2.png';

    /**
     * Get or create a meta tag
     */
    function getOrCreateMetaTag(property, content = '') {
        let meta = document.querySelector(`meta[property="${property}"]`) || 
                   document.querySelector(`meta[name="${property}"]`);
        
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('property', property);
            document.head.appendChild(meta);
        }
        
        if (content) {
            meta.setAttribute('content', content);
        }
        
        return meta;
    }

    /**
     * Get frontend base URL for absolute image URLs
     */
    function getFrontendBaseUrl() {
        if (typeof globalScope.getFrontendBase === 'function') {
            return globalScope.getFrontendBase();
        }
        if (typeof globalScope.getFrontendBaseUrl === 'function') {
            return globalScope.getFrontendBaseUrl();
        }
        const hostname = globalScope.location.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
            return `${globalScope.location.protocol}//${globalScope.location.host}`;
        }
        return 'https://urbangametheory.xyz';
    }

    /**
     * Resolve image URL - convert relative to absolute
     */
    function resolveImageUrl(imageUrl) {
        if (!imageUrl) return null;
        
        // If already absolute URL, return as is
        if (/^https?:\/\//.test(imageUrl)) {
            return imageUrl;
        }
        
        // If IPFS URL, return as is
        if (/^ipfs:\/\//.test(imageUrl)) {
            // Convert IPFS to HTTP gateway URL
            const ipfsHash = imageUrl.replace(/^ipfs:\/\//, '');
            return `https://ipfs.io/ipfs/${ipfsHash}`;
        }
        
        // Relative URL - make absolute
        const baseUrl = getFrontendBaseUrl();
        const cleanPath = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
        return `${baseUrl}${cleanPath}`;
    }

    /**
     * Update Open Graph metadata for a proposal
     */
    function updateProposalOGMetadata(proposal) {
        if (!proposal) {
            resetOGMetadata();
            return;
        }

        const baseUrl = getFrontendBaseUrl();
        const currentUrl = globalScope.location.href;
        
        // Extract proposal information
        const title = proposal.title || proposal.name || proposal.proposalName || 'Untitled Proposal';
        const description = proposal.description || 
                          (proposal.type ? `A ${proposal.type} proposal` : 'A proposal on Consensus Builder') ||
                          DEFAULT_DESCRIPTION;
        const author = proposal.author || proposal.username || '';
        
        // Build description with author if available
        let fullDescription = description;
        if (author) {
            fullDescription = `By ${author}. ${description}`;
        }
        
        // Limit description length for social media (typically 200 chars)
        if (fullDescription.length > 200) {
            fullDescription = fullDescription.substring(0, 197) + '...';
        }

        // Resolve image URL
        let imageUrl = null;
        if (proposal.imageURI) {
            imageUrl = resolveImageUrl(proposal.imageURI);
        } else if (proposal.imageUrl) {
            imageUrl = resolveImageUrl(proposal.imageUrl);
        } else if (proposal.onchain && proposal.onchain.imageUri) {
            imageUrl = resolveImageUrl(proposal.onchain.imageUri);
        } else if (proposal.onchain && proposal.onchain.imageUrl) {
            imageUrl = resolveImageUrl(proposal.onchain.imageUrl);
        }
        
        // Fallback to default image if no proposal image
        if (!imageUrl) {
            imageUrl = resolveImageUrl(DEFAULT_IMAGE);
        }

        // Update page title
        document.title = `${title} - ${DEFAULT_TITLE}`;

        // Open Graph tags
        getOrCreateMetaTag('og:title', title);
        getOrCreateMetaTag('og:description', fullDescription);
        getOrCreateMetaTag('og:image', imageUrl);
        getOrCreateMetaTag('og:url', currentUrl);
        getOrCreateMetaTag('og:type', 'website');
        getOrCreateMetaTag('og:site_name', DEFAULT_TITLE);

        // Twitter Card tags
        getOrCreateMetaTag('twitter:card', 'summary_large_image');
        getOrCreateMetaTag('twitter:title', title);
        getOrCreateMetaTag('twitter:description', fullDescription);
        getOrCreateMetaTag('twitter:image', imageUrl);

        // Additional meta tags
        getOrCreateMetaTag('description', fullDescription);
    }

    /**
     * Reset OG metadata to defaults
     */
    function resetOGMetadata() {
        const baseUrl = getFrontendBaseUrl();
        const currentUrl = globalScope.location.href;
        const imageUrl = resolveImageUrl(DEFAULT_IMAGE);

        document.title = DEFAULT_TITLE;

        getOrCreateMetaTag('og:title', DEFAULT_TITLE);
        getOrCreateMetaTag('og:description', DEFAULT_DESCRIPTION);
        getOrCreateMetaTag('og:image', imageUrl);
        getOrCreateMetaTag('og:url', currentUrl);
        getOrCreateMetaTag('og:type', 'website');
        getOrCreateMetaTag('og:site_name', DEFAULT_TITLE);

        getOrCreateMetaTag('twitter:card', 'summary_large_image');
        getOrCreateMetaTag('twitter:title', DEFAULT_TITLE);
        getOrCreateMetaTag('twitter:description', DEFAULT_DESCRIPTION);
        getOrCreateMetaTag('twitter:image', imageUrl);

        getOrCreateMetaTag('description', DEFAULT_DESCRIPTION);
    }

    /**
     * Initialize default OG metadata on page load
     */
    function initializeOGMetadata() {
        resetOGMetadata();
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeOGMetadata);
    } else {
        initializeOGMetadata();
    }

    // Export functions
    globalScope.updateProposalOGMetadata = updateProposalOGMetadata;
    globalScope.resetOGMetadata = resetOGMetadata;
})();

