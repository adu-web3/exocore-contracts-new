const { expect } = require("chai");
require("dotenv").config();

describe("Precompile State Reversion Issue", () => {
    let anotherReverter;
    let reverterContract;
    let tryCatchCaller;
    let assetsPrecompile;
    let deployer;
    let staker;
    let stakerBytes;

    const ASSETS_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000804";
    
    // Test chain and token constants - must match contract values
    const TEST_CHAIN_ID = 99;
    const VIRTUAL_TOKEN_ADDR = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
    const VIRTUAL_TOKEN = ethers.getBytes(VIRTUAL_TOKEN_ADDR);
    const DEPOSIT_AMOUNT = ethers.parseUnits("0.1", 8); // 0.1 TestToken
    const WITHDRAWAL_AMOUNT = ethers.parseUnits("0.01", 8);
    
    before(async () => {
        const initialAccounts = await ethers.getSigners();
        [deployer, staker] = initialAccounts;

        // Format staker address for the precompile
        stakerBytes = ethers.getBytes(ethers.zeroPadBytes(ethers.getBytes(staker.address), 32));
        
        console.log("Test running with accounts:");
        console.log("Deployer:", deployer.address);
        console.log("Staker:", staker.address);
        
        // deployer is also the faucet
        faucet = deployer;

        // transfer 1 ether gas tokens to all accounts
        for (const account of initialAccounts) {
            const tx = await faucet.sendTransaction({
                to: account.address,
                value: ethers.parseEther("1"),
            });
            // wait until the transaction is mined but should not exceed 10 seconds
            await tx.wait();
            expect(await ethers.provider.getBalance(account.address)).to.be.greaterThanOrEqual(ethers.parseEther("1"));
        }

        const ThirdPartyCallee = await ethers.getContractFactory("ThirdPartyCallee");
        anotherReverter = await ThirdPartyCallee.deploy();
        await anotherReverter.waitForDeployment();
        
        // Deploy the contracts
        const PrecompileCallerThatReverts = await ethers.getContractFactory("PrecompileCallerThatReverts");
        reverterContract = await PrecompileCallerThatReverts.deploy(anotherReverter.target);
        await reverterContract.waitForDeployment();
        
        const TryCatchCaller = await ethers.getContractFactory("TryCatchCaller");
        tryCatchCaller = await TryCatchCaller.deploy();
        await tryCatchCaller.waitForDeployment();
        
        // Get the assets precompile interface
        assetsPrecompile = await ethers.getContractAt("IAssets", ASSETS_PRECOMPILE_ADDRESS);
        
        console.log("Contracts deployed:");
        console.log("Reverter Contract:", reverterContract.target);
        console.log("TryCatch Caller:", tryCatchCaller.target);
    });

    it("should set up the test environment and activate staking", async () => {
        console.log("Setting up test environment...");
        
        // Set the reverter contract as an authorized gateway
        console.log("Authorizing reverter contract as gateway...");
        const tx1 = await assetsPrecompile.connect(deployer).updateAuthorizedGateways([reverterContract.target]);
        await tx1.wait();
        
        // Verify the reverter is authorized
        const [success, authorized] = await assetsPrecompile.isAuthorizedGateway(reverterContract.target);
        expect(success).to.be.true;
        expect(authorized).to.be.true;
        console.log("Reverter contract successfully authorized as gateway");
        
        try {
            // Activate staking for test chain
            console.log("Activating staking for test chain...");
            const tx2 = await reverterContract.connect(deployer).activateStakingForTestChain();
            await tx2.wait();
        } catch (error) {
            console.log("the chain and token might have been already registered, continuing...");
        }
        
        // Verify the client chain is registered
        const [chainSuccess, registered] = await assetsPrecompile.isRegisteredClientChain(TEST_CHAIN_ID);
        expect(chainSuccess).to.be.true;
        expect(registered).to.be.true;
        console.log("Test chain successfully registered");
        
        // Verify the token is registered
        const [tokenSuccess, tokenInfo] = await assetsPrecompile.getTokenInfo(TEST_CHAIN_ID, VIRTUAL_TOKEN);
        expect(tokenSuccess).to.be.true;
        expect(tokenInfo.name).to.equal("TestToken");
        console.log("Test token successfully registered");
    });

    it("should demonstrate state persistence despite transaction revert", async () => {        
        // Get initial balance (if it exists)
        const initialBalance = await getBalance();
        console.log("Initial balance:", ethers.formatUnits(initialBalance, 8), "TestToken");

        // before testing try/catch, we make a no revert call to test deposit works
        console.log("Making real deposits...");
        const tx1 = await reverterContract.callPrecompileAndNotRevert(
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            DEPOSIT_AMOUNT
        )

        const receipt1 = await tx1.wait();
        expect(receipt1.status).to.equal(1, "Deposit should succeed");
        console.log("Transaction completed with status:", receipt1.status);

        // Get initial balance (if it exists)
        const intermediateBalance = await getBalance();
        expect(intermediateBalance).to.equal(initialBalance + DEPOSIT_AMOUNT, "Incorrect intermediate balance");
        console.log("Intermediate balance:", ethers.formatUnits(intermediateBalance, 8), "TestToken");
        console.log("Intermediate balance grows as expected")
        
        // Call the TryCatchCaller which will call the reverting contract
        console.log("Making call with try/catch...");
        const tx2 = await tryCatchCaller.connect(deployer).callWithTryCatch(
            reverterContract.target,
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            DEPOSIT_AMOUNT
        );
        
        // Wait for transaction to complete
        const receipt2 = await tx2.wait();
        expect(receipt2.status).to.equal(1, "Transaction should succeed at the outer level");
        console.log("Transaction completed with status:", receipt2.status);
        
        // Get the return data from the transaction
        const result = await tryCatchCaller.callWithTryCatch.staticCall(
            reverterContract.target,
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            DEPOSIT_AMOUNT
        );
        
        // Check that the inner call failed as expected
        expect(result[0]).to.equal(false, "Inner call should have failed");
        // expect(result[1]).to.equal("Deliberate revert after precompile call", "Unexpected error message");
        console.log("Inner call correctly failed with message:", result[1]);
        
        // Check the balance after the call
        const finalBalance = await getBalance();
        console.log("Final balance:", ethers.formatUnits(finalBalance, 8), "TestToken");

        if (finalBalance > intermediateBalance) {
            console.log("ISSUE CONFIRMED: Precompile state change was not reverted!");
            console.log("Balance increased by:", ethers.formatUnits(finalBalance - intermediateBalance, 8), "TestToken");
            
            // This assertion checks our hypothesis that the balance increased despite the revert
            expect(finalBalance).to.be.equal(intermediateBalance + DEPOSIT_AMOUNT, 
                "Balance should have increased by deposited amount if the issue exists");
        } else {
            console.log("State was properly reverted");
            expect(finalBalance).to.equal(intermediateBalance, 
                "Balance should not have changed if state was properly reverted");
        }

        console.log("Making real withdrawals...");
        const tx3 = await reverterContract.callPrecompileAndNotRevert2(
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            WITHDRAWAL_AMOUNT
        )

        const receipt3 = await tx3.wait();
        expect(receipt3.status).to.equal(1, "Withdrawal should succeed");
        console.log("Transaction completed with status:", receipt3.status);

        // Get balance
        const balanceAfterWithdrawal = await getBalance();
        console.log("Balance after withdrawal:", ethers.formatUnits(balanceAfterWithdrawal, 8), "TestToken");

        expect(balanceAfterWithdrawal).to.be.equal(finalBalance - WITHDRAWAL_AMOUNT, "Balance should have decreased");
        
        // Call the TryCatchCaller which will call the reverting contract
        console.log("Making call with try/catch...");
        const tx4 = await tryCatchCaller.connect(deployer).callWithTryCatch2(
            reverterContract.target,
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            WITHDRAWAL_AMOUNT
        );
        
        // Wait for transaction to complete
        const receipt4 = await tx4.wait();
        expect(receipt4.status).to.equal(1, "Transaction should succeed at the outer level");
        console.log("Transaction completed with status:", receipt4.status);

        // Get the return data from the transaction
        const result4 = await tryCatchCaller.callWithTryCatch2.staticCall(
            reverterContract.target,
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            WITHDRAWAL_AMOUNT
        );
        
        // Check that the inner call failed as expected
        expect(result4[0]).to.equal(false, "Inner call should have failed");
        // expect(result[1]).to.equal("Deliberate revert after precompile call", "Unexpected error message");
        console.log("Inner call correctly failed with message:", result4[1]);
        
        const balanceAfterWithdrawalWithRevert = await getBalance();
        console.log("Balance after withdrawal with revert:", ethers.formatUnits(balanceAfterWithdrawalWithRevert, 8), "TestToken");
        
        if (balanceAfterWithdrawalWithRevert < balanceAfterWithdrawal) {
            console.log("ISSUE CONFIRMED: Precompile state change was not reverted!");
            console.log("Balance decreased by:", ethers.formatUnits(balanceAfterWithdrawal - balanceAfterWithdrawalWithRevert, 8), "TestToken");
            
            // This assertion checks our hypothesis that the balance increased despite the revert
            expect(balanceAfterWithdrawalWithRevert).to.be.equal(balanceAfterWithdrawal - WITHDRAWAL_AMOUNT, 
                "Balance should have decreased by withdrawal amount if the issue exists");
        } else {
            console.log("State was properly reverted");
            expect(balanceAfterWithdrawalWithRevert).to.equal(balanceAfterWithdrawal, 
                "Balance should not have changed if state was properly reverted");
        }
        
    });

    it("should demonstrate try/catch catching the precompile revert", async () => {
        // Get initial balance (if it exists)
        const initialBalance = await getBalance();
        console.log("Initial balance:", ethers.formatUnits(initialBalance, 8), "TestToken");

        // before testing try/catch, we make a no revert call to test deposit works
        console.log("Making real deposits...");
        const tx1 = await reverterContract.callPrecompileAndNotRevert(
            TEST_CHAIN_ID,
            VIRTUAL_TOKEN,
            stakerBytes,
            DEPOSIT_AMOUNT
        )

        const receipt1 = await tx1.wait();
        expect(receipt1.status).to.equal(1, "Deposit should succeed");
        console.log("Transaction completed with status:", receipt1.status);

        // Get initial balance (if it exists)
        const balanceAfterDeposit = await getBalance();
        expect(balanceAfterDeposit).to.equal(initialBalance + DEPOSIT_AMOUNT, "Incorrect balance after deposit");
        console.log("Balance after deposit:", ethers.formatUnits(balanceAfterDeposit, 8), "TestToken");
        console.log("Balance after deposit grows as expected")

        // withdraw more than staker's withdrawable balance with try/catch call, to see if the precompile revert could be caught
        try {
            // Call the TryCatchCaller which will call the reverting contract
            console.log("Making out-of-fund withdrawal with try/catch call...");
            const tx = await tryCatchCaller.connect(deployer).callWithTryCatch2(
                reverterContract.target,
                TEST_CHAIN_ID,
                VIRTUAL_TOKEN,
                stakerBytes,
                balanceAfterDeposit + WITHDRAWAL_AMOUNT
            );

            // Wait for transaction to complete
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1, "Transaction should succeed at the outer level");
            console.log("Transaction completed with status:", receipt.status);

            // Get the return data from the transaction
            const result = await tryCatchCaller.callWithTryCatch2.staticCall(
                reverterContract.target,
                TEST_CHAIN_ID,
                VIRTUAL_TOKEN,
                stakerBytes,
                balanceAfterDeposit + WITHDRAWAL_AMOUNT
            );
            
            // Check that the inner call failed as expected
            expect(result[0]).to.equal(false, "Inner call should have failed");
            console.log("Inner call correctly failed with message:", result[1]);

            console.log("Outter try/catch call successfully catch the precompile error(revert)");
        } catch (error) {
            console.log("Outter try/catch call cannot catch the precompile error(revert)");
            console.log(error.message);
        }
    })

    async function getBalance() {
        try {
            const [success, balance] = await assetsPrecompile.getStakerBalanceByToken(
                TEST_CHAIN_ID,
                stakerBytes,
                VIRTUAL_TOKEN
            );
            return balanceAssumed = success ? balance.withdrawable : 0n;
        } catch (error) {
            return 0n;
        }
    }

});