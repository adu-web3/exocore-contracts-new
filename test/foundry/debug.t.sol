// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import "forge-std/Test.sol";
import "../../src/core/ImuachainGateway.sol";

address constant ASSETS_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000804;

contract LayerZeroDebugTest is Test {
    // Addresses from the trace
    address constant LZ_EXECUTOR = 0x55c175DD5b039331dB251424538169D8495C18d1;
    address constant LZ_ENDPOINT = 0x6EDCE65403992e310A62460808c4b910D972f10f;
    address payable constant IMUACHAIN_GATEWAY = payable(0xdDf5218Dbff297ADdF17fB7977E2469D774545ED);
    bytes32 constant TX_HASH = bytes32(hex"c2b004f88884797b7f5b5256d0871ff21dc38e52c35c67e42d03b2c4fb57cae0");
    
    // Transaction data from the trace
    uint32 constant SRC_CHAIN_ID = 40168;
    bytes32 constant SENDER = 0xca3a70116bc23dac30d0a8c1c80437e590365f0c08314346a99d300645b0f493;
    uint64 constant LZ_NONCE = 6;
    bytes32 constant GUID = 0x28a75f78b5d8da7b41f0f068ab19b572954f94990e09a2a46b0186ed67b234b8;
    bytes constant MESSAGE = hex"04f590705f01036905f4d208d1416e1bd6debca9b86675173d82817f3d4f7d340e000000000000000000000000000000000000000000000000000009184e72a0007311a2862f6aa853d2f5aa69df454bdca288a277f187fe5c5b2ed73ba70a721e";
    bytes constant PAYLOAD = hex"f590705f01036905f4d208d1416e1bd6debca9b86675173d82817f3d4f7d340e000000000000000000000000000000000000000000000000000009184e72a0007311a2862f6aa853d2f5aa69df454bdca288a277f187fe5c5b2ed73ba70a721e";
    uint256 constant GAS_LIMIT = 519000;
    
    // Parsed payload components
    bytes32 constant STAKER = 0xf590705f01036905f4d208d1416e1bd6debca9b86675173d82817f3d4f7d340e;
    uint256 constant AMOUNT = 10000000000000; // 1e13
    bytes32 constant TOKEN = 0x7311a2862f6aa853d2f5aa69df454bdca288a277f187fe5c5b2ed73ba70a721e;
    
    ImuachainGateway gateway;
    
    function setUp() public {
        // Fork the Imua chain at the block before the transaction
        string memory rpcUrl = "imuachain_testnet";
        uint256 forkId = vm.createFork(rpcUrl, TX_HASH);
        vm.selectFork(forkId);
        
        // Get the ImuachainGateway contract instance
        gateway = ImuachainGateway(IMUACHAIN_GATEWAY);
        
        // Mock the precompile calls
        // For ASSETS_CONTRACT.withdrawLST
        vm.mockCall(
            ASSETS_PRECOMPILE_ADDRESS,
            abi.encodeWithSignature(
                "withdrawLST(uint32,bytes,bytes,uint256)",
                SRC_CHAIN_ID,
                abi.encodePacked(TOKEN),
                abi.encodePacked(STAKER),
                AMOUNT
            ),
            abi.encode(true, bytes(""))
        );
    }
    
    function testLayerZeroTransaction() public {
        
        // Create the Origin struct as expected by lzReceive
        Origin memory originData = Origin({
            srcEid: SRC_CHAIN_ID,
            sender: SENDER,
            nonce: LZ_NONCE
        });
        
        // simulate lz endpoint calling gateway
        vm.startPrank(LZ_ENDPOINT);
        // Try to directly call the ImuachainGateway's _lzReceive function
        // This bypasses some of the LZ endpoint logic but should help identify if the issue is in the gateway
        try gateway.lzReceive(originData, GUID, MESSAGE, LZ_EXECUTOR, bytes("")) {
            console.log("Direct lzReceive call succeeded");
        } catch Error(string memory reason) {
            console.log("Direct lzReceive call failed with reason:", reason);
        } catch (bytes memory lowLevelData) {
            console.logBytes(lowLevelData);
            console.log("Direct lzReceive call failed with low-level error");
        }
        vm.stopPrank();
        
        // Simulate the LZ executor calling the endpoint
        vm.startPrank(LZ_EXECUTOR);

        try ILayerZeroEndpointV2(LZ_ENDPOINT).lzReceive(
            originData,
            IMUACHAIN_GATEWAY,
            GUID,
            MESSAGE,
            bytes("")
        ) {
            console.log("Full LZ call path succeeded");
        } catch Error(string memory reason) {
            console.log("Full LZ call path failed with reason:", reason);
        } catch (bytes memory lowLevelData) {
            console.logBytes(lowLevelData);
            console.log("Full LZ call path failed with low-level error");
        }
        
        vm.stopPrank();
    }
    
    // Test specifically the handleLSTTransfer function which seems to be failing
    function testHandleLSTTransfer() public {
        vm.startPrank(IMUACHAIN_GATEWAY);
        
        try ImuachainGateway(IMUACHAIN_GATEWAY).handleLSTTransfer(
            SRC_CHAIN_ID,
            LZ_NONCE,
            Action.REQUEST_WITHDRAW_LST,
            PAYLOAD
        ) returns (bytes memory response) {
            console.log("handleLSTTransfer succeeded");
            console.logBytes(response);
        } catch Error(string memory reason) {
            console.log("handleLSTTransfer failed with reason:", reason);
        } catch (bytes memory lowLevelData) {
            console.logBytes(lowLevelData);
            console.log("handleLSTTransfer failed with low-level error");
        }
        
        vm.stopPrank();
    }
}
