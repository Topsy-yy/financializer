// Adapter registration. Requiring this module wires the available providers
// into the boundary; `PAYMENT_PROVIDER` then selects which one is used.
const provider = require("./provider");

/* Paystack is the primary provider: it is M-Pesa-native, CBK-licensed, and the
   only option here that SIGNS its webhooks (HMAC-SHA512). See paystack.js. */
provider.register("paystack", require("./paystack"));
/* Direct Daraja stays available for a future volume-driven switch, but it
   cannot sign callbacks, so it is not the default. */
provider.register("mpesa", require("./mpesa"));
/* The deterministic adapter refuses to configure itself outside test and
   development, so registering it here cannot make it usable in production. */
provider.register("test", require("./testAdapter"));

module.exports = provider;
