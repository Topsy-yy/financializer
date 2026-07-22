const fs = require("fs");
const path = require("path");

const buildDir = path.resolve(__dirname, "..", "contracts", "build");

function loadArtifact(fileName) {
  const filePath = path.join(buildDir, fileName);
  if (!fs.existsSync(filePath)) {
    // Self-heal: build artifacts are gitignored and regenerated via postinstall,
    // but compile on demand if they're missing for any reason (fresh checkout
    // without npm install, artifacts deleted, etc).
    const { compile } = require("../../scripts/compile-contracts");
    compile();
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing compiled contract artifact: ${fileName}. Run "npm run build:contracts" first.`
    );
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

const treasuryGuard = loadArtifact("TreasuryGuard.json");
const invoiceVault = loadArtifact("InvoiceVault.json");

const TEMPLATES = [
  {
    id: "treasury-guard-v1",
    contractName: treasuryGuard.contractName,
    label: "Treasury Guard",
    icon: "shield",
    description:
      "Locks your business funds in a contract only you control. Anyone can send money in, but only " +
      "you (the owner) can approve withdrawals — and every deposit or withdrawal is permanently recorded on-chain.",
    abi: treasuryGuard.abi,
    bytecode: treasuryGuard.bytecode,
    constructorArgsSchema: []
  },
  {
    id: "invoice-vault-v1",
    contractName: invoiceVault.contractName,
    label: "Invoice Vault",
    icon: "file-text",
    description:
      "Keeps a tamper-proof, permanent record of every invoice you issue — amount, timestamp, and paid " +
      "status — so you always have proof of what was billed and when, even years later.",
    abi: invoiceVault.abi,
    bytecode: invoiceVault.bytecode,
    constructorArgsSchema: []
  }
];

function listContractTemplates() {
  return TEMPLATES.map((item) => ({
    id: item.id,
    contract_name: item.contractName,
    label: item.label,
    icon: item.icon,
    description: item.description,
    abi: item.abi,
    bytecode: item.bytecode,
    constructor_args_schema: item.constructorArgsSchema || []
  }));
}

function getContractTemplate(templateId) {
  if (!templateId) return null;
  return TEMPLATES.find((item) => item.id === templateId) || null;
}

module.exports = {
  listContractTemplates,
  getContractTemplate
};
