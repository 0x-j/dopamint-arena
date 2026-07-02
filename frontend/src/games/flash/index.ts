import { register } from "../registry";
import { FlashWindow } from "./FlashWindow";

register({
  id: "flash",
  name: "Flash",
  icon: "⚡",
  image: "/games/flash.png",
  Window: FlashWindow,
  catalog: true,
  arenaGameId: "flash",
});
