// Guest rules: what a visitor without a profile name, a wallet or an ownership attestation may do.
// One table, consulted by every gate (publish, share link, mint, Offer my land); see next-steps.md.
//
//   none            Stays on this device: create, edit, fork, apply, compare.
//   name            Leaves the device and carries an author: publish/upload, share link, mint,
//                   joining a public list. A guest is asked to choose a profile name.
//   ownership-proof Asserts ownership (Offer my land / owner offer): a connected wallet that a lens
//                   member attested as owner of the parcels. A name alone is not enough; the offer is
//                   also published, so the name is required as well.
//
// Also decides which author an outgoing record carries (claimAuthorAgentId / outgoingAuthor below).
//
// Pure: no DOM. Browser global `window.GuestPolicy`; CommonJS in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GuestPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const RULES = Object.freeze({
        create: 'none',
        edit: 'none',
        fork: 'none',
        apply: 'none',
        compare: 'none',
        publish: 'name',
        share: 'name',
        mint: 'name',
        joinList: 'name',
        ownerOffer: 'ownership-proof'
    });

    function requires(action) {
        if (!Object.prototype.hasOwnProperty.call(RULES, action)) {
            throw new Error(`GuestPolicy: unknown action "${action}"`);
        }
        return RULES[action];
    }

    // state: { isGuest, walletConnected, ownershipAttested }. A missing fact counts as unmet (an
    // unknown profile is a guest), never as a guess that it holds.
    // -> what is missing, in the order the user should fix it: 'wallet', 'attestation', 'name'.
    function missing(action, state) {
        const requirement = requires(action);
        const s = state || {};
        const out = [];
        if (requirement === 'none') return out;
        if (requirement === 'ownership-proof') {
            if (s.walletConnected !== true) out.push('wallet');
            if (s.ownershipAttested !== true) out.push('attestation');
        }
        if (s.isGuest !== false) out.push('name');
        return out;
    }

    function check(action, state) {
        const gaps = missing(action, state);
        return { action, requirement: requires(action), missing: gaps, allowed: gaps.length === 0 };
    }

    // ---- the author an outgoing record carries ----
    //
    // A guest profile is the same profile before it has a name: choosing a name renames the agent
    // in place (same agent id). So a record this profile created as "Guest 4232" is the profile's
    // own record, and when it leaves the device it must carry the name the profile has NOW, or the
    // name gate above is defeated by a record that publishes its old guest alias.
    //
    // Ownership is the agent id stamped at creation (`authorAgentId`), never a name guess at publish:
    //   - claimAuthorAgentId: a new record whose author is the current profile's name belongs to
    //     that profile. Records by other agents (AI agents, imports of other people's records) carry
    //     another name and stay unclaimed.
    //   - outgoingAuthor: a record that has never left the device (not published, not minted) and
    //     belongs to the current profile carries the profile's current name. A published or minted
    //     record is immutable and keeps its author; so does a record of another agent, or one made
    //     before authorAgentId existed (it has no proof whose it is).
    // Lineage: a fork or an edit is a new record created by whoever forks it, so it is claimed by the
    // current profile and carries its name; the source keeps its own author, reached through
    // sourceProposalId. Author names are never inherited along a fork.

    function identityOf(agent) {
        if (!agent || agent.id === undefined || agent.id === null || agent.id === '') return null;
        const name = typeof agent.name === 'string' ? agent.name.trim() : '';
        return name ? { id: String(agent.id), name } : null;
    }

    // -> the agent id to stamp on a record being created, or null (leave it unclaimed).
    function claimAuthorAgentId(record, agent) {
        if (!record || typeof record !== 'object') return null;
        if (record.authorAgentId !== undefined && record.authorAgentId !== null && record.authorAgentId !== '') {
            return String(record.authorAgentId);
        }
        const identity = identityOf(agent);
        if (!identity) return null;
        const author = typeof record.author === 'string' ? record.author.trim() : '';
        return author === identity.name ? identity.id : null;
    }

    // options.immutable: the record has left the device (published or minted).
    // -> { author, restamped, reason } where reason is why the author was kept:
    //    'immutable' | 'no-profile' | 'unclaimed' | 'other-profile' | null when it is the profile's.
    function outgoingAuthor(record, agent, options) {
        const current = record && typeof record.author === 'string' ? record.author : (record && record.author) || '';
        const keep = reason => ({ author: current, restamped: false, reason });
        if (!record || typeof record !== 'object') return keep('unclaimed');
        if (options && options.immutable === true) return keep('immutable');
        const identity = identityOf(agent);
        if (!identity) return keep('no-profile');
        const owner = record.authorAgentId;
        if (owner === undefined || owner === null || owner === '') return keep('unclaimed');
        if (String(owner) !== identity.id) return keep('other-profile');
        return { author: identity.name, restamped: current !== identity.name, reason: null };
    }

    return { RULES, requires, missing, check, claimAuthorAgentId, outgoingAuthor };
});
