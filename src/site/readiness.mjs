// Whether a new content Site's resilience guarantee holds (ADR 0010): its
// published content is served from the Frontend's publication store through
// CMS outages, refreshed by signed CMS events, retried and reconciled by the
// CMS's scheduler, with uploads hosted independently of the CMS. A running
// Worker, a running DDEV, an HTTP 200 or a matching CMS title proves none of
// that, so each part is checked where it can be observed:
//
//   cms       WordPress is installed and answers GraphQL, and WPGraphQL has
//             every field the Frontend reads (which the GETQUICK plugins and
//             theme add): GraphQL validates them without running anything.
//             A bilingual Site's CMS has each of its languages (Polylang's,
//             listed by GQ Polylang for WPGraphQL), and every language's
//             front page, title and menu are fields too.
//   frontend  the deployed Worker accepts this Site's signed events and its
//             refresh token, its store holds a prepared Site, every
//             language's front page and chrome (the signed check reports
//             states and counts, never content), and each language's
//             homepage is served from it with nothing caching it.
//   delivery  the CMS's .env has this Site's event key and its server has
//             the retry crontab (Ploi), and the CMS's scheduler has had the
//             Frontend reconcile with WordPress recently, which also proves
//             the CMS sends signed events the Frontend accepts.
//   media     `gq media check --upload`: an upload through the CMS lands on
//             the media host and is served without it.
//
// Every check is read-only except the media upload probe, which deletes what
// it uploads. Results never carry a secret's value or content. A check is
// { area, name, status, detail, action? } with media's statuses: ok,
// not-ready, warn, skipped. The Site is "ready" only when nothing is
// not-ready.

import { RECONCILIATION_STALE_MS, sendCheckEvent } from "../frontend/commands.mjs";
import { siteLanguages, wordpressGraphqlUrl } from "../manifest/schema.mjs";
import { productionMediaReadiness } from "../media/readiness.mjs";
import { cmsFetch } from "../cms/access.mjs";
import { EVENT_SECRET, inspectCmsEvents } from "../ploi/events.mjs";

const TIMEOUT = 30_000;
const REFRESH_TOKEN = "FRONTEND_REFRESH_TOKEN";
const THROUGH_SIGILLO = "run this through gq sigillo run staging (pnpm site:check)";
const RELEASE_CMS =
  "release the CMS once WordPress is installed (pnpm push fix): its deploy activates gq.ops.json wordpress.plugins, and deploy/ploi/admin.d/10-theme.sh activates getquick-theme";

/**
 * Every field the Frontend skeleton's queries read (apps/frontend/src/lib/
 * wordpress.ts), each skipped: GraphQL validates a skipped field against the
 * schema, so an answer without errors proves they all exist, and nothing is
 * resolved or read. A bilingual Site's (`languages`, siteLanguages) adds each
 * other language's front page, title and tagline, and menu, which also
 * proves LanguageCodeEnum has it, each entry's language and translations,
 * and the entries of every language.
 */
