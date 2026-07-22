/* ═══════════════════════════════════════════════════════════════
   FinGuard AI — Application Logic
   Premium Dark Dashboard SPA
   ═══════════════════════════════════════════════════════════════ */

/* ── 1. DOM References ───────────────────────────────────────── */
var $pageContent    = document.getElementById('page-content');
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
  currentPage: 'overview',
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
  send:             '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'
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

function scoreBarClass(score) {
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-mid';
  return 'score-low';
}

var MAX_VISIBLE_TOASTS = 3;

function showToast(message, type) {
  type = type || 'info';
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
  rate_limited: 'Your AI provider’s rate limit or quota has been reached. Showing rule-based analysis instead.',
  invalid_api_key: 'Your AI API key was rejected by the provider. Check it in Settings.',
  model_not_found: 'The configured AI model is no longer available from your provider. Try a different provider in Settings, or contact your administrator.',
  insufficient_balance: 'Your AI provider account has run out of prepaid balance. Top up your account, or switch providers in Settings.',
  provider_unavailable: 'Your AI provider is temporarily unavailable. Showing rule-based analysis instead.',
  unparseable_response: 'The AI returned a response we couldn’t parse. Showing rule-based analysis instead.',
  timeout: 'The AI request timed out. Showing rule-based analysis instead.',
  request_failed: 'Could not reach the AI provider. Showing rule-based analysis instead.',
  ai_analysis_disabled: 'AI analysis is disabled on this server.'
};

