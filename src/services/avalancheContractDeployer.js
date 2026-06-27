const { ethers } = require("ethers");
const config = require("../config");
const { getContractTemplate } = require("./contractTemplateRegistry");

function resolveBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function sanitizeContractName(name) {
  if (!name) return "Contract";
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "Contract";
}

function isAllowlisted(contractName) {
  const allowlist = Array.isArray(config.avalancheContractAllowlist)
    ? config.avalancheContractAllowlist.filter(Boolean)
    : [];

  if (allowlist.length === 0) return true;
  const normalized = String(contractName || "").toLowerCase();
  return allowlist.some((name) => String(name).toLowerCase() === normalized);
}

function buildDeployChecks({ abi, bytecode }) {
  const checks = [];

  if (!Array.isArray(abi) || abi.length === 0) {
    checks.push("abi must be a non-empty JSON array");
  }

  if (!bytecode || typeof bytecode !== "string") {
    checks.push("bytecode must be a non-empty hex string");
  } else if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) {
    checks.push("bytecode must be 0x-prefixed hex");
  }

  return checks;
}

function normalizeReceiverAddress(payload) {
  const raw = payload.receiverAddress || payload.receiver_address || payload.recipient || payload.to;
  if (!raw) return "";
  return String(raw).trim();
}

function estimateDeploymentReadiness({ rpcUrl, privateKey, allowLiveDeploy, checks }) {
  return {
    allow_live_deploy: Boolean(allowLiveDeploy),
    rpc_configured: Boolean(rpcUrl),
    deployer_key_configured: Boolean(privateKey),
    checks_passed: checks.length === 0
  };
}

async function deployCChainContract(payload = {}) {
  const template = getContractTemplate(payload.templateId || payload.template_id);
  const contractName = sanitizeContractName(
    payload.contractName || payload.contract_name || template?.contractName
  );
  const abi = payload.abi || template?.abi;
  const bytecode = payload.bytecode || template?.bytecode;
  const constructorArgs = Array.isArray(payload.constructorArgs)
    ? payload.constructorArgs
    : (Array.isArray(payload.constructor_args) ? payload.constructor_args : []);

  const rpcUrl = payload.rpcUrl || payload.rpc_url || config.avalancheCChainRpcUrl;
  const privateKey = payload.privateKey || payload.private_key || config.avalancheDeployPrivateKey;
  const chainId = Number(payload.chainId || payload.chain_id || config.avalancheCChainChainId || 43113);
  const dryRun = resolveBoolean(payload.dryRun ?? payload.dry_run, true);
  const receiverAddress = normalizeReceiverAddress(payload);

  const checks = buildDeployChecks({ abi, bytecode });
  if (!receiverAddress) {
    checks.push("receiverAddress is required");
  } else if (!ethers.isAddress(receiverAddress)) {
    checks.push("receiverAddress must be a valid 0x address");
  }

  const allowLiveDeploy = config.enableAvalancheContractDeploy;
  const readiness = estimateDeploymentReadiness({ rpcUrl, privateKey, allowLiveDeploy, checks });

  const plan = {
    network: "avalanche-c-chain",
    rpc_url: rpcUrl,
    chain_id: chainId,
    contract_name: contractName,
    receiver_address: receiverAddress || null,
    template_id: template?.id || null,
    constructor_args_count: constructorArgs.length,
    mode: dryRun ? "dry-run" : "live",
    readiness
  };

  if (checks.length > 0) {
    return {
      ok: false,
      dry_run: dryRun,
      error: "invalid_contract_payload",
      validation: checks,
      plan
    };
  }

  if (!isAllowlisted(contractName)) {
    return {
      ok: false,
      dry_run: dryRun,
      error: "contract_not_allowlisted",
      message: `Contract ${contractName} is not in AVALANCHE_CONTRACT_ALLOWLIST.`,
      plan
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      message: "Dry run completed. Contract payload is valid for deployment.",
      plan
    };
  }

  if (!allowLiveDeploy) {
    return {
      ok: false,
      dry_run: false,
      error: "live_deploy_disabled",
      message: "Set ENABLE_AVALANCHE_CONTRACT_DEPLOY=true to allow live deployments.",
      plan
    };
  }

  if (!rpcUrl || !privateKey) {
    return {
      ok: false,
      dry_run: false,
      error: "missing_runtime_credentials",
      message: "rpcUrl and privateKey are required for live deployment.",
      plan
    };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  const deployTxOverrides = {};
  if (payload.gasLimit) deployTxOverrides.gasLimit = Number(payload.gasLimit);
  if (payload.maxFeePerGas) deployTxOverrides.maxFeePerGas = BigInt(payload.maxFeePerGas);
  if (payload.maxPriorityFeePerGas) deployTxOverrides.maxPriorityFeePerGas = BigInt(payload.maxPriorityFeePerGas);

  const contract = await factory.deploy(...constructorArgs, deployTxOverrides);
  const receipt = await contract.deploymentTransaction().wait();

  return {
    ok: true,
    dry_run: false,
    deployment: {
      contract_name: contractName,
      receiver_address: receiverAddress,
      address: contract.target,
      chain_id: chainId,
      tx_hash: receipt.hash,
      block_number: receipt.blockNumber,
      deployer: wallet.address,
      gas_used: receipt.gasUsed ? receipt.gasUsed.toString() : null,
      status: receipt.status === 1 ? "confirmed" : "failed"
    }
  };
}

module.exports = {
  deployCChainContract
};
