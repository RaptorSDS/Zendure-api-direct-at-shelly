// Script 3: Überarbeitete Regelung + Zendure-Steuerung mit SmartMode und Winter-Backup
// Läuft auf dem Shelly Pro 3EM
// FIXES: Hysterese +50W/-50W, stabile PV-Überschuss-Berechnung (Netz + Akku), acMode=1 (kein 2 außer Sommer-Nacht)

let ZENDURE_IP   = "192.168.xxx";
let ZENDURE_PORT = 80;

// Konfiguration
let MAX_POWER      = 800;  // Max. Ladeleistung (W)
let SUMMER_MIN_SOC = 150;  // 15% in Zehntel %
let WINTER_MIN_SOC = 600;  // 60% in Zehntel %
let SUMMER_NIGHT_W = 150;  // Sommer-Nacht-Entladeleistung (W)
let OFF_THRESHOLD  = 50;   // AUS-Schwelle Bezug (W) <- Hysterese
let ON_THRESHOLD   = -50;  // EIN-Schwelle Einspeisung (W) <- Hysterese
let MIN_POWER      = 50;   // Mindestladeleistung (W)

// SmartMode immer 1
let SMART_MODE = 1;

// Globale Zustände (persistieren über Timer)
let GLOBAL_STATE = {
  isNight: 0,
  dst: 0,
  notladen: 0,  // 0=normal, 1=Notladung aktiv
  pvUeberschussGesamt: 0,  // Stabiler PV-Überschuss (Netz + geschätzte Akku-Ladung)
  laden_aktiv: 0
};

// Shadow für Hysterese und Sends
let shadow = {
  acMode:      null,
  inputLimit:  null,
  outputLimit: null,
  minSoc:      null,
  smartMode:   null
};

// --- Hilfsfunktionen ---
function updateDST() {
  Shelly.call("Sys.GetStatus", {}, function(res, err) {
    if (err) {
      print("Sys.GetStatus error: " + JSON.stringify(err));
      GLOBAL_STATE.dst = 0;
      return;
    }
    GLOBAL_STATE.dst = (res.time && res.time.is_dst) ? 1 : 0;
    print("DST updated: " + GLOBAL_STATE.dst);
  });
}

function getNetPower() {
  let em = Shelly.getComponentStatus("em", 0);
  let p = em.total_act_power;  // >0 = Bezug, <0 = Einspeisung
  print("EM total_act_power: " + p + " W");
  return p;
}

function getIsNight() {
  Shelly.call("Boolean.GetStatus", { id: 200 }, function (res, err) {
    if (err) return;
    let dayVal = res.value;

    Shelly.call("Boolean.GetStatus", { id: 201 }, function (res2, err2) {
      if (err2) return;
      let nightVal = res2.value;
      let isNight = nightVal === true ? 1 : (dayVal === true ? 0 : GLOBAL_STATE.isNight);
      GLOBAL_STATE.isNight = isNight;
      print("isNight updated: " + isNight + " (day=" + dayVal + ", night=" + nightVal + ")");
    });
  });
}

function getSocPercent(cb) {
  Shelly.call("Number.GetStatus", { id: 200 }, function (res, err) {
    if (err) {
      print("SoC error: " + JSON.stringify(err));
      cb(0);
      return;
    }
    let soc = res.value || 0;
    cb(soc);
  });
}

function sendZendure(acMode, inputLimit, outputLimit, minSoc) {
  let body = {
    sn: "HOA1Nxxxxxx,
    properties: {
      acMode:      acMode,
      inputLimit:  inputLimit,
      outputLimit: outputLimit,
      minSoc:      minSoc,
      smartMode:   SMART_MODE
    }
  };

  Shelly.call("HTTP.POST", {
    url: "http://" + ZENDURE_IP + ":" + ZENDURE_PORT + "/properties/write",
    body: JSON.stringify(body),
    content_type: "application/json",
    timeout: 5
  }, function (res, err) {
    if (err || !res) {
      print("Zendure POST error:", JSON.stringify(err || res));
      return;
    }
    print("Zendure OK: " + res.code + " -> ac=" + acMode + " in=" + inputLimit);
  });
}

