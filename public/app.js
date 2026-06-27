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
var $btnDemo        = document.getElementById('btn-demo-mode');
var $onboardStep1   = document.getElementById('onboard-step-1');
var $onboardStep2   = document.getElementById('onboard-step-2');
var $progStep1      = document.getElementById('prog-step-1');
var $progStep2      = document.getElementById('prog-step-2');
var $progressConn   = document.querySelector('.progress-connector');
var $btnConnWallet  = document.getElementById('btn-connect-wallet');
var $btnSkipWallet  = document.getElementById('btn-skip-wallet');
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
  aiProvider: 'openai',
  aiApiKey: '',
  aiAssistant: 'controller-core',
  chatHistory: [],
  currentPage: 'overview',
  isLoading: false
};

/* ── 3. Utilities ────────────────────────────────────────────── */
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

function showToast(message, type) {
  type = type || 'info';
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.innerHTML =
    '<span>' + escapeHtml(message) + '</span>' +
    '<button class="toast-dismiss" onclick="dismissToast(this)">&times;</button>';
  $toastContainer.appendChild(toast);
  setTimeout(function() {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 5000);
}

function dismissToast(btn) {
  var toast = btn.closest('.toast');
  if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
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

function renderEmptyState(icon, title, text) {
  return '<div class="empty-state">' +
    '<div class="empty-state-icon">' + (icon || '📊') + '</div>' +
    '<div class="empty-state-title">' + escapeHtml(title || 'No Data Yet') + '</div>' +
    '<div class="empty-state-text">' + escapeHtml(text || 'Select a target month from Controller Overview to begin analysis.') + '</div>' +
  '</div>';
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
      $profileContent.innerHTML =
        '<div class="profile-field"><div class="profile-field-label">Name</div><div class="profile-field-value">' + escapeHtml(p.name || appState.userName) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Company</div><div class="profile-field-value">' + escapeHtml(p.business_name || appState.businessName) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Zoho</div><div class="profile-field-value">' + (p.zoho_connected ? '✅ Connected' : '❌ Not connected') + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">Wallet</div><div class="profile-field-value text-sm">' + escapeHtml(maskWalletAddress(p.wallet_address)) + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">AI Provider</div><div class="profile-field-value">' + escapeHtml(p.ai_provider || appState.aiProvider || 'openai') + '</div></div>' +
        '<div class="profile-field"><div class="profile-field-label">AI Assistant</div><div class="profile-field-value">' + escapeHtml(p.ai_assistant || appState.aiAssistant || 'controller-core') + '</div></div>';

      appState.aiProvider = p.ai_provider || appState.aiProvider;
      appState.aiAssistant = p.ai_assistant || appState.aiAssistant;
      appState.aiApiKey = p.ai_api_key || appState.aiApiKey;
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
async function checkOnboarding() {
  $signupOverlay.classList.remove('hidden');

  try {
    var res = await fetch('/api/profile');
    var data = await res.json();
    if (data.ok && data.profile && data.profile.business_name) {
      appState.userName = data.profile.name || appState.userName;
      appState.businessName = data.profile.business_name || appState.businessName;
      appState.zohoApiKey = data.profile.zoho_api_key || '';
      appState.zohoOrgId = data.profile.zoho_org_id || '';
      appState.walletAddress = data.profile.wallet_address || '';
      appState.aiProvider = data.profile.ai_provider || appState.aiProvider;
      appState.aiAssistant = data.profile.ai_assistant || appState.aiAssistant;
      appState.aiApiKey = data.profile.ai_api_key || '';

      var nameInput = document.getElementById('input-name');
      var companyInput = document.getElementById('input-company');
      var zohoOrgInput = document.getElementById('input-zoho-org');
      var zohoInput = document.getElementById('input-zoho');
      var walletInput = document.getElementById('input-wallet');

      if (nameInput) nameInput.value = appState.userName || '';
      if (companyInput) companyInput.value = appState.businessName || '';
      if (zohoOrgInput) zohoOrgInput.value = appState.zohoOrgId || '';
      if (zohoInput) zohoInput.value = appState.zohoApiKey || '';
      if (walletInput) walletInput.value = appState.walletAddress || '';

      $companyContext.textContent = 'Company: ' + appState.businessName;
    }
  } catch (e) { /* continue to show signup */ }
}

/* ── Wizard: Step Navigation Helper ──────────────────────────── */
function goToStep2() {
  $onboardStep1.classList.remove('active');
  $onboardStep2.classList.add('active');
  $progStep1.classList.remove('active');
  $progStep1.classList.add('completed');
  $progStep1.querySelector('.step-number').textContent = '✓';
  $progStep2.classList.add('active');
  if ($progressConn) $progressConn.classList.add('filled');
}

function completeOnboarding(walletAddr) {
  appState.walletAddress = walletAddr || '';
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

/* ── Step 1: Continue with Zoho Books ────────────────────────── */
$signupForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  var name = document.getElementById('input-name').value.trim();
  var company = document.getElementById('input-company').value.trim();
  var zohoOrg = document.getElementById('input-zoho-org').value.trim();
  var zoho = document.getElementById('input-zoho').value.trim();

  if (!name || !company) {
    showToast('Name and company are required.', 'warning');
    return;
  }

  // Store Step 1 data
  appState.userName = name;
  appState.businessName = company;
  appState.zohoApiKey = zoho;
  appState.zohoOrgId = zohoOrg;

  showToast('Zoho Books connected! Now link your wallet.', 'success');
  goToStep2();
});

if ($btnZohoOauth) {
  $btnZohoOauth.addEventListener('click', function() {
    var name = document.getElementById('input-name').value.trim();
    var company = document.getElementById('input-company').value.trim();
    var zohoOrg = document.getElementById('input-zoho-org').value.trim();

    if (!name || !company) {
      showToast('Name and company are required before OAuth.', 'warning');
      return;
    }

    appState.userName = name;
    appState.businessName = company;
    appState.zohoOrgId = zohoOrg;

    var oauthUrl = '/api/oauth/zoho/start?name=' + encodeURIComponent(name)
      + '&business_name=' + encodeURIComponent(company)
      + '&zoho_org_id=' + encodeURIComponent(zohoOrg || '');

    window.location.href = oauthUrl;
  });
}

function handleOauthResultFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var oauth = params.get('oauth');
  if (!oauth) return;

  if (oauth === 'success') {
    showToast('Zoho OAuth connected successfully.', 'success');
    goToStep2();
  } else if (oauth === 'not_configured') {
    showToast('Zoho OAuth is not configured on the server.', 'warning');
  } else {
    var reason = params.get('reason') || 'unknown_error';
    showToast('Zoho OAuth failed: ' + reason, 'error');
  }

  var newUrl = window.location.pathname + window.location.hash;
  history.replaceState(null, '', newUrl);
}

/* ── Step 2: Connect Core Wallet ─────────────────────────────── */
$btnConnWallet.addEventListener('click', function() {
  var wallet = document.getElementById('input-wallet').value.trim();
  if (!wallet) {
    showToast('Please enter a wallet address or skip.', 'warning');
    return;
  }
  if (!wallet.startsWith('0x') || wallet.length < 10) {
    showToast('Enter a valid Avalanche C-Chain address (0x…).', 'warning');
    return;
  }
  showToast('Core Wallet connected!', 'success');
  completeOnboarding(wallet);
});

$btnSkipWallet.addEventListener('click', function() {
  completeOnboarding('');
  showToast('Wallet skipped — you can add it later in Settings.', 'info');
});

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
  $analysisMonth.textContent = '⏳ Analyzing ' + getMonthLabel(month) + '…';
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
      $analysisMonth.textContent = '📅 ' + getMonthLabel(month);
      showToast('Analysis complete for ' + getMonthLabel(month), 'success');
    } else {
      showToast('Analysis failed: ' + (data.error || 'Unknown error'), 'error');
      $analysisMonth.textContent = '❌ Failed';
    }
  } catch (e) {
    showToast('Connection error during analysis.', 'error');
    $analysisMonth.textContent = '❌ Error';
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
    $pageContent.innerHTML = monthGrid + renderEmptyState('📅', 'No Month Selected', 'Select a target month above to begin your financial analysis.');
    return;
  }

  var review = d.review || d.data || d;
  var health = review.health_score || review.healthScore || {};
  var cashflow = review.cashflow || review.cash_flow || {};
  var risk = review.risk || review.anomalies || {};
  var revenue = review.revenue || {};
  var ai = review.ai_summary || review.controller_summary || review.summary || '';
  var fraud = review.fraud || review.fraud_watch || [];
  var expenses = review.expenses || review.expense_breakdown || [];

  var healthScore = health.overall_score || health.score || '—';
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
  html += '<div class="kpi-card"><div class="kpi-label">Health Score</div><div class="kpi-value ' + (healthScore >= 70 ? 'text-emerald' : healthScore >= 40 ? 'text-amber' : 'text-red') + '">' + healthScore + '<span class="text-muted text-sm">/100</span></div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Current Risk Level</div><div class="kpi-value ' + (String(riskLevel).toLowerCase() === 'high' ? 'text-red' : String(riskLevel).toLowerCase() === 'medium' ? 'text-amber' : 'text-emerald') + '">' + escapeHtml(String(riskLevel)) + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Cash Runway</div><div class="kpi-value">' + cashRunway + ' <span class="text-muted text-sm">days</span></div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Revenue Trend</div><div class="kpi-value">' + revTrend + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Critical Findings</div><div class="kpi-value ' + (riskCount > 3 ? 'text-red' : 'text-amber') + '">' + riskCount + '</div></div>';
  html += '<div class="kpi-card"><div class="kpi-label">Pending Actions</div><div class="kpi-value ' + (pendingActions > 0 ? 'text-amber' : 'text-emerald') + '">' + pendingActions + '</div></div>';
  html += '</div>';

  /* Critical Findings + AI Summary */
  html += '<div class="grid-2col">';
  html += '<div class="glass-card"><div class="card-title">Critical Findings</div>' + renderFindingsList(criticalFindings) + '</div>';
  html += '<div class="glass-card glow-border"><div class="card-title">🤖 FinGuard AI Summary</div><p class="text-sm" style="line-height:1.7;white-space:pre-wrap;">' + escapeHtml(typeof ai === 'string' ? ai : JSON.stringify(ai, null, 2)) + '</p></div>';
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
      html += '<div class="glass-card"><div class="card-title">🔍 Fraud Watch</div>' + renderFindingsList(fraud) + '</div>';
    }
    if (hasExpenses) {
      html += '<div class="glass-card"><div class="card-title">💸 Expense Breakdown</div>';
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
      $pageContent.innerHTML = renderEmptyState('📊', 'No Health Data', 'Select a target month from Controller Overview to begin analysis.');
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

    $pageContent.innerHTML = html;
  });
}

