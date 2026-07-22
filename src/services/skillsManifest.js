const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

// Mirrors the "Navigation Contract" table in skills/financial-controller-core/skill.md.
// Keep these in sync if that table ever changes.
const NAV_SKILL_MAP = {
  overview: ["financial-health-scorer", "financial-controller-core", "executive-report-generator"],
  financial_health: ["financial-health-scorer"],
  cashflow: ["cashflow-risk-analyzer"],
  revenue: ["revenue-intelligence"],
  risk: ["fraud-and-errors-detector"],
  vendors: ["vendor-dependency-detector"],
  customers: ["customer-concentration-detector", "revenue-intelligence"],
  actions: ["followup-orchestrator", "recommendation-engine"],
  executive_report: ["executive-report-generator", "financial-controller-core"],
  chat: ["financial-controller-core", "executive-report-generator", "recommendation-engine"]
};

let cache = null;

function loadAllSkills() {
  if (cache) return cache;

  cache = {};
  if (!fs.existsSync(SKILLS_DIR)) return cache;

  fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => {
      const skillFile = path.join(SKILLS_DIR, entry.name, "skill.md");
      if (fs.existsSync(skillFile)) {
        cache[entry.name] = fs.readFileSync(skillFile, "utf-8");
      }
    });

  return cache;
}

/**
 * Returns the raw skill.md content for the skill(s) that own a given
 * navigation page, concatenated, so the AI can read exactly what that
 * page/skill is supposed to detect and how it should talk about it.
 */
function getSkillContextForPage(pageKey) {
  const skills = loadAllSkills();
  const names = NAV_SKILL_MAP[pageKey] || [];
  return names
    .map((name) => skills[name])
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function getAllSkillNames() {
  return Object.keys(loadAllSkills());
}

module.exports = {
  NAV_SKILL_MAP,
  loadAllSkills,
  getSkillContextForPage,
  getAllSkillNames
};