export function schemaQuery(languages = []) {
  const translated = languages.length > 0;
  const languageFields = translated
    ? `
      language {
        slug
      }
      translations {
        uri
        language {
          slug
        }
      }`
    : "";
  const perLanguage = languages
    .filter((language) => !language.isDefault)
    .map(
      ({ code, home }) => /* GraphQL */ `
    front_${code}: nodeByUri(uri: "${home}") @skip(if: true) {
      __typename
      ... on Page {
        id
        title
        content
        blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
        isFrontPage
      }
    }
    language_${code}: language(code: ${code}) @skip(if: true) {
      title
      description
    }
    menu_${code}: menuItems(where: { location: PRIMARY, language: ${code} }, first: 100) @skip(if: true) {
      nodes {
        id
        parentId
        label
        url
        target
      }
    }`,
    )
    .join("");
  return /* GraphQL */ `
  query GqSiteCheck {
    generalSettings @skip(if: true) {
      title
      description
      siteIcon {
        node {
          sourceUrl
          altText
        }
      }
      siteLogo {
        node {
          sourceUrl
          altText
        }
      }
    }
    nodeByUri(uri: "/") @skip(if: true) {
      __typename
      ... on Page {
        id
        title
        content
        blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
        isFrontPage
      }
    }
    designTokens @skip(if: true) {
      spacingSizes {
        slug
        size
      }
      colors {
        slug
        color
      }
    }
    menuItems(where: { location: PRIMARY }, first: 100) @skip(if: true) {
      nodes {
        id
        parentId
        label
        url
        target
      }
    }
    postBy(uri: "/") @skip(if: true) {
      id
      title
      excerpt
      content
      blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
      uri${languageFields}
      date
      status
      isRestricted
      modifiedGmt
      featuredImage {
        node {
          sourceUrl
          altText
        }
      }
    }
    pageBy(uri: "/") @skip(if: true) {
      id
      title
      content
      blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
      uri${languageFields}
      status
      isRestricted
      modifiedGmt
      featuredImage {
        node {
          sourceUrl
          altText
        }
      }
    }
    contentNodes(first: 100, where: { contentTypes: [PAGE, POST]${translated ? ", language: ALL" : ""} }) @skip(if: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        uri
        id
        modifiedGmt
      }
    }${perLanguage}
  }
`;
}

/** A monolingual Site's: every field the Frontend reads. */
export const SCHEMA_QUERY = schemaQuery();

/** A bilingual Site's languages in its CMS, as GQ Polylang for WPGraphQL lists them. */
export const LANGUAGES_QUERY = "{ languages { slug } }";

const POLYLANG_GRAPHQL = "GQ Polylang for WPGraphQL (gq-polylang-graphql)";

// What adds the fields WPGraphQL's own schema lacks, by what a validation
// error names.
const SCHEMA_PROVIDERS = [
  [/designTokens|siteLogo|siteIcon/u, "GETQUICK Design (gq-design)"],
  [
    /"blocks"|"attributes"|"htmlContent"|"dynamicContent"|"postTemplate"/u,
    "WPGraphQL Blocks (wpgraphql-blocks)",
  ],
  [/PRIMARY|MenuLocationEnum/u, "getquick-theme (its primary menu location)"],
  [/"languages?"|"translations"|LanguageCode/u, POLYLANG_GRAPHQL],
];

// --- the CMS -----------------------------------------------------------------

/**
 * Whether the CMS at `graphqlUrl` is ready for the Frontend: WordPress is
 * installed and answers GraphQL (WPGraphQL is active), a bilingual Site's has
 * each of its `languages` (siteLanguages), and its schema has every field the
 * Frontend reads. A CMS that is merely running, or answers only some of them,
 * is not ready.
 */
