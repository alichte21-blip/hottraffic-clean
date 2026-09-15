# HOT TRAFFIC TAXI — 1.0 CLEAN BUILD

Kompletter Neuaufbau der Oberfläche mit bewusst kleinem Funktionskern.

## Enthalten
- Fahrgast / Fahrer als zwei klar getrennte Modi
- Live-Karte
- Fahrgastbedarf senden und beenden
- Taxi LIVE / Offline mit 30-Sekunden-Heartbeat
- D1-Backend mit bestehender `hottraffic-live` Datenbank
- Standort-Rasterung im Backend
- Share-Funktion
- Premium-Marker ohne Strichmännchen
- Keine Demo-Layer, keine Zeitfenster-Altlogik, keine Bolt/Uber-Logik, kein UI-Patchwork

## Deployment
Das Verzeichnis kann als neues GitHub-Repo verwendet werden. Cloudflare Worker/Assets werden über `wrangler.jsonc` bereitgestellt. Die D1-Bindung `DB` zeigt weiterhin auf `hottraffic-live`.

## Architektur
- `index.html` — reine Struktur
- `style.css` — komplette Oberfläche
- `app.js` — Frontend-Logik
- `worker.js` — API + D1
- `schema.sql` — DB-Schema
- `wrangler.jsonc` — Cloudflare-Konfiguration

## Wichtig
Diese Version ist bewusst die neue Basis. Erweiterungen erst wieder hinzufügen, wenn der Kern stabil getestet ist.


## 1.0.1
- Cloudflare Worker-Name auf `hottraffic-clean` bereinigt, damit Clean Build und Altprojekt eindeutig getrennt bleiben.


## 1.0.2
- Direkter Fahrgast/Fahrer-Wechsel in der unteren Navigation.
- Rolle bleibt nach Reload erhalten.
- Bedarf senden wird nach dem D1-Write über `/api/state` verifiziert.
- Fahrer LIVE wird nach dem D1-Heartbeat über `/api/state` verifiziert.
- Cache-Buster auf 1.0.2.


## 1.0.3 LIVE chain hardening
- Demand expiry now follows the selected time_window (default 30 minutes).
- Ending a demand is verified against /api/state before the UI reports success.
- Stale local demand IDs are automatically reconciled after expiry/end.
