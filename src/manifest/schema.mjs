// gq.ops.json schema v1, the single source of the manifest's shape: commands
// read the manifest it validates, and scripts/generate-schema.mjs writes the
// JSON Schema editors load through `$schema` from it. Every object is strict,
// so a misspelt key fails by name instead of being ignored. The blocks are
// optional (a site not yet provisioned has none of its Ploi or Cloudflare
// IDs); each command still names the keys it needs. `release`, `verify`
// and `doctor` hold only additions to the variant's defaults
// (site-settings.mjs), so a site states only how it differs.
import { isIP } from "node:net";
import { z } from "zod";

import { validPreviewUrl } from "../frontend/preview-bindings.mjs";

export const MANIFEST_FILENAME = "gq.ops.json";
export const SCHEMA_VERSION = 1;
export const FRAMEWORKS = ["astro", "tanstack"];
export function frontendFramework(manifest) {
  return manifest.framework ?? "astro";
}

export const VARIANTS = ["content", "commerce"];
// Where a content Site's runtime comes from (ADR 0020): "package" for the
// pinned getquick/gq-content and @getquick/content pair. A Site without the
// key keeps the runtime an earlier blueprint copied into it.
export const CONTENT_RUNTIMES = ["package"];
export const WORDPRESS_GRAPHQL_PATHS = ["/graphql", "/wp/graphql"];
// An offboarded Site's phases (ADR 0011): its access cut (`gq offboard`,
// reversible), then its content archived and its infrastructure deleted.
export const OFFBOARDING_PHASES = ["cut", "archived"];
// What a check can require to run locally (see workspace/verify.mjs).
export const CHECK_REQUIREMENTS = ["php", "ddev"];
// Where an Artifacts namespace keeps its repositories, as the Artifacts API
// names it. Cloudflare can't change it after the namespace is created.
export const ARTIFACTS_JURISDICTIONS = ["eu", "us", "unrestricted"];
export const DEFAULT_ARTIFACTS_JURISDICTION = "eu";
// The longest a consent record is kept after its decision stops being in
// force, and the consent Runtime's default (CN-R10; @getquick/content's
// MAX_RETENTION_DAYS): 5 years.
export const MAX_CONSENT_RETENTION_DAYS = 1826;
// Headless forms (gq-platform ADR 0009): the form providers a Site can choose,
// and the spam controls it can rely on. @getquick/content's forms handler
// applies a form's own Gravity Forms honeypot whenever the form enables it;
// Turnstile is verified server-side when the Site chooses it.
export const FORM_PROVIDERS = ["gravityforms"];
export const FORM_SPAM_CONTROLS = ["honeypot", "turnstile"];

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

