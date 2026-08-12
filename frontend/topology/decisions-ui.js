// The guided pass through the junctions the rules could not settle.
//
// What this replaces: a warning marker you could click to get a JSON dump reading
// `receiving_lane_undetermined`, an inspector with no controls in it, and a hint about hovering
// lanes that had nothing to do with the obstacle in front of you. The manager could state that a
// junction was unresolved and offered no way to resolve it, so the only honest thing to do at that
// point was close the tab.
//
// The flow here is: a queue of the open approaches in view, hardest first; picking one flies the
// map to it, letters each arm and numbers each arriving lane on the map itself; the card asks one
// question — which arms may each lane use — pre-filled with whatever OSM already says; saving
// stores the answer against the junction and moves to the next one.
//
// The map drawing and the card are deliberately the same vocabulary: arm B on the map is the button
// marked B in the card. Everything decided about WHAT to ask lives in lane-topology-decisions.js,
// which is pure and tested; this file is the wiring.
(function (root) {
    'use strict';

    // Enough to letter every arm of a junction the rules will even look at (six).
    const ARM_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const ARM_COLORS = ['#e8743b', '#4bb3d4', '#8bc24a', '#c471d4', '#e8c33b', '#4be0b0', '#d44b7a', '#7a8cff'];
    const APPROACH_COLOR = '#ffffff';
    const FOCUS_ZOOM = 19;

    function decisionsModule() {
        const api = root.LaneTopologyDecisions;
        if (!api) throw new Error('The decision queue needs lane-topology-decisions.js to be loaded first.');
        return api;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    function latLngs(geometry) {
        return (geometry?.coordinates || []).map(point => [point[1], point[0]]);
    }

    // A short run of the lane nearest the junction. Drawing a whole 200 m arm to show which arm is
    // meant buries the junction it is meant to point at.
    function stubTowards(coordinates, atNode, metres = 35) {
        const points = atNode ? [...coordinates].reverse() : coordinates.slice();
        const out = [points[0]];
        let span = 0;
        for (let index = 1; index < points.length; index += 1) {
            const [aLng, aLat] = points[index - 1];
            const [bLng, bLat] = points[index];
            const meanLat = (aLat + bLat) * Math.PI / 360;
            span += Math.hypot((bLng - aLng) * 111320 * Math.cos(meanLat), (bLat - aLat) * 110540);
            out.push(points[index]);
            if (span >= metres) break;
        }
        return out;
    }

    function badge(className, text) {
        return L.divIcon({
            className: '',
            html: `<span class="${className}">${escapeHtml(text)}</span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        });
    }

    function createDecisionsUi(options) {
        const { map, api, element, showToast, getGraph, onSaved } = options;
        // Just the focus highlight: it belongs to the question being asked and goes when the card
        // closes. The ANSWERS are not drawn here — they are connections in the derived graph now,
        // so the derived layer draws them, once, in the colour it reserves for a human decision.
        const layer = L.layerGroup().addTo(map);
        const state = {
            decisions: [],
            stored: new Map(),      // decisionKey -> the saved record
            current: null,          // the decision being answered
            assignment: {},         // laneId -> [exit sectionId]
            received: {},           // "laneOrdinal->exitWayId" -> receiving lane ordinal
            saving: false
        };

        // ---- data -------------------------------------------------------------------------

        async function loadStored(bbox) {
            try {
                const body = await api(`/lane-topology/decisions?city=zagreb&bbox=${bbox}`);
                state.stored = new Map((body.decisions || []).map(row => [row.decisionKey, row]));
            } catch (error) {
                // Loud, because a queue that has quietly forgotten the answers already given will
                // walk someone through the same junctions a second time.
                showToast(`Saved decisions could not be loaded: ${error.message}`, true);
                state.stored = new Map();
            }
        }

        function rebuildQueue() {
            const graph = getGraph();
            if (!graph) { state.decisions = []; return; }
            // Answered approaches are no longer open — the builder folded them in — so they come
            // from what it reported applying, not from the queue. They stay in the list, marked,
            // so the pass is reviewable and a mistake can be reopened and corrected.
            const answered = graph.decisions?.answered || [];
            state.decisions = [...decisionsModule().openDecisions(graph), ...answered];
        }

        // Fetching is separate from rendering because the derivation needs the stored answers
        // BEFORE it runs — they are inputs to the graph now, not an overlay on it — and the queue
        // needs the graph that results. Doing both in one call put them in the wrong order and the
        // first derivation of every viewport silently ignored every answer.
        async function refresh(bbox) {
            if (bbox) await loadStored(bbox);
            rebuildQueue();
            if (state.current) {
                const stillOpen = state.decisions.find(decision => decision.id === state.current.id);
                if (!stillOpen) { close(); return; }
                state.current = stillOpen;
            }
            renderQueue();
            renderCard();
        }

        // ---- queue ------------------------------------------------------------------------

        function answerable() {
            return state.decisions.filter(decision => decision.kind === 'lane_exits');
        }

        function pending() {
            return answerable().filter(decision => !decision.answered);
        }

        function renderQueue() {
            const list = element('decision-list');
            const summary = element('decision-summary');
            if (!list || !summary) return;
            const open = answerable();
            const done = open.filter(decision => decision.answered).length;
            const blocked = state.decisions.filter(decision => decision.kind !== 'lane_exits');

            summary.textContent = open.length
                ? `${done} of ${open.length} answered in this view`
                : (state.decisions.length ? 'nothing here can be answered by hand' : 'nothing open in this view');
            const bar = element('decision-progress');
            if (bar) bar.style.setProperty('--progress', open.length ? `${(done / open.length) * 100}%` : '0%');

            const next = element('decision-start');
            if (next) {
                const remaining = pending().length;
                next.disabled = !remaining;
                next.textContent = remaining
                    ? (done ? `Next of ${remaining} left` : `Start · ${remaining} to decide`)
                    : (open.length ? 'All answered here' : 'Nothing to decide here');
            }

            if (!state.decisions.length) {
                list.innerHTML = '<div class="empty-state">Pan or zoom to an area with unresolved junctions.</div>';
                return;
            }
            const rows = open.map(decision => {
                const active = state.current?.id === decision.id;
                return `<button type="button" class="decision-row${active ? ' decision-row--active' : ''}`
                    + `${decision.answered ? ' decision-row--done' : ''}" data-decision="${escapeHtml(decision.id)}">
                        <span class="decision-row__mark">${decision.answered ? '✓' : decision.laneCount}</span>
                        <span class="decision-row__text">
                            <b>${escapeHtml(decision.approach.name || 'unnamed road')}</b>
                            <small>${decision.laneCount} lane${decision.laneCount === 1 ? '' : 's'} in ·
                                ${decision.exitCount} way${decision.exitCount === 1 ? '' : 's'} out ·
                                ${escapeHtml(decision.reason.replaceAll('_', ' '))}</small>
                        </span>
                    </button>`;
            }).join('');
            const blockedRows = blocked.length
                ? `<div class="decision-blocked">
                        <b>${blocked.length} not answerable here</b>
                        ${blocked.map(decision => `<small>${escapeHtml(decision.prompt)} ·
                            ${escapeHtml(decision.approach.name || decision.nodeId)}</small>`).join('')}
                   </div>`
                : '';
            list.innerHTML = rows + blockedRows;
            list.querySelectorAll('[data-decision]').forEach(button => {
                button.addEventListener('click', () => focusById(button.dataset.decision));
            });
        }

        // ---- map --------------------------------------------------------------------------

        function paintFocus(decision) {
            layer.clearLayers();
            if (!decision) return;
            const graph = getGraph();
            if (!graph) return;
            const laneById = new Map((graph.lanes || []).map(lane => [lane.id, lane]));

            decision.approach.lanes.forEach(lane => {
                const record = laneById.get(lane.id);
                if (!record) return;
                const stub = stubTowards(record.geometry.coordinates, true);
                L.polyline(latLngs({ coordinates: stub }), {
                    pane: 'topology-problems',
                    color: APPROACH_COLOR,
                    weight: 5,
                    opacity: .85,
                    interactive: false
                }).addTo(layer);
                L.marker(latLngs({ coordinates: stub })[0], {
                    pane: 'topology-problems',
                    icon: badge('decision-badge decision-badge--lane', String(lane.ordinal + 1)),
                    interactive: false
                }).addTo(layer);
            });

            decision.exits.forEach((exit, index) => {
                const colour = ARM_COLORS[index % ARM_COLORS.length];
                const first = laneById.get(exit.lanes[0]?.id);
                if (!first) return;
                exit.lanes.forEach(exitLane => {
                    const record = laneById.get(exitLane.id);
                    if (!record) return;
                    L.polyline(latLngs({ coordinates: stubTowards(record.geometry.coordinates, false) }), {
                        pane: 'topology-problems',
                        color: colour,
                        weight: 4,
                        opacity: .8,
                        interactive: false
                    }).addTo(layer);
                });
                const stub = stubTowards(first.geometry.coordinates, false);
                L.marker(latLngs({ coordinates: stub }).at(-1), {
                    pane: 'topology-problems',
                    icon: badge('decision-badge decision-badge--arm', ARM_LETTERS[index] || '?'),
                    interactive: false
                }).addTo(layer);
            });

            if (Array.isArray(decision.point)) {
                L.circleMarker([decision.point[1], decision.point[0]], {
                    pane: 'topology-problems',
                    radius: 8,
                    color: '#ffffff',
                    weight: 2,
                    fillOpacity: 0,
                    interactive: false
                }).addTo(layer);
            }
        }

        // ---- card -------------------------------------------------------------------------

        function laneRow(decision, lane) {
            const chosen = state.assignment[lane.id] || [];
            const buttons = decision.exits.map((exit, index) => {
                const on = chosen.includes(exit.sectionId);
                return `<button type="button" class="arm-chip${on ? ' arm-chip--on' : ''}"
                    style="--arm: ${ARM_COLORS[index % ARM_COLORS.length]}"
                    data-lane="${escapeHtml(lane.id)}" data-exit="${escapeHtml(exit.sectionId)}"
                    aria-pressed="${on}" title="${escapeHtml(exit.label)}">${ARM_LETTERS[index] || '?'}</button>`;
            }).join('');
            const kind = lane.type === 'driving' ? '' : ` · ${escapeHtml(lane.type)}`;
            return `<div class="lane-row">
                <span class="lane-row__name"><b>${lane.ordinal + 1}</b>
                    <small>${escapeHtml(lane.side)}${kind}</small></span>
                <span class="lane-row__arms">${buttons}</span>
            </div>`;
        }

        // The question the old card could not ask. A one-lane on-ramp meeting a three-lane trunk
        // has one arriving lane and one arm, so the lane-to-arm question was already answered and
        // the card looked empty — while the real ambiguity, which of the three lanes it enters,
        // had no control at all and Save wrote a guess.
        function receivingRows(decision) {
            const questions = decisionsModule().openReceivingChoices(decision, state.assignment, getGraph());
            if (!questions.length) return '';
            const rows = questions.map(question => {
                const picked = state.received[question.key];
                const buttons = question.candidates.map(candidate => `
                    <button type="button" class="arm-chip arm-chip--lane${picked === candidate.ordinal ? ' arm-chip--on' : ''}"
                        data-receive="${escapeHtml(question.key)}" data-ordinal="${candidate.ordinal}"
                        aria-pressed="${picked === candidate.ordinal}"
                        title="${escapeHtml(candidate.side)}">${candidate.ordinal + 1}</button>`).join('');
                return `<div class="lane-row">
                    <span class="lane-row__name"><b>${question.laneOrdinal + 1}</b>
                        <small>into ${escapeHtml(question.exit.label.toLowerCase())}</small></span>
                    <span class="lane-row__arms">${buttons}</span>
                </div>`;
            }).join('');
            const undecided = questions.filter(question => !Number.isInteger(state.received[question.key])).length;
            return `<div class="decision-card__sub">
                    <h4>Which lane of the arm does it enter?</h4>
                    <p>Lane 1 is the leftmost of the receiving arm.${undecided
                        ? ' Unanswered ones are paired by side, and marked as assumed.' : ''}</p>
                    ${rows}
                </div>`;
        }

        function renderCard() {
            const card = element('decision-card');
            if (!card) return;
            const decision = state.current;
            if (!decision) {
                card.hidden = true;
                return;
            }
            card.hidden = false;
            const queue = answerable();
            const position = queue.findIndex(entry => entry.id === decision.id) + 1;
            const notes = decisionsModule().validate(decision, state.assignment);
            const blocking = notes.filter(note => !note.startsWith('NOTE:'));
            const advisory = notes.filter(note => note.startsWith('NOTE:'));

            card.innerHTML = `
                <div class="decision-card__head">
                    <span class="decision-card__step">Decision ${position || '—'} of ${queue.length}</span>
                    <button type="button" class="decision-card__close" id="decision-close"
                        aria-label="Close">×</button>
                </div>
                <h3>${escapeHtml(decision.approach.name || 'Unnamed road')}</h3>
                <p class="decision-card__prompt">${escapeHtml(decision.prompt)}</p>
                <p class="decision-card__why">${escapeHtml(decision.why)}</p>
                <div class="decision-card__lanes">
                    ${decision.approach.lanes.map(lane => laneRow(decision, lane)).join('')}
                </div>
                ${receivingRows(decision)}
                <div class="decision-card__legend">
                    ${decision.exits.map((exit, index) => `<span>
                        <i style="background:${ARM_COLORS[index % ARM_COLORS.length]}">${ARM_LETTERS[index] || '?'}</i>
                        ${escapeHtml(exit.label)}${exit.forked ? ' <em>(fork)</em>' : ''}
                    </span>`).join('')}
                </div>
                ${blocking.length
                    ? `<div class="decision-card__warn">${blocking.map(escapeHtml).join('<br>')}</div>` : ''}
                ${advisory.length
                    ? `<div class="decision-card__note">${advisory
                        .map(note => escapeHtml(note.replace(/^NOTE:\s*/, ''))).join('<br>')}</div>` : ''}
                ${decision.answered ? '<div class="decision-card__saved">Answered already — saving replaces it.</div>' : ''}
                <div class="decision-card__actions">
                    <button type="button" class="button button--tiny" id="decision-skip">Skip</button>
                    <button type="button" class="button button--primary" id="decision-save"
                        ${blocking.length || state.saving ? 'disabled' : ''}>
                        ${state.saving ? 'Saving…' : 'Save &amp; next'}</button>
                </div>`;

            card.querySelectorAll('[data-lane]').forEach(button => {
                button.addEventListener('click', () => toggle(button.dataset.lane, button.dataset.exit));
            });
            card.querySelectorAll('[data-receive]').forEach(button => {
                button.addEventListener('click', () => {
                    const key = button.dataset.receive;
                    const ordinal = Number(button.dataset.ordinal);
                    // Tapping the chosen one again clears it, back to the rule's own pairing.
                    if (state.received[key] === ordinal) delete state.received[key];
                    else state.received[key] = ordinal;
                    renderCard();
                });
            });
            element('decision-close').addEventListener('click', close);
            element('decision-skip').addEventListener('click', () => advance(true));
            element('decision-save').addEventListener('click', save);
        }

        function toggle(laneId, exitSectionId) {
            const chosen = new Set(state.assignment[laneId] || []);
            if (chosen.has(exitSectionId)) chosen.delete(exitSectionId);
            else chosen.add(exitSectionId);
            // Kept in the arms' own order, so the movements come out left to right like the lanes.
            const order = state.current.exits.map(exit => exit.sectionId);
            state.assignment[laneId] = order.filter(sectionId => chosen.has(sectionId));
            renderCard();
        }

        // ---- moving through the queue -----------------------------------------------------

        function openDecision(decision) {
            state.current = decision;
            const module = decisionsModule();
            const saved = state.stored.get(decision.id);
            state.received = {};
            if (decision.assignment) {
                // Already folded into the graph; the builder resolved it against today's lanes.
                state.assignment = decision.assignment;
                state.received = { ...(saved?.assignment?.received || {}) };
            } else if (saved) {
                // An answer given before may have been given against a junction that has since
                // changed shape; `missing` is how that says so instead of silently half-applying.
                const { assignment, missing, received } = module.fromStoredAssignment(decision, saved.assignment);
                state.assignment = assignment;
                state.received = received;
                if (missing.length) showToast(`This junction changed since it was answered: ${missing[0]}`, true);
            } else {
                state.assignment = module.suggestAssignment(decision);
            }
            if (Array.isArray(decision.point)) {
                map.setView([decision.point[1], decision.point[0]], Math.max(map.getZoom(), FOCUS_ZOOM), {
                    // A pan the map animates is a pan an agent-driven browser never finishes, and
                    // there is nothing to watch here anyway — the card is the point, not the flight.
                    animate: false
                });
            }
            paintFocus(decision);
            renderQueue();
            renderCard();
        }

        function focusById(id) {
            const decision = state.decisions.find(entry => entry.id === id);
            if (!decision) return;
            if (decision.kind !== 'lane_exits') {
                showToast(`${decision.prompt}. ${decision.why}`);
                return;
            }
            openDecision(decision);
        }

        // Clicking the warning on the map is how most people will arrive: the marker is what they
        // can see. It opens the first unanswered approach at that junction, so the click that used
        // to produce a JSON dump now produces the question.
        function focusByNode(nodeId) {
            const here = state.decisions.filter(decision => decision.nodeId === nodeId);
            if (!here.length) return false;
            const answerable = here.filter(decision => decision.kind === 'lane_exits');
            const next = answerable.find(decision => !decision.answered) || answerable[0];
            if (!next) {
                showToast(`${here[0].prompt}. ${here[0].why}`);
                return true;
            }
            openDecision(next);
            return true;
        }

        function advance(skipping) {
            const queue = answerable();
            const from = queue.findIndex(entry => entry.id === state.current?.id);
            const after = queue.slice(from + 1).find(entry => skipping || !entry.answered);
            const next = after || pending()[0];
            if (!next || next.id === state.current?.id) { close(); return; }
            openDecision(next);
        }

        function close() {
            state.current = null;
            state.assignment = {};
            state.received = {};
            layer.clearLayers();
            renderQueue();
            renderCard();
        }

        async function save() {
            const decision = state.current;
            if (!decision || state.saving) return;
            const module = decisionsModule();
            const blocking = module.validate(decision, state.assignment)
                .filter(note => !note.startsWith('NOTE:'));
            if (blocking.length) { showToast(blocking[0], true); return; }

            state.saving = true;
            renderCard();
            try {
                const graph = getGraph();
                const body = await api('/lane-topology/decisions', {
                    method: 'POST',
                    body: JSON.stringify({
                        city: 'zagreb',
                        decisionKey: decision.id,
                        nodeKey: decision.nodeId,
                        fromWayId: decision.fromWayId,
                        reason: decision.reason,
                        snapshotId: graph?.source?.snapshotId ?? null,
                        point: decision.point,
                        assignment: module.toStoredAssignment(decision, state.assignment, state.received)
                    })
                });
                state.stored.set(decision.id, body.decision);
                decision.answered = true;
                showToast(`Saved: ${decision.approach.name || 'junction'}`);
                // Re-derives with this answer in it, which is what removes the junction's warning
                // and draws its movements; then the queue re-reads the graph that came out.
                onSaved?.(decision);
                rebuildQueue();
            } catch (error) {
                showToast(`Could not save the decision: ${error.message}`, true);
                state.saving = false;
                renderCard();
                return;
            }
            state.saving = false;
            advance(false);
        }

        function start() {
            const next = pending()[0] || answerable()[0];
            if (!next) { showToast('Nothing here needs a decision.'); return; }
            openDecision(next);
        }

        return {
            load: loadStored,
            // What the derivation must be given: the graph builder folds these in itself.
            stored: () => [...state.stored.values()],
            refresh,
            focusById,
            focusByNode,
            start,
            close,
            isOpen: () => !!state.current
        };
    }

    // Namespaced, not a bare `createDecisionsUi`: these are classic scripts sharing one global
    // scope, and a bare name is one collision away from being silently shadowed.
    root.LaneTopologyDecisionsUi = { create: createDecisionsUi };
})(window);
