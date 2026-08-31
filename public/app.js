/* ═══════════════════════════════════════════════════════════════
   FinGuard — Application Logic
   Premium Dark Dashboard SPA
   ═══════════════════════════════════════════════════════════════ */

/* ── 1. DOM References ───────────────────────────────────────── */
var $pageContent    = document.getElementById('page-content');
var $pageTabs       = document.getElementById('page-tabs');
var $pageTitle      = document.getElementById('page-title');
var $companyContext = document.getElementById('company-context');
var $analysisMonth  = document.getElementById('analysis-month');
var $navLinks       = document.getElementById('nav-links');
var $signupOverlay  = document.getElementById('signup-overlay');
var $signupForm     = document.getElementById('signup-form');
var $btnZohoOauth   = document.getElementById('btn-zoho-oauth');
var $btnZohoContinue = document.getElementById('btn-zoho-continue');
var $btnDemo        = document.getElementById('btn-demo-mode');
var $btnLoginGoogle = document.getElementById('btn-login-google');
var $btnSkipDatasource = document.getElementById('btn-skip-datasource');
var $googleAuthUnavailableHint = document.getElementById('google-auth-unavailable-hint');
var $onboardStepWelcome = document.getElementById('onboard-step-welcome');
var $onboardStep1   = document.getElementById('onboard-step-1');
var $onboardStep2   = document.getElementById('onboard-step-2');
var $onboardStep3   = document.getElementById('onboard-step-3');
var $onboardingProgress = document.getElementById('onboarding-progress');
var $progStep1      = document.getElementById('prog-step-1');
var $progStep2      = document.getElementById('prog-step-2');
var $progStep3      = document.getElementById('prog-step-3');
var $progConnector1 = document.getElementById('prog-connector-1');
var $progConnector2 = document.getElementById('prog-connector-2');
var $themeToggle    = document.getElementById('theme-toggle');
var $profileToggle  = document.getElementById('profile-toggle');
var $profilePopover = document.getElementById('profile-popover');
var $profileContent = document.getElementById('profile-content');
var $refreshProfile = document.getElementById('refresh-profile');
var $toastContainer = document.getElementById('toast-container');
var $status         = document.getElementById('status');

/* ── 2. Application State ────────────────────────────────────── */
var appState = {
  activeMonth: null,
  /* Has an analysis actually run for this session? Distinguishes "nothing
     flagged" from "nothing examined", which must never read the same. */
  hasAnalysis: false,
  /* True when the figures on screen come from the demo dataset. */
  isDemoData: false,
  /* The authoritative capability map from /api/account/entitlements. The UI
     renders locks from this; the backend enforces the same rules independently. */
  account: null,
  plannedCapabilities: [],
  /* Periods the tenant ACTUALLY has, from /api/analysis/periods — so the month
     picker offers real data instead of twelve generated calendar months. */
  availablePeriods: null,
  cachedData: null,
  userName: 'Aisha',
  businessName: 'ABC Traders Ltd',
  zohoApiKey: '',
  walletAddress: '',
  walletVerified: false,
  walletChainId: null,
  networks: [],
  aiProvider: 'openai',
  aiApiKey: '',
  aiApiKeyConfigured: false,
  aiApiKeyPreview: '',
  aiAssistant: 'controller-core',
  chatHistory: [],
  // Copilot conversation identity, so a follow-up resolves "this"/"that"
  // server-side against the entities the conversation established.
  copilotConversationId: null,
  // A finding the user selected to ask about; applies to ONE question.
  copilotFindingId: null,
  currentPage: 'overview',
  pageTab: {},
  isLoading: false
};

/* ── 3. Icon Library (inline SVG, currentColor) ──────────────── */
var ICONS = {
  home:            '<path d="M3 11.5L12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
  'bar-chart':      '<rect x="4" y="10" width="4" height="10" rx="0.5"/><rect x="10" y="4" width="4" height="16" rx="0.5"/><rect x="16" y="13" width="4" height="7" rx="0.5"/>',
  wallet:           '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"/>',
  'trending-up':    '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  shield:           '<path d="M12 2 20 6v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z"/>',
  'shield-alert':   '<path d="M12 2 20 6v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z"/><line x1="12" y1="8" x2="12" y2="12.5"/><line x1="12" y1="15.5" x2="12.01" y2="15.5"/>',
  building:         '<rect x="4" y="3" width="16" height="18" rx="1"/><rect x="7" y="6.5" width="2.5" height="2.5"/><rect x="14.5" y="6.5" width="2.5" height="2.5"/><rect x="7" y="11.5" width="2.5" height="2.5"/><rect x="14.5" y="11.5" width="2.5" height="2.5"/><rect x="9.75" y="16.5" width="4.5" height="4.5"/>',
  users:            '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'check-circle':   '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'file-text':      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
  clipboard:        '<path d="M9 2h6a1 1 0 0 1 1 1v1H8V3a1 1 0 0 1 1-1z"/><rect x="5" y="4" width="14" height="18" rx="2"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
  bot:              '<rect x="4" y="8" width="16" height="12" rx="2"/><line x1="12" y1="2" x2="12" y2="8"/><circle cx="12" cy="2" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="13.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.3" fill="currentColor" stroke="none"/><line x1="8" y1="18" x2="16" y2="18"/>',
  settings:         '<circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="7.05" y2="16.95"/><line x1="16.95" y1="7.05" x2="19.07" y2="4.93"/>',
  moon:             '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  user:             '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  save:             '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  download:         '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  'alert-triangle': '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  search:           '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'pie-chart':      '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  calendar:         '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock:            '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'x-circle':       '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  briefcase:        '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  'book-open':      '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  lock:             '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  link:             '<path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 6"/><path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.4a5 5 0 0 0 7.07 7.07L14 18"/>',
  flask:            '<path d="M9 2v6.5L4.5 17a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L15 8.5V2"/><line x1="8" y1="2" x2="16" y2="2"/><line x1="7" y1="14" x2="17" y2="14"/>',
  send:             '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  sliders:          '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  play:             '<polygon points="5 3 19 12 5 21 5 3"/>',
  'arrow-right':    '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  'trending-down':  '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
  minus:            '<line x1="5" y1="12" x2="19" y2="12"/>',
  info:             '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
};

function icon(name, opts) {
  opts = opts || {};
  var body = ICONS[name] || '';
  var cls = 'icon' + (opts.cls ? ' ' + opts.cls : '');
  return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="' + (opts.strokeWidth || 1.75) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>';
}

/* ── 4. Utilities ────────────────────────────────────────────── */
function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function severityClass(severity) {
  if (!severity) return 'badge-info';
  var s = severity.toLowerCase();
  if (s === 'critical' || s === 'high') return 'badge-high';
  if (s === 'medium') return 'badge-medium';
  if (s === 'low') return 'badge-low';
  return 'badge-info';
}

function severityDotClass(severity) {
  if (!severity) return 'dot-info';
  var s = severity.toLowerCase();
  if (s === 'critical') return 'dot-critical';
  if (s === 'high') return 'dot-high';
  if (s === 'medium') return 'dot-medium';
  if (s === 'low') return 'dot-low';
  return 'dot-info';
}

/**
 * THE SCORE BANDS, fetched from the server's rules registry.
 *
 * JOB 7 carry-forward: the client used its own 70/40 cut-offs while the registry
 * defines 80/60/40/20, so a score of 62 the engine calls "Good" was painted
 * amber and captioned "Needs attention". The bands now come from
 * GET /api/methodology, which generates them from the registry — one source of
 * truth, as everywhere else.
 *
 * Until that response arrives the client shows a neutral state rather than
 * guessing: an unknown band is not a reason to invent a colour.
 */
var SCORE_BANDS = null;

function loadScoreBands() {
  /* `api()` was never defined anywhere in this file — this was the only call to
     it, and it threw a synchronous ReferenceError as the FIRST statement of
     init(), taking checkOnboarding() and every loader after it down with it.
     The visible symptom was "Log in is not configured on this server yet" on a
     server where Google auth was configured and working: appState.authSession
     was simply never assigned. Every other request here uses fetch directly. */
  return fetch('/api/methodology')
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res && res.methodology && res.methodology.scoring) {
        SCORE_BANDS = res.methodology.scoring.categories || null;
      }
    })
    .catch(function () { /* neutral rendering is the fallback, never a guess */ });
}

/** The registry's label for a score, or null if the bands are not loaded. */
function scoreCategory(score) {
  if (!SCORE_BANDS || score == null || isNaN(score)) return null;
  for (var i = 0; i < SCORE_BANDS.length; i++) {
    var band = SCORE_BANDS[i];
    if (band.atOrAbove == null || score >= band.atOrAbove) return band.label;
  }
  return null;
}

/** Colour from the registry's LABEL, never from a client-side threshold. */
function categoryClass(label) {
  if (!label) return 'text-muted';
  if (/excellent|good/i.test(label)) return 'text-emerald';
  if (/fair/i.test(label)) return 'text-amber';
  if (/poor|critical/i.test(label)) return 'text-red';
  return 'text-muted';
}

function scoreBarClass(score) {
  var label = scoreCategory(score);
  if (label) {
    if (/excellent|good/i.test(label)) return 'score-high';
    if (/fair/i.test(label)) return 'score-mid';
    return 'score-low';
  }
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-mid';
  return 'score-low';
}

var MAX_VISIBLE_TOASTS = 3;

var USER_ERROR_MESSAGES = {
  internal_error: 'Something went wrong on our side. Please try again.',
  invalid_period: 'Please choose a valid month and try again.',
  no_data_source: 'No financial source is connected yet. Connect one or upload files first.',
  zoho_fetch_failed: 'We could not fetch your latest records. Please reconnect and try again.',
  persistence_unavailable: 'Your data service is temporarily unavailable. Please try again shortly.',
  records_unavailable: 'We could not load these records right now. Please try again.',
  analysis_unavailable: 'We could not load this analysis right now. Please try again.',
  analysis_index_unavailable: 'We could not load saved analyses right now. Please try again.',
  no_completed_analysis: 'No completed analysis was found for this period yet.',
  no_such_run: 'This saved analysis could not be found anymore.',
  no_such_record: 'This record could not be found anymore.',
  no_such_finding: 'This finding could not be found anymore.',
  legacy_unrecoverable: 'This historical analysis cannot be reloaded. Please run a fresh monthly review.',
  billing_unavailable: 'Billing is temporarily unavailable. Please try again later.',
  payment_unavailable: 'Online payment is not available at the moment. Please contact support.',
  payment_initiation_failed: 'We could not start your payment. Please try again.',
  no_such_payment: 'That payment request could not be found.',
  phone_required: 'Please enter a phone number to continue.',
  checkout_failed: 'We could not complete checkout. Please try again.',
  mail_not_configured: 'Email delivery is not available right now.',
  email_failed: 'We could not send this email. Please try again.',
  no_recipient: 'Please enter at least one recipient email address.',
  no_report: 'Please run a monthly review before doing this action.',
  csrf_token_missing: 'Your session expired. Please refresh the page and try again.',
  csrf_token_invalid: 'Your session could not be verified. Please refresh and try again.',
  rate_limited: 'Too many requests in a short time. Please wait a moment and try again.',
  upgrade_required: 'This feature is not included in your current plan yet.',
  forbidden: 'You do not have permission to perform this action.',
  entitlements_unavailable: 'Plan details are temporarily unavailable. Please try again.',
  plan_not_purchasable: 'This plan is currently unavailable for purchase.',
  connection_error: 'Connection issue detected. Please check your network and try again.'
};

function sanitizeTechTerms(text) {
  return String(text || '')
    .replace(/\baccess key\b/gi, 'access key')
    .replace(/\bOAuth\b/g, 'secure sign-in')
    .replace(/\bCSRF\b/g, 'security check')
    .replace(/\bprovider\b/gi, 'service')
    .replace(/\bmodel\b/gi, 'assistant mode')
    .replace(/\bBYOK\b/g, 'custom key mode')
    .replace(/\bOpenAI\b|\bAnthropic\b|\bGemini\b|\bMistral\b|\bNVIDIA\b|\bxAI\b|\bDeepSeek\b|\bAzure OpenAI\b/g, 'connected service')
    .replace(/\bAI\b/g, 'smart')
    .replace(/smart smart/g, 'smart');
}

function humanizeErrorCode(code) {
  if (!code) return '';
  return String(code)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
}

function resolveUserError(payload, fallback) {
  var errorCode = payload && payload.error ? String(payload.error) : '';
  var detail = payload && payload.detail ? String(payload.detail) : '';
  var message = payload && payload.message ? String(payload.message) : '';
  if (errorCode && USER_ERROR_MESSAGES[errorCode]) return USER_ERROR_MESSAGES[errorCode];
  if (detail) return sanitizeTechTerms(detail);
  if (message) return sanitizeTechTerms(message);
  if (errorCode) return humanizeErrorCode(errorCode) + '.';
  return fallback || 'Something went wrong. Please try again.';
}

function showToast(message, type) {
  type = type || 'info';
  message = sanitizeTechTerms(message);
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.innerHTML =
    '<span>' + escapeHtml(message) + '</span>' +
    '<button class="toast-dismiss" onclick="dismissToast(this)">&times;</button>';
  $toastContainer.appendChild(toast);

  while ($toastContainer.children.length > MAX_VISIBLE_TOASTS) {
    $toastContainer.removeChild($toastContainer.firstElementChild);
  }

  setTimeout(function() {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 4000);
}

function dismissToast(btn) {
  var toast = btn.closest('.toast');
  if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
}

/* Surfaces WHY the AI didn't run, instead of silently falling back to
   rule-based analysis and leaving the user wondering if their key is even
   being used. 'missing_ai_api_key' is intentionally quiet -- that's just
   "no key configured yet", not a failure. */
var AI_FAILURE_MESSAGES = {
  rate_limited: 'Live guidance is temporarily busy. We are showing computed insights instead.',
  invalid_api_key: 'Your access key was not accepted. Update it in Settings and try again.',
  model_not_found: 'The selected guidance mode is unavailable. Please choose another mode in Settings.',
  insufficient_balance: 'Your connected service account has no remaining balance.',
  provider_unavailable: 'Live guidance is temporarily unavailable. We are showing computed insights instead.',
  unparseable_response: 'We could not process the guidance response. We are showing computed insights instead.',
  timeout: 'Live guidance took too long to respond. We are showing computed insights instead.',
  request_failed: 'We could not reach the guidance service. We are showing computed insights instead.',
  ai_analysis_disabled: 'Live guidance is currently turned off on this server.',
  insufficient_credits: 'You have used your guidance allowance for the current cycle. The core analysis below still works fully.',
  managed_key_unavailable: 'Live guidance is not configured on this server yet.'
};

function notifyAiFailureIfAny(aiAnalysis) {
  if (!aiAnalysis || aiAnalysis.ok || aiAnalysis.reason === 'missing_ai_api_key' || aiAnalysis.reason === 'ai_not_requested') return;
  var message = AI_FAILURE_MESSAGES[aiAnalysis.reason] || ('Live guidance is unavailable right now. Showing computed insights instead.');
  showToast(message, aiAnalysis.reason === 'insufficient_credits' ? 'info' : 'warning');
}

/* ── Plan & guidance credits (entitlements) ────────────────────────── */
/* ── Plan features (server is authoritative; this only renders state) ──
   Premium capabilities are shown locked rather than hidden, so users discover
   them naturally while using the app. */
function planAllows(feature) {
  var e = appState.entitlement;
  if (!e || !e.features) return true; /* until loaded, don't flash a lock */
  return e.features[feature] !== false;
}
function featureCopy(feature, fallback) {
  var e = appState.entitlement;
  return (e && e.feature_copy && e.feature_copy[feature]) || fallback || 'This capability';
}
/* What a capability contains — defined server-side so the promise shown to the
   user lives beside the gate that enforces it. */
function featureDetails(feature) {
  var e = appState.entitlement;
  return (e && e.feature_details && e.feature_details[feature]) || [];
}
/* The Starter-vs-Growth positioning, also server-supplied. */
function productBoundary() {
  var e = appState.entitlement;
  return (e && e.product_boundary) || {
    starter: { verb: 'Explains', scope: 'Current state', role: 'Monitoring', question: 'What is happening in my business?' },
    growth: { verb: 'Recommends', scope: 'Future decisions', role: 'Growth Advisor', question: 'What should I do next?' }
  };
}
/* Is this capability entitled but not yet built? Server-supplied, so the UI can
   say "coming soon" instead of implying a missing screen. */
function featurePlanned(feature) {
  var e = appState.entitlement;
  var req = e && e.feature_requirements && e.feature_requirements[feature];
  return Boolean(req && req.planned);
}
/* Which plan unlocks a capability — supplied by the server so the UI never
   hardcodes a tier name. */
function featureRequiredPlan(feature) {
  var e = appState.entitlement;
  var req = e && e.feature_requirements && e.feature_requirements[feature];
  return (req && req.plan_label) || 'Growth';
}
function upgradeMessage(feature) {
  var plan = featureRequiredPlan(feature);
  var tail = plan === 'Accountant Workspace'
    ? ' is available on the Accountant Workspace plan.'
    : ' is available on the ' + plan + ' and Custom Guidance plans.';
  return featureCopy(feature) + tail;
}
function lockIcon() {
  return icon('lock', { cls: 'lock-ic' });
}
/* A locked premium feature presented in place, with what it unlocks. */
function lockedFeatureCard(feature, title, description, bullets) {
  if (!bullets || !bullets.length) bullets = featureDetails(feature);
  var html = '<div class="glass-card locked-feature">' +
    '<div class="locked-head">' + lockIcon() +
      '<div><div class="locked-title">' + escapeHtml(title) + '</div>' +
      '<div class="locked-sub">' + escapeHtml(description) + '</div></div>' +
      '<span class="locked-badge">' + escapeHtml(featureRequiredPlan(feature)) + '</span>' +
    '</div>';
  if (bullets && bullets.length) {
    html += '<ul class="locked-list">';
    bullets.forEach(function(b) { html += '<li>' + escapeHtml(b) + '</li>'; });
    html += '</ul>';
  }
  html += '<div class="locked-actions">' +
      '<button type="button" class="btn-primary btn-small" onclick="showUpgradeModal(\'' +
        escapeHtml(upgradeMessage(feature)) + '\')">Unlock with ' + escapeHtml(featureRequiredPlan(feature)) + '</button>' +
      '<button type="button" class="btn-ghost btn-small" onclick="navigate(\'settings\');switchSettingsSection(\'plan\');">Compare plans</button>' +
    '</div></div>';
  return html;
}

/* Sidebar upgrade card — shown only when the current plan is actually missing
   a capability, so a Growth/Workspace user never sees an upsell. */
function renderUpgradeCard() {
  var card = document.getElementById('upgrade-card');
  if (!card) return;
  var e = appState.entitlement;
  if (!e || !e.features) { card.classList.add('hidden'); return; }
  /* Only advertise capabilities that are BOTH locked and actually built. A
     Growth user's only locked capabilities are Workspace ones that do not exist
     yet, so they correctly see no upsell at all. */
  var locked = Object.keys(e.features).filter(function(k) {
    return e.features[k] === false && !featurePlanned(k);
  });
  if (!locked.length) { card.classList.add('hidden'); return; }

  var target = featureRequiredPlan(locked[0]);
  var title = document.getElementById('upgrade-card-title');
  var text = document.getElementById('upgrade-card-text');
  if (title) title.textContent = 'Upgrade to ' + target;
  if (text) {
    /* Describe up to three genuinely locked capabilities — never features the
       user already has. */
    var names = locked.slice(0, 3).map(function(k) { return featureCopy(k); });
    text.textContent = names.length
      ? 'Unlock ' + names.join(', ') + '.'
      : 'Unlock more advanced guidance features.';
  }
  card.classList.remove('hidden');
}

function renderCreditsChip() {
  var chip = document.getElementById('credits-chip');
  if (!chip) return;
  var e = appState.entitlement;
  if (!e) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  if (e.byok) {
    chip.innerHTML = icon('bot') + ' Custom Guidance';
    chip.title = 'Using your own access key with no monthly guidance cap.';
  } else {
    chip.innerHTML = icon('bot') + ' ' + escapeHtml(e.plan_label) + ' · ' + e.credits + ' guidance credits';
    chip.title = e.credits + ' of ' + e.allowance + ' guidance credits left in the current cycle.';
  }
}

function loadEntitlement() {
  return fetch('/api/entitlement').then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) { appState.entitlement = d.entitlement; renderCreditsChip(); renderUpgradeCard(); }
    return appState.entitlement;
  }).catch(function() { return null; });
}

function setPlan(plan) {
  return fetch('/api/plan', {
    method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ plan: plan })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) {
      appState.entitlement = d.entitlement;
      renderCreditsChip();
      renderUpgradeCard();
      showToast('Plan set to ' + d.entitlement.plan_label, 'success');
      if (appState.currentPage === 'settings' && routes.settings) routes.settings.render();
    } else {
      showToast('Could not change plan.', 'error');
    }
    return d;
  }).catch(function() { showToast('Could not change plan.', 'error'); });
}


/* ═══════════════════════════════════════════════════════════════
   PLANS & BILLING
   Every price, plan name and capability shown here comes from the server.
   This file contains no plan catalog of its own — a second definition is a
   second source of truth, and billing cannot survive one.
   ═══════════════════════════════════════════════════════════════ */

var billingState = { plans: null, payment: null, poll: null };

async function loadBilling() {
  var el = document.getElementById('billing-body');
  if (!el) return;
  try {
    var res = await fetch('/api/billing/plans');
    var data = await res.json();
    if (!data.ok) { el.innerHTML = '<p class="text-sm text-muted">Plans unavailable.</p>'; return; }
    billingState.plans = data;
    renderBilling();
  } catch (e) {
    el.innerHTML = '<p class="text-sm text-muted">Could not load plans.</p>';
  }
}

function renderBilling() {
  var el = document.getElementById('billing-body');
  if (!el || !billingState.plans) return;
  var d = billingState.plans;
  var acct = appState.account || {};
  var h = '';

  /* CURRENT PLAN, with its real state — not a label guessed from a stored
     field. `source` distinguishes a paid subscription from the free floor. */
  if (acct.plan_label) {
    h += '<div class="plan-current text-sm">Current plan: <strong class="text-brand-bright">'
      + escapeHtml(acct.plan_label) + '</strong>'
      + (acct.status && acct.status !== 'none' ? ' · ' + escapeHtml(acct.status) : '')
      + (acct.expires_at ? ' · renews ' + escapeHtml(String(acct.expires_at).slice(0, 10)) : '')
      + '</div>';
  }

  /* PAYMENT UNAVAILABLE IS SAID PLAINLY. The plans are still shown — the user
     should know what exists — but no checkout is offered that cannot complete,
     and nothing pretends a payment succeeded. */
  if (!d.payment.available) {
    h += '<div class="callout-warning" style="margin:0.75rem 0;">'
      + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
      + '<div class="callout-warning-text">Online payment is not set up on this '
      + 'server yet, so upgrading is unavailable here.</div></div>';
  }

  h += '<div class="plan-grid">';
  (d.plans || []).forEach(function (p) {
    var isCurrent = acct.plan === p.key;
    h += '<div class="plan-card' + (isCurrent ? ' plan-card-current' : '') + '">'
      + '<div class="plan-card-name">' + escapeHtml(p.label) + '</div>'
      + '<div class="plan-card-price">' + escapeHtml(p.currency) + ' '
      + Number(p.price).toLocaleString() + '<span class="text-muted text-sm">/'
      + escapeHtml(String(p.period_days)) + ' days</span></div>'
      + '<div class="text-sm text-muted">' + Number(p.allowance).toLocaleString()
      + ' guidance credits per cycle</div>';

    /* WHAT IT ADDS, from the entitlement map the server sent. Nothing is
       advertised that the catalog does not actually grant. */
    var adds = (acct.features && billingState.plans.plans)
      ? Object.keys(acct.features).filter(function (k) { return acct.features[k] === false; })
      : [];
    if (!isCurrent && adds.length) {
      h += '<ul class="plan-card-adds">';
      adds.slice(0, 5).forEach(function (k) {
        h += '<li>' + escapeHtml(featureCopy(k))
          + (featurePlanned(k) ? ' <span class="cap-soon">coming soon</span>' : '') + '</li>';
      });
      h += '</ul>';
    }

    h += isCurrent
      ? '<div class="text-sm text-emerald">Your current plan</div>'
      : (d.payment.available
        ? '<button type="button" class="btn-primary btn-full" onclick="startCheckout(\''
          + escapeHtml(p.key) + '\')">Upgrade to ' + escapeHtml(p.label) + '</button>'
        : '<button type="button" class="btn-secondary btn-full" disabled>Unavailable</button>');
    h += '</div>';
  });
  h += '</div>';

  if (acct.source === 'subscription') {
    h += '<div style="margin-top:1rem;"><button type="button" class="btn-ghost btn-small" '
      + 'onclick="cancelSubscription()">Cancel subscription</button></div>';
  }

  h += '<div id="checkout-area"></div>';
  el.innerHTML = h;
}

/** Collect the phone number and start an M-Pesa prompt. */
function startCheckout(planKey) {
  var area = document.getElementById('checkout-area');
  if (!area) return;
  var plan = (billingState.plans.plans || []).filter(function (p) { return p.key === planKey; })[0];
  if (!plan) return;

  area.innerHTML = '<div class="glass-card section-gap">'
    + '<div class="card-title">Pay for ' + escapeHtml(plan.label) + '</div>'
    /* The amount is DISPLAYED from the server's catalog and sent nowhere — the
       server prices the checkout from the plan key alone. */
    + '<p class="text-sm text-muted">You will be charged ' + escapeHtml(plan.currency)
    + ' ' + Number(plan.price).toLocaleString() + ' for ' + escapeHtml(String(plan.period_days))
    + ' days.</p>'
    + '<label class="settings-label">M-Pesa phone number</label>'
    + '<input type="tel" class="settings-input" id="checkout-phone" placeholder="07XX XXX XXX" />'
    + '<div style="margin-top:0.75rem;">'
    + '<button type="button" class="btn-primary" onclick="submitCheckout(\''
    + escapeHtml(planKey) + '\')">Send payment request</button> '
    + '<button type="button" class="btn-ghost" onclick="document.getElementById(\'checkout-area\').innerHTML=\'\'">Cancel</button>'
    + '</div><div id="checkout-status" class="text-sm" style="margin-top:0.75rem;"></div></div>';
}

async function submitCheckout(planKey) {
  var phoneEl = document.getElementById('checkout-phone');
  var statusEl = document.getElementById('checkout-status');
  var phone = phoneEl ? phoneEl.value.trim() : '';
  if (!phone) { statusEl.innerHTML = '<span class="text-red">Enter your phone number.</span>'; return; }

  statusEl.innerHTML = 'Sending payment request…';
  try {
    /* ONLY the plan key and the phone number. No amount, no price, no period —
       the server reads those from its own catalog. */
    var res = await fetch('/api/billing/checkout', {
      method: 'POST', headers: mutatingHeaders(),
      body: JSON.stringify({ plan: planKey, phone: phone })
    });
    var data = await res.json();

    if (!data.ok) {
      statusEl.innerHTML = '<span class="text-red">' +
        escapeHtml(resolveUserError(data, 'The payment could not be started.')) + '</span>';
      return;
    }

    billingState.payment = data.payment_id;
    /* TELL THEM WHAT TO LOOK FOR. A handset can show several prompts; naming
       the account and amount lets the payer confirm it is ours before entering
       a PIN. And the last line is the honest one — nothing has been paid or
       upgraded yet, whatever the prompt looks like. */
    var p = data.prompt || {};
    statusEl.innerHTML = icon('clock')
      + ' <strong>Request sent'
      + (p.phone ? ' to ' + escapeHtml(p.phone) : '') + '.</strong>'
      + '<div style="margin-top:0.35rem;">Your phone will show '
      + (p.account ? '<strong>' + escapeHtml(p.account) + '</strong>' : 'the request')
      + ' for <strong>' + escapeHtml(data.currency || 'KES') + ' '
      + Number(data.amount || 0).toLocaleString() + '</strong>. '
      + 'Enter your M-Pesa PIN to approve.</div>'
      + '<div class="text-xs text-muted" style="margin-top:0.35rem;">'
      + 'Your plan changes only once M-Pesa confirms the payment. '
      + 'This usually takes a few seconds.</div>'
      + '<div id="checkout-elapsed" class="text-xs text-muted" style="margin-top:0.25rem;"></div>';
    pollCheckout(data.payment_id);
  } catch (e) {
    statusEl.innerHTML = '<span class="text-red">Connection error.</span>';
  }
}

/**
 * Poll until the SERVER says the payment settled.
 *
 * The client never decides that a payment succeeded — it asks, and the answer
 * comes from a subscription the backend activated after verifying the callback.
 */
function pollCheckout(paymentId) {
  var statusEl = document.getElementById('checkout-status');
  var tries = 0;
  clearInterval(billingState.poll);
  billingState.poll = setInterval(async function () {
    tries += 1;

    /* THREE MINUTES OF AN UNCHANGING LINE reads as a hung page. The counter
       says the app is still listening, without ever implying progress towards
       a result it does not have. */
    var elapsedEl = document.getElementById('checkout-elapsed');
    if (elapsedEl) {
      var secs = tries * 3;
      elapsedEl.textContent = secs < 15
        ? 'Waiting for M-Pesa…'
        : 'Still waiting — ' + secs + 's. You can leave this page; '
          + 'the payment will still be applied.';
    }

    if (tries > 60) {   // ~3 minutes, past the checkout window
      clearInterval(billingState.poll);
      if (statusEl) statusEl.innerHTML = '<span class="text-amber">' + icon('alert-triangle')
        + ' <strong>No confirmation yet.</strong>'
        + '<div style="margin-top:0.35rem;">If you approved the payment it may still '
        + 'arrive — your plan will update on its own. Check Plan &amp; Credits shortly. '
        + 'You have not been charged twice by waiting.</div></span>';
      return;
    }
    try {
      var res = await fetch('/api/billing/checkout/' + encodeURIComponent(paymentId));
      var d = await res.json();
      if (!d.ok) return;

      if (d.status === 'successful') {
        clearInterval(billingState.poll);
        if (d.account) appState.account = d.account;
        appState.entitlement = null;
        if (statusEl) statusEl.innerHTML = '<span class="text-emerald">' + icon('check-circle')
          + ' Payment confirmed — your plan is active.</span>';
        showToast('Upgraded to ' + (d.account ? d.account.plan_label : d.plan), 'success');
        // Re-render with the NEW capabilities, no manual refresh.
        await refreshAccount();
        renderBilling();
        renderCreditsChip();
        renderUpgradeCard();
      } else if (d.status === 'failed' || d.status === 'expired' || d.status === 'cancelled') {
        clearInterval(billingState.poll);
        /* IN THE PAYER'S LANGUAGE. "expired" is Daraja's word for a prompt
           nobody answered, and "cancelled" for one that was declined — showing
           the raw status makes a normal outcome read like a system error. */
        var said = d.status === 'cancelled'
          ? 'You declined the request on your phone.'
          : d.status === 'expired'
            ? 'The request timed out on your phone.'
            : 'M-Pesa could not complete the payment.';
        if (statusEl) statusEl.innerHTML = '<span class="text-red">' + icon('x-circle')
          + ' <strong>' + escapeHtml(said) + '</strong>'
          + '<div style="margin-top:0.35rem;">You have not been charged, and your plan '
          + 'has not changed. You can try again.</div>'
          + (d.failure_reason
            ? '<div class="text-xs text-muted" style="margin-top:0.25rem;">'
              + escapeHtml(d.failure_reason) + '</div>'
            : '') + '</span>';
      }
    } catch (e) { /* keep polling */ }
  }, 3000);
}

async function cancelSubscription() {
  if (!confirm('Cancel your subscription and return to the free Starter plan?')) return;
  try {
    var res = await fetch('/api/billing/cancel', { method: 'POST', headers: mutatingHeaders() });
    var d = await res.json();
    if (d.ok) {
      appState.account = d.account;
      showToast('Subscription cancelled. You are on ' + d.account.plan_label + '.', 'info');
      renderBilling();
      renderCreditsChip();
    }
  } catch (e) { showToast('Could not cancel.', 'error'); }
}

/** The authoritative capability map. The UI renders locks from THIS. */
async function refreshAccount() {
  try {
    var res = await fetch('/api/account/entitlements');
    var d = await res.json();
    if (d.ok) {
      appState.account = d.account;
      appState.plannedCapabilities = d.planned || [];
    }
    return d.ok ? d.account : null;
  } catch (e) { return null; }
}

function renderPlanPanel() {
  // Populate the upgrade cards alongside the credits panel.
  loadBilling();
  var el = document.getElementById('plan-panel-body');
  if (!el) return;
  var e = appState.entitlement;
  if (!e) { el.innerHTML = '<p class="text-sm text-muted">Loading plan…</p>'; return; }

  var h = '<div class="plan-current text-sm">Current plan: <strong class="text-brand-bright">' + escapeHtml(e.plan_label) + '</strong>' + (e.byok ? ' — using your own key' : '') + '</div>';
  if (e.byok) {
    h += '<p class="text-sm text-muted" style="margin-top:0.5rem;">You’re on Custom Guidance: your own key is used and guidance usage is <strong>not metered</strong>. Remove your key in the Guided Assistant tab to fall back to a managed plan.</p>';
  } else {
    var pct = e.allowance ? Math.max(0, Math.min(100, Math.round((e.credits / e.allowance) * 100))) : 0;
    h += '<div class="progress-bar" style="margin:0.6rem 0;"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
    h += '<div class="text-sm text-muted"><strong class="text-main">' + e.credits + '</strong> of ' + e.allowance + ' guidance credits left in the current cycle.</div>';
  }
  h += '<div class="text-xs text-muted" style="margin-top:0.75rem;">Usage costs — guided chat: 2 · action plan: 10 · monthly review: 15 · forecast advisor: 25 · what-if: 25. Your computed dashboard, reports and PDF exports are always free.</div>';

  /* What this plan includes, and what the next tier would add. Built entirely
     from server-supplied capabilities — no plan names or feature lists here. */
  var GROWTH_HIGHLIGHTS = [
    'ai_forecast_advisory', 'what_if_simulator', 'ai_action_plan', 'smart_recommendations',
    'automatic_monitoring', 'ai_followup_workflow', 'team_collaboration', 'custom_rules',
    'ai_executive_reports', 'email_alerts', 'tax_readiness', 'benchmarking'
  ];
  var included = GROWTH_HIGHLIGHTS.filter(function(k) { return e.features && e.features[k]; });
  var missing = GROWTH_HIGHLIGHTS.filter(function(k) { return e.features && e.features[k] === false; });

  function capRow(k, on) {
    var soon = featurePlanned(k)
      ? ' <span class="cap-soon">coming soon</span>'
      : '';
    return '<li class="cap-row' + (on ? '' : ' cap-off') + '">' +
      (on ? '<span class="text-emerald">' + icon('check-circle') + '</span>' : lockIcon()) +
      '<span>' + escapeHtml(featureCopy(k)) + soon + '</span></li>';
  }

  if (missing.length) {
    /* Starter: make the reason to upgrade concrete. */
    var pb = productBoundary();
    h += '<div class="settings-card-head" style="margin-top:1.5rem;margin-bottom:0.5rem;"><h3>What ' +
      escapeHtml(featureRequiredPlan(missing[0])) + ' adds</h3>' +
      '<p>Starter answers <em>' + escapeHtml(pb.starter.question) + '</em>. ' +
      escapeHtml(featureRequiredPlan(missing[0])) + ' answers <em>' + escapeHtml(pb.growth.question) + '</em>.</p></div>';
    h += '<div class="boundary-grid">' +
      '<div class="boundary-col"><div class="boundary-head">Starter · ' + escapeHtml(pb.starter.role) + '</div>' +
        '<div class="boundary-verb">' + escapeHtml(pb.starter.verb) + '</div>' +
        '<div class="boundary-eg">“' + escapeHtml(pb.starter.example) + '”</div></div>' +
      '<div class="boundary-col boundary-col-paid"><div class="boundary-head">' + escapeHtml(featureRequiredPlan(missing[0])) + ' · ' + escapeHtml(pb.growth.role) + '</div>' +
        '<div class="boundary-verb">' + escapeHtml(pb.growth.verb) + '</div>' +
        '<div class="boundary-eg">“' + escapeHtml(pb.growth.example) + '”</div></div>' +
    '</div>';
    h += '<ul class="cap-list">';
    missing.forEach(function(k) { h += capRow(k, false); });
    h += '</ul>';
  } else if (included.length) {
    /* Growth and above: confirm what they already have, flag what is still building. */
    h += '<div class="settings-card-head" style="margin-top:1.5rem;margin-bottom:0.5rem;"><h3>Included in your plan</h3></div>';
    h += '<ul class="cap-list">';
    included.forEach(function(k) { h += capRow(k, true); });
    h += '</ul>';
  }

  h += '<div class="settings-card-head" style="margin-top:1.5rem;margin-bottom:0.6rem;"><h3>Change plan</h3><p>Payments aren’t wired up yet — use these to simulate upgrading while testing.</p></div>';
  h += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">';
  h += '<button type="button" class="btn-secondary btn-small" onclick="setPlan(\'starter\')">Starter (Free)</button>';
  h += '<button type="button" class="btn-primary btn-small" onclick="setPlan(\'growth\')">Growth</button>';
  h += '<button type="button" class="btn-secondary btn-small" onclick="setPlan(\'workspace\')">Accountant Workspace</button>';
  h += '</div>';
  el.innerHTML = h;
}

