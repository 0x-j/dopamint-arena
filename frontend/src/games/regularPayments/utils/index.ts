import { MTPS_DECIMALS } from "@/onchain/mtps";

const ONE_MTPS = 10n ** BigInt(MTPS_DECIMALS);

export function formatMtps(raw: bigint, dp = 4): string {
  const whole = raw / ONE_MTPS;
  const frac = (raw % ONE_MTPS)
    .toString()
    .padStart(MTPS_DECIMALS, "0")
    .slice(0, dp)
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

export function formatGrammarLength(text: string, amount: number) {
  const grammar = amount >= 1 ? "s" : "";

  return `${text}${grammar}`;
}
