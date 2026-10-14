# Simulator prometa u Zagrebu

Hrvatski simulator prikazuje kretanje vozila kroz odabrano područje Zagreba. Možete zatvarati
trake, pratiti vozila, pregledati razlog njihova zaustavljanja i mjeriti protok. Kretanje koristi
spremljene odgovore za raskrižja i izričito dopuštene veze; nedostajući izlazi i skretanja ne
izmišljaju se.

## Prometni signali

OSM čvorovi služe kao izvorni dokaz za signale. Simulator ih grupira u kontrolere raskrižja i
izvodi vjerojatne položaje glava semafora uz rub prilaza. Više OSM čvorova može završiti na istom
prilazu i dijeliti kontroler; prikazana glava zato ne označava nužno točan položaj fizičkog stupa.
Suprotni prilazi imaju zeleno zajedno, a okomiti smjerovi izmjenjuju se. Svaka faza koristi
ilustrativnih 24 sekunde zelenog, 3 sekunde žutog i 2 sekunde svecrvenog vremena za raščišćavanje.
To nisu stvarni signalni planovi, izmjerena vremena ni podaci o trenutačnom prometu.

## Geometrija i alati

`surfaceLanes` opisuje fizički prikaz traka tipa `driving` i `bus`, uključujući trake koje nisu
dopuštene osobnim automobilima, primjerice privatne ili zajedničke središnje trake. Te površine
služe samo za prikaz. Simulacijski graf `lanes` sadrži trake dostupne automobilima, a `connections`
njihove izričito dopuštene veze. Površinska geometrija ne dodaje kretanja u graf.

Alat **Zatvori traku** zatvara dionice od 5 ili 10 metara; zauzeta dionica čeka da je vozila napuste.
Vozila obilaze prepreku samo dopuštenim susjednim trakama, a bez dopuštenog obilaska čekaju.
Alat **Mjeri protok** broji simulirana vozila po traci i smjeru do 60 simuliranih sekundi. Zatvaranja,
mjerači i stanje prometa postoje samo u otvorenoj stranici. To su rezultati simulacije, a ne prognoza
ili kalibrirano mjerenje cestovnog prometa.

Položaji vozila i traka izvedeni su iz karte, ne iz geodetske izmjere. Dio nogostupa može nedostajati;
neka raskrižja ostaju neriješena. Kad nedostaje dopuštena veza, vozilo se zaustavlja umjesto da
simulator pretpostavi skretanje. Podloga karte koristi javne OSM pločice i traži internetsku vezu.

## API i podaci

Stranica za produkciju nalazi se na [`https://zagreb.lol/promet/simulator/`](https://zagreb.lol/promet/simulator/).
Mreža se učitava na zahtjev s `/api/promet/simulator/network`; `/api/promet/simulator/status`
vraća obuhvat, broj elemenata i sažetak izvora. API spaja trenutačni OSM izvoz sa spremljenim
kandidatima za raskrižja, provjerava njihove roditeljske verzije i ograničenja te ne mijenja bazu.
Podaci se drže u memoriji dvije minute. Ako osvježavanje ne uspije, API vraća HTTP 503 i ne poslužuje
istekli odgovor. U paketu se ne objavljuje izvedena JSON mreža.

## Priprema izdanja i lokalni pregled

Iz korijena repozitorija izradite paket u novom direktoriju čiji roditelj već postoji. Putanja mora
biti izvan oba radna repozitorija i korisničkog direktorija.

```sh
node backend/scripts/build-traffic-release.mjs \
  --topology-root ../canonical-topology \
  --output /tmp/traffic-simulator-release
```

Izgradnja kopira frontend i runtime skripte te potrebne topološke datoteke iz `HEAD` kanonskog
topološkog repozitorija. `release-manifest.json` bilježi SHA aplikacije, SHA topologije i kontrolne
sažetke datoteka. Rezultat je pripremljen paket (`PREPARED`); naredba ga ne objavljuje i ne deploya.
Topološki runtime čuva kanonske algoritme. Paket izričito izvozi dvije postojeće funkcije za
provjeru spremljenih odgovora; manifest razlikuje sažetak izvornika od sažetka paketirane datoteke.

Za pokretanje pripremljenog paketa:

```sh
cd /tmp/traffic-simulator-release
npm --prefix backend install --omit=dev
export TRAFFIC_TOPOLOGY_ROOT=./topology
export TRAFFIC_ROADS_API=https://roads-api.example/api
export PGHOST=localhost
export PGPORT=5432
export PGUSER=readonly_user
export PGPASSWORD='...'
export PGDATABASE=geodata
node backend/scripts/serve-traffic-simulator.mjs
```

Otvorite `http://localhost:8192/promet/simulator/`. Poslužitelj prihvaća i `DATABASE_URL`;
inače koristi navedene `PG*` varijable. PostgreSQL sesija je samo za čitanje. Skripta po zadanim
postavkama čita `backend/.env`, a `--env-file` može odabrati drugu datoteku. Iz radnog repozitorija
poslužitelju treba predati `--assets-dir /tmp/traffic-simulator-release/frontend/traffic/assets`;
paket već sadrži te biblioteke na zadanoj putanji. Izvoz za testove ostaje u `backend/test/fixtures/`
i nikada se ne servira stranici.

Poslužitelj sluša na localhostu i servira stranicu pod `/promet/simulator/` te API pod
`/api/promet/simulator/`. Za javnu objavu potrebno je zasebno konfigurirati reverse proxy za ta dva
prefiksa i postupak deploya. `sitemap.xml` sadrži kanonsku stranicu; pri objavi je treba uključiti u
glavni sitemap zagreb.lol. `llms.txt` opisuje API, izvore, obuhvat i ograničenja simulacije.
