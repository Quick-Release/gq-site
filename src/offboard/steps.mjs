// What offboarding a Site cuts, and what restoring it brings back, as plans:
// inspectSite() reads, once, everything the Site exposes; cutPlan() and
// restorePlan() turn that reading into ordered items, each "done" (nothing
// left to do), "todo" (with the `apply` that does it) or "manual" (something
// gq can't do, for the operator). Applying only the "todo" items is what
// makes both commands idempotent. The archive (phase 2) plans the same way
// from the same reading.
//
// The cut writes gq.ops.json `offboarded` before anything else, so the
// guards hold while it is half done, and notes in `offboarded.cut` each
// change once made; --restore brings back only those.
//
// An Artifacts-only Site (no github.repository, ADR 0012) has no GitHub
// webhook: a push to its Artifacts repository starts CI. Its cut silences CI
// by taking away every push credential instead: the Artifacts token that
// mints git tokens, then the git tokens still live.

import { isArtifactsOnly } from "../ci/git-artifacts.mjs";
import { webhookUrl } from "../ci/github-setup.mjs";
import { tokenName } from "../cloudflare/tokens.mjs";
import { parseDotenv } from "../dotenv-text.mjs";
import { retryCrontab } from "../ploi/events.mjs";
import { updateManifest } from "../manifest/manifest.mjs";
import {
  artifactsRepositoryName,
  frontendWorker,
  isOwn,
  ownName,
  PUBLICATION_BINDING,
  publicationsStages,
  publicationsStore,
  stageCandidates,
} from "./names.mjs";

export const SUSPEND_REASON = "offboarded";

// Throws unless the Ploi site gq.ops.json's ploi.siteId names is the Site's
// CMS, running as its system user: a stale or copied id (or user) would
// suspend or delete another client's site (or user).
export function assertOwnPloiSite(ops, site) {
  const id = `The Ploi site ${ops.ploi.siteId} (gq.ops.json ploi.siteId)`;
  if (site.domain !== ops.domains.admin) {
    throw new Error(
      `${id} is ${site.domain ?? "unnamed"}, not ${ops.domains.admin} (domains.admin): ${STOP}`,
    );
  }
  if (site.system_user !== ops.ploi.systemUser) {
    throw new Error(
      `${id} runs as ${site.system_user ?? "no system user"}, not ${ops.ploi.systemUser} (ploi.systemUser): ${STOP}`,
    );
  }
}

// Throws unless the site's .env (read, never written) names gq.ops.json's
// ploi.database: Ploi's databases aren't linked to sites, so a copied name
// would back up, archive and delete another client's database.
export async function assertOwnDatabase(ops, ploi) {
  const name = parseDotenv(await ploi.siteEnv()).DB_NAME?.trim();
  if (name !== ops.ploi.database) {
    throw new Error(
      `The Ploi site ${ops.domains.admin}'s .env has ${name ? `DB_NAME ${name}` : "no DB_NAME"}, not ${ops.ploi.database} (gq.ops.json ploi.database): ${STOP}`,
    );
  }
}

const STOP = "stopping before anything changes.";

// The Frontend's non-production stages among the account's `workers`
// ([{ stage, worker, d1 }]): a Worker named `<project>-fe-<stage>` whose
// PUBLICATION_DB binding is the D1 store `<project>-fe-publications-<stage>`,
// which ties it to the project; a name alone could be another project's or
// a hand-deployed Worker's. The rest named like one are `unclear`, and the
// stores named like a stage's that no stage Worker binds are `unbound`.
export async function frontendStages(cloudflare, project, workers) {
  const { candidates, unclear } = stageCandidates(project, workers);
  const stores = publicationsStages(
    project,
    await cloudflare.d1Stores(`${publicationsStore(project)}-`),
  );
  const stages = [];
  for (const { stage, worker } of candidates) {
    const store = stores.find((candidate) => candidate.stage === stage)?.d1;
    const bound = (await cloudflare.workerBindings(worker)).some(
      (binding) =>
        binding.type === "d1" &&
        binding.name === PUBLICATION_BINDING &&
        store !== undefined &&
        (binding.database_id ?? binding.id) === store.uuid,
    );
    if (bound) stages.push({ stage, worker, d1: store });
    else unclear.push(worker);
  }
  const unbound = stores
    .filter(({ stage }) => !stages.some((tied) => tied.stage === stage))
    .map(({ d1 }) => d1);
  return { stages, unclear, unbound };
}

