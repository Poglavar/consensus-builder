/*
    Agent system for the consensus builder application.
    This file contains functionality for creating, managing, and controlling AI agents
    that can interact with the parcel system and make proposals.
*/

// The stored form of the agents. ownedParcels mirrors the parcel owner rows, and a derived live
// piece's owner row is memory-only (persistent-storage.js isMemoryOnlyKey: the replay rebuilds it),
// so derived piece ids are left out of the stored list too.
function agentRowsForStorage(agents) {
    const derived = id => PersistentStorage.isDerivedParcelId(id);
    return Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        ...agent,
        ...(Array.isArray(agent && agent.ownedParcels)
            ? { ownedParcels: agent.ownedParcels.filter(parcelId => !derived(parcelId)) }
            : {})
    }));
}

// Agent storage and management
const agentStorage = {
    agents: new Map(), // Key: agentId, Value: agent object
    _suspendSaveCount: 0,
    _hasPendingSave: false,

    snapshotForMutation() {
        return {
            records: new Map(Array.from(this.agents, ([id, agent]) => [id, JSON.parse(JSON.stringify(agent))]))
        };
    },

    createMutationDraft(snapshot) {
        const draft = Object.create(this);
        draft.agents = new Map(Array.from(snapshot.records || [], ([id, agent]) => [id, JSON.parse(JSON.stringify(agent))]));
        draft._suspendSaveCount = 0;
        draft._hasPendingSave = false;
        draft.save = () => { draft._hasPendingSave = true; };
        draft._saveOrDefer = draft.save;
        draft.beginBatch = () => {};
        draft.endBatch = () => {};
        return draft;
    },

    serializeMutationDraft(draft) {
        const serialize = agents => JSON.stringify(agentRowsForStorage(agents));
        const value = serialize(draft.agents);
        // Unchanged agents mean nothing durable to write for this store.
        if (value === serialize(this.agents)) return null;
        return { key: 'consensus_agents', value };
    },

    publishMutationDraft(draft) {
        this.agents.clear();
        draft.agents.forEach((agent, id) => this.agents.set(id, JSON.parse(JSON.stringify(agent))));
        this._hasPendingSave = false;
    },

    restoreMutationSnapshot(snapshot) {
        this.publishMutationDraft({ agents: snapshot.records });
    },

    // Save agents to PersistentStorage
    save() {
        PersistentStorage.setItem('consensus_agents', JSON.stringify(agentRowsForStorage(this.agents)));
    },

    // Load agents from PersistentStorage
    load() {
        const data = PersistentStorage.getItem('consensus_agents');
        if (!data) {
            return;
        }

        this.agents.clear();

        try {
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed)) {
                return;
            }

            parsed.forEach(agent => {
                if (!agent || !agent.id) return;
                this.agents.set(agent.id, agent);
            });
        } catch (error) {
            console.error('agentStorage.load: Failed to parse agents from storage', error);
            this.agents.clear();
        }
    },

    beginBatch() {
        this._suspendSaveCount += 1;
    },

    endBatch() {
        if (this._suspendSaveCount > 0) {
            this._suspendSaveCount -= 1;
        }
        if (this._suspendSaveCount === 0 && this._hasPendingSave) {
            this._hasPendingSave = false;
            this.save();
        }
    },

    _saveOrDefer() {
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
            return;
        }
        this.save();
    },

    // Add a new agent
    addAgent(agent) {
        this.agents.set(agent.id, agent);
        this._saveOrDefer();
        return agent.id;
    },

    // Get agent by ID
    getAgent(agentId) {
        return this.agents.get(agentId);
    },

    // Get all agents
    getAllAgents() {
        return Array.from(this.agents.values());
    },

    // Update agent
    updateAgent(agentId, updates) {
        const agent = this.agents.get(agentId);
        if (agent) {
            Object.assign(agent, updates);
            this._saveOrDefer();
        }
    },

    // Delete agent
    deleteAgent(agentId) {
        this.agents.delete(agentId);
        this._saveOrDefer();
    },

    // Clear all agents
    clear() {
        this.agents.clear();
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
        } else {
            PersistentStorage.removeItem('consensus_agents');
        }
    }
};

// Maximum number of avatars/agents
const MAX_AGENTS = 17;

// Agent name generation
const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u'];

/**
 * Generate a random agent name with 3-6 syllables of consonant-vowel combinations
 * @returns {string} - Generated name with first letter capitalized
 */
function generateAgentName() {
    const syllableCount = Math.floor(Math.random() * 4) + 3; // 3-6 syllables
    let name = '';

    for (let i = 0; i < syllableCount; i++) {
        const consonant = CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)];
        const vowel = VOWELS[Math.floor(Math.random() * VOWELS.length)];
        name += consonant + vowel;
    }

    // Capitalize first letter
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Create a new agent with sequential avatar assignment
 * @returns {Object} - New agent object
 */
function createAgent() {
    // Find the next available avatar index (0-15)
    const usedIndices = new Set(agentStorage.getAllAgents().map(a => a.avatarIndex));
    let avatarIndex = 0;
    while (usedIndices.has(avatarIndex) && avatarIndex < MAX_AGENTS) avatarIndex++;
    if (avatarIndex >= MAX_AGENTS) throw new Error('Maximum number of agents reached');

    const agentId = 'agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const agent = {
        id: agentId,
        name: generateAgentName(),
        avatarIndex: avatarIndex,
        ethBalance: 100, // Initial 100 ETH as specified
        walletAddresses: [],
        ownedParcels: [],
        proposalsCreated: [],
        proposalsExecuted: [],
        createdAt: new Date().toISOString(),
        lastActionAt: null,
        controller: 'algorithm',
        aiControlled: true, // AI controls this agent by default
        userControlled: false // Not controlled by user
    };
    return agent;
}

/**
 * Create a user agent with specified name and avatar
 * @param {string} name - Agent name
 * @param {number} avatarIndex - Avatar index
 * @param {object} options - Optional settings
 * @param {boolean} options.isGuest - Whether this is a guest agent
 */
function createUserAgent(name, avatarIndex, options = {}) {
    const agentId = 'user_agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const agent = {
        id: agentId,
        name: name,
        avatarIndex: avatarIndex,
        ethBalance: 100, // Initial 100 ETH
        walletAddresses: [],
        ownedParcels: [],
        proposalsCreated: [],
        proposalsExecuted: [],
        createdAt: new Date().toISOString(),
        lastActionAt: null,
        controller: 'human',
        aiControlled: false, // Not AI controlled
        userControlled: true, // Controlled by user
        isGuest: options.isGuest === true // Track if user hasn't personalized their profile
    };
    return agent;
}

/**
 * Set agent as user controlled and clear other user controlled agents
 */
function setUserControlledAgent(agentId, isUserControlled = true) {
    const agents = agentStorage.getAllAgents();

    // Clear userControlled flag from all agents first
    agents.forEach(agent => {
        if (agent.userControlled) {
            agentStorage.updateAgent(agent.id, { userControlled: false });
        }
    });

    // Set the specified agent as user controlled
    if (isUserControlled) {
        agentStorage.updateAgent(agentId, { userControlled: true, aiControlled: false, controller: 'human' });
    }
}

// Helper to get avatar image path
function getAvatarImagePath(avatarIndex) {
    return `avatars/avatar${avatarIndex}.png`;
}

/**
 * Get parcels owned by an agent
 * @param {string} agentId - The agent ID
 * @returns {Array} - Array of parcel IDs owned by the agent
 */
function forEachPersistentParcelOwnership(iterator, options = {}) {
    if (typeof iterator !== 'function') return;
    const storage = options.storage || PersistentStorage;
    // PersistentStorage.key(i) materialises Array.from(cache.keys()) on every call. Walking N
    // entries through that API is therefore O(N²) and made a two-parcel readjustment pause for
    // about two seconds in a mature plan. The storage already exposes its cache's linear walk.
    if (storage && typeof storage.forEach === 'function') {
        storage.forEach((ownerId, key) => {
            if (key && key.startsWith('parcel_') && key.endsWith('_owner')) {
                iterator(String(ownerId), key.slice(7, -6));
            }
        });
        return;
    }
    // Compatibility for older embedded storage adapters.
    for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith('parcel_') && key.endsWith('_owner')) {
            iterator(String(storage.getItem(key)), key.slice(7, -6));
        }
    }
}

function getAgentOwnedParcels(agentId, { includePersistent = true, includeTransient = true, storage = null } = {}) {
    const parcels = [];

    if (includePersistent) {
        forEachPersistentParcelOwnership((ownerId, parcelId) => {
            if (ownerId === agentId) parcels.push(parcelId);
        }, { storage: storage || PersistentStorage });
    }

    // Merge only observations belonging to the current connected wallet scope.
    if (includeTransient) parcels.push(...getAgentObservedWalletParcels(agentId));

    return Array.from(new Set(parcels));
}

function buildAgentOwnedParcelIndex({ includePersistent = true, includeTransient = true, storage = null } = {}) {
    const ownerToParcels = new Map();

    const addOwnership = (ownerId, parcelId) => {
        if (!ownerId || !parcelId) return;
        const ownerKey = String(ownerId);
        const parcelKey = String(parcelId);
        if (!ownerToParcels.has(ownerKey)) {
            ownerToParcels.set(ownerKey, []);
        }
        ownerToParcels.get(ownerKey).push(parcelKey);
    };

    if (includePersistent) {
        forEachPersistentParcelOwnership(addOwnership, { storage: storage || PersistentStorage });
    }

    if (includeTransient) {
        Object.keys(agentWalletObservations).forEach(agentId => {
            getAgentObservedWalletParcels(agentId).forEach(parcelId => addOwnership(agentId, parcelId));
        });
    }

    ownerToParcels.forEach((parcelIds, ownerId) => {
        ownerToParcels.set(ownerId, Array.from(new Set(parcelIds)));
    });

    return ownerToParcels;
}