// --- Haupt-Regelung mit PV-Überschuss-Stabilisierung und Hysterese ---
function mainRegelLoop() {
  let dst     = GLOBAL_STATE.dst;
  let netP    = getNetPower();
  let isNight = GLOBAL_STATE.isNight;
  let minSoc  = dst ? SUMMER_MIN_SOC : WINTER_MIN_SOC;
  let ladenStatusVorher = GLOBAL_STATE.laden_aktiv;

  // 1. PV-ÜBERSCHUSS GESA MT berechnen: netP + geschätzte Akku-Ladung (stabilisiert!)
  let geschPvLadung = shadow.inputLimit || 0;  // Letzte gesetzte inputLimit als Schätzung
  GLOBAL_STATE.pvUeberschussGesamt = Math.max(-netP, 0) + geschPvLadung;  // Immer >=0
  print("PV-Überschuss Gesamt: " + GLOBAL_STATE.pvUeberschussGesamt + " W (netP=" + netP + ", geschAkku=" + geschPvLadung + ")");

  getSocPercent(function (socPercent) {
    let acMode = 1, inputLimit = 0, outputLimit = 0;  // Default: Ladekomfort

    // === WINTER-BACKUP (höchste Priorität) ===
    if (dst === 0 && isNight === 0) {
      if (socPercent < 10 && GLOBAL_STATE.notladen === 0) {
        // START Notladung
        inputLimit = 150;
        GLOBAL_STATE.notladen = 1;
        print("WINTER NOTLADUNG START: SoC=" + socPercent + "% -> 150W");
      } else if (socPercent >= 15 && GLOBAL_STATE.notladen === 1) {
        // STOP Notladung
        GLOBAL_STATE.notladen = 0;
        print("WINTER NOTLADUNG STOP: SoC=" + socPercent + "%");
      }
    }

    if (GLOBAL_STATE.notladen === 1) {
      // Notladung fortsetzen
      inputLimit = 150;
      print("NOTLADUNG AKTIV: 150W");
    } else {
      // === NORMALE ÜBERLADUNG ===
      let ueberschuss = GLOBAL_STATE.pvUeberschussGesamt;  // Stabile Basis!

      // Sommer-Tag: Überschussladen mit Hysterese
      if (dst === 1 && isNight === 0) {
        if (ueberschuss > ON_THRESHOLD * -1 && !ladenStatusVorher) {
          // Noch nicht laden
          GLOBAL_STATE.laden_aktiv = 0;
        } else if ((ueberschuss > ON_THRESHOLD * -1 && ladenStatusVorher) || ueberschuss <= ON_THRESHOLD * -1) {
          // Laden mit Hysterese: Ein bei <= -50W, Aus erst bei >= +50W
          let charge = ueberschuss * 0.5;
          charge = Math.max(MIN_POWER, Math.min(MAX_POWER, charge));
          charge = charge <= 100 ? Math.floor(charge / 10) * 10 : Math.floor(charge / 5) * 5;

          inputLimit = charge;
          GLOBAL_STATE.laden_aktiv = 1;
          print("SOMMER-TAG LADEN: " + inputLimit + "W (Überschuss=" + ueberschuss + ")");
        } else if (ladenStatusVorher && netP > OFF_THRESHOLD) {
          // Hysterese-Aus: Nur bei +50W Bezug stoppen
          inputLimit = 0;
          GLOBAL_STATE.laden_aktiv = 0;
          print("Hysterese AUS: netP=" + netP + "W > +" + OFF_THRESHOLD);
        }

      // Sommer-Nacht: Entladen
      } else if (dst === 1 && isNight === 1) {
        acMode = 2;  // Nur hier!
        outputLimit = SUMMER_NIGHT_W;
        print("SOMMER-NACHT: acMode=2, out=" + outputLimit + "W");

      // Winter: Überschussladen (vereinfacht, da kein Sommer-Nacht)
      } else if (dst === 0) {
        if (ueberschuss > ON_THRESHOLD * -1) {
          let charge = ueberschuss * 0.5;
          charge = Math.max(MIN_POWER, Math.min(MAX_POWER, charge));
          charge = charge <= 100 ? Math.floor(charge / 10) * 10 : Math.floor(charge / 5) * 5;

          inputLimit = charge;
          GLOBAL_STATE.laden_aktiv = 1;
          print("WINTER LADEN: " + inputLimit + "W (Überschuss=" + ueberschuss + ")");
        } else {
          inputLimit = 0;
          GLOBAL_STATE.laden_aktiv = 0;
        }
      }
    }

    // Shadow-Check & Senden (nur bei Änderung)
    if (acMode !== shadow.acMode || inputLimit !== shadow.inputLimit ||
        outputLimit !== shadow.outputLimit || minSoc !== shadow.minSoc) {

      print(">>> SEND: ac=" + acMode + " in=" + inputLimit + " out=" + outputLimit +
            " SoC=" + socPercent + "% notladen=" + GLOBAL_STATE.notladen +
            " laden=" + GLOBAL_STATE.laden_aktiv);

      shadow.acMode = acMode;
      shadow.inputLimit = inputLimit;
      shadow.outputLimit = outputLimit;
      shadow.minSoc = minSoc;

      sendZendure(acMode, inputLimit, outputLimit, minSoc);
    }
  });
}

// Initial & Timer (60s DST/Night, 15s Regelung)
updateDST();
getIsNight();
Timer.set(60000, true, updateDST);
Timer.set(60000, true, getIsNight);
Timer.set(15000, true, mainRegelLoop);