// The plan line for a Worker named like one of the project's Frontend stages
// that nothing ties to it.
export function unclearStage(area, project, worker) {
  return manual(
    area,
    `the Worker ${worker} is named like one of ${project}'s Frontend stages, but no ${PUBLICATION_BINDING} binding to ${publicationsStore(project)}-<stage> ties it to ${project}; check it by hand`,
  );
}

// Everything the Site exposes now, read through `providers`
// (withOffboardingProviders).
export async function inspectSite(providers) {
  const { ops, cloudflare, ploi, github } = providers;
  const site = await ploi.site();
  assertOwnPloiSite(ops, site);
  const crontab = retryCrontab({
    systemUser: ops.ploi.systemUser,
    domain: ops.domains.admin,
  });
  const existingCrontab = (await ploi.crontabs()).find(
    (entry) => entry.user === crontab.user && entry.command === crontab.command,
  );
  const ciUrl = webhookUrl(ops.ci.worker, await cloudflare.accountSubdomain());
  const artifactsOnly = isArtifactsOnly(ops);
  const hooks = artifactsOnly ? [] : await github.hooks();
  // The production Frontend first, then its other stages.
  const { stages, unclear } = await frontendStages(
    cloudflare,
    ops.project,
    await cloudflare.workers(),
  );
  const tokens = await cloudflare.projectTokens();
  const frontends = [];
  for (const worker of [frontendWorker(ops.project), ...stages.map((stage) => stage.worker)]) {
    frontends.push({
      worker,
      domains: await cloudflare.workerDomains(worker),
      subdomain: await cloudflare.workerSubdomain(worker),
    });
  }

  return {
    ops,
    cms: { site, suspended: site.status === "suspended", crontab, existingCrontab },
    frontends,
    unclearStages: unclear,
    media: {
      ...ops.media,
      attached: await cloudflare.bucketDomain(ops.media.bucket, ops.media.domain),
    },
    ci: {
      worker: ops.ci.worker,
      subdomain: await cloudflare.workerSubdomain(ops.ci.worker),
      webhookUrl: ciUrl,
      hooks,
      hook: hooks.find((hook) => hook.config?.url === ciUrl),
    },
    tokens,
    // What can push to an Artifacts-only Site's repository.
    artifacts: artifactsOnly
      ? {
          repository: artifactsRepositoryName(ops),
          tokenName: tokenName(ops.project, "Artifacts"),
          token: tokens.find(({ name }) => name === tokenName(ops.project, "Artifacts")),
          // null once the repository is gone.
          gitTokens: await cloudflare.artifactsGitTokens(
            ops.artifacts.namespace,
            ops.artifacts.repo,
          ),
        }
      : undefined,
    record: ops.offboarded,
  };
}

const done = (area, text) => ({ area, state: "done", text });
const manual = (area, text) => ({ area, state: "manual", text });
const todo = (area, text, apply) => ({ area, state: "todo", text, apply });

// A Worker's workers.dev setting, as offboarded.cut keeps it.
const workersDev = (subdomain) => ({
  enabled: Boolean(subdomain.enabled),
  previewsEnabled: Boolean(subdomain.previews_enabled),
});

