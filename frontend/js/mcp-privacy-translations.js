// Register the policy in every app language and use the shared preference/switcher behavior.
(function attachMcpPrivacy(root) {
    'use strict';
    const strings = {
    "en": {
        "title": "MCP privacy policy",
        "back": "Back to the map",
        "updated": "Updated 25 October 2026",
        "intro": "This notice covers the Urban Game Theory hosted MCP service, its planning plugin, private preview links and feedback reports. Urban Game Theory operates Consensus Builder. Your AI assistant provider has its own privacy policy for your conversations.",
        "requestsTitle": "Requests and their purpose",
        "requests": "We process the tool arguments your assistant sends: for example place searches, site coordinates, parcel or design identifiers, design geometry, titles and proposed changes. We use them to retrieve data, create and edit drafts, compare alternatives and return results. The MCP service does not request your full chat history or account credentials, and does not itself call a language model or train one.",
        "draftsTitle": "Private drafts and preview links",
        "drafts": "Draft content is kept in temporary server-side storage. References normally expire 24 hours after creation or refresh; expired records are removed when storage is pruned. Availability is not guaranteed. Anyone with the full private reference can read its content. These links are not account-protected or end-to-end encrypted: keep them private. Service administrators can access data held by the service.",
        "publicTitle": "Public publication",
        "public": "Publishing a design or plan requires explicit confirmation. Published content and any names, descriptions or other data you put in it become public. Content-addressed storage and third-party copies can persist; we cannot guarantee removal of every published copy. The hosted MCP does not sign wallet transactions or make payments.",
        "feedbackTitle": "Feedback and Telegram notifications",
        "feedback": "When you submit feedback, we store your report text, optional page link, report type, source, receipt identifier, timestamps and notification-delivery state in a private maintainer inbox. A report excerpt and optional page link are sent to the maintainer through Telegram. Feedback has no automatic expiry currently configured and may remain until a maintainer removes it. Include only information you want to share; do not submit passwords, wallet secrets or private chat transcripts.",
        "providersTitle": "Infrastructure and other providers",
        "providers": "Hosting, Cloudflare and other delivery infrastructure may process connection and diagnostic data such as IP addresses, requested URLs, timestamps, user-agent information and errors. Place and site queries can reach the configured geodata providers; opening a preview can contact map and imagery providers. Public publication uses the configured content-storage provider. Telegram processes feedback notifications under its own policies. The plugin package itself contains no analytics or executable hooks.",
        "retentionTitle": "Logs and local preferences",
        "retention": "Operational log and backup retention follows the infrastructure configuration; this notice does not promise a fixed deletion deadline for those copies. The privacy page stores its language preference locally in your browser. Your assistant provider may independently retain conversations and tool results according to its own settings and policies.",
        "contactTitle": "Questions, access and deletion requests",
        "contact": "Use the feedback form below to contact the maintainer about privacy, access, correction or deletion of data we control. Include a report receipt or other reference so we can identify the record. Requests are reviewed against the information available and the limits of public and third-party storage. Future changes to this notice will be dated on this page.",
        "contactLink": "Contact the maintainer / request data review"
    },
    "es": {
        "title": "Política de privacidad de MCP",
        "back": "Volver al mapa",
        "updated": "Actualizada el 25 de octubre de 2026",
        "intro": "Este aviso cubre el servicio MCP alojado de Urban Game Theory, su complemento de planificación, los enlaces de vista previa privada y los informes de comentarios. Urban Game Theory opera Consensus Builder. El proveedor de tu asistente de IA tiene su propia política de privacidad para tus conversaciones.",
        "requestsTitle": "Solicitudes y su finalidad",
        "requests": "Procesamos los argumentos que envía tu asistente a las herramientas: por ejemplo búsquedas de lugares, coordenadas, identificadores de parcelas o diseños, geometría, títulos y cambios propuestos. Los usamos para recuperar datos, crear y editar borradores, comparar alternativas y devolver resultados. El servicio MCP no solicita tu historial de chat completo ni credenciales de cuenta, y no llama por sí mismo a un modelo de lenguaje ni lo entrena.",
        "draftsTitle": "Borradores privados y enlaces de vista previa",
        "drafts": "Los borradores se guardan temporalmente en el servidor. Sus referencias normalmente caducan 24 horas después de crearse o renovarse; los registros caducados se eliminan al depurar el almacenamiento. No se garantiza la disponibilidad. Cualquiera con la referencia privada completa puede leer el contenido. Estos enlaces no están protegidos por una cuenta ni cifrados de extremo a extremo: mantenlos privados. Los administradores del servicio pueden acceder a los datos almacenados.",
        "publicTitle": "Publicación",
        "public": "Publicar un diseño o plan requiere confirmación explícita. El contenido publicado, incluidos nombres, descripciones y otros datos que añadas, se hace público. El almacenamiento por contenido y las copias de terceros pueden persistir; no podemos garantizar la eliminación de todas las copias publicadas. El MCP alojado no firma transacciones de cartera ni realiza pagos.",
        "feedbackTitle": "Comentarios y notificaciones de Telegram",
        "feedback": "Al enviar comentarios, guardamos el texto, el enlace opcional, el tipo de informe, su origen, identificador de recibo, fechas y estado de entrega en un buzón privado del equipo. Un extracto del informe y el enlace opcional se envían al mantenedor por Telegram. Actualmente no hay caducidad automática para los comentarios y pueden conservarse hasta que un mantenedor los elimine. Incluye solo información que quieras compartir; no envíes contraseñas, secretos de carteras ni transcripciones privadas.",
        "providersTitle": "Infraestructura y otros proveedores",
        "providers": "El alojamiento, Cloudflare y otra infraestructura de distribución pueden procesar datos de conexión y diagnóstico, como direcciones IP, URL solicitadas, fechas, información del navegador y errores. Las consultas de lugares y sitios pueden llegar a los proveedores de geodatos configurados; abrir una vista previa puede contactar con proveedores de mapas e imágenes. La publicación utiliza el proveedor de almacenamiento configurado. Telegram procesa las notificaciones según sus propias políticas. El paquete del complemento no contiene analítica ni hooks ejecutables.",
        "retentionTitle": "Registros y preferencias locales",
        "retention": "La conservación de registros operativos y copias de seguridad depende de la configuración de la infraestructura; este aviso no promete un plazo fijo de eliminación para esas copias. La página guarda la preferencia de idioma localmente en tu navegador. El proveedor de tu asistente puede conservar conversaciones y resultados según sus propios ajustes y políticas.",
        "contactTitle": "Preguntas y solicitudes de acceso o eliminación",
        "contact": "Usa el formulario de comentarios para contactar con el mantenedor sobre privacidad, acceso, corrección o eliminación de datos que controlamos. Incluye el recibo del informe u otra referencia para identificar el registro. Revisamos las solicitudes según la información disponible y los límites del almacenamiento público y de terceros. Los cambios futuros de este aviso se fecharán en esta página.",
        "contactLink": "Contactar con el mantenedor / solicitar revisión de datos"
    },
    "hr": {
        "title": "Pravila privatnosti MCP-a",
        "back": "Natrag na kartu",
        "updated": "Ažurirano 25. listopada 2026.",
        "intro": "Ova obavijest obuhvaća udomljenu MCP uslugu Urban Game Theory, njezin dodatak za planiranje, privatne poveznice za pregled i prijave povratnih informacija. Urban Game Theory upravlja aplikacijom Consensus Builder. Pružatelj vašeg AI asistenta ima vlastita pravila privatnosti za vaše razgovore.",
        "requestsTitle": "Zahtjevi i njihova svrha",
        "requests": "Obrađujemo argumente koje vaš asistent šalje alatima: primjerice pretrage mjesta, koordinate, identifikatore čestica ili dizajna, geometriju, naslove i predložene promjene. Koristimo ih za dohvat podataka, izradu i uređivanje nacrta, usporedbu alternativa i vraćanje rezultata. MCP usluga ne traži cijelu povijest razgovora ni vjerodajnice računa te sama ne poziva niti trenira jezični model.",
        "draftsTitle": "Privatni nacrti i poveznice za pregled",
        "drafts": "Sadržaj nacrta privremeno se čuva na poslužitelju. Reference u pravilu istječu 24 sata nakon nastanka ili obnavljanja; istekli zapisi brišu se prilikom čišćenja pohrane. Dostupnost nije zajamčena. Svatko s cijelom privatnom referencom može pročitati sadržaj. Te poveznice nisu zaštićene računom ni šifrirane s kraja na kraj: čuvajte ih privatnima. Administratori usluge mogu pristupiti pohranjenim podacima.",
        "publicTitle": "Javna objava",
        "public": "Objava dizajna ili plana zahtijeva izričitu potvrdu. Objavljeni sadržaj, uključujući imena, opise i druge unesene podatke, postaje javan. Pohrana adresirana sadržajem i kopije trećih strana mogu ostati dostupne; ne možemo zajamčiti uklanjanje svake objavljene kopije. Udomljeni MCP ne potpisuje transakcije novčanika niti obavlja plaćanja.",
        "feedbackTitle": "Povratne informacije i obavijesti putem Telegrama",
        "feedback": "Pri slanju povratne informacije u privatnom pretincu održavatelja spremamo tekst, neobaveznu poveznicu, vrstu i izvor prijave, oznaku potvrde, vremenske oznake i stanje dostave obavijesti. Izvadak prijave i neobavezna poveznica šalju se održavatelju putem Telegrama. Za povratne informacije trenutačno nije podešen automatski istek te mogu ostati pohranjene dok ih održavatelj ne ukloni. Uključite samo podatke koje želite podijeliti; ne šaljite lozinke, tajne novčanika ni privatne razgovore.",
        "providersTitle": "Infrastruktura i drugi pružatelji",
        "providers": "Hosting, Cloudflare i druga infrastruktura mogu obrađivati podatke o povezivanju i dijagnostici, poput IP adresa, zatraženih URL-ova, vremena, podataka o pregledniku i pogrešaka. Upiti o mjestima i lokacijama mogu se proslijediti podešenim pružateljima geopodataka; pregled može kontaktirati pružatelje karata i snimaka. Javna objava koristi podešenog pružatelja pohrane. Telegram obrađuje obavijesti prema vlastitim pravilima. Sam paket dodatka ne sadrži analitiku ni izvršne hookove.",
        "retentionTitle": "Dnevnici i lokalne postavke",
        "retention": "Čuvanje operativnih dnevnika i sigurnosnih kopija ovisi o postavkama infrastrukture; ova obavijest ne obećava fiksni rok brisanja tih kopija. Stranica pravila privatnosti sprema odabir jezika lokalno u vašem pregledniku. Pružatelj vašeg asistenta može zasebno čuvati razgovore i rezultate prema vlastitim postavkama i pravilima.",
        "contactTitle": "Pitanja te zahtjevi za pristup ili brisanje",
        "contact": "Za pitanja o privatnosti, pristup, ispravak ili brisanje podataka kojima upravljamo javite se održavatelju putem obrasca za povratne informacije. Navedite oznaku potvrde prijave ili drugu referencu radi pronalaženja zapisa. Zahtjevi se razmatraju prema dostupnim podacima i ograničenjima javne pohrane i trećih strana. Buduće promjene ove obavijesti bit će označene datumom na ovoj stranici.",
        "contactLink": "Kontaktirajte održavatelja / zatražite pregled podataka"
    },
    "sr": {
        "title": "Pravila privatnosti MCP-a",
        "back": "Nazad na mapu",
        "updated": "Ažurirano 25. oktobra 2026.",
        "intro": "Ovo obaveštenje obuhvata hostovanu MCP uslugu Urban Game Theory, njen dodatak za planiranje, privatne veze za pregled i prijave povratnih informacija. Urban Game Theory upravlja aplikacijom Consensus Builder. Pružalac vašeg AI asistenta ima sopstvena pravila privatnosti za vaše razgovore.",
        "requestsTitle": "Zahtevi i njihova svrha",
        "requests": "Obrađujemo argumente koje vaš asistent šalje alatima: na primer pretrage mesta, koordinate, identifikatore parcela ili dizajna, geometriju, naslove i predložene promene. Koristimo ih za pribavljanje podataka, izradu i uređivanje nacrta, poređenje alternativa i vraćanje rezultata. MCP usluga ne traži celu istoriju razgovora ni pristupne podatke naloga i sama ne poziva niti trenira jezički model.",
        "draftsTitle": "Privatni nacrti i veze za pregled",
        "drafts": "Sadržaj nacrta privremeno se čuva na serveru. Reference obično ističu 24 sata posle nastanka ili obnavljanja; istekli zapisi brišu se prilikom čišćenja skladišta. Dostupnost nije zagarantovana. Svako sa celom privatnom referencom može pročitati sadržaj. Te veze nisu zaštićene nalogom niti šifrovane s kraja na kraj: čuvajte ih privatno. Administratori usluge mogu pristupiti sačuvanim podacima.",
        "publicTitle": "Javna objava",
        "public": "Objava dizajna ili plana zahteva izričitu potvrdu. Objavljeni sadržaj, uključujući imena, opise i druge unete podatke, postaje javan. Skladištenje adresirano sadržajem i kopije trećih strana mogu ostati dostupni; ne možemo garantovati uklanjanje svake objavljene kopije. Hostovani MCP ne potpisuje transakcije novčanika niti obavlja plaćanja.",
        "feedbackTitle": "Povratne informacije i obaveštenja preko Telegrama",
        "feedback": "Pri slanju povratne informacije u privatnom sandučetu održavalaca čuvamo tekst, neobaveznu vezu, vrstu i izvor prijave, oznaku potvrde, vremenske oznake i stanje dostave obaveštenja. Izvod prijave i neobavezna veza šalju se održavaocu preko Telegrama. Za povratne informacije trenutno nije podešen automatski istek i mogu ostati sačuvane dok ih održavalac ne ukloni. Uključite samo podatke koje želite da podelite; ne šaljite lozinke, tajne novčanika ni privatne razgovore.",
        "providersTitle": "Infrastruktura i drugi pružaoci",
        "providers": "Hosting, Cloudflare i druga infrastruktura mogu obrađivati podatke o povezivanju i dijagnostici, kao što su IP adrese, traženi URL-ovi, vreme, podaci o pregledaču i greške. Upiti o mestima i lokacijama mogu se proslediti podešenim pružaocima geopodataka; pregled može kontaktirati pružaoce mapa i snimaka. Javna objava koristi podešenog pružaoca skladištenja. Telegram obrađuje obaveštenja prema sopstvenim pravilima. Sam paket dodatka ne sadrži analitiku ni izvršne hookove.",
        "retentionTitle": "Dnevnici i lokalne postavke",
        "retention": "Čuvanje operativnih dnevnika i rezervnih kopija zavisi od postavki infrastrukture; ovo obaveštenje ne obećava fiksni rok brisanja tih kopija. Stranica pravila privatnosti čuva izbor jezika lokalno u vašem pregledaču. Pružalac vašeg asistenta može zasebno čuvati razgovore i rezultate prema sopstvenim postavkama i pravilima.",
        "contactTitle": "Pitanja i zahtevi za pristup ili brisanje",
        "contact": "Za pitanja o privatnosti, pristup, ispravku ili brisanje podataka kojima upravljamo obratite se održavaocu preko obrasca za povratne informacije. Navedite oznaku potvrde prijave ili drugu referencu radi pronalaženja zapisa. Zahtevi se razmatraju prema dostupnim podacima i ograničenjima javnog skladištenja i trećih strana. Buduće promene ovog obaveštenja biće označene datumom na ovoj stranici.",
        "contactLink": "Kontaktirajte održavaoca / zatražite pregled podataka"
    }
};
    if (typeof module === 'object' && module.exports) module.exports = strings;
    if (!root) return;
    for (const [lang, entries] of Object.entries(strings)) root.i18n.registerTranslations(lang,
        Object.fromEntries(Object.entries(entries).map(([key, value]) => [`mcpPrivacy.${key}`, value])));
    function init() {
        const locale = root.document.getElementById('privacy-language');
        locale.value = root.i18n.getLocale();
        locale.addEventListener('change', () => root.i18n.setLanguage(locale.value));
        root.i18n.applyTranslations(root.document);
    }
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})(typeof window !== 'undefined' ? window : null);
