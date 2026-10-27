import start from "@tanstack/react-start/server-entry";
import { consent } from "./site.server";

export default {
  fetch: start.fetch,
  scheduled(_event: ScheduledController, _env: unknown, context: ExecutionContext) {
    context.waitUntil(consent.purge());
  },
};
