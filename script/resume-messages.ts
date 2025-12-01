import { ethers } from "ethers";
import axios from "axios";
import * as dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";

dotenv.config();

// Configuration
const SENDER_ADDRESS = "0x64b5b5a618072c1e4d137f91af780e3b17a81f3f";
const SENDER_EID = 40161;
const RECEIVER_ADDRESS = "0xddf5218dbff297addf17fb7977e2469d774545ed";
const RECEIVER_EID = 40259;
const LAYERZERO_SCAN_API_BASE = "https://scan-testnet.layerzero-api.com/v1";
const MESSAGE_POLL_INTERVAL_MS = 5_000;
const MESSAGE_POLL_TIMEOUT_MS = 360_000;
const RPC_URL = process.env.IMUACHAIN_TESTNET_RPC;
const PRIVATE_KEY = process.env.TEST_ACCOUNT_THREE_PRIVATE_KEY;

if (!RPC_URL) {
  throw new Error("IMUACHAIN_TESTNET_RPC or IMUACHAIN_LOCALNET_RPC must be set in .env");
}

if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY must be set in .env");
}

const RESOLVED_RPC_URL: string = RPC_URL;
const RESOLVED_PRIVATE_KEY: string = PRIVATE_KEY;

// IOAppCore ABI (minimal - just endpoint() function)
const OAPP_CORE_ABI = [
  "function endpoint() external view returns (address)"
];

// ILayerZeroEndpointV2 ABI (just lzReceive function)
const ENDPOINT_ABI = [
  "function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) external payable"
];

// ImuachainGateway ABI (nextNonce function)
const IMUACHAIN_GATEWAY_ABI = [
  "function nextNonce(uint32 srcEid, bytes32 sender) external view returns (uint64)"
];

interface Origin {
  srcEid: number;
  sender: string;
  nonce: number;
}

interface MessageData {
  pathway: {
    srcEid: number;
    dstEid: number;
    sender: {
      address: string;
      id: string;
      name: string;
      chain: string;
    };
    receiver: {
      address: string;
      id: string;
      name: string;
      chain: string;
    };
    id: string;
    nonce: number;
  };
  source: {
    status: string;
    tx: {
      txHash: string;
      blockHash: string;
      blockNumber: string;
      blockTimestamp: number;
      from: string;
      blockConfirmations: number;
      payload: string;
      value: string;
      readinessTimestamp: number;
      resolvedPayload: string;
    };
    failedTx: string[];
  };
  destination: {
    status: string;
    tx?: {
      txHash: string;
      blockHash: string;
      blockNumber: number;
      blockTimestamp: number;
    };
    payloadStoredTx?: string;
    failedTx: string[];
  };
  verification: {
    dvn: {
      dvns: Record<string, any>;
      status: string;
    };
    sealer: {
      tx?: {
        txHash: string;
        blockHash: string;
        blockNumber: number;
        blockTimestamp: number;
      };
      failedTx: Array<{
        txHash: string;
        txError: string;
      }>;
      status: string;
    };
  };
  guid: string;
  config: {
    error: boolean;
    errorMessage: string;
    dvnConfigError: boolean;
    receiveLibrary: string;
    sendLibrary: string;
    inboundConfig: {
      confirmations: number;
      requiredDVNCount: number;
      optionalDVNCount: number;
      optionalDVNThreshold: number;
      requiredDVNs: string[];
      requiredDVNNames: string[];
      optionalDVNs: string[];
      optionalDVNNames: string[];
      executor: string;
    };
    outboundConfig: {
      confirmations: number;
      requiredDVNCount: number;
      optionalDVNCount: number;
      optionalDVNThreshold: number;
      requiredDVNs: string[];
      requiredDVNNames: string[];
      optionalDVNs: string[];
      optionalDVNNames: string[];
      executor: string;
    };
    ulnSendVersion: string;
    ulnReceiveVersion: string;
  };
  status: {
    name: string;
    message: string;
  };
  created: string;
  updated: string;
}

interface ApiResponse {
  data: MessageData[];
  nextToken?: string;
}

interface MessageByTxResponse {
  data: MessageData | MessageData[];
}

const FAILURE_STATUS_NAMES = new Set([
  "FAILED",
  "SIMULATION_REVERTED",
  "BLOCKED",
  "BLOCKED_BY_ORDERING"
]);

const DELIVERED_STATUS_NAMES = new Set([
  "DELIVERED",
  "SUCCESS",
  "SUCCEEDED"
]);

