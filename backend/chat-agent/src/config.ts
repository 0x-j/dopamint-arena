import "dotenv/config";

export interface OllamaSpeedOptions {
  /** Cap on generated tokens per chat reply (lower = faster). */
  numPredict: number;
  /** Token cap for topic generation (kept small). */
  topicPredict: number;
  /** Context window in tokens; smaller windows process prompts faster. */
  numCtx: number;
  /** How long Ollama keeps the model resident between calls. */
  keepAlive: string;
}

export interface ChatAgentConfig {
  suiRpcUrl: string;
  backendUrl: string;
  tunnelPackageId: string;
  dopamintPackageId: string;
  dopamintFaucetId: string;
  dopamintCoinType: string;
  operatorKey: string;
  ollamaModel: string;
  ollamaUrl: string;
  ollamaSpeed: OllamaSpeedOptions;
  stakeRaw: bigint;
  botPoolSize: number;
  botVsBotEnabled: boolean;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export function loadConfig(): ChatAgentConfig {
  const whole = BigInt(process.env.CHAT_STAKE_WHOLE_TOKENS ?? "1");
  return {
    suiRpcUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443",
    backendUrl: getEnv("BACKEND_URL"),
    tunnelPackageId: getEnv("TUNNEL_PACKAGE_ID"),
    dopamintPackageId: getEnv("DOPAMINT_PACKAGE_ID"),
    dopamintFaucetId: getEnv("DOPAMINT_FAUCET_ID"),
    dopamintCoinType: getEnv("DOPAMINT_COIN_TYPE"),
    operatorKey: getEnv("SUI_SETTLER_KEY"),
    ollamaModel: process.env.CHAT_OLLAMA_MODEL ?? "qwen2.5:1.5b",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaSpeed: {
      numPredict: Number(process.env.CHAT_OLLAMA_NUM_PREDICT ?? "64"),
      topicPredict: Number(process.env.CHAT_OLLAMA_TOPIC_PREDICT ?? "24"),
      numCtx: Number(process.env.CHAT_OLLAMA_NUM_CTX ?? "2048"),
      keepAlive: process.env.CHAT_OLLAMA_KEEP_ALIVE ?? "30m",
    },
    stakeRaw: whole * 10n ** 9n, // 9 decimals
    botPoolSize: Number(process.env.CHAT_BOT_POOL_SIZE ?? "3"),
    botVsBotEnabled: (process.env.CHAT_BOT_VS_BOT_ENABLED ?? "true") === "true",
  };
}
