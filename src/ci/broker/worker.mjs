// The GETQUICK CI token broker's Worker entry (gq-platform ADR 0012); the
// broker itself is broker.mjs. A Worker module's named exports are taken as
// entrypoints, so this one exports only its handler.
import { handleRequest } from "./broker.mjs";

export default { fetch: handleRequest };