function showStatus(text) {
  if (!text) {
    $status.classList.add('hidden');
    $status.textContent = '';
    return;
  }
  $status.classList.remove('hidden');
  $status.textContent = text;
}

/**
 * UNMEASURED SENTINEL.
 *
 * The API deliberately returns null for a value it could not measure, which is
 * a different claim from zero. Rendering that as "KES 0" tells the user the
 * business broke even when in fact nothing was measured — so every unmeasured
 * value renders as this, and never as a number.
 */
var UNMEASURED = '\u2014'; // em dash

/** Is this a real, measured number? Guards BOTH the value and its colour. */
function isMeasured(value) {
  return value != null && value !== '' && !isNaN(Number(value));
}

/**
 * Read the CSRF token the server issued.
 *
 * Double-submit: the server sets `fg_csrf` on any safe request, and every
 * mutating request must echo it in a header. Another origin cannot read the
 * cookie, so it cannot produce the header — which is the whole protection.
 */
function csrfToken() {
  var match = String(document.cookie || "").match(/(?:^|;\s*)fg_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Headers for a JSON request that changes state. */
function mutatingHeaders(extra) {
  var headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
  headers["x-csrf-token"] = csrfToken();
  return headers;
}

/**
 * CSRF header ONLY, with no Content-Type.
 *
 * For multipart uploads and bodiless requests. A FormData upload must NOT have
 * Content-Type set by hand -- the browser has to add it together with the
 * multipart boundary, and overriding it makes the body unparseable server-side.
 */
function csrfHeaders(extra) {
  var headers = Object.assign({}, extra || {});
  headers["x-csrf-token"] = csrfToken();
  return headers;
}

function formatCurrency(amount) {
  // JOB 7: was 'KES 0'. Null means "we could not measure this".
  if (amount == null || isNaN(amount)) return UNMEASURED;
  var num = Number(amount);
  var neg = num < 0;
  num = Math.abs(num);
  var parts = num.toFixed(0).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + 'KES ' + parts[0];
}

function formatPercent(value) {
  // JOB 7: was '0%'. A growth rate with no prior period is unknown, not flat.
  if (value == null || isNaN(value)) return UNMEASURED;
  return Number(value).toFixed(1) + '%';
}


/** Thousands-separated integer, or the unmeasured sentinel. */
function formatNumber(n) {
  if (n == null || isNaN(n)) return UNMEASURED;
  return Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Explain WHY a figure could not be produced.
 *
 * The API states a reason on every unavailable metric. Showing it turns a bare
 * dash into something actionable — and for mixed currency it shows the
 * per-currency parts, which ARE known even though their sum is not.
 */
function unavailableNotice(block, what) {
  if (!block || block.available !== false) return '';
  var reason = block.unavailable_reason;
  var text;
  if (reason === 'mixed_currency') {
    var parts = (block.by_currency || [])
      .map(function(b) { return (b.currency || 'unspecified') + ' ' + formatNumber(b.total); })
      .join(', ');
    text = what + ' cannot be combined: this period holds more than one currency and no '
      + 'conversion rate is available. Measured separately: ' + (parts || 'n/a') + '.';
  } else if (reason === 'unattributed_transactions') {
    text = what + ' could not be measured: ' + formatCurrency(block.unattributed_amount)
      + ' of activity names no counterparty.';
  } else if (reason === 'no_attributable_value') {
    text = what + ' could not be measured: there is no attributable value this period.';
  } else if (reason === 'no_transactions') {
    text = what + ' could not be measured: there are no transactions for this period.';
  } else {
    text = what + ' could not be measured for this period.';
  }
  return '<div class="callout-info">' + escapeHtml(text) + '</div>';
}

function maskWalletAddress(address) {
  if (!address) return 'Not set';
  var text = String(address);
  if (text.length <= 10) return '••••••••';
  return text.slice(0, 6) + '••••••••' + text.slice(-4);
}

function getMonthLabel(monthStr) {
  if (!monthStr) return '—';
  var parts = monthStr.split('-');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var mi = parseInt(parts[1], 10) - 1;
  return months[mi] + ' ' + parts[0];
}

function generateRecentMonths(count) {
  count = count || 12;
  var months = [];
  var now = new Date();
  for (var i = 0; i < count; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var y = d.getFullYear();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    months.push(y + '-' + m);
  }
  return months;
}

function renderLoadingShimmer(n) {
  n = n || 4;
  var html = '<div class="kpi-row">';
  for (var i = 0; i < n; i++) {
    html += '<div class="loading-shimmer" style="height:90px"></div>';
  }
  html += '</div>';
  return html;
}

function renderEmptyState(iconName, title, text) {
  return '<div class="empty-state">' +
    '<div class="empty-state-icon">' + icon(iconName || 'bar-chart', { cls: 'icon-xl' }) + '</div>' +
    '<div class="empty-state-title">' + escapeHtml(title || 'No Data Yet') + '</div>' +
    '<div class="empty-state-text">' + escapeHtml(text || 'Select a target month from Controller Overview to begin analysis.') + '</div>' +
  '</div>';
}

/**
 * DISCLOSURE — what the reader must be told about this analysis.
 *
 * The API returns a `disclosure` block on every route whose figures may be
 * incomplete: a derived input, an unavailable metric, partial scoring coverage.
 * app.js IGNORED IT ENTIRELY, so a page built on an estimated cash balance
 * looked exactly like one built on fully observed books — and a metric the
 * engine had a precise reason for withholding rendered as a blank the reader
 * would naturally read as zero.
 *
 * ONE helper, used by every page that receives a disclosure, rather than
 * per-page DOM logic that would drift. The WORDING comes from the backend:
 * `detail` is written where the reason is actually known, so repeating it here
 * would let the two versions disagree.
 */
function renderDisclosure(disclosure) {
  if (!disclosure || !disclosure.limitations || !disclosure.limitations.length) return '';

  /* DEMO DATA GETS ITS OWN BANNER, not a bullet in a list of caveats.
     "Some inputs were estimated" and "none of this is your business" are not
     the same order of statement, and the second must not be skimmable. */
  var demo = disclosure.limitations.filter(function (l) { return l.type === 'demo_data'; })[0];
  var demoHtml = demo
    ? '<div class="callout-warning disclosure-demo">'
      + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
      + '<div class="callout-warning-text"><strong>Sample data — not your accounts.</strong> '
      + escapeHtml(demo.detail) + '</div></div>'
    : '';
  var rest = disclosure.limitations.filter(function (l) { return l.type !== 'demo_data'; });
  if (!rest.length) return demoHtml;
  disclosure = { scoring_coverage_pct: disclosure.scoring_coverage_pct, limitations: rest };

  var items = disclosure.limitations.map(function (l) {
    // Prefer the backend's own explanation; fall back to naming the field only
    // when it did not supply one, so nothing is ever shown without a reason.
    var text = l.detail
      || (l.metric ? (l.metric + ' is not available (' + (l.reason || 'unknown reason') + ')')
                   : (l.input ? (l.input + ' was ' + (l.basis || 'derived')) : ''));
    if (!text) return '';
    return '<li>' + escapeHtml(text) + '</li>';
  }).filter(Boolean).join('');

  if (!items) return '';

  var coverage = (disclosure.scoring_coverage_pct != null)
    ? ' Scored on ' + escapeHtml(String(disclosure.scoring_coverage_pct)) + '% of the model.'
    : '';

  return demoHtml
    + '<div class="callout-warning disclosure-notice">'
    + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
    + '<div class="callout-warning-text">'
    + '<strong>This analysis is not based on fully observed data.</strong>' + coverage
    + '<ul class="disclosure-list">' + items + '</ul>'
    + '<span class="text-sm text-muted">Values shown as not measured were not '
    + 'observed, and must not be read as zero.</span>'
    + '</div></div>';
}

function renderAiInsightsCard(aiInsights) {
  if (!aiInsights) {
    return '<div class="glass-card ai-insights-card section-gap">' +
      '<div class="card-title">' + icon('bot') + ' Guided Insights</div>' +
      '<p class="text-sm text-muted">Enable live guidance in <a href="#settings" class="text-brand" style="text-decoration:underline;">Settings</a> to get extra narrative on this page.</p>' +
      '</div>';
  }

  var html = '<div class="glass-card ai-insights-card glow-border section-gap">';
  html += '<div class="card-title">' + icon('bot') + ' Guided Insights</div>';

  if (aiInsights.narrative) {
    html += '<p class="text-sm" style="line-height:1.6;margin-bottom:1rem;">' + escapeHtml(aiInsights.narrative) + '</p>';
  }

  if (aiInsights.key_findings && aiInsights.key_findings.length) {
    html += '<div class="text-xs text-muted" style="font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">Key Findings</div>';
    html += '<ul style="margin:0 0 1rem 0;padding-left:1.25rem;">';
    aiInsights.key_findings.forEach(function(finding) {
      html += '<li class="text-sm" style="margin-bottom:0.4rem;line-height:1.5;">' + escapeHtml(finding) + '</li>';
    });
    html += '</ul>';
  }

  if (aiInsights.recommended_actions && aiInsights.recommended_actions.length) {
    html += '<div class="text-xs text-muted" style="font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">Recommended Actions</div>';
    html += '<ul style="margin:0;padding-left:1.25rem;">';
    aiInsights.recommended_actions.forEach(function(action) {
      html += '<li class="text-sm" style="margin-bottom:0.4rem;line-height:1.5;">' + escapeHtml(action) + '</li>';
    });
    html += '</ul>';
  }

  html += '</div>';
  return html;
}


/* ═══════════════════════════════════════════════════════════════
   FINDING INVESTIGATION

   The endpoints have existed since JOB 12 and had no frontend at all:
   /api/findings/:key/records, /api/records/:id, and the comment / resolve /
   thread trio. A user could be told a duplicate payment existed and had no way
   to see which transactions it referred to, or to record what they did about it.
   ═══════════════════════════════════════════════════════════════ */

var investigation = { key: null, records: null, thread: null };

/* CLICKS ARE DELEGATED, NOT INLINE.
   The app's own Helmet policy sends `script-src-attr 'none'`, which makes an
   `onclick="..."` attribute inert — the browser never compiles it and the
   button silently does nothing. That is invisible to a backend test, so this
   panel is wired through one delegated listener on data attributes instead. */
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-fg-action]');
  if (!el) return;
  var action = el.getAttribute('data-fg-action');
  if (action === 'investigate') investigateFinding(el.getAttribute('data-finding'));
  else if (action === 'investigation-close') closeInvestigation();
  else if (action === 'finding-note') submitFindingNote();
  else if (action === 'finding-resolve') {
    toggleFindingResolved(el.getAttribute('data-resolved') === 'true');
  }
  else if (action === 'analyse-anyway') {
    // The user has read which documents were not imported and chosen to go on.
    var period = el.getAttribute('data-period');
    appState.activeMonth = period;
    runMonthlyReview(period).then(function () {
      if (typeof loadImportHistory === 'function') loadImportHistory();
      navigate('overview');
    });
  }
});

async function investigateFinding(findingKey) {
  investigation.key = findingKey;
  openInvestigationPanel('<p class="text-sm text-muted">Loading evidence…</p>');

  var results = await Promise.all([
    fetch('/api/findings/' + encodeURIComponent(findingKey) + '/records')
      .then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('/api/findings/thread?fingerprint=' + encodeURIComponent(findingKey))
      .then(function (r) { return r.json(); }).catch(function () { return null; })
  ]);
  investigation.records = results[0];
  investigation.thread = results[1];
  renderInvestigation();
}

function openInvestigationPanel(inner) {
  closeInvestigation();
  var wrap = document.createElement('div');
  wrap.id = 'investigation-modal';
  wrap.className = 'modal-overlay';
  wrap.innerHTML = '<div class="modal-card glass-card investigation-card">'
    + '<div class="investigation-head"><h2>Investigate finding</h2>'
    + '<button type="button" class="btn-ghost btn-small" data-fg-action="investigation-close">Close</button></div>'
    + '<div id="investigation-body">' + inner + '</div></div>';
  document.body.appendChild(wrap);
}

function closeInvestigation() {
  var el = document.getElementById('investigation-modal');
  if (el) el.remove();
}

function renderInvestigation() {
  var body = document.getElementById('investigation-body');
  if (!body) return;
  var r = investigation.records;
  var h = '';

  if (!r || !r.ok) {
    h += '<div class="callout-warning"><div class="callout-warning-icon">' + icon('alert-triangle')
      + '</div><div class="callout-warning-text">'
      + escapeHtml((r && r.detail) || 'The evidence for this finding could not be loaded.')
      + '</div></div>';
  } else {
    h += '<div class="text-sm text-muted">' + escapeHtml(r.rule_id || '')
      + (r.severity ? ' · ' + escapeHtml(r.severity) : '') + '</div>';

    /* THE DISTINCTION THAT MATTERS. `records: []` with `unresolved: [...]`
       means the evidence exists and we could not retrieve it — which is NOT
       the same as a finding with no evidence. Rendering an empty list without
       saying so would tell the user the finding rests on nothing. */
    if (r.unresolved && r.unresolved.length) {
      h += '<div class="callout-warning" style="margin-top:0.75rem;">'
        + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
        + '<div class="callout-warning-text"><strong>'
        + escapeHtml(String(r.unresolved.length))
        + ' cited record(s) could not be retrieved.</strong> '
        + 'They are referenced by this finding but are not currently available, '
        + 'so the evidence below is incomplete.'
        + '<div class="text-xs text-muted" style="margin-top:0.35rem;">'
        + escapeHtml(r.unresolved.join(', ')) + '</div></div></div>';
    }

    if (r.records && r.records.length) {
      h += '<div class="card-title" style="margin-top:1rem;">Underlying transactions</div>';
      h += '<table class="data-table"><thead><tr><th>Date</th><th>Description</th>'
        + '<th>Counterparty</th><th>Amount</th><th>Source</th></tr></thead><tbody>';
      r.records.forEach(function (t) {
        h += '<tr>'
          + '<td>' + escapeHtml(t.date || '—') + '</td>'
          + '<td>' + escapeHtml(t.description || '—') + '</td>'
          /* An unattributed record stays unattributed — never "Unknown". */
          + '<td>' + (t.counterparty ? escapeHtml(t.counterparty)
            : '<span class="text-muted">not attributed</span>') + '</td>'
          + '<td>' + formatCurrency(t.amount) + '</td>'
          /* PROVENANCE: where this row came from, and its id in that system. */
          + '<td class="text-xs text-muted">' + escapeHtml(t.sourceSystem || '—')
          + '<br>' + escapeHtml(t.sourceRecordId || '') + '</td>'
          + '</tr>';
      });
      h += '</tbody></table>';
    } else if (!r.unresolved || !r.unresolved.length) {
      h += '<p class="text-sm text-muted" style="margin-top:1rem;">'
        + 'This finding cites no individual transactions — it was derived from '
        + 'period totals rather than specific records.</p>';
    }
  }

  // ── Notes and resolution ─────────────────────────────────────
  var t = investigation.thread;
  var thread = (t && t.thread) || null;
  h += '<div class="card-title" style="margin-top:1.5rem;">Notes</div>';

  if (t && !t.ok) {
    h += '<p class="text-sm text-muted">' + escapeHtml(t.error === 'not_a_member'
      ? 'You do not have access to notes on this workspace.'
      : 'Notes are unavailable.') + '</p>';
  } else {
    if (thread && thread.resolved) {
      h += '<div class="callout-info text-sm">' + icon('check-circle') + ' Resolved'
        /* The server's thread view is snake_case (`resolved_by`,
           `resolved_at`); reading the camelCase names silently rendered a
           bare "Resolved" with no attribution. */
        + (thread.resolved_by ? ' by ' + escapeHtml(thread.resolved_by) : '')
        + (thread.resolved_at ? ' on ' + escapeHtml(String(thread.resolved_at).slice(0, 10)) : '')
        + '</div>';
    }
    var comments = (thread && thread.comments) || [];
    if (comments.length) {
      comments.forEach(function (c) {
        h += '<div class="finding-comment"><div class="text-xs text-muted">'
          + escapeHtml(c.name || 'Someone') + ' · ' + escapeHtml(String(c.ts || '').slice(0, 16))
          + '</div><div>' + escapeHtml(c.text) + '</div></div>';
      });
    } else {
      h += '<p class="text-sm text-muted">No notes yet.</p>';
    }

    h += '<textarea class="settings-input" id="investigation-note" rows="2" '
      + 'placeholder="What did you find?"></textarea>'
      + '<div style="margin-top:0.6rem;display:flex;gap:0.5rem;">'
      + '<button type="button" class="btn-primary btn-small" data-fg-action="finding-note">Add note</button>'
      + '<button type="button" class="btn-secondary btn-small" data-fg-action="finding-resolve"'
      + ' data-resolved="' + (thread && thread.resolved ? 'false' : 'true') + '">'
      + (thread && thread.resolved ? 'Reopen' : 'Mark resolved') + '</button>'
      + '</div>';
  }

  body.innerHTML = h;
}

async function submitFindingNote() {
  var el = document.getElementById('investigation-note');
  var text = el ? el.value.trim() : '';
  if (!text) { showToast('Write a note first.', 'warning'); return; }
  try {
    var res = await fetch('/api/findings/comment', {
      method: 'POST', headers: mutatingHeaders(),
      body: JSON.stringify({ fingerprint: investigation.key, text: text })
    });
    var d = await res.json();
    if (!d.ok) { showToast(d.error === 'forbidden' ? 'Your role cannot comment.' : 'Could not save the note.', 'error'); return; }
    // Refresh from the SERVER's thread, not from what we just typed.
    investigation.thread = d;
    renderInvestigation();
    showToast('Note added.', 'success');
  } catch (e) { showToast('Connection error.', 'error'); }
}

async function toggleFindingResolved(resolved) {
  try {
    var res = await fetch('/api/findings/resolve', {
      method: 'POST', headers: mutatingHeaders(),
      body: JSON.stringify({ fingerprint: investigation.key, resolved: resolved })
    });
    var d = await res.json();
    if (!d.ok) { showToast(d.error === 'forbidden' ? 'Your role cannot resolve findings.' : 'Could not update.', 'error'); return; }
    investigation.thread = d;
    renderInvestigation();
    showToast(resolved ? 'Finding marked resolved.' : 'Finding reopened.', 'success');
  } catch (e) { showToast('Connection error.', 'error'); }
}

function renderFindingsList(findings) {
  if (!findings || !findings.length) return '<p class="text-muted text-sm">No findings.</p>';
  var html = '';
  findings.forEach(function(f) {
    var sev = f.severity || f.level || 'info';
    html += '<div class="finding-item">' +
      '<div class="severity-dot ' + severityDotClass(sev) + '"></div>' +
      '<div>' +
        '<div class="finding-text">' + escapeHtml(f.description || f.finding || f.text || f.message || '') + '</div>' +
        (f.category ? '<div class="finding-meta">' + escapeHtml(f.category) + '</div>' : '') +
      '</div>' +
    '</div>';
  });
  return html;
}

/* ── 4. Theme Toggle ─────────────────────────────────────────── */
$themeToggle.addEventListener('click', function() {
  /* Reserved for light/dark toggle — currently dark-only */
  showToast('Dark mode is the default premium experience.', 'info');
});

/* ── 5. Profile Popover ──────────────────────────────────────── */
$profileToggle.addEventListener('click', function() {
  $profilePopover.classList.toggle('hidden');
  if (!$profilePopover.classList.contains('hidden')) {
    loadProfile();
  }
});

$refreshProfile.addEventListener('click', function() {
  loadProfile();
});

async function loadProfile() {
  $profileContent.innerHTML = '<div class="loading-shimmer" style="height:80px"></div>';
  try {
    var res = await fetch('/api/profile');
    var data = await res.json();
    if (data.ok && data.profile) {
      var p = data.profile;
      var session = appState.authSession || { authenticated: false };
      var accountValue = session.authenticated
        ? icon('check-circle', { cls: 'text-emerald' }) + ' ' + escapeHtml(session.user && (session.user.email || session.user.name) || 'Logged in')
        : icon('x-circle', { cls: 'text-muted' }) + ' Guest / Demo (not logged in)';

      $profileContent.innerHTML =
        '<div class="profile-field"><div class="profile-field-label">Account</div><div class="profile-field-value">' + accountValue + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Name</div><div class="profile-field-value">' + escapeHtml(p.name || appState.userName) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Company</div><div class="profile-field-value">' + escapeHtml(p.business_name || appState.businessName) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Zoho</div><div class="profile-field-value">' + (p.zoho_api_key ? icon('check-circle', { cls: 'text-emerald' }) + ' Connected' : icon('x-circle', { cls: 'text-muted' }) + ' Not connected') + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Wallet</div><div class="profile-field-value text-sm">' + escapeHtml(maskWalletAddress(p.wallet_address)) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Guidance</div><div class="profile-field-value">' + (appState.aiApiKeyConfigured ? icon('check-circle', { cls: 'text-emerald' }) + ' Enabled' : icon('info', { cls: 'text-muted' }) + ' Using built-in mode') + '</div></div>' +
        (session.authenticated
          ? '<button type="button" class="btn-secondary btn-full" style="margin-top:0.75rem;" onclick="window.location.href=\'/api/auth/google/logout\'">Log Out</button>'
          : (session.google_enabled
            ? '<button type="button" class="btn-secondary btn-full" style="margin-top:0.75rem;" onclick="window.location.href=\'/api/auth/google/start\'">Log In with Google</button>'
            : ''));

      appState.aiProvider = p.ai_provider || appState.aiProvider;
      appState.aiAssistant = p.ai_assistant || appState.aiAssistant;
      appState.aiApiKeyConfigured = Boolean(p.ai_api_key_configured);
      appState.aiApiKeyPreview = p.ai_api_key_preview || '';
    } else {
      $profileContent.innerHTML = '<p class="text-muted text-sm">Unable to load profile.</p>';
    }
  } catch (e) {
    $profileContent.innerHTML = '<p class="text-muted text-sm">Connection error.</p>';
  }
}

/* Close popover when clicking outside */
document.addEventListener('click', function(e) {
  if (!$profilePopover.contains(e.target) && !$profileToggle.contains(e.target)) {
    $profilePopover.classList.add('hidden');
  }
});

/* ── 6. Onboarding ───────────────────────────────────────────── */
async function fetchAuthSession() {
  try {
    var res = await fetch('/api/auth/session');
    var data = await res.json();
    return data.ok ? data : { google_enabled: false, authenticated: false, user: null };
  } catch (e) {
    return { google_enabled: false, authenticated: false, user: null };
  }
}

async function checkOnboarding() {
  var session = await fetchAuthSession();
  appState.authSession = session;

  if (!session.google_enabled) {
    $googleAuthUnavailableHint.classList.remove('hidden');
    $btnLoginGoogle.setAttribute('disabled', 'disabled');
  }

  var profile = null;
  try {
    var res = await fetch('/api/profile');
    var data = await res.json();
    if (data.ok && data.profile) {
      profile = data.profile;
      appState.userName = profile.name || appState.userName;
      appState.businessName = profile.business_name || appState.businessName;
      appState.zohoApiKey = profile.zoho_api_key || '';
      appState.zohoOrgId = profile.zoho_org_id || '';
      appState.walletAddress = profile.wallet_address || '';
      appState.walletVerified = Boolean(profile.wallet_verified);
      appState.walletChainId = profile.wallet_chain_id || null;
      appState.aiProvider = profile.ai_provider || appState.aiProvider;
      appState.aiAssistant = profile.ai_assistant || appState.aiAssistant;
      appState.aiApiKeyConfigured = Boolean(profile.ai_api_key_configured);
      appState.aiApiKeyPreview = profile.ai_api_key_preview || '';

      var nameInput = document.getElementById('input-name');
      var companyInput = document.getElementById('input-company');
      var zohoOrgInput = document.getElementById('input-zoho-org');
      var zohoInput = document.getElementById('input-zoho');

      if (nameInput) nameInput.value = appState.userName || '';
      if (companyInput) companyInput.value = appState.businessName || '';
      if (zohoOrgInput) zohoOrgInput.value = appState.zohoOrgId || '';
      if (zohoInput) zohoInput.value = appState.zohoApiKey || '';

      $companyContext.textContent = 'Company: ' + appState.businessName;
    }
  } catch (e) { /* continue to show signup */ }

  // Re-establish wallet trust without re-asking for a signature: if the
  // browser wallet is still silently connected to the SAME address the
  // server already verified, treat it as verified again. Only a genuinely
  // new/different wallet ever needs a fresh "Sign In to Verify".
  var walletState = await FinGuardWallet.silentReconnect();
  if (walletState && walletState.address && profile && profile.wallet_verified && profile.wallet_address) {
    FinGuardWallet.trustServerVerification(profile.wallet_address);
  }

  var fullyOnboarded = Boolean(profile && profile.business_name && profile.wallet_verified);

  if (fullyOnboarded) {
    $signupOverlay.classList.add('hidden');
    if (session.authenticated && session.user) {
      showToast('Welcome back, ' + (session.user.name || appState.userName) + '.', 'info');
    }
    return;
  }

  $signupOverlay.classList.remove('hidden');

  if (session.authenticated) {
    // Already logged in via Google — skip the Welcome screen, resume the wizard.
    goToStep1();
  }
}

async function loadNetworks() {
  try {
    var res = await fetch('/api/avalanche/networks');
    var data = await res.json();
    if (data.ok) appState.networks = data.items;
  } catch (e) { appState.networks = []; }
}

function networkNameForChainId(chainId) {
  var net = (appState.networks || []).find(function(n) { return n.chainId === chainId; });
  return net ? net.name : (chainId ? ('Chain ' + chainId) : 'Unknown network');
}

/* ── Wallet Connect UI (shared: onboarding, Settings, Contracts) ─
   Real EIP-1193 browser-wallet connection. The user's own wallet
   (Core Wallet / MetaMask) signs everything — no typed addresses,
   no server-held keys involved on this path. ──────────────────── */
var walletUiState = { busy: false, error: '' };
var activeWalletPanel = null;
var activeNetworkPanel = null;

FinGuardWallet.onChange(function() {
  if (activeWalletPanel && document.getElementById(activeWalletPanel.containerId)) {
    renderWalletConnectCard(activeWalletPanel.containerId, activeWalletPanel.opts);
  }
  if (activeNetworkPanel && document.getElementById(activeNetworkPanel)) {
    renderNetworkPanel(activeNetworkPanel);
  }
});

function renderNetworkPanel(containerId) {
  activeNetworkPanel = containerId;
  var el = document.getElementById(containerId);
  if (!el) return;

  var w = FinGuardWallet.getState();
  if (!w.address) {
    el.innerHTML = '<p class="text-sm text-muted">Connect your wallet above to see network and balance details.</p>';
    return;
  }

  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  var networkLabel = net ? net.name : ('Unrecognized network (chain ' + w.chainId + ')');

  var html = '<div class="network-row">';
  html += '<div class="network-row-info">';
  html += '<span class="badge">' + icon(net && net.isTestnet ? 'flask' : 'shield') + ' ' + escapeHtml(networkLabel) + '</span>';
  html += '<span id="network-balance-value" class="text-sm text-muted">Loading balance…</span>';
  html += '</div>';
  html += '<div class="network-row-actions">';
  (appState.networks || []).forEach(function(n) {
    var isActive = n.chainId === w.chainId;
    html += '<button type="button" class="btn-small' + (isActive ? ' network-btn-active' : '') + '" ' +
      'onclick="handleSwitchNetwork(\'' + n.key + '\')"' + (isActive ? ' disabled' : '') + '>' +
      icon(n.isTestnet ? 'flask' : 'shield') + ' ' + escapeHtml(n.name) + '</button>';
  });
  html += '</div>';
  html += '<div id="network-faucet-hint"></div>';
  html += '</div>';
  el.innerHTML = html;

  FinGuardWallet.getBalance().then(function (bal) {
    var balEl = document.getElementById('network-balance-value');
    if (!balEl) return;
    var num = Number(bal);
    balEl.textContent = 'Balance: ' + num.toFixed(4) + ' AVAX';
    var hintEl = document.getElementById('network-faucet-hint');
    if (!hintEl) return;
    if (net && net.isTestnet && num === 0) {
      hintEl.innerHTML = '<a href="' + net.faucetUrl + '" target="_blank" rel="noopener" class="text-sm text-brand">' +
        'Get free test AVAX from the faucet →</a>';
    } else {
      hintEl.innerHTML = '';
    }
  }).catch(function () {});
}

async function handleSwitchNetwork(networkKey) {
  var net = (appState.networks || []).find(function (n) { return n.key === networkKey; });
  if (!net) return;
  try {
    await FinGuardWallet.switchNetwork(net);
    showToast('Switched to ' + net.name + '.', 'success');
  } catch (e) {
    showToast('Could not switch network: ' + (e.message || 'unknown error'), 'error');
  }
}

/* ── Upload Panel (shared: onboarding, Settings/Financial Health) ─
   Alternative to Zoho. Accepts either a bank/accounting CSV export, or the
   source documents themselves — invoices, bills, receipts and bank slips as
   PDFs — because that is what an SME actually keeps. ───────────── */
function renderUploadPanel(containerId, opts) {
  opts = opts || {};
  var el = document.getElementById(containerId);
  if (!el) return;

  var months = generateRecentMonths(12);
  var monthOptions = months.map(function(m) {
    return '<option value="' + m + '">' + getMonthLabel(m) + '</option>';
  }).join('');

  var html = '';
  html += '<div class="form-group"><label class="settings-label">Which month is this for?</label>';
  html += '<select class="settings-input" id="' + containerId + '-period">' + monthOptions + '</select></div>';

  html += '<div class="form-group"><label class="settings-label">Your records</label>';
  /* MULTIPLE, and both formats. A day of paperwork is many files, so the input
     takes a whole selection at once. */
  html += '<div class="upload-dropzone"><input type="file" multiple '
    + 'accept=".csv,.pdf,text/csv,application/pdf" id="' + containerId + '-file" /></div>';
  html += '<p class="text-xs text-muted">'
    + 'A bank or accounting <strong>CSV export</strong> — or your <strong>PDF documents</strong> '
    + '(invoices, bills, receipts, bank slips). You can select a whole day or month at once.'
    + '</p>';
  html += '<p class="text-xs text-muted" style="margin-top:0.3rem;">'
    + 'Scanned or photographed PDFs cannot be read — the figures are an image, not text. '
    + 'Those documents are listed after upload so you can enter them another way.</p>';
  html += '<div id="' + containerId + '-selected" class="text-xs text-muted" style="margin-top:0.4rem;"></div>';
  html += '</div>';

  html += '<div class="form-group"><label class="settings-label">Current Cash Balance (optional)</label>';
  html += '<input type="number" class="settings-input" id="' + containerId + '-balance" placeholder="Leave blank to estimate from transactions" /></div>';
  html += '<button type="button" class="btn-primary btn-full" id="' + containerId + '-submit">' + icon('download') + ' Upload &amp; Analyze</button>';
  html += '<div id="' + containerId + '-result"></div>';

  el.innerHTML = html;

  var submitBtn = document.getElementById(containerId + '-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', function() { handleUploadSubmit(containerId, opts); });
  }

  /* Confirm what was picked BEFORE uploading. Selecting a folder of 53 files
     and being shown nothing is how people upload the wrong month. */
  var fileEl = document.getElementById(containerId + '-file');
  var selectedEl = document.getElementById(containerId + '-selected');
  if (fileEl && selectedEl) {
    fileEl.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileEl.files || []);
      if (!files.length) { selectedEl.innerHTML = ''; return; }
      var pdfs = files.filter(function (f) { return /\.pdf$/i.test(f.name); }).length;
      var csvs = files.length - pdfs;
      var parts = [];
      if (pdfs) parts.push(pdfs + ' PDF document' + (pdfs === 1 ? '' : 's'));
      if (csvs) parts.push(csvs + ' CSV file' + (csvs === 1 ? '' : 's'));
      selectedEl.innerHTML = 'Selected: ' + escapeHtml(parts.join(' and '))
        + (files.length === 1 ? ' — ' + escapeHtml(files[0].name) : '');
    });
  }
}

/**
 * Documents the server could not import.
 *
 * ALWAYS RENDERED WHEN NON-EMPTY. The server names every file it refused and
 * why; dropping that on the floor would show a clean summary for a month that
 * is silently missing records — the same class of error as presenting an
 * unmeasured figure as zero. Each row is a file the user still has to account
 * for.
 */
function renderUnreadDocuments(rejected, outOfPeriod) {
  var rows = [];
  (rejected || []).forEach(function (r) {
    rows.push({ name: r.filename, reason: r.reason });
  });
  (outOfPeriod || []).forEach(function (r) {
    rows.push({ name: r.filename, reason: r.reason });
  });
  if (!rows.length) return '';

  var h = '<div class="callout-warning" style="margin-top:0.75rem;">'
    + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
    + '<div class="callout-warning-text"><strong>'
    + escapeHtml(String(rows.length)) + ' document'
    + (rows.length === 1 ? ' was' : 's were') + ' not imported.</strong> '
    + (rows.length === 1 ? 'It is' : 'They are') + ' not included in the figures above.';
  h += '<div style="margin-top:0.5rem;">';
  rows.slice(0, 25).forEach(function (r) {
    h += '<div class="text-xs" style="margin-bottom:0.2rem;">'
      + '<span class="text-muted">' + escapeHtml(r.name || 'document') + '</span> — '
      + escapeHtml(r.reason || 'could not be read') + '</div>';
  });
  if (rows.length > 25) {
    h += '<div class="text-xs text-muted">and ' + escapeHtml(String(rows.length - 25)) + ' more.</div>';
  }
  h += '</div></div></div>';
  return h;
}

