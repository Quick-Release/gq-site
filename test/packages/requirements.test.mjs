// The blueprint's GETQUICK Composer pins satisfy one another: what each
// pinned version requires (blueprint/package-requirements.json, recorded
// from the registry) accepts every other pin, in both CMS skeletons. 0.29.0
// pinned getquick/gq-design 0.9.4 beside getquick-theme 0.5.1 and
// getquick-ecommerce 0.3.5, which require ^0.3.1, so neither skeleton's
// composer install could resolve; this suite fails on such a combination
// without the network.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ownCatalogue from "../../blueprint/packages.json" with { type: "json" };
import ownRequirements from "../../blueprint/package-requirements.json" with { type: "json" };
import ownCommerce from "../../blueprint/templates/commerce/apps/cms/composer.json" with { type: "json" };
import ownContent from "../../blueprint/templates/apps/cms/composer.json" with { type: "json" };
import ownNpm from "../../blueprint/templates/fragments/commerce-frontend-package.keys.json" with { type: "json" };
import { catalogueProblems, loadCatalogue } from "../../src/packages/catalogue.mjs";
import { parseVersion, satisfiesConstraint } from "../../src/packages/versions.mjs";

const CONTENT_FILE = "templates/apps/cms/composer.json";
const COMMERCE_FILE = "templates/commerce/apps/cms/composer.json";
const BLUEPRINT = fileURLToPath(new URL("../../blueprint/", import.meta.url));

function composers(content = ownContent, commerce = ownCommerce) {
  return [
    { file: CONTENT_FILE, variants: ["content"], json: content },
    { file: COMMERCE_FILE, variants: ["commerce"], json: commerce },
  ];
}

function problems({ catalogue = ownCatalogue, content, commerce, requirements } = {}) {
  return catalogueProblems(catalogue, content ?? ownContent, ownNpm, {
    composers: composers(content, commerce),
    requirements: requirements ?? ownRequirements,
  });
}

function withPins(composer, pins) {
  return { ...composer, require: { ...composer.require, ...pins } };
}

test("the shipped pins agree with their recorded requirements in both CMS skeletons", async () => {
  assert.deepEqual(problems(), []);
  const loaded = await loadCatalogue({ directory: BLUEPRINT, root: BLUEPRINT });
  assert.deepEqual(
    loaded.composers.map(({ file, variants }) => [file, variants]),
    [
      [CONTENT_FILE, ["content"]],
      [COMMERCE_FILE, ["commerce"]],
    ],
  );
  assert.equal(loaded.catalogue.requirementsFile, "package-requirements.json");

  // Every GETQUICK package either skeleton pins is catalogued and recorded
  // at its pin, and both skeletons pin it alike.
  for (const composer of [ownContent, ownCommerce]) {
    for (const [name, pin] of Object.entries(composer.require)) {
      if (!name.startsWith("getquick/")) continue;
      assert.ok(
        ownCatalogue.packages.some((pkg) => pkg.name === name),
        `${name} is catalogued`,
      );
      assert.equal(ownRequirements.packages[name]?.version, pin, `${name} is recorded at ${pin}`);
    }
  }
  for (const [name, pin] of Object.entries(ownContent.require)) {
    if (name.startsWith("getquick/") && Object.hasOwn(ownCommerce.require, name)) {
      assert.equal(ownCommerce.require[name], pin, `${name} is pinned alike`);
    }
  }
});

test("every pinned package's requirement on GQ Design accepts the lockstep pin", () => {
  const pin = ownContent.require["getquick/gq-design"];
  assert.equal(ownCommerce.require["getquick/gq-design"], pin);
  const group = ownCatalogue.packages.filter((pkg) => pkg.lockstep === "gq-design");
  assert.ok(group.length > 1);
  const dependents = Object.entries(ownRequirements.packages).filter(([, record]) =>
    Object.hasOwn(record.require, "getquick/gq-design"),
  );
  assert.ok(
    dependents.some(([name]) => name === "getquick/getquick-theme"),
    "getquick-theme declares its Design requirement",
  );
  assert.ok(
    dependents.some(([name]) => name === "getquick/getquick-ecommerce"),
    "getquick-ecommerce declares its Design requirement",
  );
  for (const [name, record] of dependents) {
    const constraint = record.require["getquick/gq-design"];
    assert.equal(
      satisfiesConstraint(parseVersion(pin), constraint),
      true,
      `${name} ${record.version} requires getquick/gq-design ${constraint}, which must accept ${pin}`,
    );
  }
});

test("0.29.1's pins are refused: GQ Design 0.9.4 beside packages that require ^0.3.1", () => {
  const theme = {
    version: "0.5.1",
    require: {
      "getquick/gq-config": "^0.4.0",
      "getquick/gq-design": "^0.3.1",
      "getquick/gq-support": "^0.1.0",
    },
  };
  const ecommerce = { version: "0.3.5", require: { "getquick/gq-design": "^0.3.1" } };
  const requirements = structuredClone(ownRequirements);
  requirements.packages["getquick/getquick-theme"] = theme;
  requirements.packages["getquick/getquick-ecommerce"] = ecommerce;
  const old = { "getquick/getquick-theme": "0.5.1" };
  assert.deepEqual(
    problems({
      requirements,
      content: withPins(ownContent, old),
      commerce: withPins(ownCommerce, { ...old, "getquick/getquick-ecommerce": "0.3.5" }),
    }),
    [
      `getquick/getquick-ecommerce 0.3.5 requires getquick/gq-design ^0.3.1, but ${COMMERCE_FILE} pins getquick/gq-design 0.9.4: Composer can't install them together.`,
      `getquick/getquick-theme 0.5.1 requires getquick/gq-design ^0.3.1, but ${CONTENT_FILE} pins getquick/gq-design 0.9.4: Composer can't install them together.`,
      `getquick/getquick-theme 0.5.1 requires getquick/gq-design ^0.3.1, but ${COMMERCE_FILE} pins getquick/gq-design 0.9.4: Composer can't install them together.`,
    ],
  );
});

