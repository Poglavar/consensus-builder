// Map and focus lifecycle shared by the Dog and Hare dialogs.
(function (win) {
    'use strict';
    const doc = win.document;

    function tourSteps(id, snapshot, data, t) {
        const tour = win.CriticTour;
        const designs = new Map(snapshot.designs.map(row => [row.cid, row.content]));
        const eligible = data.homes.filter(home => home.coordinate).sort((a, b) => a.coordinate[0] - b.coordinate[0]);
        const withTrips = eligible.filter(home => Object.values(home.routes).some(Boolean));
        const noTrip = eligible.find(home => !Object.values(home.routes).some(Boolean));
        const homes = withTrips.length ? [...tour.sample(withTrips, noTrip ? 4 : 5), ...(noTrip ? [noTrip] : [])] : tour.sample(eligible);
        if (!homes.length) {
            const paths = data.segments || (data.paths || []).map(coordinates => ({ points: coordinates }));
            return tour.sample(paths, 3).map(segment => ({ coordinates: segment.points, label: segment.tiers
                ? tour.t('segment', { grade: [...new Set(segment.tiers)].map(type => t(type)).join(' · ') }) : tour.t('path') }));
        }
        return homes.map((home, index) => {
            const [, cid, building] = home.id.split(':');
            const design = designs.get(cid), buildings = win.__planYield.buildingFeaturesOf(design);
            const footprint = buildings[Number(building)]?.geometry;
            const geometry = buildings.length === 1 ? design.geometry?.landTake || design.site || footprint : footprint;
            const options = Object.entries(home.routes).filter(([, trip]) => trip);
            const [category, trip] = options.length ? options[index % options.length] : [];
            const coordinates = trip && (data.selectTrip ? data.selectTrip(home.id, category).coordinates : data.route(home.id, category));
            return { geometry, coordinates: coordinates || [home.coordinate],
                label: trip ? tour.t(id, { from: home.title, to: trip.title }) : tour.t('noRoute', { name: home.title }) };
        });
    }

    function create({ id, shell, evaluate, render, t }) {
        let session;
        function close(restore = true) {
            const current = session;
            if (!current) return;
            session = null;
            current.tour.abort();
            current.unregister();
            current.network?.remove();
            current.route?.remove();
            current.panel.remove();
            if (current.month && current.clockPlan === win.BuildoutClock.plan()) win.BuildoutClock.open(current.month);
            if (!restore) return;
            if (current.framed) win.map.setView(current.center, current.zoom, { animate: false });
            void win.PlanAnalysisControls.restoreCriticOrigin(win, doc, current, id)
                .catch(error => win.showStyledAlert(error.message));
        }

        function frame(current, bounds) {
            if (!bounds.isValid()) return;
            const map = win.map.getContainer().getBoundingClientRect(), panel = current.panel.getBoundingClientRect();
            const mobile = win.matchMedia('(max-width: 767px)').matches;
            win.map.fitBounds(bounds, { maxZoom: 19, animate: false, paddingTopLeft: [35, 80],
                paddingBottomRight: mobile ? [35, map.bottom - panel.top + 12] : [map.right - panel.left + 20, 70] });
            current.framed = true;
        }

        async function open(plan, row, returnTo) {
            close(false);
            const current = { ...shell(plan), plan, row, returnTo, tour: new AbortController(), mode: win.__mapModeState?.desired || '2d',
                center: win.map.getCenter(), zoom: win.map.getZoom() };
            session = current;
            current.unregister = win.ModalEscape.register(current.panel, () => close());
            current.ui.close.addEventListener('click', () => close());
            win.MapShell.closeSheets();
            win.ClickStack?.close();
            win.clearProposalPreview?.();
            current.ui.close.focus();
            try {
                const snapshot = await win.PlanWorkspace.resolve(plan);
                if (session !== current) return;
                if (current.mode !== '2d' && !await win.requestMapMode('2d')) throw new Error(t('mapUnavailable'));
                if (session !== current) return;
                const assessment = evaluate(snapshot.content, snapshot.designs);
                current.month = win.BuildoutClock?.month();
                if (current.month) {
                    current.clockPlan = win.BuildoutClock.plan();
                    win.BuildoutClock.close();
                }
                await win.CriticTour.play({ id, portrait: `/images/critic-${id}.webp`, steps: tourSteps(id, snapshot, assessment, t),
                    panel: current.panel, status: current.ui.status, close: current.ui.close, signal: current.tour.signal,
                    frame: bounds => frame(current, bounds) });
                if (session !== current) return;
                render(current, assessment, bounds => frame(current, bounds));
            } catch (error) {
                if (session !== current) return;
                current.network?.remove();
                current.route?.remove();
                current.ui.results.hidden = true;
                current.ui.status.hidden = false;
                current.ui.status.textContent = t('failed', { reason: error.message });
            }
        }

        win.addEventListener('cityChanged', () => close(false));
        doc.addEventListener('mapshell:sheetopened', () => close(false));
        win.addEventListener('mapmodechange', event => {
            if (session && event.detail?.desired !== '2d') close(false);
        });
        return { open };
    }

    win.ActiveTravelPanel = { create };
})(window);
