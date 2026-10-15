# Džepni simulator prometa

Naslov **Džepni simulator prometa** prikazan je kompaktno, bez zasebnog uvodnog bloka; poveznice na
povezane stranice i izvore nalaze se u podnožju. Simulator omogućuje zatvaranje traka, praćenje
vozila, pregled razloga zaustavljanja i mjerenje protoka. Kretanje koristi spremljene odgovore za
raskrižja i izričito dopuštene veze; nedostajući izlazi i skretanja ne izmišljaju se.

Vozila napreduju prema prostoru koji je trenutačno slobodan ispred njih. Provjeravaju sljedeću
stvarnu crtu zaustavljanja, razmak iza vozila i fizičko preklapanje karoserija u svakom koraku.
Na zelenom ulaze i kada je nizvodno red; prolaze slobodni dio koraka pa čekaju ako je put zauzet.
Već prijeđeni semafor ne zaustavlja ih ponovno. Pri velikoj gustoći mogu nastati zastoji i potpune
blokade; simulator ne optimizira tok prometa.
Ako je vozilo blokirano, može se polako prestrojiti u slobodnu susjednu traku i unutar raskrižja,
uključujući prelazak oznake koja inače ograničava promjenu trake. Vozači imaju različite razmake,
vremena reakcije i pragove strpljenja. Bliska vozila koja se spajaju u istu traku daju prednost
onome koje je već dalje; pri uzajamnoj blokadi jedno pokušava uzmaknuti ako iza njega ima mjesta.
Nestrpljivi vozač traži drugi dopušteni izlaz ili okretanje prema postojećoj suprotnoj traci iste
ceste. Pretraživanje je ograničeno i raspoređeno kroz korake simulacije. Okretanje može sadržavati
više vožnji naprijed i natrag, uz provjeru cijele karoserije na kolniku, ostalih vozila, zatvorenih
dionica i stvarnih lokalnih crta zaustavljanja. Ako nema sigurnog puta, vozilo ostaje u redu.
Zaglavljeni započeti manevar može se ponovno planirati iz stvarnog položaja vozila. Ostala vozila
propuštaju njegovu kratku putanju, uključujući promjenu smjera vožnje, umjesto da popune prostor
za uzmicanje. Pretraživanje izmjenjuje vozače redom, a ne uvijek od najmanjeg broja vozila.
Zadovoljstvo vozača, trenutačno trajanje zastoja i manevar prikazani su pri odabiru vozila;
zaustavljeno vozilo prikazuje čekanje na prostor, a ne manevar koji se ne izvodi.
Plavi gradski autobusi, policijska vozila i vozila hitne pomoći imaju vlastite dimenzije i polumjere
okretanja; slijede iste prometne signale i pravila propuštanja.

Prekidač **Zvuk** uključuje tihu, udaljenu buku motora i guma vozila u vidljivom području.
Nestrpljivi vozači povremeno kratko trube; čuju se samo vidljiva vozila, uz ograničen broj i učestalost
zvukova. Zvuk počinje nakon interakcije sa stranicom i utiša se pri pauziranju ili skrivanju kartice.

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
određuju i provjeru dostupnog kolnika pri okretanju. Simulacijski graf `lanes` sadrži trake dostupne
automobilima, a `connections`
njihove izričito dopuštene veze. Površinska geometrija ne dodaje kretanja u graf.
Površine koriste pune izvorne putanje; odmaci koji odvajaju simulacijske trake od raskrižja
ne prekidaju kolnik ni kada nastavak nije riješen. Samo stvarni prijelaz broja traka ili
zaglađeni zavoj preuzima odgovarajući dio površine.
Kolnik prati širinu i putanju svake trake i spremljenog kretanja. Prazni kutovi između krakova
raskrižja ne popunjavaju se trokutima; proširenja i suženja prate stvarne prijelaze broja traka.
Oznake pri promjeni broja traka nastavljaju uzdužne rubove cestovnih traka. Ne iscrtavaju
lepezaste putanje vozila prema novim trakama; dodatne paralelne crte počinju tek na kolniku.

Prekidač **Tramvajske tračnice** prikazuje aktivne OSM središnice iz zajedničkog API-ja
`/roads/rails`. `tramTracks` zadržava identitet OSM puta, njegovu geometriju i oznake `gauge` i
`tracks`; putovi se režu na obuhvat prikaza bez spajanja dijelova koji izlaze iz njega.
Razmak tračnica slijedi izvorni kolosijek od 1000 mm. Ako jedan OSM put opisuje dva kolosijeka,
njihove središnice razmiču se za 2,8 m prema postojećem standardu Station3D-a.
Uska tramvajska podloga crta se ispod cestovnog kolnika, a tračnice iznad njega: izdvojeni pojas
ostaje vidljiv, dok zajedničke prometne trake zadržavaju asfalt. Prikaz ne dodaje trake ni
dopuštena kretanja u automobilski graf.

Alat **Zatvori traku** zatvara dionice od 5 ili 10 metara; zauzeta dionica čeka da je vozila napuste.
Vozila obilaze prepreku preko susjednih traka u istom smjeru; bez slobodnog obilaska čekaju.
Alat **Mjeri protok** broji sve prelaze preko crte po traci; na karti prikazuje zbroj za svaki smjer.
Protok u vozilima po minuti računa se iz posljednjih 60 simuliranih sekundi. Zatvaranja,
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

Paket sadrži `backend/traffic/ecosystem.config.cjs` za zaseban PM2 proces
`zagreb-traffic-simulator` na lokalnom portu 8192 te `backend/traffic/nginx.locations.conf`
za navedena dva URL prefiksa. PostgreSQL pristupni podaci ostaju u datoteci
`/etc/traffic-simulator/database.env` na poslužitelju. Pri izmjeni izdanja ponovno učitajte
PM2 konfiguraciju i provjerite API prije ponovnog učitavanja nginx konfiguracije.
