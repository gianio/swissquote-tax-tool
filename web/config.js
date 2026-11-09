/*
 * Site configuration. Edit this file when deploying — no code changes needed.
 */
window.APP_CONFIG = {
  // Shown in the header, legal pages link to it.
  productName: "E‑Steuerauszug Generator",

  // Operator / Impressum details — fill in before going public.
  operator: {
    name: "[Name / Firma des Betreibers]",
    address: "[Strasse Nr., PLZ Ort, Schweiz]",
    email: "[kontakt@example.ch]",
  },

  // ---- Paywall ------------------------------------------------------------
  // Charges for the *download* of the generated Steuerauszug (XML / PDF).
  // Disabled for now: downloads are free and no payment UI is shown.
  //
  // To activate:
  //   1. Create a payment link / checkout at a Swiss payment provider that
  //      supports TWINT and cards (e.g. Payrexx, Datatrans, Stripe).
  //      Set its success redirect to  https://<your-domain>/paid.html
  //      (the provider must append ?ref=<reference>&status=success).
  //   2. Deploy a tiny verification endpoint (serverless function) that
  //      answers GET <verifyUrl>?ref=<reference> with {"paid": true} once the
  //      provider's webhook confirmed the payment.
  //   3. Add that endpoint's origin to `connect-src` in the
  //      Content-Security-Policy meta tag of index.html.
  //   4. Set enabled: true.
  //
  // Only the price and a random reference are sent to the provider — never
  // any tax data.
  //
  // Preview the payment dialog without charging: open index.html?paywall=demo
  paywall: {
    enabled: false,
    priceChf: "9.90",
    checkoutUrl: { twint: "", card: "" },
    verifyUrl: "",
  },
};