export async function cmsReadiness({
  graphqlUrl,
  fetch,
  languages = [],
  env = {},
  cmsOrigin = new URL(graphqlUrl).origin,
}) {
  fetch = cmsFetch({ env, origin: cmsOrigin, fetch });
  const checks = [];
  const add = (check) => checks.push({ area: "cms", ...check });
  const location = new URL(graphqlUrl);

  let response;
  try {
    response = await postGraphql(fetch, graphqlUrl, "{ __typename }");
  } catch (error) {
    add(
      notReady(
        "wordpress",
        `${location.origin} doesn't answer: ${messageOf(error)}`,
        "check the CMS's host, DNS and certificate (pnpm ploi:provision), or start it",
      ),
    );
    return checks;
  }
  const redirect = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400) {
    add(
      redirect.includes("install.php")
        ? notReady(
            "wordpress",
            `WordPress isn't installed at ${location.origin}: it redirects to its installer`,
            `install it at ${new URL(redirect, location).href}, then ${RELEASE_CMS}`,
          )
        : notReady(
            "wordpress",
            `${location.href} redirects to ${redirect || "nowhere"} instead of answering GraphQL`,
            "point domains.admin at the CMS's own host",
          ),
    );
    return checks;
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok || answer?.data?.__typename !== "RootQuery") {
    add(
      notReady(
        "wordpress",
        `${location.href} isn't a WPGraphQL endpoint (HTTP ${response.status}): WordPress is running without WPGraphQL active`,
        RELEASE_CMS,
      ),
    );
    return checks;
  }
  add(ok("wordpress", `WordPress is installed and answers GraphQL at ${location.href}`));
  if (languages.length > 0) add(await languagesCheck({ graphqlUrl, fetch, languages }));

  let errors;
  try {
    const validated = await postGraphql(fetch, graphqlUrl, schemaQuery(languages));
    const result = await validated.json().catch(() => null);
    if (!result) throw new Error(`HTTP ${validated.status} without a GraphQL answer`);
    errors = (result.errors ?? []).map((error) => String(error?.message ?? error));
  } catch (error) {
    add(
      notReady("wpgraphql-schema", `the schema couldn't be checked: ${messageOf(error)}`, "retry"),
    );
    return checks;
  }
  if (errors.length === 0) {
    add(
      ok(
        "wpgraphql-schema",
        `WPGraphQL has every field the Frontend reads (GETQUICK Design's design tokens and logo, WPGraphQL Blocks, getquick-theme's primary menu${languages.length > 0 ? ", each language's front page, title and menu" : ""})`,
      ),
    );
    return checks;
  }
  const providers = SCHEMA_PROVIDERS.filter(([pattern]) =>
    errors.some((error) => pattern.test(error)),
  ).map(([, provider]) => provider);
  add(
    notReady(
      "wpgraphql-schema",
      `WPGraphQL lacks fields the Frontend reads${providers.length > 0 ? `, which ${providers.join(", ")} add` : ""}: ${errors.slice(0, 3).join(" ")}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ""}`,
      RELEASE_CMS,
    ),
  );
  return checks;
}

/** Whether Polylang has each language gq.ops.json declares, as GQ Polylang for WPGraphQL lists them. */
async function languagesCheck({ graphqlUrl, fetch, languages }) {
  const name = "languages";
  const declared = languages.map(({ slug }) => slug);
  let answer;
  try {
    const response = await postGraphql(fetch, graphqlUrl, LANGUAGES_QUERY);
    answer = await response.json().catch(() => null);
  } catch (error) {
    return notReady(name, `the languages couldn't be read: ${messageOf(error)}`, "retry");
  }
  const listed = answer?.data?.languages;
  if (!Array.isArray(listed)) {
    const reason = answer?.errors?.[0]?.message ?? "no languages in its answer";
    return notReady(
      name,
      `WPGraphQL lists no languages (${reason}): ${POLYLANG_GRAPHQL} and Polylang aren't active`,
      RELEASE_CMS,
    );
  }
  const slugs = new Set(listed.map((language) => language?.slug));
  const missing = declared.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    return notReady(
      name,
      `Polylang has no ${missing.join(", ")} language${missing.length > 1 ? "s" : ""}, which gq.ops.json declares`,
      "release the CMS (pnpm push fix): its deploy creates gq.ops.json's languages in Polylang (deploy/ploi/polylang.sh)",
    );
  }
  return ok(name, `Polylang has every language gq.ops.json declares: ${declared.join(", ")}`);
}

function postGraphql(fetch, url, query) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

// --- the Frontend --------------------------------------------------------------

/**
 * Whether the deployed Frontend at `origin` (a URL) is ready: it accepts
 * this Site's signed events and its refresh token, its publication store
 * holds a prepared Site, the homepage is served from it uncached, and the
 * CMS's scheduler has had it reconcile with WordPress recently. `env` holds
 * PUBLICATION_EVENT_SECRET and FRONTEND_REFRESH_TOKEN, which are only sent
 * to the Frontend (the secret as a signature).
 */
