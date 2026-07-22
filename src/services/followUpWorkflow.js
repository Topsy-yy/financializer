const fs = require("fs");
const path = require("path");
const config = require("../config");
const { runAvalanche } = require("./avalancheClient");

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function createFollowUpActions(report) {
  const actions = [];

  report.checklist.forEach((entry) => {
    if (entry.count > 0 && entry.status !== "ok") {
      actions.push({
        task: `Resolve: ${entry.item}`,
        owner: entry.item.toLowerCase().includes("reconcile") ? "accountant" : "founder",
        priority: report.risk.severity === "high" ? "urgent" : "normal",
        dueInDays: report.risk.severity === "high" ? 3 : 7
      });
    }
  });

  return actions;
}

function toCsv(actions) {
  const headers = ["task", "owner", "priority", "dueInDays"];
  const rows = actions.map((a) => [a.task, a.owner, a.priority, String(a.dueInDays)]);
  return [headers, ...rows]
    .map((row) => row.map((cell) => `\"${String(cell).replaceAll("\"", "\"\"")}\"`).join(","))
    .join("\n");
}

function toPlainTextReport(report, actions) {
  const summary = report.summary || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  const founderSummary = Array.isArray(summary.founderSummary) ? summary.founderSummary : [];
  const checklist = Array.isArray(report.checklist) ? report.checklist : [];

  const header = [
    "FinGuard AI - Monthly Analysis",
    `Business: ${report.company?.name || "Unknown"}`,
    `Address: ${report.company?.address || "Not provided"}`,
    `Period: ${report.period || "Current month"}`,
    `Generated At: ${report.generatedAt}`,
    ""
  ];

  const riskSection = [
    "Risk Snapshot",
    `- Score: ${report.risk?.riskScore ?? "n/a"}/100`,
    `- Severity: ${report.risk?.severity || "unknown"}`,
    `- Estimated Runway: ${report.risk?.runwayMonths ?? "unknown"} months`,
    ""
  ];

  const summarySection = [
    "Founder Summary",
    ...founderSummary.map((line, index) => `${index + 1}. ${line}`),
    founderSummary.length ? "" : "No summary points.",
    ""
  ];

  const warningSection = [
    "Early Warnings",
    ...(warnings.length ? warnings.map((line, index) => `${index + 1}. ${line}`) : ["None"]),
    ""
  ];

  const checklistSection = [
    "Checklist",
    ...(checklist.length
      ? checklist.map((item) => `- ${item.item}: ${item.count} (${item.status})`)
      : ["No checklist items."]),
    ""
  ];

  const actionsSection = [
    "Follow-up Actions",
    ...(actions.length
      ? actions.map(
          (action, index) =>
            `${index + 1}. ${action.task} | Owner: ${action.owner} | Priority: ${action.priority} | Due in: ${action.dueInDays} days`
        )
      : ["No action items required."])
  ];

  return [
    ...header,
    ...riskSection,
    ...summarySection,
    ...warningSection,
    ...checklistSection,
    ...actionsSection
  ].join("\n");
}

async function notifyViaAvalanche(report, actions) {
  if (!config.enableAvalanche) {
    return { sent: false, reason: "ENABLE_AVALANCHE=false" };
  }

  const message = [
    `Financial review for ${report.company.name} (${report.period || "current month"})`,
    `Risk score: ${report.risk.riskScore}/100 (${report.risk.severity})`,
    `Action items: ${actions.length}`
  ].join(" | ");

  const addresses = config.alertEmails.join(",");
  const args = ["notify", "--to", addresses, "--message", message];
  const response = await runAvalanche(args);

  return { sent: true, response };
}

async function runFollowUpWorkflow(report, reportsDir) {
  const actions = createFollowUpActions(report);
  const targetDir = reportsDir || config.reportsDir;

  const reportId = `${report.period || "period"}-${timestampSlug()}`;
  const actionsFile = path.resolve(targetDir, `${reportId}-actions.csv`);
  const reportFile = path.resolve(targetDir, `${reportId}-report.json`);
  const reportTextFile = path.resolve(targetDir, `${reportId}-report.txt`);

  fs.writeFileSync(actionsFile, toCsv(actions));
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportTextFile, toPlainTextReport(report, actions));

  const avalancheNotification = await notifyViaAvalanche(report, actions);

  return {
    reportId,
    actions,
    outputs: {
      actionsFile,
      reportFile,
      reportTextFile
    },
    avalancheNotification
  };
}

module.exports = {
  runFollowUpWorkflow
};
