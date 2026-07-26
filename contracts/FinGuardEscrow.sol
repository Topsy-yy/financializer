// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Two-party escrow between two organisations.
/// The payer funds the escrow; the payee is paid when the payer releases.
/// Roles are fixed at deployment (immutable) so neither side can be swapped out.
///  - payer  (the counterparty organisation) deposits funds, and can release() to
///    the payee or refund() itself before the deadline.
///  - payee  (your organisation, the deployer) receives funds on release, and can
///    claimAfterDeadline() if the payer never acts — so funds can't be locked forever.
contract FinGuardEscrow {
    address public immutable payer; // counterparty organisation — deposits the funds
    address public immutable payee; // your organisation — receives the funds (deployer)
    uint256 public immutable deadline;

    uint256 public totalDeposited;
    bool public released;
    bool public refunded;

    uint256 private _locked;

    event Deposited(address indexed from, uint256 amount, uint256 timestamp);
    event Released(address indexed to, uint256 amount, uint256 timestamp);
    event Refunded(address indexed to, uint256 amount, uint256 timestamp);

    modifier nonReentrant() {
        require(_locked == 0, "FinGuardEscrow: reentrant call");
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier notSettled() {
        require(!released && !refunded, "FinGuardEscrow: already settled");
        _;
    }

    /// @param _payer the counterparty organisation's wallet (the one who deposits)
    /// @param _deadlineSeconds seconds from now after which the payee may claim unreleased funds
    constructor(address _payer, uint256 _deadlineSeconds) {
        require(_payer != address(0), "FinGuardEscrow: payer required");
        require(_payer != msg.sender, "FinGuardEscrow: payer and payee must differ");
        require(_deadlineSeconds > 0, "FinGuardEscrow: deadline required");
        payer = _payer;
        payee = msg.sender;
        deadline = block.timestamp + _deadlineSeconds;
    }

    /// @notice Payer deposits funds into escrow. May be called more than once before settlement.
    function deposit() external payable notSettled {
        require(msg.sender == payer, "FinGuardEscrow: only payer can deposit");
        require(msg.value > 0, "FinGuardEscrow: no value sent");
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value, block.timestamp);
    }

    /// @notice Payer approves payment — the full balance is sent to the payee.
    function release() external nonReentrant notSettled {
        require(msg.sender == payer, "FinGuardEscrow: only payer can release");
        released = true;
        uint256 amount = address(this).balance;
        emit Released(payee, amount, block.timestamp);
        (bool ok, ) = payable(payee).call{value: amount}("");
        require(ok, "FinGuardEscrow: payee transfer failed");
    }

    /// @notice Payer reclaims the funds before the deadline (e.g. the deal fell through).
    function refund() external nonReentrant notSettled {
        require(msg.sender == payer, "FinGuardEscrow: only payer can refund");
        require(block.timestamp < deadline, "FinGuardEscrow: past deadline");
        refunded = true;
        uint256 amount = address(this).balance;
        emit Refunded(payer, amount, block.timestamp);
        (bool ok, ) = payable(payer).call{value: amount}("");
        require(ok, "FinGuardEscrow: payer transfer failed");
    }

    /// @notice After the deadline, the payee may claim funds the payer never released,
    /// so the payer cannot hold the payee's funds hostage indefinitely.
    function claimAfterDeadline() external nonReentrant notSettled {
        require(msg.sender == payee, "FinGuardEscrow: only payee can claim");
        require(block.timestamp >= deadline, "FinGuardEscrow: before deadline");
        released = true;
        uint256 amount = address(this).balance;
        emit Released(payee, amount, block.timestamp);
        (bool ok, ) = payable(payee).call{value: amount}("");
        require(ok, "FinGuardEscrow: payee transfer failed");
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
