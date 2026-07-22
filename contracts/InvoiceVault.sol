// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Owner-only, tamper-proof registry of invoice records. Once recorded,
/// an invoice's hash, amount and timestamp cannot be altered — only its paid status can change.
contract InvoiceVault {
    address public owner;

    struct Invoice {
        bytes32 invoiceHash;
        uint256 amount;
        uint256 recordedAt;
        bool paid;
    }

    Invoice[] private invoices;

    event InvoiceRecorded(uint256 indexed invoiceId, bytes32 invoiceHash, uint256 amount, uint256 timestamp);
    event InvoiceMarkedPaid(uint256 indexed invoiceId, uint256 timestamp);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "InvoiceVault: caller is not the owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    function recordInvoice(bytes32 invoiceHash, uint256 amount) external onlyOwner returns (uint256 invoiceId) {
        invoices.push(Invoice({
            invoiceHash: invoiceHash,
            amount: amount,
            recordedAt: block.timestamp,
            paid: false
        }));
        invoiceId = invoices.length - 1;
        emit InvoiceRecorded(invoiceId, invoiceHash, amount, block.timestamp);
    }

    function markPaid(uint256 invoiceId) external onlyOwner {
        require(invoiceId < invoices.length, "InvoiceVault: invalid invoice id");
        invoices[invoiceId].paid = true;
        emit InvoiceMarkedPaid(invoiceId, block.timestamp);
    }

    function getInvoice(uint256 invoiceId) external view returns (bytes32 invoiceHash, uint256 amount, uint256 recordedAt, bool paid) {
        require(invoiceId < invoices.length, "InvoiceVault: invalid invoice id");
        Invoice storage inv = invoices[invoiceId];
        return (inv.invoiceHash, inv.amount, inv.recordedAt, inv.paid);
    }

    function totalInvoices() external view returns (uint256) {
        return invoices.length;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "InvoiceVault: zero address");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }
}
