import {ERC20PresetFixedSupply} from "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetFixedSupply.sol";
import { NonShortCircuitEndpointV2Mock } from "test/mocks/NonShortCircuitEndpointV2Mock.sol";
import "forge-std/Script.sol";
import "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {BaseScript} from "./BaseScript.sol";
import "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

import "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/AddressCast.sol";
import "forge-std/Test.sol";

contract DebugScript is BaseScript {
    uint32 public constant clientChainId = 40161; // Exocore chain ID
    uint32 public constant imuachainId = 40259; // Exocore
    address imuachainGatewayAddr;
    address clientGatewayAddr;
    using AddressCast for address;

    function setUp() public virtual override {
        super.setUp();

        string memory deployed = vm.readFile("script/deployments/deployedContracts.json");

        clientGatewayAddr = stdJson.readAddress(deployed, ".sepolia.bootstrap");
        require(address(clientGatewayAddr) != address(0), "clientGateway address should not be empty");

        // Load exocore contracts
        imuachainGatewayAddr = stdJson.readAddress(deployed, ".imuachain.imuachainGateway");
        require(address(imuachainGatewayAddr) != address(0), "imuachain gateway address should not be empty");

        imuachainLzEndpoint = NonShortCircuitEndpointV2Mock(stdJson.readAddress(deployed, ".imuachain.lzEndpoint"));
        require(address(imuachainLzEndpoint) != address(0), "imuachainLzEndpoint address should not be empty");

        if (!useImuachainPrecompileMock) {
            // bind precompile mock contracts code to constant precompile address so that local simulation could pass
            _bindPrecompileMocks();
        }
    }

    function run() public {
        // uint64 nonce = 5;
        // bytes memory payload =
        //     hex"05a7f676745e14f888fff97e637a27c172b1c20af50000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a7640000";

        // uint64 nonce = 4;
        // bytes memory payload = hex"0502d3eea35ce9546f29e36e7d55786f021a36d9c2000000000000000000000000000000000000000000000000000000000000000000000001bc16d674ec800000";
        uint64 nonce = 349;
        bytes memory payload = hex"0a9fd4d27f4116bb6e90cff62ba4962f1bda29dcac0000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a7640000f79f563571f7d8122611d0219a0d5449b5304f79000000000000000000000000696d3174777a6e6a3379357675347779646737756a737a65726b6b303568616330386532617334646e";

        vm.selectFork(imuachain);
        vm.startBroadcast(depositor.privateKey);
        uint64 inboundNonce = imuachainLzEndpoint.lazyInboundNonce(address(imuachainGatewayAddr), clientChainId, address(clientGatewayAddr).toBytes32());
        console.log("inbound nonce", inboundNonce);
        // uint64 resetNonce = 6;
        // NonShortCircuitEndpointV2Mock(address(exocoreLzEndpoint)).resetInboundNonce(address(exocoreGateway), 40217, 0x0000000000000000000000006d71516f397162e0c63e5301777b24f3ac787538, resetNonce);
        // uint64 inboundNonce = exocoreLzEndpoint.lazyInboundNonce(address(exocoreGateway), 40217, 0x0000000000000000000000006d71516f397162e0c63e5301777b24f3ac787538);
        // console.log("inbound nonce", inboundNonce);
        imuachainLzEndpoint.lzReceive{gas: 500_000}(    
            Origin(clientChainId, address(clientGatewayAddr).toBytes32(), nonce),
            address(imuachainGatewayAddr),
            GUID.generate(
                nonce, clientChainId, address(clientGatewayAddr), imuachainId, address(imuachainGatewayAddr).toBytes32()
            ),
            payload,
            bytes("")
        );
        vm.stopBroadcast();
    }

}
