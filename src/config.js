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
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  mockRequiredIntegrations: String(process.env.MOCK_REQUIRED_INTEGRATIONS || "true") === "true",
  zohoDirectApiUrl: process.env.ZOHO_DIRECT_API_URL || "",
  zohoApiKey: process.env.ZOHO_API_KEY || "",
  zohoOauthClientId: process.env.ZOHO_OAUTH_CLIENT_ID || "",
  zohoOauthClientSecret: process.env.ZOHO_OAUTH_CLIENT_SECRET || "",
  zohoOauthAuthUrl: process.env.ZOHO_OAUTH_AUTH_URL || "https://accounts.zoho.com/oauth/v2/auth",
  zohoOauthTokenUrl: process.env.ZOHO_OAUTH_TOKEN_URL || "https://accounts.zoho.com/oauth/v2/token",
  zohoOauthScope: process.env.ZOHO_OAUTH_SCOPE || "ZohoBooks.fullaccess.all",
  zohoOauthRedirectUri:
    process.env.ZOHO_OAUTH_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`}/api/oauth/zoho/callback`,
  coreWalletApiUrl: process.env.CORE_WALLET_API_URL || "",
  coreWalletApiKey: process.env.CORE_WALLET_API_KEY || "",
  coreWalletAccountId: process.env.CORE_WALLET_ACCOUNT_ID || "",
  avalancheWalletAddress: process.env.AVALANCHE_WALLET_ADDRESS || "",
  avalancheWalletApiKey: process.env.AVALANCHE_WALLET_API_KEY || "",
  businessName: process.env.BUSINESS_NAME || "K-Biz Holdings",
  userName: process.env.USER_NAME || "Aisha Mwangi",
  businessAddress: process.env.BUSINESS_ADDRESS || "Nairobi, Kenya",
  aiApiBaseUrl: process.env.AI_API_BASE_URL || "https://api.openai.com/v1",
  aiApiModel: process.env.AI_API_MODEL || "gpt-5-mini",
  aiApiTimeoutMs: Number(process.env.AI_API_TIMEOUT_MS || 15000),
  enableAiAnalysis: String(process.env.ENABLE_AI_ANALYSIS || "true") === "true",
  businessOwnerKeywords: parseCsvEnv(process.env.BUSINESS_OWNER_KEYWORDS),
  alertEmails: parseCsvEnv(process.env.ALERT_EMAILS),
  avalancheCliPath: process.env.AVALANCHE_CLI_PATH || "avalanche",
  enableAvalanche: String(process.env.ENABLE_AVALANCHE || "false") === "true",
  avalancheCChainRpcUrl: process.env.AVALANCHE_CCHAIN_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
  avalancheCChainChainId: Number(process.env.AVALANCHE_CCHAIN_CHAIN_ID || 43113),
  avalancheDeployPrivateKey: process.env.AVALANCHE_DEPLOY_PRIVATE_KEY || "",
  avalancheContractAllowlist: parseCsvEnv(process.env.AVALANCHE_CONTRACT_ALLOWLIST),
  enableAvalancheContractDeploy: String(process.env.ENABLE_AVALANCHE_CONTRACT_DEPLOY || "false") === "true",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`}/api/auth/google/callback`,
  sessionSecret: process.env.SESSION_SECRET || "",
  get enableGoogleAuth() {
    return Boolean(this.googleClientId && this.googleClientSecret);
  },
  avalancheNetworks: {
    fuji: {
      key: "fuji",
      chainId: 43113,
      chainIdHex: "0xa869",
      name: "Avalanche Fuji Testnet",
      isTestnet: true,
      rpcUrl: process.env.AVALANCHE_CCHAIN_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
      explorerUrl: "https://testnet.snowtrace.io",
      faucetUrl: "https://core.app/tools/testnet-faucet/?subnet=c&token=c",
      nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }
    },
    mainnet: {
      key: "mainnet",
      chainId: 43114,
      chainIdHex: "0xa86a",
      name: "Avalanche C-Chain",
      isTestnet: false,
      rpcUrl: process.env.AVALANCHE_MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
      explorerUrl: "https://snowtrace.io",
      faucetUrl: "",
      nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }
    }
  },
  reportsDir
};