/* ── Cash Flow ───────────────────────────────────────────────── */
function renderCashFlow() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('cashflow').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('💰', 'No Cash Flow Data', 'Select a target month from Controller Overview to begin analysis.');
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
      html += '<div class="callout-warning"><div class="callout-warning-icon">⚠️</div><div class="callout-warning-text">Cash runway is below 30 days (' + runway + ' days). Immediate attention required.</div></div>';
    }

    var overdueReceivables = cf.overdue_receivables || cf.overdue_amount || 0;
    if (overdueReceivables > 0) {
      html += '<div class="callout-warning"><div class="callout-warning-icon">⚠️</div><div class="callout-warning-text">Overdue receivables: ' + formatCurrency(overdueReceivables) + '. Follow up with customers.</div></div>';
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

    $pageContent.innerHTML = html;
  });
}

/* ── Revenue Intelligence ────────────────────────────────────── */
function renderRevenueIntelligence() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('revenue').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('📈', 'No Revenue Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var rev = data.revenue || data.data || data;
    var total = rev.total_revenue || rev.total || 0;
    var growth = rev.growth_rate || rev.growth || null;
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

    $pageContent.innerHTML = html;
  });
}

/* ── Risk & Anomalies ────────────────────────────────────────── */
function renderRiskAnomalies() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('anomalies').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('🛡', 'No Risk Data', 'Select a target month from Controller Overview to begin analysis.');
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
      html += renderEmptyState('✅', 'No Anomalies Detected', 'Your financials look clean this period.');
    }

    $pageContent.innerHTML = html;
  });
}

