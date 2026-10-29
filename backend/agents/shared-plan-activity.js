// Activity is ephemeral in the MCP worker; accepted content and authority always come from storage.
export function withSharedPlanActivity(store) {
    const activities = new Map(), listeners = new Map();
    const notify = id => { for (const fn of listeners.get(id) || []) { try { fn(); } catch {} } };
    return {
        ...store,
        async eventState(id, capability) {
            const state = await store.eventState(id, capability), pending = activities.get(id);
            return { ...state, activity: { agentEditing: state.controller === 'agent' && pending?.version === state.version && pending.markers.size > 0 } };
        },
        async subscribe(id, capability, listener, onError) {
            const off = await store.subscribe(id, capability, listener, onError);
            const set = listeners.get(id) || new Set(); set.add(listener); listeners.set(id, set);
            return () => { off(); set.delete(listener); if (!set.size) listeners.delete(id); };
        },
        async beginActivity(id, capability, expectedVersion) {
            const current = await store.assertEditable(id, capability, expectedVersion);
            if (current.controller !== 'agent') return () => {};
            let pending = activities.get(id);
            if (!pending || pending.version !== expectedVersion) { pending = { version: expectedVersion, markers: new Set() }; activities.set(id, pending); }
            const marker = Symbol(); pending.markers.add(marker); notify(id);
            return () => {
                if (activities.get(id) === pending && pending.markers.delete(marker)) {
                    if (!pending.markers.size) activities.delete(id);
                    notify(id);
                }
            };
        },
        async dispose() { listeners.clear(); activities.clear(); await store.dispose(); }
    };
}
