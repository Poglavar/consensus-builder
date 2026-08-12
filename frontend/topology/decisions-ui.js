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

        // Where an arm's letter goes: as far along the arm as it can sit while staying near the
        // junction AND inside the frame.
        //
        // Two faults produced the missing B. `stubTowards` walked whole vertices, so an arm drawn
        // as one long straight put its label at the far end — hundreds of metres away. And nothing
        // consulted the viewport, so a label could be perfectly placed and still off screen, or
        // hidden behind the decision card. Working in container pixels fixes both at once, and
        // makes the distance from the junction look the same at every zoom.
        const LABEL_REACH_PX = 78;
        const FRAME_INSET_PX = 30;

        function cardRect() {
            const card = element('decision-card');
            const container = map.getContainer();
            if (!card || card.hidden || !container) return null;
            const a = card.getBoundingClientRect();
            const b = container.getBoundingClientRect();
            // A margin, so a letter never sits tight against the card's edge either.
            return { left: a.left - b.left - 12, top: a.top - b.top - 12,
                right: a.right - b.left + 12, bottom: a.bottom - b.top + 12 };
        }

        function labelAnchor(coordinates, atNode, blocked) {
            const points = (atNode ? [...coordinates].reverse() : coordinates)
                .map(([lng, lat]) => map.latLngToContainerPoint([lat, lng]));
            if (!points.length) return null;
            const size = map.getSize();
            const usable = point => point.x >= FRAME_INSET_PX && point.y >= FRAME_INSET_PX
                && point.x <= size.x - FRAME_INSET_PX && point.y <= size.y - FRAME_INSET_PX
                && !(blocked && point.x >= blocked.left && point.x <= blocked.right
                    && point.y >= blocked.top && point.y <= blocked.bottom);

            let best = usable(points[0]) ? points[0] : null;
            let travelled = 0;
            for (let index = 1; index < points.length; index += 1) {
                const from = points[index - 1];
                const to = points[index];
                const span = from.distanceTo(to);
                if (!span) continue;
                // Sampled rather than per-vertex, so a single long segment is still walked.
                const steps = Math.max(1, Math.ceil(span / 8));
                for (let step = 1; step <= steps; step += 1) {
                    const ratio = step / steps;
                    if (travelled + span * ratio > LABEL_REACH_PX) {
                        return map.containerPointToLatLng(best || points[0]);
                    }
                    const point = L.point(from.x + (to.x - from.x) * ratio,
                        from.y + (to.y - from.y) * ratio);
                    if (!usable(point)) return map.containerPointToLatLng(best || points[0]);
                    best = point;
                }
                travelled += span;
            }
            return map.containerPointToLatLng(best || points[0]);
        }

        // Drawn layers, kept so hovering can single one out without redrawing everything.
        const drawn = { lanes: new Map(), exits: new Map(), node: null };

        function paintFocus(decision) {
            layer.clearLayers();
            drawn.lanes.clear();
            drawn.exits.clear();
            drawn.node = null;
            if (!decision) return;
            const graph = getGraph();
            if (!graph) return;
            const laneById = new Map((graph.lanes || []).map(lane => [lane.id, lane]));
            const blocked = cardRect();

            decision.approach.lanes.forEach(lane => {
                const record = laneById.get(lane.id);
                if (!record) return;
                const parts = [];
                parts.push(L.polyline(latLngs({ coordinates: stubTowards(record.geometry.coordinates, true) }), {
                    pane: 'topology-problems',
                    color: APPROACH_COLOR,
                    weight: 5,
                    opacity: .85,
                    interactive: false
                }).addTo(layer));
                const anchor = labelAnchor(record.geometry.coordinates, true, blocked);
                if (anchor) {
                    parts.push(L.marker(anchor, {
                        pane: 'topology-problems',
                        icon: badge('decision-badge decision-badge--lane', String(lane.ordinal + 1)),
                        interactive: false
                    }).addTo(layer));
                }
                drawn.lanes.set(lane.id, parts);
            });

            decision.exits.forEach((exit, index) => {
                const colour = ARM_COLORS[index % ARM_COLORS.length];
                const first = laneById.get(exit.lanes[0]?.id);
                if (!first) return;
                const parts = [];
                exit.lanes.forEach(exitLane => {
                    const record = laneById.get(exitLane.id);
                    if (!record) return;
                    parts.push(L.polyline(latLngs({ coordinates: stubTowards(record.geometry.coordinates, false) }), {
                        pane: 'topology-problems',
                        color: colour,
                        weight: 4,
                        opacity: .8,
                        interactive: false
                    }).addTo(layer));
                });
                const anchor = labelAnchor(first.geometry.coordinates, false, blocked);
                if (anchor) {
                    parts.push(L.marker(anchor, {
                        pane: 'topology-problems',
                        icon: badge('decision-badge decision-badge--arm', ARM_LETTERS[index] || '?'),
                        interactive: false
                    }).addTo(layer));
                }
                drawn.exits.set(exit.sectionId, parts);
            });

            if (Array.isArray(decision.point)) {
                drawn.node = L.circleMarker([decision.point[1], decision.point[0]], {
                    pane: 'topology-problems',
                    radius: 8,
                    color: '#ffffff',
                    weight: 2,
                    fillOpacity: 0,
                    interactive: false
                }).addTo(layer);
            }
            applySpotlight();
        }

        // Hovering a row or an arm chip singles that piece out and hides the rest, because at a
        // junction with three arms and five lanes the drawing is exactly as crowded as the road is.
        let spotlight = null;

        function setOpacity(parts, visible) {
            (parts || []).forEach(part => {
                if (part.setStyle) part.setStyle({ opacity: visible ? (part.options.weight > 4 ? .85 : .8) : 0 });
                else if (part.getElement) {
                    const element = part.getElement();
                    if (element) element.style.opacity = visible ? '1' : '0';
                }
            });
        }

        function applySpotlight() {
            const lit = key => !spotlight || spotlight.lanes.includes(key) || spotlight.exits.includes(key);
            drawn.lanes.forEach((parts, id) => setOpacity(parts, lit(id)));
            drawn.exits.forEach((parts, id) => setOpacity(parts, lit(id)));
        }

        function highlight(next) {
            const same = JSON.stringify(next) === JSON.stringify(spotlight);
            if (same) return;
            spotlight = next;
            applySpotlight();
        }

        // A lane row lights the lane and every arm that lane may use; an arm chip lights the arm
        // and every lane assigned to it. Either way you see one movement's worth of road.
        function spotlightForLane(laneId) {
            return { lanes: [laneId], exits: [...(state.assignment[laneId] || [])] };
        }

        function spotlightForExit(sectionId) {
            const lanes = Object.entries(state.assignment)
                .filter(([, exits]) => (exits || []).includes(sectionId))
                .map(([laneId]) => laneId);
            return { lanes, exits: [sectionId] };
        }

        // ---- card -------------------------------------------------------------------------

        function laneRow(decision, lane) {
            const chosen = state.assignment[lane.id] || [];
            const buttons = decision.exits.map((exit, index) => {
                const on = chosen.includes(exit.sectionId);
                return `<button type="button" class="arm-chip${on ? ' arm-chip--on' : ''}"
                    style="--arm: ${ARM_COLORS[index % ARM_COLORS.length]}"
                    data-lane="${escapeHtml(lane.id)}" data-exit="${escapeHtml(exit.sectionId)}"
                    data-hover-pair="${escapeHtml(lane.id)}|${escapeHtml(exit.sectionId)}"
                    aria-pressed="${on}" title="${escapeHtml(exit.label)}">${ARM_LETTERS[index] || '?'}</button>`;
            }).join('');
            const kind = lane.type === 'driving' ? '' : ` · ${escapeHtml(lane.type)}`;
            return `<div class="lane-row" data-hover-lane="${escapeHtml(lane.id)}">
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
                <h3>${escapeHtml(decision.approach.name || 'Unnamed road')}${(() => {
                    // Looking along the approach at the junction: the view that shows the painted
                    // arrows on the lanes being asked about.
                    const straight = decision.exits.find(exit => exit.category === 'through')
                        || decision.exits[0];
                    const url = straight && decisionsModule().streetViewUrl(
                        decisionsModule().streetViewViewpoint(decision, straight, getGraph()));
                    return url ? ` <a class="street-view street-view--head" href="${escapeHtml(url)}"
                        target="_blank" rel="noopener">street view</a>` : '';
                })()}</h3>
                <p class="decision-card__prompt">${escapeHtml(decision.prompt)}</p>
                <p class="decision-card__why">${escapeHtml(decision.why)}</p>
                <div class="decision-card__lanes">
                    ${decision.approach.lanes.map(lane => laneRow(decision, lane)).join('')}
                </div>
                ${receivingRows(decision)}
                <div class="decision-card__legend">
                    ${decision.exits.map((exit, index) => {
                        const view = decisionsModule().streetViewUrl(
                            decisionsModule().streetViewViewpoint(decision, exit, getGraph()));
                        return `<span data-hover-exit="${escapeHtml(exit.sectionId)}">
                            <i style="background:${ARM_COLORS[index % ARM_COLORS.length]}">${ARM_LETTERS[index] || '?'}</i>
                            <span class="decision-card__legend-text">${escapeHtml(exit.label)}${
                                exit.forked ? ' <em>(fork)</em>' : ''}</span>
                            ${view ? `<a class="street-view" href="${escapeHtml(view)}" target="_blank"
                                rel="noopener" title="Street View from the approach, looking this way"
                                >street view</a>` : ''}
                        </span>`;
                    }).join('')}
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
            const hover = (selector, resolve) => {
                card.querySelectorAll(selector).forEach(node => {
                    node.addEventListener('mouseenter', () => highlight(resolve(node)));
                    node.addEventListener('mouseleave', () => highlight(null));
                    // Touch has no hover, so a tap on the row does the same without changing the answer.
                    node.addEventListener('focusin', () => highlight(resolve(node)));
                    node.addEventListener('focusout', () => highlight(null));
                });
            };
            hover('[data-hover-lane]', node => spotlightForLane(node.dataset.hoverLane));
            hover('[data-hover-exit]', node => spotlightForExit(node.dataset.hoverExit));
            hover('[data-hover-pair]', node => {
                const [laneId, sectionId] = node.dataset.hoverPair.split('|');
                return { lanes: [laneId], exits: [sectionId] };
            });
            card.addEventListener('mouseleave', () => highlight(null));

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

        // Label positions are computed in container pixels against the current frame, so they go
        // stale the moment the map moves. Redrawn on the settled view rather than continuously:
        // there is nothing to watch mid-gesture, and Leaflet fires these once per gesture.
        map.on('moveend zoomend resize', () => {
            if (state.current) paintFocus(state.current);
        });

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
