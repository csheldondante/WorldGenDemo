import { registerCactus } from "./proceduralCactus";
import { registerPine } from "./proceduralPine";
import { registerBoulder } from "./proceduralBoulder";
import { registerShanty } from "./proceduralShanty";
import { registerBridge } from "./proceduralBridge";

let registered = false;

export function registerBuiltinAssets() {
  if (registered) return;
  registered = true;
  registerCactus();
  registerPine();
  registerBoulder();
  registerShanty();
  registerBridge();
}
