// Croatian-only copy for the Zagreb traffic simulator.
(function exposeTrafficCopy(root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TrafficCopy = api;
})(typeof window === 'undefined' ? null : window, function createTrafficCopy() {
    'use strict';

    const labels = Object.freeze({
        siteHome: 'zagreb.lol',
        trafficHub: 'Promet',
        aboutSimulator: 'O simulatoru',

            title: 'Džepni simulator prometa',
            play: 'Pokreni',
            pause: 'Pauziraj',
            reset: 'Novi promet',
            speed: 'Brzina simulacije',
            cars: 'Automobili',
            lights: 'Semafori',
            lanes: 'Kolnik i oznake',
            tools: 'Alati',
            inspectTool: 'Pregled',
            closeTool: 'Zatvori traku',
            meterTool: 'Mjeri protok',
            chunkSize: 'Duljina dionice',
            reopenAll: 'Otvori sve',
            closureCount: '{active} zatvoreno · {pending} čeka pražnjenje',
            meters: 'Mjerači protoka',
            meterName: 'Mjerač {id}',
            meterLane: 'Traka / smjer',
            meterTotal: 'Ukupno',
            meterRate: 'voz/min',
            meterBefore: 'Prije',
            resetMeter: 'Poništi brojanje',
            removeMeter: 'Ukloni',
            meterWindow: 'Protok u {seconds} simuliranih sekundi (do 60).',
            baselineWindow: 'Prije posljednje izmjene: {seconds} s.',
            noBaseline: '—',
            laneHover: '{road} · traka {number}',
            closedHover: 'Kliknite za ponovno otvaranje',
            openHover: 'Kliknite za zatvaranje · {length} m',
            noSpace: 'Nema dopuštenog obilaska: promet će čekati.',
            directionE: 'Istok',
            directionN: 'Sjever',
            directionW: 'Zapad',
            directionS: 'Jug',
            follow: 'Prati automobil',
            unfollow: 'Prestani pratiti',
            areas: 'Istraži',
            miramarska: 'Miramarska × Vukovarska',
            split: 'Račvanje traka · Lučićeva',
            center: 'Središte grada',
            west: 'Trešnjevka',
            overview: 'Cijeli prikaz',
            moving: 'U pokretu',
            waiting: 'Čekanje',
            turns: 'Prolasci kroz raskrižja',
            changes: 'Promjene traka',
            rules: 'Kako funkcionira',
            explanation: 'Automobili biraju dopuštena skretanja na putovima koji ostaju povezani kroz učitano područje. Promjene traka poštuju ucrtana ograničenja.',
            signalNote: 'Položaji semafora izvode se iz podataka OpenStreetMapa (OSM). Više OSM čvorova može se grupirati na isti prilaz i dijeliti jedan simulirani ciklus. Prikazani položaji ne moraju odgovarati točnoj lokaciji fizičkih stupova semafora.',
            dataNote: 'Kolnik se prikazuje i kada nisu dodijeljena sva dopuštena kretanja. Širine traka su procijenjene; nogostupi mogu biti nepotpuni.',
            selectHint: 'Kliknite automobil da vidite njegovu traku, dopuštene izlaze, razlog zaustavljanja i sljedeći semafor.',
            stopReason: 'Zašto je zaustavljen',
            reasonMoving: 'U pokretu · {speed} km/h',
            reasonStarting: 'Spreman za polazak',
            reasonPaused: 'Reprodukcija je pauzirana',
            reasonSignal: 'Čeka na semaforu: {aspect}',
            reasonFollowing: 'Održava siguran razmak iza automobila {id}',
            reasonExit: 'Čeka se slobodan prostor iza raskrižja',
            reasonCollision: 'Čeka da automobil {id} oslobodi put',
            reasonClosure: 'Čeka se zbog zatvaranja trake',
            reasonNoExit: 'Iz ove trake nema dopuštenog puta',
            reasonChanging: 'Čeka se prostor za završetak promjene trake',
            blockingCar: 'Vozilo koje blokira: {id}',
            signalAhead: 'Semafor na ovom prilazu',
            signalApproach: '{road} · {direction} · {aspect} · još {distance} m',
            signalNone: 'Na ovom prilazu nema semafora ispred',
            signalDisabled: 'Semafori su isključeni',
            showSignal: 'Prikaži semafor',
            aspectRed: 'crveno',
            aspectAmber: 'žuto',
            aspectGreen: 'zeleno',
            selected: 'Automobil {id}',
            road: 'Cesta',
            unnamed: 'Neimenovana ulica',
            lane: 'Traka {number}',
            exits: '{count} dopuštenih izlaza',
            loading: 'Učitavanje…',
            error: 'Nije moguće učitati prometnu mrežu.',
            retry: 'Pokušaj ponovno',
            network: '{lanes} traka · {connections} veza',
            solved: 'Potpuni odgovori spremljeni su za {count} raskrižja',
            coverage: 'U učitanom području {unresolved} čvorova ostaje neriješeno; {partial} raskrižja koristi djelomične spremljene odgovore',
            snapshot: 'OSM snimka: {date}',
            noExit: 'Nema poznatog izlaza',
            driving: 'Vožnja',
            red: 'Čekanje na crvenom',
            queue: 'Čekanje na slobodan prostor',
            blocked: 'Zaustavljen: nema poznatog izlaza',
            turning: 'Prolazak kroz raskrižje',
            changing: 'Promjena trake',
            reduceMotion: 'Pauzirano zbog smanjenog kretanja. Pritisnite Pokreni za animaciju.',
            mapLabel: 'Prikaz zagrebačkog prometa na karti',
            carCount: '{count} automobila',
            dataDetails: 'Podaci',
            loadedArea: 'Učitano područje',
            zoomIn: 'Povećajte prikaz za pojedinačne trake',
            zoomInButton: 'Povećaj kartu',
            zoomOutButton: 'Smanji kartu',
            closePopup: 'Zatvori opis',
            elapsed: 'Simulirano vrijeme',
            lightLegend: 'OSM podaci · izvedeni položaj · simulirani ciklus',
            signalSource: 'Semafor · {road} · {direction}',
            signalDetails: 'Izveden položaj · simulirani ciklus.',
            signalLink: 'OSM',
            sourceLink: 'Referenca oznaka za promjenu trake'
    });

    function t(key, params = {}) {
        const requestedKey = String(key ?? '');
        const labelKey = requestedKey.startsWith('traffic.') ? requestedKey.slice(8) : requestedKey;
        const template = labels[labelKey];
        if (typeof template !== 'string') return requestedKey;
        const values = params && typeof params === 'object' ? params : {};
        return template.replace(/\{([^{}]+)\}/g, (placeholder, name) =>
            Object.hasOwn(values, name) ? String(values[name]) : placeholder);
    }

    return { labels, t };
});