// Cutting a Site's public access, in order: the record first (the guards
// hold from then on), the final backup before anything is cut, then CI (so
// no push mid-cut can deploy the Frontend again), the CMS, the Frontend
// (every stage) and media, and the project's tokens last, since the steps
// before them may need what they grant.
export function cutPlan(site, { configPath, now = () => new Date() }) {
  const { ops, cms, frontends, media, ci, artifacts } = site;
  // An Artifacts-only Site's Artifacts token goes with CI, not last.
  const tokens = site.tokens.filter((token) => token !== artifacts?.token);
  const backups = `r2://${ops.backups.bucket}/${ops.backups.prefix ?? "db/"}`;
  // A todo that applies, then notes its change in offboarded.cut: a change
  // that failed is never undone by --restore. With `before`, the note (an
  // original state, kept by ??= from the first run) goes first instead, so
  // it survives a change that half happened.
  const noteCut = (note) =>
    updateManifest(configPath, (manifest) => {
      note((manifest.offboarded.cut ??= {}));
    });
  const cut = (area, text, note, apply, { before = false } = {}) =>
    todo(area, text, async (providers) => {
      if (before) await noteCut(note);
      await apply(providers);
      if (!before) await noteCut(note);
    });
  const disableToken = (area, token, text = `disable ${token.name}`) =>
    cut(
      area,
      text,
      (record) => {
        const disabled = (record.tokens ??= []);
        if (!disabled.includes(token.id)) disabled.push(token.id);
      },
      (p) => p.cloudflare.setTokenStatus(token, "disabled"),
    );
  return [
    site.record
      ? done("Record", `gq.ops.json has offboarded (${site.record.phase}, since ${site.record.at})`)
      : todo(
          "Record",
          "write offboarded to gq.ops.json first, so gq refuses to expose the Site from then on (commit it)",
          () =>
            updateManifest(configPath, (manifest) => {
              manifest.offboarded = { at: now().toISOString(), phase: "cut", cut: {} };
            }),
        ),
    // A suspended CMS can't change its database any more: the backup taken
    // before it was suspended is the final one.
    cms.suspended
      ? done("Backup", "the CMS is suspended, so the backup taken before is the final one")
      : cut(
          "Backup",
          `back up ${ops.ploi.database} to ${backups} before anything is cut`,
          (record) => {
            record.backup = true;
          },
          (providers) => providers.backupDatabase(),
        ),
    // CI first: a push from now on can deploy nothing (the record isn't
    // committed yet, so CI would not refuse).
    ...(artifacts
      ? silenceArtifacts(site, disableToken)
      : [
          ci.hook?.active
            ? cut(
                "CI",
                `deactivate the GitHub push webhook ${ci.hook.id} on ${ops.github.repository}`,
                (record) => {
                  record.webhook = ci.hook.id;
                },
                (p) => p.github.updateHook(ci.hook.id, { active: false }),
              )
            : done("CI", `no active GitHub push webhook to ${ci.webhookUrl}`),
        ]),
    !isOwn(ops.project, "ciWorker", ci.worker)
      ? manual(
          "CI",
          `the CI Worker ${ci.worker} isn't ${ops.project}'s own (gq names it ${ownName(ops.project, "ciWorker")}): its workers.dev stays on; switch it off by hand if only ${ops.project} uses it`,
        )
      : ci.subdomain.enabled || ci.subdomain.previews_enabled
        ? cut(
            "CI",
            `switch the CI Worker ${ci.worker}'s workers.dev off`,
            (record) => {
              (record.workersDev ??= {})[ci.worker] ??= workersDev(ci.subdomain);
            },
            (p) =>
              p.cloudflare.setWorkerSubdomain(ci.worker, {
                enabled: false,
                previewsEnabled: false,
              }),
            { before: true },
          )
        : done("CI", `the CI Worker ${ci.worker}'s workers.dev is off`),
    cms.existingCrontab
      ? cut(
          "CMS",
          `delete the retry crontab (${cms.crontab.user}: wp gq-events retry-due)`,
          (record) => {
            const { user, frequency, command } = cms.existingCrontab;
            record.crontab = { user, frequency, command };
          },
          (p) => p.ploi.deleteCrontab(cms.existingCrontab.id),
        )
      : done("CMS", "no retry crontab"),
    cms.suspended
      ? done("CMS", `the Ploi site ${ops.domains.admin} is suspended`)
      : cut(
          "CMS",
          `suspend the Ploi site ${ops.domains.admin} (reason "${SUSPEND_REASON}"); its files, .env and database stay`,
          (record) => {
            record.suspended = true;
          },
          (p) => p.ploi.suspend(SUSPEND_REASON),
        ),
    manual(
      "CMS",
      "Ploi's API can't disable the site's deploy webhook; the suspension is what stops it",
    ),
    manual(
      "CMS",
      `the DNS record for ${ops.domains.admin} was added by hand; remove it by hand if it should go`,
    ),
    ...frontends.flatMap((frontend) => [
      ...(frontend.domains.length > 0
        ? frontend.domains.map((domain) =>
            cut(
              "Frontend",
              `detach ${domain.hostname} from the Worker ${frontend.worker}`,
              (record) => {
                const detached = (record.workerDomains ??= []);
                if (!detached.some(({ hostname }) => hostname === domain.hostname)) {
                  detached.push({
                    hostname: domain.hostname,
                    service: frontend.worker,
                    zoneId: domain.zone_id,
                  });
                }
              },
              (p) => p.cloudflare.detachWorkerDomain(domain.id),
            ),
          )
        : [done("Frontend", `the Worker ${frontend.worker} has no custom domain`)]),
      frontend.subdomain.enabled || frontend.subdomain.previews_enabled
        ? cut(
            "Frontend",
            `switch the Worker ${frontend.worker}'s workers.dev and preview URLs off (the Worker and its D1 store stay)`,
            (record) => {
              (record.workersDev ??= {})[frontend.worker] ??= workersDev(frontend.subdomain);
            },
            (p) =>
              p.cloudflare.setWorkerSubdomain(frontend.worker, {
                enabled: false,
                previewsEnabled: false,
              }),
            { before: true },
          )
        : done("Frontend", `the Worker ${frontend.worker}'s workers.dev and preview URLs are off`),
    ]),
    ...site.unclearStages.map((worker) => unclearStage("Frontend", ops.project, worker)),
    !isOwn(ops.project, "mediaBucket", media.bucket)
      ? manual(
          "Media",
          `the bucket ${media.bucket} isn't ${ops.project}'s own (gq names it ${ownName(ops.project, "mediaBucket")}): https://${media.domain} stays enabled; disable it by hand if only ${ops.project} uses it`,
        )
      : media.attached?.enabled
        ? cut(
            "Media",
            `disable https://${media.domain} on the bucket ${media.bucket} (the bucket and its objects stay)`,
            (record) => {
              record.mediaDomain = media.domain;
            },
            (p) => p.cloudflare.setBucketDomain(media.bucket, media.domain, false),
          )
        : done(
            "Media",
            `https://${media.domain} is ${media.attached ? "disabled" : "not attached"}`,
          ),
    ...tokens.map((token) =>
      token.status === "active"
        ? disableToken("Tokens", token)
        : done("Tokens", `${token.name} is ${token.status}`),
    ),
  ];
}

