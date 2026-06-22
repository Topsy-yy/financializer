const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const reportsDir = path.resolve(process.cwd(), "data", "reports");
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

function parseCsvEnv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 8080),
  mockRequiredIntegrations: String(process.env.MOCK_REQUIRED_INTEGRATIONS || "true") === "true",
  zohoDirectApiUrl: process.env.ZOHO_DIRECT_API_URL || "",
  zohoApiKey: process.env.ZOHO_API_KEY || "",
  coreWalletApiUrl: process.env.CORE_WALLET_API_URL || "",
  coreWalletApiKey: process.env.CORE_WALLET_API_KEY || "",
  coreWalletAccountId: process.env.CORE_WALLET_ACCOUNT_ID || "",
  avalancheWalletAddress: process.env.AVALANCHE_WALLET_ADDRESS || "",
  avalancheWalletApiKey: process.env.AVALANCHE_WALLET_API_KEY || "",
  businessName: process.env.BUSINESS_NAME || "K-Biz Holdings",
  userName: process.env.USER_NAME || "Aisha Mwangi",
  businessAddress: process.env.BUSINESS_ADDRESS || "Nairobi, Kenya",
  businessOwnerKeywords: parseCsvEnv(process.env.BUSINESS_OWNER_KEYWORDS),
  alertEmails: parseCsvEnv(process.env.ALERT_EMAILS),
  avalancheCliPath: process.env.AVALANCHE_CLI_PATH || "avalanche",
  enableAvalanche: String(process.env.ENABLE_AVALANCHE || "false") === "true",
  reportsDir
};