function normalizeStatusName(message: MessageData): string {
  return (message.status?.name || "").toUpperCase();
}

function isFailureStatus(message: MessageData): boolean {
  return FAILURE_STATUS_NAMES.has(normalizeStatusName(message));
}

function isDeliveredStatus(message: MessageData): boolean {
  return DELIVERED_STATUS_NAMES.has(normalizeStatusName(message));
}

async function fetchMessageByTx(txHash: string): Promise<MessageData | undefined> {
  try {
    const url = `${LAYERZERO_SCAN_API_BASE}/messages/tx/${txHash}`;
    const response = await axios.get<MessageByTxResponse>(url);
    const data = response.data?.data;
    if (Array.isArray(data)) {
      return data[0];
    }
    return data;
  } catch (error) {
    console.warn(`Warning: unable to fetch status for tx ${txHash}: ${(error as Error).message}`);
    return undefined;
  }
}

async function waitForMessageDelivery(
  txHash: string,
  nonce: number,
  provider: ethers.Provider,
  gatewayAddress: string,
  expectedNextNonceBeforeExecution: number
): Promise<void> {
  const start = Date.now();

  while (true) {
    // Check contract's nextNonce - if it increased by 1, the message was successfully executed
    const currentNextNonce = await getExpectedNextNonce(provider, gatewayAddress);
    if (currentNextNonce === expectedNextNonceBeforeExecution + 1) {
      console.log(`  - Contract confirms: nextNonce increased from ${expectedNextNonceBeforeExecution} to ${currentNextNonce}`);
      console.log(`  - Message ${nonce} successfully executed (verified by contract state).`);
      return;
    }

    // Also check LayerZero Scan API as a secondary confirmation
    const message = await fetchMessageByTx(txHash);
    if (message) {
      const statusName = normalizeStatusName(message);
      console.log(`  - Scan status for nonce ${nonce}: ${statusName || "UNKNOWN"}`);

      if (isDeliveredStatus(message)) {
        console.log(`  - Message ${nonce} reported as delivered by LayerZero Scan.`);
        // Double-check contract state matches
        if (currentNextNonce === expectedNextNonceBeforeExecution + 1) {
          return;
        }
        // If contract state doesn't match yet, continue waiting
        console.log(`  - Waiting for contract state to update (current nextNonce: ${currentNextNonce}, expected: ${expectedNextNonceBeforeExecution + 1})...`);
      }

      if (isFailureStatus(message)) {
        throw new Error(`Message ${nonce} reported failure after manual execution (status: ${statusName}).`);
      }
    } else {
      console.log(`  - Waiting for LayerZero Scan to index tx ${txHash}...`);
      console.log(`  - Contract nextNonce: ${currentNextNonce} (expected: ${expectedNextNonceBeforeExecution + 1})`);
    }

    if (Date.now() - start > MESSAGE_POLL_TIMEOUT_MS) {
      throw new Error(`Timed out (${MESSAGE_POLL_TIMEOUT_MS / 1000}s) waiting for message ${nonce} to be confirmed.`);
    }

    await new Promise((resolve) => setTimeout(resolve, MESSAGE_POLL_INTERVAL_MS));
  }
}

async function waitForUserConfirmation(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write("Press Enter to start executing pending messages...");
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
  console.log();
}

/**
 * Check if a message matches the target pathway
 * Pathway is defined by: sender address, sender EID, receiver address, receiver EID
 */
function matchesTargetPathway(message: MessageData): boolean {
  const senderMatch = 
    message.pathway.sender.address.toLowerCase() === SENDER_ADDRESS.toLowerCase() &&
    message.pathway.srcEid === SENDER_EID;
  
  const receiverMatch = 
    message.pathway.receiver.address.toLowerCase() === RECEIVER_ADDRESS.toLowerCase() &&
    message.pathway.dstEid === RECEIVER_EID;
  
  return senderMatch && receiverMatch;
}

/**
 * Fetch messages from LayerZero Scan API
 * Note: The API returns all messages for the receiver OApp, so we need to filter by pathway
 */
async function fetchMessages(nextToken?: string, limit: number = 100): Promise<ApiResponse> {
  const url = `${LAYERZERO_SCAN_API_BASE}/messages/oapp/${RECEIVER_EID}/${RECEIVER_ADDRESS}`;
  const params: any = { limit };
  if (nextToken) {
    params.nextToken = nextToken;
  }
  
  console.log(`Fetching messages${nextToken ? ` (nextToken: ${nextToken.substring(0, 20)}...)` : ""}...`);
  
  const response = await axios.get<ApiResponse>(url, { params });
  return response.data;
}

