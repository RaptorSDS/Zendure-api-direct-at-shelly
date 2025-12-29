// Script 3: Regelung + Zendure-Steuerung mit SmartMode und Winter-Backup
// Läuft auf dem Shelly Pro 3EM
// IP und Seriennummer setzen !!!!

let ZENDURE_IP   = "192.168.xxxx";
let ZENDURE_PORT = 80;

// Konfiguration (angepasst an dein ESPEasy-Script)
let MAX_POWER      = 800;  // Max. Ladeleistung
let SUMMER_MIN_SOC = 150;  // 15% in Zehntel %
let WINTER_MIN_SOC = 600;  // 60% in Zehntel %
let SUMMER_NIGHT_W = 150;  // Sommer-Nacht-Entladeleistung
let OFF_THRESHOLD  = 50;   // AUS-Schwelle Last (W)
let MIN_POWER      = 50;   // Mindestladeleistung (W)
let ON_THRESHOLD   = -50;  // Einspeise-Schwelle (W)

// SmartMode immer 1 senden
let SMART_MODE = 1;

// Shadow zur Hysterese für Sends
let shadow = {
  acMode:      null,
  inputLimit:  null,
  outputLimit: null,
  minSoc:      null,
  smartMode:   null
};

let laden_aktiv = 0;

// globaler Zustand
let GLOBAL_STATE = {
  isNight: 0,
  dst: 0,
  notladen: 0  // 0=normal, 1=Notladung aktiv
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
  });
}

function getNetPower() {
  let em = Shelly.getComponentStatus("em", 0);  // Pro 3EM
  let p = em.total_act_power;                  // W, >0 = Bezug, <0 = Einspeisung
  print("EM status:", JSON.stringify(em));
  print("Net power p =", p, "W");
  return p;
}

// isNight aus lokalen Boolean 200/201 auf diesem 3EM ableiten
function getIsNight() {
  Shelly.call("Boolean.GetStatus", { id: 200 }, function (res, err) {
    if (err) {
      print("Boolean 200 get error: " + JSON.stringify(err));
      return;
    }
    let dayVal = res.value; // true/false

    Shelly.call("Boolean.GetStatus", { id: 201 }, function (res2, err2) {
      if (err2) {
        print("Boolean 201 get error: " + JSON.stringify(err2));
        return;
      }
      let nightVal = res2.value;

      let isNight = 0;
      if (nightVal === true) {
        isNight = 1;
      } else if (dayVal === true) {
        isNight = 0;
      }

      GLOBAL_STATE.isNight = isNight;
      print(
        "Local Booleans -> isNight=" +
          isNight +
          " (b200=" +
          dayVal +
          ", b201=" +
          nightVal +
          ")"
      );
    });
  });
}

// SoC aus virtueller Number 200 holen (Script 2)
function getSocPercent(cb) {
  Shelly.call("Number.GetStatus", { id: 200 }, function (res, err) {
    if (err) {
      print("Number 200 get error (SoC): " + JSON.stringify(err));
      cb(0);
      return;
    }
    let soc = res.value || 0; // 0..100
    cb(soc);
  });
}

// Zendure ansteuern
function sendZendure(acMode, inputLimit, outputLimit, minSoc) {
  let body = {
    sn: "xxxx",
    properties: {
      acMode:      acMode,
      inputLimit:  inputLimit,
      outputLimit: outputLimit,
      minSoc:      minSoc,
      smartMode:   SMART_MODE
    }
  };

  Shelly.call(
    "HTTP.POST",
    {
      url: "http://" + ZENDURE_IP + ":" + ZENDURE_PORT + "/properties/write",
      body: JSON.stringify(body),
      content_type: "application/json",
      timeout: 5
    },
    function (res, err) {
      if (err || !res) {
        print("Zendure HTTP POST error:", JSON.stringify(err || res));
        return;
      }
      print("Zendure write:", res.code, res.body);
    }
  );
}

