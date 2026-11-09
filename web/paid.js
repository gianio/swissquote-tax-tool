// Return page of the payment provider: hand the reference back to the app tab.
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const ref = q.get("ref") || "";
  const status = (q.get("status") || "success").toLowerCase() === "success" ? "success" : "cancelled";
  if (window.opener && ref) {
    window.opener.postMessage({ type: "est-payment", ref, status }, location.origin);
    document.getElementById("t").textContent = status === "success" ? "✓ Zahlung übermittelt" : "Zahlung abgebrochen";
    setTimeout(() => window.close(), 1500);
  } else {
    document.getElementById("t").textContent = "Kein offenes Steuerauszug-Fenster gefunden";
    document.getElementById("m").textContent = "Bitte kehren Sie zum ursprünglichen Fenster zurück.";
  }
})();