test("a pin moved without its record, a stale or missing record, and an unpinned requirement are refused", () => {
  const moved = withPins(ownContent, { "getquick/gq-support": "0.1.9" });
  assert.deepEqual(problems({ content: moved }), [
    `getquick/gq-support is pinned to different versions: 0.1.9 in ${CONTENT_FILE}, 0.1.10 in ${COMMERCE_FILE}.`,
    "package-requirements.json records what getquick/gq-support 0.1.10 requires, but the blueprint pins 0.1.9: record 0.1.9's requirements (gq packages check shows them).",
  ]);

  const stale = structuredClone(ownRequirements);
  stale.packages["getquick/gq-polylang-graphql"] = { version: "0.1.0", require: {} };
  delete stale.packages["getquick/gq-content"];
  assert.deepEqual(problems({ requirements: stale }), [
    "package-requirements.json doesn't record what getquick/gq-content 0.4.2 requires.",
    "package-requirements.json records getquick/gq-polylang-graphql, which the blueprint doesn't pin.",
  ]);

  const unpinned = structuredClone(ownRequirements);
  unpinned.packages["getquick/gq-design"].require = { "getquick/gq-assets": "^1.0.0" };
  assert.deepEqual(problems({ requirements: unpinned }), [
    `getquick/gq-design 0.9.4 requires getquick/gq-assets ^1.0.0, which ${CONTENT_FILE} doesn't pin.`,
    `getquick/gq-design 0.9.4 requires getquick/gq-assets ^1.0.0, which ${COMMERCE_FILE} doesn't pin.`,
  ]);

  const { requirementsFile, ...noRecords } = ownCatalogue;
  assert.ok(requirementsFile);
  assert.deepEqual(
    catalogueProblems(ownCatalogue, ownContent, ownNpm, { composers: composers() }),
    ["package-requirements.json wasn't read."],
  );
  assert.deepEqual(
    catalogueProblems(noRecords, ownContent, ownNpm, { composers: composers() }),
    [],
  );
});

test("each CMS skeleton requires exactly its variants' blueprint packages", () => {
  const withoutEcommerce = { ...ownCommerce.require };
  delete withoutEcommerce["getquick/getquick-ecommerce"];
  assert.deepEqual(
    problems({
      content: withPins(ownContent, { "getquick/getquick-ecommerce": "0.4.3" }),
      commerce: { ...ownCommerce, require: withoutEcommerce },
    }),
    [
      `getquick/getquick-ecommerce is in require (${CONTENT_FILE}), but the catalogue's variants for it (commerce) don't include content.`,
      `getquick/getquick-ecommerce is a blueprint requirement but isn't in require (${COMMERCE_FILE}).`,
    ],
  );
  // A commerce composer.json the catalogue was given no JSON for.
  assert.deepEqual(
    catalogueProblems(ownCatalogue, ownContent, ownNpm, { requirements: ownRequirements }),
    [`${COMMERCE_FILE} (the commerce CMS composer.json) wasn't read.`],
  );
});

test("Composer constraints are read as Composer reads them, or not at all", () => {
  const cases = [
    ["0.9.4", "^0.9.0", true],
    ["0.10.0", "^0.9.0", false],
    ["0.9.4", "^0.3.1", false],
    ["0.3.19", "^0.3.1", true],
    ["0.0.4", "^0.0.3", false],
    ["1.9.0", "^1.2", true],
    ["0.9.4", ">=0.3.19 <1.0", true],
    ["1.0.0", ">=0.3.19 <1.0", false],
    ["0.9.4", ">=0.9,<0.10", true],
    ["0.9.4", "^0.8.0 || ^0.9.0", true],
    ["0.9.4", "^0.8.0 | ^0.10.0", false],
    ["0.9.4", "0.9.4", true],
    ["0.9.4", "v0.9.3", false],
    ["0.9.4", "!=0.9.3", true],
    ["0.9.4", "*@stable", true],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "~1.2", true],
    ["2.0.0", "~1.2", false],
    ["1.2.9", "1.2.*", true],
    ["1.3.0", "1.2.*", false],
    ["1.5.1", "1.0 - 1.5", true],
    ["1.6.0", "1.0 - 1.5", false],
    ["1.5.1", "1.0 - 1.5.0", false],
    ["0.9.4", "dev-main", null],
    ["0.9.4", "dev-main as 0.9.99", null],
  ];
  for (const [version, constraint, expected] of cases) {
    assert.equal(
      satisfiesConstraint(parseVersion(version), constraint),
      expected,
      `${version} against ${constraint}`,
    );
  }
});