/* ── Vendors ─────────────────────────────────────────────────── */
function renderVendors() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('vendors').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('🏢', 'No Vendor Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var v = data.vendors || data.data || data;
    var riskScore = v.vendor_risk_score || v.risk_score || '—';
    var concentration = v.concentration || v.top_vendor_concentration || '—';
    var topVendor = v.top_vendor || v.largest_vendor || '—';
    var vendors = v.vendor_list || v.vendors || v.breakdown || [];
    var findings = v.findings || [];

    var html = '';

    /* Summary */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Vendor Risk Score</div><div class="kpi-value ' + (riskScore >= 70 ? 'text-emerald' : riskScore >= 40 ? 'text-amber' : 'text-red') + '">' + riskScore + '<span class="text-muted text-sm">/100</span></div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Top Concentration</div><div class="kpi-value">' + (typeof concentration === 'number' ? formatPercent(concentration) : concentration) + '</div></div>';
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

    $pageContent.innerHTML = html;
  });
}

/* ── Customers ───────────────────────────────────────────────── */
function renderCustomers() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('customers').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('👥', 'No Customer Data', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var c = data.customers || data.data || data;
    var riskScore = c.customer_risk_score || c.risk_score || '—';
    var concentration = c.concentration || c.top_customer_concentration || '—';
    var topCustomer = c.top_customer || c.largest_customer || '—';
    var customers = c.customer_list || c.customers || c.breakdown || [];
    var findings = c.findings || [];

    var html = '';

    /* Summary */
    html += '<div class="kpi-row">';
    html += '<div class="kpi-card"><div class="kpi-label">Customer Risk Score</div><div class="kpi-value ' + (riskScore >= 70 ? 'text-emerald' : riskScore >= 40 ? 'text-amber' : 'text-red') + '">' + riskScore + '<span class="text-muted text-sm">/100</span></div></div>';
    html += '<div class="kpi-card"><div class="kpi-label">Top Concentration</div><div class="kpi-value">' + (typeof concentration === 'number' ? formatPercent(concentration) : concentration) + '</div></div>';
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

    $pageContent.innerHTML = html;
  });
}

