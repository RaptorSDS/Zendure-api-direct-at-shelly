# Zendure-api-direct-at-shelly

Shelly-Skripte, die einen Zendure-Speicher **direkt über dessen lokale HTTP-API** steuern,
ohne Cloud, Home Assistant oder weiteren Server. Die Skripte laufen auf einem
**Shelly Pro 3EM**, der den Netzbezug misst und daraus die Lade- und Entladeleistung des
Akkus regelt (Nulleinspeisung / Überschussladen).

## Funktionsübersicht

| Betriebsart | Tag (Sonnenaufgang bis Sonnenuntergang) | Nacht |
|-------------|-----------------------------------------|-------|
| **Sommer** (Sommerzeit) | Überschussladen mit Hysterese | Grundlast: feste Entladung mit 150 W |
| **Winter** (Normalzeit) | Überschussladen, Notladung bei SoC < 10 % | Aus (kein Laden, kein Entladen) |

- **Sommer/Winter** wird über die Sommerzeit-Info des Shelly erkannt (`is_dst`).
- **Minimaler SoC** (`minSoc`): Sommer 15 %, Winter 60 %.
- **Überschussladen**: Geladen wird mit der Hälfte des aktuellen Überschusses,
  mindestens 50 W, höchstens 800 W. Die Ladeleistung wird an die Genauigkeit des Zendure
  angepasst: bis 100 W in 10-W-Schritten, darüber in 5-W-Schritten.
- **Hysterese**: Laden startet ab 50 W Einspeisung und stoppt erst ab 50 W Netzbezug.
  Dazwischen bleibt der letzte Zustand erhalten (Merker).
- **Winter-Notladung**: Fällt der SoC im Winter tagsüber unter 10 %, wird mit 150 W aus dem
  Netz geladen, bis 15 % erreicht sind. Währenddessen ist das Überschussladen gesperrt.
- Befehle werden nur an den Zendure geschickt, wenn sich ein Wert geändert hat.

## Dateien

| Datei | Aufgabe |
|-------|---------|
| `Zendure holen.mjs` | Liest alle 30 s die Werte des Zendure (`/properties/report`) und schreibt sie in virtuelle Komponenten des Shelly |
| `Zendure_steuern.mjs` | Regelung: wertet alle 15 s Netzleistung, SoC und Tag/Nacht aus und schreibt die Sollwerte an den Zendure (`/properties/write`) |
| `Zendure_steuern_2.mjs` | Überarbeitete, **experimentelle** Variante der Regelung: berechnet den PV-Überschuss aus Netzleistung plus aktueller Ladeleistung, damit die Regelung ruhiger läuft |

Es wird immer nur **eine** der beiden Steuer-Varianten benötigt.

## Voraussetzungen

- Shelly Pro 3EM mit aktueller Firmware (Skripte und virtuelle Komponenten)
- Zendure-Gerät mit lokaler HTTP-API im selben Netz, möglichst mit fester IP-Adresse
- Seriennummer des Zendure-Geräts (steht in der Zendure-App)

## Einrichtung

### 1. Virtuelle Komponenten im Shelly anlegen

In der Weboberfläche des Shelly Pro 3EM unter *Komponenten* anlegen:

| Typ | ID | Inhalt | wird gesetzt von |
|-----|----|--------|------------------|
| Number | 200 | SoC in % | `Zendure holen.mjs` |
| Number | 201 | Ladeleistung in W | `Zendure holen.mjs` |
| Number | 202 | Entladeleistung in W | `Zendure holen.mjs` |
| Number | 203 | Betriebsmodus des Zendure | `Zendure holen.mjs` |
| Boolean | 200 | Tag | Zeitplan (siehe unten) |
| Boolean | 201 | Nacht | Zeitplan (siehe unten) |

### 2. Tag/Nacht per Zeitplan setzen

Die Steuerskripte lesen Tag/Nacht aus den Booleans 200 und 201. Dazu im Shelly zwei
Zeitpläne anlegen:

- bei **Sonnenaufgang**: Boolean 200 = `true`, Boolean 201 = `false`
- bei **Sonnenuntergang**: Boolean 200 = `false`, Boolean 201 = `true`

Dafür muss der Standort des Shelly eingestellt sein.

### 3. Skripte anpassen

In jedem Skript die IP-Adresse des Zendure eintragen:

```js
let ZENDURE_IP   = "192.168.xxx.xxx";
```

In der Steuerung zusätzlich die Seriennummer in `sendZendure()`:

```js
sn: "SERIENNUMMER",
```

Die übrigen Parameter stehen am Anfang des Steuerskripts:

| Parameter | Standard | Bedeutung |
|-----------|----------|-----------|
| `MAX_POWER` | 800 | maximale Ladeleistung (W) |
| `MIN_POWER` | 50 | minimale Ladeleistung (W) |
| `SUMMER_MIN_SOC` | 150 | minimaler SoC im Sommer, in 0,1 % (150 = 15 %) |
| `WINTER_MIN_SOC` | 600 | minimaler SoC im Winter, in 0,1 % (600 = 60 %) |
| `SUMMER_NIGHT_W` | 150 | Entladeleistung in Sommernächten (W) |
| `ON_THRESHOLD` | -50 | Laden ein ab dieser Netzleistung (W, negativ = Einspeisung) |
| `OFF_THRESHOLD` | 50 | Laden aus ab dieser Netzleistung (W, positiv = Bezug) |

### 4. Skripte installieren

1. Im Shelly unter *Skripte* zwei neue Skripte anlegen und den Inhalt von
   `Zendure holen.mjs` und `Zendure_steuern.mjs` (oder `Zendure_steuern_2.mjs`) einfügen.
2. Beide Skripte starten und **„Beim Start ausführen“** aktivieren.
3. In der Skript-Konsole kontrollieren, ob Werte gelesen (`✅ Zendure: SoC=…`) und
   gesendet (`SEND -> …` bzw. `Zendure OK`) werden.

## Hinweise

- Ein maximaler SoC (z. B. 90 % im Winter) wird von den Skripten nicht gesetzt.
- Netzleistung: positive Werte bedeuten Bezug, negative Werte Einspeisung
  (`total_act_power` des Pro 3EM).
- Nutzung auf eigene Gefahr. Vor dem Dauerbetrieb das Verhalten in der Skript-Konsole
  beobachten.

## Lizenz

[MIT](LICENSE)