// An Artifacts-only Site's push credentials taken away: its Artifacts token
// disabled first, so no git token can be minted, then every git token still
// active revoked, listed again once the token is disabled, so none minted
// since the plan was read survives. Git tokens last an hour at most, and the
// credential helper mints new ones once the token is enabled again, so
// --restore brings none back.
function silenceArtifacts(site, disableToken) {
  const { ops, artifacts } = site;
  const { token, gitTokens, repository } = artifacts;
  const { namespace, repo } = ops.artifacts;
  // While the token is active, a git token can still be minted before it is
  // disabled.
  const minting = token?.status === "active";
  return [
    !token
      ? done("CI", `there is no ${artifacts.tokenName} token to mint git tokens with`)
      : minting
        ? disableToken(
            "CI",
            token,
            `disable ${token.name}, so no git token for the Artifacts repository ${repository} can be minted (${ops.project} is Artifacts-only: a push there starts CI)`,
          )
        : done("CI", `${token.name} is ${token.status}`),
    gitTokens === null
      ? done("CI", `the Artifacts repository ${repository} is gone, so nothing can be pushed to it`)
      : minting || gitTokens.length > 0
        ? todo(
            "CI",
            `revoke every active git token for the Artifacts repository ${repository} (${gitTokens.length} now)`,
            async (p) => {
              const live = (await p.cloudflare.artifactsGitTokens(namespace, repo)) ?? [];
              for (const gitToken of live) {
                await p.cloudflare.revokeArtifactsGitToken(namespace, gitToken.id);
              }
            },
          )
        : done("CI", `no active git token for the Artifacts repository ${repository}`),
  ];
}