/**
 * Update agent's owned parcels list
 * @param {string} agentId - The agent ID
 */
function updateAgentOwnedParcels(agentId, options = {}) {
    const store = options.agentStore || agentStorage;
    const ownedParcels = getAgentOwnedParcels(agentId, { storage: options.storage || null });
    store.updateAgent(agentId, { ownedParcels });
}

/**
 * Transfer parcel ownership from one agent to another
 * @param {string} parcelId - The parcel ID
 * @param {string} fromAgentId - Current owner agent ID
 * @param {string} toAgentId - New owner agent ID
 */
function transferParcelOwnership(parcelId, fromAgentId, toAgentId, options = {}) {
    const storage = options.storage || PersistentStorage;
    const store = options.agentStore || agentStorage;
    // Update PersistentStorage
    storage.setItem(`parcel_${parcelId}_owner`, toAgentId);

    // Update both agents' owned parcels lists. skipAgentSync lets a bulk caller (e.g. a parcel layout
    // carrying owners over to dozens of pieces) defer this to one keyspace pass afterwards — each updateAgentOwnedParcels
    // scans the whole keyspace, so doing it per parcel is O(n²).
    if (!options.skipAgentSync) {
        if (fromAgentId) {
            updateAgentOwnedParcels(fromAgentId, { storage, agentStore: store });
        }
        if (toAgentId) {
            updateAgentOwnedParcels(toAgentId, { storage, agentStore: store });
        }
    }

    console.log(`Transferred parcel ${parcelId} from ${fromAgentId || 'nobody'} to ${toAgentId}`);
    // Transfers are tracked browser-local (parcel_<id>_owner). The old server round-trip via
    // /parcel-ownership was write-only — its read-back (hydrateParcelOwnershipFromServer) was never
    // wired in — so the endpoint (an unauthenticated upsert) was removed.
}

// ---- Proposal ownership execution (Tiers 0–1) -----------------------------
// A stable "City" agent so public-good / to-city transfers have a real owner id
// (city ownership previously existed only as a display label).
const CITY_AGENT_ID = 'agent_city';

function getOrCreateCityAgent(options = {}) {
    const store = options.agentStore || agentStorage;
    if (!store.getAgent(CITY_AGENT_ID)) {
        store.addAgent({
            id: CITY_AGENT_ID, name: 'City', avatarIndex: 0, isCity: true,
            ethBalance: 0, walletAddresses: [], ownedParcels: [],
            proposalsCreated: [], proposalsExecuted: [],
            createdAt: new Date().toISOString(), lastActionAt: null,
            controller: 'system', aiControlled: false, userControlled: false
        });
    }
    return CITY_AGENT_ID;
}

function _recipientHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
}

// Find-or-create a lightweight agent for a third-party recipient (a name or 0x address).
function getOrCreateAgentForRecipient(label, options = {}) {
    if (!label) return null;
    const trimmed = String(label).trim();
    if (!trimmed) return null;
    const store = options.agentStore || agentStorage;
    const existing = store.getAllAgents().find(a =>
        (a.name || '').trim().toLowerCase() === trimmed.toLowerCase()
        || (Array.isArray(a.walletAddresses) && a.walletAddresses.some(w => (w || '').toLowerCase() === trimmed.toLowerCase())));
    if (existing) return existing.id;
    const id = 'agent_recipient_' + _recipientHash(trimmed.toLowerCase());
    if (!store.getAgent(id)) {
        store.addAgent({
            id, name: trimmed, avatarIndex: 0, external: true,
            ethBalance: 0, walletAddresses: trimmed.startsWith('0x') ? [trimmed] : [],
            ownedParcels: [], proposalsCreated: [], proposalsExecuted: [],
            createdAt: new Date().toISOString(), lastActionAt: null,
            controller: 'human', aiControlled: false, userControlled: false
        });
    }
    return id;
}

function getOrCreateJointPoolAgent(label, members, options = {}) {
    const store = options.agentStore || agentStorage;
    const normalized = (Array.isArray(members) ? members : []).map(member => ({
        agentId: String(member.agentId || member.ownerKey || '').trim(),
        name: String(member.name || member.displayName || member.ownerLabel || '').trim(),
        share: member.share
    })).sort((a, b) => `${a.agentId}\u0000${a.name}`.localeCompare(`${b.agentId}\u0000${b.name}`));
    if (!normalized.length || normalized.some(member => !member.agentId || !member.name || !Number.isFinite(member.share) || member.share <= 0)
        || Math.abs(normalized.reduce((sum, member) => sum + member.share, 0) - 1) > 1e-6) {
        throw new Error('Joint pool members must have valid identities and shares summing to one.');
    }
    const key = JSON.stringify(normalized);
    const id = 'agent_joint_pool_' + _recipientHash(key);
    const existing = store.getAgent(id);
    if (existing && JSON.stringify(existing.members) !== key) throw new Error('Joint pool identity collision.');
    if (!existing) {
        store.addAgent({
            id, name: label || normalized.map(member => member.name).join(' / '), avatarIndex: 0,
            jointPool: true, members: normalized, ethBalance: 0, walletAddresses: [], ownedParcels: [],
            proposalsCreated: [], proposalsExecuted: [], createdAt: new Date().toISOString(),
            lastActionAt: null, aiControlled: false, userControlled: false
        });
    }
    return id;
}

// Parcel ownership in game mode is tracked browser-local (parcel_<id>_owner); canonical ownership
// is on-chain. The old non-canonical server cache (/parcel-ownership) was removed — its read-back
// was never wired in, so it was a write-only, unauthenticated upsert.

if (typeof window !== 'undefined') {
    window.getOrCreateCityAgent = getOrCreateCityAgent;
    window.CITY_AGENT_ID = CITY_AGENT_ID;
}

/**
 * Build an edge-keyed adjacency map for the supplied parcel pool.
 * Two parcels are neighbours if they share an edge segment (after quantising
 * vertices to 1 cm). This is far more robust than vertex-only matching —
 * adjacent cadastre parcels frequently subdivide a shared boundary into
 * different vertex sequences, so the previous vertex-equality check missed
 * most real neighbours and almost every proposal collapsed to a single parcel.
 */
function buildAgentNeighborMap(parcels) {
    // Every parcel in one metric frame (projections.md §2): shared edges meet in the same metres,
    // quantised to 1 cm whatever CRS the city's dataset is in.
    const quantize = 100;
    const minEdgeLen = 0.1;
    const frame = parcels.length ? window.__metricFrame.frameFor(parcels.map(parcel => parcel.feature)) : null;
    const edgeMap = new Map(); // edgeKey -> Set<parcelId>

    function keyForEdge(p, q) {
        const x1 = Math.round(p[0] * quantize);
        const y1 = Math.round(p[1] * quantize);
        const x2 = Math.round(q[0] * quantize);
        const y2 = Math.round(q[1] * quantize);
        const swap = x1 === x2 ? y1 > y2 : x1 > x2;
        return swap
            ? `${x2},${y2}|${x1},${y1}`
            : `${x1},${y1}|${x2},${y2}`;
    }

    for (const parcel of parcels) {
        if (typeof metricExteriorRing !== 'function') break;
        const ring = metricExteriorRing(parcel.feature, frame);
        if (!Array.isArray(ring) || ring.length < 2) continue;
        const n = ring.length - 1; // skip duplicate closing vertex
        for (let i = 0; i < n; i++) {
            const p = ring[i];
            const q = ring[i + 1];
            if (!Array.isArray(p) || !Array.isArray(q)) continue;
            const dx = q[0] - p[0];
            const dy = q[1] - p[1];
            if (Math.hypot(dx, dy) <= minEdgeLen) continue;
            const k = keyForEdge(p, q);
            let bucket = edgeMap.get(k);
            if (!bucket) {
                bucket = new Set();
                edgeMap.set(k, bucket);
            }
            bucket.add(parcel.id);
        }
    }

    const neighborMap = new Map();
    function link(a, b) {
        let list = neighborMap.get(a);
        if (!list) {
            list = [];
            neighborMap.set(a, list);
        }
        if (!list.includes(b)) list.push(b);
    }
    edgeMap.forEach(idSet => {
        if (idSet.size !== 2) return; // shared by exactly two parcels = adjacency
        const [a, b] = Array.from(idSet);
        link(a, b);
        link(b, a);
    });
    return neighborMap;
}

/**
 * Find contiguous parcels for agent proposal creation.
 * @param {Array} allParcels - Pool of eligible parcels ({id, layer, isOwned}).
 * @param {number} targetSize - Desired number of parcels (1-10).
 * @param {Map<string, string[]>} neighborMap - Precomputed adjacency map.
 * @returns {Array} - Array of selected parcels.
 */
function findContiguousParcels(allParcels, targetSize, neighborMap) {
    if (!allParcels.length) return [];
    const map = neighborMap instanceof Map ? neighborMap : buildAgentNeighborMap(allParcels);

    const idToParcel = new Map();
    allParcels.forEach(p => idToParcel.set(p.id, p));

    const startParcel = allParcels[Math.floor(Math.random() * allParcels.length)];
    const selected = [startParcel];
    const visited = new Set([startParcel.id]);
    const queue = [startParcel.id];

    while (queue.length && selected.length < targetSize) {
        const currentId = queue.shift();
        const neighborIds = map.get(currentId) || [];
        // Shuffle in place for variety
        const order = neighborIds.slice();
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (const nId of order) {
            if (visited.has(nId)) continue;
            const neighbor = idToParcel.get(nId);
            if (!neighbor) continue; // neighbour was filtered out (road/park/etc.)
            selected.push(neighbor);
            visited.add(nId);
            queue.push(nId);
            if (selected.length >= targetSize) break;
        }
    }

    return selected;
}

