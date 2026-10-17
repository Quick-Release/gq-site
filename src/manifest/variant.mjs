// What only a content Site has, refused on a commerce Site by name (ADR
// 0017): a commerce Site has no publication store, no publication events
// and no readiness gate yet, so running a content command there would prove
// nothing or report the wrong thing.

export const COMMERCE_READINESS_ISSUE = "https://github.com/Quick-Release/gq-site/issues/26";

export function isCommerce(ops) {
  return ops?.variant === "commerce";
}

// Throws for `command` on a commerce Site, saying why.
export function refuseOnCommerce(ops, command, reason) {
  if (isCommerce(ops)) throw new Error(`${command} isn't for a commerce Site: ${reason}`);
}
