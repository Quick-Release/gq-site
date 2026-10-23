import assert from "node:assert/strict";
import test from "node:test";
import { previewBindings } from "../../src/frontend/preview-bindings.mjs";
import { validateManifest } from "../../src/manifest/manifest.mjs";

const preview = { cmsUrl: "https://cms.example", audience: "https://www.example/gq/preview" };
const manifest = { schemaVersion: 1, project: "example", variant: "content" };
test("preview is opt-in and config becomes server bindings with dedicated secrets", () => {
  assert.deepEqual(
    previewBindings({}, {}, (value) => ({ redacted: value })),
    {},
  );
  assert.deepEqual(validateManifest({ ...manifest, preview }).preview, preview);
  assert.deepEqual(
    previewBindings(
      { preview },
      {
        GQ_PREVIEW_ACCESS_CLIENT_ID: "preview-id",
        GQ_PREVIEW_ACCESS_CLIENT_SECRET: "preview-secret",
        GQ_AUTH_GRAPHQL_CLIENT_ID: "graphql-id",
      },
      (value) => ({ redacted: value }),
    ),
    {
      GQ_PREVIEW_CMS_URL: preview.cmsUrl,
      GQ_PREVIEW_AUDIENCE: preview.audience,
      GQ_PREVIEW_ACCESS_CLIENT_ID: { redacted: "preview-id" },
      GQ_PREVIEW_ACCESS_CLIENT_SECRET: { redacted: "preview-secret" },
    },
  );
});

test("malformed or partial preview config fails without disclosing values", () => {
  for (const invalid of [
    null,
    false,
    0,
    "",
    {},
    { cmsUrl: preview.cmsUrl },
    { audience: preview.audience },
    ...[
      "http://cms.example",
      "https://cms.example/",
      "https://cms.example/path",
      "https://user:password@cms.example",
      "https://cms.example?",
      "https://cms.example#",
      " https://cms.example",
    ].map((cmsUrl) => ({ ...preview, cmsUrl })),
    ...[
      "https://www.example",
      "https://www.example/gq/preview/",
      "https://www.example/gq/preview?q=x",
      "http://www.example/gq/preview",
    ].map((audience) => ({ ...preview, audience })),
  ]) {
    assert.throws(() => validateManifest({ ...manifest, preview: invalid }), /preview/u);
    assert.throws(() => previewBindings({ preview: invalid }, {}, String), /preview/u);
  }
  for (const env of [
    { GQ_PREVIEW_ACCESS_CLIENT_ID: "sensitive-value" },
    { GQ_PREVIEW_ACCESS_CLIENT_SECRET: "sensitive-value" },
    { GQ_PREVIEW_ACCESS_CLIENT_ID: "", GQ_PREVIEW_ACCESS_CLIENT_SECRET: "sensitive-value" },
  ]) {
    assert.throws(
      () => previewBindings({ preview }, env, String),
      (error) =>
        /must be nonempty and set together/u.test(error.message) &&
        !error.message.includes("sensitive-value"),
    );
  }
  assert.throws(
    () =>
      previewBindings(
        {},
        {
          GQ_PREVIEW_ACCESS_CLIENT_ID: "sensitive-value",
          GQ_PREVIEW_ACCESS_CLIENT_SECRET: "sensitive-value",
        },
        String,
      ),
    /require preview/u,
  );
  assert.deepEqual(previewBindings({ preview }, {}, String), {
    GQ_PREVIEW_CMS_URL: "https://cms.example",
    GQ_PREVIEW_AUDIENCE: "https://www.example/gq/preview",
  });
});