/* ── Action Center ───────────────────────────────────────────── */
function renderActionCenter() {
  $pageContent.innerHTML = renderLoadingShimmer(4);

  fetchPageData('actions').then(function(data) {
    if (!data) {
      $pageContent.innerHTML = renderEmptyState('✅', 'No Actions', 'Select a target month from Controller Overview to begin analysis.');
      return;
    }

    var actions = data.actions || data.tasks || data.data || [];
    if (!Array.isArray(actions)) actions = [];

    var html = '';

    /* Export buttons */
    html += '<div style="display:flex;gap:0.75rem;margin-bottom:1.25rem;">';
    html += '<button class="btn-small" onclick="exportActions(\'csv\')">📥 Export CSV</button>';
    html += '<button class="btn-small" onclick="exportActions(\'json\')">📥 Export JSON</button>';
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
      html += renderEmptyState('✅', 'All Clear', 'No pending actions at this time.');
    }

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
    { id: 'monthly_review',  icon: '📋', title: 'Monthly Review',      desc: 'Comprehensive monthly financial review with all KPIs, findings, and recommendations.' },
    { id: 'weekly_risk',     icon: '🛡', title: 'Weekly Risk Report',   desc: 'Focused risk analysis including anomalies, fraud indicators, and urgent items.' },
    { id: 'board_summary',   icon: '📊', title: 'Board Summary',       desc: 'High-level summary suitable for board presentation with key metrics.' },
    { id: 'investor_summary', icon: '💼', title: 'Investor Summary',   desc: 'Investor-ready report with growth metrics, runway, and financial health.' }
  ];

  var html = '<div class="grid-2col">';
  reportTypes.forEach(function(rt) {
    html += '<div class="report-card" id="report-card-' + rt.id + '">';
    html += '<div class="report-card-icon">' + rt.icon + '</div>';
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
    html += '<div class="empty-state" style="flex:1"><div class="empty-state-icon">🤖</div><div class="empty-state-title">FinGuard AI</div><div class="empty-state-text">Ask me anything about your finances. I have full context from your latest analysis.</div></div>';
  } else {
    appState.chatHistory.forEach(function(msg) {
      html += renderChatMessage(msg.role, msg.content);
    });
  }
  html += '</div>';

  /* Input bar */
  html += '<div class="chat-input-wrapper">';
  html += '<input type="text" class="chat-input" id="chat-input" placeholder="Ask the FinGuard AI…" onkeydown="if(event.key===\'Enter\')sendChat()" />';
  html += '<button class="btn-primary" onclick="sendChat()">Send</button>';
  html += '</div>';

  html += '</div>';

  $pageContent.innerHTML = html;

  /* Scroll to bottom */
  var feed = document.getElementById('chat-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function renderChatMessage(role, content) {
  var isUser = role === 'user';
  var avatarIcon = isUser ? '👤' : '🤖';
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
  feed.insertAdjacentHTML('beforeend', '<div id="' + typingId + '" class="chat-msg ai"><div class="chat-msg-avatar">🤖</div><div class="chat-msg-bubble" style="animation:pulse 1s infinite">Thinking…</div></div>');
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
  var html = '<div class="glass-card" style="max-width:860px">';
  html += '<div class="settings-section">';
  html += '<h3>Avalanche Contract Deploy</h3>';
  html += '<div class="settings-helper text-sm text-muted">Choose a contract template and deploy. No ABI or bytecode required in standard mode.</div>';
  html += '<div class="settings-group"><label class="settings-label">Receiver Address</label><input type="text" class="settings-input" id="settings-contract-receiver" placeholder="0x..." /></div>';
  html += '<div class="settings-group"><label class="settings-label">Contract Template</label><select class="settings-input" id="settings-contract-template"></select></div>';
  html += '<div class="settings-group"><label class="settings-label">Deployment Name (optional)</label><input type="text" class="settings-input" id="settings-contract-name" placeholder="Leave blank to use template default" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Constructor Args (optional JSON Array)</label><input type="text" class="settings-input" id="settings-contract-args" placeholder="[]" /></div>';
  html += '<div class="settings-group settings-inline-check"><label><input type="checkbox" id="settings-contract-dryrun" checked /> Dry Run (recommended)</label></div>';
  html += '<div class="settings-group settings-inline-check"><label><input type="checkbox" id="settings-contract-advanced" /> Advanced mode (manual ABI/bytecode)</label></div>';
  html += '<div id="settings-contract-advanced-panel" class="hidden">';
  html += '<div class="settings-group"><label class="settings-label">ABI (JSON Array)</label><textarea class="settings-input settings-textarea" id="settings-contract-abi" placeholder="[{\"type\":\"constructor\",\"inputs\":[]}]"></textarea></div>';
  html += '<div class="settings-group"><label class="settings-label">Bytecode</label><textarea class="settings-input settings-textarea" id="settings-contract-bytecode" placeholder="0x..."></textarea></div>';
  html += '</div>';
  html += '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;">';
  html += '<button class="btn-primary" onclick="deployContractFromSettings()">Deploy Contract</button>';
  html += '<button class="btn-small" onclick="loadContractDeploymentHistory()">Refresh Deployment History</button>';
  html += '</div>';
  html += '<div id="contract-deploy-result" class="contract-deploy-result"></div>';
  html += '<div class="card-title" style="margin-top:1rem;">Recent Contract Deployments</div>';
  html += '<div id="contract-deploy-history" class="contract-deploy-history text-sm text-muted">Loading deployment history…</div>';
  html += '</div>';
  html += '</div>';

  $pageContent.innerHTML = html;
  setTimeout(loadContractTemplates, 0);
  setTimeout(loadContractDeploymentHistory, 0);

  var advancedToggle = document.getElementById('settings-contract-advanced');
  if (advancedToggle) {
    advancedToggle.addEventListener('change', function() {
      var panel = document.getElementById('settings-contract-advanced-panel');
      if (!panel) return;
      if (advancedToggle.checked) panel.classList.remove('hidden');
      else panel.classList.add('hidden');
    });
  }
}

function renderSettings() {
  var html = '<div class="glass-card" style="max-width:640px">';

  /* Business Profile */
  html += '<div class="settings-section">';
  html += '<h3>Business Profile</h3>';
  html += '<div class="settings-group"><label class="settings-label">Name</label><input type="text" class="settings-input" id="settings-name" value="' + escapeHtml(appState.userName) + '" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Company</label><input type="text" class="settings-input" id="settings-company" value="' + escapeHtml(appState.businessName) + '" /></div>';
  html += '</div>';

  /* Zoho */
  html += '<div class="settings-section">';
  html += '<h3>Zoho Connection</h3>';
  html += '<div class="settings-group"><label class="settings-label">API Key</label><input type="password" class="settings-input" id="settings-zoho" value="' + escapeHtml(appState.zohoApiKey) + '" placeholder="Enter Zoho API Key" /></div>';
  html += '</div>';

  /* AI API & Assistant */
  html += '<div class="settings-section">';
  html += '<h3>AI API & Assistant</h3>';
  html += '<div class="settings-group"><label class="settings-label">AI Provider</label>' +
    '<select class="settings-input" id="settings-ai-provider">' +
      '<option value="openai"' + (appState.aiProvider === 'openai' ? ' selected' : '') + '>OpenAI</option>' +
      '<option value="anthropic"' + (appState.aiProvider === 'anthropic' ? ' selected' : '') + '>Anthropic</option>' +
      '<option value="azure-openai"' + (appState.aiProvider === 'azure-openai' ? ' selected' : '') + '>Azure OpenAI</option>' +
      '<option value="custom"' + (appState.aiProvider === 'custom' ? ' selected' : '') + '>Custom</option>' +
    '</select></div>';
  html += '<div class="settings-group"><label class="settings-label">AI API Key</label><input type="password" class="settings-input" id="settings-ai-api-key" value="' + escapeHtml(appState.aiApiKey || '') + '" placeholder="Enter AI API Key" /></div>';
  html += '<div class="settings-group"><label class="settings-label">AI Assistant</label>' +
    '<select class="settings-input" id="settings-ai-assistant">' +
      '<option value="controller-core"' + (appState.aiAssistant === 'controller-core' ? ' selected' : '') + '>Controller Core</option>' +
      '<option value="risk-analyst"' + (appState.aiAssistant === 'risk-analyst' ? ' selected' : '') + '>Risk Analyst</option>' +
      '<option value="cashflow-guardian"' + (appState.aiAssistant === 'cashflow-guardian' ? ' selected' : '') + '>Cashflow Guardian</option>' +
      '<option value="executive-brief"' + (appState.aiAssistant === 'executive-brief' ? ' selected' : '') + '>Executive Brief</option>' +
    '</select></div>';
  html += '<div class="text-sm text-muted">This assistant routes requests through financial skills first, then formats responses in your selected assistant style.</div>';
  html += '</div>';

  /* Avalanche Settings */
  html += '<div class="settings-section">';
  html += '<h3>Avalanche Settings</h3>';
  html += '<div class="settings-group"><label class="settings-label">Wallet Address</label><input type="password" class="settings-input" id="settings-wallet" value="' + escapeHtml(appState.walletAddress) + '" placeholder="0x..." autocomplete="off" spellcheck="false" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Network</label><input type="text" class="settings-input" value="Avalanche C-Chain" readonly /></div>';
  html += '</div>';

  /* Risk Thresholds */
  html += '<div class="settings-section">';
  html += '<h3>Risk Thresholds</h3>';
  html += '<div class="settings-group"><label class="settings-label">Runway Warning (days)</label><input type="number" class="settings-input" id="settings-runway" value="30" min="1" max="365" /></div>';
  html += '<div class="settings-group"><label class="settings-label">Concentration Threshold (%)</label><input type="number" class="settings-input" id="settings-concentration" value="40" min="1" max="100" /></div>';
  html += '</div>';

  /* Notification Settings */
  html += '<div class="settings-section">';
  html += '<h3>Notification Settings</h3>';
  html += '<div class="settings-group"><label class="settings-label">Alert Email</label><input type="email" class="settings-input" id="settings-email" placeholder="alerts@company.com" /></div>';
  html += '</div>';

  /* User Management */
  html += '<div class="settings-section">';
  html += '<h3>User Management</h3>';
  html += '<div class="settings-group"><label class="settings-label">Primary User Role</label><input type="text" class="settings-input" value="Owner / Admin" readonly /></div>';
  html += '<div class="settings-group"><label class="settings-label">Access Review</label><input type="text" class="settings-input" value="Review quarterly" readonly /></div>';
  html += '</div>';

  /* Save */
  html += '<div style="display:flex;gap:0.75rem;margin-top:1.5rem;">';
  html += '<button class="btn-primary" onclick="saveSettings()">💾 Save Settings</button>';
  html += '</div>';

  html += '</div>';

  $pageContent.innerHTML = html;
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
  var advancedMode = document.getElementById('settings-contract-advanced').checked;
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
  var zoho = document.getElementById('settings-zoho').value.trim();
  var wallet = document.getElementById('settings-wallet').value.trim();
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
        zoho_api_key: zoho,
        wallet_address: wallet,
        ai_provider: aiProvider,
        ai_api_key: aiApiKey,
        ai_assistant: aiAssistant
      })
    });
    var data = await res.json();
    if (data.ok) {
      appState.userName = name;
      appState.businessName = company;
      appState.zohoApiKey = zoho;
      appState.walletAddress = wallet;
      appState.aiProvider = aiProvider;
      appState.aiApiKey = aiApiKey;
      appState.aiAssistant = aiAssistant;
      $companyContext.textContent = 'Company: ' + company;
      showToast('Settings saved successfully!', 'success');
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

  /* Route on load */
  var initialPage = location.hash.slice(1) || 'overview';
  navigate(initialPage);
})();