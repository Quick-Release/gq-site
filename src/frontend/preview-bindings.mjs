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
  const user = env.GQ_PREVIEW_CMS_USERNAME;
  const password = env.GQ_PREVIEW_CMS_APPLICATION_PASSWORD;
  const id = env.GQ_PREVIEW_ACCESS_CLIENT_ID;
  const secret = env.GQ_PREVIEW_ACCESS_CLIENT_SECRET;
  if (
    (id !== undefined || secret !== undefined) &&
    (typeof id !== "string" ||
      !id.trim() ||
      id !== id.trim() ||
      typeof secret !== "string" ||
      !secret.trim() ||
      secret !== secret.trim())
  ) {
    throw new Error(
      "GQ_PREVIEW_ACCESS_CLIENT_ID and GQ_PREVIEW_ACCESS_CLIENT_SECRET must be nonempty and set together, without surrounding whitespace.",
    );
  }
  if (ops.preview === undefined) {
    if (id !== undefined || secret !== undefined || user !== undefined || password !== undefined) {
      throw new Error("Preview secrets require preview.cmsUrl and preview.audience.");
    }
    return {};
  }
  if (!validPreviewUrl(ops.preview?.cmsUrl) || !validPreviewUrl(ops.preview?.audience, true)) {
    throw new Error(
      "preview.cmsUrl must be an exact HTTPS origin and preview.audience an exact HTTPS /gq/preview URL.",
    );
  }
  if (
    typeof user !== "string" ||
    !user.trim() ||
    user !== user.trim() ||
    /[:\r\n]/u.test(user) ||
    typeof password !== "string" ||
    !password.trim() ||
    password !== password.trim() ||
    /[\r\n]/u.test(password)
  ) {
    throw new Error(
      "GQ_PREVIEW_CMS_USERNAME and GQ_PREVIEW_CMS_APPLICATION_PASSWORD must be nonempty and set together; username cannot contain a colon and credentials cannot contain newlines or surrounding whitespace.",
    );
  }
  return {
    GQ_PREVIEW_CMS_USERNAME: redact(user),
    GQ_PREVIEW_CMS_APPLICATION_PASSWORD: redact(password),
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
