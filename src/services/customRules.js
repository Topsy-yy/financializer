// MOVED. Custom-rule evaluation is rule evaluation, so it lives with the other
// rules under the authoritative registry: src/domain/rules/customRules.js.
//
// It moved in JOB 7 together with the change that makes custom rules emit the
// real Finding/Evidence contract instead of a bare {type, severity, description}
// object. This file re-exports so existing callers keep working; delete it once
// they import from the domain directly.
module.exports = require("../domain/rules/customRules");
