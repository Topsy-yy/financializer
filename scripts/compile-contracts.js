const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractsDir = path.resolve(__dirname, "..", "contracts");
const buildDir = path.resolve(__dirname, "..", "src", "contracts", "build");

const CONTRACTS = ["TreasuryGuard.sol", "InvoiceVault.sol", "FinGuardEscrow.sol"];

function compile() {
  const sources = {};
  CONTRACTS.forEach((fileName) => {
    sources[fileName] = { content: fs.readFileSync(path.join(contractsDir, fileName), "utf-8") };
  });

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    errors.forEach((e) => console.error(e.formattedMessage));
    throw new Error("Solidity compilation failed");
  }
  (output.errors || [])
    .filter((e) => e.severity === "warning")
    .forEach((e) => console.warn(e.formattedMessage));

  fs.mkdirSync(buildDir, { recursive: true });

  CONTRACTS.forEach((fileName) => {
    const contractName = fileName.replace(/\.sol$/, "");
    const compiled = output.contracts[fileName][contractName];
    const artifact = {
      contractName,
      abi: compiled.abi,
      bytecode: "0x" + compiled.evm.bytecode.object
    };
    fs.writeFileSync(
      path.join(buildDir, `${contractName}.json`),
      JSON.stringify(artifact, null, 2)
    );
    console.log(`Compiled ${contractName} -> src/contracts/build/${contractName}.json (${artifact.bytecode.length / 2 - 1} bytes)`);
  });
}

if (require.main === module) {
  compile();
}

module.exports = { compile };