/**
 * Fetch all messages matching the target pathway from LayerZero Scan API
 */
async function fetchAllMessages(): Promise<MessageData[]> {
  const allMessages: MessageData[] = [];
  let nextToken: string | undefined = undefined;
  let hasMorePages = true;
  let pageCount = 0;
  
  console.log("Fetching all messages from LayerZero Scan...");
  console.log(`Target pathway: ${SENDER_ADDRESS} (EID ${SENDER_EID}) -> ${RECEIVER_ADDRESS} (EID ${RECEIVER_EID})\n`);
  
  let totalFetched = 0;
  let totalFiltered = 0;
  
  while (hasMorePages) {
    pageCount++;
    let response: ApiResponse;
    try {
      response = await fetchMessages(nextToken);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log("Reached final page from LayerZero Scan (404).");
        break;
      }
      throw error;
    }
    
    // Process messages in reverse order (oldest first)
    const messages = [...response.data].reverse();
    totalFetched += messages.length;
    let pageFiltered = 0;
    
    for (const message of messages) {
      // Only process messages that match our target pathway
      if (!matchesTargetPathway(message)) {
        pageFiltered++;
        continue;
      }
      
      allMessages.push(message);
    }
    
    totalFiltered += pageFiltered;
    if (pageFiltered > 0) {
      console.log(`  Page ${pageCount}: ${messages.length} messages fetched, ${pageFiltered} filtered (not matching target pathway), ${messages.length - pageFiltered} processed`);
    }
    
    // Continue to next page if available
    if (response.nextToken) {
      nextToken = response.nextToken;
      hasMorePages = true;
    } else {
      hasMorePages = false;
    }
    
    // Safety limit to avoid infinite loops
    if (pageCount > 100) {
      console.warn("Reached page limit (100), stopping search");
      break;
    }
  }
  
  allMessages.sort((a, b) => a.pathway.nonce - b.pathway.nonce);
  
  console.log(`\nTotal: ${totalFetched} messages fetched, ${totalFiltered} filtered (not matching target pathway), ${allMessages.length} matching target pathway`);
  
  if (allMessages.length === 0) {
    console.log("\nNo messages found matching target pathway.");
    return [];
  }
  
  console.log(`Target pathway messages from nonce ${allMessages[0].pathway.nonce} to ${allMessages[allMessages.length - 1].pathway.nonce}`);
  
  // Write all messages to file for review
  const reviewPath = path.resolve(process.cwd(), "pending-messages.json");
  await fs.writeFile(reviewPath, JSON.stringify(allMessages, null, 2));
  console.log(`All fetched messages written to ${reviewPath}\n`);
  
  return allMessages;
}

/**
 * Get the expected next nonce from ImuachainGateway contract
 */
async function getExpectedNextNonce(
  provider: ethers.Provider,
  gatewayAddress: string
): Promise<number> {
  const gateway = new ethers.Contract(gatewayAddress, IMUACHAIN_GATEWAY_ABI, provider);
  const senderBytes32 = addressToBytes32(SENDER_ADDRESS);
  const nextNonce = await gateway.nextNonce(SENDER_EID, senderBytes32);
  return Number(nextNonce);
}

/**
 * Find a message by nonce from the collected messages
 */
function findMessageByNonce(messages: MessageData[], nonce: number): MessageData | undefined {
  return messages.find(m => m.pathway.nonce === nonce);
}

/**
 * Check if there are any pending messages (inflight or failed) with nonce higher than the given nonce
 */
function hasPendingMessagesAfterNonce(messages: MessageData[], nonce: number): boolean {
  return messages.some(m => 
    m.pathway.nonce > nonce && 
    !isDeliveredStatus(m) &&
    (isFailureStatus(m) || normalizeStatusName(m) === "INFLIGHT" || normalizeStatusName(m) === "WAITING")
  );
}

/**
 * Get the highest nonce from messages that are pending (not delivered)
 */
function getHighestPendingNonce(messages: MessageData[]): number | undefined {
  const pendingMessages = messages.filter(m => 
    !isDeliveredStatus(m) &&
    (isFailureStatus(m) || normalizeStatusName(m) === "INFLIGHT" || normalizeStatusName(m) === "WAITING")
  );
  
  if (pendingMessages.length === 0) {
    return undefined;
  }
  
  return Math.max(...pendingMessages.map(m => m.pathway.nonce));
}

