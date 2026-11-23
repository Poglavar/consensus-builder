// Resolve the view before the application's classic scripts choose a city and open IndexedDB.
// Only the same-origin static application supplies markup. Plan data stays in a verified object.
(async function (win) {
    if (!await win.BrowserWorkspace.ready) return;
    const doc = win.document;
    const status = doc.getElementById('plan-arrival-status'), retry = doc.getElementById('plan-arrival-retry');
    const heading = doc.getElementById('plan-arrival-heading'), back = doc.getElementById('plan-arrival-back');
    const lang = (new URL(win.location.href).searchParams.get('lang') || win.localStorage.getItem('cb_language') || win.navigator.language || 'en').split('-')[0];
    const words = JSON.parse(doc.getElementById('plan-entry-words').textContent);
    let language = words[lang] ? lang : 'en';
    let labels = words[language] || {};
    const localize = () => {
        doc.documentElement.lang = language;
        doc.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
        if (labels.loading) status.textContent = labels.loading;
        if (labels.retry) retry.textContent = labels.retry;
        if (labels.heading) {
            heading.textContent = labels.heading;
            doc.title = `${labels.heading} · Consensus Builder`;
        }
        if (labels.back) back.textContent = labels.back;
    };
    localize();
    // Unbundled development pages use the same source dictionary as the map.
    if (!words.en && lang !== 'en' && /^[a-z]{2}$/.test(lang)) {
        win.fetch(`/i18n/${lang}.json`).then(r => r.ok && r.json()).then(d => {
            if (d && status.isConnected && retry.hidden) {
                language = lang;
                labels = { loading: d.common?.busy?.loading, retry: d.bets?.retry,
                    failed: d.proposals?.share?.named?.openFailed, heading: d.planDialog?.openPlan, back: d.pageHeader?.backToMap };
                localize();
            }
        }).catch(() => { /* optional locale enhancement; built-in English labels remain usable */ });
    }
    async function open() {
        status.textContent = labels.loading || 'Loading…';
        status.setAttribute('aria-busy', 'true');
        try {
            const [arrival, application] = await Promise.all([win.NamedPlans.resolveEntry(), win.fetch('/index.html', {
                cache: 'no-cache', mode: 'same-origin', signal: AbortSignal.timeout(30000)
            }).then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })]);
            win.compactPlanArrival = arrival;
            // Run the ordinary parser-ordered application in this browsing context. The
            // address, workspace lease, verified record and navigation remain the same.
            doc.open();
            doc.write(application);
            doc.close();
        } catch (error) {
            status.removeAttribute('aria-busy');
            status.textContent = [labels.failed, error.message].filter(Boolean).join(' · ');
            retry.hidden = false;
            retry.focus();
        }
    }
    retry.addEventListener('click', () => {
        if (!win.BusyControl.isBusy(retry)) win.BusyControl.track(retry, open);
    });
    await open();
})(window);