async function handleUploadSubmit(containerId, opts) {
  opts = opts || {};
  var periodEl = document.getElementById(containerId + '-period');
  var fileEl = document.getElementById(containerId + '-file');
  var balanceEl = document.getElementById(containerId + '-balance');
  var resultEl = document.getElementById(containerId + '-result');

  var files = Array.prototype.slice.call((fileEl && fileEl.files) || []);
  if (!files.length) {
    showToast('Choose a CSV file or your PDF documents first.', 'warning');
    return;
  }

  /* MIXING THE TWO IS REFUSED HERE TOO, so the user is told before a 400 comes
     back. A CSV export and the documents behind it describe the same money;
     importing both would count it twice. */
  var pdfs = files.filter(function (f) { return /\.pdf$/i.test(f.name); });
  if (pdfs.length && pdfs.length !== files.length) {
    showToast('Upload either a CSV export or your PDF documents — not both at '
      + 'once, or the same transaction could be counted twice.', 'warning');
    return;
  }
  if (!pdfs.length && files.length > 1) {
    showToast('Attach one CSV file, or attach your PDF documents.', 'warning');
    return;
  }

  var formData = new FormData();
  files.forEach(function (f) { formData.append('file', f); });
  formData.append('period', periodEl.value);
  if (balanceEl.value) formData.append('currentCashBalance', balanceEl.value);

  resultEl.innerHTML = '<div class="loading-shimmer" style="height:60px;margin-top:0.75rem;"></div>';

  try {
    var res = await fetch('/api/financial-data/upload', {
      method: 'POST',
      // csrfHeaders, NOT mutatingHeaders: setting Content-Type by hand would
      // strip the multipart boundary the browser generates for FormData.
      headers: csrfHeaders(),
      body: formData
    });
    var data = await res.json();

    if (!data.ok) {
      resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:0.75rem;">'
        + escapeHtml(resolveUserError(data, 'Upload failed.')) + '</p>'
        + renderUnreadDocuments(data.rejected, data.out_of_period);
      return;
    }

    var s = data.summary;
    var d = data.documents;

    resultEl.innerHTML =
      '<div class="glass-card" style="margin-top:1rem;padding:1rem;">' +
      (d
        ? '<div class="upload-summary-row"><span>Documents read</span><span>'
            + d.transactions + ' of ' + d.attached + '</span></div>'
          + '<div class="upload-summary-row"><span>Supporting receipts</span><span>'
            + d.supporting_evidence + '</span></div>'
        : '') +
      '<div class="upload-summary-row"><span>Transactions parsed</span><span>' + s.transaction_count + '</span></div>' +
      '<div class="upload-summary-row"><span>Money in</span><span class="text-emerald">' + formatCurrency(s.inflow) + '</span></div>' +
      '<div class="upload-summary-row"><span>Money out</span><span class="text-red">' + formatCurrency(s.outflow) + '</span></div>' +
      '<div class="upload-summary-row"><span>Net</span><span>' + formatCurrency(s.net_income) + '</span></div>' +
      '</div>' +
      renderUnreadDocuments(d && d.rejected, d && d.out_of_period);

    /* A PARTIAL IMPORT IS NOT A SUCCESS. If some documents could not be read,
       the toast says so — otherwise the user is told "uploaded" and analyses a
       month that is quietly missing records. */
    var unread = (d && d.rejected ? d.rejected.length : 0);
    if (unread) {
      /* THE ANALYSIS IS NOT STARTED AUTOMATICALLY when something was refused.
         Running it re-renders this page and destroys the list above, so the
         user would be moved to a dashboard built from an incomplete month
         having never seen what was missing. They read it, then choose. */
      resultEl.innerHTML += '<button type="button" class="btn-primary btn-full" '
        + 'style="margin-top:0.75rem;" data-fg-action="analyse-anyway" '
        + 'data-period="' + escapeHtml(data.period) + '">'
        + 'Analyse ' + escapeHtml(getMonthLabel(data.period))
        + ' without ' + escapeHtml(String(unread)) + ' document'
        + (unread === 1 ? '' : 's') + '</button>';
      showToast(s.transaction_count + ' transactions imported — but ' + unread
        + ' document' + (unread === 1 ? '' : 's') + ' could not be read. See below.', 'warning');
    } else {
      showToast('Uploaded — ' + s.transaction_count + ' transactions ready for analysis.', 'success');
    }
    /* THE OUTCOME TRAVELS WITH THE CALLBACK. The caller has to know whether
       anything was refused, because navigating away from this panel destroys
       the list of documents that were not imported — and that list is the
       whole point of reporting them. */
    if (opts.onUploaded) {
      opts.onUploaded(data.period, {
        unread: unread,
        transactions: s.transaction_count,
        documents: d || null
      });
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:0.75rem;">Connection error.</p>';
  }
}

async function handleWalletConnectClick(containerId, opts) {
  walletUiState.busy = true;
  walletUiState.error = '';
  renderWalletConnectCard(containerId, opts);
  try {
    await FinGuardWallet.connect();
  } catch (e) {
    walletUiState.error = e.message || 'Could not connect wallet.';
  }
  walletUiState.busy = false;
  renderWalletConnectCard(containerId, opts);
}

async function handleWalletSignInClick(containerId, opts) {
  walletUiState.busy = true;
  walletUiState.error = '';
  renderWalletConnectCard(containerId, opts);
  try {
    await FinGuardWallet.signIn();
  } catch (e) {
    walletUiState.error = e.message || 'Signature verification failed.';
  }
  walletUiState.busy = false;
  renderWalletConnectCard(containerId, opts);
}

function renderWalletConnectCard(containerId, opts) {
  opts = opts || {};
  activeWalletPanel = { containerId: containerId, opts: opts };

  var el = document.getElementById(containerId);
  if (!el) return;

  var w = FinGuardWallet.getState();
  var html = '';
  var cardClass = 'wallet-connect-card glass-card' + (opts.compact ? ' wallet-connect-compact' : '');

  function skipButtonHtml() {
    if (!opts.allowSkip) return '';
    return '<button type="button" class="btn-ghost btn-full" id="' + containerId + '-skip">Skip for now →</button>';
  }

  if (!FinGuardWallet.hasWalletExtension()) {
    html += '<div class="' + cardClass + '">';
    html += '<div class="wallet-connect-icon">' + icon('wallet', { cls: 'icon-lg' }) + '</div>';
    html += '<div class="wallet-connect-title">No wallet found</div>';
    html += '<p class="text-sm text-muted">Install a free browser wallet to connect — Core Wallet is Avalanche’s official wallet and takes about a minute to set up. No technical knowledge needed.</p>';
    html += '<a class="btn-secondary btn-full" href="https://core.app/" target="_blank" rel="noopener">' + icon('link') + ' Get Core Wallet</a>';
    html += skipButtonHtml();
    html += '</div>';
    el.innerHTML = html;
    var skipBtn0 = document.getElementById(containerId + '-skip');
    if (skipBtn0) skipBtn0.addEventListener('click', opts.onSkip || function() {});
    return;
  }

  if (!w.address) {
    html += '<div class="' + cardClass + '">';
    html += '<div class="wallet-connect-icon">' + icon('wallet', { cls: 'icon-lg' }) + '</div>';
    html += '<div class="wallet-connect-title">Connect your wallet</div>';
    html += '<p class="text-sm text-muted">' + escapeHtml(w.providerLabel || 'A wallet') + ' was detected in your browser. Click connect and approve in the popup — this does not move any funds.</p>';
    if (walletUiState.error) html += '<p class="text-sm text-red">' + escapeHtml(walletUiState.error) + '</p>';
    html += '<button type="button" class="btn-primary btn-full" id="' + containerId + '-connect"' + (walletUiState.busy ? ' disabled' : '') + '>' +
      icon('wallet') + (walletUiState.busy ? ' Connecting…' : ' Connect Wallet') + '</button>';
    html += skipButtonHtml();
    html += '</div>';
    el.innerHTML = html;
    var connectBtn = document.getElementById(containerId + '-connect');
    if (connectBtn) connectBtn.addEventListener('click', function() { handleWalletConnectClick(containerId, opts); });
    var skipBtn1 = document.getElementById(containerId + '-skip');
    if (skipBtn1) skipBtn1.addEventListener('click', opts.onSkip || function() {});
    return;
  }

  if (!w.verified) {
    html += '<div class="' + cardClass + '">';
    html += '<div class="wallet-connect-icon text-brand">' + icon('wallet', { cls: 'icon-lg' }) + '</div>';
    html += '<div class="wallet-connect-title">Verify wallet ownership</div>';
    html += '<div class="wallet-address-chip">' + maskWalletAddress(w.address) + '</div>';
    html += '<p class="text-sm text-muted">One more step — sign a free message to prove this wallet is yours. It costs nothing and moves no funds.</p>';
    if (walletUiState.error) html += '<p class="text-sm text-red">' + escapeHtml(walletUiState.error) + '</p>';
    html += '<button type="button" class="btn-primary btn-full" id="' + containerId + '-signin"' + (walletUiState.busy ? ' disabled' : '') + '>' +
      (walletUiState.busy ? 'Waiting for signature…' : 'Sign In to Verify') + '</button>';
    html += skipButtonHtml();
    html += '</div>';
    el.innerHTML = html;
    var signinBtn = document.getElementById(containerId + '-signin');
    if (signinBtn) signinBtn.addEventListener('click', function() { handleWalletSignInClick(containerId, opts); });
    var skipBtn2 = document.getElementById(containerId + '-skip');
    if (skipBtn2) skipBtn2.addEventListener('click', opts.onSkip || function() {});
    return;
  }

  html += '<div class="' + cardClass + ' wallet-connect-verified">';
  html += '<div class="wallet-connect-icon text-emerald">' + icon('check-circle', { cls: 'icon-lg' }) + '</div>';
  html += '<div class="wallet-connect-title">Wallet connected &amp; verified</div>';
  html += '<div class="wallet-address-chip">' + icon('check-circle', { cls: 'text-emerald' }) + ' ' + maskWalletAddress(w.address) + '</div>';
  html += '<div class="text-sm text-muted">' + escapeHtml(networkNameForChainId(w.chainId)) + '</div>';
  if (opts.showContinue) {
    html += '<button type="button" class="btn-primary btn-full" id="' + containerId + '-continue">Continue</button>';
  }
  if (opts.showDisconnect) {
    html += '<button type="button" class="btn-ghost btn-full" id="' + containerId + '-disconnect">Disconnect</button>';
  }
  html += '</div>';
  el.innerHTML = html;

  if (opts.showContinue) {
    var contBtn = document.getElementById(containerId + '-continue');
    if (contBtn) contBtn.addEventListener('click', function() { if (opts.onVerified) opts.onVerified(w.address, w.chainId); });
  }
  if (opts.showDisconnect) {
    var discBtn = document.getElementById(containerId + '-disconnect');
    if (discBtn) discBtn.addEventListener('click', function() {
      FinGuardWallet.disconnect();
      if (opts.onDisconnect) opts.onDisconnect();
    });
  }
  if (opts.onVerifiedAuto) opts.onVerifiedAuto(w.address, w.chainId);
}

/* ── Wizard: Step Navigation ──────────────────────────────────── */
function showOnboardingProgress() {
  $onboardingProgress.classList.remove('hidden');
}

function goToStep1() {
  $onboardStepWelcome.classList.remove('active');
  $onboardStep1.classList.add('active');
  showOnboardingProgress();

  var nameInput = document.getElementById('input-name');
  var companyInput = document.getElementById('input-company');
  if (nameInput && !nameInput.value && appState.authSession && appState.authSession.user) {
    nameInput.value = appState.authSession.user.name || '';
  }
  if (companyInput && !companyInput.value) {
    companyInput.value = appState.businessName && appState.businessName !== 'ABC Traders Ltd' ? appState.businessName : '';
  }
}

/**
 * STEP 2 IS NOW IMPORTING DATA, not connecting a wallet.
 *
 * THE DEFECT. Onboarding was Business -> Wallet -> Data Source, so the second
 * thing an SME owner was asked for was an Avalanche crypto wallet — before
 * they had seen a single figure from their own books. It was skippable, but it
 * was presented as step 2 of 3, which reads as required.
 *
 * The wallet flow is NOT removed. `renderWalletConnectCard` is untouched and
 * still rendered by Settings > Integrations and by the Contracts page, which is
 * where it is genuinely needed. Only the sequencing changed.
 */
function goToStep2() {
  $onboardStep1.classList.remove('active');
  // Straight to the data-source step; the wallet step is no longer in the path.
  $onboardStep3.classList.add('active');
  $progStep1.classList.remove('active');
  $progStep1.classList.add('completed');
  $progStep1.querySelector('.step-number').textContent = '✓';
  $progStep2.classList.add('active');
  if ($progConnector1) $progConnector1.classList.add('filled');

  renderUploadPanel('onboarding-upload-panel', {
    onUploaded: function(period) {
      appState.activeMonth = period;
      completeOnboarding(appState.walletAddress);
      runMonthlyReview(period);
    }
  });
}

function completeOnboarding(walletAddr) {
  appState.walletAddress = walletAddr || appState.walletAddress || '';
  $companyContext.textContent = 'Company: ' + appState.businessName;
  $signupOverlay.classList.add('hidden');

  // Persist to backend
  fetch('/api/profile', {
    method: 'POST',
    headers: mutatingHeaders(),
    body: JSON.stringify({
      name: appState.userName,
      business_name: appState.businessName,
      zoho_api_key: appState.zohoApiKey,
      zoho_org_id: appState.zohoOrgId || '',
      wallet_address: appState.walletAddress
    })
  }).catch(function() { /* silent */ });

  showToast('Welcome, ' + appState.userName + '! Your account is ready.', 'success');
}

/* ── Welcome Screen ───────────────────────────────────────────── */
$btnLoginGoogle.addEventListener('click', function() {
  if (!appState.authSession || !appState.authSession.google_enabled) {
    showToast('Log in is not configured on this server yet.', 'warning');
    return;
  }
  window.location.href = '/api/auth/google/start';
});

/* ── Step 1: Business Details ────────────────────────────────── */
$signupForm.addEventListener('submit', function(e) {
  e.preventDefault();
  var name = document.getElementById('input-name').value.trim();
  var company = document.getElementById('input-company').value.trim();

  if (!name || !company) {
    showToast('Name and company are required.', 'warning');
    return;
  }

  appState.userName = name;
  appState.businessName = company;
  goToStep2();
});

/* ── Step 3: Data Source — Zoho tab ───────────────────────────── */
if ($btnZohoOauth) {
  $btnZohoOauth.addEventListener('click', function() {
    var zohoOrg = document.getElementById('input-zoho-org').value.trim();
    appState.zohoOrgId = zohoOrg;

    var oauthUrl = '/api/oauth/zoho/start?name=' + encodeURIComponent(appState.userName)
      + '&business_name=' + encodeURIComponent(appState.businessName)
      + '&zoho_org_id=' + encodeURIComponent(zohoOrg || '');

    window.location.href = oauthUrl;
  });
}

if ($btnZohoContinue) {
  $btnZohoContinue.addEventListener('click', function() {
    var zohoOrg = document.getElementById('input-zoho-org').value.trim();
    var zoho = document.getElementById('input-zoho').value.trim();
    appState.zohoOrgId = zohoOrg;
    appState.zohoApiKey = zoho;
    completeOnboarding(appState.walletAddress);
  });
}

if ($btnSkipDatasource) {
  $btnSkipDatasource.addEventListener('click', function() {
    completeOnboarding(appState.walletAddress);
  });
}

/* ── Step 3: Data Source tab switching ────────────────────────── */
function switchDataSourceTab(tab) {
  var zohoTab = document.getElementById('tab-datasource-zoho');
  var uploadTab = document.getElementById('tab-datasource-upload');
  var zohoPanel = document.getElementById('panel-datasource-zoho');
  var uploadPanel = document.getElementById('panel-datasource-upload');
  var showUpload = tab === 'upload';

  zohoTab.classList.toggle('active', !showUpload);
  uploadTab.classList.toggle('active', showUpload);
  zohoPanel.classList.toggle('active', !showUpload);
  uploadPanel.classList.toggle('active', showUpload);
}

var $tabDatasourceZoho = document.getElementById('tab-datasource-zoho');
var $tabDatasourceUpload = document.getElementById('tab-datasource-upload');
if ($tabDatasourceZoho) $tabDatasourceZoho.addEventListener('click', function() { switchDataSourceTab('zoho'); });
if ($tabDatasourceUpload) $tabDatasourceUpload.addEventListener('click', function() { switchDataSourceTab('upload'); });

function handleOauthResultFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var oauth = params.get('oauth');
  var auth = params.get('auth');
  if (!oauth && !auth) return;

  if (oauth === 'success') {
    showToast('Zoho Books connected successfully.', 'success');
  } else if (oauth === 'not_configured') {
    showToast('Zoho OAuth is not configured on the server.', 'warning');
  } else if (oauth) {
    showToast('Zoho OAuth failed: ' + (params.get('reason') || 'unknown_error'), 'error');
  }

  if (auth === 'success') {
    showToast('Signed in with Google.', 'success');
  } else if (auth === 'not_configured') {
    showToast('Google sign-in is not configured on the server.', 'warning');
  } else if (auth) {
    showToast('Google sign-in failed: ' + (params.get('reason') || 'unknown_error'), 'error');
  }

  var newUrl = window.location.pathname + window.location.hash;
  history.replaceState(null, '', newUrl);
}

/* ── Demo Mode: Skip everything ──────────────────────────────── */
$btnDemo.addEventListener('click', function() {
  var demoWallet = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
  appState.userName = 'Aisha';
  appState.businessName = 'ABC Traders Ltd';
  appState.zohoApiKey = 'demo_zoho_connected';
  appState.zohoOrgId = 'demo-org-001';
  appState.walletAddress = demoWallet;

  completeOnboarding(demoWallet);
  showToast('Demo Mode active — Zoho and wallet connected with sample data.', 'info');
});

/* ── 7. Router (Fundex-style 5-page structure) ───────────────────
   The 12 original views are consolidated into 5 top-level pages.
   Each tabbed page reuses the original render functions unchanged —
   they still fill #page-content; the tab bar lives in #page-tabs. */
var PAGE_TABS = {
  'activity': [
    { key: 'flagged', label: 'Flagged Items', render: renderRiskAnomalies },
    { key: 'actions', label: 'Action Center',  render: renderActionCenter }
  ],
  'analytics': [
    { key: 'health',   label: 'Financial Health', render: renderFinancialHealth },
    { key: 'cashflow', label: 'Cash Flow',        render: renderCashFlow },
    { key: 'forecast', label: 'Forecast',         render: renderForecast },
    { key: 'revenue',  label: 'Revenue',          render: renderRevenueIntelligence },
    { key: 'reports',  label: 'Executive Reports', render: renderExecutiveReports }
  ],
  'concentration': [
    { key: 'vendors',   label: 'Vendors',   render: renderVendors },
    { key: 'customers', label: 'Customers', render: renderCustomers }
  ]
};


/* ═══════════════════════════════════════════════════════════════
   IMPORT DATA — the monthly product loop.

   THE DEFECT THIS CLOSES. `renderUploadPanel` had exactly ONE caller: step 3
   of the one-time onboarding wizard. After onboarding there was no way to
   import anything — in a product whose entire premise is a monthly financial
   review. A returning user in February had no route to give us February.

   The panel itself is reused unchanged; what was missing was a destination.
   ═══════════════════════════════════════════════════════════════ */

function renderImportData() {
  if ($pageTabs) $pageTabs.innerHTML = '';
  $pageContent.innerHTML =
    '<div class="glass-card">'
    + '<div class="card-title">Import financial data</div>'
    + '<p class="text-sm text-muted">Upload a bank or accounting CSV export, or the '
    + 'source documents themselves — invoices, bills and receipts as PDFs. Each '
    + 'import is analysed on its own, and previous periods stay available.</p>'
    + '<div id="import-upload-panel"></div>'
    + '</div>'
    + '<div class="glass-card section-gap">'
    + '<div class="card-title">Your imports</div>'
    + '<div id="import-history"><p class="text-sm text-muted">Loading…</p></div>'
    + '</div>';

  renderUploadPanel('import-upload-panel', {
    onUploaded: function (period, info) {
      /* AFTER AN IMPORT: analyse that period and take the user to it. The
         month they just gave us is the month they want to see.

         UNLESS SOMETHING WAS NOT IMPORTED. Navigating away destroys the list of
         documents the server refused, so the user would land on a dashboard
         built from an incomplete month with no indication that anything is
         missing. When there is something to read, the analysis still runs but
         the user stays here to read it. */
      appState.activeMonth = period;
      var unread = (info && info.unread) || 0;

      /* Something was refused: the panel now shows what, and an explicit
         "analyse anyway" action. Starting the review here would re-render this
         page and take that list away before it could be read. */
      if (unread) return;

      showToast('Imported ' + getMonthLabel(period) + ' — analysing…', 'info');
      runMonthlyReview(period).then(function () {
        loadImportHistory();
        navigate('overview');
      });
    }
  });

  loadImportHistory();
}

/**
 * Record which periods are analysable, from a server response.
 *
 * `null` means UNKNOWN, and unknown must leave every month clickable. Two ways
 * to arrive at unknown, and both used to collapse into "none":
 *
 *   - persistence is unavailable, so the server cannot see stored runs at all;
 *   - a LIVE SOURCE is connected, so a month needs no stored run to have data.
 *     Zoho can fetch any period on request, and gating on "already analysed"
 *     made that impossible to reach: June could not be analysed because June
 *     had not been analysed.
 *
 * The symptom was a Zoho user with a full June being sent to the upload page.
 */
function applyAvailablePeriods(list, meta) {
  var m = meta || {};
  if (m.live_source) { appState.availablePeriods = null; return; }
  if (m.persistence === 'unavailable' || list === null || list === undefined) {
    appState.availablePeriods = null;
    return;
  }
  appState.availablePeriods = list;
}

/** Which periods this tenant actually has, from the server. */
async function loadImportHistory() {
  var el = document.getElementById('import-history');
  if (!el) return;
  try {
    var res = await fetch('/api/financial-data/uploads');
    var data = await res.json();
    var imports = (data && data.imports) || [];
    applyAvailablePeriods(
      imports.filter(function (i) { return i.analysed; })
        .map(function (i) { return i.period; }),
      data);

    if (!imports.length) {
      el.innerHTML = '<p class="text-sm text-muted">Nothing imported yet. '
        + 'Upload your first period above.</p>';
      return;
    }

    var h = '<div class="import-list">';
    imports.forEach(function (i) {
      h += '<div class="import-row">'
        + '<div><strong>' + escapeHtml(getMonthLabel(i.period)) + '</strong>'
        + '<div class="text-xs text-muted">'
        + (i.analysed ? 'Analysed' : 'Imported — not analysed yet')
        + (i.analysed && !i.recoverable ? ' · needs re-running' : '')
        + '</div></div>'
        + '<button type="button" class="btn-secondary btn-small" onclick="openPeriod(\''
        + escapeHtml(i.period) + '\')">'
        + (i.analysed ? 'View' : 'Analyse') + '</button></div>';
    });
    h += '</div>';
    el.innerHTML = h;
  } catch (e) {
    el.innerHTML = '<p class="text-sm text-muted">Could not load your imports.</p>';
  }
}

/** Switch to a period: recover its analysis if there is one, else run it. */
function openPeriod(period) {
  appState.activeMonth = period;
  navigate('overview');
  runMonthlyReview(period);
}

function renderDashboard() {
  if ($pageTabs) $pageTabs.innerHTML = '';
  // Populate the real period list so the month picker is honest.
  if (appState.availablePeriods === null) loadAvailablePeriods();
  // Renewal state is server-computed; refresh it if we have none yet.
  if (!appState.account) refreshAccount().then(function () { renderOverview(); });
  renderOverview();
}

/** The periods that actually have a completed analysis. */
async function loadAvailablePeriods() {
  try {
    var res = await fetch('/api/analysis/periods');
    var d = await res.json();
    if (d && d.ok) {
      applyAvailablePeriods(
        d.periods === null || d.periods === undefined
          ? null
          : d.periods.map(function (p) { return p.period; }),
        d);
      if (appState.currentPage === 'overview') renderOverview();
    }
  } catch (e) { /* leave null: every month stays clickable */ }
}

/* Untabbed page: clear the tab bar, then render */
function renderSimplePage(fn) {
  if ($pageTabs) $pageTabs.innerHTML = '';
  fn();
}

function renderTabbedPage(page) {
  beginRender();   // invalidate any in-flight fetch from the previous tab
  var tabs = PAGE_TABS[page];
  if (!tabs) { renderDashboard(); return; }
  var active = appState.pageTab[page] || tabs[0].key;
  if (!tabs.some(function(t) { return t.key === active; })) active = tabs[0].key;
  appState.pageTab[page] = active;

  var bar = '<div class="page-tabs-inner">';
  tabs.forEach(function(t) {
    bar += '<button type="button" class="page-tab' + (t.key === active ? ' active' : '') +
      '" onclick="switchTab(\'' + page + '\',\'' + t.key + '\')">' + escapeHtml(t.label) + '</button>';
  });
  bar += '</div>';
  if ($pageTabs) $pageTabs.innerHTML = bar;

  var activeTab = tabs.filter(function(t) { return t.key === active; })[0] || tabs[0];
  activeTab.render();
}

function switchTab(page, tab) {
  appState.pageTab[page] = tab;
  renderTabbedPage(page);
}

var routes = {
  'overview':      { title: 'Dashboard',          render: renderDashboard },
  'import':        { title: 'Import Data',        render: function() { renderSimplePage(renderImportData); } },
  'activity':      { title: 'Activity & Actions', render: function() { renderTabbedPage('activity'); } },
  'analytics':     { title: 'Analytics',          render: function() { renderTabbedPage('analytics'); } },
  'concentration': { title: 'Concentration Risk', render: function() { renderTabbedPage('concentration'); } },
  'contracts':     { title: 'Contracts',          render: function() { renderSimplePage(renderContracts); } },
  'ai':            { title: 'FinGuard',         render: function() { renderSimplePage(renderAIController); } },
  'settings':      { title: 'Settings',           render: function() { renderSimplePage(renderSettings); } }
};

function navigate(page) {
  beginRender();   // invalidate any in-flight fetch from the previous page
  if (!routes[page]) page = 'overview';
  stopStatusPolling();
  appState.currentPage = page;

  /* Update nav active class */
  var links = $navLinks.querySelectorAll('a');
  links.forEach(function(link) {
    if (link.getAttribute('data-page') === page) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });

  /* Update page title */
  $pageTitle.textContent = routes[page].title;

  /* Update URL hash without triggering hashchange */
  if (location.hash.slice(1) !== page) {
    history.replaceState(null, '', '#' + page);
  }

  /* Close profile popover */
  $profilePopover.classList.add('hidden');

  /* Call render function */
  routes[page].render();
}

window.addEventListener('hashchange', function() {
  var page = location.hash.slice(1) || 'overview';
  navigate(page);
});

/* ── 8. Data Fetching ────────────────────────────────────────── */
/* ── STALE-RENDER GUARD ───────────────────────────────────────────
   THE DEFECT. Every page renderer fetches its own data and writes the result
   into the single #page-content element when the promise resolves. Nothing
   cancelled an in-flight request when the user switched tab, so the SLOWER
   earlier request landed last and painted the previous tab's figures under the
   new tab's heading — Executive Reports showing the Forecast's numbers, for
   instance. Wrong-page figures are worse than a spinner: nothing on screen
   reveals the mismatch.

   Every navigation bumps this token. A renderer captures it before fetching
   and discards its own result if the token has moved on. */
var renderToken = 0;

function beginRender() {
  renderToken += 1;
  return renderToken;
}

/** Is this render still the one the user is waiting for? */
function isCurrentRender(token) {
  return token === renderToken;
}

async function fetchPageData(endpoint) {
  var token = renderToken;
  try {
    var response = await fetch('/api/' + endpoint);
    if (!response.ok) return null;
    var json = await response.json();
    if (!json.ok) return null;
    // The user moved on while this was in flight — drop it rather than paint
    // it over whatever they are looking at now.
    if (!isCurrentRender(token)) return null;
    return json;
  } catch (e) {
    return null;
  }
}

var ANALYSIS_STEPS = [
  'Fetching your financial data',
  'Detecting anomalies & fraud signals',
  'Analyzing cash flow & runway',
  'Reviewing vendor & customer concentration',
  'Scoring financial health',
  'Writing guided insights'
];

function startAnalysisProgress(month, label) {
  var periodLabel = label || getMonthLabel(month);
  var steps = ANALYSIS_STEPS.map(function(s, i) {
    return '<li class="ap-step" data-i="' + i + '"><span class="ap-mark"></span>' + escapeHtml(s) + '</li>';
  }).join('');
  var showNotifBtn = window.Notification && Notification.permission === 'default';
  var notifBtn = showNotifBtn
    ? '<button type="button" class="btn-secondary btn-small" id="ap-enable-notif" style="margin-top:0.85rem;">' + icon('bot') + ' Notify me when it’s done</button>'
    : '';
  $pageContent.innerHTML =
    '<div class="analysis-progress glass-card">' +
      '<div class="orb-stage" role="status" aria-live="polite" aria-label="Analysis in progress">' +
        '<div class="orb-loader">' +
          '<span class="orb orb-a"></span>' +
          '<span class="orb orb-b"></span>' +
          '<span class="orb orb-c"></span>' +
          '<span class="orb orb-core"></span>' +
        '</div>' +
      '</div>' +
      '<div class="ap-headline">' +
        '<div class="ap-title">Running your monthly review…</div>' +
        '<div class="ap-sub">Analyzing ' + escapeHtml(periodLabel) + ' — this can take up to a minute on busy periods.</div>' +
      '</div>' +
      '<ul class="ap-steps">' + steps + '</ul>' +
      '<div class="ap-note">' + icon('check-circle') + ' You can switch to other tabs while this runs — we’ll notify you when the analysis is ready.</div>' +
      notifBtn +
    '</div>';

  var enable = document.getElementById('ap-enable-notif');
  if (enable) {
    enable.addEventListener('click', function() {
      if (!window.Notification) return;
      Notification.requestPermission().then(function(p) {
        if (p === 'granted') { enable.textContent = 'Notifications on'; enable.disabled = true; }
        else { enable.textContent = 'Notifications blocked'; enable.disabled = true; }
      });
    });
  }

  var mark = function(idx) {
    document.querySelectorAll('.ap-step').forEach(function(li) {
      var n = Number(li.getAttribute('data-i'));
      li.classList.toggle('done', n < idx);
      li.classList.toggle('active', n === idx);
    });
  };
  var i = 0;
  mark(0);
  appState.analysisTimer = setInterval(function() {
    i = Math.min(i + 1, ANALYSIS_STEPS.length - 1);
    mark(i);
  }, 4500);
}

function stopAnalysisProgress() {
  if (appState.analysisTimer) { clearInterval(appState.analysisTimer); appState.analysisTimer = null; }
}

function notifyAnalysisReady(month, ok) {
  if (window.Notification && Notification.permission === 'granted') {
    try {
      new Notification(ok ? 'FinGuard analysis ready' : 'FinGuard analysis failed', {
        body: ok
          ? 'Your review for ' + getMonthLabel(month) + ' is ready to view.'
          : 'Could not complete the review for ' + getMonthLabel(month) + '.',
        tag: 'finguard-analysis'
      });
    } catch (e) {}
  }
}

