import type { GameWindowProps } from "../../../types";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { PaymentsLobby } from "../PaymentsLobby";
import { PaymentsShop } from "../PaymentsShop";
import { PaymentsThankYou } from "../PaymentsThankYou";

export function PaymentsWindow({ windowId }: GameWindowProps) {
  const session = useRegularPaymentsSession(windowId);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col text-foreground">
      {session.screen === "lobby" && <PaymentsLobby session={session} />}

      {session.screen === "shop" && <PaymentsShop session={session} />}

      {session.screen === "thankYou" && <PaymentsThankYou session={session} />}
    </div>
  );
}
