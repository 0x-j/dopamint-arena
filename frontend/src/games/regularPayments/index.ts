import { register } from "../registry";
import { PaymentsWindow } from "./components/PaymentsWindow";

register({
  id: "regular-payments",
  name: "Regular Payments",
  catalog: true,
  workspace: "payment",
  icon: "🛒",
  image: "/games/payment.png",
  Window: PaymentsWindow,
});