/**
 * Convert address to bytes32
 */
function addressToBytes32(address: string): string {
  return ethers.zeroPadValue(address, 32);
}

/**
 * Execute lzReceive for a failed message
 */
async function executeLzReceive(
  provider: ethers.Provider,
  wallet: ethers.Wallet,
  endpointAddress: string,
  message: MessageData
): Promise<string> {
  const endpoint = new ethers.Contract(endpointAddress, ENDPOINT_ABI, wallet);
  
  // Extract data from message
  const srcEid = message.pathway.srcEid;
  const senderAddress = message.pathway.sender.address;
  const nonce = message.pathway.nonce;
  const receiver = message.pathway.receiver.address;
  let guid = message.guid;
  let payload = message.source.tx.payload || message.source.tx.resolvedPayload;
  const extraData = "0x";
  
  // Validate data
  if (!srcEid || srcEid === 0) {
    throw new Error(`Invalid srcEid: ${srcEid}`);
  }
  if (!senderAddress || senderAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Invalid sender address: ${senderAddress}`);
  }
  if (nonce === undefined || nonce === null) {
    throw new Error(`Invalid nonce: ${nonce}`);
  }
  if (!receiver || receiver.toLowerCase() !== RECEIVER_ADDRESS.toLowerCase()) {
    throw new Error(`Invalid receiver: ${receiver}, expected ${RECEIVER_ADDRESS}`);
  }
  
  // Verify the message matches our target pathway
  if (!matchesTargetPathway(message)) {
    throw new Error(
      `Message does not match target pathway. ` +
      `Expected: sender ${SENDER_ADDRESS} (EID ${SENDER_EID}) -> receiver ${RECEIVER_ADDRESS} (EID ${RECEIVER_EID}), ` +
      `Got: sender ${senderAddress} (EID ${srcEid}) -> receiver ${receiver} (EID ${message.pathway.dstEid})`
    );
  }
  
  // Ensure GUID is properly formatted (should be 66 chars: 0x + 64 hex chars)
  if (!guid || guid.length !== 66) {
    throw new Error(`Invalid GUID format: ${guid} (expected 66 characters)`);
  }
  
  // Ensure payload is properly formatted hex string
  if (!payload || payload === "0x") {
    throw new Error(`Invalid payload: ${payload}`);
  }
  if (!payload.startsWith("0x")) {
    payload = "0x" + payload;
  }
  
  // Convert sender address to bytes32
  const sender = addressToBytes32(senderAddress);
  
  // Construct Origin struct
  const origin: Origin = {
    srcEid,
    sender,
    nonce
  };
  
  console.log(`Executing lzReceive for message:`);
  console.log(`  - GUID: ${guid}`);
  console.log(`  - Nonce: ${nonce}`);
  console.log(`  - SrcEid: ${srcEid}`);
  console.log(`  - Sender: ${senderAddress} -> ${sender}`);
  console.log(`  - Receiver: ${receiver}`);
  console.log(`  - Payload length: ${payload.length / 2 - 1} bytes`);
  
  // Call lzReceive
  try {
    const tx = await endpoint.lzReceive(origin, receiver, guid, payload, extraData, {
      gasLimit: 6000000 // Set a high gas limit
    });
    
    console.log(`  - Transaction hash: ${tx.hash}`);
    console.log(`  - Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    console.log(`  - Confirmed in block: ${receipt.blockNumber}`);
    console.log(`  - Gas used: ${receipt.gasUsed.toString()}`);
    
    return tx.hash;
  } catch (error: any) {
    console.error(`  - Error executing lzReceive:`, error.message);
    if (error.data) {
      console.error(`  - Error data:`, error.data);
    }
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  console.log("=== LayerZero Message Resumption Script ===\n");
  console.log(`Target Pathway:`);
  console.log(`  Sender: ${SENDER_ADDRESS} (EID: ${SENDER_EID})`);
  console.log(`  Receiver: ${RECEIVER_ADDRESS} (EID: ${RECEIVER_EID})`);
  console.log(`RPC URL: ${RESOLVED_RPC_URL}\n`);
  
  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(RESOLVED_RPC_URL);
  const wallet = new ethers.Wallet(RESOLVED_PRIVATE_KEY, provider);
  console.log(`Wallet Address: ${wallet.address}\n`);
  
  // Get endpoint address from receiver OApp
  const oapp = new ethers.Contract(RECEIVER_ADDRESS, OAPP_CORE_ABI, provider);
  const endpointAddress = await oapp.endpoint();
  console.log(`Endpoint Address: ${endpointAddress}\n`);
  
  // Get the gateway address (same as receiver address for ImuachainGateway)
  const gatewayAddress = RECEIVER_ADDRESS;
  
  // Fetch all messages matching the target pathway
  const allMessages = await fetchAllMessages();
  
  if (allMessages.length === 0) {
    console.log("No messages found matching target pathway. Exiting.");
    return;
  }
  
  // Get the highest pending nonce to track progress
  const highestPendingNonce = getHighestPendingNonce(allMessages);
  if (highestPendingNonce !== undefined) {
    console.log(`Highest pending nonce in collected messages: ${highestPendingNonce}`);
  }
  
  // Ask for confirmation before starting the loop
  console.log("\nReady to process pending messages. Review pending-messages.json and press Ctrl+C to abort.\n");
  await waitForUserConfirmation();
  
  // Loop: execute messages until all are processed or a gap is detected
  let executionCount = 0;
  console.log("\n=== Processing Messages ===\n");
  
  while (true) {
    // Get the expected next nonce from the contract
    const expectedNextNonce = await getExpectedNextNonce(provider, gatewayAddress);
    console.log(`\n[Iteration ${executionCount + 1}] Expected next nonce from ImuachainGateway: ${expectedNextNonce}`);
    
    // Find the message with the expected nonce
    const messageToExecute = findMessageByNonce(allMessages, expectedNextNonce);
    
    if (!messageToExecute) {
      // Check if there are pending messages with higher nonces
      const hasPending = hasPendingMessagesAfterNonce(allMessages, expectedNextNonce - 1);
      
      if (hasPending) {
        const highestPending = getHighestPendingNonce(allMessages);
        console.error(`\n⚠️  ALERT: Missing message detected!`);
        console.error(`  - Expected next nonce: ${expectedNextNonce}`);
        console.error(`  - But there are pending messages with higher nonces (up to ${highestPending})`);
        console.error(`  - This means message with nonce ${expectedNextNonce} is missing from the API response`);
        console.error(`  - Cannot proceed safely - stopping execution`);
        process.exit(1);
      } else {
        console.log(`\n✓ No message found with nonce ${expectedNextNonce}, and no pending messages with higher nonces.`);
        console.log(`✓ All messages have been successfully processed!`);
        break;
      }
    }
    
    // Check if the message is already delivered
    if (isDeliveredStatus(messageToExecute)) {
      console.log(`  - Message with nonce ${expectedNextNonce} is already delivered, skipping...`);
      // Continue to check for next message
      continue;
    }
    
    // Check if we've reached the highest pending nonce
    if (highestPendingNonce !== undefined && expectedNextNonce > highestPendingNonce) {
      console.log(`\n✓ Reached highest pending nonce (${highestPendingNonce}). All pending messages processed!`);
      break;
    }
    
    // Execute the message
    console.log(`\n  Found message to execute:`);
    console.log(`    - Nonce: ${messageToExecute.pathway.nonce}`);
    console.log(`    - GUID: ${messageToExecute.guid}`);
    console.log(`    - Status: ${messageToExecute.status?.name || "N/A"}`);
    console.log(`    - Destination status: ${messageToExecute.destination.status || "N/A"}`);
    
    try {
      const expectedNextNonceBeforeExecution = expectedNextNonce;
      const txHash = await executeLzReceive(provider, wallet, endpointAddress, messageToExecute);
      console.log(`  ✓ Transaction sent: ${txHash}`);
      
      // Wait for message delivery (checks both contract state and LayerZero Scan)
      await waitForMessageDelivery(txHash, expectedNextNonce, provider, gatewayAddress, expectedNextNonceBeforeExecution);
      
      console.log(`  ✓ Successfully executed and confirmed message with nonce ${expectedNextNonce}`);
      executionCount++;
      
      // Small delay before processing next message
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
    } catch (error: any) {
      console.error(`  ✗ Failed to execute message with nonce ${expectedNextNonce}:`, error.message);
      console.error("Stopping execution. Please check the error and retry if needed.");
      process.exit(1);
    }
  }
  
  console.log("\n=== All Messages Processed ===");
  console.log(`Successfully executed ${executionCount} message(s).`);
}

// Run the script
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

