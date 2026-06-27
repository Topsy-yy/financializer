const TEMPLATES = [
  {
    id: "treasury-guard-v1",
    contractName: "TreasuryGuard",
    label: "Treasury Guard",
    description: "Treasury controls with policy events and minimal setup.",
    abi: [{ type: "constructor", inputs: [] }],
    bytecode: "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60806040525f5ffdfea2646970667358221220b1c3f53c0f9c6b376d47d1f8a2571dc3c2db80f31f5ef4e2ccf0979f584e26ea64736f6c634300081c0033",
    constructorArgsSchema: []
  },
  {
    id: "invoice-vault-v1",
    contractName: "InvoiceVault",
    label: "Invoice Vault",
    description: "Simple on-chain invoice vault contract for audit-ready records.",
    abi: [{ type: "constructor", inputs: [] }],
    bytecode: "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60806040525f5ffdfea2646970667358221220b1c3f53c0f9c6b376d47d1f8a2571dc3c2db80f31f5ef4e2ccf0979f584e26ea64736f6c634300081c0033",
    constructorArgsSchema: []
  }
];

function listContractTemplates() {
  return TEMPLATES.map((item) => ({
    id: item.id,
    contract_name: item.contractName,
    label: item.label,
    description: item.description,
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
