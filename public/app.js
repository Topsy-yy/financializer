/* ============================================================
   AI Financial Controller — Frontend Application
   Executive BI Dashboard
   ============================================================ */

/* ---------- DOM References ---------- */
const statusEl = document.getElementById("status");
const monthListEl = document.getElementById("month-list");
const analysisMonthEl = document.getElementById("analysis-month");
const analysisStreamEl = document.getElementById("analysis-stream");
const profilePopover = document.getElementById("profile-popover");
const profileToggleBtn = document.getElementById("profile-toggle");
const profileContent = document.getElementById("profile-content");
const refreshProfileBtn = document.getElementById("refresh-profile");
const themeToggleBtn = document.getElementById("theme-toggle");
const toastContainer = document.getElementById("toast-container");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send");
const chatContextHint = document.getElementById("chat-context-hint");
const companyContext = document.getElementById("company-context");

/* Dashboard Specific DOM */
const kpiHealth = document.getElementById("kpi-health");
const kpiRunway = document.getElementById("kpi-runway");
const kpiAlerts = document.getElementById("kpi-alerts");
const kpiRevenue = document.getElementById("kpi-revenue");
const findingsList = document.getElementById("findings-list");
const aiSummaryContent = document.getElementById("ai-summary-content");

/* Onboarding DOM */
const signupOverlay = document.getElementById("signup-overlay");
const signupForm = document.getElementById("signup-form");
const btnDemoMode = document.getElementById("btn-demo-mode");

/* ---------- State ---------- */
let activeMonth = null;
let streamTimer = null;
let chatHistory = [];
let isProcessing = false;
let userName = "Aisha";
let businessName = "ABC Traders Ltd";
let zohoApiKey = "";
let walletAddress = "";

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */

function escapeHtml(value) {
  var s = String(value);
  var map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, function (m) { return map[m]; });
}

function severityClass(severity) {
  if (severity === "high") return "text-red";
  if (severity === "medium") return "text-amber";
  return "text-emerald";
}

/* ============================================================
   TOAST NOTIFICATION SYSTEM
   ============================================================ */

function showToast(message, type, duration) {
  if (duration === undefined) duration = 4000;
  if (!toastContainer) return;

  var icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  var toast = document.createElement("div");
  toast.className = "toast toast-" + type;
  toast.setAttribute("role", "alert");
  toast.innerHTML =
    '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
    '<span class="toast-message">' + escapeHtml(message) + '</span>' +
    '<button class="toast-close" aria-label="Dismiss" style="background:transparent;border:none;color:white;cursor:pointer;">&times;</button>';

  toast.querySelector(".toast-close").addEventListener("click", function () {
    dismissToast(toast);
  });

  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(function () { dismissToast(toast); }, duration);
  }
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.opacity = "0";
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 250);
}

/* ============================================================
   THEME (DARK / LIGHT MODE)
   ============================================================ */

function getPreferredTheme() {
  var stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.className = theme;
  localStorage.setItem("theme", theme);
}

function toggleTheme() {
  var current = document.documentElement.className;
  setTheme(current === "dark" ? "light" : "dark");
}

setTheme(getPreferredTheme());

if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", toggleTheme);
}

/* ============================================================
   PROFILE
   ============================================================ */

async function loadProfile() {
  if (!profileContent) return;
  profileContent.innerHTML = '<p class="text-muted">Loading profile...</p>';

  try {
    var response = await fetch("/api/profile");
    var json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || "Unable to load profile");

    var profile = json.profile || {};
    
    // Fallback to local session state if backend didn't persist it
    userName = profile.userName || sessionStorage.getItem("userName") || "Aisha";
    businessName = profile.businessName || sessionStorage.getItem("businessName") || "ABC Traders Ltd";

    if (companyContext) {
      companyContext.textContent = "Company: " + businessName;
    }

    profileContent.innerHTML =
      '<div class="profile-card">' +
        '<h3>' + escapeHtml(businessName) + '</h3>' +
        '<p><strong>User:</strong> ' + escapeHtml(userName) + '</p>' +
      '</div>';
  } catch (error) {
    profileContent.innerHTML = '<p class="text-red">' + escapeHtml(error.message) + '</p>';
  }
}

/* ============================================================
   MONTH SELECTION
   ============================================================ */