// --- Haupt-Regel-Loop ---
function mainRegelLoop() {
  let dst     = GLOBAL_STATE.dst;
  let netP    = getNetPower();
  let isNight = GLOBAL_STATE.isNight;
  let minSoc  = dst ? SUMMER_MIN_SOC : WINTER_MIN_SOC;

  getSocPercent(function (socPercent) {
    let acMode, inputLimit, outputLimit;

    // === WINTER-BACKUP-LOGIK (Höchste Priorität) ===
    if (dst === 0 && isNight === 0) {
      if (socPercent < 10 && GLOBAL_STATE.notladen === 0) {
        // START Notladung
        acMode      = 1;
        inputLimit  = 150;
        outputLimit = 0;
        minSoc      = 150;
        GLOBAL_STATE.notladen = 1;
        print("WINTER-BACKUP: SOC < 10%, Notladung GESTARTET -> Ziel 15%");
      } 
      else if (socPercent >= 15 && GLOBAL_STATE.notladen === 1) {
        // STOP Notladung
        acMode      = 1;
        inputLimit  = 0;
        outputLimit = 0;
        GLOBAL_STATE.notladen = 0;
        minSoc      = WINTER_MIN_SOC;
        print("WINTER-BACKUP: SOC >= 15%, Notladung BEENDET");
      }
    }

    // === NOTLADUNG AKTIV? -> Überschussladen BLOCKIEREN ===
    if (GLOBAL_STATE.notladen === 1) {
      // Notladung läuft weiter (auch wenn SoC jetzt >=15%)
      acMode      = 1;
      inputLimit  = 150;
      outputLimit = 0;
      minSoc      = 150;
      print("WINTER-BACKUP: Notladung AKTIV, Überschussladen blockiert");
    }

    // === NORMALE REGELUNG (nur wenn notladen=0) ===
    if (GLOBAL_STATE.notladen === 0 && acMode === undefined) {

      // SOMMER
      if (dst === 1) {
        if (isNight === 1) {
          // Nacht: feste Entladeleistung
          acMode      = 2;
          inputLimit  = 0;
          outputLimit = SUMMER_NIGHT_W;
        } else {
          // Tag: dynamisches Überschussladen
          if (netP < ON_THRESHOLD) {
            let charge = netP * -0.5;
            if (charge < MIN_POWER) charge = MIN_POWER;
            if (charge <= 100) {
              charge = Math.floor(charge / 10) * 10;
            } else {
              charge = Math.floor(charge / 5) * 5;
            }
            if (charge > MAX_POWER) charge = MAX_POWER;

            acMode      = 1;
            inputLimit  = charge;
            outputLimit = 0;
            laden_aktiv = 1;
          } else {
            if (laden_aktiv === 1 && netP > OFF_THRESHOLD) {
              acMode      = 1;
              inputLimit  = 0;
              outputLimit = 0;
              laden_aktiv = 0;
            } else {
              acMode      = shadow.acMode;
              inputLimit  = shadow.inputLimit;
              outputLimit = shadow.outputLimit;
            }
          }
        }

      // WINTER - Überschussladen (nur wenn notladen=0)
      } else {
        if (netP < -50) {
          let charge = netP * -0.5;
          if (charge < MIN_POWER) charge = MIN_POWER;
          if (charge <= 100) {
            charge = Math.floor(charge / 10) * 10;
          } else {
            charge = Math.floor(charge / 5) * 5;
          }
          if (charge > MAX_POWER) charge = MAX_POWER;

          acMode      = 1;
          inputLimit  = charge;
          outputLimit = 0;
          laden_aktiv = 1;
        } else {
          acMode      = 1;
          inputLimit  = 0;
          outputLimit = 0;
          laden_aktiv = 0;
        }
      }
    }

    // Fallback wenn nichts gesetzt
    if (acMode === undefined) {
      acMode      = 1;
      inputLimit  = 0;
      outputLimit = 0;
      minSoc      = dst ? SUMMER_MIN_SOC : WINTER_MIN_SOC;
    }

    // Shadow-Check und Zendure-Senden
    if (
      acMode      !== shadow.acMode ||
      inputLimit  !== shadow.inputLimit ||
      outputLimit !== shadow.outputLimit ||
      minSoc      !== shadow.minSoc ||
      SMART_MODE  !== shadow.smartMode
    ) {
      print(
        "SEND -> acMode=" +
          acMode +
          " in=" +
          inputLimit +
          " out=" +
          outputLimit +
          " minSoc=" +
          minSoc +
          " notladen=" +
          GLOBAL_STATE.notladen
      );

      shadow.acMode      = acMode;
      shadow.inputLimit  = inputLimit;
      shadow.outputLimit = outputLimit;
      shadow.minSoc      = minSoc;
      shadow.smartMode   = SMART_MODE;

      sendZendure(acMode, inputLimit, outputLimit, minSoc);
    }
  });
}

// Timer
Timer.set(60000, true, getIsNight);
Timer.set(60000, true, updateDST);
Timer.set(15000, true, mainRegelLoop);
