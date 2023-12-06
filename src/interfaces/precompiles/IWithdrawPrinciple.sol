// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.17 .0;

/// @dev The DEPOSIT contract's address.
address constant WITHDRAW_PRINCIPLE_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000806;

/// @dev The DEPOSIT contract's instance.
IWithdrawPrinciple constant WITHDRAW_PRINCIPLE_CONTRACT = IWithdrawPrinciple(
    WITHDRAW_PRINCIPLE_PRECOMPILE_ADDRESS
);

/// @author Exocore Team
/// @title Deposit Precompile Contract
/// @dev The interface through which solidity contracts will interact with Deposit
/// @custom:address 0x0000000000000000000000000000000000000804
interface IWithdrawPrinciple {
/// TRANSACTIONS
/// @dev deposit the client chain assets to the staker, that will change the state in deposit module
/// Note that this address cannot be a module account.
/// @param clientChainLzId The lzId of client chain
/// @param assetsAddress The client chain asset Address
/// @param withdrawer The staker address
/// @param opAmount The deposit amount
    function withdrawPrinciple(
        uint16 clientChainLzId,
        bytes memory assetsAddress,
        bytes memory withdrawer,
        uint256 opAmount
    ) external returns (bool success,uint256 latestAssetState);
}