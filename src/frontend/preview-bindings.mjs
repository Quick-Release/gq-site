// Shared by manifest validation and managed deploy entrypoints. Never include
// input values in errors: the environment can contain credentials.
export function validPreviewUrl(value, audience = false) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      value === (audience ? `${url.origin}/gq/preview` : url.origin)
    );
  } catch {
    return false;
  }
}

export function previewBindings(ops, env, redact) {
  const id = env.GQ_PREVIEW_ACCESS_CLIENT_ID;
  const secret = env.GQ_PREVIEW_ACCESS_CLIENT_SECRET;
  if (
    (id !== undefined || secret !== undefined) &&
    (typeof id !== "string" || !id.trim() || typeof secret !== "string" || !secret.trim())
  ) {
    throw new Error(
      "GQ_PREVIEW_ACCESS_CLIENT_ID and GQ_PREVIEW_ACCESS_CLIENT_SECRET must be nonempty and set together.",
    );
  }
  if (ops.preview === undefined) {
    if (id !== undefined || secret !== undefined) {
      throw new Error("Preview Access secrets require preview.cmsUrl and preview.audience.");
    }
    return {};
  }
  if (!validPreviewUrl(ops.preview?.cmsUrl) || !validPreviewUrl(ops.preview?.audience, true)) {
    throw new Error(
      "preview.cmsUrl must be an exact HTTPS origin and preview.audience an exact HTTPS /gq/preview URL.",
    );
  }
  return {
    GQ_PREVIEW_CMS_URL: ops.preview.cmsUrl,
    GQ_PREVIEW_AUDIENCE: ops.preview.audience,
    ...(id && secret
      ? {
          GQ_PREVIEW_ACCESS_CLIENT_ID: redact(id),
          GQ_PREVIEW_ACCESS_CLIENT_SECRET: redact(secret),
        }
      : {}),
  };
}
