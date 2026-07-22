const { ethers } = require("ethers");
const config = require("../config");

function getNetworkByChainId(chainId) {
  const numeric = Number(chainId);
  return Object.values(config.avalancheNetworks).find((n) => n.chainId === numeric) || null;
}

async function verifyDeploymentTx({ chainId, txHash, contractAddress }) {
  const network = getNetworkByChainId(chainId);
  if (!network) {
    return { verified: false, reason: "unknown_network" };
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { verified: false, reason: "invalid_tx_hash" };
  }

  try {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { verified: false, reason: "receipt_not_found" };
    }

    const receiptContractAddress = receipt.contractAddress ? receipt.contractAddress.toLowerCase() : null;
    const matchesAddress = !contractAddress || receiptContractAddress === String(contractAddress).toLowerCase();
    const succeeded = receipt.status === 1;

    return {
      verified: Boolean(succeeded && matchesAddress),
      reason: !succeeded ? "transaction_failed" : (!matchesAddress ? "contract_address_mismatch" : "ok"),
      block_number: receipt.blockNumber,
      gas_used: receipt.gasUsed ? receipt.gasUsed.toString() : null
    };
  } catch (error) {
    return { verified: false, reason: "rpc_error", message: error.message };
  }
}

module.exports = {
  getNetworkByChainId,
  verifyDeploymentTx
};