// Bringing a cut Site back, in the reverse order, and only what the cut
// changed (gq.ops.json offboarded.cut): its tokens first, then media, the
// Frontend's domains and workers.dev as they were, the CMS, and CI (its
// Worker before the webhook that reaches it); then gq.ops.json loses
// `offboarded`. Tokens are re-enabled, never recreated.
export function restorePlan(site, { configPath }) {
  const { ops, cms, frontends, media, ci, tokens } = site;
  const cut = site.record?.cut ?? {};
  const disabled = new Set(cut.tokens ?? []);
  const restoredWorkersDev = (area, worker, setting, subdomain) =>
    !subdomain
      ? manual(area, `the Worker ${worker} is gone; its workers.dev can't come back`)
      : subdomain.enabled === setting.enabled &&
          Boolean(subdomain.previews_enabled) === setting.previewsEnabled
        ? done(area, `the Worker ${worker}'s workers.dev and preview URLs are as before`)
        : todo(
            area,
            `switch the Worker ${worker}'s workers.dev ${setting.enabled ? "on" : "off"} and its preview URLs ${setting.previewsEnabled ? "on" : "off"}, as before`,
            (p) => p.cloudflare.setWorkerSubdomain(worker, setting),
          );
  const hook = ci.hooks.find(({ id }) => id === cut.webhook);
  return [
    ...(site.record && !site.record.cut
      ? [
          manual(
            "Record",
            "gq.ops.json offboarded records nothing the cut changed: restore by hand",
          ),
        ]
      : []),
    ...tokens.flatMap((token) => {
      if (!disabled.has(token.id)) {
        return token.status === "active"
          ? []
          : [
              manual(
                "Tokens",
                `${token.name} stays ${token.status}: gq offboard didn't disable it`,
              ),
            ];
      }
      return token.status === "active"
        ? [done("Tokens", `${token.name} is active`)]
        : [
            todo("Tokens", `re-enable ${token.name}`, (p) =>
              p.cloudflare.setTokenStatus(token, "active"),
            ),
          ];
    }),
    ...[...disabled]
      .filter((id) => !tokens.some((token) => token.id === id))
      .map((id) =>
        manual(
          "Tokens",
          `the token ${id} the cut disabled is gone: the gq command that made it makes it again`,
        ),
      ),
    ...(!cut.mediaDomain
      ? []
      : !media.attached
        ? [manual("Media", `https://${media.domain} isn't attached: run pnpm cf:media`)]
        : media.attached.enabled
          ? [done("Media", `https://${media.domain} is enabled`)]
          : [
              todo(
                "Media",
                `re-enable https://${media.domain} on the bucket ${media.bucket}`,
                (p) => p.cloudflare.setBucketDomain(media.bucket, media.domain, true),
              ),
            ]),
    ...(cut.workerDomains ?? []).map(({ hostname, service, zoneId }) =>
      frontends
        .find(({ worker }) => worker === service)
        ?.domains.some((domain) => domain.hostname === hostname)
        ? done("Frontend", `${hostname} is attached to the Worker ${service}`)
        : todo("Frontend", `attach ${hostname} to the Worker ${service}`, (p) =>
            p.cloudflare.attachWorkerDomain({ hostname, service, zoneId }),
          ),
    ),
    ...Object.entries(cut.workersDev ?? {})
      .filter(([worker]) => worker !== ci.worker)
      .map(([worker, setting]) =>
        restoredWorkersDev(
          "Frontend",
          worker,
          setting,
          frontends.find((frontend) => frontend.worker === worker)?.subdomain,
        ),
      ),
    ...(cut.suspended
      ? [
          cms.suspended
            ? todo("CMS", `resume the Ploi site ${ops.domains.admin}`, (p) => p.ploi.resume())
            : done("CMS", `the Ploi site ${ops.domains.admin} is active`),
        ]
      : []),
    ...(cut.crontab
      ? [
          cms.existingCrontab
            ? done("CMS", "the retry crontab is there")
            : todo(
                "CMS",
                `re-add the retry crontab (${cut.crontab.user}: wp gq-events retry-due)`,
                (p) => p.ploi.createCrontab(cut.crontab),
              ),
        ]
      : []),
    manual("CMS", `if you removed the DNS record for ${ops.domains.admin}, add it back by hand`),
    ...(cut.workersDev?.[ci.worker]
      ? [restoredWorkersDev("CI", ci.worker, cut.workersDev[ci.worker], ci.subdomain)]
      : []),
    ...(cut.webhook === undefined
      ? []
      : !hook
        ? [manual("CI", `the GitHub push webhook ${cut.webhook} is gone: run pnpm github:setup`)]
        : hook.active
          ? [done("CI", `the GitHub push webhook ${hook.id} is active`)]
          : [
              todo(
                "CI",
                `reactivate the GitHub push webhook ${hook.id} on ${ops.github.repository}`,
                (p) => p.github.updateHook(hook.id, { active: true }),
              ),
            ]),
    site.record
      ? todo("Record", "remove offboarded from gq.ops.json (commit it)", () =>
          updateManifest(configPath, (manifest) => {
            delete manifest.offboarded;
          }),
        )
      : done("Record", "gq.ops.json has no offboarded"),
  ];
}
