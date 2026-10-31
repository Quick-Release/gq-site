// The fleet's register of rate-limit namespace IDs
// (blueprint/rate-limit-namespaces.json): which Site holds which ID in which
// Cloudflare account, and the IDs reserved for documentation and tests. A
// namespace's counters are shared by every Worker that binds its ID in the
// account, so a commerce Site's cloudflare.rateLimitNamespaces must be its
// own: gq doctor warns about what this finds.
import register from "../../blueprint/rate-limit-namespaces.json" with { type: "json" };

export { register as rateLimitRegister };

// What is wrong with a validated manifest's rate-limit namespaces, as
// messages: an ID reserved for documentation, an ID another Site holds in
// the same account, one ID bound twice by the Site, and IDs the register
// doesn't list for it (it should be added before the Site deploys with
// them). Nothing for a Site without rateLimitNamespaces.
export function rateLimitNamespaceProblems(config) {
  const namespaces = Object.entries(config.cloudflare?.rateLimitNamespaces ?? {});
  if (namespaces.length === 0) return [];
  const account = config.cloudflare?.accountId;
  const allocations = (account && register.accounts[account]) || [];
  const problems = [];
  const unregistered = new Set();
  const seen = new Map();
  for (const [binding, id] of namespaces) {
    const where = `cloudflare.rateLimitNamespaces.${binding} (${id})`;
    if (seen.has(id)) {
      problems.push(`${where} is also ${seen.get(id)}'s: the two limiters would share counters`);
    }
    seen.set(id, binding);
    const reserved = register.reserved.find(({ from, to }) => id >= from && id <= to);
    if (reserved) {
      problems.push(`${where} is reserved for ${reserved.use}: take unused IDs from the register`);
      continue;
    }
    const holders = allocations.filter(({ namespaces: ids }) => Object.values(ids).includes(id));
    const others = holders.filter(({ project }) => project !== config.project);
    if (others.length > 0) {
      problems.push(
        `${where} is ${others.map(({ project }) => project).join(" and ")}'s in Cloudflare account ${account}: the Sites would share its counters`,
      );
    } else if (holders.length === 0) unregistered.add(id);
  }
  if (unregistered.size > 0) {
    const ids = [...unregistered];
    problems.push(
      `rate-limit namespace ${ids.join(", ")} ${ids.length === 1 ? "isn't" : "aren't"} in the fleet's register${account ? ` for Cloudflare account ${account}` : ""}: add ${config.project}'s to @getquick/site blueprint/rate-limit-namespaces.json`,
    );
  }
  return problems;
}
