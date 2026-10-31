// What only a content Site has, refused on a commerce Site by name (ADR
// 0017): a commerce Site has no publication store and no publication
// events, so running a content command there would prove nothing or report
// the wrong thing.

export function isCommerce(ops) {
  return ops?.variant === "commerce";
}

// Throws for `command` on a commerce Site, saying why.
export function refuseOnCommerce(ops, command, reason) {
  if (isCommerce(ops)) throw new Error(`${command} isn't for a commerce Site: ${reason}`);
}