export async function frontendReadiness({
  origin,
  project,
  env,
  fetch,
  now = Date.now,
  languages = [],
}) {
  const checks = [];
  const add = (area, check) => checks.push({ area, ...check });
  const answer = await checkEvents({ origin, project, env, fetch, add });
  await checkRefreshToken({ origin, env, fetch, add });
  if (answer) {
    add("frontend", storeCheck(answer, languages));
    add("delivery", reconciliationCheck(answer.reconciliation, now));
    add("delivery", delaysCheck(answer.store));
  } else {
    const unknown = "unknown until the Frontend accepts this Site's signed check";
    add("frontend", skipped("publication-store", unknown));
    add("delivery", skipped("reconciliation", unknown));
  }
  const others = languages.filter(({ isDefault }) => !isDefault);
  add("frontend", await homepageCheck({ origin, fetch, required: others.length > 0 }));
  for (const language of others) {
    add("frontend", await homepageCheck({ origin, fetch, language, required: true }));
  }
  return checks;
}

async function checkEvents({ origin, project, env, fetch, add }) {
  const name = "frontend-events";
  const secret = env[EVENT_SECRET]?.trim();
  if (!secret) {
    add(
      "frontend",
      notReady(
        name,
        `${EVENT_SECRET} is missing here`,
        `${THROUGH_SIGILLO}; if Sigillo staging lacks it, run pnpm frontend:secrets and deploy the Frontend`,
      ),
    );
    return null;
  }
  const url = new URL("/gq/events", origin);
  let checked;
  try {
    checked = await sendCheckEvent({ url, site: project, secret, fetch });
  } catch (error) {
    add(
      "frontend",
      notReady(
        name,
        messageOf(error),
        "deploy the Frontend (pnpm deploy:frontend, or a release), then check again",
      ),
    );
    return null;
  }
  const { status, answer, accepted } = checked;
  if (accepted) {
    add(
      "frontend",
      ok(
        name,
        `${url.origin} has a publication store and accepts ${project}'s signed events (${EVENT_SECRET} is bound)`,
      ),
    );
    return answer;
  }
  const reason = answer?.error ?? `HTTP ${status}`;
  const action =
    status === 401
      ? `redeploy the Frontend with Sigillo staging's ${EVENT_SECRET} (pnpm deploy:frontend), and pnpm ci:deploy so CI releases bind it too`
      : status === 403 && /store/u.test(reason)
        ? "deploy the Frontend with apps/frontend/migrations, which makes infra/frontend.run.ts declare and bind its publication store"
        : status === 403
          ? `run pnpm frontend:secrets, then pnpm ci:deploy and deploy the Frontend, so the Worker has ${EVENT_SECRET}`
          : status === 404
            ? "the Frontend predates publication events: adopt its event files from a newly generated site (CHANGELOG) and deploy"
            : "deploy the Frontend, then check again";
  add(
    "frontend",
    notReady(name, `${url.origin} refused ${project}'s signed check: ${reason}`, action),
  );
  return null;
}

