# Parcel sources, building defaults and recovery

The map and site-to-parcel calculation now select the same official WFS adapters for Buenos Aires
and Belgrade. Buenos Aires uses IDECABA `nam` identities (`AR-CABA-WFS-NAM-…`); Belgrade uses
RGZ `source_parcel_id` identities (`SR-RGZ-DKP-…`) through RGZ's public WFS proxy. These replace the
imported identity namespaces deliberately. Experimental designs using the previous imported
identities must be recreated; no compatibility reader or automatic migration was added.

The user confirmed that RGZ restricts access to Serbian IPs. Requests outside Serbia explain that
restriction and offer the existing continuation without parcels. Actual geometry access from a
Serbian connection has not been verified here. The RGZ proxy relay accepts only the fixed proxy
and its configured cadastral upstream URL.

Cities without a dedicated building source use backend OpenStreetMap, including the three
previous generic Overture database defaults. Dedicated GDI, NYC and Bogotá cadastral providers
remain. Bogotá's fallback is backend OSM. The browser no longer loads Overture building tiles.
OSM's existing staged-data lookup, live provider selection and completeness signals remain in use.
The browser's direct Overpass backup for roads/street life is unchanged.

Parcel failures use the existing recovery dialog directly, without an additional parcel-warning
banner. It retains loaded land, displays known access restrictions and a bounded, sanitized HTTP
status/reason or timeout. Retry remains in the dialog, disables the button and uses the shared
busy spinner. A failed retry updates its message; a successful retry closes the dialog.

The translation loader waits for locale detection and loads English plus the selected dictionary
before revealing translated labels. Other languages load when selected. Missing dictionary keys
leave the readable HTML labels/attributes intact. An unavailable selected dictionary uses English.

## Verification

Live checks used the local API explicitly selected by the browser:

- Buenos Aires binding returned `server:ar-caba-idecaba-wfs-parcelas` and an official native ID.
  A browser viewport retained 107 official parcels, including `AR-CABA-WFS-NAM-02-004-002A`.
  Some viewport cells timed out; the recovery dialog retained loaded parcels and reported counts.
  This verifies the source wiring, not uninterrupted provider availability.
- Paris `/buildings/under` returned `source: osm-footprints`, supported and not truncated, with
  one intersecting building.
- Belgrade's official portal and WFS timed out from the laptop and the European host, consistent
  with the stated restriction. Deterministic browser coverage verifies the restriction message,
  HTTP diagnostic and continuation without parcels. A final live browser also displayed the Serbia restriction, timeout detail and exactly one recovery dialog with no parcel-warning banner; this is not live Serbian-access evidence.

Targeted runs only; none stopped and no full suite:

| Type | Scope | Result |
| --- | --- | --- |
| Headless unit | 9 files: official defaults, source selection, WFS, city buildings, client, credits, membership, OSM, locale | 130 passed |
| Headless unit | 5 files: ground fallback, source health, fallback transport, locale, official defaults | 41 passed; 1 old exact-message assertion updated for HTTP diagnostics |
| Headless unit | 5 files: source health, ground fallback, locale, browser source runtime, WFS | 127 passed; 1 catalogue evidence assertion exposed missing restriction evidence, then corrected |
| Headless unit | browser source runtime, provider relay, source health | 45 passed |
| Headless unit | final source-health, official-default and provider-relay checks | 34 passed |
| Headed Playwright | 6 locale, building-routing and recovery cases | 5 passed; 1 navigation timeout in the new test |
| Headed Playwright | 2 building-routing cases after deterministic tiles | 1 passed; 1 over-broad request matcher also matched local `stack` scripts |
| Headed Playwright | same 2 building-routing cases after matcher correction | 2 passed |
| Headed Playwright | retry spinner and Belgrade restriction/no-parcels flow | 2 passed |
| Headed Playwright | imported GLB Done/save regression | 1 passed |

The shared parcel worker and world coverage metadata were rebuilt. The coverage rebuild changes
only Buenos Aires and Belgrade source metadata.