async function runMonthlyReview(month, opts) {
  opts = opts || {};
  // Reset until this run actually returns something; see appState.hasAnalysis.
  appState.hasAnalysis = false;
  var periodLabel = scopeLabelFor(month, opts);
  appState.activeMonth = month;
  appState.activeScope = (opts.granularity && opts.granularity !== 'monthly') ? opts : null;
  $analysisMonth.innerHTML = icon('clock') + ' Analyzing ' + escapeHtml(periodLabel) + '…';
  showStatus('Running ' + (opts.granularity || 'monthly') + ' review…');
  appState.isLoading = true;

  /* Ask for notification permission within this click gesture so we can alert when done. */
  if (window.Notification && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }

  /* Update month picker active state */
  var btns = document.querySelectorAll('.month-btn');
  btns.forEach(function(btn) {
    if (btn.getAttribute('data-month') === month) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  startAnalysisProgress(month, periodLabel);

  var ok = false;
  try {
    var res = await fetch('/api/monthly-review', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify(Object.assign({ month: month }, opts))
    });
    var data = await res.json();

    if (data.ok) {
      appState.cachedData = data;
      ok = true;
      appState.hasAnalysis = true;
      /* IS THIS THE USER'S DATA, OR THE DEMO SET? With nothing imported the
         analysis falls back to a fictional business, and the result is
         otherwise indistinguishable from a real one. The server reports the
         source; the banner below is driven from it. */
      appState.isDemoData = (data.data_quality && data.data_quality.source === 'demo')
        || (data.scope && data.scope.source === 'demo') || false;
      var doneLabel = (data.scope && data.scope.label) || periodLabel;
      $analysisMonth.innerHTML = icon('calendar') + ' ' + escapeHtml(doneLabel);
      showToast(appState.isDemoData
        ? 'Sample analysis ready for ' + doneLabel + ' — import your data for a real one.'
        : 'Analysis complete for ' + doneLabel,
      appState.isDemoData ? 'warning' : 'success');
      notifyAiFailureIfAny(data.aiAnalysis);
    } else {
      showToast(resolveUserError(data, 'We could not complete this analysis.'), 'error');
      $analysisMonth.innerHTML = icon('x-circle') + ' Failed';
    }
  } catch (e) {
    showToast('Connection error during analysis.', 'error');
    $analysisMonth.innerHTML = icon('x-circle') + ' Error';
  }

  stopAnalysisProgress();
  notifyAnalysisReady(month, ok);
  loadEntitlement(); /* credits may have been consumed */

  appState.isLoading = false;
  showStatus('');

  /* Re-render current page */
  if (routes[appState.currentPage]) {
    routes[appState.currentPage].render();
  }
}

/* ── 9. Page Renderers ───────────────────────────────────────── */

/* ── Fundex-style dashboard building blocks ──────────────────── */
function fundexStat(iconName, label, value, opts) {
  opts = opts || {};
  var delta = '';
  if (opts.deltaText) {
    var dir = opts.deltaDir === 'down' ? 'down' : (opts.deltaDir === 'up' ? 'up' : 'flat');
    var arrow = dir === 'down' ? '▼ ' : (dir === 'up' ? '▲ ' : '');
    delta = '<span class="stat-delta ' + dir + '">' + arrow + escapeHtml(opts.deltaText) + '</span>';
  }
  var sub = opts.sub ? '<span class="stat-since">' + escapeHtml(opts.sub) + '</span>' : '';
  return '<div class="stat-card">' +
    '<div class="stat-card-top"><span class="stat-icon">' + icon(iconName) + '</span>' +
    '<span class="stat-label">' + escapeHtml(label) + '</span></div>' +
    '<div class="stat-value ' + (opts.valueClass || '') + '">' + value + '</div>' +
    '<div class="stat-foot">' + delta + sub + '</div>' +
  '</div>';
}

function fundexBarChart(bars) {
  var max = 1;
  bars.forEach(function(b) { max = Math.max(max, Math.abs(b.value)); });
  var cols = bars.map(function(b) {
    var h = Math.max(4, Math.round(Math.abs(b.value) / max * 100));
    return '<div class="barchart-col">' +
      '<div class="barchart-val">' + escapeHtml(b.display) + '</div>' +
      '<div class="barchart-track"><div class="barchart-bar" style="height:' + h + '%;background:' + b.color + '"></div></div>' +
      '<div class="barchart-label">' + escapeHtml(b.label) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="barchart">' + cols + '</div>';
}

function fundexDonut(segments) {
  var total = 0;
  segments.forEach(function(s) { total += (s.pct || 0); });
  if (total <= 0) return '';
  var acc = 0;
  var stops = [];
  segments.forEach(function(s) {
    var start = acc / total * 100;
    acc += (s.pct || 0);
    var end = acc / total * 100;
    stops.push(s.color + ' ' + start + '% ' + end + '%');
  });
  var legend = segments.map(function(s) {
    return '<div class="donut-legend-item"><span class="dot" style="background:' + s.color + '"></span>' +
      '<span class="text-sm">' + escapeHtml(s.label) + '</span>' +
      '<span class="text-sm text-muted" style="margin-left:auto">' + formatPercent(s.pct) + '</span></div>';
  }).join('');
  return '<div class="donut-wrap"><div class="donut" style="background:conic-gradient(' + stops.join(',') + ')"><div class="donut-hole"></div></div>' +
    '<div class="donut-legend">' + legend + '</div></div>';
}

/* ── Overview (Dashboard) ────────────────────────────────────── */
/* ── Daily Monitoring Report (dashboard hero) ─────────────────── */
function drStat(ic, value, label, cls) {
  return '<div class="dr-stat"><div class="dr-stat-ic">' + icon(ic) + '</div>' +
    '<div><div class="dr-stat-val ' + (cls || '') + '">' + escapeHtml(String(value)) + '</div>' +
    '<div class="dr-stat-label">' + escapeHtml(label) + '</div></div></div>';
}

function dailyReportHtml() {
  var status = appState.monitoringStatus;
  var m = (status && status.monitoring) || {};
  var enabled = Boolean(m.enabled);
  var alerts = (typeof notifState !== 'undefined' && notifState.items) || [];
  var unread = (typeof notifState !== 'undefined' && notifState.unread) || 0;
  var newLast = m.lastNewIssues != null ? m.lastNewIssues : 0;
  var freqLabel = (MONITOR_FREQ_LABELS && MONITOR_FREQ_LABELS[m.frequency]) || 'Daily';
  var today;
  try { today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
  catch (e) { today = ''; }

  var statusPill = enabled
    ? '<span class="dr-pill dr-pill-on">' + icon('check-circle') + ' ' + escapeHtml(freqLabel) + '</span>'
    : '<span class="dr-pill dr-pill-off">Off</span>';

  var html = '<div class="glass-card daily-report" id="daily-report">';
  html += '<div class="dr-head"><div><div class="dr-title">' + icon('sliders') + ' Daily Monitoring Report</div>' +
    '<div class="dr-sub">' + escapeHtml(today) + ' · automatic financial simulation</div></div>' + statusPill + '</div>';

  var canSchedule = status && status.can_schedule;
  if (!enabled && !canSchedule) {
    html += '<div class="dr-off">' +
      '<p class="text-sm text-muted">Run a fresh analysis any time — unlimited on your plan. ' +
      'Automatic scheduled monitoring is a Growth capability.</p>' +
      '<div class="dr-actions" style="margin-top:0;">' +
        '<button type="button" class="btn-primary btn-small" onclick="syncDailyReport()">' + icon('clock') + ' Run analysis now</button>' +
        '<button type="button" class="btn-ghost btn-small" onclick="showUpgradeModal(\'Automatic scheduled monitoring is available on the Growth and Custom Guidance plans. Manual analysis stays unlimited on Starter.\')">' + lockIcon() + ' Automate this</button>' +
      '</div></div>';
  } else if (!enabled) {
    html += '<div class="dr-off">' +
      '<p class="text-sm text-muted">Continuous monitoring is off. Turn it on to automatically re-run your financial analysis on a schedule and be alerted the moment a new issue appears.</p>' +
      '<button type="button" class="btn-primary btn-small" onclick="enableMonitoringFromDashboard()">' + icon('clock') + ' Turn on monitoring</button>' +
    '</div>';
  } else {
    html += '<div class="dr-stats">';
    html += drStat('alert-triangle', newLast, 'New issues last sync', newLast > 0 ? 'text-red' : 'text-emerald');
    html += drStat('bot', unread, 'Unread alerts', unread > 0 ? 'text-amber' : 'text-muted');
    html += drStat('check-circle', alerts.length, 'Total alerts', 'text-muted');
    html += drStat('clock', freqLabel, 'Sync cadence', 'text-muted');
    html += '</div>';
    html += '<div class="dr-meta">' +
      '<span>Last sync: <strong>' + (m.lastRunAt ? formatDateTime(m.lastRunAt) : 'Never') + '</strong></span>' +
      '<span>Next due: <strong>' + (m.nextDueAt ? formatDateTime(m.nextDueAt) : 'Soon') + '</strong></span>' +
      '<span>Status: <strong class="' + (m.lastStatus === 'error' ? 'text-red' : 'text-emerald') + '">' + escapeHtml(m.lastStatus || '—') + '</strong></span>' +
    '</div>';
  }

  html += '<div class="dr-alerts-head"><div class="card-title" style="margin:0;">Latest alerts</div>' +
    '<button type="button" class="see-all" onclick="toggleNotifPanel()">Open all</button></div>';
  if (alerts.length) {
    html += '<div class="dr-alerts">';
    alerts.slice(0, 5).forEach(function(n) {
      html += '<div class="dr-alert"><span class="notif-dot notif-dot-' + (n.level || 'low') + '"></span>' +
        '<div class="dr-alert-main"><div class="dr-alert-title">' + escapeHtml(n.title || 'Alert') + '</div>' +
        '<div class="dr-alert-body">' + escapeHtml(n.body || '') + '</div></div>' +
        '<div class="dr-alert-time">' + escapeHtml(formatRelativeTime(n.ts)) + '</div></div>';
    });
    html += '</div>';
  } else if (appState.hasAnalysis) {
    // Analysed, and genuinely nothing flagged.
    html += '<div class="dr-empty">' + icon('check-circle') + ' No alerts — your books look clean.</div>';
  } else {
    /* NOTHING HAS BEEN ANALYSED YET. "Your books look clean" is an audit
       RESULT, and stating it before any data has been examined tells a brand
       new user their finances are fine on the strength of nothing. */
    html += '<div class="dr-empty">' + icon('upload') +
      ' No data yet — import your financial records to see alerts.</div>';
  }

  html += '<div class="dr-actions">' +
    '<button type="button" class="btn-secondary btn-small" onclick="syncDailyReport()">' + icon('clock') + ' Sync now</button>' +
    '<button type="button" class="btn-ghost btn-small" onclick="navigate(\'settings\');switchSettingsSection(\'monitoring\');">Monitoring settings</button>' +
  '</div>';
  html += '</div>';
  return html;
}

function weeksInMonth(month) {
  var p = String(month).split('-').map(Number);
  var dim = new Date(p[0], p[1], 0).getDate();
  var weeks = [];
  for (var w = 1; (w - 1) * 7 + 1 <= dim; w++) {
    var sd = (w - 1) * 7 + 1;
    var ed = Math.min(sd + 6, dim);
    weeks.push({ week: w, label: sd + '–' + ed });
  }
  return weeks;
}
function daysInMonthList(month) {
  var p = String(month).split('-').map(Number);
  var dim = new Date(p[0], p[1], 0).getDate();
  var out = [];
  for (var d = 1; d <= dim; d++) out.push(month + '-' + String(d).padStart(2, '0'));
  return out;
}
function scopeLabelFor(month, opts) {
  if (!opts || !opts.granularity || opts.granularity === 'monthly') return getMonthLabel(month);
  if (opts.granularity === 'weekly') return 'Week ' + (opts.week || 1) + ' · ' + getMonthLabel(month);
  var p = String(opts.date || '').split('-');
  var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return p[1] ? names[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0] : getMonthLabel(month);
}

function monthSelectorCompactHtml(prompt) {
  var g = appState.analysisGranularity || 'monthly';
  var head = '<div class="card-head"><div class="card-title" style="margin:0;">Analyze your finances</div>' +
    '<div class="analysis-gran"><span class="text-xs text-muted">Period</span>' +
    '<select class="settings-input analysis-gran-select" onchange="onAnalysisGranularityChange(this.value)">' +
      '<option value="monthly"' + (g === 'monthly' ? ' selected' : '') + '>Monthly</option>' +
      '<option value="weekly"' + (g === 'weekly' ? ' selected' : '') + '>Weekly</option>' +
      '<option value="daily"' + (g === 'daily' ? ' selected' : '') + '>Daily</option>' +
    '</select></div></div>';
  return '<div class="glass-card section-gap month-select-card">' + head +
    '<div id="analysis-scope-body">' + analysisScopeBodyHtml(prompt) + '</div></div>';
}

function analysisScopeBodyHtml(prompt) {
  var g = appState.analysisGranularity || 'monthly';
  var months = generateRecentMonths(12);

  if (g === 'monthly') {
    /* REAL PERIODS, NOT GENERATED ONES.
       This offered the last twelve calendar months regardless of whether any
       data existed for them, so most buttons ran an analysis of nothing — or,
       worse, of the demo dataset. `availablePeriods` comes from the server and
       lists the periods that genuinely have an analysis; anything else is
       shown as unavailable with a route to import it. */
    var have = appState.availablePeriods;
    var grid = months.map(function(m) {
      var isActive = appState.activeMonth === m ? ' active' : '';
      var known = !have || have.indexOf(m) !== -1;
      if (known) {
        return '<button class="month-btn' + isActive + '" data-month="' + m + '" onclick="runMonthlyReview(\'' + m + '\')">' + getMonthLabel(m) + '</button>';
      }
      return '<button class="month-btn month-btn-empty" data-month="' + m + '" title="No data imported for this period" onclick="navigate(\'import\')">' + getMonthLabel(m) + '</button>';
    }).join('');
    var note = (have && have.length === 0)
      ? '<div class="text-xs text-muted" style="margin-bottom:0.6rem;">No periods imported yet — <a href="#import" onclick="navigate(\'import\');return false;">import your data</a> to begin.</div>'
      : (prompt ? '<div class="text-xs text-muted" style="margin-bottom:0.6rem;">Pick a month for a full deep-dive analysis. Dimmed months have no imported data.</div>' : '');
    return note + '<div class="month-picker-grid">' + grid + '</div>';
  }

  /* weekly / daily: choose the month first, then the week or day */
  var selMonth = appState.analysisScopeMonth || months[0];
  if (months.indexOf(selMonth) === -1) selMonth = months[0];
  var monthOpts = months.map(function(m) {
    return '<option value="' + m + '"' + (m === selMonth ? ' selected' : '') + '>' + getMonthLabel(m) + '</option>';
  }).join('');

  var html = '<div class="scope-row"><div class="scope-field"><label class="whatif-label">Month</label>' +
    '<select class="settings-input" id="scope-month" onchange="onScopeMonthChange(this.value)">' + monthOpts + '</select></div>';

  if (g === 'weekly') {
    var weeks = weeksInMonth(selMonth);
    if (!appState.analysisScopeWeek || appState.analysisScopeWeek > weeks.length) appState.analysisScopeWeek = 1;
    var wbtns = weeks.map(function(w) {
      var active = appState.analysisScopeWeek === w.week ? ' active' : '';
      return '<button type="button" class="scope-chip' + active + '" onclick="selectScopeWeek(' + w.week + ')">Week ' + w.week +
        '<span class="scope-chip-sub">' + w.label + '</span></button>';
    }).join('');
    html += '<div class="scope-field scope-field-wide"><label class="whatif-label">Week</label><div class="scope-chips">' + wbtns + '</div></div>';
  } else {
    var days = daysInMonthList(selMonth);
    var selDay = (appState.analysisScopeDay && appState.analysisScopeDay.slice(0, 7) === selMonth) ? appState.analysisScopeDay : days[0];
    appState.analysisScopeDay = selDay;
    var dayOpts = days.map(function(dd) {
      return '<option value="' + dd + '"' + (dd === selDay ? ' selected' : '') + '>' + Number(dd.slice(8)) + '</option>';
    }).join('');
    html += '<div class="scope-field"><label class="whatif-label">Day</label>' +
      '<select class="settings-input" id="scope-day" onchange="appState.analysisScopeDay=this.value">' + dayOpts + '</select></div>';
  }

  html += '<div class="scope-field scope-run"><button type="button" class="btn-primary" onclick="runScopedAnalysis()">' + icon('play') + ' Run analysis</button></div>';
  html += '</div>';
  return html;
}

function rerenderScopeBody() {
  var el = document.getElementById('analysis-scope-body');
  if (el) el.innerHTML = analysisScopeBodyHtml(false);
}
function onAnalysisGranularityChange(v) {
  appState.analysisGranularity = v;
  if (!appState.analysisScopeMonth) appState.analysisScopeMonth = generateRecentMonths(1)[0];
  rerenderScopeBody();
}
function onScopeMonthChange(m) {
  appState.analysisScopeMonth = m;
  appState.analysisScopeWeek = 1;
  appState.analysisScopeDay = m + '-01';
  rerenderScopeBody();
}
function selectScopeWeek(w) {
  appState.analysisScopeWeek = w;
  rerenderScopeBody();
}
function runScopedAnalysis() {
  var g = appState.analysisGranularity || 'monthly';
  var monthEl = document.getElementById('scope-month');
  var month = (monthEl && monthEl.value) || appState.analysisScopeMonth;
  if (g === 'monthly') { runMonthlyReview(month); return; }
  if (g === 'weekly') { runMonthlyReview(month, { granularity: 'weekly', week: appState.analysisScopeWeek || 1 }); return; }
  var dayEl = document.getElementById('scope-day');
  var day = (dayEl && dayEl.value) || appState.analysisScopeDay || (month + '-01');
  runMonthlyReview(month, { granularity: 'daily', date: day });
}

function refreshDailyReport() {
  Promise.all([
    fetch('/api/monitoring').then(function(r) { return r.json(); }).catch(function() { return null; }),
    (typeof loadNotifications === 'function' ? loadNotifications() : Promise.resolve())
  ]).then(function(res) {
    if (res[0] && res[0].ok) appState.monitoringStatus = res[0];
    var node = document.getElementById('daily-report');
    if (node && appState.currentPage === 'overview') node.outerHTML = dailyReportHtml();
  });
}

function syncDailyReport() {
  showToast('Running your daily simulation…', 'info');
  fetch('/api/monitoring/run', { method: 'POST', headers: mutatingHeaders(), body: '{}' })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) {
        var n = (d.result && d.result.newIssues) || 0;
        showToast(n > 0 ? (n + ' new issue' + (n > 1 ? 's' : '') + ' found') : 'Simulation complete — no new issues', 'success');
        if (d.monitoring) appState.monitoringStatus = Object.assign({}, appState.monitoringStatus || {}, { monitoring: d.monitoring });
        if (typeof applyNotifications === 'function') applyNotifications(d.notifications || [], d.unread || 0);
        var node = document.getElementById('daily-report');
        if (node && appState.currentPage === 'overview') node.outerHTML = dailyReportHtml();
      } else { showToast('Sync failed.', 'error'); }
    }).catch(function() { showToast('Sync failed.', 'error'); });
}

function enableMonitoringFromDashboard() {
  fetch('/api/monitoring', { method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ enabled: true }) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) {
        appState.monitoringStatus = d;
        showToast('Monitoring on (' + ((MONITOR_FREQ_LABELS && MONITOR_FREQ_LABELS[d.monitoring.frequency]) || 'Daily') + ')', 'success');
        if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) {} }
        syncDailyReport();
      } else { showToast('Could not enable monitoring.', 'error'); }
    }).catch(function() { showToast('Could not enable monitoring.', 'error'); });
}

