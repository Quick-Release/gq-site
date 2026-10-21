/** Site-owned loader boundary. Never serialize the original cause into the public document. */
export function publicRouteError(error: unknown): never {
  // Router handles redirect()/notFound() before onError; their statuses remain unchanged.
  if (import.meta.env.SSR) console.error("Public page loader failed", error);
  throw new Error("Temporarily unavailable");
}