function buildRecentMonths(total) {
  if (total === undefined) total = 12;
  var months = [];
  var now = new Date();
  for (var i = 0; i < total; i += 1) {
    var date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    var key = date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
    var label = date.toLocaleString("en-US", { month: "short", year: "numeric" });
    months.push({ key: key, label: label });
  }
  return months;
}

function renderMonths() {
  if (!monthListEl) return;
  var months = buildRecentMonths();
  monthListEl.innerHTML = months.map(function (month) {
    return '<button type="button" class="month-btn' + (month.key === activeMonth ? " active" : "") + '" data-month="' + month.key + '">' + escapeHtml(month.label) + '</button>';
  }).join("");

  monthListEl.querySelectorAll(".month-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      var month = button.getAttribute("data-month");
      if (month) runMonthlyReview(month);
    });
  });
}

/* ============================================================
   DASHBOARD RENDERER
   ============================================================ */

function renderReport(json) {
  var report = json.report || {};
  var risk = report.risk || {};
  var summary = report.summary || {};
  var followUp = json.followUp || {};
  var checklist = report.checklist || [];

  /* Render KPIs */
  if (kpiRunway) kpiRunway.textContent = risk.runwayMonths != null ? (Math.round(risk.runwayMonths * 30)) + " Days" : "-- Days";
  
  var alertsCount = checklist.filter(c => c.status === "action-needed" || c.status === "review").length;
  if (kpiAlerts) kpiAlerts.textContent = alertsCount || "0";
  
  var score = risk.riskScore != null ? (100 - risk.riskScore) : "--";
  if (kpiHealth) {
    kpiHealth.textContent = score + "/100";
    kpiHealth.className = "kpi-value " + severityClass(risk.severity);
  }
  
  /* Mock revenue trend */
  if (kpiRevenue) {
      kpiRevenue.textContent = "+12%";
      kpiRevenue.className = "kpi-value text-emerald";
  }

  /* Render Findings */
  if (findingsList) {
    if (summary.warnings && summary.warnings.length > 0) {
      findingsList.innerHTML = summary.warnings.map(w => '<li><span class="dot red"></span> ' + escapeHtml(w) + '</li>').join("");
    } else {
      findingsList.innerHTML = '<li class="text-muted text-sm">No critical findings.</li>';
    }
  }

  /* Render AI Summary */
  if (aiSummaryContent) {
    var headline = summary.headline || "Monthly financial analysis complete.";
    var severityDisplay = risk.severity ? "severity-" + risk.severity.toLowerCase() : "";
    
    var html = '<p class="' + severityDisplay + '"><strong>' + escapeHtml(headline) + '</strong></p>';
    
    if (summary.founderSummary && summary.founderSummary.length > 0) {
      html += '<p>Reasons:</p><ul>' + summary.founderSummary.map(s => '<li>' + escapeHtml(s) + '</li>').join("") + '</ul>';
    }
    
    if (followUp.actions && followUp.actions.length > 0) {
      html += '<p class="text-brand" style="margin-top: 1rem; font-weight: 600;">Recommended Actions:</p><ol style="padding-left: 1.5rem; margin-top: 0.5rem;">';
      html += followUp.actions.map(a => '<li style="margin-bottom: 0.5rem;">' + escapeHtml(a.task) + '</li>').join("");
      html += '</ol>';
    }

    aiSummaryContent.innerHTML = html;
  }
}

function showStatus(text) {
  if (statusEl) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = text;
  }
}

async function runMonthlyReview(month) {
  activeMonth = month;
  renderMonths();

  if (analysisMonthEl) analysisMonthEl.textContent = month;
  
  showStatus("Processing " + month + "...");
  
  try {
    var response = await fetch("/api/monthly-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 
        month: month,
        businessName: businessName,
        userName: userName,
        apiKey: zohoApiKey
      })
    });

    var json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || "Review failed");

    if (statusEl) statusEl.classList.add("hidden");
    renderReport(json);
    showToast("Dashboard updated for " + month, "success");

  } catch (error) {
    showStatus("Error processing request");
    showToast(error.message, "error");
  }
}

/* ============================================================
   CHAT LOGIC
   ============================================================ */

function getChatFeed() {
  var feed = document.getElementById("chat-feed");
  if (!feed) return null;
  return feed;
}

function ensureChatMessagesContainer() {
  var feed = getChatFeed();
  if (!feed) return null;
  var container = feed.querySelector(".chat-messages");
  if (!container) {
    container = document.createElement("div");
    container.className = "chat-messages";
    feed.appendChild(container);
  }
  return container;
}