function renderOverview() {
  var d = appState.cachedData;

  if (!d) {
    $pageContent.innerHTML = renderRenewalBanner() + dailyReportHtml() +
      renderEmptyState('bar-chart', 'No deep analysis yet', 'Your daily monitoring report is above. Run a full month analysis below for the complete dashboard.') +
      monthSelectorCompactHtml(true);
    refreshDailyReport();
    return;
  }

  var review = d.review || d.data || d;
  var health = (typeof review.health_score === 'object' && review.health_score) || review.health || review.healthScore || {};
  var cashflow = review.cashflow || review.cash_flow || {};
  var risk = review.risk || review.anomalies || {};
  var revenue = review.revenue || {};
  var ai = review.ai_summary || review.controller_summary || review.summary || '';
  var fraud = review.fraud || review.fraud_watch || [];
  var expenses = review.expenses || review.expense_breakdown || [];

  var healthScore = typeof review.health_score === 'number' ? review.health_score
    : (health.overall_score != null ? health.overall_score : health.score);
  var hasHealthScore = typeof healthScore === 'number' && !isNaN(healthScore);
  if (!hasHealthScore) healthScore = '—';
  var cashRunway = cashflow.runway_days || cashflow.cash_runway || '—';
  var riskCount = (risk.findings || risk.items || []).length || 0;
  var revTrend = revenue.growth_rate != null ? formatPercent(revenue.growth_rate) : (revenue.trend || '—');
  var riskLevel = cashflow.risk_level || health.risk_category || (riskCount >= 5 ? 'High' : riskCount >= 2 ? 'Medium' : 'Low');
  var pendingActions = review.pending_actions != null
    ? review.pending_actions
    : ((review.next_actions && review.next_actions.length) || (review.actions && review.actions.length) || 0);

  var criticalFindings = (risk.findings || risk.items || review.findings || []).slice(0, 6);

  /* guidance summary body (shown in the right rail) */
  var aiAnalysis = d.aiAnalysis || {};
  var aiSummaryBody;
  if (aiAnalysis.ok && aiAnalysis.insights) {
    var insights = aiAnalysis.insights;
    aiSummaryBody = '<p class="text-sm" style="line-height:1.7;margin-bottom:0.75rem;">' + escapeHtml(insights.overall_summary || '') + '</p>';
    var keyInsights = (insights.executive_report && insights.executive_report.key_insights) || [];
    if (keyInsights.length) {
      aiSummaryBody += '<ul style="margin:0;padding-left:1.25rem;">';
      keyInsights.forEach(function(k) {
        aiSummaryBody += '<li class="text-sm" style="margin-bottom:0.35rem;line-height:1.5;">' + escapeHtml(k) + '</li>';
      });
      aiSummaryBody += '</ul>';
    }
  } else if (aiAnalysis.reason === 'missing_ai_api_key' || aiAnalysis.mode === 'skills-fallback') {
    var fallbackHint = aiAnalysis.reason === 'missing_ai_api_key'
      ? 'Enable live guidance in Settings for richer guided analysis.'
      : escapeHtml(AI_FAILURE_MESSAGES[aiAnalysis.reason] || 'Live guidance is unavailable right now. Showing computed insights instead.');
    aiSummaryBody = '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(typeof ai === 'string' ? ai : JSON.stringify(ai, null, 2)) + '</p>' +
      '<p class="text-xs text-muted" style="margin-top:0.75rem;">' + fallbackHint + '</p>' +
      '<button type="button" class="btn-secondary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">' + icon('settings') + ' Switch guidance mode</button>';
  } else {
    aiSummaryBody = '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(typeof ai === 'string' ? ai : JSON.stringify(ai, null, 2)) + '</p>';
  }

  var monthLabel = getMonthLabel(appState.activeMonth || '');
  /* Renewal state first: whether the plan is lapsing changes how everything
     below it should be read. */
  var html = renderRenewalBanner() + dailyReportHtml();

  /* ── Stat cards row (Fundex style: icon + value + delta) ── */
  var ncf = cashflow.net_cash_flow;
  var gr = revenue.growth_rate;
  html += '<div class="stat-row">';
  html += fundexStat('shield', 'Financial Health',
    (hasHealthScore ? healthScore : '—') + '<span class="stat-unit">/100</span>',
    // The category is the ENGINE's (health.risk_category), so the label and the
    // colour agree with the score the engine published.
    { valueClass: !hasHealthScore ? 'text-muted'
        : categoryClass(health.risk_category || scoreCategory(healthScore)),
      sub: hasHealthScore
        ? (health.risk_category || scoreCategory(healthScore) || 'Scored')
        : 'No score yet' });
  html += fundexStat('wallet', 'Cash Runway',
    cashRunway + '<span class="stat-unit"> days</span>',
    { sub: 'At current burn rate' });
  html += fundexStat('trending-up', 'Net Cash Flow',
    formatCurrency(ncf || 0),
    { valueClass: ncf > 0 ? 'text-emerald' : ncf < 0 ? 'text-red' : '',
      deltaText: ncf != null ? (ncf >= 0 ? 'Positive' : 'Negative') : '',
      deltaDir: ncf >= 0 ? 'up' : 'down',
      sub: monthLabel });
  html += fundexStat('bar-chart', 'Revenue Trend',
    revTrend,
    { deltaText: gr != null ? formatPercent(gr) : '',
      deltaDir: (gr != null && gr < 0) ? 'down' : 'up',
      sub: 'vs prior period' });
  html += '</div>';

  /* ── Main grid: left (chart + findings), right rail (hero + donut + AI) ── */
  html += '<div class="dash-grid">';

  /* LEFT column */
  html += '<div class="dash-main">';

  /* Cash Flow chart */
  if (cashflow.net_cash_flow != null || cashflow.monthly_burn != null || cashflow.total_receivables != null) {
    var bars = [
      { label: 'Receivables', value: cashflow.total_receivables || 0, display: formatCurrency(cashflow.total_receivables || 0), color: '#22c55e' },
      { label: 'Monthly Burn', value: cashflow.monthly_burn || cashflow.burn_rate || 0, display: formatCurrency(cashflow.monthly_burn || cashflow.burn_rate || 0), color: '#ef4444' },
      { label: 'Net Flow', value: cashflow.net_cash_flow || 0, display: formatCurrency(cashflow.net_cash_flow || 0), color: '#8b5cf6' }
    ];
    html += '<div class="glass-card section-gap chart-card">' +
      '<div class="chart-head"><div><div class="chart-title">Cash Flow</div>' +
      '<div class="chart-sub">Inflow vs outflow</div></div>' +
      '<span class="chart-period">' + escapeHtml(monthLabel || 'This month') + '</span></div>' +
      fundexBarChart(bars) + '</div>';
  }

  /* Recent Findings table (Fundex "Recent Transactions" style) */
  html += '<div class="glass-card chart-card"><div class="card-head"><div class="chart-title">Recent Findings</div>' +
    '<button type="button" class="see-all" onclick="navigate(\'activity\')">See all</button></div>';
  if (criticalFindings.length) {
    html += '<table class="data-table"><thead><tr><th>Finding</th><th>Category</th><th>Severity</th></tr></thead><tbody>';
    criticalFindings.forEach(function(f) {
      var sev = String(f.severity || f.level || 'info').toLowerCase();
      var text = f.message || f.title || f.description || f.text || 'Finding';
      var cat = f.category || f.type || f.skill || '—';
      var badgeClass = (sev === 'critical' || sev === 'high') ? 'badge-high' : sev === 'medium' ? 'badge-medium' : sev === 'low' ? 'badge-low' : 'badge-info';
      var sevColor = (sev === 'critical' || sev === 'high') ? '#ef4444' : sev === 'medium' ? '#f59e0b' : sev === 'low' ? '#22c55e' : '#8b5cf6';
      html += '<tr><td><div class="tx-cell"><span class="tx-icon" style="color:' + sevColor + ';background:' + sevColor + '22">' + icon('alert-triangle') + '</span>' + escapeHtml(text) + '</div></td>' +
        '<td class="text-muted">' + escapeHtml(String(cat)) + '</td>' +
        '<td><span class="' + badgeClass + '">' + escapeHtml(sev) + '</span></td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += renderEmptyState('check-circle', 'No findings', 'Your books look clean for this period.');
  }
  html += '</div>';

  html += '</div>'; /* /dash-main */

  /* RIGHT rail */
  html += '<div class="dash-rail">';

  /* Violet hero card (Fundex balance card) */
  var heroVal = ncf != null ? formatCurrency(ncf) : (hasHealthScore ? healthScore + ' / 100' : '—');
  html += '<div class="balance-card">' +
    '<div class="balance-card-label">Net cash position · ' + escapeHtml(monthLabel) + '</div>' +
    '<div class="balance-card-value">' + heroVal + '</div>' +
    '<div class="balance-card-actions">' +
    '<button type="button" class="balance-btn" onclick="navigate(\'analytics\')">' + icon('bar-chart') + ' Analytics</button>' +
    '<button type="button" class="balance-btn" onclick="navigate(\'activity\')">' + icon('clipboard') + ' Actions</button>' +
    '</div></div>';

  /* Expense breakdown donut */
  var hasExpenses = Array.isArray(expenses) && expenses.length > 0;
  if (hasExpenses) {
    var palette = ['#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#38bdf8', '#a78bfa'];
    var segs = expenses.slice(0, 6).map(function(e, i) {
      return { label: e.category || e.name || 'Other', pct: e.percentage || e.pct || 0, color: palette[i % palette.length] };
    });
    html += '<div class="glass-card"><div class="card-title">Expense Breakdown</div>' + fundexDonut(segs) + '</div>';
  }

  /* guidance summary */
  html += '<div class="glass-card"><div class="card-title">' + icon('bot') + ' FinGuard Summary</div>' + aiSummaryBody + '</div>';

  html += '</div>'; /* /dash-rail */
  html += '</div>'; /* /dash-grid */

  html += monthSelectorCompactHtml(false);

  $pageContent.innerHTML = html;
  refreshDailyReport();
}

/* ── Financial Health ────────────────────────────────────────── */
function renderFinancialHealth() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('health-score').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('bar-chart', 'No Health Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var h = data.health || data.data || data;
    // JOB 7: `|| 0` painted an insufficient-evidence result as a score of ZERO
    // — the visual signature of total collapse — on the app's flagship widget.
    var overallRaw = (h.overall_score != null) ? h.overall_score : h.score;
    var scored = h.available !== false && isMeasured(overallRaw);
    var overall = scored ? overallRaw : null;
    var category = h.risk_category || h.category || 'Unknown';
    var components = h.component_scores || h.components || {};
    var trend = h.trend_note || h.trend || '';

    // JOB 7: this tested for 'low'/'high', which no backend category has been
    // called since the registry defined them (Excellent/Good/Fair/Poor/Critical/
    // Unknown) — so EVERY score rendered amber, including "Excellent" and
    // "Critical". The bands are the server's; the client only maps the label it
    // was given to a colour, and shows an unscored result as neutral.
    var categoryColor = !scored ? 'text-muted' :
                        /excellent|good/i.test(category) ? 'text-emerald' :
                        /fair/i.test(category) ? 'text-amber' :
                        /poor|critical/i.test(category) ? 'text-red' : 'text-muted';

    /* The API's own account of what this score does not rest on, read before
       the number it qualifies. Same helper as every other page. */
    var html = renderDisclosure(data.disclosure);
    html += '<div class="grid-2-1">';

    /* Left: Score display + bars */
    html += '<div class="glass-card">';
    html += '<div style="text-align:center;margin-bottom:2rem;">';
    html += '<div class="score-gauge" style="--score:' + overall + '"><span>' + overall + '</span></div>';
    html += '<div class="text-sm text-muted" style="margin-bottom:0.5rem;">Overall Health Score</div>';
    html += '<span class="' + severityClass(category) + '">' + escapeHtml(category) + '</span>';
    html += '</div>';

    /* Component score bars */
    var compKeys = Object.keys(components);
    if (compKeys.length > 0) {
      html += '<div class="card-title">Component Scores</div>';
      compKeys.forEach(function(key) {
        // JOB 7 CRASH FIX: an unmeasured component is null, and `typeof null`
        // is 'object', so this read null.score and threw — bricking the whole
        // page on the most common insufficient-evidence case.
        var raw = components[key];
        var val = (raw && typeof raw === 'object') ? raw.score : raw;
        var label = key.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
        html += '<div class="score-bar-container">';
        if (!isMeasured(val)) {
          // Shown, but explicitly as NOT measured — never as an empty red bar,
          // which reads as a score of zero.
          html += '<div class="score-bar-label"><span>' + escapeHtml(label) + '</span>'
            + '<span class="text-muted">Not measured</span></div>';
          html += '<div class="score-bar-track"><div class="score-bar-fill score-unmeasured" style="width:100%"></div></div>';
        } else {
          html += '<div class="score-bar-label"><span>' + escapeHtml(label) + '</span><span>' + val + '/100</span></div>';
          html += '<div class="score-bar-track"><div class="score-bar-fill ' + scoreBarClass(val) + '" style="width:' + val + '%"></div></div>';
        }
        html += '</div>';
      });
    }

    html += '</div>';

    /* Right: Details */
    html += '<div class="glass-card">';
    html += '<div class="card-title">Analysis Details</div>';
    if (trend) {
      html += '<div class="finding-item"><div class="severity-dot dot-info"></div><div><div class="finding-text">' + escapeHtml(trend) + '</div></div></div>';
    }
    html += '<div style="margin-top:1rem;">';
    html += '<div class="kpi-label">Risk Category</div>';
    html += '<div class="kpi-value ' + categoryColor + '" style="font-size:1.25rem;">' + escapeHtml(category) + '</div>';
    html += '</div>';
    html += '</div>';

    html += '</div>';

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Cash Flow ───────────────────────────────────────────────── */
function renderCashFlow() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('cashflow').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('wallet', 'No Cash Flow Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var cf = data.cashflow || data.data || data;
    // JOB 7: `||` also swallowed a legitimate runway of 0 — the most dangerous
    // value there is. Measured-ness is now tested explicitly.
    var runwayRaw = (cf.runway_days != null) ? cf.runway_days : cf.cash_runway;
    var runwayKnown = isMeasured(runwayRaw);
    var runway = runwayKnown ? runwayRaw : (cf.never_depletes ? 'No limit' : 'Not measured');
    /* `|| 0` HERE DEFEATED THE isMeasured() GUARD BELOW.
       An unmeasured net cash flow was coerced to 0 before the guard ran, so it
       rendered "KES 0" in the POSITIVE colour — the same JOB 7 defect this file
       fixed elsewhere, still live on this page. Both values stay null when
       unmeasured; formatCurrency() already renders null as the unmeasured
       sentinel rather than a zero amount. */
    var netCF = (cf.net_cash_flow != null) ? cf.net_cash_flow : null;
    var burn = (cf.monthly_burn != null) ? cf.monthly_burn
      : ((cf.burn_rate != null) ? cf.burn_rate : null);
    var liquidity = cf.liquidity_ratio || '—';
    var findings = cf.findings || [];
    var recommendations = cf.recommendations || [];

    var html = '';

    /* The API's own account of what this page cannot show, and why. Placed
       FIRST so it is read before the figures it qualifies. */
    html += renderDisclosure(data.disclosure);

    /* Warnings */
    if (typeof runway === 'number' && runway < 30) {
      html += '<div class="callout-warning"><div class="callout-warning-icon">' + icon('alert-triangle') + '</div><div class="callout-warning-text">Cash runway is below 30 days (' + runway + ' days). Immediate attention required.</div></div>';
    }

    var overdueReceivables = cf.overdue_receivables || cf.overdue_amount || 0;
    if (overdueReceivables > 0) {
      html += '<div class="callout-warning"><div class="callout-warning-icon">' + icon('alert-triangle') + '</div><div class="callout-warning-text">Overdue receivables: ' + formatCurrency(overdueReceivables) + '. Follow up with customers.</div></div>';
    }

    /* KPI Row */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Cash Runway</div><div class="kpi-value ' + (!runwayKnown ? (cf.never_depletes ? 'text-emerald' : 'text-muted')
        : runway < 30 ? 'text-red' : runway < 60 ? 'text-amber' : 'text-emerald') + '">' + runway + (runwayKnown ? ' <span class="text-muted text-sm">days</span>' : '') + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Net Cash Flow</div><div class="kpi-value ' + (!isMeasured(netCF) ? 'text-muted' : netCF >= 0 ? 'text-emerald' : 'text-red') + '">' + formatCurrency(netCF) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Monthly Burn</div><div class="kpi-value ' + (isMeasured(burn) ? '' : 'text-muted') + '">' + formatCurrency(burn) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Liquidity Ratio</div><div class="kpi-value">' + liquidity + '</div></div>';
    html += '</div>';

    /* Findings + Recommendations */
    html += '<div class="grid-2col">';
    html += '<div class="glass-card"><div class="card-title">Findings</div>' + renderFindingsList(findings) + '</div>';
    html += '<div class="glass-card"><div class="card-title">Recommendations</div>';
    if (recommendations.length > 0) {
      recommendations.forEach(function(rec) {
        var text = typeof rec === 'string' ? rec : (rec.description || rec.text || rec.recommendation || '');
        html += '<div class="finding-item"><div class="severity-dot dot-info"></div><div class="finding-text">' + escapeHtml(text) + '</div></div>';
      });
    } else {
      html += '<p class="text-muted text-sm">No recommendations available.</p>';
    }
    html += '</div></div>';

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Cash-flow Forecast (premium: deterministic projection + gated AI advice) ── */
function renderForecast() {
  $pageContent.innerHTML = renderLoadingShimmer(3);
  fetch('/api/forecast', {
    method: 'POST',
    headers: mutatingHeaders(),
    body: JSON.stringify({ month: appState.activeMonth || null })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (!data || !data.ok) {
      $pageContent.innerHTML = renderEmptyState('trending-up', 'Forecast unavailable', 'Run a monthly review first, then open Forecast.');
      return;
    }
    var f = data.forecast;
    var fmt = function(n) { return formatCurrency(n); };
    var statusClass = f.status === 'surplus' ? 'text-emerald' : f.status === 'critical' ? 'text-red' : 'text-amber';
    var statusLabel = f.status === 'surplus' ? 'Cash-positive' : f.status === 'critical' ? 'Cash-critical' : 'Burning cash';
    // JOB 7: `null >= 0` is true, so an unknown net cash flow reported an
    // affirmative "No depletion" all-clear. Not measuring is not good news.
    var daysLabel = f.days_to_zero != null ? (f.days_to_zero + ' days')
      : !isMeasured(f.monthly_net) ? 'Not measured'
        : f.monthly_net >= 0 ? 'No depletion' : UNMEASURED;

    var html = '<div class="stat-row">';
    html += fundexStat('wallet', 'Cash on hand', fmt(f.starting_cash), { sub: 'Starting balance' });
    html += fundexStat('trending-up', 'Monthly net', fmt(f.monthly_net), { valueClass: !isMeasured(f.monthly_net) ? 'text-muted' : f.monthly_net >= 0 ? 'text-emerald' : 'text-red', sub: !isMeasured(f.monthly_net) ? 'Not measured' : f.monthly_net >= 0 ? 'Surplus' : 'Burn rate' });
    html += fundexStat('clock', 'Runs out in', daysLabel, { valueClass: statusClass, sub: statusLabel });
    html += fundexStat('bar-chart', 'In 90 days', fmt(f.horizons[2].projected_balance), { valueClass: !isMeasured(f.horizons[2].projected_balance) ? 'text-muted' : f.horizons[2].projected_balance >= 0 ? 'text-emerald' : 'text-red', sub: 'Projected balance' });
    html += '</div>';

    html += '<div class="dash-grid"><div class="dash-main">';

    var bars = f.series.map(function(s) {
      return { label: s.label, value: s.balance, display: fmt(s.balance), color: !isMeasured(s.balance) ? '#94a3b8' : s.balance >= 0 ? '#22c55e' : '#ef4444' };
    });
    html += '<div class="glass-card chart-card"><div class="chart-head"><div><div class="chart-title">Cash Flow Forecast</div>' +
      '<div class="chart-sub">Calculated from your run-rate · next 90 days · included on every plan</div></div>' +
      '<span class="chart-period">' + escapeHtml(getMonthLabel(data.month || '')) + '</span></div>' + fundexBarChart(bars) + '</div>';

    html += '<div class="glass-card chart-card"><div class="card-head"><div class="chart-title">Projection detail</div></div>' +
      '<table class="data-table"><thead><tr><th>Horizon</th><th>Projected balance</th></tr></thead><tbody>';
    f.horizons.forEach(function(h) {
      html += '<tr><td>' + h.days + ' days</td><td class="' + (!isMeasured(h.projected_balance) ? 'text-muted' : h.projected_balance >= 0 ? 'text-emerald' : 'text-red') + '">' + fmt(h.projected_balance) + '</td></tr>';
    });
    if (f.optimistic_30d_balance != null) {
      html += '<tr><td class="text-muted">+30d if receivables collected (' + fmt(f.overdue_receivables) + ')</td><td class="text-emerald">' + fmt(f.optimistic_30d_balance) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '</div>'; /* /dash-main */

    html += '<div class="dash-rail">';
    var ai = data.ai || {};
    var advisorLocked = (ai.reason === 'upgrade_required');
    html += '<div class="glass-card' + (advisorLocked ? ' advisor-locked' : '') + '">' +
      '<div class="card-title">' + (advisorLocked ? lockIcon() : icon('bot')) + ' Cash Flow Advisor' +
      (advisorLocked ? '<span class="locked-badge" style="margin-left:auto;">' + escapeHtml(featureRequiredPlan('ai_forecast_advisory')) + '</span>' : '') +
      '</div>';
    if (ai.ok && ai.text) {
      html += '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(ai.text) + '</p>';
    } else if (advisorLocked) {
      html += '<p class="text-sm text-muted">Your <strong>Cash Flow Forecast</strong> above is complete and always free — every number, horizon and runway figure is yours.</p>' +
        '<p class="text-sm text-muted" style="margin-top:0.5rem;">The <strong>Cash Flow Advisor</strong> adds the interpretation: what the trend means, which risks matter first, and what to do about them.</p>' +
        '<ul class="locked-list" style="margin-top:0.6rem;">' +
          '<li>Reads your forecast and explains the outlook in plain language</li>' +
          '<li>Prioritises the risks that actually threaten your runway</li>' +
          '<li>Recommends concrete next actions</li>' +
        '</ul>' +
        '<button type="button" class="btn-primary btn-small" onclick="showUpgradeModal(\'' + escapeHtml(upgradeMessage('ai_forecast_advisory')) + '\')">Unlock the Advisor</button>';
    } else if (ai.reason === 'insufficient_credits') {
      html += '<p class="text-sm text-muted">You’re out of guidance credits in the current cycle. Your Cash Flow Forecast above is unaffected — top up or add your own access key for the advisor.</p>' +
        '<button type="button" class="btn-primary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">Upgrade / add key</button>';
    } else if (ai.reason === 'missing_ai_api_key' || ai.reason === 'managed_key_unavailable') {
      html += '<p class="text-sm text-muted">Enable live guidance in Settings to get the advisor’s interpretation of this forecast.</p>' +
        '<button type="button" class="btn-secondary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">' + icon('settings') + ' Guidance settings</button>';
    } else {
      html += '<p class="text-sm text-muted">' + escapeHtml(AI_FAILURE_MESSAGES[ai.reason] || 'The guidance advisor is unavailable right now — your Cash Flow Forecast above is still valid.') + '</p>';
    }
    html += '</div>';
    html += '<div class="glass-card"><div class="card-title">How this is computed</div>' +
      '<p class="text-sm text-muted">Your <strong>Cash Flow Forecast</strong> projects current cash forward at this month’s net run-rate. The <strong>Cash Flow Advisor</strong> only interprets those numbers; it never calculates or changes them.</p></div>';
    html += '</div></div>'; /* /dash-rail /dash-grid */

    html += whatIfCardHtml();

    $pageContent.innerHTML = html;
    if (planAllows('what_if_simulator')) onWhatIfScenarioChange(); /* populate scenario inputs */
    loadEntitlement(); /* AI advisory may have spent credits */
  }).catch(function() {
    $pageContent.innerHTML = renderEmptyState('x-circle', 'Forecast failed', 'Could not compute the forecast. Try again.');
  });
}

/* ── What-If Simulator (Forecast → What If → Adjust → Run → Results) ──
   Client mirror of the server SCENARIOS catalogue so the form fields always
   match what /api/what-if understands. */
var WHATIF_SCENARIOS = {
  increase_payroll: { label: 'Increase payroll', hint: 'Add a recurring monthly staff cost.',
    inputs: [{ key: 'amount', label: 'Extra monthly payroll', type: 'money', default: 50000 }] },
  reduce_revenue: { label: 'Reduce revenue', hint: 'Model a drop in monthly sales.',
    inputs: [{ key: 'percent', label: 'Revenue drop (%)', type: 'percent', default: 20 }] },
  hire_employees: { label: 'Hire employees', hint: 'Add headcount at an average monthly salary.',
    inputs: [{ key: 'count', label: 'New hires', type: 'number', default: 2 },
             { key: 'salary', label: 'Avg monthly salary each', type: 'money', default: 60000 }] },
  increase_rent: { label: 'Increase rent', hint: 'A higher recurring monthly rent.',
    inputs: [{ key: 'amount', label: 'Extra monthly rent', type: 'money', default: 30000 }] },
  large_purchase: { label: 'Large purchase', hint: 'A one-time cash outlay (equipment, inventory).',
    inputs: [{ key: 'amount', label: 'Purchase amount', type: 'money', default: 200000 }] },
  loan_repayment: { label: 'Loan repayment', hint: 'A recurring monthly loan repayment.',
    inputs: [{ key: 'amount', label: 'Monthly repayment', type: 'money', default: 40000 },
             { key: 'months', label: 'Term (months)', type: 'number', default: 12 }] },
  custom: { label: 'Custom scenario', hint: 'Any change: a monthly net effect and/or a one-time cash change.',
    inputs: [{ key: 'label', label: 'Scenario name', type: 'text', default: '' },
             { key: 'monthlyNetDelta', label: 'Monthly net change (+/-)', type: 'signed-money', default: 0 },
             { key: 'oneTimeCashDelta', label: 'One-time cash change (+/-)', type: 'signed-money', default: 0 }] }
};
var WHATIF_ORDER = ['increase_payroll', 'reduce_revenue', 'hire_employees', 'increase_rent', 'large_purchase', 'loan_repayment', 'custom'];

function whatIfCardHtml() {
  /* Decision simulation is strategic planning, not monitoring -- a Growth
     capability. Shown locked (not hidden) so it is discoverable. */
  if (!planAllows('what_if_simulator')) {
    return lockedFeatureCard(
      'what_if_simulator',
      'What-If Simulator',
      'Test a decision before you make it and see the impact on cash, runway and health.'
    );
  }
  var opts = WHATIF_ORDER.map(function(k) {
    return '<option value="' + k + '">' + escapeHtml(WHATIF_SCENARIOS[k].label) + '</option>';
  }).join('');
  return '<div class="glass-card whatif-card">' +
    '<div class="card-head"><div>' +
      '<div class="chart-title">' + icon('sliders') + ' What-If Simulator</div>' +
      '<div class="chart-sub">Model a decision before you make it, then get a guided recommendation.</div>' +
    '</div></div>' +
    '<div class="whatif-controls">' +
      '<div class="whatif-field"><label class="whatif-label">Scenario</label>' +
        '<select id="whatif-scenario" class="whatif-input" onchange="onWhatIfScenarioChange()">' + opts + '</select></div>' +
      '<div id="whatif-inputs" class="whatif-inputs"></div>' +
      '<button type="button" class="btn-primary" id="whatif-run" onclick="runWhatIfSimulation()">' + icon('play') + ' Run Simulation</button>' +
    '</div>' +
    '<div id="whatif-results"></div>' +
  '</div>';
}

function onWhatIfScenarioChange() {
  var sel = document.getElementById('whatif-scenario');
  var box = document.getElementById('whatif-inputs');
  if (!sel || !box) return;
  var scn = WHATIF_SCENARIOS[sel.value];
  if (!scn) { box.innerHTML = ''; return; }
  var html = '';
  scn.inputs.forEach(function(inp) {
    var isNum = inp.type !== 'text';
    var placeholder = inp.type === 'percent' ? '%' : (inp.type === 'text' ? 'e.g. New warehouse lease' : '');
    html += '<div class="whatif-field">' +
      '<label class="whatif-label">' + escapeHtml(inp.label) + '</label>' +
      '<input id="wf-' + inp.key + '" class="whatif-input" ' +
        (isNum ? 'type="number" inputmode="numeric" ' : 'type="text" ') +
        'value="' + escapeHtml(String(inp.default)) + '" placeholder="' + escapeHtml(placeholder) + '"></div>';
  });
  html += '<div class="whatif-hint">' + icon('info') + ' ' + escapeHtml(scn.hint) + '</div>';
  box.innerHTML = html;
}

function runWhatIfSimulation() {
  var sel = document.getElementById('whatif-scenario');
  var btn = document.getElementById('whatif-run');
  var out = document.getElementById('whatif-results');
  if (!sel || !out) return;
  var type = sel.value;
  var scn = WHATIF_SCENARIOS[type];
  var params = {};
  scn.inputs.forEach(function(inp) {
    var el = document.getElementById('wf-' + inp.key);
    if (!el) return;
    params[inp.key] = inp.type === 'text' ? el.value : Number(el.value || 0);
  });

  if (btn) { btn.disabled = true; btn.innerHTML = icon('clock') + ' Simulating…'; }
  out.innerHTML = '<div class="whatif-loading">' + icon('clock') + ' Running scenario…</div>';

  fetch('/api/what-if', {
    method: 'POST', headers: mutatingHeaders(),
    body: JSON.stringify({ month: appState.activeMonth || null, type: type, params: params })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('play') + ' Run Simulation'; }
    if (!data || !data.ok) {
      if (data && data.error === 'upgrade_required') {
        loadEntitlement().then(function() { renderTabbedPage('analytics'); });
        showUpgradeModal(data.message || 'The What-If Simulator is available on the Growth and Custom Guidance plans.');
        return;
      }
      out.innerHTML = '<div class="whatif-loading text-red">' + icon('x-circle') + ' ' +
        escapeHtml(data && data.error === 'unknown_scenario' ? 'Unknown scenario.' : 'Simulation failed. Run a monthly review first.') + '</div>';
      return;
    }
    renderWhatIfResults(data);
    loadEntitlement(); /* guided recommendation may have spent credits */
  }).catch(function() {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('play') + ' Run Simulation'; }
    out.innerHTML = '<div class="whatif-loading text-red">' + icon('x-circle') + ' Connection error during simulation.</div>';
  });
}

function whatIfDelta(before, after, format) {
  var fmt = function(v) {
    if (v == null) return format === 'days' ? 'No depletion' : '—';
    if (format === 'money') return formatCurrency(v);
    if (format === 'days') return v + ' days';
    if (format === 'score') return v + '/100';
    return escapeHtml(String(v));
  };
  return { before: fmt(before), after: fmt(after) };
}

function renderWhatIfResults(data) {
  var out = document.getElementById('whatif-results');
  if (!out) return;
  var r = data.result;
  var arrow = ' <span class="whatif-arrow">' + icon('arrow-right') + '</span> ';

  var html = '<div class="whatif-results-inner">';
  html += '<div class="whatif-scenario-line">' + icon('sliders') + ' <strong>' + escapeHtml(r.scenario.label) + '</strong> — ' + escapeHtml(r.scenario.summary) + '</div>';

  /* Headline before → after tiles */
  html += '<div class="whatif-compare">';
  r.risk_changes.forEach(function(c) {
    var d = whatIfDelta(c.before, c.after, c.format);
    var cls = c.direction === 'better' ? 'text-emerald' : c.direction === 'worse' ? 'text-red' : 'text-muted';
    var dirIcon = c.direction === 'better' ? 'trending-up' : c.direction === 'worse' ? 'trending-down' : 'minus';
    html += '<div class="whatif-metric">' +
      '<div class="whatif-metric-label">' + escapeHtml(c.label) + '</div>' +
      '<div class="whatif-metric-values"><span class="whatif-before">' + d.before + '</span>' + arrow +
        '<span class="whatif-after ' + cls + '">' + d.after + '</span></div>' +
      '<div class="whatif-metric-dir ' + cls + '">' + icon(dirIcon) + ' ' +
        (c.direction === 'better' ? 'Improves' : c.direction === 'worse' ? 'Worsens' : 'No change') + '</div>' +
    '</div>';
  });
  html += '</div>';

  /* Adjusted run-rate summary */
  html += '<div class="whatif-runrate">' +
    '<span>Cash on hand: <strong>' + formatCurrency(r.baseline.starting_cash) + '</strong>' + arrow + '<strong class="' + (r.adjusted.starting_cash >= r.baseline.starting_cash ? 'text-emerald' : 'text-red') + '">' + formatCurrency(r.adjusted.starting_cash) + '</strong></span>' +
    '<span>Monthly net: <strong>' + formatCurrency(r.baseline.monthly_net) + '</strong>' + arrow + '<strong class="' + (r.adjusted.monthly_net >= r.baseline.monthly_net ? 'text-emerald' : 'text-red') + '">' + formatCurrency(r.adjusted.monthly_net) + '</strong></span>' +
  '</div>';

  /* guided recommendation */
  var ai = data.ai || {};
  html += '<div class="whatif-ai">';
  html += '<div class="card-title">' + icon('bot') + ' Guided Recommendation</div>';
  if (ai.ok && ai.text) {
    html += '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(ai.text) + '</p>';
  } else if (ai.reason === 'upgrade_required') {
    html += '<p class="text-sm text-muted">' + escapeHtml(ai.message || 'The guided recommendation is available on Growth or Custom Guidance. The simulation numbers above are free.') + '</p>' +
      '<button type="button" class="btn-primary btn-small" style="margin-top:0.6rem;" onclick="showUpgradeModal(\'Unlock guided recommendations for what-if scenarios on the Growth or Custom Guidance plans.\')">' + icon('bot') + ' Unlock guided recommendation</button>';
  } else if (ai.reason === 'insufficient_credits') {
    html += '<p class="text-sm text-muted">You’re out of guidance credits in the current cycle. The simulation numbers are free — upgrade or add your own access key for the guided recommendation.</p>' +
      '<button type="button" class="btn-primary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">Upgrade / add key</button>';
  } else if (ai.reason === 'missing_ai_api_key' || ai.reason === 'managed_key_unavailable') {
    html += '<p class="text-sm text-muted">Enable live guidance in Settings for a guided recommendation.</p>' +
      '<button type="button" class="btn-secondary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">' + icon('settings') + ' Guidance settings</button>';
  } else {
    html += '<p class="text-sm text-muted">' + escapeHtml(AI_FAILURE_MESSAGES[ai.reason] || 'Guided recommendation unavailable — the simulation numbers above are still valid.') + '</p>';
  }
  html += '</div>';

  html += '</div>';
  out.innerHTML = html;
}

/* ── Revenue Intelligence ────────────────────────────────────── */
function renderRevenueIntelligence() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('revenue').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('trending-up', 'No Revenue Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var rev = data.revenue || data.data || data;
    var total = rev.total_revenue || rev.total || 0;
    var growth = rev.growth_rate != null ? rev.growth_rate : (rev.growth != null ? rev.growth : null);
    var direction = rev.direction || rev.trend_direction || '—';
    var activeCustomers = rev.active_customers || rev.customer_count || '—';
    var findings = rev.findings || [];
    var trends = rev.monthly_trend || rev.trends || [];

    var html = '';

    /* Summary card */
    html += '<div class="glass-card section-gap">';
    html += '<div class="card-title">Revenue Summary</div>';
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Total Revenue</div><div class="kpi-value">' + formatCurrency(total) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Growth Rate</div><div class="kpi-value ' + (!isMeasured(growth) ? 'text-muted' : growth >= 0 ? 'text-emerald' : 'text-red') + '">' + (growth != null ? formatPercent(growth) : '—') + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Direction</div><div class="kpi-value">' + escapeHtml(direction) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Active Customers</div><div class="kpi-value">' + activeCustomers + '</div></div>';
    html += '</div></div>';

    /* Trend bars */
    if (trends.length > 0) {
      html += '<div class="glass-card section-gap">';
      html += '<div class="card-title">Monthly Revenue Trend</div>';
      var maxVal = Math.max.apply(null, trends.map(function(t) { return t.revenue || t.amount || t.value || 0; }));
      trends.forEach(function(t) {
        var val = t.revenue || t.amount || t.value || 0;
        var pct = maxVal > 0 ? (val / maxVal * 100) : 0;
        var label = t.month || t.label || '';
        html += '<div class="concentration-bar">' +
          '<div class="concentration-bar-label"><span>' + escapeHtml(label) + '</span><span>' + formatCurrency(val) + '</span></div>' +
          '<div class="concentration-bar-track"><div class="concentration-bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    /* Findings */
    if (findings.length > 0) {
      html += '<div class="glass-card"><div class="card-title">Revenue Findings</div>' + renderFindingsList(findings) + '</div>';
    }

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Risk & Anomalies ────────────────────────────────────────── */
function renderRiskAnomalies() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('anomalies').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('shield', 'No Risk Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var risk = data.anomalies || data.findings || data.data || data;
    var items = risk.items || risk.findings || (Array.isArray(risk) ? risk : []);

    /* Count by severity */
    var counts = { critical: 0, high: 0, medium: 0, low: 0 };
    items.forEach(function(item) {
      var sev = (item.severity || 'low').toLowerCase();
      if (counts[sev] !== undefined) counts[sev]++;
    });

    var html = '';

    /* Summary stats */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Total Findings</div><div class="kpi-value">' + items.length + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Critical</div><div class="kpi-value text-red">' + counts.critical + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">High</div><div class="kpi-value text-amber">' + counts.high + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Medium / Low</div><div class="kpi-value text-emerald">' + (counts.medium + counts.low) + '</div></div>';
    html += '</div>';

    /* Data table */
    if (items.length > 0) {
      html += '<div class="glass-card">';
      html += '<table class="data-table"><thead><tr><th>Type</th><th>Severity</th><th>Description</th><th></th></tr></thead><tbody>';
      items.forEach(function(item) {
        var key = item.finding_id || item.id || '';
        html += '<tr>';
        html += '<td>' + escapeHtml(item.type || item.category || '—') + '</td>';
        html += '<td><span class="' + severityClass(item.severity) + '">' + escapeHtml(item.severity || '—') + '</span></td>';
        html += '<td>' + escapeHtml(item.description || item.text || item.message || '—') + '</td>';
        /* INVESTIGATE. A finding says "these two payments are duplicates"; the
           user's next question is always "which two?". The backend has been
           able to answer that since JOB 12 and nothing asked it. */
        html += '<td>' + (key
          ? '<button type="button" class="btn-secondary btn-small" data-fg-action="investigate"'
            + ' data-finding="' + escapeHtml(key) + '">Investigate</button>'
          : '') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += renderEmptyState('check-circle', 'No Anomalies Detected', 'Your financials look clean this period.');
    }

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Vendors ─────────────────────────────────────────────────── */
function renderVendors() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('vendors').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('building', 'No Vendor Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var v = data.vendors || data.data || data;
    // JOB 7: `'—' >= 70` and `'—' >= 40` are both false, so an UNMEASURABLE
    // score fell through to text-red — the client inventing a critical reading
    // out of "we could not attribute these transactions".
    var riskRaw = (v.vendor_risk_score != null) ? v.vendor_risk_score : v.risk_score;
    var riskKnown = v.available !== false && isMeasured(riskRaw);
    var riskScore = riskKnown ? riskRaw : UNMEASURED;
    var concentrationObj = (v.concentration && typeof v.concentration === 'object') ? v.concentration : {};
    var concentrationPct = concentrationObj.top_3_percentage != null ? concentrationObj.top_3_percentage
      : (typeof v.top_vendor_concentration === 'number' ? v.top_vendor_concentration
      : (typeof v.concentration === 'number' ? v.concentration : null));
    var topVendor = v.top_vendor || v.largest_vendor || '—';
    var vendors = v.vendor_list || v.vendors || v.breakdown || [];
    var findings = v.findings || [];

    var html = '';

    /* Summary */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Vendor Risk Score</div><div class="kpi-value ' + (!riskKnown ? 'text-muted' : categoryClass(scoreCategory(riskScore))) + '">' + riskScore + (riskKnown ? '<span class="text-muted text-sm">/100</span>' : '')  + '</div></div>';
    /* `unavailableNotice(c, 'Customer concentration')` used to sit here — a
       copy-paste from renderCustomers that referenced an undefined `c` AND
       named the wrong metric. It threw `ReferenceError: c is not defined` on
       every render, so the Vendors page was blank for every user, on every
       period, while /api/vendors returned complete data. */
    html += unavailableNotice(v, 'Vendor concentration');
    html += '<div class="kpi-card"><div class="kpi-label">Top 3 Concentration</div><div class="kpi-value">' + (concentrationPct != null ? formatPercent(concentrationPct) : '—') + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Top Vendor</div><div class="kpi-value text-sm" style="font-size:1.1rem">' + escapeHtml(typeof topVendor === 'object' ? (topVendor.name || '—') : topVendor) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Vendor Count</div><div class="kpi-value">' + vendors.length + '</div></div>';
    html += '</div>';

    /* Vendor bars */
    if (vendors.length > 0) {
      html += '<div class="glass-card section-gap"><div class="card-title">Vendor Spend Distribution</div>';
      vendors.slice(0, 10).forEach(function(vendor) {
        var name = vendor.name || vendor.vendor || 'Unknown';
        var pct = vendor.percentage || vendor.pct || vendor.share || 0;
        html += '<div class="concentration-bar">' +
          '<div class="concentration-bar-label"><span>' + escapeHtml(name) + '</span><span>' + formatPercent(pct) + '</span></div>' +
          '<div class="concentration-bar-track"><div class="concentration-bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    /* Findings */
    if (findings.length > 0) {
      html += '<div class="glass-card"><div class="card-title">Vendor Findings</div>' + renderFindingsList(findings) + '</div>';
    }

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Customers ───────────────────────────────────────────────── */
function renderCustomers() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('customers').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('users', 'No Customer Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var c = data.customers || data.data || data;
    // JOB 7: `'—' >= 70` and `'—' >= 40` are both false, so an UNMEASURABLE
    // score fell through to text-red — the client inventing a critical reading
    // out of "we could not attribute these transactions".
    var riskRaw = (c.customer_risk_score != null) ? c.customer_risk_score : c.risk_score;
    var riskKnown = c.available !== false && isMeasured(riskRaw);
    var riskScore = riskKnown ? riskRaw : UNMEASURED;
    var concentrationObj = (c.concentration && typeof c.concentration === 'object') ? c.concentration : {};
    var concentrationPct = concentrationObj.top_3_percentage != null ? concentrationObj.top_3_percentage
      : (typeof c.top_customer_concentration === 'number' ? c.top_customer_concentration
      : (typeof c.concentration === 'number' ? c.concentration : null));
    var topCustomer = c.top_customer || c.largest_customer || '—';
    var customers = c.customer_list || c.customers || c.breakdown || [];
    var findings = c.findings || [];

    var html = '';

    /* Summary */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Customer Risk Score</div><div class="kpi-value ' + (!riskKnown ? 'text-muted' : categoryClass(scoreCategory(riskScore))) + '">' + riskScore + (riskKnown ? '<span class="text-muted text-sm">/100</span>' : '')  + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Top 3 Concentration</div><div class="kpi-value">' + (concentrationPct != null ? formatPercent(concentrationPct) : '—') + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Top Customer</div><div class="kpi-value text-sm" style="font-size:1.1rem">' + escapeHtml(typeof topCustomer === 'object' ? (topCustomer.name || '—') : topCustomer) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Customer Count</div><div class="kpi-value">' + customers.length + '</div></div>';
    html += '</div>';

    /* Customer bars */
    if (customers.length > 0) {
      html += '<div class="glass-card section-gap"><div class="card-title">Customer Revenue Distribution</div>';
      customers.slice(0, 10).forEach(function(cust) {
        var name = cust.name || cust.customer || 'Unknown';
        var pct = cust.percentage || cust.pct || cust.share || 0;
        html += '<div class="concentration-bar">' +
          '<div class="concentration-bar-label"><span>' + escapeHtml(name) + '</span><span>' + formatPercent(pct) + '</span></div>' +
          '<div class="concentration-bar-track"><div class="concentration-bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    /* Findings */
    if (findings.length > 0) {
      html += '<div class="glass-card"><div class="card-title">Customer Findings</div>' + renderFindingsList(findings) + '</div>';
    }

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* ── Action Center ───────────────────────────────────────────── */
function renderActionCenter() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('actions').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('check-circle', 'No Actions', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var actions = data.actions || data.tasks || data.data || [];
    if (!Array.isArray(actions)) actions = [];

    var html = '';

    /* Action bar */
    html += '<div style="display:flex;gap:0.75rem;margin-bottom:1.25rem;flex-wrap:wrap;">';
    html += '<button class="btn-primary btn-small" onclick="generateActionPlan()">' + icon('bot') + ' Generate Guided Action Plan</button>';
    html += '<button class="btn-small" onclick="exportActions(\'csv\')">' + icon('download') + ' Export CSV</button>';
    html += '<button class="btn-small" onclick="exportActions(\'json\')">' + icon('download') + ' Export JSON</button>';
    html += '</div>';

    /* AI action plan renders here */
    html += '<div id="action-plan-result" class="section-gap"></div>';

    /* Actions table (with client-side done toggle) */
    if (actions.length > 0) {
      html += '<div class="glass-card">';
      html += '<table class="data-table"><thead><tr><th></th><th>Priority</th><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>';
      actions.forEach(function(action) {
        var priority = action.priority || 'medium';
        html += '<tr>';
        html += '<td><input type="checkbox" onchange="toggleTaskDone(this)" aria-label="Mark done" /></td>';
        html += '<td><span class="' + severityClass(priority) + '">' + escapeHtml(priority) + '</span></td>';
        html += '<td><span class="task-text">' + escapeHtml(action.task || action.description || action.title || '—') + '</span></td>';
        html += '<td><span class="action-owner">' + escapeHtml(action.owner || action.assigned_to || '—') + '</span></td>';
        html += '<td class="text-muted text-sm">' + escapeHtml(action.due || action.due_date || '—') + '</td>';
        html += '<td>' + escapeHtml(action.status || 'Pending') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += renderEmptyState('check-circle', 'All Clear', 'No pending actions at this time.');
    }

    html += renderAiInsightsCard(data.ai_insights);

    $pageContent.innerHTML = html;
  });
}

/* Guided Action Plan (gated premium action) */
function generateActionPlan() {
  var out = document.getElementById('action-plan-result');
  if (out) out.innerHTML = '<div class="glass-card"><div class="card-title">' + icon('bot') + ' Guided Action Plan</div>' + renderLoadingShimmer(2) + '</div>';
  fetch('/api/action-plan', {
    method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ month: appState.activeMonth || null })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (!out) return;
    var ai = (data && data.ai) || {};
    var body;
    if (ai.ok && ai.text) {
      body = '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(ai.text) + '</p>';
    } else if (ai.reason === 'insufficient_credits') {
      body = '<p class="text-sm text-muted">You’re out of guidance credits in the current cycle. Upgrade to Pro or add your own access key to generate action plans.</p>' +
        '<button type="button" class="btn-primary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">Upgrade / add key</button>';
    } else if (ai.reason === 'missing_ai_api_key' || ai.reason === 'managed_key_unavailable') {
      body = '<p class="text-sm text-muted">Enable live guidance in Settings to generate an action plan.</p>' +
        '<button type="button" class="btn-secondary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">' + icon('settings') + ' Guidance settings</button>';
    } else {
      body = '<p class="text-sm text-muted">' + escapeHtml(AI_FAILURE_MESSAGES[ai.reason] || 'Could not generate the action plan. Try again.') + '</p>';
    }
    out.innerHTML = '<div class="glass-card glow-border"><div class="card-title">' + icon('bot') + ' Guided Action Plan · ' + escapeHtml(getMonthLabel(data.month || '')) + '</div>' + body + '</div>';
    loadEntitlement();
  }).catch(function() {
    if (out) out.innerHTML = '<div class="glass-card"><p class="text-sm text-red">Could not generate the action plan. Try again.</p></div>';
  });
}

function toggleTaskDone(cb) {
  var row = cb.closest('tr');
  if (row) row.classList.toggle('task-done', cb.checked);
}

/* Export helper */
function exportActions(format) {
  fetchPageData('actions').then(function(data) {
    if (!data) { showToast('No data to export.', 'warning'); return; }
    var actions = data.actions || data.tasks || data.data || [];

    if (format === 'json') {
      var blob = new Blob([JSON.stringify(actions, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'actions.json');
    } else {
      /* CSV CANNOT CARRY A NOTICE BLOCK, so the limitation becomes an explicit
         COLUMN rather than being silently dropped. A downloaded file is read
         with no app around it: if the analysis behind these actions rested on
         estimated or unmeasured inputs, the file has to say so itself.

         The actions carry no measured financial figures, so nothing here can
         misstate an amount -- what is at stake is the COMPLETENESS of the list,
         which is exactly what this column records. */
      var limitations = (data.disclosure && data.disclosure.limitations) || [];
      var analysisNote = limitations.length
        ? 'Analysis incomplete: ' + limitations.map(function (l) {
          return l.detail || l.metric || l.input || 'unspecified limitation';
        }).join(' | ')
        : 'Analysis complete';

      function csvCell(v) {
        return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      }

      var csv = 'Priority,Task,Owner,Due,Status,Analysis status\n';
      actions.forEach(function(a) {
        csv += [
          csvCell(a.priority), csvCell(a.task || a.description), csvCell(a.owner),
          csvCell(a.due || a.due_date), csvCell(a.status), csvCell(analysisNote)
        ].join(',') + '\n';
      });
      var blob = new Blob([csv], { type: 'text/csv' });
      downloadBlob(blob, 'actions.csv');
    }
    if (data.disclosure && (data.disclosure.limitations || []).length) {
      showToast('Export downloaded \u2014 it notes the analysis limitations.', 'warning');
    } else {
      showToast('Export downloaded!', 'success');
    }
  });
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Executive Reports ───────────────────────────────────────── */
function renderExecutiveReports() {
  var reportTypes = [
    { id: 'monthly_review',  iconName: 'clipboard',     title: 'Monthly Review',      desc: 'Comprehensive monthly financial review with all KPIs, findings, and recommendations.' },
    { id: 'weekly_risk',     iconName: 'shield-alert',  title: 'Weekly Risk Report',   desc: 'Focused risk analysis including anomalies, fraud indicators, and urgent items.' },
    { id: 'board_summary',   iconName: 'bar-chart',     title: 'Board Summary',       desc: 'High-level summary suitable for board presentation with key metrics.' },
    { id: 'investor_summary', iconName: 'briefcase',    title: 'Investor Summary',   desc: 'Investor-ready report with growth metrics, runway, and financial health.' }
  ];

  var html = '<div class="grid-2col">';
  reportTypes.forEach(function(rt) {
    html += '<div class="report-card" id="report-card-' + rt.id + '">';
    html += '<div class="report-card-icon">' + icon(rt.iconName, { cls: 'icon-xl' }) + '</div>';
    html += '<div class="report-card-title">' + escapeHtml(rt.title) + '</div>';
    html += '<div class="report-card-desc">' + escapeHtml(rt.desc) + '</div>';
    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">';
    html += '<button class="btn-secondary btn-small" onclick="generateReport(\'' + rt.id + '\')">Preview</button>';
    html += '<button class="btn-primary btn-small" onclick="downloadExecutiveReportPdf(\'' + rt.id + '\')">' + icon('download') + ' Download PDF</button>';
    html += '</div>';
    html += '<div id="report-result-' + rt.id + '"></div>';
    html += '</div>';
  });
  html += '</div>';

  $pageContent.innerHTML = html;
}

async function generateReport(reportType) {
  var resultEl = document.getElementById('report-result-' + reportType);
  if (!resultEl) return;

  resultEl.innerHTML = '<div class="loading-shimmer" style="height:60px;margin-top:1rem;"></div>';
  showToast('Generating ' + reportType.replace(/_/g, ' ') + '…', 'info');

  try {
    var res = await fetch('/api/executive-report', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify({ report_type: reportType })
    });
    var data = await res.json();

    if (data.ok) {
      var content = data.report || data.content || data.text || JSON.stringify(data.data, null, 2);
      /* A REPORT WITH LIMITATIONS IS NOT AN UNQUALIFIED SUCCESS.
         The limitations are already written into the report TEXT server-side,
         so they travel with anything exported or forwarded. What was missing
         here was the signal at the moment of generation: "generated
         successfully" told the user the document was complete when the server
         had said `complete: false`. The structured block is rendered above the
         text as well, using the same helper as every other page. */
      resultEl.innerHTML = renderDisclosure(data.disclosure)
        + '<div class="report-result">' + escapeHtml(content) + '</div>';
      if (data.complete === false) {
        showToast('Report generated — see the limitations noted on it.', 'warning');
      } else {
        showToast('Report generated successfully!', 'success');
      }
    } else {
      resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:1rem;">Failed: ' + escapeHtml(resolveUserError(data, 'This operation could not be completed.')) + '</p>';
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:1rem;">Connection error.</p>';
  }
}

/* Download the branded PDF (gated: Free → upgrade modal; Pro → 20 credits; BYOK → free) */
function downloadExecutiveReportPdf(reportType) {
  /* Reports are available on every plan -- rendering a document from already
     computed numbers is deterministic work, not intelligence. */
  showToast('Preparing your PDF…', 'info');
  fetch('/api/executive-report/pdf', {
    method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ report_type: reportType })
  }).then(function(res) {
    var ct = res.headers.get('content-type') || '';
    if (res.ok && ct.indexOf('application/pdf') !== -1) {
      var cd = res.headers.get('content-disposition') || '';
      var m = cd.match(/filename="?([^"]+)"?/);
      var fname = m ? m[1] : 'finguard-report.pdf';
      return res.blob().then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Report downloaded.', 'success');
        loadEntitlement(); /* credits may have changed */
      });
    }
    return res.json().then(function(d) {
      if (d.error === 'no_report') showToast('Run a monthly review first, then download.', 'warning');
      else showToast(resolveUserError(d, 'Could not generate the PDF right now.'), 'error');
    });
  }).catch(function() { showToast('Could not download the PDF. Try again.', 'error'); });
}


/** Every upgrade path lands here — one destination, one checkout. */
function openPlansAndBilling() {
  navigate('settings');
  switchSettingsSection('plan');
}

/**
 * RENEWAL BANNER.
 *
 * M-Pesa has no merchant-initiated auto-debit, so a paid period genuinely ends
 * and the customer has to renew. `renewal` is computed server-side from the
 * authoritative expiry — the client does no date arithmetic of its own on a
 * value it was handed.
 *
 * The expired copy leads with what is NOT lost. "Your plan expired" reads to an
 * SME owner as "my books are gone", and that fear is worth one explicit
 * sentence to prevent.
 */

/** A plan key -> its label, from the catalog the server sent. */
function featurePlanLabel(planKey) {
  var opts = (appState.account && appState.account.upgrade_options) || [];
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].key === planKey) return opts[i].label;
  }
  // Not in the upgrade list because it IS the current plan.
  if (appState.account && appState.account.plan === planKey) {
    return appState.account.plan_label;
  }
  return null;
}

function renderRenewalBanner() {
  var r = appState.account && appState.account.renewal;
  if (!r || r.state === 'none' || r.state === 'active') return '';

  /* THE PLAN THAT LAPSED, not the plan they are on now. After expiry the
     current plan is Starter, so `plan_label` would render "Renew Starter" —
     asking the user to buy the free tier. `renewal.plan` carries what actually
     expired. */
  var lapsed = r.plan && featurePlanLabel(r.plan);
  var planLabel = lapsed
    || (appState.account && appState.account.plan_label)
    || 'your plan';

  if (r.state === 'expired') {
    return '<div class="callout-warning renewal-expired">'
      + '<div class="callout-warning-icon">' + icon('alert-triangle') + '</div>'
      + '<div class="callout-warning-text">'
      + '<strong>Your plan has expired.</strong> '
      + 'Your financial data and historical analyses are still here — nothing has '
      + 'been deleted. Paid features are locked until you renew.'
      + '<div style="margin-top:0.6rem;"><button type="button" class="btn-primary btn-small" '
      + 'onclick="openPlansAndBilling()">Renew ' + escapeHtml(planLabel) + '</button></div>'
      + '</div></div>';
  }

  var d = r.days_remaining;
  var when = d <= 1 ? 'tomorrow' : ('in ' + d + ' days');
  return '<div class="callout-warning renewal-soon">'
    + '<div class="callout-warning-icon">' + icon('clock') + '</div>'
    + '<div class="callout-warning-text">'
    + 'Your ' + escapeHtml(planLabel) + ' plan expires ' + escapeHtml(when) + '. '
    + 'Renew to keep forecasting, what-if analysis and advanced guided features.'
    + '<div style="margin-top:0.6rem;"><button type="button" class="btn-primary btn-small" '
    + 'onclick="openPlansAndBilling()">Renew now</button></div>'
    + '</div></div>';
}

function showUpgradeModal(message) {
  closeUpgradeModal();
  var wrap = document.createElement('div');
  wrap.id = 'upgrade-modal';
  wrap.className = 'modal-overlay';
  wrap.innerHTML = '<div class="modal-card glass-card">' +
    '<div class="modal-icon">' + icon('bot', { cls: 'icon-xl' }) + '</div>' +
    '<h2>Unlock more with Growth</h2>' +
    '<p class="text-sm text-muted">' + escapeHtml(message) + '</p>' +
    '<div class="modal-actions">' +
      /* WAS `setPlan('growth')` — a direct call to the test-only grant
         endpoint, which is refused outside NODE_ENV=test. In production this
         button showed "Could not change plan". An upgrade now goes where an
         upgrade actually happens: Plans & Billing, and a real checkout. */
      '<button type="button" class="btn-primary btn-full" onclick="closeUpgradeModal();openPlansAndBilling()">See plans &amp; upgrade</button>' +
      '<button type="button" class="btn-secondary btn-full" onclick="closeUpgradeModal();navigate(\'settings\')">Add my own access key</button>' +
      '<button type="button" class="btn-ghost" onclick="closeUpgradeModal()">Maybe later</button>' +
    '</div></div>';
  wrap.addEventListener('click', function(ev) { if (ev.target === wrap) closeUpgradeModal(); });
  document.body.appendChild(wrap);
}

function closeUpgradeModal() {
  var m = document.getElementById('upgrade-modal');
  if (m) m.remove();
}

/* ── FinGuard (Chat) ────────────────────────────────────── */
function renderAIController() {
  var suggestedQuestions = [
    'Why is profit dropping?',
    'What is our biggest risk?',
    'Which customer should we follow up?',
    'Why is cash running low?',
    'What should I fix this week?'
  ];

  var html = '<div class="chat-page">';

  html += '<div class="glass-card" style="margin-bottom:1rem;padding:0.9rem 1rem">';
  html += '<div class="text-sm text-muted">Assistant style: <strong>' + escapeHtml(appState.aiAssistant) + '</strong> · grounded in your latest analysis</div>';
  html += '</div>';

  /* Chat chips */
  html += '<div class="chat-chips">';
  suggestedQuestions.forEach(function(q) {
    html += '<button class="chat-chip" onclick="sendChatFromChip(this)" data-question="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>';
  });
  html += '</div>';

  /* Chat feed */
  html += '<div class="chat-feed-full" id="chat-feed">';
  if (appState.chatHistory.length === 0) {
    /* Finna greets an empty conversation, idling. She is the same single
       instance that will later follow the answers down the page. */
    html += '<div class="empty-state" style="flex:1">'
      + '<div class="empty-state-icon finna-slot finna-slot-lg"></div>'
      + '<div class="empty-state-title">Finna</div>'
      + '<div class="empty-state-text">Ask me anything about your finances. '
      + 'I have full context from your latest analysis.</div></div>';
  } else {
    appState.chatHistory.forEach(function(msg) {
      html += renderChatMessage(msg.role, msg.content);
    });
  }
  html += '</div>';

  /* Input bar */
  html += '<div class="chat-input-wrapper">';
  html += '<input type="text" class="chat-input" id="chat-input" placeholder="Ask the FinGuard…" onkeydown="if(event.key===\'Enter\')sendChat()" />';
  html += '<button class="btn-primary" onclick="sendChat()">Send ' + icon('send') + '</button>';
  html += '</div>';

  html += '</div>';

  $pageContent.innerHTML = html;

  /* Scroll to bottom */
  var feed = document.getElementById('chat-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;

  /* Put Finna in the newest assistant slot: the greeting on an empty
     conversation, otherwise beside the last thing she said. */
  if (window.Finna) {
    var slots = document.querySelectorAll('.finna-slot');
    if (slots.length) {
      Finna.mount(slots[slots.length - 1], { size: slots.length === 1 ? 96 : 44 });
      Finna.setState('idle');
    }
  }
}

/* Render a safe subset of Markdown so guided answers show as formatted text
   (bold, headings, bullets) instead of raw asterisks and hashes. HTML is
   escaped FIRST, so nothing the model emits can inject markup. */
function inlineMd(s) {
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}
function mdLiteToHtml(raw) {
  var lines = escapeHtml(String(raw || '')).split(/\r?\n/);
  var html = '';
  var inList = false;
  var closeList = function() { if (inList) { html += '</ul>'; inList = false; } };
  lines.forEach(function(line) {
    var t = line.trim();
    if (!t) { closeList(); return; }
    var h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html += '<div class="chat-h chat-h' + Math.min(h[1].length, 4) + '">' + inlineMd(h[2].replace(/:\s*$/, '')) + '</div>'; return; }
    var li = t.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul class="chat-ul">'; inList = true; } html += '<li>' + inlineMd(li[2]) + '</li>'; return; }
    closeList();
    html += '<div class="chat-p">' + inlineMd(t) + '</div>';
  });
  closeList();
  return html;
}

/* ── Finna, the copilot's face ─────────────────────────────────────
   She is a single instance that re-anchors to the newest assistant message, so
   she appears to follow the conversation down the page rather than being
   duplicated on every bubble.

   EVERY STATE COMES FROM A REAL EVENT. `thinking` while the request is in
   flight, `speaking` while an answer is being placed on the page, `error` when
   one did not arrive. Nothing here is on a timer that guesses at progress. */

/** Move Finna into a message's slot and set her state. Safe if she is absent. */
function mountFinnaOn(messageEl, state) {
  if (!window.Finna || !messageEl) return null;
  var slot = messageEl.querySelector('.finna-slot');
  if (!slot) return null;
  var f = Finna.mount(slot);
  if (f && state) f.setState(state);
  return f;
}

/**
 * Talk for as long as there is plausibly something to read, then settle.
 *
 * Scaled to the length of the answer rather than a fixed beat, and clamped so a
 * one-line reply does not get a five-second performance and a long one does not
 * mumble on forever.
 */
function finnaSpeak(messageEl, text) {
  var f = mountFinnaOn(messageEl, 'speaking');
  if (!f) return;
  var words = String(text || '').split(/\s+/).filter(Boolean).length;
  var ms = Math.max(900, Math.min(4200, words * 90));
  window.setTimeout(function () {
    // Only settle if she is still the one on screen and still talking.
    if (Finna.state === 'speaking') Finna.setState('happy');
    window.setTimeout(function () {
      if (Finna.state === 'happy') Finna.setState('idle');
    }, 1200);
  }, ms);
}

function renderChatMessage(role, content) {
  var isUser = role === 'user';
  var body = isUser ? escapeHtml(content).replace(/\n/g, '<br>') : mdLiteToHtml(content);
  /* An assistant row carries an empty SLOT rather than a static icon, so the
     one live Finna can move into it. The user's own row keeps its icon. */
  var avatar = isUser
    ? '<div class="chat-msg-avatar">' + icon('user') + '</div>'
    : '<div class="chat-msg-avatar finna-slot"></div>';
  return '<div class="chat-msg ' + (isUser ? 'user' : 'ai') + '">' +
    avatar +
    '<div class="chat-msg-bubble">' + body + '</div>' +
  '</div>';
}

function sendChatFromChip(btn) {
  var question = btn.getAttribute('data-question');
  if (question) {
    var input = document.getElementById('chat-input');
    if (input) input.value = question;
    sendChat();
  }
}

/**
 * THE FINANCIAL COPILOT.
 *
 * Distinct from a chat bubble in the way that matters: an answer is not one
 * block of text. It is a structured response separating what the engine
 * DETECTED from what the model INTERPRETED and what it RECOMMENDS — and the UI
 * shows that distinction, because presenting all three in the same voice is how
 * an interpretation gets mistaken for a finding.
 */
async function sendChat() {
  var input = document.getElementById('chat-input');
  var feed = document.getElementById('chat-feed');
  if (!input || !feed) return;

  var message = input.value.trim();
  if (!message) return;

  var emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  appState.chatHistory.push({ role: 'user', content: message });
  feed.insertAdjacentHTML('beforeend', renderChatMessage('user', message));
  input.value = '';
  feed.scrollTop = feed.scrollHeight;

  /* FINNA THINKS WHILE THE REQUEST IS IN FLIGHT. The state is driven by what
     the fetch is actually doing, never by a timer — she must not look like she
     is answering before an answer exists. */
  var typingId = 'typing-' + Date.now();
  feed.insertAdjacentHTML('beforeend',
    '<div id="' + typingId + '" class="chat-msg ai">'
    + '<div class="chat-msg-avatar finna-slot"></div>'
    + '<div class="chat-msg-bubble" style="animation:pulse 1s infinite">'
    + 'Checking your analysis&hellip;</div></div>');
  mountFinnaOn(document.getElementById(typingId), 'thinking');
  feed.scrollTop = feed.scrollHeight;

  try {
    var res = await fetch('/api/copilot', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify({
        message: message,
        month: appState.activeMonth || null,
        /* The conversation id lets a follow-up resolve "this" and "that"
           server-side, where the entity references actually live. */
        conversation_id: appState.copilotConversationId || null,
        finding_id: appState.copilotFindingId || null,
        ai_assistant: appState.aiAssistant
      })
    });
    var data = await res.json();

    var typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (data.conversation_id) appState.copilotConversationId = data.conversation_id;
    /* A finding selection applies to one question, not the whole conversation. */
    appState.copilotFindingId = null;

    if (data.ok && data.answer) {
      appState.chatHistory.push({ role: 'ai', content: data.answer.summary || '' });
      feed.insertAdjacentHTML('beforeend', renderCopilotAnswer(data));
      /* She talks while the answer is being read, then settles. The duration is
         scaled to how much there is to read rather than a fixed beat. */
      finnaSpeak(feed.lastElementChild, data.answer.summary || '');
    } else {
      feed.insertAdjacentHTML('beforeend', renderCopilotUnavailable(data));
      /* NOT EVERY "no answer" IS A FAULT. Declining because no analysis exists
         for the period, or because the run is legacy, is the copilot working
         correctly — renderCopilotUnavailable() exists precisely to stop those
         being presented as breakage. An alarmed face would put the alarm back.
         She simply stops talking. A genuine transport failure is handled in the
         catch below, and that one does get the error face. */
      mountFinnaOn(feed.lastElementChild, 'idle');
    }
    feed.scrollTop = feed.scrollHeight;
  } catch (e) {
    var el = document.getElementById(typingId);
    if (el) el.remove();
    feed.insertAdjacentHTML('beforeend', renderChatMessage('ai',
      'I could not reach the copilot service. Your analysis is unaffected.'));
    mountFinnaOn(feed.lastElementChild, 'error');
    feed.scrollTop = feed.scrollHeight;
  }
}

/**
 * Render a structured copilot answer.
 *
 * THE VISUAL CONTRACT: a detected fact, an interpretation and a recommendation
 * must never look alike. Facts carry a citation the user can open; inferences
 * are explicitly labelled as interpretation; recommendations are advice.
 */
function renderCopilotAnswer(data) {
  var a = data.answer || {};
  var html = '<div class="chat-msg ai"><div class="chat-msg-avatar finna-slot"></div>'
    + '<div class="chat-msg-bubble copilot-answer">';

  if (a.summary) {
    html += '<div class="copilot-summary">' + escapeHtml(a.summary) + '</div>';
  }

  if (a.facts && a.facts.length) {
    html += '<div class="copilot-section copilot-facts">'
      + '<div class="copilot-label copilot-label-fact">Detected in your data</div><ul>';
    a.facts.forEach(function (f) {
      html += '<li>' + escapeHtml(f.claim);
      /* Evidence navigation: a fact citing a finding is inspectable. */
      (f.citations || []).forEach(function (c) {
        var m = String(c).match(/^finding:(fnd_[0-9a-f]+)$/);
        if (m) {
          html += ' <button class="copilot-cite" onclick="showCopilotEvidence(\'' + m[1]
            + '\')">view evidence</button>';
        }
      });
      html += '</li>';
    });
    html += '</ul></div>';
  }

  if (a.inferences && a.inferences.length) {
    html += '<div class="copilot-section copilot-inferences">'
      + '<div class="copilot-label copilot-label-inference">Interpretation &mdash; not a detected finding</div><ul>';
    a.inferences.forEach(function (i) { html += '<li>' + escapeHtml(i.claim) + '</li>'; });
    html += '</ul></div>';
  }

  if (a.recommendations && a.recommendations.length) {
    html += '<div class="copilot-section copilot-recommendations">'
      + '<div class="copilot-label copilot-label-recommendation">Suggested next steps</div><ul>';
    a.recommendations.forEach(function (r) { html += '<li>' + escapeHtml(r.claim) + '</li>'; });
    html += '</ul></div>';
  }

  if (a.limitations && a.limitations.length) {
    html += '<div class="copilot-section copilot-limitations">'
      + '<div class="copilot-label">What I could not determine</div><ul>';
    a.limitations.forEach(function (l) { html += '<li>' + escapeHtml(l) + '</li>'; });
    html += '</ul></div>';
  }

  /* Provenance, so an answer is auditable from the UI. */
  if (data.meta) {
    html += '<div class="copilot-provenance">Grounded in analysis '
      + escapeHtml(String(data.meta.analysisRunId || '').slice(0, 12))
      + ' for ' + escapeHtml(data.meta.period || '')
      + (data.meta.claimsRejected
        ? ' &middot; ' + data.meta.claimsRejected + ' unsupported statement(s) removed' : '')
      + '</div>';
  }

  html += '</div></div>';
  return html;
}

/** An honest unavailable/blocked response. */
function renderCopilotUnavailable(data) {
  var blocked = data.blocked;

  /* A LEGACY RUN IS NOT A MISSING ONE.
     An analysis saved before the application stored everything needed to reload
     it cannot be rebuilt -- but it EXISTS, and the user has one clear action.
     Labelling it "Not available" alongside every other failure told them their
     analysis was gone, which is both wrong and alarming. It gets its own label
     and its own action. */
  if (data.reason === 'analysis_legacy_unrecoverable') {
    var period = data.period ? String(data.period) : '';
    return '<div class="chat-msg ai"><div class="chat-msg-avatar finna-slot"></div>'
      + '<div class="chat-msg-bubble copilot-unavailable">'
      + '<div class="copilot-label copilot-label-unavailable">Saved, but needs re-running</div>'
      + '<div>' + escapeHtml(resolveUserError(data,
        'This analysis was saved before the app stored everything needed to reload it.'))
      + '</div>'
      + (period
        ? '<div style="margin-top:0.6rem"><button class="btn btn-sm btn-primary" '
          + 'onclick="runMonthlyReview(\'' + escapeHtml(period) + '\')">'
          + 'Re-run ' + escapeHtml(period) + '</button></div>'
        : '')
      + '<div class="text-sm text-muted" style="margin-top:0.5rem">Your saved records '
      + 'are unaffected &mdash; only the analysis needs recomputing.</div>'
      + '</div></div>';
  }

  return '<div class="chat-msg ai"><div class="chat-msg-avatar finna-slot"></div>'
    + '<div class="chat-msg-bubble copilot-unavailable">'
    + '<div class="copilot-label copilot-label-unavailable">'
    + (blocked ? 'Answer withheld' : 'Not available') + '</div>'
    + '<div>' + escapeHtml(resolveUserError(data, 'I could not answer that.')) + '</div>'
    + (blocked
      ? '<div class="text-sm text-muted" style="margin-top:0.5rem">Your analysis is '
        + 'unaffected &mdash; the findings and scores on your dashboard are computed by '
        + 'the rules engine.</div>'
      : '')
    + '</div></div>';
}

/** Open the authoritative evidence behind a finding the answer cited. */
async function showCopilotEvidence(findingId) {
  try {
    var res = await fetch('/api/copilot/evidence/' + encodeURIComponent(findingId));
    var data = await res.json();
    if (!data.ok) { showToast('That evidence is no longer available.', 'warning'); return; }

    var e = data.evidence;
    var rows = (e.evidence || []).map(function (row) {
      var f = row.fields || {};
      return '<tr><td>' + escapeHtml(f.date || '—') + '</td>'
        + '<td>' + escapeHtml(f.counterparty || '—') + '</td>'
        + '<td>' + escapeHtml(f.description || '—') + '</td>'
        + '<td class="text-right">' + formatCurrency(f.amount) + '</td>'
        + '<td class="text-sm text-muted">' + escapeHtml(row.source_record_id || '—') + '</td></tr>';
    }).join('');

    openModal('Evidence',
      '<p class="text-sm text-muted">' + escapeHtml(e.calculation || '') + '</p>'
      + (e.match_criteria
        ? '<p class="text-sm">Matched on: <strong>'
          + escapeHtml((e.match_criteria.fields || []).join(', ')) + '</strong></p>' : '')
      + '<table class="data-table"><thead><tr><th>Date</th><th>Counterparty</th>'
      + '<th>Description</th><th class="text-right">Amount</th><th>Record</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>');
  } catch (err) {
    showToast('Could not load the evidence.', 'error');
  }
}

/** Ask the copilot about a specific finding, from anywhere in the app. */
function askCopilotAbout(findingId, question) {
  appState.copilotFindingId = findingId;
  navigate('chat');
  setTimeout(function () {
    var input = document.getElementById('chat-input');
    if (input) { input.value = question || 'Explain this finding'; sendChat(); }
  }, 150);
}


/* ── Settings ────────────────────────────────────────────────── */
/* Plain-language guide for each contract: who the two organisations are and
   what owner actions are available after deployment. */
var CONTRACT_GUIDES = {
  'treasury-guard-v1': {
    yourRole: 'Your organisation owns the treasury and is the only one who can withdraw funds.',
    theirRole: 'The counterparty organisation can pay funds into the treasury at any time. Every deposit and withdrawal is recorded permanently on-chain.',
    counterpartyNote: 'The counterparty pays in by sending test AVAX to the contract address above from their own wallet.',
    showStatus: true,
    statusReader: async function(c) {
      var bal = await c.balance();
      var dep = await c.totalDeposited();
      var wd = await c.totalWithdrawn();
      return {
        label: 'In treasury now: ' + ethers.formatEther(bal) + ' AVAX',
        cls: bal > 0n ? 'text-emerald' : 'text-brand-bright',
        lines: ['Total deposited: ' + ethers.formatEther(dep) + ' AVAX · Total withdrawn: ' + ethers.formatEther(wd) + ' AVAX'],
        balance: bal
      };
    },
    terminalCommands: function(addr, rpc) {
      return [
        { label: 'Send 0.1 test AVAX into the treasury (plain send — TreasuryGuard has receive())', cmd: 'cast send ' + addr + ' --value 0.1ether --rpc-url ' + rpc + ' --private-key <TOPSYY_KEY>' }
      ];
    },
    actions: [
      { id: 'deposit', kind: 'deposit', label: 'Send a deposit (from my wallet)', desc: 'Pay test AVAX into the treasury. Normally the counterparty does this from their wallet — this button lets you demo it.',
        fields: [ { name: 'amount', label: 'Amount (AVAX)', type: 'etherText' } ] },
      { id: 'withdraw', kind: 'call', method: 'withdraw', label: 'Withdraw funds', desc: 'Send AVAX out of the treasury (owner only).',
        fields: [ { name: 'to', label: 'Send to address', type: 'address', fill: 'counterparty' }, { name: 'amount', label: 'Amount (AVAX)', type: 'ether' } ] },
      { id: 'transfer', kind: 'call', method: 'transferOwnership', label: 'Transfer ownership to counterparty', desc: 'Hand control of the treasury to the other organisation.',
        fields: [ { name: 'newOwner', label: 'New owner address', type: 'address', fill: 'counterparty' } ] }
    ]
  },
  'invoice-vault-v1': {
    yourRole: 'Your organisation records invoices and marks them paid. Records are tamper-proof once written.',
    theirRole: 'The counterparty organisation is the other party to these invoices and can verify every record on the block explorer.',
    counterpartyNote: 'Share the contract address so the counterparty can read and verify invoices on the explorer.',
    actions: [
      { id: 'record', kind: 'call', method: 'recordInvoice', label: 'Record an invoice', desc: 'Write a tamper-proof invoice record on-chain.',
        fields: [ { name: 'ref', label: 'Invoice reference (text)', type: 'bytes32text' }, { name: 'amount', label: 'Amount', type: 'uint' } ] },
      { id: 'transfer', kind: 'call', method: 'transferOwnership', label: 'Transfer ownership to counterparty', desc: 'Hand control of the registry to the other organisation.',
        fields: [ { name: 'newOwner', label: 'New owner address', type: 'address', fill: 'counterparty' } ] }
    ]
  },
  'finguard-escrow-v1': {
    yourRole: 'Your organisation is the payee. You receive the funds when the counterparty releases them, or you can claim them yourself once the deadline passes.',
    theirRole: 'The counterparty organisation is the payer. From their terminal wallet they deposit funds and then release them to you — or refund themselves before the deadline.',
    counterpartyNote: 'The counterparty acts from their Avalanche terminal wallet. Share the contract address and the commands below with them.',
    showStatus: true,
    statusReader: async function(c) {
      var released = await c.released();
      var refunded = await c.refunded();
      var dep = await c.totalDeposited();
      var bal = await c.balance();
      var label = released ? 'Released — paid to your organisation'
        : refunded ? 'Refunded — returned to the payer'
        : (bal > 0n ? 'Funded — awaiting release' : 'Deployed — awaiting deposit');
      return {
        label: label,
        cls: released ? 'text-emerald' : refunded ? 'text-amber' : 'text-brand-bright',
        lines: ['Total deposited: ' + ethers.formatEther(dep) + ' AVAX · In escrow now: ' + ethers.formatEther(bal) + ' AVAX'],
        balance: bal
      };
    },
    actions: [
      { id: 'claim', kind: 'call', method: 'claimAfterDeadline', label: 'Claim funds (after deadline)', desc: 'If the counterparty never released and the deadline has passed, sweep the escrowed funds to your organisation.', fields: [] }
    ],
    terminalCommands: function(addr, rpc) {
      return [
        { label: '1. Deposit 0.1 test AVAX into the escrow', cmd: 'cast send ' + addr + ' "deposit()" --value 0.1ether --rpc-url ' + rpc + ' --private-key <TOPSYY_KEY>' },
        { label: '2. Release the funds to your organisation', cmd: 'cast send ' + addr + ' "release()" --rpc-url ' + rpc + ' --private-key <TOPSYY_KEY>' },
        { label: 'Or — refund yourself before the deadline', cmd: 'cast send ' + addr + ' "refund()" --rpc-url ' + rpc + ' --private-key <TOPSYY_KEY>' }
      ];
    }
  }
};

function rpcFor(net) { return (net && net.rpcUrl) ? net.rpcUrl : 'https://api.avax-test.network/ext/bc/C/rpc'; }

/* Save an on-chain money movement to the server ledger (for the monthly analysis). */
function recordOnchainMovement(mv) {
  return fetch('/api/avalanche/onchain/record', {
    method: 'POST',
    headers: mutatingHeaders(),
    body: JSON.stringify(mv)
  }).then(function(r) { return r.json(); }).catch(function() { return null; });
}

/* Total Balance card + wallet "My Card" (Fundex-style) */
function renderBalancesSection() {
  var h = '<div class="balances-row">';
  h += '<div class="tb-card">';
  h += '<div class="tb-head"><span class="tb-title">Total balance</span><span class="tb-chip"><span class="dot"></span>AVAX · Fuji</span></div>';
  h += '<div class="tb-avail">' + icon('wallet') + ' Combined across wallet + contracts</div>';
  h += '<div class="tb-big" id="bal-total">—</div>';
  h += '<div class="tb-breakdown">';
  h += '<div class="tb-brow"><span>' + icon('wallet') + ' Wallet</span><span id="bal-wallet">—</span></div>';
  h += '<div class="tb-brow"><span>' + icon('shield') + ' Treasury</span><span id="bal-treasury">—</span></div>';
  h += '<div class="tb-brow"><span>' + icon('briefcase') + ' Escrow</span><span id="bal-escrow">—</span></div>';
  h += '</div>';
  h += '<div class="tb-actions"><button class="tb-btn" onclick="loadBalances()">Refresh</button>' +
    '<button class="tb-btn" onclick="window.open(\'https://faucet.avax.network/\',\'_blank\')">Get test AVAX</button></div>';
  h += '</div>';

  h += '<div class="glass-card"><div class="card-head"><div class="chart-title">My card</div></div>';
  h += '<div class="wallet-card">';
  h += '<div class="wallet-card-top"><div class="wallet-card-chip"></div><div class="wallet-card-brand">FinGuard</div></div>';
  h += '<div class="wallet-card-number" id="wcard-number">Not connected</div>';
  h += '<div class="wallet-card-foot">' +
    '<div><div class="wallet-card-label">Network</div><div class="wallet-card-val" id="wcard-network">—</div></div>' +
    '<div style="text-align:right"><div class="wallet-card-label">Balance</div><div class="wallet-card-val" id="wcard-balance">—</div></div></div>';
  h += '</div></div>';

  h += '</div>';
  return h;
}

/* Find the most recently deployed treasury + escrow addresses from history. */
async function latestContractAddresses() {
  var res = { treasury: null, escrow: null };
  try {
    var r = await fetch('/api/avalanche/contracts/deployments');
    var d = await r.json();
    var items = d.items || d.deployments || [];
    var valid = function(a) { return a && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== '0x1234567890123456789012345678901234567890'; };
    items.forEach(function(it) {
      if (!it.ok || !valid(it.address)) return;
      if (it.contract_name === 'TreasuryGuard') res.treasury = it.address; // later entries overwrite → latest wins
      if (it.contract_name === 'FinGuardEscrow') res.escrow = it.address;
    });
  } catch (e) {}
  return res;
}

/* Read wallet + treasury + escrow balances live from chain and fill the cards. */
async function loadBalances() {
  var w = FinGuardWallet.getState();
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  var fmt = function(wei) { try { return Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' AVAX'; } catch (e) { return '0 AVAX'; } };
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  try {
    var provider = FinGuardWallet.getReadProvider(rpcFor(net));
    var walletBal = 0n;
    if (w.address) { try { walletBal = await provider.getBalance(w.address); } catch (e) {} }
    var addrs = await latestContractAddresses();
    var treBal = 0n, escBal = 0n;
    if (addrs.treasury) { try { treBal = await provider.getBalance(addrs.treasury); } catch (e) {} }
    if (addrs.escrow) { try { escBal = await provider.getBalance(addrs.escrow); } catch (e) {} }

    set('bal-total', fmt(walletBal + treBal + escBal));
    set('bal-wallet', w.address ? fmt(walletBal) : 'Not connected');
    set('bal-treasury', addrs.treasury ? fmt(treBal) : 'None deployed');
    set('bal-escrow', addrs.escrow ? fmt(escBal) : 'None deployed');

    set('wcard-number', w.address ? (w.address.slice(0, 6) + ' •••• •••• ' + w.address.slice(-4)) : 'Not connected');
    set('wcard-network', net ? net.name : (w.address ? 'Unknown network' : '—'));
    set('wcard-balance', w.address ? fmt(walletBal) : '—');
  } catch (e) {
    set('bal-total', '—');
  }
}

/* Read live contract state from chain (works even for deposits/releases done in the terminal).
   Each contract's guide provides a statusReader(contract) -> { label, cls, lines[], balance }. */
async function refreshContractStatus(templateId, contractAddress, opts) {
  opts = opts || {};
  var el = document.getElementById('contract-status-body');
  var guide = CONTRACT_GUIDES[templateId];
  var template = (appState.contractTemplates || []).find(function(t) { return t.id === templateId; });
  if (!guide || !guide.statusReader || !template) return;
  if (el && !opts.quiet) el.innerHTML = '<span class="text-muted text-sm">Checking on-chain…</span>';
  var w = FinGuardWallet.getState();
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  try {
    var provider = FinGuardWallet.getReadProvider(rpcFor(net));
    var c = new ethers.Contract(contractAddress, template.abi, provider);
    var s = await guide.statusReader(c);

    /* Notify when the balance has grown since the last check (a deposit arrived). */
    appState.lastKnownBalance = appState.lastKnownBalance || {};
    var prev = appState.lastKnownBalance[contractAddress];
    if (prev != null && s.balance != null && s.balance > prev) {
      showToast('💰 ' + ethers.formatEther(s.balance - prev) + ' AVAX received — ' + shortAddr(contractAddress), 'success');
    }
    if (s.balance != null) appState.lastKnownBalance[contractAddress] = s.balance;

    if (el) {
      el.innerHTML = '<div class="text-sm"><strong class="' + s.cls + '">' + escapeHtml(s.label) + '</strong></div>' +
        (s.lines || []).map(function(l) { return '<div class="text-sm text-muted" style="margin-top:0.3rem;">' + escapeHtml(l) + '</div>'; }).join('');
    }
  } catch (e) {
    if (el && !opts.quiet) el.innerHTML = '<span class="text-red text-sm">Could not read status: ' + escapeHtml((e && (e.shortMessage || e.message)) || 'error') + '</span>';
  }
}

/* Poll the live status every 15s so terminal-side deposits show up (and notify) without a manual refresh. */
function startStatusPolling(templateId, contractAddress) {
  stopStatusPolling();
  appState.statusPollId = setInterval(function() {
    refreshContractStatus(templateId, contractAddress, { quiet: true });
  }, 15000);
}

function stopStatusPolling() {
  if (appState.statusPollId) { clearInterval(appState.statusPollId); appState.statusPollId = null; }
}

/* Verify any transaction hash succeeded on-chain (incl. terminal-submitted txs). */
async function checkTxStatus() {
  var input = document.getElementById('tx-verify-input');
  var out = document.getElementById('tx-verify-result');
  if (!input || !out) return;
  var hash = input.value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    out.innerHTML = '<span class="text-red text-sm">Enter a valid 0x transaction hash (66 characters).</span>';
    return;
  }
  out.innerHTML = '<span class="text-muted text-sm">Looking up…</span>';
  var w = FinGuardWallet.getState();
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  try {
    var provider = FinGuardWallet.getReadProvider(rpcFor(net));
    var receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      out.innerHTML = '<span class="text-amber text-sm">Not found yet — it may still be pending, or the hash is wrong.</span>';
      return;
    }
    var link = net ? ' <a href="' + net.explorerUrl + '/tx/' + hash + '" target="_blank" rel="noopener" class="text-brand">View on explorer</a>' : '';
    out.innerHTML = (receipt.status === 1)
      ? '<span class="text-emerald text-sm">' + icon('check-circle') + ' Success — confirmed in block ' + receipt.blockNumber + '.' + link + '</span>'
      : '<span class="text-red text-sm">Transaction failed (reverted) in block ' + receipt.blockNumber + '.' + link + '</span>';
  } catch (e) {
    out.innerHTML = '<span class="text-red text-sm">Lookup error: ' + escapeHtml((e && (e.shortMessage || e.message)) || 'error') + '</span>';
  }
}

function getCounterparty() { return appState.counterpartyAddress || ''; }

function setCounterpartyFromInput() {
  var el = document.getElementById('contract-counterparty');
  if (!el) return;
  var v = el.value.trim();
  appState.counterpartyAddress = v;
  try { localStorage.setItem('finguard_counterparty', v); } catch (e) {}
  var hint = document.getElementById('counterparty-hint');
  if (hint) {
    if (v && !ethers.isAddress(v)) hint.innerHTML = '<span class="text-red">Not a valid 0x wallet address</span>';
    else if (v) hint.innerHTML = '<span class="text-emerald">Saved</span>';
    else hint.innerHTML = '';
  }
}

function setEscrowDeadlineFromInput() {
  var el = document.getElementById('escrow-deadline-hours');
  if (!el) return;
  var h = Number(el.value);
  if (h > 0) appState.escrowDeadlineSeconds = Math.round(h * 3600);
}

function shortAddr(a) { return a ? (a.slice(0, 6) + '…' + a.slice(-4)) : ''; }

function copyToClipboard(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function() { showToast('Copied to clipboard', 'info'); });
}

function copyCodeFromButton(btn) {
  var row = btn.parentElement;
  var code = row ? row.querySelector('code') : null;
  if (code) copyToClipboard(code.textContent);
}

function convertContractField(type, raw) {
  raw = (raw == null ? '' : String(raw)).trim();
  if (type === 'address') {
    if (!ethers.isAddress(raw)) throw new Error('Enter a valid 0x wallet address.');
    return raw;
  }
  if (type === 'ether' || type === 'etherText') return ethers.parseEther(raw || '0');
  if (type === 'uint') { if (!/^\d+$/.test(raw)) throw new Error('Enter a whole number.'); return BigInt(raw); }
  if (type === 'bytes32text') { if (!raw) throw new Error('Enter an invoice reference.'); return ethers.id(raw); }
  return raw;
}

function deployTxLink(net, hash) {
  return net ? '<a href="' + net.explorerUrl + '/tx/' + hash + '" target="_blank" rel="noopener">View transaction</a>' : '';
}

/* Build constructor arguments for a template from its schema + the Contract Parties inputs. */
function buildConstructorArgs(template) {
  var schema = template.constructor_args_schema || template.constructorArgsSchema || [];
  var cp = getCounterparty();
  return schema.map(function(entry) {
    if (entry.source === 'counterparty') {
      if (!cp) throw new Error('Enter the counterparty wallet address in "Contract Parties" first.');
      if (!ethers.isAddress(cp)) throw new Error('The counterparty address is not a valid 0x address.');
      return cp;
    }
    if (entry.source === 'deadlineSeconds') {
      var secs = Number(appState.escrowDeadlineSeconds);
      if (!secs || isNaN(secs)) secs = entry.default || 86400;
      return BigInt(secs);
    }
    if (entry.type === 'uint') return BigInt(entry.default || 0);
    if (entry.type === 'address') return entry.default || ethers.ZeroAddress;
    return entry.default;
  });
}

function renderDeployedGuidePanel(templateId, contractAddress) {
  var guide = CONTRACT_GUIDES[templateId] || { yourRole: '', theirRole: '', actions: [], counterpartyNote: '' };
  var w = FinGuardWallet.getState();
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  var cp = getCounterparty();

  var html = '<div class="deploy-status deploy-status-success">';
  html += '<div class="text-emerald" style="display:flex;align-items:center;gap:0.4rem;font-weight:600;">' + icon('check-circle') + ' Deployed on-chain!</div>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.6rem;flex-wrap:wrap;">';
  html += '<span class="wallet-address-chip">' + contractAddress + '</span>';
  html += '<button type="button" class="btn-small" onclick="copyToClipboard(\'' + contractAddress + '\')">Copy address</button>';
  if (net) html += '<a href="' + net.explorerUrl + '/address/' + contractAddress + '" target="_blank" rel="noopener" class="text-sm text-brand">Explorer →</a>';
  html += '</div>';

  html += '<div class="guide-roles">';
  html += '<div class="guide-role"><div class="guide-role-tag">Your organisation ' + (w.address ? '(' + shortAddr(w.address) + ')' : '') + '</div><p class="text-sm text-muted">' + escapeHtml(guide.yourRole) + '</p></div>';
  html += '<div class="guide-role"><div class="guide-role-tag">Counterparty ' + (cp ? '(' + shortAddr(cp) + ')' : '') + '</div><p class="text-sm text-muted">' + escapeHtml(guide.theirRole) + '</p></div>';
  html += '</div>';
  if (guide.counterpartyNote) html += '<p class="text-xs text-muted" style="margin-top:0.6rem;">' + escapeHtml(guide.counterpartyNote) + '</p>';

  if (guide.actions && guide.actions.length) {
    html += '<div class="guide-actions">';
    guide.actions.forEach(function(a) {
      html += '<div class="guide-action"><div class="guide-action-head">' + escapeHtml(a.label) + '</div>';
      if (a.desc) html += '<p class="text-xs text-muted" style="margin-bottom:0.5rem;">' + escapeHtml(a.desc) + '</p>';
      html += '<div class="guide-action-fields">';
      (a.fields || []).forEach(function(f) {
        var val = (f.fill === 'counterparty' && cp) ? cp : '';
        html += '<input class="settings-input" id="act-' + templateId + '-' + a.id + '-' + f.name + '" placeholder="' + escapeHtml(f.label) + '" value="' + escapeHtml(val) + '" />';
      });
      html += '<button type="button" class="btn-primary btn-small" onclick="runOwnerAction(\'' + templateId + '\',\'' + a.id + '\',\'' + contractAddress + '\')">Run</button>';
      html += '</div><div id="act-result-' + templateId + '-' + a.id + '" style="margin-top:0.5rem;"></div></div>';
    });
    html += '</div>';
  }

  if (guide.showStatus) {
    html += '<div class="guide-terminal"><div class="guide-action-head">Live on-chain status</div>' +
      '<div id="contract-status-body" class="text-sm text-muted">Checking…</div>' +
      '<button type="button" class="btn-small" style="margin-top:0.5rem;" onclick="refreshContractStatus(\'' + templateId + '\',\'' + contractAddress + '\')">Refresh now</button>' +
      '<span class="text-xs text-muted" style="margin-left:0.5rem;">Auto-updates every 15s.</span></div>';
  }

  if (typeof guide.terminalCommands === 'function') {
    var rpc = (net && net.rpcUrl) ? net.rpcUrl : 'https://api.avax-test.network/ext/bc/C/rpc';
    var cmds = guide.terminalCommands(contractAddress, rpc);
    html += '<div class="guide-terminal"><div class="guide-action-head">Counterparty terminal commands' + (cp ? ' (run as ' + shortAddr(cp) + ')' : '') + '</div>';
    html += '<p class="text-xs text-muted" style="margin-bottom:0.6rem;">Get the key with <span class="mono">avalanche key export Topsyy</span>, then run these from your terminal:</p>';
    cmds.forEach(function(c) {
      html += '<div class="guide-cmd"><div class="text-xs text-muted" style="margin-bottom:0.2rem;">' + escapeHtml(c.label) + '</div>' +
        '<div class="guide-cmd-row"><code>' + escapeHtml(c.cmd) + '</code>' +
        '<button type="button" class="btn-small" onclick="copyCodeFromButton(this)">Copy</button></div></div>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

async function runOwnerAction(templateId, actionId, contractAddress) {
  var guide = CONTRACT_GUIDES[templateId];
  var template = (appState.contractTemplates || []).find(function(t) { return t.id === templateId; });
  if (!guide || !template) return;
  var action = guide.actions.filter(function(a) { return a.id === actionId; })[0];
  if (!action) return;

  var resultEl = document.getElementById('act-result-' + templateId + '-' + actionId);
  var w = FinGuardWallet.getState();
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  var pending = function(msg) { if (resultEl) resultEl.innerHTML = '<div class="deploy-status"><p class="text-sm text-muted">' + msg + '</p></div>'; };
  var succeed = function(msg, hash) {
    if (resultEl) resultEl.innerHTML = '<div class="deploy-status deploy-status-success"><p class="text-sm text-emerald">' + icon('check-circle') + ' ' + escapeHtml(msg) + '</p>' + (net ? '<p class="text-xs" style="margin-top:0.3rem;">' + deployTxLink(net, hash) + '</p>' : '') + '</div>';
  };

  try {
    var handle;
    var raws = {};
    var depositAmount = '0';
    var claimAmount = '0';

    if (action.kind === 'deposit') {
      var amtEl = document.getElementById('act-' + templateId + '-' + actionId + '-amount');
      depositAmount = (amtEl && amtEl.value) || '0';
      pending('Approve the deposit in your wallet…');
      handle = await FinGuardWallet.sendNative(contractAddress, depositAmount);
    } else {
      var args = [];
      action.fields.forEach(function(f) {
        var raw = (document.getElementById('act-' + templateId + '-' + actionId + '-' + f.name) || {}).value;
        raws[f.name] = raw;
        args.push(convertContractField(f.type, raw));
      });
      // For a claim, the amount moved is whatever is sitting in the contract right now.
      if (action.method === 'claimAfterDeadline') {
        try {
          var prov = FinGuardWallet.getReadProvider(rpcFor(net));
          claimAmount = ethers.formatEther(await prov.getBalance(contractAddress));
        } catch (e) {}
      }
      pending('Approve the transaction in your wallet…');
      handle = await FinGuardWallet.callContract(contractAddress, template.abi, action.method, args);
    }
    pending('Confirming on-chain… ' + deployTxLink(net, handle.txHash));
    await handle.wait();
    succeed(action.label + ' complete.', handle.txHash);
    showToast(action.label + ' complete.', 'success');

    /* Save the money movement to the ledger so it flows into the monthly analysis. */
    var mv = null;
    if (action.kind === 'deposit') mv = { kind: 'deposit', from: w.address, to: contractAddress, amount: depositAmount };
    else if (action.method === 'withdraw') mv = { kind: 'withdraw', from: contractAddress, to: raws.to || '', amount: raws.amount || '0' };
    else if (action.method === 'claimAfterDeadline') mv = { kind: 'claim', from: contractAddress, to: w.address, amount: claimAmount };
    if (mv) {
      mv.contractName = template.contract_name;
      mv.contractAddress = contractAddress;
      mv.txHash = handle.txHash;
      mv.chainId = w.chainId;
      mv.wallet = w.address;
      mv.month = appState.activeMonth || null;
      recordOnchainMovement(mv);
    }

    loadContractDeploymentHistory();
    loadBalances();
  } catch (e) {
    var msg = (e && (e.reason || e.shortMessage || e.message)) || 'Action failed.';
    if (resultEl) resultEl.innerHTML = '<div class="deploy-status deploy-status-error"><p class="text-sm text-red">' + escapeHtml(msg) + '</p></div>';
    showToast('Action failed: ' + msg, 'error');
  }
}

function renderContracts() {
  if (appState.counterpartyAddress == null) {
    try { appState.counterpartyAddress = localStorage.getItem('finguard_counterparty') || ''; } catch (e) { appState.counterpartyAddress = ''; }
  }
  var html = '';

  html += '<div id="contracts-wallet-panel" class="section-gap"></div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Network &amp; Balance</div>';
  html += '<div id="contracts-network-panel"></div>';
  html += '</div>';

  html += renderBalancesSection();

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Contract Parties</div>';
  html += '<div class="guide-roles">';
  html += '<div class="guide-role"><div class="guide-role-tag">Your organisation</div>' +
    '<p class="text-sm text-muted">Your connected browser wallet. It deploys and owns the contract, and pays the network fee.</p>' +
    '<div id="parties-your-wallet" class="text-xs mono text-muted" style="margin-top:0.4rem;">Not connected — connect your wallet above.</div></div>';
  html += '<div class="guide-role"><div class="guide-role-tag">Counterparty organisation</div>' +
    '<p class="text-sm text-muted">The other organisation wallet address (for example, your terminal wallet). Used to pre-fill deposit, withdrawal and ownership actions.</p>' +
    '<input class="settings-input" id="contract-counterparty" placeholder="0x..." style="margin-top:0.4rem;max-width:100%;" oninput="setCounterpartyFromInput()" value="' + escapeHtml(getCounterparty()) + '" />' +
    '<div id="counterparty-hint" class="text-xs" style="margin-top:0.3rem;"></div>' +
    '<label class="settings-label" style="display:block;margin-top:0.7rem;">Escrow deadline (hours)</label>' +
    '<input class="settings-input" id="escrow-deadline-hours" type="number" min="1" placeholder="24" style="max-width:140px;" value="' + (appState.escrowDeadlineSeconds ? Math.round(appState.escrowDeadlineSeconds / 3600) : 24) + '" oninput="setEscrowDeadlineFromInput()" />' +
    '<div class="text-xs text-muted" style="margin-top:0.2rem;">Two-Party Escrow only: after this window, your org can claim unreleased funds.</div>' +
    '</div>';
  html += '</div></div>';

  html += '<div class="section-title">Deploy a Contract</div>';
  html += '<p class="text-sm text-muted" style="margin-bottom:1rem;">Pick what you want to set up. Your connected wallet signs the deployment and pays the network fee — nothing happens without your approval.</p>';
  html += '<div id="contract-template-gallery" class="section-gap"></div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="settings-inline-check"><label><input type="checkbox" id="contracts-advanced-toggle" /> Advanced: use a server-managed deployer instead (developer option)</label></div>';
  html += '<div id="contracts-advanced-panel" class="hidden" style="margin-top:1.25rem;">';
  html += '<div class="settings-helper text-sm text-muted">The server deploys using its own configured key instead of your wallet. Useful for automated/backend deployments.</div>';
  html += '<div class="settings-group"><label class="settings-label">Receiver Address</label><input type="text" class="settings-input" id="settings-contract-receiver" placeholder="0x..." /></div>';
  html += '<div class="settings-group"><label class="settings-label">Contract Template</label><select class="settings-input" id="settings-contract-template"></select></div>';
  html += '<div class="settings-group"><label class="settings-label">Deployment Name (optional)</label><input type="text" class="settings-input" id="settings-contract-name" placeholder="Leave blank to use template default" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Constructor Args (optional JSON Array)</label><input type="text" class="settings-input" id="settings-contract-args" placeholder="[]" /></div>';
  html += '<div class="settings-group settings-inline-check"><label><input type="checkbox" id="settings-contract-dryrun" checked /> Dry Run (recommended)</label></div>';
  html += '<div class="settings-group settings-inline-check"><label><input type="checkbox" id="settings-contract-advanced-abi" /> Manual ABI/bytecode</label></div>';
  html += '<div id="settings-contract-advanced-panel" class="hidden">';
  html += '<div class="settings-group"><label class="settings-label">ABI (JSON Array)</label><textarea class="settings-input settings-textarea" id="settings-contract-abi" placeholder="[{\"type\":\"constructor\",\"inputs\":[]}]"></textarea></div>';
  html += '<div class="settings-group"><label class="settings-label">Bytecode</label><textarea class="settings-input settings-textarea" id="settings-contract-bytecode" placeholder="0x..."></textarea></div>';
  html += '</div>';
  html += '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;">';
  html += '<button class="btn-primary" onclick="deployContractFromSettings()">Deploy Contract</button>';
  html += '</div>';
  html += '<div id="contract-deploy-result" class="contract-deploy-result"></div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Verify a Transaction</div>';
  html += '<p class="text-sm text-muted" style="margin-bottom:0.6rem;">Paste any transaction hash — including deposits or releases done from the terminal — to confirm it succeeded on-chain.</p>';
  html += '<div class="guide-action-fields"><input class="settings-input" id="tx-verify-input" placeholder="0x… transaction hash" style="flex:1;max-width:100%;" />' +
    '<button type="button" class="btn-primary btn-small" onclick="checkTxStatus()">Check</button></div>';
  html += '<div id="tx-verify-result" class="text-sm" style="margin-top:0.5rem;"></div>';
  html += '</div>';

  html += '<div class="glass-card">';
  html += '<div class="card-title">Recent Contract Deployments</div>';
  html += '<div id="contract-deploy-history" class="text-sm text-muted">Loading deployment history…</div>';
  html += '</div>';

  $pageContent.innerHTML = html;

  renderWalletConnectCard('contracts-wallet-panel', { compact: true, showDisconnect: true });
  renderNetworkPanel('contracts-network-panel');
  renderContractTemplateGallery();
  loadContractDeploymentHistory();
  setTimeout(loadContractTemplates, 0);

  var advToggle = document.getElementById('contracts-advanced-toggle');
  if (advToggle) {
    advToggle.addEventListener('change', function() {
      var panel = document.getElementById('contracts-advanced-panel');
      if (!panel) return;
      if (advToggle.checked) panel.classList.remove('hidden');
      else panel.classList.add('hidden');
    });
  }

  var advancedAbiToggle = document.getElementById('settings-contract-advanced-abi');
  if (advancedAbiToggle) {
    advancedAbiToggle.addEventListener('change', function() {
      var panel = document.getElementById('settings-contract-advanced-panel');
      if (!panel) return;
      if (advancedAbiToggle.checked) panel.classList.remove('hidden');
      else panel.classList.add('hidden');
    });
  }

  /* Show connected wallet as "your organisation" + validate counterparty */
  var w = FinGuardWallet.getState();
  var yourEl = document.getElementById('parties-your-wallet');
  if (yourEl && w.address) yourEl.textContent = w.address;
  setCounterpartyFromInput();
  setEscrowDeadlineFromInput();
  loadBalances();
}

async function renderContractTemplateGallery() {
  var el = document.getElementById('contract-template-gallery');
  if (!el) return;
  el.innerHTML = renderLoadingShimmer(2);

  try {
    var res = await fetch('/api/avalanche/contracts/templates');
    var data = await res.json();
    if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
      el.innerHTML = renderEmptyState('file-text', 'No Templates Available', 'No contract templates are configured on the server.');
      return;
    }

    appState.contractTemplates = data.items;

    var html = '<div class="grid-2col">';
    data.items.forEach(function(t) {
      html += '<div class="report-card">';
      html += '<div class="report-card-icon">' + icon(t.icon || 'file-text', { cls: 'icon-xl' }) + '</div>';
      html += '<div class="report-card-title">' + escapeHtml(t.label) + '</div>';
      html += '<div class="report-card-desc">' + escapeHtml(t.description) + '</div>';
      var g = CONTRACT_GUIDES[t.id];
      if (g) {
        html += '<div class="guide-mini">' +
          '<span class="guide-mini-row"><strong>Your org:</strong> ' + escapeHtml(g.yourRole) + '</span>' +
          '<span class="guide-mini-row"><strong>Counterparty:</strong> ' + escapeHtml(g.theirRole) + '</span></div>';
      }
      html += '<button class="btn-primary" onclick="handleDeployTemplateClick(\'' + t.id + '\')">' + icon('wallet') + ' Deploy with My Wallet</button>';
      html += '<div id="deploy-status-' + t.id + '"></div>';
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<p class="text-muted text-sm">Unable to load contract templates.</p>';
  }
}

async function handleDeployTemplateClick(templateId) {
  var w = FinGuardWallet.getState();
  if (!w.address) {
    showToast('Connect your wallet above first.', 'warning');
    return;
  }
  if (!w.verified) {
    showToast('Verify your wallet (sign in) above before deploying.', 'warning');
    return;
  }

  var cp = getCounterparty();
  if (cp && !ethers.isAddress(cp)) {
    showToast('The counterparty address is not a valid 0x address. Fix or clear it.', 'warning');
    return;
  }

  var template = (appState.contractTemplates || []).find(function(t) { return t.id === templateId; });
  if (!template) {
    showToast('Template not found.', 'error');
    return;
  }

  var ctorArgs;
  try {
    ctorArgs = buildConstructorArgs(template);
  } catch (e) {
    showToast(e.message, 'warning');
    return;
  }

  var statusEl = document.getElementById('deploy-status-' + templateId);
  var net = (appState.networks || []).find(function(n) { return n.chainId === w.chainId; });
  var networkLabel = net ? net.name : ('chain ' + w.chainId);

  if (statusEl) {
    statusEl.innerHTML = '<div class="deploy-status"><p class="text-sm text-muted">Deploying <strong>' +
      escapeHtml(template.label) + '</strong> to <strong>' + escapeHtml(networkLabel) +
      '</strong>. Approve the transaction in your wallet — it will show a small network fee (gas).</p></div>';
  }

  try {
    var deployment = await FinGuardWallet.deployTemplate(template, ctorArgs);

    if (statusEl) {
      statusEl.innerHTML = '<div class="deploy-status"><div class="loading-shimmer" style="height:44px"></div>' +
        '<p class="text-sm text-muted" style="margin-top:0.5rem;">Waiting for confirmation on-chain…' +
        (net ? ' <a href="' + net.explorerUrl + '/tx/' + deployment.txHash + '" target="_blank" rel="noopener">View transaction</a>' : '') +
        '</p></div>';
    }

    var result = await deployment.wait();

    if (statusEl) {
      statusEl.innerHTML = renderDeployedGuidePanel(templateId, result.address);
    }
    if (CONTRACT_GUIDES[templateId] && CONTRACT_GUIDES[templateId].showStatus) {
      appState.lastKnownBalance = appState.lastKnownBalance || {};
      delete appState.lastKnownBalance[result.address];
      refreshContractStatus(templateId, result.address);
      startStatusPolling(templateId, result.address);
    }
    loadBalances();

    showToast(template.label + ' deployed successfully!', 'success');

    fetch('/api/avalanche/contracts/deployments/record', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify({
        templateId: template.id,
        contractName: template.contract_name,
        contractAddress: result.address,
        txHash: deployment.txHash,
        chainId: w.chainId,
        deployerAddress: w.address,
        counterpartyAddress: getCounterparty()
      })
    }).then(function() { loadContractDeploymentHistory(); }).catch(function() {});

  } catch (e) {
    var message = (e && e.reason) || (e && e.shortMessage) || (e && e.message) || 'Deployment failed.';
    if (statusEl) {
      statusEl.innerHTML = '<div class="deploy-status deploy-status-error"><p class="text-sm text-red">' + escapeHtml(message) + '</p></div>';
    }
    showToast('Deployment failed: ' + message, 'error');
  }
}

/* ── Custom Financial Rules (Settings → Financial Rules) ─────── */
function loadRules() {
  var el = document.getElementById('rules-panel-body');
  if (!el) return;
  fetch('/api/rules').then(function(r) { return r.json(); }).then(function(d) {
    if (!d || !d.ok) { el.innerHTML = '<p class="text-sm text-red">Could not load rules.</p>'; return; }
    appState.rulesData = d;
    renderRulesPanel();
  }).catch(function() { if (el) el.innerHTML = '<p class="text-sm text-red">Could not load rules.</p>'; });
}

function ruleSummary(rule) {
  var c = rule.condition || {};
  switch (c.type) {
    case 'expense_over': return 'Transaction above ' + formatCurrency(c.amount);
    case 'cash_below': return 'Cash balance below ' + formatCurrency(c.amount);
    case 'vendor_payment_over': return 'Vendor payment above ' + formatCurrency(c.amount);
    case 'duplicate_payment': return 'Duplicate payment (reuses engine)';
    case 'weekend_transaction': return 'Weekend transaction';
    case 'director_expense': return 'Director / owner expense';
    case 'unknown_supplier': return 'Unknown / one-off supplier';
    case 'keyword': return 'Keyword: "' + (c.keyword || '') + '"';
    default: return c.type || 'Rule';
  }
}

function renderRulesPanel() {
  var el = document.getElementById('rules-panel-body');
  var d = appState.rulesData;
  if (!el || !d) return;

  // Free (read-only): examples + upgrade prompt.
  if (!d.can_manage) {
    var hf = '<p class="text-sm text-muted" style="margin-bottom:1rem;">Custom rules are available on <strong>Growth</strong> and <strong>Custom Guidance</strong>. Examples of what you could set up:</p><div class="rules-list">';
    d.examples.forEach(function(ex) {
      hf += '<div class="rule-row rule-example"><div class="rule-row-main">' +
        '<div class="rule-row-name">' + escapeHtml(ex.name) + ' <span class="' + severityClass(ex.severity) + '">' + escapeHtml(ex.severity) + '</span></div>' +
        '<div class="rule-row-sub">' + escapeHtml(ex.description) + ' · action: ' + escapeHtml(ex.action.replace(/_/g, ' ')) + '</div></div></div>';
    });
    hf += '</div><div class="rules-upgrade"><button type="button" class="btn-primary" onclick="setPlan(\'pro\')">Upgrade to create rules</button>' +
      '<button type="button" class="btn-secondary" onclick="switchSettingsSection(\'assistant\')">Add my own access key</button></div>';
    el.innerHTML = hf;
    return;
  }

  var typeOpts = d.rule_types.map(function(t) { return '<option value="' + t.key + '">' + escapeHtml(t.label) + '</option>'; }).join('');
  var sevOpts = d.severities.map(function(s) { return '<option value="' + s + '">' + s + '</option>'; }).join('');
  var actOpts = d.actions.map(function(a) { return '<option value="' + a + '">' + a.replace(/_/g, ' ') + '</option>'; }).join('');

  var h = '<div class="rules-list" id="rules-list">';
  if (!d.rules.length) h += '<p class="text-sm text-muted">No rules yet — create one below or start from a template.</p>';
  d.rules.forEach(function(rule) {
    h += '<div class="rule-row">' +
      '<label class="rule-toggle"><input type="checkbox" ' + (rule.enabled !== false ? 'checked' : '') + ' onchange="toggleRule(\'' + rule.id + '\', this.checked)"></label>' +
      '<div class="rule-row-main"><div class="rule-row-name">' + escapeHtml(rule.name) + ' <span class="' + severityClass(rule.severity) + '">' + escapeHtml(rule.severity) + '</span></div>' +
      '<div class="rule-row-sub">' + escapeHtml(ruleSummary(rule)) + ' · action: ' + escapeHtml((rule.action || 'flag').replace(/_/g, ' ')) + (rule.enabled === false ? ' · disabled' : '') + '</div></div>' +
      '<button type="button" class="btn-small btn-danger" onclick="deleteRule(\'' + rule.id + '\')">Delete</button></div>';
  });
  h += '</div>';

  h += '<div class="rules-templates"><span class="text-xs text-muted">Start from a template:</span> ';
  d.examples.forEach(function(ex, i) { h += '<button type="button" class="chat-chip" onclick="useRuleTemplate(' + i + ')">' + escapeHtml(ex.name) + '</button>'; });
  h += '</div>';

  h += '<div class="rules-form"><div class="settings-card-head" style="margin-bottom:0.75rem;"><h3>Create a rule</h3></div><div class="settings-fields">';
  h += '<div class="settings-group full"><label class="settings-label">Name</label><input class="settings-input" id="rule-name" placeholder="e.g. Large expense" /></div>';
  h += '<div class="settings-group full"><label class="settings-label">Description</label><input class="settings-input" id="rule-desc" placeholder="Optional" /></div>';
  h += '<div class="settings-group"><label class="settings-label">Condition</label><select class="settings-input" id="rule-type" onchange="onRuleTypeChange()">' + typeOpts + '</select></div>';
  h += '<div class="settings-group" id="rule-param-group"><label class="settings-label" id="rule-param-label">Amount (KES)</label><input class="settings-input" id="rule-amount" type="number" min="1" placeholder="e.g. 200000" /><input class="settings-input hidden" id="rule-keyword" placeholder="keyword" /></div>';
  h += '<div class="settings-group"><label class="settings-label">Severity</label><select class="settings-input" id="rule-severity">' + sevOpts + '</select></div>';
  h += '<div class="settings-group"><label class="settings-label">Action</label><select class="settings-input" id="rule-action">' + actOpts + '</select></div>';
  h += '</div>';
  h += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem;"><button type="button" class="btn-secondary btn-small" onclick="previewRuleForm()">Preview trigger</button><button type="button" class="btn-primary btn-small" onclick="saveRule()">Save rule</button></div>';
  h += '<div id="rule-preview-result" class="text-sm" style="margin-top:0.6rem;"></div></div>';

  h += '<div class="rules-history" id="rules-history"></div>';

  el.innerHTML = h;
  onRuleTypeChange();
  loadRuleHistory();
}

function onRuleTypeChange() {
  var d = appState.rulesData; if (!d) return;
  var sel = document.getElementById('rule-type'); if (!sel) return;
  var t = d.rule_types.filter(function(x) { return x.key === sel.value; })[0] || {};
  var amount = document.getElementById('rule-amount');
  var keyword = document.getElementById('rule-keyword');
  var label = document.getElementById('rule-param-label');
  var group = document.getElementById('rule-param-group');
  if (t.input === 'amount') { amount.classList.remove('hidden'); keyword.classList.add('hidden'); label.textContent = 'Amount (KES)'; group.style.display = ''; }
  else if (t.input === 'keyword') { keyword.classList.remove('hidden'); amount.classList.add('hidden'); label.textContent = 'Keyword'; group.style.display = ''; }
  else { amount.classList.add('hidden'); keyword.classList.add('hidden'); group.style.display = 'none'; }
}

function readRuleForm() {
  var g = function(id) { var e = document.getElementById(id); return e ? e.value : ''; };
  var type = g('rule-type');
  var d = appState.rulesData;
  var t = d && d.rule_types.filter(function(x) { return x.key === type; })[0];
  var cond = { type: type };
  if (t && t.input === 'amount') cond.amount = Number(g('rule-amount'));
  if (t && t.input === 'keyword') cond.keyword = g('rule-keyword');
  return { name: g('rule-name'), description: g('rule-desc'), severity: g('rule-severity'), action: g('rule-action'), condition: cond, enabled: true };
}

function previewRuleForm() {
  var out = document.getElementById('rule-preview-result');
  if (out) out.innerHTML = '<span class="text-muted">Checking against the current month…</span>';
  fetch('/api/rules/preview', { method: 'POST', headers: mutatingHeaders(), body: JSON.stringify(readRuleForm()) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (!out) return;
      if (!d.ok) { out.innerHTML = '<span class="text-red">' + escapeHtml(resolveUserError(d, 'Invalid rule.')) + '</span>'; return; }
      var p = d.preview;
      if (p.no_data) { out.innerHTML = '<span class="text-muted">Run a monthly review first to preview against real data.</span>'; return; }
      var s = '<span class="' + (p.matchCount > 0 ? 'text-amber' : 'text-emerald') + '">Would match <strong>' + p.matchCount + '</strong> item' + (p.matchCount === 1 ? '' : 's') + ' this month.</span>';
      if (p.samples && p.samples.length) s += '<ul style="margin:0.4rem 0 0;padding-left:1.2rem;">' + p.samples.map(function(x) { return '<li class="text-xs text-muted">' + escapeHtml(x) + '</li>'; }).join('') + '</ul>';
      out.innerHTML = s;
    }).catch(function() { if (out) out.innerHTML = '<span class="text-red">Preview failed.</span>'; });
}

function saveRule() {
  fetch('/api/rules', { method: 'POST', headers: mutatingHeaders(), body: JSON.stringify(readRuleForm()) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) { showToast('Rule saved.', 'success'); loadRules(); }
      else if (d.error === 'upgrade_required') showUpgradeModal(d.message || 'Custom rules are available on Growth or Custom Guidance.');
      else showToast(resolveUserError(d, 'Could not save rule.'), 'error');
    }).catch(function() { showToast('Could not save rule.', 'error'); });
}

function toggleRule(id, enabled) {
  fetch('/api/rules/' + id, { method: 'PUT', headers: mutatingHeaders(), body: JSON.stringify({ enabled: enabled }) })
    .then(function(r) { return r.json(); }).then(function(d) { if (d.ok) showToast('Rule ' + (enabled ? 'enabled' : 'disabled') + '.', 'info'); });
}

function deleteRule(id) {
  fetch('/api/rules/' + id, { method: 'DELETE' }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) { showToast('Rule deleted.', 'info'); loadRules(); } });
}

function useRuleTemplate(i) {
  var d = appState.rulesData; if (!d || !d.examples[i]) return;
  var ex = d.examples[i];
  var set = function(id, v) { var e = document.getElementById(id); if (e) e.value = v; };
  set('rule-name', ex.name); set('rule-desc', ex.description); set('rule-severity', ex.severity); set('rule-action', ex.action); set('rule-type', ex.condition.type);
  onRuleTypeChange();
  if (ex.condition.amount) set('rule-amount', ex.condition.amount);
  if (ex.condition.keyword) set('rule-keyword', ex.condition.keyword);
}

function loadRuleHistory() {
  var el = document.getElementById('rules-history'); if (!el) return;
  fetch('/api/rules/history').then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok || !d.history.length) { el.innerHTML = ''; return; }
    var h = '<div class="settings-card-head" style="margin-top:1.5rem;margin-bottom:0.5rem;"><h3>Rule execution history</h3></div>';
    h += '<table class="data-table"><thead><tr><th>When</th><th>Month</th><th>Rule</th><th>Matches</th></tr></thead><tbody>';
    d.history.forEach(function(run) {
      (run.results || []).forEach(function(res) {
        h += '<tr><td class="text-xs text-muted">' + escapeHtml((run.at || '').slice(0, 16).replace('T', ' ')) + '</td><td class="text-sm">' + escapeHtml(run.month || '—') + '</td><td class="text-sm">' + escapeHtml(res.ruleName || '—') + '</td><td class="text-sm">' + (res.matchCount || 0) + '</td></tr>';
      });
    });
    h += '</tbody></table>';
    el.innerHTML = h;
  }).catch(function() {});
}

function renderSettings() {
  var active = appState.settingsSection || 'profile';
  var navItems = [
    { key: 'profile',      label: 'Profile' },
    { key: 'plan',         label: 'Plan & Usage' },
    { key: 'rules',        label: 'Financial Rules' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'assistant',    label: 'Guided Assistant' },
    { key: 'monitoring',   label: 'Monitoring' },
    { key: 'team',         label: 'Team' },
    { key: 'alerts',       label: 'Risk & Alerts' },
    { key: 'access',       label: 'Access' }
  ];

  function cardHead(title, desc) {
    return '<div class="settings-card-head"><h3>' + escapeHtml(title) + '</h3>' +
      (desc ? '<p>' + escapeHtml(desc) + '</p>' : '') + '</div>';
  }
  function field(label, control, full) {
    return '<div class="settings-group' + (full ? ' full' : '') + '"><label class="settings-label">' +
      escapeHtml(label) + '</label>' + control + '</div>';
  }

  var html = '<div class="settings-layout">';

  /* Left section nav */
  html += '<nav class="settings-nav">';
  navItems.forEach(function(n) {
    html += '<button type="button" class="settings-nav-item' + (n.key === active ? ' active' : '') +
      '" data-sec="' + n.key + '" onclick="switchSettingsSection(\'' + n.key + '\')">' + escapeHtml(n.label) + '</button>';
  });
  html += '</nav>';

  /* Right body */
  html += '<div class="settings-body">';

  /* ── Profile ── */
  html += '<div class="settings-panel' + (active === 'profile' ? ' active' : '') + '" data-section="profile">';
  html += '<div class="glass-card">' + cardHead('Personal Information', 'This information appears on your reports and dashboard.') +
    '<div class="settings-fields">' +
      field('Your Name', '<input type="text" class="settings-input" id="settings-name" value="' + escapeHtml(appState.userName) + '" />') +
      field('Company Name', '<input type="text" class="settings-input" id="settings-company" value="' + escapeHtml(appState.businessName) + '" />') +
    '</div></div>';
  html += '</div>';

  /* ── Plan & Credits ── */
  html += '<div class="settings-panel' + (active === 'plan' ? ' active' : '') + '" data-section="plan">';
  html += '<div class="glass-card">' + cardHead('Plan & Guidance Usage', 'Your subscription and available guidance usage for the current cycle. Core analysis always remains available.') +
    '<div id="plan-panel-body"><p class="text-sm text-muted">Loading plan…</p></div></div>';
  /* Upgrade cards and checkout. Populated from /api/billing/plans, so prices
     and availability come from the server catalog — never from this file. */
  html += '<div class="glass-card section-gap" id="billing-card">'
    + cardHead('Upgrade', 'Plans, prices and payment.')
    + '<div id="billing-body"><p class="text-sm text-muted">Loading plans…</p></div></div>';
  html += '</div>';

  /* ── Financial Rules ── */
  html += '<div class="settings-panel' + (active === 'rules' ? ' active' : '') + '" data-section="rules">';
  html += '<div class="glass-card">' + cardHead('Custom Financial Rules', 'Define your own policies. Matches feed straight into the risk engine and show up as findings on your dashboard and reports.') +
    '<div id="rules-panel-body"><p class="text-sm text-muted">Loading rules…</p></div></div>';
  html += '</div>';

  /* ── Integrations ── */
  html += '<div class="settings-panel' + (active === 'integrations' ? ' active' : '') + '" data-section="integrations">';
  html += '<div class="glass-card">' + cardHead('Zoho Books', 'Connect your accounting data source for automatic monthly sync.') +
    '<div id="settings-zoho-panel"></div></div>';
  html += '<div class="glass-card">' + cardHead('Avalanche Wallet', 'Optional on-chain identity for contract deployment workflows.') +
    '<div id="settings-wallet-panel"></div></div>';
  html += '</div>';

  /* ── Guided Assistant ── */
  var aiKeyPlaceholder = appState.aiApiKeyConfigured
    ? 'Saved - leave blank to keep, or enter a new one to replace it'
    : 'Enter access key';
  var providerControl = '<input type="hidden" id="settings-ai-provider" value="' + escapeHtml(appState.aiProvider || 'openai') + '" />';
  var assistantControl = '<select class="settings-input" id="settings-ai-assistant">' +
      '<option value="controller-core"' + (appState.aiAssistant === 'controller-core' ? ' selected' : '') + '>Controller Core</option>' +
      '<option value="risk-analyst"' + (appState.aiAssistant === 'risk-analyst' ? ' selected' : '') + '>Risk Analyst</option>' +
      '<option value="cashflow-guardian"' + (appState.aiAssistant === 'cashflow-guardian' ? ' selected' : '') + '>Cashflow Guardian</option>' +
      '<option value="executive-brief"' + (appState.aiAssistant === 'executive-brief' ? ' selected' : '') + '>Executive Brief</option>' +
    '</select>';
  var keyControl = '<input type="password" class="settings-input" id="settings-ai-api-key" value="" placeholder="' + escapeHtml(aiKeyPlaceholder) + '" autocomplete="off" />' +
    '<div id="ai-key-hint" class="text-xs text-muted" style="margin-top:0.4rem;"></div>';
  if (appState.aiApiKeyConfigured && appState.aiApiKeyPreview) {
    keyControl += '<div class="text-xs text-emerald" style="margin-top:0.35rem;">' + icon('check-circle') + ' Currently saved: <span class="mono">' + escapeHtml(appState.aiApiKeyPreview) + '</span></div>';
  }
  html += '<div class="settings-panel' + (active === 'assistant' ? ' active' : '') + '" data-section="assistant">';
  if (planAllows('bring_your_own_ai')) {
    /* Custom guidance: user-owned access key. */
    var byokNotice = '';
    if (!appState.aiApiKeyConfigured) {
      byokNotice = '<div class="byok-setup">' + icon('alert-triangle') +
        '<div><strong>Add your access key to start.</strong><div class="text-xs text-muted">' +
        'Live guidance uses your own key on this plan. Add it below to enable guided features.</div></div></div>';
    }
    html += '<div class="glass-card">' + cardHead('Guidance Access Key', 'Use your own key for live guidance on this plan.') +
      byokNotice +
      '<div class="settings-fields">' +
        providerControl +
        field('Assistant Style', assistantControl) +
        field('Access Key', keyControl, true) +
      '</div></div>';
  } else {
    /* Managed guidance mode. */
    html += '<div class="glass-card">' + cardHead('Guided Assistant', 'Choose how your guidance is phrased. No key is required on this plan.') +
      '<div class="settings-fields">' + field('Assistant Style', assistantControl) + '</div></div>';
    html += lockedFeatureCard(
      'bring_your_own_ai',
      'Use Your Own Key',
      'Use your own access key for live guidance with no monthly cap.'
    );
    if (appState.aiApiKeyConfigured) {
      html += '<div class="text-xs text-muted" style="margin-top:0.75rem;">' + icon('info') +
        ' You have a saved access key from a previous plan. It is kept safely but not used on this plan.</div>';
    }
  }
  html += '</div>';

  /* ── Continuous Monitoring ── */
  html += '<div class="settings-panel' + (active === 'monitoring' ? ' active' : '') + '" data-section="monitoring">';
  html += '<div class="glass-card">' + cardHead('Continuous Monitoring', 'Automatically re-analyze your books on a schedule and alert you the moment a new issue appears — no duplicate alerts.') +
    '<div id="monitoring-panel-body"><p class="text-sm text-muted">Loading monitoring…</p></div></div>';
  html += '</div>';

  /* ── Team ── */
  html += '<div class="settings-panel' + (active === 'team' ? ' active' : '') + '" data-section="team">';
  html += '<div class="glass-card">' + cardHead('Team & Roles', 'Invite teammates to your business. Each role grants a fixed set of permissions.') +
    '<div id="team-panel-body"><p class="text-sm text-muted">Loading team…</p></div></div>';
  html += '</div>';

  /* ── Risk & Alerts ── */
  html += '<div class="settings-panel' + (active === 'alerts' ? ' active' : '') + '" data-section="alerts">';
  html += '<div class="glass-card">' + cardHead('Risk Thresholds', 'When to raise warnings across the dashboard.') +
    '<div class="settings-fields">' +
      /* JOB 7/8: these inputs were never read by anything, and the values they
         displayed (30 days, 40%) contradicted the registry. Showing a user an
         editable threshold that has no effect is worse than showing none, so
         they are replaced by a pointer to the real, published methodology. */
      field('Analysis thresholds',
        '<a class="settings-link" href="/api/methodology?format=markdown" target="_blank" rel="noopener">'
        + 'View the current rules and thresholds</a>'
        + '<div class="text-sm text-muted">Thresholds are set by the deterministic rules '
        + 'engine and are the same for every business.</div>') +
    '</div></div>';
  html += '<div class="glass-card">' + cardHead('Notifications', 'Where alerts are sent.') +
    '<div class="settings-fields">' +
      field('Alert Email', '<input type="email" class="settings-input" id="settings-email" placeholder="alerts@company.com" />', true) +
    '</div></div>';
  html += '</div>';

  /* ── Access ── */
  html += '<div class="settings-panel' + (active === 'access' ? ' active' : '') + '" data-section="access">';
  html += '<div class="glass-card">' + cardHead('User Management', 'Roles and access review cadence.') +
    '<div class="settings-fields">' +
      field('Primary User Role', '<input type="text" class="settings-input" value="Owner / Admin" readonly />') +
      field('Access Review', '<input type="text" class="settings-input" value="Review quarterly" readonly />') +
    '</div></div>';
  html += '</div>';

  /* Save bar (always visible) */
  html += '<div class="settings-save"><button class="btn-primary" onclick="saveSettings()">' + icon('save') + ' Save changes</button></div>';

  html += '</div>'; /* /settings-body */
  html += '</div>'; /* /settings-layout */

  $pageContent.innerHTML = html;
  renderWalletConnectCard('settings-wallet-panel', { compact: true, showDisconnect: true });
  renderZohoPanel('settings-zoho-panel');

  /* Plan & credits: render from cache if present, then refresh from server. */
  if (appState.entitlement) renderPlanPanel();
  loadEntitlement().then(renderPlanPanel);

  /* Custom financial rules */
  loadRules();

  /* Continuous monitoring */
  loadMonitoring();

  /* Team & roles */
  loadTeam();

  var aiProviderSelect = document.getElementById('settings-ai-provider');
  if (aiProviderSelect) {
    updateAiKeyHint(aiProviderSelect.value);
    aiProviderSelect.addEventListener('change', function() { updateAiKeyHint(this.value); });
  }
}

function switchSettingsSection(sec) {
  appState.settingsSection = sec;
  var navBtns = document.querySelectorAll('.settings-nav-item');
  navBtns.forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
  var panels = document.querySelectorAll('.settings-panel');
  panels.forEach(function(p) { p.classList.toggle('active', p.getAttribute('data-section') === sec); });
}

function updateAiKeyHint(provider) {
  void provider;
  var hintEl = document.getElementById('ai-key-hint');
  if (!hintEl) return;
  hintEl.textContent = 'Enter your account access key. It is stored securely and can be replaced at any time.';
}

function renderZohoPanel(containerId) {
  var el = document.getElementById(containerId);
  if (!el) return;

  var connected = Boolean(appState.zohoApiKey);
  var cardClass = 'wallet-connect-card wallet-connect-compact glass-card' + (connected ? ' wallet-connect-verified' : '');
  var html = '<div class="' + cardClass + '">';

  if (connected) {
    html += '<div class="wallet-connect-icon text-emerald">' + icon('check-circle', { cls: 'icon-lg' }) + '</div>';
    html += '<div><div class="wallet-connect-title">Zoho Books connected</div>';
    html += '<div class="text-sm text-muted">' + (appState.zohoOrgId ? 'Org ID: ' + escapeHtml(appState.zohoOrgId) : 'Ready to sync your books') + '</div></div>';
    html += '<button type="button" class="btn-ghost" id="' + containerId + '-disconnect">Disconnect</button>';
  } else {
    html += '<div class="wallet-connect-icon">' + icon('book-open', { cls: 'icon-lg' }) + '</div>';
    html += '<div><div class="wallet-connect-title">Not connected</div>';
    html += '<div class="text-sm text-muted">Connect to import financial data automatically.</div></div>';
    html += '<button type="button" class="btn-primary" id="' + containerId + '-connect">' + icon('book-open') + ' Connect Zoho</button>';
  }

  html += '</div>';
  el.innerHTML = html;

  var connectBtn = document.getElementById(containerId + '-connect');
  if (connectBtn) {
    connectBtn.addEventListener('click', function() {
      var oauthUrl = '/api/oauth/zoho/start?name=' + encodeURIComponent(appState.userName)
        + '&business_name=' + encodeURIComponent(appState.businessName);
      window.location.href = oauthUrl;
    });
  }

  var disconnectBtn = document.getElementById(containerId + '-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async function() {
      try {
        await fetch('/api/oauth/zoho/disconnect', { method: 'POST', headers: csrfHeaders() });
        appState.zohoApiKey = '';
        appState.zohoOrgId = '';
        renderZohoPanel(containerId);
        showToast('Zoho Books disconnected.', 'info');
      } catch (e) {
        showToast('Could not disconnect. Try again.', 'error');
      }
    });
  }
}

function safeParseJson(input, fallback) {
  if (!input || !String(input).trim()) return fallback;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function prettyJson(data) {
  return escapeHtml(JSON.stringify(data, null, 2));
}

async function deployContractFromSettings() {
  var contractName = document.getElementById('settings-contract-name').value.trim();
  var receiverAddress = document.getElementById('settings-contract-receiver').value.trim();
  var templateId = document.getElementById('settings-contract-template').value;
  var advancedMode = document.getElementById('settings-contract-advanced-abi').checked;
  var abiInput = document.getElementById('settings-contract-abi').value;
  var bytecode = document.getElementById('settings-contract-bytecode').value.trim();
  var constructorArgsInput = document.getElementById('settings-contract-args').value;
  var dryRun = document.getElementById('settings-contract-dryrun').checked;
  var resultEl = document.getElementById('contract-deploy-result');

  var constructorArgs = safeParseJson(constructorArgsInput, []);

  if (!Array.isArray(constructorArgs)) {
    showToast('Constructor args must be a valid JSON array.', 'warning');
    return;
  }

  var payload = {
    templateId: templateId || null,
    receiverAddress: receiverAddress,
    contractName: contractName || undefined,
    constructorArgs: constructorArgs,
    dryRun: dryRun
  };

  if (!receiverAddress) {
    showToast('Receiver address is required.', 'warning');
    return;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(receiverAddress)) {
    showToast('Receiver address must be a valid 0x address.', 'warning');
    return;
  }

  if (!advancedMode && !payload.templateId) {
    showToast('Please select a contract template.', 'warning');
    return;
  }

  if (advancedMode) {
    var abi = safeParseJson(abiInput, []);
    if (!Array.isArray(abi)) {
      showToast('ABI must be a valid JSON array.', 'warning');
      return;
    }
    if (!bytecode) {
      showToast('Bytecode is required in advanced mode.', 'warning');
      return;
    }
    payload.abi = abi;
    payload.bytecode = bytecode;
  }

  resultEl.innerHTML = '<div class="loading-shimmer" style="height:90px;margin-top:0.75rem"></div>';

  try {
    var res = await fetch('/api/avalanche/contracts/deploy', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify(payload)
    });
    var data = await res.json();

    if (data.ok) {
      showToast(dryRun ? 'Dry run completed.' : 'Deployment submitted.', 'success');
      resultEl.innerHTML = '<pre class="json-block">' + prettyJson(data) + '</pre>';
    } else {
      showToast(resolveUserError(data, 'Deployment could not be completed.'), 'error');
      resultEl.innerHTML = '<pre class="json-block">' + prettyJson(data) + '</pre>';
    }
    loadContractDeploymentHistory();
  } catch (e) {
    showToast('Deployment request failed.', 'error');
    resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:0.75rem;">Connection error.</p>';
  }
}

async function loadContractTemplates() {
  var select = document.getElementById('settings-contract-template');
  if (!select) return;

  select.innerHTML = '<option value="">Loading templates...</option>';
  try {
    var res = await fetch('/api/avalanche/contracts/templates');
    var data = await res.json();
    if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
      select.innerHTML = '<option value="">No templates available</option>';
      return;
    }

    select.innerHTML = '<option value="">Select template</option>';
    data.items.forEach(function(item) {
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label + ' (' + item.contract_name + ')';
      select.appendChild(option);
    });
  } catch (e) {
    select.innerHTML = '<option value="">Unable to load templates</option>';
  }
}

async function loadContractDeploymentHistory() {
  var historyEl = document.getElementById('contract-deploy-history');
  if (!historyEl) return;

  historyEl.innerHTML = '<div class="loading-shimmer" style="height:90px"></div>';
  try {
    var res = await fetch('/api/avalanche/contracts/deployments?limit=12');
    var data = await res.json();
    if (!data.ok || !Array.isArray(data.items)) {
      historyEl.innerHTML = '<p class="text-muted text-sm">Unable to load deployment history.</p>';
      return;
    }

    if (data.items.length === 0) {
      historyEl.innerHTML = '<p class="text-muted text-sm">No deployments recorded yet.</p>';
      return;
    }

    var html = '<table class="data-table"><thead><tr><th>When</th><th>Contract</th><th>Receiver</th><th>Mode</th><th>Status</th><th>Tx / Error</th></tr></thead><tbody>';
    data.items.forEach(function(item) {
      var statusClass = item.ok ? 'badge-low' : 'badge-high';
      var statusText = item.ok ? 'ok' : 'failed';
      var txOrErr = item.tx_hash || item.error || '—';
      html += '<tr>';
      html += '<td class="text-xs text-muted">' + escapeHtml(item.created_at || '—') + '</td>';
      html += '<td>' + escapeHtml(item.contract_name || '—') + '</td>';
      html += '<td class="text-xs" style="max-width:220px;overflow-wrap:anywhere;">' + escapeHtml(item.receiver_address || '—') + '</td>';
      html += '<td>' + escapeHtml(item.mode || '—') + '</td>';
      html += '<td><span class="' + statusClass + '">' + statusText + '</span></td>';
      html += '<td class="text-xs" style="max-width:260px;overflow-wrap:anywhere;">' + escapeHtml(txOrErr) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    historyEl.innerHTML = html;
  } catch (e) {
    historyEl.innerHTML = '<p class="text-muted text-sm">Unable to load deployment history.</p>';
  }
}

async function saveSettings() {
  var name = document.getElementById('settings-name').value.trim();
  var company = document.getElementById('settings-company').value.trim();
  var aiProviderEl = document.getElementById('settings-ai-provider');
  var aiProvider = aiProviderEl ? aiProviderEl.value : appState.aiProvider;
  var aiKeyEl = document.getElementById('settings-ai-api-key');
  var aiApiKey = aiKeyEl ? aiKeyEl.value.trim() : '';
  var aiAssistant = document.getElementById('settings-ai-assistant').value;

  try {
    var res = await fetch('/api/profile', {
      method: 'POST',
      headers: mutatingHeaders(),
      body: JSON.stringify({
        name: name,
        business_name: company,
        ai_provider: aiProvider,
        ai_api_key: aiApiKey,
        ai_assistant: aiAssistant
      })
    });
    var data = await res.json();
    if (!data.ok && data.error === 'upgrade_required') {
      showUpgradeModal(data.message || 'Use Your Own Key is available on the Custom Guidance plan.');
      return;
    }
    if (data.ok) {
      appState.userName = name;
      appState.businessName = company;
      appState.aiProvider = aiProvider;
      appState.aiAssistant = aiAssistant;
      if (aiApiKey) appState.aiApiKeyConfigured = true;
      $companyContext.textContent = 'Company: ' + company;
      showToast(aiApiKey ? 'Settings saved — AI access key stored.' : 'Settings saved successfully!', 'success');

      // Take the user straight to Controller Overview so they immediately
      // see the effect of what they just saved, instead of leaving them on
      // a Settings form with no visible confirmation the key "stuck".
      navigate('overview');

      // A newly-entered AI key should immediately start powering the
      // skill-grounded analysis, not wait for a separate manual step --
      // runMonthlyReview() re-renders whatever page is current (now Overview).
      if (aiApiKey) {
        var targetMonth = appState.activeMonth || generateRecentMonths(1)[0];
        showToast('Running skill-grounded AI analysis…', 'info');
        await runMonthlyReview(targetMonth);
      }
    } else {
      showToast(resolveUserError(data, 'We could not save your changes.'), 'error');
    }
  } catch (e) {
    showToast('Connection error. Please try again.', 'error');
  }
}

/* ── Continuous Monitoring (settings) ────────────────────────── */
var MONITOR_FREQ_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
var appMonitoring = null;

function formatDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}
function formatRelativeTime(iso) {
  if (!iso) return '';
  var t = Date.parse(iso);
  if (!isFinite(t)) return '';
  var s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function loadMonitoring() {
  var el = document.getElementById('monitoring-panel-body');
  if (!el) return;
  fetch('/api/monitoring').then(function(r) { return r.json(); }).then(function(d) {
    if (!d || !d.ok) { el.innerHTML = '<p class="text-sm text-muted">Could not load monitoring.</p>'; return; }
    appMonitoring = d;
    renderMonitoringPanel(d);
  }).catch(function() { el.innerHTML = '<p class="text-sm text-muted">Could not load monitoring.</p>'; });
}

function renderMonitoringPanel(d) {
  var el = document.getElementById('monitoring-panel-body');
  if (!el) return;
  var mon = d.monitoring || {};
  var allowed = d.allowed_frequencies || [];
  var isPro = allowed.indexOf('daily') !== -1;
  var opts = ['daily', 'weekly', 'monthly'].map(function(f) {
    var locked = allowed.indexOf(f) === -1;
    return '<option value="' + f + '"' + (mon.frequency === f ? ' selected' : '') + (locked ? ' disabled' : '') +
      '>' + MONITOR_FREQ_LABELS[f] + (locked ? ' — Growth' : '') + '</option>';
  }).join('');

  var statusCls = mon.lastStatus === 'error' ? 'text-red' : mon.lastStatus === 'ok' ? 'text-emerald' : 'text-muted';
  var statusTxt = mon.lastStatus ? (mon.lastStatus === 'ok'
    ? 'Healthy' + (mon.lastNewIssues != null ? ' · ' + mon.lastNewIssues + ' new last run' : '')
    : 'Error — ' + escapeHtml(mon.lastError || 'sync failed')) : 'Not run yet';

  var canSchedule = d.can_schedule !== undefined ? d.can_schedule : (allowed.indexOf('daily') !== -1);

  var html = '';

  if (!canSchedule) {
    /* Starter: automatic monitoring is a paid capability, but MANUAL analysis is
       unlimited -- so we show what's locked without taking anything away. */
    html += '<div class="mon-manual">' + icon('check-circle') +
      '<div><div class="mon-toggle-title">Manual analysis — unlimited</div>' +
      '<div class="text-xs text-muted">Run a fresh analysis whenever you like. Your dashboard, alerts and reports all stay up to date.</div></div></div>';
    html += '<div style="margin-top:1rem;"><button type="button" class="btn-primary btn-small" onclick="syncMonitoringNow()">' + icon('clock') + ' Run analysis now</button></div>';

    html += '<div class="mon-locked">' +
      '<div class="locked-head">' + lockIcon() +
        '<div><div class="locked-title">Automatic monitoring</div>' +
        '<div class="locked-sub">Let FinGuard analyze your books on a schedule and alert you the moment a new issue appears.</div></div>' +
        '<span class="locked-badge">Growth</span></div>' +
      '<ul class="locked-list">' +
        '<li>Daily, weekly or monthly scheduled analysis</li>' +
        '<li>Automatic alerts on new issues — no duplicate notifications</li>' +
        '<li>Runs even when you are not signed in</li>' +
      '</ul>' +
      '<button type="button" class="btn-primary btn-small" onclick="showUpgradeModal(\'Automatic scheduled monitoring is available on the Growth and Custom Guidance plans. Manual analysis stays unlimited on Starter.\')">Unlock automatic monitoring</button>' +
    '</div>';

    if (mon.lastRunAt) {
      html += '<div class="mon-status">' +
        '<div class="mon-stat"><span class="mon-stat-label">Last analysis</span><span class="mon-stat-val">' + formatDateTime(mon.lastRunAt) + '</span></div>' +
        '<div class="mon-stat"><span class="mon-stat-label">Status</span><span class="mon-stat-val ' + statusCls + '">' + statusTxt + '</span></div>' +
      '</div>';
    }
    el.innerHTML = html;
    return;
  }

  html += '<div class="mon-toggle-row">' +
    '<label class="switch"><input type="checkbox" id="mon-enabled"' + (mon.enabled ? ' checked' : '') + ' onchange="saveMonitoring()"><span class="switch-slider"></span></label>' +
    '<div><div class="mon-toggle-title">' + (mon.enabled ? 'Monitoring is on' : 'Monitoring is off') + '</div>' +
    '<div class="text-xs text-muted">Growth — sync as often as daily.</div></div></div>';

  html += '<div class="settings-fields" style="margin-top:1.1rem;">' +
    '<div class="settings-group"><label class="settings-label">Sync frequency</label>' +
    '<select class="settings-input" id="mon-frequency" onchange="saveMonitoring()">' + opts + '</select></div></div>';

  html += '<div class="mon-status">' +
    '<div class="mon-stat"><span class="mon-stat-label">Last sync</span><span class="mon-stat-val">' + formatDateTime(mon.lastRunAt) + '</span></div>' +
    '<div class="mon-stat"><span class="mon-stat-label">Next due</span><span class="mon-stat-val">' + (mon.enabled ? (mon.nextDueAt ? formatDateTime(mon.nextDueAt) : 'Soon') : '—') + '</span></div>' +
    '<div class="mon-stat"><span class="mon-stat-label">Status</span><span class="mon-stat-val ' + statusCls + '">' + statusTxt + '</span></div>' +
  '</div>';

  html += '<div style="margin-top:1.1rem;"><button type="button" class="btn-secondary btn-small" onclick="syncMonitoringNow()">' + icon('clock') + ' Sync now</button></div>';
  el.innerHTML = html;
}

function saveMonitoring() {
  var enabled = document.getElementById('mon-enabled');
  var freq = document.getElementById('mon-frequency');
  var body = {};
  if (enabled) body.enabled = enabled.checked;
  if (freq) body.frequency = freq.value;
  fetch('/api/monitoring', { method: 'POST', headers: mutatingHeaders(), body: JSON.stringify(body) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) {
        appMonitoring = d;
        renderMonitoringPanel(d);
        showToast('Monitoring ' + (d.monitoring.enabled ? 'on (' + MONITOR_FREQ_LABELS[d.monitoring.frequency] + ')' : 'off'), 'success');
        if (d.monitoring.enabled && window.Notification && Notification.permission === 'default') {
          try { Notification.requestPermission(); } catch (e) {}
        }
        loadNotifications();
      } else if (d && d.error === 'upgrade_required') {
        showUpgradeModal(d.message || 'Automatic scheduled monitoring is available on the Growth and Custom Guidance plans.');
        loadMonitoring();
      } else { showToast('Could not update monitoring.', 'error'); }
    }).catch(function() { showToast('Could not update monitoring.', 'error'); });
}

function syncMonitoringNow() {
  showToast('Syncing your books…', 'info');
  fetch('/api/monitoring/run', { method: 'POST', headers: mutatingHeaders(), body: '{}' })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) {
        var n = (d.result && d.result.newIssues) || 0;
        showToast(n > 0 ? (n + ' new issue' + (n > 1 ? 's' : '') + ' found') : 'Sync complete — no new issues', 'success');
        applyNotifications(d.notifications || [], d.unread || 0);
        if (document.getElementById('monitoring-panel-body') && d.monitoring) {
          renderMonitoringPanel({ monitoring: d.monitoring, allowed_frequencies: (appMonitoring && appMonitoring.allowed_frequencies) || ['monthly'] });
        }
      } else { showToast('Sync failed.', 'error'); }
    }).catch(function() { showToast('Sync failed.', 'error'); });
}

