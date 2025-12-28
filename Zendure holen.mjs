let ZENDURE_IP   = "192.168.xxxx";
let ZENDURE_PORT = 80;

function setVirtualNumber(id, val) {
  Shelly.call("Number.Set", { id: id, value: val },
    function(res, err) { if (err) print("VC-Error id=" + id + ": " + JSON.stringify(err)); }
  );
}

function pollZendureAndStore(result, error_code, error_desc) {
  if (error_code !== 0) {
    print("❌ HTTP Error: " + error_code + " - " + (error_desc || "")); 
    return;
  }
  
  if (!result || result.code !== 200 || !result.body) {
    print("❌ HTTP Response invalid: " + JSON.stringify(result)); 
    return;
  }
  
  try {
    let prop = JSON.parse(result.body).properties;
    let soc = prop.electricLevel || 0;
    let chargePower = prop.outputPackPower || 0;      // VC 201: Laden
    let dischargePower = prop.packInputPower || 0;    // VC 202: Entladen
    let acMode = prop.packState || prop.acMode || 0;

    setVirtualNumber(200, soc);
    setVirtualNumber(201, chargePower);
    setVirtualNumber(202, dischargePower);
    setVirtualNumber(203, acMode);

    print("✅ Zendure: SoC=" + soc + "% | LADEN=" + chargePower + 
          "W | Entladen=" + dischargePower + "W | Mode=" + acMode);
  } catch (e) { 
    print("❌ JSON Parse Error: " + e + " | Body: " + result.body.substring(0, 200)); 
  }
}

function startPolling() {
  Shelly.call("HTTP.GET", {
      url: "http://" + ZENDURE_IP + ":" + ZENDURE_PORT + "/properties/report",
      timeout: 5
    }, pollZendureAndStore  // ✅ Callback-Parameter explizit!
  );
}

Timer.set(30000, true, startPolling);
