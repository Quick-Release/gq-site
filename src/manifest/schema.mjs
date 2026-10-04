// gq.ops.json schema v1, the single source of the manifest's shape: commands
// read the manifest it validates, and scripts/generate-schema.mjs writes the
// JSON Schema editors load through `$schema` from it. Every object is strict,
// so a misspelt key fails by name instead of being ignored. The blocks are
// optional (a site not yet provisioned has none of its Ploi or Cloudflare
// IDs); each command still names the keys it needs. `release`, `verify`
// and `doctor` hold only additions to the variant's defaults
// (site-settings.mjs), so a site states only how it differs.
import { z } from "zod";

export const MANIFEST_FILENAME = "gq.ops.json";
export const SCHEMA_VERSION = 1;
export const VARIANTS = ["content", "commerce"];
// An offboarded Site's phases (ADR 0011): its access cut (`gq offboard`,
// reversible), then its content archived and its infrastructure deleted.
export const OFFBOARDING_PHASES = ["cut", "archived"];
// What a check can require to run locally (see workspace/verify.mjs).
export const CHECK_REQUIREMENTS = ["php", "ddev"];
// Where an Artifacts namespace keeps its repositories, as the Artifacts API
// names it. Cloudflare can't change it after the namespace is created.
export const ARTIFACTS_JURISDICTIONS = ["eu", "us", "unrestricted"];
export const DEFAULT_ARTIFACTS_JURISDICTION = "eu";

// Where `$schema` points from a site root, through the site's own install.
export const SCHEMA_URL = "./node_modules/@getquick/site/schema/gq.ops.schema.json";

const name = z.string().trim().min(1);
const hostname = z.string().trim().min(1);
const path = z.string().trim().min(1);
// A plugin's directory name: the CMS deploy script activates each one, so
// nothing that means something to the shell (or to wp, like a leading -).
const pluginSlug = z
  .string()
  .regex(
    /^[A-Za-z0-9][\w.-]*$/u,
    "must be a plugin slug (letters, digits, -, _ and ., starting with a letter or digit)",
  );
// A WordPress locale: a language, then optionally a region and a variant, as
// WordPress.org names its language packs (en_US, pt_PT, pt_PT_ao90,
// de_DE_formal). The CMS deploy script passes it to wp, so nothing else.
export const LOCALE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?$/u;
const locale = z
  .string()
  .regex(LOCALE_PATTERN, "must be a WordPress locale, like en_US, pt_PT or pt_PT_ao90");
// A language's URL directory (en for /en/) and Polylang slug: a lowercase
// URL segment, which the CMS deploy script passes to wp.
const languageSlug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, "must be a lowercase URL segment, like en or pt-br");
// What a bilingual Site needs in wordpress.plugins: Polylang (Pro, or the free
// plugin) and its GraphQL integration.
const POLYLANG_PLUGINS = ["polylang-pro", "polylang"];
const POLYLANG_GRAPHQL_PLUGIN = "gq-polylang-graphql";

// gq.ops.json `artifacts.jurisdiction`, or the default when it's left out.
export function artifactsJurisdiction(ops) {
  return ops.artifacts?.jurisdiction ?? DEFAULT_ARTIFACTS_JURISDICTION;
}

// The default language's slug: its locale's language code (pt for
// pt_PT_ao90), as Polylang names it.
function defaultLanguageSlug(locale) {
  return locale.split("_")[0];
}

/**
 * A bilingual Site's languages, the default (wordpress.locale) first, as the
 * Frontend serves them: each with its slug, its GraphQL LanguageCodeEnum
 * value (the slug in upper case) and its home route (`/`, `/en/`). Empty for
 * a monolingual Site (no wordpress.languages).
 */
export function siteLanguages(ops) {
  const { locale, languages } = ops.wordpress ?? {};
  if (!locale || !languages?.length) return [];
  return [{ locale, slug: defaultLanguageSlug(locale) }, ...languages].map(
    ({ locale, slug }, index) => ({
      locale,
      slug,
      code: slug.toUpperCase().replaceAll("-", "_"),
      home: index === 0 ? "/" : `/${slug}/`,
      isDefault: index === 0,
    }),
  );
}

// A pattern whose match is replaced by `replacement`, `{version}` standing
// for the release version: the JSON form of a release config's
// { regexp: /…/flags, replacement: (version) => `…${version}…` }.
const versionPattern = z.strictObject({
  regexp: z.string().refine((source) => compiles(source), "must be a valid regular expression"),
  flags: z
    .string()
    .refine((flags) => compiles("", flags), "must be valid regular expression flags")
    .optional(),
  replacement: z.string().refine((text) => text.includes("{version}"), "must contain {version}"),
});

const check = z.strictObject({
  cmd: name,
  args: z.array(z.string()).optional(),
  cwd: path.optional(),
  env: z.record(z.string(), z.string()).optional(),
  requires: z.array(z.enum(CHECK_REQUIREMENTS)).optional(),
});