/* ── Notifications (header bell) ──────────────────────────────── */
var notifState = { items: [], unread: 0 };

function loadNotifications() {
  return fetch('/api/notifications').then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) {
      applyNotifications(d.notifications || [], d.unread || 0);
      if (d.synced && d.synced.newIssues > 0) maybeBrowserNotify(d.synced.newIssues);
    }
    return d;
  }).catch(function() {});
}

function applyNotifications(items, unread) {
  notifState.items = items || [];
  notifState.unread = unread != null ? unread : notifState.items.filter(function(n) { return !n.read; }).length;
  renderNotifBadge();
  var pop = document.getElementById('notif-popover');
  if (pop && !pop.classList.contains('hidden')) renderNotifList();
}

function renderNotifBadge() {
  var b = document.getElementById('notif-badge');
  if (!b) return;
  if (notifState.unread > 0) { b.textContent = notifState.unread > 9 ? '9+' : String(notifState.unread); b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderNotifList() {
  var list = document.getElementById('notif-list');
  if (!list) return;
  if (!notifState.items.length) {
    list.innerHTML = '<div class="notif-empty">' + icon('check-circle') + ' No alerts — you’re all caught up.</div>';
    return;
  }
  list.innerHTML = notifState.items.map(function(n) {
    return '<div class="notif-item' + (n.read ? ' read' : '') + '">' +
      '<span class="notif-dot notif-dot-' + (n.level || 'low') + '"></span>' +
      '<div class="notif-item-main">' +
        '<div class="notif-item-title">' + escapeHtml(n.title || 'Alert') + '</div>' +
        '<div class="notif-item-body">' + escapeHtml(n.body || '') + '</div>' +
        '<div class="notif-item-meta">' + escapeHtml(formatRelativeTime(n.ts)) + (n.period ? ' · ' + escapeHtml(getMonthLabel(n.period)) : '') + '</div>' +
      '</div></div>';
  }).join('');
}

function toggleNotifPanel() {
  var pop = document.getElementById('notif-popover');
  if (!pop) return;
  if (pop.classList.contains('hidden')) {
    var prof = document.getElementById('profile-popover');
    if (prof) prof.classList.add('hidden');
    pop.classList.remove('hidden');
    renderNotifList();
    if (notifState.unread > 0) markAllNotifsRead();
  } else {
    pop.classList.add('hidden');
  }
}
function closeNotifPanel() { var p = document.getElementById('notif-popover'); if (p) p.classList.add('hidden'); }

function markAllNotifsRead() {
  fetch('/api/notifications/read', { method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ all: true }) })
    .then(function(r) { return r.json(); }).then(function(d) {
      notifState.items.forEach(function(n) { n.read = true; });
      notifState.unread = (d && d.unread) || 0;
      renderNotifBadge();
      renderNotifList();
    }).catch(function() {});
}