// The refresh token's binding, without refreshing anything: an empty list of
// routes is refused (400) only once the token was accepted.
async function checkRefreshToken({ origin, env, fetch, add }) {
  const name = "frontend-refresh";
  const token = env[REFRESH_TOKEN]?.trim();
  if (!token) {
    add(
      "frontend",
      notReady(
        name,
        `${REFRESH_TOKEN} is missing here`,
        `${THROUGH_SIGILLO}; if Sigillo staging lacks it, run pnpm frontend:secrets and deploy the Frontend`,
      ),
    );
    return;
  }
  const url = new URL("/gq/refresh", origin);
  let status;
  try {
    const response = await fetch(url.href, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ uris: [] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    add("frontend", notReady(name, `${url.origin} doesn't answer: ${messageOf(error)}`, "retry"));
    return;
  }
  if (status === 400) {
    add(
      "frontend",
      ok(name, `${url.origin} accepts ${REFRESH_TOKEN}, so the Site can be prepared`),
    );
    return;
  }
  add(
    "frontend",
    notReady(
      name,
      status === 401
        ? `${url.origin} refuses Sigillo staging's ${REFRESH_TOKEN}`
        : status === 403
          ? `${url.origin} has no ${REFRESH_TOKEN} bound: refreshes are refused`
          : `${url.origin} answered a refresh probe with HTTP ${status}`,
      `redeploy the Frontend with Sigillo staging's ${REFRESH_TOKEN} (pnpm deploy:frontend), and pnpm ci:deploy so CI releases bind it too`,
    ),
  );
}

const PREPARE = "prepare the Site: pnpm frontend:refresh (a whole-Site refresh), then check again";

/**
 * The store, as the signed check reports it: a prepared Site holds its front
 * page and chrome, and a bilingual Site every other language's too.
 */
function storeCheck(answer, languages) {
  const name = "publication-store";
  if (!("store" in answer)) {
    return notReady(
      name,
      "the Frontend's check doesn't report its store: it predates gq site check",
      "adopt src/lib/events.ts and src/lib/publications.ts from a newly generated site, and deploy",
    );
  }
  const { store } = answer;
  if (!store) {
    return notReady(
      name,
      "the Frontend couldn't read its publication store, so pages without a stored copy are a 503",
      "check the Worker's PUBLICATION_DB binding and the D1 database in the Cloudflare dashboard, then redeploy",
    );
  }
  const others = languages.filter(({ isDefault }) => !isDefault);
  if (others.length > 0 && !store.languages) {
    return notReady(
      name,
      "the Frontend's check doesn't report each language's front page and chrome: it predates bilingual Sites",
      "adopt src/lib/delivery.ts and src/lib/events.ts from a newly generated site, and deploy",
    );
  }
  const shared = { home: "front page", chrome: "site chrome" };
  const absent = Object.entries(shared)
    .filter(([key]) => store[key] === null)
    .map(([, label]) => label);
  if (absent.length > 0) {
    return notReady(
      name,
      `the store holds no ${absent.join(" or ")}: the Site was never prepared, so its pages are a 503`,
      PREPARE,
    );
  }
  // The other languages' rows in a state (null: never stored), each named
  // as "en front page".
  const languageRows = (matches) =>
    others.flatMap(({ slug }) =>
      Object.entries(shared)
        .filter(([key]) => matches(store.languages[slug]?.[key]))
        .map(([, label]) => ({ slug, label: `${slug} ${label}` })),
    );
  const absentInLanguage = languageRows((state) => state === undefined || state === null);
  if (absentInLanguage.length > 0) {
    const slugs = [...new Set(absentInLanguage.map(({ slug }) => slug))];
    return notReady(
      name,
      `the store holds no ${absentInLanguage.map(({ label }) => label).join(" or ")}: the Site was never prepared in ${slugs.join(", ")}, so those pages aren't served`,
      PREPARE,
    );
  }
  const unusable = [
    ...Object.entries({ ...shared, design: "design presets" })
      .filter(([key]) => store[key] === "unusable")
      .map(([, label]) => label),
    ...languageRows((state) => state === "unusable").map(({ label }) => label),
  ];
  if (unusable.length > 0 || store.entries?.unusable > 0) {
    return notReady(
      name,
      `the store holds ${[...unusable, ...(store.entries?.unusable ? [`${store.entries.unusable} entries`] : [])].join(", ")} in a format this Frontend doesn't serve`,
      PREPARE,
    );
  }
  const counts = Object.entries(store.entries ?? {})
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  const inLanguages = others
    .map(({ slug }) => `; ${slug}: front page (${store.languages[slug].home}), site chrome`)
    .join("");
  const summary = `front page (${store.home}), site chrome and ${store.design ? "design presets" : "no shared design presets"} stored${inLanguages}; entries: ${counts || "none"}`;
  if (store.home !== "published") {
    // A bilingual Site needs every language's front page, its default's too.
    return (others.length > 0 ? notReady : warn)(
      name,
      `${summary}. WordPress has no published front page, so the homepage is a 404`,
      "set a front page in WordPress (Settings → Reading) and publish it",
    );
  }
  // Every language of a bilingual Site must have its front page: without
  // one, its home is a 404 and its visitors have no way in.
  const unpublished = others.filter(({ slug }) => store.languages[slug].home !== "published");
  if (unpublished.length > 0) {
    const slugs = unpublished.map(({ slug }) => slug).join(", ");
    return notReady(
      name,
      `${summary}. WordPress has no published ${slugs} front page, so ${unpublished.map(({ home }) => home).join(", ")} is a 404`,
      `translate the front page into ${slugs} in WordPress and publish it`,
    );
  }
  if (!store.design) {
    return warn(name, `${summary}`, PREPARE);
  }
  return ok(name, summary);
}

function reconciliationCheck(reconciliation, now) {
  const name = "reconciliation";
  const scheduler =
    "run pnpm ploi:events (the CMS's every-minute crontab), release the CMS, and read wp gq-events delays on the server";
  if (reconciliation === undefined) {
    return notReady(
      name,
      "the Frontend's check doesn't report reconciliation: it predates ADR 0009",
      "adopt the reconciliation files from a newly generated site, and deploy",
    );
  }
  if (!reconciliation) {
    return notReady(
      name,
      "the Frontend has never reconciled with WordPress: the CMS's scheduler isn't running, or its events don't reach the Frontend",
      scheduler,
    );
  }
  const time = (ms) => (ms ? new Date(ms).toISOString() : "never");
  const fresh =
    reconciliation.reconciledAt && now() - reconciliation.reconciledAt <= RECONCILIATION_STALE_MS;
  const failure = reconciliation.reason
    ? ` (${reconciliation.reason}: ${reconciliation.message})`
    : "";
  const detail = `last run ${time(reconciliation.startedAt)}: ${reconciliation.outcome ?? "unfinished"}${failure}; the store last matched WordPress at ${time(reconciliation.reconciledAt)}`;
  if (!fresh) {
    return notReady(
      name,
      `${detail}, over ${RECONCILIATION_STALE_MS / 60_000} minutes ago`,
      reconciliation.outcome === "failed"
        ? "fix the failure above (the Frontend couldn't read WordPress), then wait for the next minute's run"
        : scheduler,
    );
  }
  return reconciliation.outcome === "reconciled" || reconciliation.outcome === undefined
    ? ok(name, `the CMS's scheduler retries and reconciles: ${detail}`)
    : warn(name, `the CMS's scheduler runs, but ${detail}`, "wait for the next runs to catch up");
}

function delaysCheck(store) {
  const name = "delivery-delays";
  const failed = store?.failedEvents ?? 0;
  if (failed === 0) return ok(name, "no event is waiting on a failed refresh");
  return warn(
    name,
    `${failed} event(s) couldn't be refreshed and wait for the CMS's retries; visitors keep the last good versions`,
    "wp gq-events delays on the CMS lists them and why",
  );
}

/**
 * Whether a language's homepage (the default's, `/`, unless `language`) is
 * served from the store with nothing caching it. Unless `required` (every
 * homepage of a bilingual Site), one WordPress confirms has no front page
 * only warns.
 */
async function homepageCheck({ origin, fetch, language, required = false }) {
  const name = language ? `homepage-${language.slug}` : "homepage";
  const url = new URL(language?.home ?? "/", origin);
  const front = language ? `${language.slug} front page` : "front page";
  let response;
  try {
    response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    await response.body?.cancel();
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, "deploy the Frontend");
  }
  const cacheControl = response.headers.get("cache-control") ?? "";
  const cached = /^hit$/iu.test(response.headers.get("cf-cache-status") ?? "");
  if (response.status === 200 && /no-cache/u.test(cacheControl) && !cached) {
    return ok(name, `${url.href} serves the stored homepage (HTTP 200, ${cacheControl})`);
  }
  if (response.status === 200) {
    return notReady(
      name,
      `${url.href} is served ${cached ? "from Cloudflare's cache" : `with Cache-Control: ${cacheControl || "none"}`}, so a cached copy could outlive a withdrawal`,
      "remove any cache rule for the Frontend's host; its pages answer Cache-Control: no-cache",
    );
  }
  if (response.status === 404) {
    const detail = `${url.href} is a 404: WordPress confirms no ${front}`;
    return (required ? notReady : warn)(
      name,
      detail,
      language ? `translate the front page into ${language.slug} and publish it` : `set a ${front}`,
    );
  }
  return notReady(
    name,
    `${url.href} answers HTTP ${response.status}${response.status === 503 ? ": nothing usable is stored for it" : ""}`,
    PREPARE,
  );
}

