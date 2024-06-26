// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.17;

/// @dev The delegation contract's address.
address constant DELEGATION_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000805;

/// @dev The delegation contract's instance.
IDelegation constant DELEGATION_CONTRACT = IDelegation(DELEGATION_PRECOMPILE_ADDRESS);

/// @author Exocore Team
/// @title delegation Precompile Contract
/// @dev The interface through which solidity contracts will interact with delegation
/// @custom:address 0x0000000000000000000000000000000000000805
interface IDelegation {
    /// TRANSACTIONS
    /// @dev delegate the client chain assets to the operator through client chain, that will change the states in delegation and restaking_assets_manage module
    /// Note that this address cannot be a module account.
    /// @param ClientChainLzId The lzId of client chain
    /// @param LzNonce The cross chain tx layerZero nonce
    /// @param AssetsAddress The client chain asset Address
    /// @param StakerAddress The staker address
    /// @param OperatorAddr  The operator address that wants to be delegated to
    /// @param OpAmount The delegation amount
    function delegateToThroughClientChain(
        uint32 ClientChainLzId,
        uint64 LzNonce,
        bytes memory AssetsAddress,
        bytes memory StakerAddress,
        bytes memory OperatorAddr,
        uint256 OpAmount
    ) external returns (bool success);

    /// TRANSACTIONS
    /// @dev undelegate the client chain assets from the operator through client chain, that will change the states in delegation and restaking_assets_manage module
    /// Note that this address cannot be a module account.
    /// @param ClientChainLzId The lzId of client chain
    /// @param LzNonce The cross chain tx layerZero nonce
    /// @param AssetsAddress The client chain asset Address
    /// @param StakerAddress The staker address
    /// @param OperatorAddr  The operator address that wants to unDelegate from
    /// @param OpAmount The Undelegation amount
    function undelegateFromThroughClientChain(
        uint32 ClientChainLzId,
        uint64 LzNonce,
        bytes memory AssetsAddress,
        bytes memory StakerAddress,
        bytes memory OperatorAddr,
        uint256 OpAmount
    ) external returns (bool success);
}