function maybeBrowserNotify(count) {
  if (window.Notification && Notification.permission === 'granted') {
    try {
      new Notification('FinGuard: ' + count + ' new financial alert' + (count > 1 ? 's' : ''), {
        body: 'New issues were detected in your latest sync.', tag: 'finguard-monitor'
      });
    } catch (e) {}
  }
}

document.addEventListener('click', function(ev) {
  var pop = document.getElementById('notif-popover');
  var bell = document.getElementById('notif-bell');
  if (!pop || pop.classList.contains('hidden')) return;
  if (pop.contains(ev.target) || (bell && bell.contains(ev.target))) return;
  pop.classList.add('hidden');
});

/* ── Team & Roles (settings) ──────────────────────────────────── */
var appTeam = null;

function statusBadge(status) {
  if (status === 'active') return '<span class="team-badge team-badge-active">Active</span>';
  if (status === 'pending') return '<span class="team-badge team-badge-pending">Invited</span>';
  return '<span class="team-badge">' + escapeHtml(status || '—') + '</span>';
}

function loadTeam() {
  var el = document.getElementById('team-panel-body');
  if (!el) return;
  fetch('/api/team').then(function(r) { return r.json(); }).then(function(d) {
    if (!d || !d.ok) { el.innerHTML = '<p class="text-sm text-muted">Could not load team.</p>'; return; }
    appTeam = d;
    renderTeamPanel(d);
  }).catch(function() { el.innerHTML = '<p class="text-sm text-muted">Could not load team.</p>'; });
}