// The public CMS endpoint. Local DDEV deliberately keeps its Bedrock path,
// independent of a Site's production path and credentials.
export function wordpressGraphqlUrl(ops, { localOrigin } = {}) {
  const origin = localOrigin ?? `https://${ops.domains.admin}`;
  const path = localOrigin ? "/wp/graphql" : (ops.wordpress?.graphqlPath ?? "/wp/graphql");
  return `${origin.replace(/\/+$/u, "")}${path}`;
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
    framework: z.enum(FRAMEWORKS).optional(),
    contentRuntime: z
      .enum(CONTENT_RUNTIMES)
      .optional()
      .describe(
        'Where the content runtime comes from. "package": the pinned getquick/gq-content and ' +
          "@getquick/content pair, whose pins and /gq routes gq sync manages; gq new sets it. " +
          "Left out, the Site keeps the runtime an earlier blueprint copied into it, and gq sync " +
          "leaves that alone.",
      ),
    domains: z
      .strictObject({
        admin: hostname,
        frontend: hostname.describe(
          "The production Frontend's public hostname: its canonical URL, which the CMS links " +
            "and allows. Outside the Cloudflare zone, it needs frontendTarget.",
        ),
        frontendTarget: hostname
          .optional()
          .describe(
            "Set only when domains.frontend is a hostname outside the Cloudflare zone: the " +
              "production Frontend's hostname inside the zone (cloudflare.zoneName). It is the " +
              "Worker's Custom Domain, which domains.frontend reaches through Cloudflare for SaaS, " +
              "or through frontendProxy. " +
              "Left out, domains.frontend is in the zone.",
          ),
        frontendProxy: z
          .strictObject({
            trustedProxies: z
              .array(
                z
                  .string()
                  .refine(validProxyAddress, "must be an IPv4 or IPv6 address or CIDR, not a /0"),
              )
              .min(1)
              .describe(
                "The addresses the proxy reaches Cloudflare from (addresses or CIDRs, IPv4 or " +
                  "IPv6): the Frontend's form and consent endpoints believe its " +
                  "X-Forwarded-For only from them, so each visitor keeps their own rate limit. " +
                  "Bound to the production Worker as GQ_TRUSTED_PROXIES. List only proxies " +
                  "we run: a listed address can claim any visitor's.",
              ),
          })
          .optional()
          .describe(
            "Set when a reverse proxy we run outside Cloudflare serves domains.frontend " +
              "(with a certificate of its own, e.g. one the client's CA issues) and forwards " +
              "to frontendTarget, with Host and SNI frontendTarget. Needs frontendTarget. The " +
              "Worker gets no route and gq makes no Cloudflare for SaaS custom hostname. " +
              "Left out, a domains.frontend outside the zone is a Cloudflare for SaaS custom " +
              "hostname.",
          ),
        docs: hostname.optional(),
      })
      .superRefine(checkFrontendTarget)
      .optional(),
    preview: z
      .strictObject({
        cmsUrl: z
          .string()
          .refine((value) => validPreviewUrl(value), "must be an exact HTTPS origin"),
        audience: z
          .string()
          .refine(
            (value) => validPreviewUrl(value, true),
            "must be an exact HTTPS /gq/preview URL",
          ),
      })
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
        graphqlPath: z
          .enum(WORDPRESS_GRAPHQL_PATHS)
          .optional()
          .describe(
            "The production CMS GraphQL path for readiness and Frontend deploys: " +
              "/graphql or /wp/graphql. Left out, /wp/graphql. Local DDEV stays on /wp/graphql.",
          ),
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
    consent: z
      .strictObject({
        retentionDays: z
          .int()
          .min(1)
          .max(MAX_CONSENT_RETENTION_DAYS)
          .optional()
          .describe(
            "How many days the consent records are kept after a decision stops being in force " +
              "(CN-R10): the Frontend's consent endpoints and the retention purge get it as " +
              `CONSENT_RETENTION_DAYS. From 1 to ${MAX_CONSENT_RETENTION_DAYS}; left out, the ` +
              `consent Runtime's default, ${MAX_CONSENT_RETENTION_DAYS} (5 years).`,
          ),
      })
      .optional(),
    forms: z
      .strictObject({
        provider: z
          .enum(FORM_PROVIDERS)
          .describe(
            'The form plugin the CMS runs: "gravityforms". wordpress.plugins must list it.',
          ),
        spam: z
          .array(z.enum(FORM_SPAM_CONTROLS))
          .refine((controls) => new Set(controls).size === controls.length, "repeats a control")
          .optional()
          .describe(
            'The spam controls the Site relies on: "honeypot" (Gravity Forms\' own, on each ' +
              'form that enables it) and "turnstile" (Cloudflare Turnstile, verified by the ' +
              "Frontend; needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Sigillo). Left " +
              "out, none beyond what each form enables.",
          ),
      })
      .optional()
      .describe(
        "Headless forms (gq-platform ADR 0009): gq sync manages the Frontend's /gq/forms/ " +
          "route, which posts each form to the CMS, and gq site check and gq doctor check " +
          'the forms published content references. Needs contentRuntime "package". Left out, ' +
          "the Site has no form endpoint.",
      ),
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
        rateLimitNamespaces: z
          .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/u), z.int().positive())
          .optional()
          .describe(
            "A commerce Site's rate-limit namespace IDs, by the storefront Runtime's binding: " +
              "per Cloudflare account, so each Site has its own. Left out, the storefront " +
              "deploy refuses once the Runtime declares rate limits.",
          ),
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
            workerRoutes: z
              .array(z.strictObject({ pattern: name, service: name, zoneId: name }))
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
            "Written by gq offboard as it cuts: what it changed (the final backup, the retry crontab, the suspension, detached Worker domains, the removed route of a custom hostname, each Worker's workers.dev setting before, the media domain, the webhook id and the token ids it disabled); gq offboard --restore brings back only these.",
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
  .superRefine((ops, context) => {
    if (
      ops.variant === "content" &&
      ops.framework === "tanstack" &&
      ops.contentRuntime !== "package"
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentRuntime"],
        message: 'TanStack content Frontends require contentRuntime "package".',
      });
    }
  })
  .superRefine(checkForms)
  .superRefine(checkFrontendZone)
  .superRefine(checkVariant)
  .meta({ title: "gq.ops.json", description: "A GETQUICK site's manifest (schema v1)." });