/**
 * Determine if a parcel should be treated as a road (and thus excluded
 * from agent-generated proposals). In order:
 * 1. Explicit isRoad / isCorridor / isTrack flag.
 * 2. Curved-road heuristic: bbox-area / parcel-area > 4 (parcel fills only a
 *    small fraction of its bounding box — typical of bends).
 * 3. Thin-strip heuristic: bbox aspect ratio > 6 and short side < 15 m. Many
 *    straight road parcels are perfect rectangles, so the area-ratio test
 *    misses them; cadastre data also frequently leaves road parcels without
 *    any explicit road designation, so we lean on the geometry directly.
 */
function isRoadLikeParcel(feature) {
    if (!feature || !feature.geometry) return false;

    const parcelId = (typeof ensureParcelId === 'function') ? ensureParcelId(feature) : (feature.properties?.parcelId || feature.properties?.parcel_id || feature.properties?.id);

    const props = feature.properties || {};
    const explicitRoad = (parcelId && typeof window.isRoadParcel === 'function' && window.isRoadParcel(parcelId))
        || props.isRoad === true
        || props.isCorridor === true
        || props.isTrack === true;
    if (explicitRoad) return true;

    const coords = metricExteriorRing(feature, window.__metricFrame.frameFor(feature));
    if (coords.length < 4) return false;

    let minX = coords[0][0], maxX = coords[0][0];
    let minY = coords[0][1], maxY = coords[0][1];
    coords.forEach(c => {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
    });

    const bboxWidth = maxX - minX;
    const bboxHeight = maxY - minY;
    const bboxArea = bboxWidth * bboxHeight;
    const area = props.calculatedArea;
    if (!area || area === 0) return false;

    if (bboxArea / area > 4) return true;

    const longSide = Math.max(bboxWidth, bboxHeight);
    const shortSide = Math.min(bboxWidth, bboxHeight);
    if (shortSide > 0 && shortSide < 15 && longSide / shortSide > 6) return true;

    return false;
}

/**
 * Reject parcels that are children of an applied park / square / lake proposal
 * — they represent public open space and should never be the subject of new
 * agent proposals.
 */
function isStructureDescendantParcel(feature) {
    const producerId = feature?.properties?.producedByProposalId || null;
    if (!producerId) return false;
    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') return false;
    const proposal = proposalStorage.getProposal(producerId);
    if (!proposal) return false;
    const goal = (proposal.goal || '').toString().toLowerCase();
    return goal === 'park' || goal === 'square' || goal === 'lake';
}

function buildTurnParcelPool() {
    const fabric = typeof window !== 'undefined' ? window.LiveParcelFabric : null;
    if (!fabric || typeof fabric.list !== 'function') {
        return [];
    }

    // Confine the agent's universe to the city the user is actually viewing.
    // A stale request can finish while navigation is underway; without this filter
    // agents can author proposals for parcels in another city, which then
    // render as bubbles/shapes far from the current map view.
    const cityId = (typeof window !== 'undefined' && window.CityConfigManager
            && typeof window.CityConfigManager.getCurrentCityId === 'function')
        ? window.CityConfigManager.getCurrentCityId()
        : null;
    const inCityFn = (typeof isInCity === 'function') ? isInCity : null;

    // No random sub-sampling here: an agent's BFS over the pool needs the full
    // local neighbourhood. Earlier we capped this at 600 random parcels, which
    // is why almost every proposal collapsed to a single parcel — a parcel's
    // neighbours were usually not in the random sample.
    const parcels = [];
    fabric.list().forEach(feature => {
        if (!feature?.properties) return;
        const parcelId = (typeof ensureParcelId === 'function')
            ? ensureParcelId(feature)
            : (feature.properties.parcelId || feature.properties.parcel_id || feature.properties.id);
        if (!parcelId) return;

        if (cityId && inCityFn && !inCityFn(parcelId, cityId)) return;
        if (isRoadLikeParcel(feature)) return;
        if (isStructureDescendantParcel(feature)) return;

        const area = feature.properties.calculatedArea || 0;
        if (area > 15000) return;

        parcels.push({ id: parcelId, feature });
    });

    return parcels;
}

/**
 * Agent decision-making: decide what action to take
 * @param {Object} agent - The agent object
 * @returns {Object} - Action object with type and details
 */
function agentDecideAction(agent, turnContext = null) {
    const safeTurnContext = turnContext && typeof turnContext === 'object' ? turnContext : {};
    const sharedTurnParcelPool = Array.isArray(safeTurnContext.turnParcelPool)
        ? safeTurnContext.turnParcelPool
        : null;
    const sharedNeighborMap = safeTurnContext.neighborMap instanceof Map
        ? safeTurnContext.neighborMap
        : null;

    // Owners decide on agreements (plan-design-agreement.md, M3); a simulated agent only creates designs.
    const actions = ['nothing', 'create'];
    const actionType = actions[Math.floor(Math.random() * actions.length)];

    const indexedOwnedParcels = safeTurnContext.ownedParcelsByAgent && typeof safeTurnContext.ownedParcelsByAgent.get === 'function'
        ? safeTurnContext.ownedParcelsByAgent.get(agent.id)
        : null;
    const ownedParcels = Array.isArray(indexedOwnedParcels)
        ? indexedOwnedParcels
        : getAgentOwnedParcels(agent.id);

    switch (actionType) {
        case 'nothing':
            return { type: 'nothing' };

        case 'create':
            // Create a proposal for 1-8 contiguous parcels from any available parcels
            // Must include at least one parcel not owned by the agent

            // Get all available parcels from the committed fabric.
            if (!window.LiveParcelFabric) {
                return { type: 'nothing' };
            }

            const ownedParcelSet = new Set((ownedParcels || []).map(id => id != null ? id.toString() : id));
            const allParcels = (sharedTurnParcelPool && sharedTurnParcelPool.length > 0)
                ? sharedTurnParcelPool
                : buildTurnParcelPool();

            if (allParcels.length === 0) {
                return { type: 'nothing' };
            }

            const targetSize = Math.floor(Math.random() * 10) + 1; // 1-10 parcels
            const neighborMap = sharedNeighborMap || buildAgentNeighborMap(allParcels);
            const proposalParcels = findContiguousParcels(allParcels, targetSize, neighborMap);

            if (proposalParcels.length === 0) {
                return { type: 'nothing' };
            }

            // Require at least one parcel not owned by the agent. Compute this
            // on the (≤10) selected parcels rather than tagging the full pool
            // up front; the pool is shared across every agent in the turn.
            const hasUnownedParcel = proposalParcels.some(p => {
                const idStr = p.id != null ? p.id.toString() : p.id;
                return !ownedParcelSet.has(idStr);
            });
            if (!hasUnownedParcel) {
                return { type: 'nothing' };
            }

            // Agents author the same complete structure instruction as the UI.  The selected live
            // parcel ids below are transient authoring input only; the durable proposal receives
            // their union geometry and the store projects them once to immutable cadastral ids.
            const proposalTypes = ['park', 'square', 'lake'];
            const randomType = proposalTypes[Math.floor(Math.random() * proposalTypes.length)];
            const structureGeometry = (typeof buildGeometryFromParcels === 'function')
                ? buildGeometryFromParcels(proposalParcels.map(parcel => parcel.feature))
                : null;
            if (!structureGeometry || !structureGeometry.type) {
                return { type: 'nothing' };
            }

            return {
                type: 'create',
                parcelIds: proposalParcels.map(p => p.id),
                geometry: structureGeometry,
                goal: randomType,
                proposalType: randomType, // legacy logging only; remove once consumers migrated
                title: randomType,
                description: `${randomType} development proposed by ${agent.name}`
            };

        default:
            return { type: 'nothing' };
    }
}

/**
 * Build a consistent proposal link for agent/game log entries using proposal ids.
 * Log links run script (the activity binders in game.js and setupAgentLogClickListeners find them by
 * their *-link-clickable class), so they are <button class="cb-link">, never an anchor with a
 * placeholder "#" href.
 */
function buildProposalLogLinkAgent(proposalIdOrHash, proposalOverride = null) {
    const proposal = proposalOverride
        || (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
            ? proposalStorage.getProposal(proposalIdOrHash)
            : null);
    const hasProposalId = proposal && proposal.proposalId !== undefined && proposal.proposalId !== null;
    const dataId = hasProposalId
        ? String(proposal.proposalId)
        : (proposalIdOrHash || '');
    const displayId = hasProposalId
        ? dataId
        : (proposalIdOrHash ? String(proposalIdOrHash).substring(0, 8) : 'unknown');
    const hashAttr = proposalIdOrHash ? ` data-proposal-hash="${proposalIdOrHash}"` : '';
    return `<button type="button" class="cb-link proposal-link-clickable" data-proposal-id="${dataId}"${hashAttr}>${displayId}</button>`;
}

/**
 * Execute an agent's action
 * @param {Object} agent - The agent object
 * @param {Object} action - The action to execute
 * @returns {string} - Log message describing the action
 */