function renderTeamPanel(d) {
  var el = document.getElementById('team-panel-body');
  if (!el) return;
  var matrix = d.matrix || { roles: [], permissions: [] };

  if (d.can_manage === false) {
    var owner = (d.members || [])[0] || {};
    var locked = '<div class="team-members"><div class="team-member-row">' +
      '<div class="team-member-id"><div class="team-avatar">' + escapeHtml((owner.name || owner.email || 'F').slice(0, 1).toUpperCase()) + '</div>' +
      '<div><div class="team-member-name">' + escapeHtml(owner.name || 'You') + '</div>' +
      '<div class="team-member-email">' + escapeHtml(owner.email || '') + '</div></div></div>' +
      '<div class="team-member-role"><span class="team-role-owner">' + icon('shield') + ' Founder · Owner</span></div>' +
      '<div class="team-member-status">' + statusBadge('active') + '</div><div></div></div></div>';

    locked += '<div class="mon-locked">' +
      '<div class="locked-head">' + lockIcon() +
        '<div><div class="locked-title">Team collaboration</div>' +
        '<div class="locked-sub">Invite your finance officer, accountant, auditor or investors — each with the right level of access.</div></div>' +
        '<span class="locked-badge">Growth</span></div>' +
      '<ul class="locked-list">' +
        '<li>5 roles: Founder, Finance Officer, Accountant, Auditor, Investor</li>' +
        '<li>Granular permissions: view, edit, approve, comment, resolve</li>' +
        '<li>Comment on and resolve findings together</li>' +
      '</ul>' +
      '<button type="button" class="btn-primary btn-small" onclick="showUpgradeModal(\'Team members, roles and accountant collaboration are available on the Growth and Custom Guidance plans.\')">Unlock team collaboration</button>' +
    '</div>';

    /* Still show what each role can do, so the value is concrete. */
    locked += '<div class="settings-card-head" style="margin-top:1.4rem;"><h3>What each role can do</h3></div>';
    locked += '<div class="team-matrix-wrap"><table class="team-matrix"><thead><tr><th>Role</th>';
    matrix.permissions.forEach(function(pm) { locked += '<th>' + escapeHtml(pm.label) + '</th>'; });
    locked += '</tr></thead><tbody>';
    matrix.roles.forEach(function(r) {
      locked += '<tr><td class="team-matrix-role">' + escapeHtml(r.label) + '</td>';
      matrix.permissions.forEach(function(pm) {
        var has = r.permissions.indexOf(pm.key) !== -1;
        locked += '<td>' + (has ? '<span class="team-check text-emerald">' + icon('check-circle') + '</span>' : '<span class="team-dash">—</span>') + '</td>';
      });
      locked += '</tr>';
    });
    locked += '</tbody></table></div>';
    el.innerHTML = locked;
    return;
  }

  var assignRoles = matrix.roles.filter(function(r) { return r.key !== 'founder'; });
  var roleOpts = function(sel) {
    return assignRoles.map(function(r) {
      return '<option value="' + r.key + '"' + (r.key === sel ? ' selected' : '') + '>' + escapeHtml(r.label) + '</option>';
    }).join('');
  };

  var html = '';

  /* Members table */
  html += '<div class="team-members">';
  (d.members || []).forEach(function(m) {
    var roleCell = m.isOwner
      ? '<span class="team-role-owner">' + icon('shield') + ' Founder · Owner</span>'
      : '<select class="settings-input team-role-select" onchange="changeMemberRole(\'' + m.id + '\', this.value)">' + roleOpts(m.role) + '</select>';
    var actionCell = m.isOwner
      ? ''
      : '<button type="button" class="team-remove" title="Remove" onclick="removeTeamMember(\'' + m.id + '\',\'' + escapeHtml(m.name || m.email) + '\')">' + icon('x-circle') + '</button>';
    html += '<div class="team-member-row">' +
      '<div class="team-member-id"><div class="team-avatar">' + escapeHtml((m.name || m.email || '?').slice(0, 1).toUpperCase()) + '</div>' +
        '<div><div class="team-member-name">' + escapeHtml(m.name || '—') + '</div>' +
        '<div class="team-member-email">' + escapeHtml(m.email || '') + '</div></div></div>' +
      '<div class="team-member-role">' + roleCell + '</div>' +
      '<div class="team-member-status">' + statusBadge(m.status) + '</div>' +
      '<div class="team-member-actions">' + actionCell + '</div>' +
    '</div>';
  });
  html += '</div>';

  /* Invite form */
  html += '<div class="team-invite">' +
    '<div class="settings-card-head" style="margin-top:1.4rem;"><h3>Invite a teammate</h3><p>They get an invite link to join this business with the role you choose.</p></div>' +
    '<div class="team-invite-row">' +
      '<input type="email" class="settings-input" id="team-invite-email" placeholder="teammate@company.com" />' +
      '<select class="settings-input" id="team-invite-role">' + roleOpts('finance_officer') + '</select>' +
      '<button type="button" class="btn-primary" onclick="inviteTeamMember()">' + icon('users') + ' Send invite</button>' +
    '</div>' +
    '<div id="team-invite-result"></div>' +
  '</div>';

  /* Businesses I've joined */
  if (d.memberships && d.memberships.length) {
    html += '<div class="settings-card-head" style="margin-top:1.4rem;"><h3>Businesses you’ve joined</h3></div>';
    html += '<div class="team-members">';
    d.memberships.forEach(function(ms) {
      html += '<div class="team-member-row"><div class="team-member-id"><div class="team-avatar">' + escapeHtml((ms.business_name || 'B').slice(0, 1).toUpperCase()) + '</div>' +
        '<div><div class="team-member-name">' + escapeHtml(ms.business_name) + '</div><div class="team-member-email">You are ' + escapeHtml(ms.role_label) + '</div></div></div>' +
        '<div></div><div>' + statusBadge('active') + '</div><div></div></div>';
    });
    html += '</div>';
  }

  /* Permission matrix reference */
  html += '<div class="settings-card-head" style="margin-top:1.4rem;"><h3>What each role can do</h3></div>';
  html += '<div class="team-matrix-wrap"><table class="team-matrix"><thead><tr><th>Role</th>';
  matrix.permissions.forEach(function(p) { html += '<th>' + escapeHtml(p.label) + '</th>'; });
  html += '</tr></thead><tbody>';
  matrix.roles.forEach(function(r) {
    html += '<tr><td class="team-matrix-role">' + escapeHtml(r.label) + '</td>';
    matrix.permissions.forEach(function(p) {
      var has = r.permissions.indexOf(p.key) !== -1;
      html += '<td>' + (has ? '<span class="team-check text-emerald">' + icon('check-circle') + '</span>' : '<span class="team-dash">—</span>') + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';

  el.innerHTML = html;
}

function inviteTeamMember() {
  var email = document.getElementById('team-invite-email');
  var role = document.getElementById('team-invite-role');
  var out = document.getElementById('team-invite-result');
  if (!email || !email.value.trim()) { showToast('Enter an email to invite.', 'error'); return; }
  fetch('/api/team/invite', {
    method: 'POST', headers: mutatingHeaders(),
    body: JSON.stringify({ email: email.value.trim(), role: role ? role.value : 'finance_officer' })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) {
      showToast('Invite created for ' + d.member.email, 'success');
      if (out && d.invite_link) {
        out.innerHTML = '<div class="team-link-box">' + icon('link') + ' <span class="team-link">' + escapeHtml(d.invite_link) + '</span>' +
          '<button type="button" class="btn-secondary btn-small" onclick="copyInviteLink(\'' + escapeHtml(d.invite_link) + '\')">Copy</button></div>';
      }
      loadTeam();
    } else {
      if (d && d.error === 'upgrade_required') {
        showUpgradeModal(d.message || 'Team collaboration is available on the Growth and Custom Guidance plans.');
        loadTeam();
        return;
      }
      var msg = d && d.error === 'already_on_team' ? 'That email is already on your team.'
        : d && d.error === 'invalid_email' ? 'That email address is not valid.'
        : 'Could not send invite.';
      showToast(msg, 'error');
    }
  }).catch(function() { showToast('Could not send invite.', 'error'); });
}

function changeMemberRole(id, role) {
  fetch('/api/team/member/' + encodeURIComponent(id), {
    method: 'PUT', headers: mutatingHeaders(), body: JSON.stringify({ role: role })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) { showToast('Role updated to ' + role.replace('_', ' '), 'success'); loadTeam(); }
    else { showToast('Could not update role.', 'error'); loadTeam(); }
  }).catch(function() { showToast('Could not update role.', 'error'); });
}

function removeTeamMember(id, name) {
  if (!confirm('Remove ' + name + ' from the team?')) return;
  fetch('/api/team/member/' + encodeURIComponent(id), { method: 'DELETE', headers: csrfHeaders() })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) { showToast('Removed ' + name, 'success'); loadTeam(); }
      else { showToast('Could not remove member.', 'error'); }
    }).catch(function() { showToast('Could not remove member.', 'error'); });
}

function copyInviteLink(link) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(function() { showToast('Invite link copied', 'success'); })
      .catch(function() { showToast('Copy failed — select the link manually.', 'error'); });
  } else { showToast('Copy not supported — select the link manually.', 'info'); }
}

function acceptInviteFromUrl() {
  var params = new URLSearchParams(location.search);
  var token = params.get('invite');
  if (!token) return;
  fetch('/api/team/accept', {
    method: 'POST', headers: mutatingHeaders(), body: JSON.stringify({ token: token })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) {
      showToast('You joined ' + d.business_name + ' as ' + d.role_label, 'success');
    } else if (d && d.error === 'invalid_or_used_invite') {
      showToast('That invite link is invalid or already used.', 'error');
    } else {
      showToast('Could not accept the invite.', 'error');
    }
    /* Strip the token from the URL so a refresh doesn't retry it. */
    params.delete('invite');
    var qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }).catch(function() {});
}

/* ── 10. Initialization ──────────────────────────────────────── */
(function init() {
  /* EACH STEP IS ISOLATED. These ran as a bare sequence, so the first one to
     throw synchronously silently cancelled every step after it — that is how a
     missing helper in loadScoreBands() ended up disabling Google login. A
     startup task that fails should degrade its own feature, not the ones that
     happen to be listed below it. */
  function step(name, fn) {
    try { fn(); } catch (e) {
      console.error('init step failed: ' + name, e);
    }
  }

  // Load the registry's score bands before rendering, so no page paints a
  // score with a client-side threshold.
  step('loadScoreBands', loadScoreBands);
  step('checkOnboarding', checkOnboarding);
  step('handleOauthResultFromUrl', handleOauthResultFromUrl);
  step('acceptInviteFromUrl', acceptInviteFromUrl);
  step('loadNetworks', loadNetworks);
  step('loadEntitlement', loadEntitlement);
  step('loadNotifications', loadNotifications);
  /* Refresh alerts periodically (also triggers a due catch-up sync server-side). */
  setInterval(loadNotifications, 5 * 60 * 1000);

  /* Route on load */
  var initialPage = location.hash.slice(1) || 'overview';
  navigate(initialPage);
})();