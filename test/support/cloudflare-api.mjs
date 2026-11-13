// Preloaded (`node --import`) into a generated Site's deploy wrapper by tests:
// the deploy guards read the account's Alchemy state store and the Frontend
// Worker through the Cloudflare API. This answers as an account whose store
// runs v8 and has no Frontend Worker yet; nothing leaves the machine.
globalThis.fetch = async (url) => {
  const target = String(url);
  if (!target.startsWith("https://api.cloudflare.com/client/v4/accounts/")) {
    throw new Error(`unexpected fetch: ${target}`);
  }
  if (target.endsWith("/workers/scripts/alchemy-state-store/settings")) {
    const bindings = [{ name: "ALCHEMY_STATE_STORE_VERSION", type: "plain_text", text: "8" }];
    return new Response(JSON.stringify({ success: true, result: { bindings } }));
  }
  return new Response(JSON.stringify({ success: false, errors: [{ code: 10007 }] }), {
    status: 404,
  });
};
