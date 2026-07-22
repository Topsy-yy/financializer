// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Owner-controlled treasury: anyone can deposit, only the owner can withdraw.
/// Every deposit and withdrawal is recorded permanently as an on-chain event.
contract TreasuryGuard {
    address public owner;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    event Deposited(address indexed from, uint256 amount, uint256 timestamp);
    event Withdrawn(address indexed to, uint256 amount, uint256 timestamp);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "TreasuryGuard: caller is not the owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    receive() external payable {
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value, block.timestamp);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "TreasuryGuard: zero address");
        require(amount <= address(this).balance, "TreasuryGuard: insufficient balance");
        totalWithdrawn += amount;
        emit Withdrawn(to, amount, block.timestamp);
        (bool success, ) = to.call{value: amount}("");
        require(success, "TreasuryGuard: transfer failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "TreasuryGuard: zero address");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