// --- the CMS's delivery (Ploi) -------------------------------------------------

/**
 * The CMS's side of events on its Ploi server: the .env has Sigillo's event
 * key (compared, never shown), and the server has the every-minute retry
 * crontab (`gq ploi events` sets both).
 */
export async function cmsDeliveryReadiness({ ops, env, fetch }) {
  const name = "cms-events";
  const action = "run pnpm ploi:events, then release the CMS (pnpm push fix)";
  const secret = env[EVENT_SECRET]?.trim();
  if (!env.PLOI_API_TOKEN || !ops.ploi?.serverId || !ops.ploi?.siteId || !secret) {
    return [
      {
        area: "delivery",
        ...notReady(
          name,
          "the CMS's .env and crontab can't be read without PLOI_API_TOKEN, PUBLICATION_EVENT_SECRET and gq.ops.json ploi.serverId/siteId",
          `${THROUGH_SIGILLO} once pnpm ploi:provision has run`,
        ),
      },
    ];
  }
  let inspected;
  try {
    inspected = await inspectCmsEvents({ ops, token: env.PLOI_API_TOKEN, secret, fetch });
  } catch (error) {
    return [
      {
        area: "delivery",
        ...notReady(name, `couldn't read the Ploi site: ${messageOf(error)}`, "retry"),
      },
    ];
  }
  const { changed, crontab, existing } = inspected;
  const problems = [
    changed.length > 0 &&
      `the CMS's .env has a missing or different ${EVENT_SECRET} (values not shown)`,
    !existing && `the server has no crontab running ${crontab.command} as ${crontab.user}`,
    existing &&
      existing.frequency !== crontab.frequency &&
      `the retry crontab runs at "${existing.frequency}", not every minute`,
  ].filter(Boolean);
  return [
    {
      area: "delivery",
      ...(problems.length === 0
        ? ok(name, `the CMS's .env has ${EVENT_SECRET}, and its every-minute retry crontab is set`)
        : notReady(name, problems.join("; "), action)),
    },
  ];
}

