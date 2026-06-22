const config = require("../config");

function maskedReference() {
  return "***";
}

function getCoreWalletIntegrationSummary() {
  const hasConfig = Boolean(config.coreWalletApiUrl && config.coreWalletApiKey);
  const connected = config.mockRequiredIntegrations || hasConfig;

  return {
    label: "Core Wallet",
    connected,
    state: connected ? "connected" : "not connected",
    secureReference: maskedReference(),
    note: connected ? "Core wallet connected with hidden credentials (***)" : "Core wallet not configured"
  };
}

function getAvalancheWalletIntegrationSummary() {
  const hasConfig = Boolean(config.avalancheWalletAddress && config.avalancheWalletApiKey);
  const connected = config.mockRequiredIntegrations || hasConfig;

  return {
    label: "Avalanche Wallet",
    connected,
    state: connected ? "connected" : "not connected",
    secureReference: maskedReference(),
    note: connected ? "Avalanche wallet connected with hidden credentials (***)" : "Avalanche wallet not configured"
  };
}

module.exports = {
  getCoreWalletIntegrationSummary,
  getAvalancheWalletIntegrationSummary
};