// forms: on a content Site with the package pair, whose CMS deploy activates
// the provider's plugin.
function checkForms({ forms, variant, contentRuntime, wordpress }, context) {
  if (forms === undefined) return;
  const issue = (message) => context.addIssue({ code: "custom", path: ["forms"], message });
  if (variant !== "content" || contentRuntime !== "package") {
    issue('needs a content Site on the package pair (variant "content", contentRuntime "package")');
  }
  // A provider is named as its plugin's slug, which the CMS deploy activates.
  if (!wordpress?.plugins.includes(forms.provider)) {
    issue(`needs ${forms.provider} in wordpress.plugins, so the CMS deploy activates it`);
  }
}

/** The spam controls gq.ops.json `forms` declares; empty without forms. */
export function formSpamControls(ops) {
  return ops.forms?.spam ?? [];
}

// domains.frontendTarget is another hostname than the one it serves, and
// domains.frontendProxy forwards to it.
function checkFrontendTarget({ frontend, frontendTarget, frontendProxy }, context) {
  if (frontendTarget === undefined) {
    if (frontendProxy !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["frontendProxy"],
        message: "needs domains.frontendTarget, the Frontend's hostname inside the Cloudflare zone",
      });
    }
    return;
  }
  if (sameHostname(frontendTarget, frontend)) {
    context.addIssue({
      code: "custom",
      path: ["frontendTarget"],
      message: "must be the Frontend's hostname inside the Cloudflare zone, not domains.frontend",
    });
  }
}

// With cloudflare.zoneName known, domains.frontendTarget is inside the zone
// and domains.frontend, which reaches it through Cloudflare for SaaS or an
// external proxy, isn't.
function checkFrontendZone({ domains, cloudflare }, context) {
  const zone = cloudflare?.zoneName;
  if (!domains?.frontendTarget || !zone) return;
  const issue = (key, message) =>
    context.addIssue({ code: "custom", path: ["domains", key], message });
  if (!inZone(domains.frontendTarget, zone)) {
    issue("frontendTarget", `must be a hostname in ${zone} (cloudflare.zoneName)`);
  }
  if (inZone(domains.frontend, zone)) {
    issue(
      "frontend",
      `is in ${zone} (cloudflare.zoneName): a Worker Custom Domain serves it, so leave out domains.frontendTarget`,
    );
  }
}

const sameHostname = (a, b) => a.toLowerCase() === b.toLowerCase();

function inZone(host, zone) {
  const name = host.toLowerCase();
  const apex = zone.toLowerCase();
  return name === apex || name.endsWith(`.${apex}`);
}

/**
 * The production Frontend's Cloudflare for SaaS custom hostname: its public
 * hostname (domains.frontend, outside the Cloudflare zone) and the in-zone
 * hostname it CNAMEs to (domains.frontendTarget). Null for a Frontend whose
 * public hostname is in the zone.
 */
export function frontendCustomHostname(ops) {
  const { frontend, frontendTarget } = ops.domains ?? {};
  if (!frontend || !frontendTarget || frontendProxied(ops)) return null;
  return { hostname: frontend, target: frontendTarget };
}

/**
 * The production Frontend behind an external reverse proxy
 * (domains.frontendProxy): the public hostname the proxy
 * serves (domains.frontend) and the Worker's in-zone hostname it forwards to
 * (domains.frontendTarget). Null otherwise.
 */
export function frontendProxy(ops) {
  const { frontend, frontendTarget } = ops.domains ?? {};
  if (!frontend || !frontendTarget || !frontendProxied(ops)) return null;
  return { hostname: frontend, target: frontendTarget };
}

const frontendProxied = (ops) => ops.domains?.frontendProxy !== undefined;

// An address or CIDR as @getquick/content's trustedProxies takes it; a /0
// would trust every address.
function validProxyAddress(value) {
  const [address, prefix, extra] = value.split("/");
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  const length = Number(prefix);
  return length > 0 && length <= (family === 4 ? 32 : 128);
}

// What only one variant may declare. A commerce Site is monolingual until
// multilingual commerce is decided (ADR 0017): wordpress.languages means
// Polylang and its GraphQL wiring, which a commerce Site doesn't have.
function checkVariant({ variant, wordpress }, context) {
  if (variant === "commerce" && wordpress?.languages !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["wordpress", "languages"],
      message: "isn't supported on a commerce Site yet: it has only wordpress.locale",
    });
  }
}

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