function notifyAiFailureIfAny(aiAnalysis) {
  if (!aiAnalysis || aiAnalysis.ok || aiAnalysis.reason === 'missing_ai_api_key' || aiAnalysis.reason === 'ai_not_requested') return;
  var message = AI_FAILURE_MESSAGES[aiAnalysis.reason] || ('AI analysis failed (' + aiAnalysis.reason + '). Showing rule-based analysis instead.');
  showToast(message, 'warning');
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

function formatCurrency(amount) {
  if (amount == null || isNaN(amount)) return 'KES 0';
  var num = Number(amount);
  var neg = num < 0;
  num = Math.abs(num);
  var parts = num.toFixed(0).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + 'KES ' + parts[0];
}

function formatPercent(value) {
  if (value == null || isNaN(value)) return '0%';
  return Number(value).toFixed(1) + '%';
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

function renderAiInsightsCard(aiInsights) {
  if (!aiInsights) {
    return '<div class="glass-card ai-insights-card section-gap">' +
      '<div class="card-title">' + icon('bot') + ' AI Insights</div>' +
      '<p class="text-sm text-muted">Connect an AI provider in <a href="#settings" class="text-brand" style="text-decoration:underline;">Settings</a> to unlock AI-written findings for this page.</p>' +
      '</div>';
  }

  var html = '<div class="glass-card ai-insights-card glow-border section-gap">';
  html += '<div class="card-title">' + icon('bot') + ' AI Insights</div>';

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
        '<div class="profile-field"><div class="profile-field-label">AI Provider</div><div class="profile-field-value">' + escapeHtml(p.ai_provider || appState.aiProvider || 'openai') + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">AI Assistant</div><div class="profile-field-value">' + escapeHtml(p.ai_assistant || appState.aiAssistant || 'controller-core') + '</div></div>' +
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
   Alternative to Zoho: parse a bank/accounting CSV export into the
   same shape the risk engine already consumes. ─────────────────── */
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
  html += '<div class="form-group"><label class="settings-label">Bank / Accounting CSV Export</label>';
  html += '<div class="upload-dropzone"><input type="file" accept=".csv,text/csv" id="' + containerId + '-file" /></div>';
  html += '<p class="text-xs text-muted">Needs a date column and either an amount column, or separate debit/credit columns.</p></div>';
  html += '<div class="form-group"><label class="settings-label">Current Cash Balance (optional)</label>';
  html += '<input type="number" class="settings-input" id="' + containerId + '-balance" placeholder="Leave blank to estimate from transactions" /></div>';
  html += '<button type="button" class="btn-primary btn-full" id="' + containerId + '-submit">' + icon('download') + ' Upload &amp; Analyze</button>';
  html += '<div id="' + containerId + '-result"></div>';

  el.innerHTML = html;

  var submitBtn = document.getElementById(containerId + '-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', function() { handleUploadSubmit(containerId, opts); });
  }
}

async function handleUploadSubmit(containerId, opts) {
  opts = opts || {};
  var periodEl = document.getElementById(containerId + '-period');
  var fileEl = document.getElementById(containerId + '-file');
  var balanceEl = document.getElementById(containerId + '-balance');
  var resultEl = document.getElementById(containerId + '-result');

  if (!fileEl.files || !fileEl.files[0]) {
    showToast('Choose a CSV file first.', 'warning');
    return;
  }

  var formData = new FormData();
  formData.append('file', fileEl.files[0]);
  formData.append('period', periodEl.value);
  if (balanceEl.value) formData.append('currentCashBalance', balanceEl.value);

  resultEl.innerHTML = '<div class="loading-shimmer" style="height:60px;margin-top:0.75rem;"></div>';

  try {
    var res = await fetch('/api/financial-data/upload', { method: 'POST', body: formData });
    var data = await res.json();

    if (!data.ok) {
      resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:0.75rem;">' + escapeHtml(data.error || 'Upload failed.') + '</p>';
      return;
    }

    var s = data.summary;
    resultEl.innerHTML =
      '<div class="glass-card" style="margin-top:1rem;padding:1rem;">' +
      '<div class="upload-summary-row"><span>Transactions parsed</span><span>' + s.transaction_count + '</span></div>' +
      '<div class="upload-summary-row"><span>Money in</span><span class="text-emerald">' + formatCurrency(s.inflow) + '</span></div>' +
      '<div class="upload-summary-row"><span>Money out</span><span class="text-red">' + formatCurrency(s.outflow) + '</span></div>' +
      '<div class="upload-summary-row"><span>Net</span><span>' + formatCurrency(s.net_income) + '</span></div>' +
      '</div>';

    showToast('File uploaded — ' + s.transaction_count + ' transactions ready for analysis.', 'success');
    if (opts.onUploaded) opts.onUploaded(data.period);
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

function goToStep2() {
  $onboardStep1.classList.remove('active');
  $onboardStep2.classList.add('active');
  $progStep1.classList.remove('active');
  $progStep1.classList.add('completed');
  $progStep1.querySelector('.step-number').textContent = '✓';
  $progStep2.classList.add('active');
  if ($progConnector1) $progConnector1.classList.add('filled');

  renderWalletConnectCard('onboarding-wallet-panel', {
    allowSkip: true,
    showContinue: true,
    onSkip: function() {
      goToStep3();
      showToast('Wallet skipped — you can add it later in Settings.', 'info');
    },
    onVerified: function(address) {
      appState.walletAddress = address;
      goToStep3();
    }
  });
}

function goToStep3() {
  $onboardStep2.classList.remove('active');
  $onboardStep3.classList.add('active');
  $progStep2.classList.remove('active');
  $progStep2.classList.add('completed');
  $progStep2.querySelector('.step-number').textContent = '✓';
  $progStep3.classList.add('active');
  if ($progConnector2) $progConnector2.classList.add('filled');

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
    headers: { 'Content-Type': 'application/json' },
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

/* ── 7. Router ───────────────────────────────────────────────── */
var routes = {
  'overview':         { title: 'Controller Overview',   render: renderOverview },
  'financial-health': { title: 'Financial Health',      render: renderFinancialHealth },
  'cashflow':         { title: 'Cash Flow',             render: renderCashFlow },
  'revenue':          { title: 'Revenue Intelligence',  render: renderRevenueIntelligence },
  'risk':             { title: 'Risk & Anomalies',      render: renderRiskAnomalies },
  'vendors':          { title: 'Vendors',               render: renderVendors },
  'customers':        { title: 'Customers',             render: renderCustomers },
  'actions':          { title: 'Action Center',         render: renderActionCenter },
  'reports':          { title: 'Executive Reports',     render: renderExecutiveReports },
  'contracts':        { title: 'Contracts',             render: renderContracts },
  'ai-controller':    { title: 'FinGuard AI',         render: renderAIController },
  'settings':         { title: 'Settings',              render: renderSettings }
};

function navigate(page) {
  if (!routes[page]) page = 'overview';
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
async function fetchPageData(endpoint) {
  try {
    var response = await fetch('/api/' + endpoint);
    if (!response.ok) return null;
    var json = await response.json();
    if (!json.ok) return null;
    return json;
  } catch (e) {
    return null;
  }
}

async function runMonthlyReview(month) {
  appState.activeMonth = month;
  $analysisMonth.innerHTML = icon('clock') + ' Analyzing ' + escapeHtml(getMonthLabel(month)) + '…';
  showStatus('Running monthly review…');
  appState.isLoading = true;

  /* Update month picker active state */
  var btns = document.querySelectorAll('.month-btn');
  btns.forEach(function(btn) {
    if (btn.getAttribute('data-month') === month) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  try {
    var res = await fetch('/api/monthly-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: month })
    });
    var data = await res.json();

    if (data.ok) {
      appState.cachedData = data;
      $analysisMonth.innerHTML = icon('calendar') + ' ' + escapeHtml(getMonthLabel(month));
      showToast('Analysis complete for ' + getMonthLabel(month), 'success');
      notifyAiFailureIfAny(data.aiAnalysis);
    } else {
      showToast('Analysis failed: ' + (data.error || 'Unknown error'), 'error');
      $analysisMonth.innerHTML = icon('x-circle') + ' Failed';
    }
  } catch (e) {
    showToast('Connection error during analysis.', 'error');
    $analysisMonth.innerHTML = icon('x-circle') + ' Error';
  }

  appState.isLoading = false;
  showStatus('');

  /* Re-render current page */
  if (routes[appState.currentPage]) {
    routes[appState.currentPage].render();
  }
}

/* ── 9. Page Renderers ───────────────────────────────────────── */

/* ── Overview ────────────────────────────────────────────────── */
function renderOverview() {
  var months = generateRecentMonths(12);
  var monthGrid = '<div class="glass-card section-gap"><div class="card-title">Select Analysis Month</div><div class="month-picker-grid">';
  months.forEach(function(m) {
    var isActive = appState.activeMonth === m ? ' active' : '';
    monthGrid += '<button class="month-btn' + isActive + '" data-month="' + m + '" onclick="runMonthlyReview(\'' + m + '\')">' + getMonthLabel(m) + '</button>';
  });
  monthGrid += '</div></div>';

  var d = appState.cachedData;

  if (!d) {
    $pageContent.innerHTML = monthGrid + renderEmptyState('calendar', 'No Month Selected', 'Select a target month above to begin your financial analysis.');
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

  var html = monthGrid;

  /* KPI Row */
  html += '<div class="kpi-row">';
  html += '<div class="kpi-card"><div class="kpi-label">Health Score</div><div class="kpi-value ' + (!hasHealthScore ? 'text-muted' : healthScore >= 70 ? 'text-emerald' : healthScore >= 40 ? 'text-amber' : 'text-red') + '">' + healthScore + '<span class="text-muted text-sm">/100</span></div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Current Risk Level</div><div class="kpi-value ' + (String(riskLevel).toLowerCase() === 'high' ? 'text-red' : String(riskLevel).toLowerCase() === 'medium' ? 'text-amber' : 'text-emerald') + '">' + escapeHtml(String(riskLevel)) + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Cash Runway</div><div class="kpi-value">' + cashRunway + ' <span class="text-muted text-sm">days</span></div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Revenue Trend</div><div class="kpi-value">' + revTrend + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Critical Findings</div><div class="kpi-value ' + (riskCount > 3 ? 'text-red' : 'text-amber') + '">' + riskCount + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Pending Actions</div><div class="kpi-value ' + (pendingActions > 0 ? 'text-amber' : 'text-emerald') + '">' + pendingActions + '</div></div>';
  html += '</div>';

  /* Critical Findings + AI Summary */
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
      ? 'Connect an AI provider in Settings for richer AI-written analysis.'
      : escapeHtml(AI_FAILURE_MESSAGES[aiAnalysis.reason] || ('AI analysis failed (' + aiAnalysis.reason + '). Showing rule-based analysis instead.'));
    aiSummaryBody = '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(typeof ai === 'string' ? ai : JSON.stringify(ai, null, 2)) + '</p>' +
      '<p class="text-xs text-muted" style="margin-top:0.75rem;">' + fallbackHint + '</p>' +
      '<button type="button" class="btn-secondary btn-small" style="margin-top:0.6rem;" onclick="navigate(\'settings\')">' + icon('settings') + ' Switch AI provider</button>';
  } else {
    aiSummaryBody = '<p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(typeof ai === 'string' ? ai : JSON.stringify(ai, null, 2)) + '</p>';
  }

  html += '<div class="grid-2col">';
  html += '<div class="glass-card"><div class="card-title">Critical Findings</div>' + renderFindingsList(criticalFindings) + '</div>';
  html += '<div class="glass-card glow-border"><div class="card-title">' + icon('bot') + ' FinGuard AI Summary</div>' + aiSummaryBody + '</div>';
  html += '</div>';

  /* Cash Flow Forecast */
  if (cashflow.net_cash_flow != null || cashflow.monthly_burn != null) {
    html += '<div class="glass-card section-gap">';
    html += '<div class="card-title">Cash Flow Snapshot</div>';
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Net Cash Flow</div><div class="kpi-value">' + formatCurrency(cashflow.net_cash_flow || 0) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Monthly Burn</div><div class="kpi-value">' + formatCurrency(cashflow.monthly_burn || cashflow.burn_rate || 0) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Liquidity Ratio</div><div class="kpi-value">' + (cashflow.liquidity_ratio || '—') + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Receivables</div><div class="kpi-value">' + formatCurrency(cashflow.total_receivables || 0) + '</div></div>';
    html += '</div></div>';
  }

  /* Fraud Watch + Expenses */
  var hasFraud = Array.isArray(fraud) && fraud.length > 0;
  var hasExpenses = Array.isArray(expenses) && expenses.length > 0;
  if (hasFraud || hasExpenses) {
    html += '<div class="grid-2col">';
    if (hasFraud) {
      html += '<div class="glass-card"><div class="card-title">' + icon('search') + ' Fraud Watch</div>' + renderFindingsList(fraud) + '</div>';
    }
    if (hasExpenses) {
      html += '<div class="glass-card"><div class="card-title">' + icon('pie-chart') + ' Expense Breakdown</div>';
      expenses.forEach(function(exp) {
        var label = exp.category || exp.name || 'Unknown';
        var pct = exp.percentage || exp.pct || 0;
        html += '<div class="concentration-bar">' +
          '<div class="concentration-bar-label"><span>' + escapeHtml(label) + '</span><span>' + formatPercent(pct) + '</span></div>' +
          '<div class="concentration-bar-track"><div class="concentration-bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
        '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  $pageContent.innerHTML = html;
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
    var overall = h.overall_score || h.score || 0;
    var category = h.risk_category || h.category || 'Unknown';
    var components = h.component_scores || h.components || {};
    var trend = h.trend_note || h.trend || '';

    var categoryColor = category.toLowerCase().includes('low') ? 'text-emerald' :
                        category.toLowerCase().includes('high') ? 'text-red' : 'text-amber';

    var html = '<div class="grid-2-1">';

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
        var val = typeof components[key] === 'object' ? (components[key].score || 0) : components[key];
        var label = key.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
        html += '<div class="score-bar-container">';
        html += '<div class="score-bar-label"><span>' + escapeHtml(label) + '</span><span>' + val + '/100</span></div>';
        html += '<div class="score-bar-track"><div class="score-bar-fill ' + scoreBarClass(val) + '" style="width:' + val + '%"></div></div>';
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
    var runway = cf.runway_days || cf.cash_runway || '—';
    var netCF = cf.net_cash_flow || 0;
    var burn = cf.monthly_burn || cf.burn_rate || 0;
    var liquidity = cf.liquidity_ratio || '—';
    var findings = cf.findings || [];
    var recommendations = cf.recommendations || [];

    var html = '';

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
    html += '<div class="kpi-card"><div class="kpi-label">Cash Runway</div><div class="kpi-value ' + (runway < 30 ? 'text-red' : runway < 60 ? 'text-amber' : 'text-emerald') + '">' + runway + ' <span class="text-muted text-sm">days</span></div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Net Cash Flow</div><div class="kpi-value ' + (netCF >= 0 ? 'text-emerald' : 'text-red') + '">' + formatCurrency(netCF) + '</div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Monthly Burn</div><div class="kpi-value">' + formatCurrency(burn) + '</div></div>';
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
    html += '<div class="kpi-card"><div class="kpi-label">Growth Rate</div><div class="kpi-value ' + (growth >= 0 ? 'text-emerald' : 'text-red') + '">' + (growth != null ? formatPercent(growth) : '—') + '</div></div>';
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
      html += '<table class="data-table"><thead><tr><th>Type</th><th>Severity</th><th>Description</th></tr></thead><tbody>';
      items.forEach(function(item) {
        html += '<tr>';
        html += '<td>' + escapeHtml(item.type || item.category || '—') + '</td>';
        html += '<td><span class="' + severityClass(item.severity) + '">' + escapeHtml(item.severity || '—') + '</span></td>';
        html += '<td>' + escapeHtml(item.description || item.text || item.message || '—') + '</td>';
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
    var riskScore = v.vendor_risk_score || v.risk_score || '—';
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
    html += '<div class="kpi-card"><div class="kpi-label">Vendor Risk Score</div><div class="kpi-value ' + (riskScore >= 70 ? 'text-emerald' : riskScore >= 40 ? 'text-amber' : 'text-red') + '">' + riskScore + '<span class="text-muted text-sm">/100</span></div></div>';
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
    var riskScore = c.customer_risk_score || c.risk_score || '—';
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
    html += '<div class="kpi-card"><div class="kpi-label">Customer Risk Score</div><div class="kpi-value ' + (riskScore >= 70 ? 'text-emerald' : riskScore >= 40 ? 'text-amber' : 'text-red') + '">' + riskScore + '<span class="text-muted text-sm">/100</span></div></div>';
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

    /* Export buttons */
    html += '<div style="display:flex;gap:0.75rem;margin-bottom:1.25rem;">';
    html += '<button class="btn-small" onclick="exportActions(\'csv\')">' + icon('download') + ' Export CSV</button>';
    html += '<button class="btn-small" onclick="exportActions(\'json\')">' + icon('download') + ' Export JSON</button>';
    html += '</div>';

    /* Actions table */
    if (actions.length > 0) {
      html += '<div class="glass-card">';
      html += '<table class="data-table"><thead><tr><th>Priority</th><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>';
      actions.forEach(function(action) {
        var priority = action.priority || 'medium';
        html += '<tr>';
        html += '<td><span class="' + severityClass(priority) + '">' + escapeHtml(priority) + '</span></td>';
        html += '<td>' + escapeHtml(action.task || action.description || action.title || '—') + '</td>';
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

/* Export helper */
function exportActions(format) {
  fetchPageData('actions').then(function(data) {
    if (!data) { showToast('No data to export.', 'warning'); return; }
    var actions = data.actions || data.tasks || data.data || [];

    if (format === 'json') {
      var blob = new Blob([JSON.stringify(actions, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'actions.json');
    } else {
      var csv = 'Priority,Task,Owner,Due,Status\n';
      actions.forEach(function(a) {
        csv += '"' + (a.priority || '') + '","' + (a.task || a.description || '') + '","' + (a.owner || '') + '","' + (a.due || a.due_date || '') + '","' + (a.status || '') + '"\n';
      });
      var blob = new Blob([csv], { type: 'text/csv' });
      downloadBlob(blob, 'actions.csv');
    }
    showToast('Export downloaded!', 'success');
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
    html += '<button class="btn-primary" onclick="generateReport(\'' + rt.id + '\')">Generate Report</button>';
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_type: reportType })
    });
    var data = await res.json();

    if (data.ok) {
      var content = data.report || data.content || data.text || JSON.stringify(data.data, null, 2);
      resultEl.innerHTML = '<div class="report-result">' + escapeHtml(content) + '</div>';
      showToast('Report generated successfully!', 'success');
    } else {
      resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:1rem;">Failed: ' + escapeHtml(data.error || 'Unknown error') + '</p>';
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="text-red text-sm" style="margin-top:1rem;">Connection error.</p>';
  }
}

/* ── FinGuard AI (Chat) ────────────────────────────────────── */
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
  html += '<div class="text-sm text-muted">Assistant: <strong>' + escapeHtml(appState.aiAssistant) + '</strong> via <strong>' + escapeHtml(appState.aiProvider) + '</strong> · Skill-first processing</div>';
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
    html += '<div class="empty-state" style="flex:1"><div class="empty-state-icon">' + icon('bot', { cls: 'icon-xl' }) + '</div><div class="empty-state-title">FinGuard AI</div><div class="empty-state-text">Ask me anything about your finances. I have full context from your latest analysis.</div></div>';
  } else {
    appState.chatHistory.forEach(function(msg) {
      html += renderChatMessage(msg.role, msg.content);
    });
  }
  html += '</div>';

  /* Input bar */
  html += '<div class="chat-input-wrapper">';
  html += '<input type="text" class="chat-input" id="chat-input" placeholder="Ask the FinGuard AI…" onkeydown="if(event.key===\'Enter\')sendChat()" />';
  html += '<button class="btn-primary" onclick="sendChat()">Send ' + icon('send') + '</button>';
  html += '</div>';

  html += '</div>';

  $pageContent.innerHTML = html;

  /* Scroll to bottom */
  var feed = document.getElementById('chat-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function renderChatMessage(role, content) {
  var isUser = role === 'user';
  var avatarIcon = icon(isUser ? 'user' : 'bot');
  return '<div class="chat-msg ' + (isUser ? 'user' : 'ai') + '">' +
    '<div class="chat-msg-avatar">' + avatarIcon + '</div>' +
    '<div class="chat-msg-bubble">' + escapeHtml(content) + '</div>' +
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

async function sendChat() {
  var input = document.getElementById('chat-input');
  var feed = document.getElementById('chat-feed');
  if (!input || !feed) return;

  var message = input.value.trim();
  if (!message) return;

  /* Clear empty state */
  var emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  /* Add user message */
  appState.chatHistory.push({ role: 'user', content: message });
  feed.insertAdjacentHTML('beforeend', renderChatMessage('user', message));
  input.value = '';
  feed.scrollTop = feed.scrollHeight;

  /* Show typing indicator */
  var typingId = 'typing-' + Date.now();
  feed.insertAdjacentHTML('beforeend', '<div id="' + typingId + '" class="chat-msg ai"><div class="chat-msg-avatar">' + icon('bot') + '</div><div class="chat-msg-bubble" style="animation:pulse 1s infinite">Thinking…</div></div>');
  feed.scrollTop = feed.scrollHeight;

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        history: appState.chatHistory.slice(-10),
        ai_provider: appState.aiProvider,
        ai_assistant: appState.aiAssistant
      })
    });
    var data = await res.json();

    /* Remove typing indicator */
    var typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    var reply = data.reply || data.response || data.message || data.answer || 'No response received.';
    appState.chatHistory.push({ role: 'ai', content: reply });
    feed.insertAdjacentHTML('beforeend', renderChatMessage('ai', reply));
    feed.scrollTop = feed.scrollHeight;
    notifyAiFailureIfAny(data.context && data.context.ai_error ? { ok: false, reason: data.context.ai_error } : null);
  } catch (e) {
    var typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    var errMsg = 'Sorry, I couldn\'t connect to the AI service. Please try again.';
    appState.chatHistory.push({ role: 'ai', content: errMsg });
    feed.insertAdjacentHTML('beforeend', renderChatMessage('ai', errMsg));
    feed.scrollTop = feed.scrollHeight;
  }
}

/* ── Settings ────────────────────────────────────────────────── */
function renderContracts() {
  var html = '';

  html += '<div id="contracts-wallet-panel" class="section-gap"></div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Network &amp; Balance</div>';
  html += '<div id="contracts-network-panel"></div>';
  html += '</div>';

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

  var template = (appState.contractTemplates || []).find(function(t) { return t.id === templateId; });
  if (!template) {
    showToast('Template not found.', 'error');
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
    var deployment = await FinGuardWallet.deployTemplate(template, []);

    if (statusEl) {
      statusEl.innerHTML = '<div class="deploy-status"><div class="loading-shimmer" style="height:44px"></div>' +
        '<p class="text-sm text-muted" style="margin-top:0.5rem;">Waiting for confirmation on-chain…' +
        (net ? ' <a href="' + net.explorerUrl + '/tx/' + deployment.txHash + '" target="_blank" rel="noopener">View transaction</a>' : '') +
        '</p></div>';
    }

    var result = await deployment.wait();

    if (statusEl) {
      statusEl.innerHTML = '<div class="deploy-status deploy-status-success">' +
        '<div class="text-emerald" style="display:flex;align-items:center;gap:0.4rem;font-weight:600;">' +
        icon('check-circle') + ' Deployed!</div>' +
        '<div class="wallet-address-chip" style="margin-top:0.5rem;">' + result.address + '</div>' +
        (net ? '<a href="' + net.explorerUrl + '/address/' + result.address + '" target="_blank" rel="noopener" class="text-sm text-brand">View on block explorer →</a>' : '') +
        '</div>';
    }

    showToast(template.label + ' deployed successfully!', 'success');

    fetch('/api/avalanche/contracts/deployments/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: template.id,
        contractName: template.contract_name,
        contractAddress: result.address,
        txHash: deployment.txHash,
        chainId: w.chainId,
        deployerAddress: w.address
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

function renderSettings() {
  var html = '<div class="grid-2col">';

  /* Left column */
  html += '<div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Business Profile</div>';
  html += '<div class="settings-group"><label class="settings-label">Name</label><input type="text" class="settings-input" id="settings-name" value="' + escapeHtml(appState.userName) + '" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Company</label><input type="text" class="settings-input" id="settings-company" value="' + escapeHtml(appState.businessName) + '" /></div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Zoho Books</div>';
  html += '<div id="settings-zoho-panel"></div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Avalanche Wallet</div>';
  html += '<div id="settings-wallet-panel"></div>';
  html += '</div>';

  html += '</div>';

  /* Right column */
  html += '<div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">AI API &amp; Assistant</div>';
  html += '<div class="settings-group"><label class="settings-label">AI Provider</label>' +
    '<select class="settings-input" id="settings-ai-provider">' +
      '<option value="openai"' + (appState.aiProvider === 'openai' ? ' selected' : '') + '>OpenAI</option>' +
      '<option value="anthropic"' + (appState.aiProvider === 'anthropic' ? ' selected' : '') + '>Anthropic (Claude)</option>' +
      '<option value="google"' + (appState.aiProvider === 'google' ? ' selected' : '') + '>Google (Gemini)</option>' +
      '<option value="deepseek"' + (appState.aiProvider === 'deepseek' ? ' selected' : '') + '>DeepSeek</option>' +
      '<option value="grok"' + (appState.aiProvider === 'grok' ? ' selected' : '') + '>Grok (xAI)</option>' +
      '<option value="nvidia"' + (appState.aiProvider === 'nvidia' ? ' selected' : '') + '>NVIDIA NIM</option>' +
      '<option value="azure-openai"' + (appState.aiProvider === 'azure-openai' ? ' selected' : '') + '>Azure OpenAI</option>' +
      '<option value="custom"' + (appState.aiProvider === 'custom' ? ' selected' : '') + '>Custom</option>' +
    '</select></div>';
  var aiKeyPlaceholder = appState.aiApiKeyConfigured
    ? 'Saved — leave blank to keep, or enter a new key to replace it'
    : 'Enter AI API Key';
  html += '<div class="settings-group"><label class="settings-label">AI API Key</label><input type="password" class="settings-input" id="settings-ai-api-key" value="" placeholder="' + escapeHtml(aiKeyPlaceholder) + '" autocomplete="off" /><div id="ai-key-hint" class="text-xs text-muted" style="margin-top:0.4rem;"></div>';
  if (appState.aiApiKeyConfigured && appState.aiApiKeyPreview) {
    html += '<div class="text-xs text-emerald" style="margin-top:0.35rem;">' + icon('check-circle') + ' Currently saved: <span class="mono">' + escapeHtml(appState.aiApiKeyPreview) + '</span></div>';
  }
  html += '</div>';
  html += '<div class="settings-group"><label class="settings-label">AI Assistant</label>' +
    '<select class="settings-input" id="settings-ai-assistant">' +
      '<option value="controller-core"' + (appState.aiAssistant === 'controller-core' ? ' selected' : '') + '>Controller Core</option>' +
      '<option value="risk-analyst"' + (appState.aiAssistant === 'risk-analyst' ? ' selected' : '') + '>Risk Analyst</option>' +
      '<option value="cashflow-guardian"' + (appState.aiAssistant === 'cashflow-guardian' ? ' selected' : '') + '>Cashflow Guardian</option>' +
      '<option value="executive-brief"' + (appState.aiAssistant === 'executive-brief' ? ' selected' : '') + '>Executive Brief</option>' +
    '</select></div>';
  html += '<div class="text-sm text-muted">This assistant routes requests through financial skills first, then formats responses in your selected assistant style.</div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Risk Thresholds</div>';
  html += '<div class="settings-group"><label class="settings-label">Runway Warning (days)</label><input type="number" class="settings-input" id="settings-runway" value="30" min="1" max="365" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Concentration Threshold (%)</label><input type="number" class="settings-input" id="settings-concentration" value="40" min="1" max="100" /></div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">Notification Settings</div>';
  html += '<div class="settings-group"><label class="settings-label">Alert Email</label><input type="email" class="settings-input" id="settings-email" placeholder="alerts@company.com" /></div>';
  html += '</div>';

  html += '<div class="glass-card section-gap">';
  html += '<div class="card-title">User Management</div>';
  html += '<div class="settings-group"><label class="settings-label">Primary User Role</label><input type="text" class="settings-input" value="Owner / Admin" readonly /></div>';
  html += '<div class="settings-group"><label class="settings-label">Access Review</label><input type="text" class="settings-input" value="Review quarterly" readonly /></div>';
  html += '</div>';

  html += '</div>';
  html += '</div>';

  html += '<div style="display:flex;gap:0.75rem;">';
  html += '<button class="btn-primary" onclick="saveSettings()">' + icon('save') + ' Save Settings</button>';
  html += '</div>';

  $pageContent.innerHTML = html;
  renderWalletConnectCard('settings-wallet-panel', { compact: true, showDisconnect: true });
  renderZohoPanel('settings-zoho-panel');

  var aiProviderSelect = document.getElementById('settings-ai-provider');
  if (aiProviderSelect) {
    updateAiKeyHint(aiProviderSelect.value);
    aiProviderSelect.addEventListener('change', function() { updateAiKeyHint(this.value); });
  }
}

var AI_KEY_LINKS = {
  openai: { url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com' },
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com' },
  google: { url: 'https://aistudio.google.com/apikey', label: 'aistudio.google.com' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', label: 'platform.deepseek.com' },
  grok: { url: 'https://console.x.ai/team/default/api-keys', label: 'console.x.ai' },
  nvidia: { url: 'https://build.nvidia.com', label: 'build.nvidia.com (free credits, no card)' }
};

function updateAiKeyHint(provider) {
  var hintEl = document.getElementById('ai-key-hint');
  if (!hintEl) return;
  var link = AI_KEY_LINKS[provider];
  if (link) {
    hintEl.innerHTML = 'Get a key from <a href="' + link.url + '" target="_blank" rel="noopener" class="text-brand">' + link.label + '</a>';
  } else {
    hintEl.textContent = 'Enter the API key for your configured endpoint.';
  }
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
        await fetch('/api/oauth/zoho/disconnect', { method: 'POST' });
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = await res.json();

    if (data.ok) {
      showToast(dryRun ? 'Dry run completed.' : 'Deployment submitted.', 'success');
      resultEl.innerHTML = '<pre class="json-block">' + prettyJson(data) + '</pre>';
    } else {
      showToast('Deploy failed: ' + (data.message || data.error || 'Unknown error'), 'error');
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
  var aiProvider = document.getElementById('settings-ai-provider').value;
  var aiApiKey = document.getElementById('settings-ai-api-key').value.trim();
  var aiAssistant = document.getElementById('settings-ai-assistant').value;

  try {
    var res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        business_name: company,
        ai_provider: aiProvider,
        ai_api_key: aiApiKey,
        ai_assistant: aiAssistant
      })
    });
    var data = await res.json();
    if (data.ok) {
      appState.userName = name;
      appState.businessName = company;
      appState.aiProvider = aiProvider;
      appState.aiAssistant = aiAssistant;
      if (aiApiKey) appState.aiApiKeyConfigured = true;
      $companyContext.textContent = 'Company: ' + company;
      showToast(aiApiKey ? 'Settings saved — AI API key stored.' : 'Settings saved successfully!', 'success');

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
      showToast('Save failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Connection error. Please try again.', 'error');
  }
}

/* ── 10. Initialization ──────────────────────────────────────── */
(function init() {
  checkOnboarding();
  handleOauthResultFromUrl();
  loadNetworks();

  /* Route on load */
  var initialPage = location.hash.slice(1) || 'overview';
  navigate(initialPage);
})();