async function executeAgentAction(agent, action) {
    switch (action.type) {
        case 'nothing':
            return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button> did nothing this turn.`;

        case 'create':
            if (typeof proposalStorage !== 'undefined') {
                // Calculate bounds for the proposal (for reliable positioning)
                let bounds = null;
                if (typeof calculateProposalBounds === 'function') {
                    bounds = calculateProposalBounds(action.parcelIds);
                }

                const fabric = (typeof window !== 'undefined') ? window.LiveParcelFabric : null;
                if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
                    return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button>`
                        + ' failed to create a proposal because cadastral ground is unavailable.';
                }
                let cadastreParcelIds;
                try {
                    cadastreParcelIds = fabric.cadastreIdsForParcelIds(action.parcelIds);
                } catch (_) {
                    return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button>`
                        + ' failed to create a proposal because its selected ground is no longer current.';
                }
                if (!cadastreParcelIds.length || !action.geometry?.type) {
                    return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button>`
                        + ' failed to create a proposal because its authored geometry is incomplete.';
                }

                const proposal = {
                    author: agent.name,
                    title: action.title,
                    description: action.description,
                    cadastreParcelIds,
                    goal: action.goal || 'square',
                    structureProposal: {
                        kind: action.goal || 'square',
                        geometry: action.geometry,
                        blockName: action.title || null
                    },
                    bounds: bounds, // Store bounds for reliable positioning
                    createdAt: new Date().toISOString() // Add creation timestamp
                };

                const proposalId = proposalStorage.addProposal(proposal, {
                    selectedParcelIds: action.parcelIds
                });
                if (proposalId === null) {
                    // console.log('Attempt failed:This exact proposal already exists');
                    return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button>`
                        + ` failed to create a proposal because it already exists.`;
                }

                // Update agent's created proposals list
                if (!agent.proposalsCreated.includes(proposalId)) {
                    agent.proposalsCreated.push(proposalId);
                    agentStorage.updateAgent(agent.id, { proposalsCreated: agent.proposalsCreated });
                }

                // Show agent bubble for this interaction
                if (typeof window.agentBubbleManager !== 'undefined') {
                    const proposalPosition = window.agentBubbleManager.getProposalPosition(proposalId);
                    if (proposalPosition) {
                        window.agentBubbleManager.addBubble({
                            agentId: agent.id,
                            agentName: agent.name,
                            avatarIndex: agent.avatarIndex,
                            objectType: 'proposal',
                            objectId: proposalId,
                            objectPosition: proposalPosition,
                            action: `created ${action.goal || action.proposalType || 'proposal'} proposal`
                        });
                    }
                }

                const storedProposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
                    ? proposalStorage.getProposal(proposalId)
                    : null;
                const proposalLink = buildProposalLogLinkAgent(proposalId, storedProposal);

                return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button> created a ${(action.goal || action.proposalType || 'proposal')} proposal (${proposalLink}) for ${action.parcelIds.length} parcel(s).`;
            }
            return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button> tried to create a proposal but failed.`;

        default:
            return `<button type="button" class="cb-link agent-link-clickable" data-agent-id="${agent.id}">${agent.name}</button> performed an unknown action.`;
    }
}

function getCurrentAgentWalletScope() {
    // A connected Solana wallet takes precedence; an unknown cluster has no usable scope.
    const evm = window.walletManager?.getState?.();
    const solana = window.solanaWalletManager?.getState?.();
    return window.AgentWalletScope.connected({
        evm, solana,
        solanaCluster: window.solanaWalletManager?.getCluster?.() || solana?.cluster
    });
}

function getAgentObservedWalletParcels(agentId) {
    if (agentStorage.getAgent(agentId)?.userControlled !== true) return [];
    return window.AgentWalletScope.parcelIds(agentWalletObservations[agentId], getCurrentAgentWalletScope());
}

function getAgentProposalRecords() {
    return typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals() : [];
}

function getI18nApi() {
    return (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
}

function formatString(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateText(key, fallback, params = {}) {
    const api = getI18nApi();
    if (api && typeof api.t === 'function') {
        { const translated = api.t(key, params); if (translated !== key) return translated; }
    }
    return formatString(fallback, params);
}

// The agent dialog's language row: the one language picker the welcome dialog uses too
// (renderLanguagePickerHtml / bindLanguageSegmented, js/user-management.js), on the current language.
function renderAgentLanguageSwitcher() {
    const i18nApi = getI18nApi();
    const currentLang = i18nApi && typeof i18nApi.getLanguage === 'function'
        ? i18nApi.getLanguage()
        : 'en';
    return window.renderLanguagePickerHtml(currentLang, 'agent-language-switcher');
}

/**
 * Show the agent dialog with detailed information
 * @param {string} agentId - The agent ID
 */
async function showAgentDialog(agentId, options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const readOnly = !!safeOptions.readOnly;
    const elevated = !!safeOptions.elevated;
    const onClose = typeof safeOptions.onClose === 'function' ? safeOptions.onClose : null;
    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
        window.CbDialog.alert(translateText('agentDialog.agentNotFound', 'Agent not found.'));
        return;
    }

    // Check if this is the current user's agent
    const isUserAgent = agent.userControlled === true;

    const walletScope = getCurrentAgentWalletScope();
    const walletState = window.walletManager ? window.walletManager.getState() : null;
    const walletConnected = walletState && walletState.status === 'connected' && walletState.accounts && walletState.accounts.length > 0;
    const walletAccounts = walletConnected ? (walletState.accounts || []) : [];
    const parcelScope = { includeTransient: isUserAgent };
    const ownedParcels = getAgentOwnedParcels(agentId, parcelScope);
    const portfolioBasis = getPortfolioValuationBasis();
    const parcelDetails = getAgentParcelDetails(agentId, parcelScope);
    const cachedLists = getAgentDialogCache(agentId);
    let portfolioValue = null;
    const createdProposals = window.AgentProposalLinks.locals(agent.proposalsCreated || []);
    const walletAddressesForDisplay = isUserAgent
        ? walletAccounts
        : (agent.walletAddresses || []);

    const initialEthBalanceDisplay = isUserAgent
        ? '-'
        : (Number.isFinite(agent.ethBalance) ? CbFormat.formatMoney(agent.ethBalance, 'ETH') : '-');
    const initialTotalWealthDisplay = '-';

    // Prefer the cached wallet parcels when available so the list does not rebuild on every open
    const usableCache = isUserAgent && window.AgentWalletScope.matches(cachedLists?.scope, walletScope) ? cachedLists : null;

    const initialParcels = usableCache && Array.isArray(usableCache.parcels) && usableCache.parcels.length
        ? cachedLists.parcels
        : parcelDetails;
    const languageSwitcherHtml = renderAgentLanguageSwitcher();

    const lensButtonTitle = translateText('modal.lens.triggerDescription', 'Lens for viewing the world');
    const labelEthBalance = translateText('agentDialog.ethBalance', 'ETH balance');
    const labelPortfolioValue = translateText('agentDialog.portfolioValue', 'Modeled land estimate (ETH)');
    const labelTotalWealth = translateText('agentDialog.totalWealth', 'Modeled total (ETH)');
    const portfolioBasisLabel = translateText('agentDialog.portfolioBasis',
        'Area-based land model: USD {{pricePerSqmUsd}}/m², converted at USD {{usdPerEth}}/ETH. Portfolio estimate and total are modeled ETH amounts.', portfolioBasis);
    const labelProposalsCreated = translateText('agentDialog.proposalsCreated', 'Proposals Created ({{count}})', { count: createdProposals.length });
    const labelOwnedParcels = translateText('agentDialog.ownedParcels', 'Linked parcels ({{count}})', { count: initialParcels.length });
    const parcelBasisKey = isUserAgent ? 'agentDialog.walletParcelsBasis' : 'agentDialog.localParcelsBasis';
    const parcelBasisLabel = translateText(parcelBasisKey, isUserAgent
        ? 'Local model assignments and parcel NFTs observed in the connected wallet; these do not establish registered land ownership.'
        : 'Parcels assigned to this agent in the local model.');
    const labelAgentLog = translateText('agentDialog.agentLog', 'Agent Log');
    const labelUser = translateText('agentDialog.userLabel', 'You');
    const labelLogout = translateText('agentDialog.logoutButton', 'Log Out');

    // The dialog wears the shared chrome (css/primitives.css cb-dialog): an overlay on the dialog rung
    // (the upper rung when it opens over another dialog, e.g. the activity explorer or the welcome
    // dialog's takeover preview) around a cb-dialog--lg card. agent-dialog-modal on the card and
    // agent-dialog-modal-close beside close-circle-btn are hooks for scripts and the e2e specs.
    const overlay = document.createElement('div');
    overlay.className = 'cb-dialog-overlay' + (elevated ? ' cb-dialog-overlay--top' : '');
    const modal = document.createElement('div');
    modal.className = 'cb-dialog cb-dialog--lg agent-dialog-modal';
    modal.dataset.portfolioUsdPerEth = String(portfolioBasis.usdPerEth);
    modal.dataset.agentId = agent.id;
    modal.__walletScope = walletScope;
    if (readOnly) {
        modal.classList.add('agent-dialog-readonly');
    }
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'agent-dialog-title');
    if (onClose) {
        modal.__onClose = onClose;
    }
    modal.innerHTML = `
            <div class="cb-dialog__header agent-dialog-modal-header">
                <div class="agent-header-main">
                    <div class="agent-header-top">
                        <div class="agent-avatar-stack">
                            <img src="${getAvatarImagePath(agent.avatarIndex)}" class="agent-avatar-large" alt="Agent Avatar">
                        </div>
                        <div class="agent-header-details">
                            <div class="agent-name-row">
                                <h2 id="agent-dialog-title" class="cb-dialog__title">${escapeHtml(agent.name)}</h2>
                                ${isUserAgent ? `<span class="cb-badge" data-i18n-key="agentDialog.userLabel">${labelUser}</span>` : ''}
                            </div>
                            ${isUserAgent ? `
                                <div class="agent-user-identity">
                                    <button class="btn btn-sm logout-button" type="button" onclick="showLogoutModal()" data-i18n-key="agentDialog.logoutButton">${labelLogout}</button>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    ${isUserAgent ? `
                        <div class="agent-header-bottom">
                            <button type="button" class="btn btn-icon btn-sm lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensButtonTitle}" aria-label="${lensButtonTitle}" data-i18n-key="modal.lens.triggerDescription" data-i18n-attr="title,aria-label">
                                <i class="fa-solid fa-glasses" aria-hidden="true"></i>
                            </button>
                            <div class="agent-wallet-actions">
                                <button class="btn btn-sm wallet-connect-button" type="button" onclick="handleWalletButtonClick()">${renderWalletButtonLabel()}</button>
                                <button type="button" class="btn btn-sm wallet-chain-info" role="button"></button>
                            </div>
                        </div>
                    ` : ''}
                </div>
                <button type="button" class="close-circle-btn agent-dialog-modal-close" aria-label="Close agent dialog" onclick="closeAgentDialog()" data-readonly-allow="true">&times;</button>
            </div>
            <div class="cb-dialog__body agent-dialog-modal-body">
                <div class="agent-stats-grid">
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.ethBalance">${labelEthBalance}</div>
                        <div class="stat-value" ${isUserAgent ? 'data-user-eth-balance' : ''}>${initialEthBalanceDisplay}</div>
                    </div>
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.portfolioValue">${labelPortfolioValue}</div>
                        <div class="stat-value" data-agent-portfolio-value>-</div>
                    </div>
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.totalWealth">${labelTotalWealth}</div>
                        <div class="stat-value" ${isUserAgent ? 'data-user-total-wealth' : ''} data-agent-total-wealth>${initialTotalWealthDisplay}</div>
                    </div>
                </div>
                <p class="stat-label" data-agent-portfolio-basis data-i18n-key="agentDialog.portfolioBasis" data-i18n-params='${JSON.stringify(portfolioBasis)}'>${portfolioBasisLabel}</p>
                <div class="info-section">
                    <h4 data-i18n-key="agentDialog.proposalsCreated" data-i18n-params='${JSON.stringify({ count: createdProposals.length })}'>${labelProposalsCreated}</h4>
                    <div class="parcels-list" data-list-type="created"></div>
                </div>
                <div class="info-section">
                        <h4 data-i18n-key="agentDialog.ownedParcels" data-i18n-params='${JSON.stringify({ count: initialParcels.length })}'>${labelOwnedParcels}</h4>
                    <p class="stat-label" data-agent-parcels-basis data-i18n-key="${parcelBasisKey}">${parcelBasisLabel}</p>
                    <div class="parcels-list" data-list-type="parcels"></div>
                </div>
                <div class="info-section">
                        <h4 data-i18n-key="agentDialog.agentLog">${labelAgentLog}</h4>
                    <div class="agent-log-container">
                        ${getAgentLogEntries(agent.id)}
                    </div>
                </div>
            </div>
            <div class="cb-dialog__footer agent-dialog-footer">
                ${languageSwitcherHtml}
            </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // The overlay is what stacks (its z-index is the dialog rung), so it is what Escape compares.
    modal.__unregisterEscape = window.ModalEscape?.register(overlay, closeAgentDialog);
    if (readOnly) {
        applyAgentDialogReadOnlyState(modal);
    }
    setupAgentDialogLanguageSwitcher(modal);
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
        window.i18n.applyTranslations(modal);
    }
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    if (typeof updateAgentDialogWalletButton === 'function') {
        updateAgentDialogWalletButton();
    }
    if (typeof updateAgentDialogChainInfo === 'function') {
        updateAgentDialogChainInfo();
    }

    // Kick off async portfolio calculation and update displays when ready
    if (typeof calculatePortfolioValue === 'function' && ownedParcels.length > 0) {
        (async () => {
            try {
                const value = await calculatePortfolioValue(ownedParcels, { forceRefresh: true, usdPerEth: portfolioBasis.usdPerEth });
                if (!modal.isConnected || (isUserAgent && window.AgentWalletScope.key(walletScope) !== window.AgentWalletScope.key(getCurrentAgentWalletScope()))) return;
                console.log('[AgentDialog] Portfolio calculation result:', value);
                portfolioValue = Number.isFinite(value) ? value : NaN;

                const portfolioNode = modal.querySelector('[data-agent-portfolio-value]');
                if (portfolioNode) {
                    portfolioNode.textContent = Number.isFinite(portfolioValue) ? CbFormat.formatMoney(portfolioValue, 'ETH') : '-';
                }

                const totalWealthNode = modal.querySelector('[data-agent-total-wealth]');
                if (totalWealthNode) {
                    totalWealthNode.setAttribute('data-portfolio-value', Number.isFinite(portfolioValue) ? portfolioValue : '');
                    if (isUserAgent) {
                        // Let wallet refresh logic combine with latest portfolio
                        if (typeof refreshUserEthBalanceDisplay === 'function') {
                            refreshUserEthBalanceDisplay();
                        } else if (typeof setUserTotalWealthDisplay === 'function') {
                            setUserTotalWealthDisplay(NaN);
                        }
                    } else {
                        const totalWealth = calculateModeledTotalEth(agent.ethBalance, portfolioValue);
                        totalWealthNode.textContent = Number.isFinite(totalWealth) ? CbFormat.formatMoney(totalWealth, 'ETH') : '-';
                    }
                }
            } catch (error) {
                console.warn('Failed to calculate portfolio value', error);
            }
        })();
    } else {
        console.log('[AgentDialog] Skipping initial portfolio calculation (no parcels yet)');
    }

    if (isUserAgent && typeof window.refreshUserEthBalanceDisplay === 'function') {
        window.refreshUserEthBalanceDisplay();
    }

    // Set up lazy loading for lists
    setupAgentDialogLazyLoading(agentId, initialParcels, createdProposals);

    // Trigger chain-backed loads (async) with spinners
    // Also re-run when wallet state changes so a later connect populates data
    loadAgentChainData(agent, isUserAgent);
    const cleanupFns = [];
    const reloadFn = () => {
        try {
            if (!isUserAgent || !modal.isConnected) return;
            const nextScope = getCurrentAgentWalletScope();
            if (window.AgentWalletScope.key(modal.__walletScope) !== window.AgentWalletScope.key(nextScope)) {
                modal.__walletScope = nextScope;
                const currentAgent = agentStorage.getAgent(agent.id) || agent;
                ensureAgentDialogListState(agent.id,
                    getAgentParcelDetails(agent.id),
                    window.AgentProposalLinks.locals(currentAgent.proposalsCreated || []));
                for (const type of ['parcels', 'created']) {
                    modal.querySelector(`[data-list-type="${type}"]`)?.replaceChildren();
                    setSectionCount(type, agentDialogListData[type].data.length);
                    renderFirstPageForList(type);
                }
                const valueNode = modal.querySelector('[data-agent-portfolio-value]');
                const totalNode = modal.querySelector('[data-agent-total-wealth]');
                if (valueNode) valueNode.textContent = '-';
                if (totalNode) {
                    totalNode.textContent = '-';
                    totalNode.setAttribute('data-portfolio-value', '');
                }
            }
            loadAgentChainData(agent, isUserAgent);
        } catch (err) {
            console.warn('[AgentDialog] wallet state listener failed', err);
        }
    };
    if (window.walletManager && typeof window.walletManager.on === 'function') {
        cleanupFns.push(window.walletManager.on('stateChanged', reloadFn));
    }
    if (window.solanaWalletManager && typeof window.solanaWalletManager.on === 'function') {
        cleanupFns.push(window.solanaWalletManager.on('stateChanged', reloadFn));
    }
    if (cleanupFns.length > 0) {
        // Clean up when modal closes
        const cleanup = () => {
            cleanupFns.forEach(dispose => {
                try { dispose(); } catch (_) { }
            });
            document.removeEventListener('agentDialogClosed', cleanup);
        };
        document.addEventListener('agentDialogClosed', cleanup);
    }

    // Set up click listeners for agent log links (similar to game log)
    setupAgentLogClickListeners();
}

function applyAgentDialogReadOnlyState(modal) {
    if (!modal) return;

    const interactiveSelectors = [
        'button',
        '[role="button"]',
        'a[href]',
        'input',
        'select',
        'textarea',
        '[onclick]',
        '[tabindex]'
    ];

    const interactive = modal.querySelectorAll(interactiveSelectors.join(','));
    interactive.forEach(element => {
        const allow = element.getAttribute && element.getAttribute('data-readonly-allow') === 'true';
        if (allow) {
            return; // keep close button active
        }

        if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(element.tagName)) {
            element.disabled = true;
        }

        if (element.tagName === 'A') {
            element.setAttribute('aria-disabled', 'true');
            element.tabIndex = -1;
        } else if (!element.hasAttribute('tabindex')) {
            element.tabIndex = -1;
        }

        element.classList.add('is-readonly-disabled');
        element.style.pointerEvents = 'none';
    });
}

// Wires the footer's language row (the shared picker, js/user-management.js). A change re-labels the
// wallet button and the network chip, whose text is translated in script.
function setupAgentDialogLanguageSwitcher(modal) {
    if (!modal) return;
    const switcher = modal.querySelector('[data-language-switcher]');
    if (!switcher) return;
    modal.__i18nCleanup = window.bindLanguageSegmented(switcher, () => {
        if (typeof updateAgentDialogWalletButton === 'function') {
            try { updateAgentDialogWalletButton(); } catch (_) { }
        }
        if (typeof updateAgentDialogChainInfo === 'function') {
            try { updateAgentDialogChainInfo(); } catch (_) { }
        }
    });
}

/**
 * Show a loader spinner inside a list container
 */
function setListLoading(listType, message = 'Loading from chain...') {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = `
            <div class="loader-spinner" role="status" aria-live="polite">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text">${message}</span>
            </div>
        `;
    }
}

function setListError(listType, message = 'Could not connect to chain') {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = `<div class="loader-spinner is-error">${message}</div>`;
    }
}

function resetList(listType) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = '';
    }
}

/**
 * Append items to a list container
 */
function appendListItems(listType, itemsHtml) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        // Remove empty-state if present
        const empty = listContainer.querySelector('.empty-list');
        if (empty) empty.remove();
        const loader = listContainer.querySelector('.loader-spinner');
        if (loader) loader.remove();
        listContainer.insertAdjacentHTML('beforeend', itemsHtml);
    }
}

/**
 * Render helpers
 */
function renderParcelListItem(parcelId) {
    return renderParcelItem({ id: parcelId, number: parcelId, proposalCount: 0 });
}

function getAgentProposalTypeLabel(proposal) {
    const defaultType = 'parcel';
    const typeKeyRaw = proposal
        ? (typeof getProposalDisplayType === 'function'
            ? getProposalDisplayType(proposal)
            : ((typeof normalizeProposalGoalKey === 'function' ? normalizeProposalGoalKey(proposal.goal) : (proposal.goal || defaultType))))
        : defaultType;
    const typeKey = typeof typeKeyRaw === 'string' ? typeKeyRaw.toLowerCase() : defaultType;

    // Prefer localized labels from i18n if available
    const typeKeyToI18n = {
        road: 'modal.roadWidth.proposalList.typeLabels.road',
        building: 'modal.roadWidth.proposalList.typeLabels.building',
        park: 'modal.roadWidth.proposalList.typeLabels.park',
        square: 'modal.roadWidth.proposalList.typeLabels.square',
        structure: 'modal.roadWidth.proposalList.typeLabels.structure',
        'parcel-layout': 'modal.roadWidth.proposalList.typeLabels.parcel-layout',
        parcel: 'modal.roadWidth.proposalList.typeLabels.parcel',
        other: 'modal.roadWidth.proposalList.typeLabels.other'
    };
    const i18nKey = typeKeyToI18n[typeKey];
    if (i18nKey) {
        const translated = translateText(i18nKey, '');
        if (translated && translated !== i18nKey) {
            return translated;
        }
    }

    if (typeof formatProposalTypeLabel === 'function') {
        return formatProposalTypeLabel(typeKey);
    }

    if (typeof PROPOSAL_TYPE_LABELS !== 'undefined' && PROPOSAL_TYPE_LABELS && PROPOSAL_TYPE_LABELS[typeKey]) {
        return PROPOSAL_TYPE_LABELS[typeKey];
    }

    return typeKey ? typeKey.charAt(0).toUpperCase() + typeKey.slice(1) : '';
}

function getAgentProposalTitle(proposal, fallbackId = '') {
    const fallbackTitle = fallbackId ? `Proposal ${fallbackId}` : 'Proposal';
    const candidates = [
        proposal && typeof proposal.title === 'string' ? proposal.title : null,
        proposal && typeof proposal.name === 'string' ? proposal.name : null,
        proposal && typeof proposal.blockName === 'string' ? proposal.blockName : null,
        proposal && proposal.structureProposal && typeof proposal.structureProposal.blockName === 'string' ? proposal.structureProposal.blockName : null,
        proposal && proposal.roadProposal && typeof proposal.roadProposal.name === 'string' ? proposal.roadProposal.name : null,
        proposal && typeof proposal.description === 'string' ? proposal.description : null
    ];

    const typeLabels = (typeof PROPOSAL_TYPE_LABELS !== 'undefined' && PROPOSAL_TYPE_LABELS)
        ? Object.values(PROPOSAL_TYPE_LABELS).map(v => String(v).toLowerCase())
        : ['road', 'building', 'park', 'square', 'structure', 'parcel layout', 'parcel', 'other'];

    let best = '';
    let bestScore = -Infinity;
    const seen = new Set();
    candidates.forEach(candidate => {
        const trimmed = candidate && String(candidate).trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        const lower = trimmed.toLowerCase();
        let score = trimmed.length;
        if (typeLabels.includes(lower)) {
            score -= 100; // heavily de-prioritise pure type labels
        }
        if (score > bestScore) {
            bestScore = score;
            best = trimmed;
        }
    });

    if (best) {
        return best;
    }

    return fallbackTitle;
}

// A proposal's rung on the lifecycle ladder as the shared badge (docs/design-language.md: Draft →
// Published → Executed), from the same derivation as the proposals list and the details panel
// (proposals/display-state.js), with its modifier (Cancelled, Expired…). proposal may be null (an
// unloaded record), and then no lifecycle rung is established.
function agentProposalLifecycleBadgeHtml(proposal) {
    const displayState = window.__proposalDisplayState;
    if (!proposal) return '';
    const state = displayState.of(proposal, { applied: false });
    const modifier = state.modifier && typeof getProposalLifecycleLabel === 'function'
        ? `<span class="cb-badge ${state.modifierTone}">${getProposalLifecycleLabel(state.modifier)}</span>`
        : '';
    return `<span class="cb-badge cb-badge--${state.rung}">${displayState.rungLabel(state.rung, translateText)}</span>${modifier}`;
}

// The proposal's type as a neutral badge beside the lifecycle one.
function agentProposalTypeBadgeHtml(typeLabel) {
    return typeLabel ? `<span class="cb-badge">${typeLabel}</span>` : '';
}

function renderProposalListItem(link) {
    return renderAgentProposalLink(link);
}

/**
 * Click handler for parcel items: close modal and select parcel
 */
function handleParcelClick(parcelId) {
    if (typeof focusOnParcel === 'function') {
        focusOnParcel(parcelId);
    } else if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
    } else {
        console.warn('No parcel focus function available');
    }
}

/**
 * Update section header counts
 */
function setSectionCount(sectionType, count, fallbackLabel = '') {
    const listContainer = document.querySelector(`[data-list-type="${sectionType}"]`);
    if (!listContainer) return;

    const section = listContainer.closest('.info-section');
    if (!section) return;

    const header = section.querySelector('h4');
    if (!header) return;

    // Remember the base label (without the count) so we can rebuild it reliably
    const baseLabel = header.getAttribute('data-base-label')
        || fallbackLabel
        || (header.textContent || '').replace(/\s*\(.*?\)\s*$/, '').trim();
    if (!header.getAttribute('data-base-label') && baseLabel) {
        header.setAttribute('data-base-label', baseLabel);
    }

    // Keep i18n params in sync so future translations reuse the updated count
    let params = {};
    const paramsRaw = header.getAttribute('data-i18n-params');
    if (paramsRaw) {
        try {
            params = JSON.parse(paramsRaw) || {};
        } catch (_) {
            params = {};
        }
    }
    params.count = count;
    header.setAttribute('data-i18n-params', JSON.stringify(params));

    const i18nKey = header.getAttribute('data-i18n-key');
    const fallbackText = baseLabel ? `${baseLabel} (${count})` : `${count}`;

    let newText = fallbackText;
    if (typeof translateText === 'function' && i18nKey) {
        try {
            newText = translateText(i18nKey, fallbackText, params) || fallbackText;
        } catch (_) {
            newText = fallbackText;
        }
    }

    header.textContent = newText;
}

/**
 * Load the connected wallet's parcel NFTs into the dialog's Linked parcels list: the ParcelNFT
 * program on Solana, else the EVM ParcelNFT contract of the wallet's chain (ChainDataLoader). Designs
 * are not minted, so the chain names no proposals here (plan-design-agreement.md, M3).
 */
async function loadAgentChainData(agent, isUserAgent) {
    // The loaders below observe the connected wallet, never another agent's wallet.
    if (!isUserAgent) return;
    const targetModal = document.querySelector('.agent-dialog-modal');
    if (!targetModal || targetModal.dataset.agentId !== agent.id) return;
    const walletScope = getCurrentAgentWalletScope();
    if (!walletScope) return;
    const useSolana = walletScope.chainId.startsWith('solana-');
    const solanaCluster = useSolana ? walletScope.chainId.slice(7) : null;

    if (useSolana) {
        if (!window.SolanaChainDataLoader || !window.solanaWeb3) {
            console.warn('Solana chain data loader not ready');
            return;
        }
    } else if (!window.ChainDataLoader || !window.ethers || !window.walletManager) {
        console.warn('Chain data loader not ready');
        return;
    } else if (!window.walletManager.getProvider?.()) {
        console.debug('No connected wallet; skipping chain load');
        return;
    }

    const walletAddress = walletScope.walletAddress;
    const chainId = walletScope.chainId;
    console.log('[AgentDialog] Loading wallet parcels', { walletAddress, chainId, useSolana });

    if (!agentDialogListData) {
        ensureAgentDialogListState(agent.id, [], []);
    }
    const targetList = agentDialogListData;
    const isCurrentProfile = () => targetModal.isConnected && agentDialogListData === targetList
        && window.AgentWalletScope.matches(walletScope, getCurrentAgentWalletScope());

    const cache = getAgentDialogCache(agent.id);
    const cacheFresh = window.AgentWalletScope.fresh(cache, walletScope, Date.now(), AGENT_DIALOG_CACHE_TTL_MS);

    const cacheKey = `${agent.id}:${chainId}:${walletAddress}`;
    const existingFetch = agentDialogFetchPromises.get(cacheKey);
    if (existingFetch && existingFetch.list === targetList) {
        console.log('[AgentDialog] Reusing in-flight chain fetch', { cacheKey });
        return existingFetch.promise;
    }
    if (cacheFresh) {
        console.log('[AgentDialog] Cache still fresh; skipping chain refetch', { cacheKey });
        return;
    }

    // The ParcelNFT program (Solana) or contract (EVM) of the wallet's chain.
    let parcelAddress = null;
    try {
        if (useSolana) {
            parcelAddress = await window.SolanaChainDataLoader.resolveProgramAddress(chainId, 'ParcelNFT');
            if (!parcelAddress && solanaCluster === 'devnet') {
                parcelAddress = await window.SolanaChainDataLoader.resolveProgramAddress('solana', 'ParcelNFT');
            }
        } else {
            parcelAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'ParcelNFT');
        }
    } catch (err) {
        console.warn('Failed to resolve the ParcelNFT address', err);
    }
    if (!isCurrentProfile()) return;
    if (!parcelAddress) {
        console.warn('Missing the ParcelNFT address for chain', chainId);
        return;
    }
    console.log('[AgentDialog] Resolved the ParcelNFT address', { parcelAddress, useSolana });

    // Only show the loader when there is nothing to show yet.
    if (!agentDialogListData.parcels || !agentDialogListData.parcels.data.length) {
        setListLoading('parcels');
    }

    const fetchPromise = (async () => {
        try {
            const parcels = useSolana
                ? await window.SolanaChainDataLoader.getParcelsFromChain(walletAddress, solanaCluster, parcelAddress)
                : await window.ChainDataLoader.getParcelsFromChain(walletAddress, chainId, parcelAddress);
            if (!isCurrentProfile()) return;

            const existingParcels = getAgentParcelDetails(agent.id, { includeTransient: false });
            replaceAgentDialogListData('parcels', Array.from(new Set([
                ...existingParcels.map(p => (p.id || p)), ...parcels.map(p => p.parcelId)
            ])));

            // Keep only this wallet response as chain evidence, including a successful empty result.
            agentWalletObservations[agent.id] = {
                scope: walletScope, contractAddress: parcelAddress,
                parcelIds: parcels.map(parcel => parcel.parcelId), fetchedAt: Date.now()
            };

            renderFirstPageForList('parcels');
            setSectionCount('parcels', agentDialogListData.parcels.data.length, 'Linked parcels');

            // Recompute portfolio value now that on-chain parcels are known
            if (typeof calculatePortfolioValue === 'function') {
                try {
                    const ownedNow = getAgentOwnedParcels(agent.id);
                    const displayedBasis = document.querySelector('.agent-dialog-modal')?.dataset.portfolioUsdPerEth;
                    const value = await calculatePortfolioValue(ownedNow, { forceRefresh: true, usdPerEth: Number(displayedBasis) });
                    if (!isCurrentProfile()) return;
                    const portfolioNode = targetModal.querySelector('[data-agent-portfolio-value]');
                    const totalWealthNode = targetModal.querySelector('[data-agent-total-wealth]');
                    const portfolioValue = Number.isFinite(value) ? value : NaN;
                    if (portfolioNode) {
                        portfolioNode.textContent = Number.isFinite(portfolioValue) ? CbFormat.formatMoney(portfolioValue, 'ETH') : '-';
                    }
                    if (totalWealthNode) {
                        totalWealthNode.setAttribute('data-portfolio-value', Number.isFinite(portfolioValue) ? portfolioValue : '');
                        // The wallet refresh below supplies the actual balance. Until then,
                        // do not combine this estimate with a simulated/stale agent balance.
                        totalWealthNode.textContent = '-';
                    }
                    if (typeof refreshUserEthBalanceDisplay === 'function') {
                        refreshUserEthBalanceDisplay();
                    }
                } catch (err) {
                    console.warn('Failed to recompute portfolio after chain load', err);
                }
            }

            // Persist the wallet's parcels for reuse while the dialog reopens.
            setAgentDialogCache(agent.id, {
                scope: walletScope,
                parcels: agentDialogListData.parcels.data.slice(),
                lastFetchedAt: Date.now()
            });
        } catch (err) {
            console.warn('[AgentDialog] Failed to load wallet parcels', err);
            if (!isCurrentProfile()) return;
            setListError('parcels', 'Could not connect to chain');
            throw err;
        }
    })();

    agentDialogFetchPromises.set(cacheKey, { list: targetList, promise: fetchPromise });
    try {
        await fetchPromise;
    } catch (error) {
        console.warn('Failed to load chain data for agent modal', error);
    } finally {
        if (agentDialogFetchPromises.get(cacheKey)?.promise === fetchPromise) {
            agentDialogFetchPromises.delete(cacheKey);
        }
    }
}

/**
 * Set up lazy loading for agent dialog lists
 */
const AGENT_DIALOG_PAGE_SIZES = {
    parcels: 50, // avoid loading hundreds of parcels at once
    created: 20
};

// Cache and in-memory state for agent dialog lists (persists while page is open)
const agentDialogCache = (typeof window !== 'undefined' && window.agentDialogCache) || {};
const AGENT_DIALOG_CACHE_TTL_MS = 60 * 1000; // reuse data for a short period before refetching
const agentDialogFetchPromises = new Map();
const agentWalletObservations = {};
if (typeof window !== 'undefined') {
    window.agentDialogCache = agentDialogCache;
    window.agentWalletObservations = agentWalletObservations;
}
let agentDialogListData = null;

function getAgentDialogCache(agentId) {
    if (!agentId) return null;
    return agentDialogCache[agentId] || null;
}

function setAgentDialogCache(agentId, data) {
    if (!agentId || !data) return;
    agentDialogCache[agentId] = data;
    if (typeof window !== 'undefined') {
        window.agentDialogCache = agentDialogCache;
    }
}

function normalizeParcelEntries(entries = []) {
    return entries
        .map(entry => {
            if (!entry) return null;
            if (typeof entry === 'string') {
                return { id: entry, number: entry, proposalCount: entry.proposalCount || 0 };
            }
            const id = entry.id || entry.parcelId || entry.parcel_id;
            if (!id) return null;
            return {
                id: id,
                number: entry.number || entry.parcelNumber || id,
                proposalCount: typeof entry.proposalCount === 'number' ? entry.proposalCount : 0
            };
        })
        .filter(Boolean);
}

function ensureAgentDialogListState(agentId, parcelDetails, createdProposals) {
    agentDialogListData = {
        parcels: { data: normalizeParcelEntries(parcelDetails), loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.parcels },
        created: { data: window.AgentProposalLinks.merge(createdProposals), loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.created }
    };
    if (typeof window !== 'undefined') {
        window.agentDialogListData = agentDialogListData;
    }
    // Only a completed chain fetch can write a fetched snapshot or advance its timestamp.
    return agentDialogListData;
}

function replaceAgentDialogListData(listType, newItems) {
    if (!agentDialogListData || !agentDialogListData[listType]) return false;
    const info = agentDialogListData[listType];
    info.data = listType === 'parcels' ? normalizeParcelEntries(newItems) : window.AgentProposalLinks.merge(newItems);
    info.loaded = 0;
    document.querySelector(`[data-list-type="${listType}"]`)?.replaceChildren();
    return true;
}

function renderFirstPageForList(listType) {
    if (!agentDialogListData || !agentDialogListData[listType]) return;
    const info = agentDialogListData[listType];
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        const loader = listContainer.querySelector('.loader-spinner');
        if (loader) {
            loader.remove();
        }
    }
    if (info.loaded === 0 && info.data.length > 0) {
        loadMoreItems(listType, info);
    }
}

function setupAgentDialogLazyLoading(agentId, parcelDetails, createdProposals) {
    const listData = ensureAgentDialogListState(agentId, parcelDetails, createdProposals);

    // Make sure section headers reflect the initial data sizes
    Object.keys(listData).forEach(listType => {
        setSectionCount(listType, listData[listType].data.length);
        renderFirstPageForList(listType);
    });
    // Set up scroll listeners for the modal body
    const modalBody = document.querySelector('.agent-dialog-modal-body');
    if (modalBody) {
        modalBody.addEventListener('scroll', () => {
            // Check current lists, including replacements after a wallet scope change.
            const currentLists = agentDialogListData;
            if (!currentLists) return;
            Object.keys(currentLists).forEach(listType => {
                const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
                if (listContainer && shouldLoadMore(modalBody, listContainer)) {
                    const listInfo = currentLists[listType];
                    if (listInfo.loaded < listInfo.data.length) {
                        loadMoreItems(listType, listInfo);
                    }
                }
            });
        });
    }
}

/**
 * Check if we should load more items for a list
 */
function shouldLoadMore(scrollContainer, listContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const listRect = listContainer.getBoundingClientRect();

    // Load more when the bottom of the list is within 200px of the visible area
    const threshold = 200;
    return (listRect.bottom - containerRect.bottom) < threshold;
}

/**
 * Load more items for a specific list
 */
function loadMoreItems(listType, listInfo) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (!listContainer || listInfo.data.length === 0) return;

    const startIndex = listInfo.loaded;
    const endIndex = Math.min(startIndex + listInfo.pageSize, listInfo.data.length);
    const items = listInfo.data.slice(startIndex, endIndex);

    // Render items based on list type
    let itemsHtml = '';
    items.forEach(item => {
        if (listType === 'parcels') {
            itemsHtml += renderParcelItem(item);
        } else if (listType === 'created') {
            itemsHtml += renderProposalItem(item);
        }
    });

    // Append new items to the list
    listContainer.insertAdjacentHTML('beforeend', itemsHtml);

    // Update loaded count
    listInfo.loaded = endIndex;
}

/**
 * Render a parcel item
 */
function renderParcelItem(parcel) {
    const parcelLabel = translateText('agentDialog.parcelLabel', 'Parcel {{number}}', { number: parcel.number });
    // The i18n plural lookup picks the form per language (Croatian has three), not a one/other guess.
    const countLabel = translateText('agentDialog.proposalCount', parcel.proposalCount === 1 ? '{{count}} proposal' : '{{count}} proposals', { count: parcel.proposalCount });
    const proposalBadge = parcel.proposalCount > 0
        ? `<span class="cb-badge">${countLabel}</span>`
        : '';
    return `<div class="proposal-item parcel-item" onclick="focusOnParcelFromAgent(${inlineJsArg(parcel.id)})">
        ${parcelLabel} ${proposalBadge}
    </div>`;
}

/**
 * Render a proposal item
 */
function renderProposalItem(link) {
    return renderAgentProposalLink(link);
}

function renderAgentProposalLink(link) {
    const proposal = window.AgentProposalLinks.resolve(link, getAgentProposalRecords());
    const linkData = escapeHtml(JSON.stringify(link));
    if (!proposal) {
        return `<div class="proposal-item agent-dialog-proposal-item" data-proposal-link="${linkData}">
            <span class="agent-dialog-proposal-primary">${escapeHtml(translateText('agentDialog.localProposalUnavailable', 'Local proposal record unavailable'))}</span>
            <span class="agent-dialog-proposal-meta">${escapeHtml(translateText('agentDialog.localProposalKey', 'Local ID {{id}}', { id: link.localProposalId }))}</span>
        </div>`;
    }
    const localId = String(proposal.proposalId);
    const proposalColor = typeof getProposalColor === 'function' ? getProposalColor(localId) : null;
    const colorStyle = proposalColor ? `style="--proposal-color: ${escapeHtml(proposalColor)}"` : '';
    const badge = agentProposalLifecycleBadgeHtml(proposal);
    const displayTitle = getAgentProposalTitle(proposal, localId);
    const localKeyLabel = translateText('agentDialog.localProposalKey', 'Local ID {{id}}', { id: localId });
    const typeBadge = agentProposalTypeBadgeHtml(escapeHtml(getAgentProposalTypeLabel(proposal)));
    return `<div class="proposal-item agent-dialog-proposal-item ${proposalColor ? 'has-color' : ''}" ${colorStyle}
        data-proposal-link="${linkData}" onclick="openAgentProposalLink(JSON.parse(this.dataset.proposalLink))">
        <span class="agent-dialog-proposal-primary">${escapeHtml(displayTitle)} (${escapeHtml(localKeyLabel)})</span>
        <span class="agent-dialog-proposal-meta">${typeBadge}${badge}</span>
    </div>`;
}

async function openAgentProposalLink(link) {
    const proposal = window.AgentProposalLinks.resolve(link, getAgentProposalRecords());
    if (!proposal) return;
    const localId = String(proposal.proposalId);
    closeAgentDialog();
    if (typeof selectAndHighlightProposal === 'function') {
        selectAndHighlightProposal(localId, proposal.cadastreParcelIds?.[0] || null, true);
    }
}

/**
 * Close the agent dialog: the card (.agent-dialog-modal) goes with the overlay around it.
 */
function closeAgentDialog() {
    const modal = document.querySelector('.agent-dialog-modal');
    if (modal) {
        const onClose = typeof modal.__onClose === 'function' ? modal.__onClose : null;
        modal.__unregisterEscape?.();
        if (typeof modal.__i18nCleanup === 'function') {
            try { modal.__i18nCleanup(); } catch (_) { }
        }
        (modal.closest('.cb-dialog-overlay') || modal).remove();
        if (onClose) {
            try {
                onClose();
            } catch (err) {
                console.warn('[AgentDialog] onClose handler failed', err);
            }
        }
    }
    // Notify listeners (e.g., to remove wallet event handlers)
    const evt = new CustomEvent('agentDialogClosed');
    document.dispatchEvent(evt);
}

/**
 * Focus map on a specific parcel
 * @param {string} parcelId - The parcel ID to focus on
 */
async function ensureParcelLoaded(parcelId) {
    const targetId = parcelId && parcelId.toString();
    if (!targetId) return null;

    const fabric = window.LiveParcelFabric;
    const presenter = window.ParcelPresenter;
    if (fabric?.get?.(targetId) && presenter?.getLayer?.(targetId)) return targetId;
    const ground = window.CadastralParcelRepository;
    if (!ground || typeof ground.ensureIds !== 'function') return null;
    try {
        await ground.ensureIds([targetId]);
        const layer = presenter?.resolveLiveLayers?.([targetId], { includeCorridors: false })?.[0] || null;
        return layer ? presenter?.getIdForLayer?.(layer) || null : null;
    } catch (error) {
        console.warn('Failed to load parcel before focusing', targetId, error);
    }
    return false;
}

async function focusOnParcel(parcelId) {
    const liveParcelId = await ensureParcelLoaded(parcelId);
    if (!liveParcelId) {
        console.warn('Parcel could not be loaded for focus', parcelId);
        return;
    }
    if (typeof selectParcel === 'function') {
        selectParcel(liveParcelId);
        closeAgentDialog();
    }
}

/**
 * Focus map on a specific proposal
 * @param {string} proposalId - The proposal id to focus on
 */
function focusOnProposal(proposalId) {
    closeAgentDialog();

    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalId);
        const parcels = Array.isArray(proposal?.cadastreParcelIds)
            ? proposal.cadastreParcelIds
            : [];
        if (proposal && parcels.length > 0) {
            selectAndHighlightProposal(proposalId, parcels[0], true);
        }
    } else if (typeof centerOnProposal === 'function') {
        // Fallback to old function
        centerOnProposal(proposalId);
    }
}

/**
 * Recent activity by or involving one agent, rendered with the shared activity row.
 * @param {string} agentId - The agent ID to filter for
 * @returns {string} HTML string of filtered log entries
 */
function getAgentLogEntries(agentId) {
    const events = typeof allActivityEvents === 'function' ? allActivityEvents() : [];
    const agentEvents = window.ActorExplorer.eventsInvolvingActor(events, agentId);
    if (agentEvents.length === 0) {
        return '<div class="empty-log">No activities recorded for this agent yet.</div>';
    }

    // Return the last 20 entries (most recent first)
    const recentEntries = agentEvents.slice(-20).reverse();
    return `
        <div class="agent-log-content">
            ${recentEntries.map(event => window.ActorExplorer.activityRowHtml(event, { translate: translateGameText })).join('')}
            ${agentEvents.length > 20 ? `<div class="agent-log-more">... and ${agentEvents.length - 20} older entries</div>` : ''}
        </div>
    `;
}

/**
 * Setup click listeners for clickable links in agent log
 */
function setupAgentLogClickListeners() {
    // Handle agent links in agent log
    document.querySelectorAll('.agent-log-content .agent-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const agentId = this.getAttribute('data-agent-id');
            if (agentId) {
                // Close current dialog first, then open new one
                closeAgentDialog();
                setTimeout(() => showAgentDialog(agentId), 100);
            }
        });
    });

    // Handle proposal links in agent log
    document.querySelectorAll('.agent-log-content .proposal-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const proposalIdOrHash = this.getAttribute('data-proposal-id') || this.getAttribute('data-proposal-hash');
            if (proposalIdOrHash && typeof showProposalFromLog === 'function') {
                showProposalFromLog(proposalIdOrHash);
            }
        });
    });

    // Handle parcel links in agent log
    document.querySelectorAll('.agent-log-content .parcel-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const parcelId = this.getAttribute('data-parcel-id');
            if (parcelId && typeof showParcelFromLog === 'function') {
                showParcelFromLog(parcelId);
            }
        });
    });
}

/**
 * Get the number of proposals affecting a specific parcel
 * @param {string} parcelId - The parcel ID
 * @returns {number} - Number of proposals affecting this parcel
 */
function getParcelProposalCount(parcelId) {
    if (typeof proposalStorage === 'undefined') {
        return 0;
    }

    const proposals = proposalStorage.getProposalsForParcel(parcelId);
    return proposals.length;
}

/**
 * Get parcel details with proposal counts for an agent
 * @param {string} agentId - The agent ID
 * @returns {Array} - Array of parcel objects with proposal counts
 */
function getAgentParcelDetails(agentId, options = {}) {
    const ownedParcels = getAgentOwnedParcels(agentId, options);

    const parcelDetails = ownedParcels.map(parcelId => {
        const proposalCount = getParcelProposalCount(parcelId);

        // Read parcel metadata from the committed fabric.
        let parcelNumber = parcelId;
        const feature = window.LiveParcelFabric?.get?.(String(parcelId));
        if (feature?.properties?.BROJ_CESTICE) parcelNumber = feature.properties.BROJ_CESTICE;

        return {
            id: parcelId,
            number: parcelNumber,
            proposalCount: proposalCount
        };
    });

    // Sort by proposal count descending, then by parcel number ascending
    parcelDetails.sort((a, b) => {
        if (b.proposalCount !== a.proposalCount) {
            return b.proposalCount - a.proposalCount;
        }
        return a.number - b.number;
    });

    return parcelDetails;
}

/**
 * Handle clicking on a parcel in the Agent Details dialog
 * @param {string} parcelId - The parcel ID to focus on
 */
async function focusOnParcelFromAgent(parcelId) {
    // Close the agent dialog first
    // Wait to close until we've confirmed the parcel is available
    const liveParcelId = await ensureParcelLoaded(parcelId);
    if (!liveParcelId) {
        console.warn('Parcel not available for focusing from agent dialog', parcelId);
        return;
    }
    closeAgentDialog();

    // Exit show proposals mode to allow normal parcel selection
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        // Trigger the change event to update the proposal layer
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    if (typeof selectParcel === 'function') selectParcel(liveParcelId);
}

function initialiseAgentStorage() {
    agentStorage.load();
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseAgentStorage);
} else {
    initialiseAgentStorage();
}

// Make functions available globally
window.agentStorage = agentStorage;
window.createAgent = createAgent;
window.generateAgentName = generateAgentName;
window.getAvatarImagePath = getAvatarImagePath;
window.getAgentOwnedParcels = getAgentOwnedParcels;
window.buildAgentOwnedParcelIndex = buildAgentOwnedParcelIndex;
window.updateAgentOwnedParcels = updateAgentOwnedParcels;
window.transferParcelOwnership = transferParcelOwnership;
window.getOrCreateJointPoolAgent = getOrCreateJointPoolAgent;
window.agentDecideAction = agentDecideAction;
window.executeAgentAction = executeAgentAction;
window.showAgentDialog = showAgentDialog;
window.closeAgentDialog = closeAgentDialog;
window.focusOnParcel = focusOnParcel;
window.focusOnProposal = focusOnProposal;
window.getAgentLogEntries = getAgentLogEntries;
window.setupAgentLogClickListeners = setupAgentLogClickListeners;
window.getParcelProposalCount = getParcelProposalCount;
window.getAgentParcelDetails = getAgentParcelDetails;
window.focusOnParcelFromAgent = focusOnParcelFromAgent;
window.findContiguousParcels = findContiguousParcels;
window.buildTurnParcelPool = buildTurnParcelPool;
window.buildAgentNeighborMap = buildAgentNeighborMap;
window.isRoadLikeParcel = isRoadLikeParcel;
window.isStructureDescendantParcel = isStructureDescendantParcel;