// --- the Site ------------------------------------------------------------------

/**
 * The production readiness of the Site gq.ops.json describes. `origin` is the
 * Frontend's (a URL; default https://<domains.frontend>). `upload` runs the
 * media upload probe, which readiness requires.
 */
export async function siteReadiness({ ops, env, fetch, origin, upload = true, now = Date.now }) {
  const missing = [
    !ops.project && "project",
    !ops.domains?.admin && "domains.admin",
    !ops.domains?.frontend && !origin && "domains.frontend",
  ].filter(Boolean);
  if (missing.length > 0) {
    return result([
      {
        area: "cms",
        ...notReady(
          "config",
          `gq.ops.json lacks ${missing.join(", ")}`,
          "fill them in (docs/guides/provisioning.md), then gq sync",
        ),
      },
    ]);
  }
  const frontend = origin ?? new URL(`https://${ops.domains.frontend}`);
  const languages = siteLanguages(ops);
  const checks = [
    ...(await cmsReadiness({
      graphqlUrl: wordpressGraphqlUrl(ops),
      env,
      fetch,
      languages,
    })),
    ...(await frontendReadiness({
      origin: frontend,
      project: ops.project,
      env,
      fetch,
      now,
      languages,
    })),
    ...(await cmsDeliveryReadiness({ ops, env, fetch })),
  ];
  const media = await productionMediaReadiness({ ops, env, fetch, upload, now });
  return result([...checks, ...media.checks.map((check) => ({ area: "media", ...check }))]);
}

export function result(checks) {
  const ready = !checks.some((check) => check.status === "not-ready");
  return { status: ready ? "ready" : "not-ready", ready, checks };
}

// An error's message, without anything a provider echoed past its first line.
function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

export function ok(name, detail) {
  return { name, status: "ok", detail };
}

export function notReady(name, detail, action) {
  return { name, status: "not-ready", detail, action };
}

function warn(name, detail, action) {
  return { name, status: "warn", detail, action };
}

function skipped(name, detail) {
  return { name, status: "skipped", detail };
}