export const manifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    project: name,
    variant: z.enum(VARIANTS),
    domains: z
      .strictObject({ admin: hostname, frontend: hostname, docs: hostname.optional() })
      .optional(),
    sigillo: z
      .strictObject({
        apiUrl: z.string().optional(),
        projectId: z.string().optional(),
        environments: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    ploi: z
      .strictObject({
        serverId: z.string().optional(),
        siteId: z.string().optional(),
        systemUser: z.string().optional(),
        projectRoot: z.string().optional(),
        webDirectory: z.string().optional(),
        database: z.string().optional(),
        envTemplate: z.string().optional(),
        deployScript: z.string().optional(),
      })
      .optional(),
    wordpress: z
      .strictObject({
        plugins: z
          .array(pluginSlug)
          .describe("The plugins the CMS deploy script activates, in order."),
        locale: locale
          .optional()
          .describe(
            "The site's main language, as a WordPress locale (pt_PT_ao90): the CMS deploy " +
              "script installs and activates it, and the Frontend's <html lang> follows it. " +
              "Left out, the deploy leaves the CMS's language as it is.",
          ),
        languages: z
          .array(z.strictObject({ locale, slug: languageSlug }))
          .optional()
          .describe(
            "The languages beside the default (locale), each under its URL directory (slug): " +
              "the CMS deploy script installs them and makes Polylang's languages match. " +
              "Needs locale, Polylang and gq-polylang-graphql. Left out, the Site is monolingual.",
          ),
      })
      .superRefine(checkLanguages)
      .optional(),
    releases: z.strictObject({ bucket: z.string(), prefix: z.string().optional() }).optional(),
    media: z.strictObject({ bucket: z.string(), domain: hostname }).optional(),
    backups: z.strictObject({ bucket: z.string(), prefix: z.string().optional() }).optional(),
    local: z
      .strictObject({ adminEmail: z.string().optional(), frontendUrl: z.string().optional() })
      .optional(),
    artifacts: z
      .strictObject({
        namespace: z.string(),
        repo: z.string(),
        jurisdiction: z
          .enum(ARTIFACTS_JURISDICTIONS)
          .optional()
          .describe(
            "Where the Artifacts namespace keeps the Site's code: gq cloudflare ci creates it " +
              'there, and stops at an existing one elsewhere. Left out, "eu"; "unrestricted" ' +
              "opts out. Cloudflare can't change it after the namespace is created.",
          ),
      })
      .optional(),
    ci: z
      .strictObject({
        worker: z.string().optional(),
        backupBucket: z.string().optional(),
        directory: z.string().optional(),
      })
      .optional(),
    cloudflare: z
      .strictObject({
        accountId: z.string().optional(),
        zoneId: z.string().optional(),
        zoneName: z.string().optional(),
      })
      .optional(),
    github: z.strictObject({ repository: z.string().optional() }).optional(),
    release: z
      .strictObject({
        jsonFiles: z.array(path).optional(),
        textFiles: z
          .array(z.strictObject({ path, patterns: z.array(versionPattern).min(1) }))
          .optional(),
        paths: z.array(path).optional(),
      })
      .optional()
      .describe("Added to the variant's version files, text patterns and release paths."),
    verify: z
      .strictObject({ checks: z.array(check).optional() })
      .optional()
      .describe("Added to the variant's checks, which run after them."),
    doctor: z
      .strictObject({ requiredFiles: z.record(path, z.array(path)).optional() })
      .optional()
      .describe("Added to the files the variant requires in each app."),
    offboarded: z
      .strictObject({
        at: z.iso.datetime(),
        phase: z.enum(OFFBOARDING_PHASES),
        cut: z
          .strictObject({
            backup: z.literal(true).optional(),
            crontab: z.strictObject({ user: name, frequency: name, command: name }).optional(),
            suspended: z.literal(true).optional(),
            workerDomains: z
              .array(z.strictObject({ hostname, service: name, zoneId: name }))
              .optional(),
            workersDev: z
              .record(name, z.strictObject({ enabled: z.boolean(), previewsEnabled: z.boolean() }))
              .optional(),
            mediaDomain: hostname.optional(),
            webhook: z.number().int().optional(),
            tokens: z.array(name).optional(),
          })
          .optional()
          .describe(
            "Written by gq offboard as it cuts: what it changed (the final backup, the retry crontab, the suspension, detached Worker domains, each Worker's workers.dev setting before, the media domain, the webhook id and the token ids it disabled); gq offboard --restore brings back only these.",
          ),
        archive: z
          .strictObject({
            bucket: name,
            prefix: path,
            manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          })
          .optional()
          .describe(
            "Written by gq offboard --archive once the archive is verified: where it is, and its manifest.json's sha256.",
          ),
      })
      .optional()
      .describe(
        "Written by gq offboard: the Site is offboarded, and gq refuses whatever would expose it again.",
      ),
  })
  .meta({ title: "gq.ops.json", description: "A GETQUICK site's manifest (schema v1)." });

// wordpress.languages: beside the default language, each locale and slug
// once, and the plugins Polylang's configuration needs.
function checkLanguages({ plugins, locale, languages }, context) {
  if (languages === undefined) return;
  const issue = (path, message) => context.addIssue({ code: "custom", path, message });
  if (locale === undefined) {
    issue(["languages"], "needs wordpress.locale, the default language");
    return;
  }
  const defaults = { locale, slug: defaultLanguageSlug(locale) };
  for (const key of ["locale", "slug"]) {
    const seen = new Set();
    languages.forEach((language, index) => {
      const value = language[key];
      if (value === defaults[key]) {
        issue(["languages", index, key], `repeats ${value}, the default language's`);
      } else if (seen.has(value)) issue(["languages", index, key], `repeats ${value}`);
      seen.add(value);
    });
  }
  const polylang = POLYLANG_PLUGINS.some((plugin) => plugins.includes(plugin));
  if (!polylang || !plugins.includes(POLYLANG_GRAPHQL_PLUGIN)) {
    issue(
      ["plugins"],
      "must include polylang-pro (or polylang) and gq-polylang-graphql for wordpress.languages",
    );
  }
}

function compiles(source, flags) {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

export function manifestJsonSchema() {
  return z.toJSONSchema(manifestSchema);
}
