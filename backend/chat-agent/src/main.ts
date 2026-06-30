import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromB64 } from "@mysten/sui/utils";
import { setTimeout as sleep } from "node:timers/promises";
import { runBotVsBot } from "./botVsBot.ts";
import { loadConfig } from "./config.ts";
import {
  ensureDopamintBalance,
  ensureDopamintBalanceForAddress,
} from "./funding.ts";
import { MpClient, resolveMpWsUrl } from "./mpClient.ts";
import {
  OllamaBackendClient,
  registerChatSessionWithRetry,
} from "./ollama.ts";

export function buildMpUrl(backendUrl: string): string {
  return `${resolveMpWsUrl(backendUrl)}/v1/mp`;
}

function createSuiClient(rpcUrl: string): SuiClient {
  return new SuiClient({ url: rpcUrl || getFullnodeUrl("testnet") });
}

export async function main(): Promise<void> {
  console.log("[chat-agent] loading config...");
  const cfg = loadConfig();
  console.log(
    "[chat-agent] config loaded, operator=derived-from-keypair",
  );
  const operatorKeypair = Ed25519Keypair.fromSecretKey(
    fromB64(cfg.operatorKey),
  );
  const operatorAddress = operatorKeypair.toSuiAddress();
  const bobKeypair = Ed25519Keypair.generate();
  const bobAddress = bobKeypair.toSuiAddress();
  console.log("[chat-agent] operator address:", operatorAddress);
  console.log("[chat-agent] bob address:", bobAddress);
  const sui = createSuiClient(cfg.suiRpcUrl);
  console.log("[chat-agent] registering chat session...");
  const chatSession = await registerChatSessionWithRetry(
    cfg.backendUrl,
    operatorAddress,
  );
  console.log("[chat-agent] chat session:", chatSession.sessionId);
  const ollama = new OllamaBackendClient(
    cfg.ollamaUrl,
    cfg.backendUrl,
    cfg.ollamaModel,
    cfg.ollamaSpeed,
    chatSession.sessionId,
    chatSession.statsToken,
  );

  const botNeed = BigInt(cfg.stakeRaw) * 2n;
  console.log("[chat-agent] ensuring DOPAMINT balance...");
  await ensureDopamintBalance(sui, cfg, operatorKeypair, botNeed);
  await ensureDopamintBalanceForAddress(
    sui,
    cfg,
    operatorKeypair,
    bobAddress,
    botNeed,
  );
  console.log("[chat-agent] balance ok");

  const aliceWallet = operatorAddress;
  const bobWallet = bobAddress;
  const intervalMs = Number(process.env.CHAT_BOT_VS_BOT_INTERVAL_MS ?? "30000");

  let tunnelCounter = 0;
  const tunnelIdProvider = () => {
    tunnelCounter += 1;
    return `${cfg.dopamintPackageId}::chat::Tunnel-${Date.now()}-${tunnelCounter}`;
  };

  while (true) {
    console.log("[chat-agent] fetching topic...");
    const topic = await ollama.topic();
    console.log("[chat-agent] topic:", topic);
    const alice = new MpClient(buildMpUrl(cfg.backendUrl), aliceWallet);
    const bob = new MpClient(buildMpUrl(cfg.backendUrl), bobWallet);

    try {
      console.log("[chat-agent] starting bot-vs-bot round...");
      const result = await runBotVsBot({
        alice,
        bob,
        ollama,
        topic,
        tunnelIdProvider,
        maxMoves: 6,
      });
      console.log("[chat-agent] bot-vs-bot complete:", result);
    } catch (e) {
      console.error("[chat-agent] bot-vs-bot round failed:", e);
    }

    console.log("[chat-agent] sleeping", intervalMs, "ms");
    await sleep(intervalMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