function scrollChatToBottom() {
  var feed = getChatFeed();
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function addUserMessage(text) {
  var container = ensureChatMessagesContainer();
  if (!container) return;
  var msgEl = document.createElement("div");
  msgEl.className = "chat-msg user";
  msgEl.innerHTML = '<div class="chat-msg-bubble">' + escapeHtml(text) + '</div>';
  container.appendChild(msgEl);
  scrollChatToBottom();
}

function addAiMessage(html) {
  var container = ensureChatMessagesContainer();
  if (!container) return;
  var msgEl = document.createElement("div");
  msgEl.className = "chat-msg ai";
  msgEl.innerHTML = '<span class="chat-msg-label">AI Controller</span><div class="chat-msg-bubble">' + html + '</div>';
  container.appendChild(msgEl);
  scrollChatToBottom();
}

async function sendChatMessage() {
  if (isProcessing || !chatInput) return;
  var text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  addUserMessage(text);
  isProcessing = true;
  chatInput.disabled = true;

  try {
    var response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, activeMonth: activeMonth, history: chatHistory.slice(-10) })
    });
    var json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || "Request failed");

    addAiMessage(json.html || escapeHtml(json.text || "I processed your request."));
    chatHistory.push({ role: "user", content: text }, { role: "assistant", content: json.text || "" });

  } catch (error) {
    addAiMessage('<p class="text-red">Error: ' + escapeHtml(error.message) + '</p>');
  } finally {
    isProcessing = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

if (chatInput) {
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
}
if (chatSendBtn) {
  chatSendBtn.addEventListener("click", sendChatMessage);
}

/* ============================================================
   POPOVER & BINDINGS
   ============================================================ */

if (refreshProfileBtn) refreshProfileBtn.addEventListener("click", loadProfile);

if (profileToggleBtn && profilePopover) {
  profileToggleBtn.addEventListener("click", function () {
    profilePopover.classList.toggle("hidden");
    if (!profilePopover.classList.contains("hidden")) loadProfile();
  });
  document.addEventListener("click", function (event) {
    if (profilePopover.contains(event.target) || profileToggleBtn.contains(event.target)) return;
    profilePopover.classList.add("hidden");
  });
}

/* ============================================================
   ONBOARDING
   ============================================================ */

function checkOnboarding() {
  const onboarded = sessionStorage.getItem("onboarded");
  if (onboarded === "true") {
    if (signupOverlay) signupOverlay.style.display = "none";
    userName = sessionStorage.getItem("userName") || "Aisha";
    businessName = sessionStorage.getItem("businessName") || "ABC Traders Ltd";
    zohoApiKey = sessionStorage.getItem("zohoApiKey") || "";
    walletAddress = sessionStorage.getItem("walletAddress") || "";
    if (companyContext) companyContext.textContent = "Company: " + businessName;
  }
}

if (signupForm) {
  signupForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    userName = document.getElementById("input-name").value;
    businessName = document.getElementById("input-company").value;
    zohoApiKey = document.getElementById("input-zoho").value;
    walletAddress = document.getElementById("input-wallet").value;
    
    sessionStorage.setItem("onboarded", "true");
    sessionStorage.setItem("userName", userName);
    sessionStorage.setItem("businessName", businessName);
    sessionStorage.setItem("zohoApiKey", zohoApiKey);
    sessionStorage.setItem("walletAddress", walletAddress);
    
    signupOverlay.style.display = "none";
    if (companyContext) companyContext.textContent = "Company: " + businessName;
    showToast("Connected successfully!", "success");
    
    await fetch("/api/profile", {
       method: "POST",
       headers: {"Content-Type": "application/json"},
       body: JSON.stringify({ userName, businessName, zohoApiKey, walletAddress })
    });
    
    loadProfile();
  });
}

if (btnDemoMode) {
  btnDemoMode.addEventListener("click", function() {
    sessionStorage.setItem("onboarded", "true");
    sessionStorage.setItem("userName", "Demo User");
    sessionStorage.setItem("businessName", "Demo Corp");
    
    userName = "Demo User";
    businessName = "Demo Corp";
    zohoApiKey = "";
    walletAddress = "";
    
    signupOverlay.style.display = "none";
    if (companyContext) companyContext.textContent = "Company: " + businessName;
    showToast("Entering Demo Mode", "info");
    
    loadProfile();
  });
}

/* INIT */
checkOnboarding();
loadProfile();
renderMonths();