// Archiving an offboarded Site (phase 2, ADR 0011), as a plan steps.mjs's way:
// inspectArchive() reads, once, what is left to archive and delete;
// archivePlan() turns it into ordered items ("done", "todo" with its
// `apply`, or "manual"). The archive goes first: every media object
// (uploads.zip), a fresh database dump, the D1 store's export, the database
// backups, gq.ops.json and a manifest.json of them all, under
// r2://offboarded-clients/<project>/<UTC date>/. It is verified by reading it
// all back, and recorded in gq.ops.json (`offboarded.archive`) only then;
// nothing is deleted before. The deletions follow gq-smoke-down's order,
// with the project's tokens last, then GitHub's webhook; then the record,
// committed and pushed before the repository is archived (repository.mjs).
//
// An Artifacts-only Site (no github.repository, ADR 0012) has no GitHub
// repository to archive read-only: its code is archived too, as code.bundle
// (a git bundle of every ref of its Artifacts repository), whose refs are
// read again from the repository when the archive is verified, so nothing
// pushed since is lost when the repository is deleted. There is no webhook
// to delete, and nowhere to push the record.
//
// A rerun skips a recorded archive (it never archives over a verified one)
// and deletes only what is still there, so a failed run is finished by
// running it again.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";

import { isArtifactsOnly } from "../ci/git-artifacts.mjs";
import { webhookUrl } from "../ci/github-setup.mjs";
import { updateManifest } from "../manifest/manifest.mjs";
import { VERSION } from "../version.mjs";
import {
  artifactsRepositoryName,
  frontendWorker,
  isOwn as isOwnName,
  ownName,
  publicationsStore,
} from "./names.mjs";
import { archivesRepository, inspectRepository, repositoryItems } from "./repository.mjs";
import { assertOwnDatabase, assertOwnPloiSite, frontendStages, unclearStage } from "./steps.mjs";
import { ZIP_TAIL_BYTES, zipEntryCount, zipStream } from "./zip.mjs";

// The private bucket every offboarded client's archive goes to.
export const ARCHIVE_BUCKET = "offboarded-clients";

// The DNS records that point a host at the Site, which the archive deletes;
// any other type at its hosts (MX, TXT, CAA) may be the client's own.
const SERVING_RECORDS = new Set(["A", "AAAA", "CNAME"]);

// How many objects are deleted at once when a bucket is emptied.
const DELETE_CONCURRENCY = 8;

// What is left of an archived (or cut) Site, read through `providers`
// (withOffboardingProviders with `archive`). `now` dates a new archive.
export async function inspectArchive(providers, { now = () => new Date() } = {}) {
  const { ops, cloudflare, ploi, github } = providers;
  const artifactsOnly = isArtifactsOnly(ops);
  const site = await ploi.existingSite();
  if (site) {
    assertOwnPloiSite(ops, site);
    await assertOwnDatabase(ops, ploi);
  }
  const frontend = frontendWorker(ops.project);
  const d1Name = publicationsStore(ops.project);
  const workers = await cloudflare.workers();
  const frontendExists = await cloudflare.workerExists(frontend);
  const containerName = `${ops.ci.worker}-cisandbox`;
  // The buckets deleted whole. The backups bucket isn't one of them unless
  // it is also one of these: it may hold other Sites' backups.
  const buckets = [];
  const roles = [
    ["mediaBucket", ops.media.bucket],
    ["releasesBucket", ops.releases.bucket],
    ["ciBackupBucket", ops.ci.backupBucket],
  ];
  for (const name of new Set(roles.map(([, bucket]) => bucket))) {
    const named = roles.filter(([, bucket]) => bucket === name).map(([role]) => role);
    buckets.push({
      name,
      exists: await cloudflare.bucketExists(name),
      // Own when gq names it so in any role gq.ops.json gives it.
      own: named.some((role) => isOwn(ops, role, name)),
      role: named[0],
    });
  }
  const mediaExists = buckets.find(({ name }) => name === ops.media.bucket).exists;
  // A media bucket that isn't the project's own may hold other clients'
  // uploads and serve them at its domain: it is neither archived nor
  // detached, and its domain's records stay.
  const mediaOwn = isOwn(ops, "mediaBucket", ops.media.bucket);
  // The records at the Site's own hosts; none at the zone's apex, which
  // carries the zone's own (mail, verification) whatever serves it.
  const zoneName = await cloudflare.zoneName();
  const hosts = [ops.domains.admin, ops.domains.frontend, ...(mediaOwn ? [ops.media.domain] : [])];
  const apexHosts = hosts.filter((host) => host.toLowerCase() === zoneName.toLowerCase());
  const records = [];
  for (const host of hosts.filter((host) => !apexHosts.includes(host))) {
    records.push(...(await cloudflare.dnsRecords(host)));
  }
  const ciUrl = webhookUrl(ops.ci.worker, await cloudflare.accountSubdomain());
  const database = (await ploi.databases()).find(({ name }) => name === ops.ploi.database);
  const d1 = await cloudflare.d1(d1Name);
  const { stages, unclear, unbound } = await frontendStages(cloudflare, ops.project, workers);
  const artifacts = await cloudflare.artifactsRepository(
    ops.artifacts.namespace,
    ops.artifacts.repo,
  );
  // What a new archive reads from, so it can't be gone already.
  const sources = [
    [site, `the Ploi site ${ops.domains.admin}`],
    [database, `the database ${ops.ploi.database}`],
    [frontendExists, `the Frontend Worker ${frontend}`],
    [d1, `the D1 store ${d1Name}`],
    ...(mediaOwn ? [[mediaExists, `the media bucket ${ops.media.bucket}`]] : []),
    ...(artifactsOnly
      ? [[artifacts, `the Artifacts repository ${artifactsRepositoryName(ops)}`]]
      : []),
  ];
  const gone = sources.filter(([present]) => !present).map(([, source]) => source);
  const backups = await inspectBackups(providers, buckets);

  return {
    ops,
    archive: await inspectContents(providers, {
      now,
      gone,
      wholeBackups: backups.withBucket,
      mediaOwn,
      artifactsOnly,
      artifactsExists: Boolean(artifacts),
    }),
    ploi: {
      site,
      database,
      systemUser: (await ploi.systemUsers()).find(({ name }) => name === ops.ploi.systemUser),
      // The server's other sites that run as the Site's system user.
      sharing: (await ploi.sites()).filter(
        (other) =>
          String(other.id) !== String(ops.ploi.siteId) && other.system_user === ops.ploi.systemUser,
      ),
    },
    frontend: {
      worker: frontend,
      exists: frontendExists,
      d1,
      d1Name,
      // Its other stages: their Workers, and their D1 stores by stage.
      stages: stages.map(({ worker }) => worker),
      unclear,
      stores: stages.map(({ stage, d1 }) => ({ stage, d1 })),
      unbound,
    },
    ci: {
      worker: ops.ci.worker,
      exists: await cloudflare.workerExists(ops.ci.worker),
      workflows: await existing([ops.ci.worker, ownName(ops.project, "mirrorWorkflow")], (name) =>
        cloudflare.workflowExists(name),
      ),
      container: (await cloudflare.containerApplications()).find(
        ({ name }) => name.toLowerCase() === containerName,
      ),
      hook: artifactsOnly
        ? undefined
        : (await github.hooks()).find((hook) => hook.config?.url === ciUrl),
    },
    mediaOwn,
    mediaDomain:
      mediaExists && mediaOwn
        ? await cloudflare.bucketDomain(ops.media.bucket, ops.media.domain)
        : undefined,
    buckets,
    backups,
    artifacts,
    artifactsOnly,
    records,
    apexHosts,
    zoneName,
    tokens: await cloudflare.projectTokens(),
    repository: artifactsOnly ? undefined : await inspectRepository(providers),
  };
}

// Those of `names` that `exists(name)` finds, in order.
async function existing(names, exists) {
  const found = [];
  for (const name of names) if (await exists(name)) found.push(name);
  return found;
}

// The Site's own database backups (`gq db backup` writes them under
// <backups.prefix><database>/), and whether they go with a bucket deleted
// whole; otherwise only they are deleted, once archived.
async function inspectBackups(providers, buckets) {
  const { ops, cloudflare } = providers;
  const { bucket } = ops.backups;
  const prefix = ownBackupsPrefix(ops);
  const withBucket = buckets.some((listed) => listed.name === bucket && listed.own);
  const objects =
    withBucket || !(await cloudflare.bucketExists(bucket))
      ? []
      : await (await providers.r2(bucket)).list(prefix);
  return { bucket, prefix, withBucket, objects };
}

function ownBackupsPrefix(ops) {
  return `${ops.backups.prefix ?? "db/"}${ops.ploi.database}/`;
}

function isOwn(ops, role, name) {
  return isOwnName(ops.project, role, name);
}

// The archive recorded in gq.ops.json (whose manifest.json must still be
// there, unchanged), or what a new one would hold. A new one starts only
// when every source it reads (`gone` names those missing) is still there and
// nothing is under its prefix yet: either would mean an archive whose record
// was lost, which a new one would overwrite or miss content from. Its
// backups/ holds the Site's own backups, or everything under backups.prefix
// when the backups bucket goes whole (`wholeBackups`). An Artifacts-only
// Site's code is read from its Artifacts repository (`code`: its refs);
// another's is in its GitHub repository (`head`: its HEAD commit).
async function inspectContents(
  providers,
  { now, gone, wholeBackups, mediaOwn, artifactsOnly, artifactsExists },
) {
  const { ops, cloudflare, github } = providers;
  const recorded = ops.offboarded?.archive;
  if (recorded) {
    const bucket = await providers.r2(recorded.bucket);
    const manifest = await readBack(bucket, `${recorded.prefix}manifest.json`);
    if (manifest?.sha256 !== recorded.manifestSha256) {
      throw new Error(
        `r2://${recorded.bucket}/${recorded.prefix}manifest.json ${manifest ? "doesn't match" : "is missing, unlike"} gq.ops.json offboarded.archive: stopping before anything else is deleted.`,
      );
    }
    if (!artifactsOnly) return { recorded };
    const contents = JSON.parse(
      await text((await bucket.get(`${recorded.prefix}manifest.json`)).body),
    );
    if (artifactsExists) await assertRefsArchived(providers, contents, recorded);
    return { recorded, files: contents.files };
  }
  const stop = "stopping before anything is written or deleted.";
  if (gone.length > 0) {
    throw new Error(
      `${gone.join(", ")} ${gone.length > 1 ? "are" : "is"} already gone, but gq.ops.json records no archive (offboarded.archive): a new archive would miss ${gone.length > 1 ? "them" : "it"}. If ${ops.project} was archived, record that archive in gq.ops.json from its manifest.json; ${stop}`,
    );
  }
  const prefix = `${ops.project}/${now().toISOString().slice(0, 10)}/`;
  const bucketExists = await cloudflare.bucketExists(ARCHIVE_BUCKET);
  const there = bucketExists ? await (await providers.r2(ARCHIVE_BUCKET)).list(prefix) : [];
  if (there.length > 0) {
    throw new Error(
      `r2://${ARCHIVE_BUCKET}/${prefix} already holds ${there.length} objects, and gq.ops.json records no archive: gq never archives over them. If they are a verified archive, record it in gq.ops.json offboarded.archive (with its manifest.json's sha256); otherwise move them aside. Then run gq offboard --archive again; ${stop}`,
    );
  }
  const backupsPrefix = ops.backups.prefix ?? "db/";
  const backupsFrom = wholeBackups ? backupsPrefix : ownBackupsPrefix(ops);
  const backups = await (await providers.r2(ops.backups.bucket)).list(backupsFrom);
  const own = backups.filter(({ key }) => key.startsWith(ownBackupsPrefix(ops)));
  if (own.length === 0 && ops.offboarded?.cut?.backup) {
    throw new Error(
      `There is no database backup under r2://${ops.backups.bucket}/${ownBackupsPrefix(ops)}, though gq offboard took a final one there: ${stop}`,
    );
  }
  return {
    prefix,
    bucketExists,
    media: mediaOwn ? await (await providers.r2(ops.media.bucket)).list() : undefined,
    backups,
    backupsPrefix,
    backupsFrom,
    ...(artifactsOnly
      ? { code: { refs: await providers.code.refs() } }
      : { head: await github.headCommit() }),
  };
}

// Throws unless an Artifacts-only Site's repository, still there when an
// archive is resumed, holds the refs the recorded manifest.json has for
// code.bundle: anything pushed since would be lost with it.
async function assertRefsArchived(providers, manifest, recorded) {
  const key = `${recorded.prefix}manifest.json`;
  const differing = differingRefs(
    await providers.code.refs(),
    manifest.sources?.artifacts?.refs ?? {},
  );
  if (differing.length > 0) {
    throw new Error(
      `The Artifacts repository ${artifactsRepositoryName(providers.ops)}'s refs differ from those r2://${recorded.bucket}/${key} records for code.bundle (${differing.join(", ")}): stopping before anything else is deleted.`,
    );
  }
}

// The refs `a` and `b` (each { ref: sha }) don't agree on.
function differingRefs(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((ref) => a[ref] !== b[ref]);
}

const done = (area, text) => ({ area, state: "done", text });
const manual = (area, text) => ({ area, state: "manual", text });
const todo = (area, text, apply) => ({ area, state: "todo", text, apply });

// Archiving, verifying, then deleting, in order. `result()` is the recorded
// archive once the plan is applied; `archivesRepository` whether the plan
// pushes the record and archives the repository too. `hasCodeBundle()` reads
// the archived files, including the recorded manifest's on a resumed run.
export function archivePlan(site, { configPath, now = () => new Date() }) {
  const { ops, archive } = site;
  // An Artifacts-only Site's refs, as code.bundle holds them once made (none
  // for a repository without refs, which has nothing to bundle).
  const session = { files: [], ...(archive.code ? { refs: {} } : {}) };
  const items = [
    ...archiveItems(site, { configPath, now, session }),
    ...deletionItems(site, { configPath }),
    todo("Record", 'offboarded.phase becomes "archived" in gq.ops.json', () =>
      updateManifest(configPath, (manifest) => {
        manifest.offboarded = {
          at: now().toISOString(),
          phase: "archived",
          archive: manifest.offboarded.archive,
        };
      }),
    ),
    ...(site.artifactsOnly
      ? [
          manual(
            "Git",
            `commit gq.ops.json's archived record in this checkout: ${ops.project} is Artifacts-only, so its repository, deleted above, takes no push (code.bundle keeps its code)`,
          ),
        ]
      : repositoryItems(site.repository, ops)),
    manual(
      "Sigillo",
      `the project ${ops.sigillo?.projectId ?? "(gq.ops.json sigillo.projectId)"} is kept, with the Site's secrets`,
    ),
  ];
  return {
    items,
    result: () => archive.recorded ?? session.recorded,
    hasCodeBundle: () =>
      (archive.files ?? session.files).some(({ path }) => path === "code.bundle"),
    archivesRepository: !site.artifactsOnly && archivesRepository(site.repository),
  };
}

function archiveItems(site, { configPath, now, session }) {
  const { ops, archive } = site;
  if (archive.recorded) {
    const { bucket, prefix, manifestSha256 } = archive.recorded;
    return [
      done(
        "Archive",
        `r2://${bucket}/${prefix} is verified and recorded (manifest.json sha256 ${manifestSha256.slice(0, 12)}…); it is never archived again`,
      ),
    ];
  }
  const at = `r2://${ARCHIVE_BUCKET}/${archive.prefix}`;
  // Production's D1 store, then each other stage's.
  const stores = [
    { path: "publications.sql", store: site.frontend.d1 },
    ...site.frontend.stores.map(({ stage, d1 }) => ({
      path: `publications-${stage}.sql`,
      store: d1,
    })),
  ];
  return [
    archive.bucketExists
      ? done("Archive", `the private bucket ${ARCHIVE_BUCKET} exists`)
      : todo("Archive", `create the private bucket ${ARCHIVE_BUCKET} (no custom domain)`, (p) =>
          p.cloudflare.createBucket(ARCHIVE_BUCKET),
        ),
    archive.media
      ? todo(
          "Archive",
          `${at}uploads.zip ← the ${archive.media.length} objects of ${ops.media.bucket}, keys kept`,
          async (p) => {
            session.files.push(await archiveUploads(p, archive));
          },
        )
      : manual(
          "Archive",
          `the bucket ${ops.media.bucket} isn't ${ops.project}'s own (gq names it ${ownName(ops.project, "mediaBucket")}): none of its objects is archived; archive ${ops.project}'s uploads by hand`,
        ),
    todo("Archive", `${at}database.sql.gz ← a fresh dump of ${ops.ploi.database}`, async (p) => {
      const bucket = await p.r2(ARCHIVE_BUCKET);
      const dump = await p.dumpDatabase(
        await bucket.presignPut(`${archive.prefix}database.sql.gz`),
      );
      session.files.push({ path: "database.sql.gz", size: dump.bytes, sha256: dump.sha256 });
    }),
    ...stores.map(({ path, store }) =>
      todo("Archive", `${at}${path} ← the D1 store ${store.name}`, async (p) => {
        const exported = await p.cloudflare.exportD1(store.uuid);
        const bucket = await p.r2(ARCHIVE_BUCKET);
        const stored = await bucket.upload(
          `${archive.prefix}${path}`,
          exported.body,
          "application/sql",
        );
        session.files.push({ path, ...stored });
      }),
    ),
    todo(
      "Archive",
      `${at}backups/ ← the ${archive.backups.length} database backups in r2://${ops.backups.bucket}/${archive.backupsFrom}`,
      async (p) => {
        const source = await p.r2(ops.backups.bucket);
        const bucket = await p.r2(ARCHIVE_BUCKET);
        for (const backup of await source.list(archive.backupsFrom)) {
          const path = `backups/${backup.key.slice(archive.backupsPrefix.length)}`;
          const response = await source.get(backup.key);
          const stored = await bucket.upload(
            `${archive.prefix}${path}`,
            listedBytes(response.body, backup, ops.backups.bucket, archive.prefix),
            "application/gzip",
          );
          session.files.push({ path, ...stored });
        }
      },
    ),
    ...(archive.code ? [codeItem(site, at, session)] : []),
    todo(
      "Archive",
      `${at}gq.ops.json, and manifest.json (each file's size and sha256, and the source resources)`,
      async (p) => {
        const bucket = await p.r2(ARCHIVE_BUCKET);
        const config = await readFile(configPath);
        const stored = await bucket.upload(
          `${archive.prefix}gq.ops.json`,
          [config],
          "application/json",
        );
        session.files.push({ path: "gq.ops.json", ...stored });
        session.manifest = manifestOf(site, session, now());
        const written = await bucket.upload(
          `${archive.prefix}manifest.json`,
          [Buffer.from(`${JSON.stringify(session.manifest, null, 2)}\n`)],
          "application/json",
        );
        session.manifestSha256 = written.sha256;
      },
    ),
    todo(
      "Verify",
      `${listed([
        "re-read every archived file against manifest.json",
        ...(archive.media ? [`count uploads.zip's entries against ${ops.media.bucket}`] : []),
        ...(archive.code
          ? [
              `read the Artifacts repository ${artifactsRepositoryName(ops)}'s refs again against code.bundle's`,
            ]
          : []),
      ])}; nothing is deleted unless all match, then gq.ops.json records the archive`,
      async (p) => {
        await verifyArchive(p, archive.prefix, session);
        session.recorded = {
          bucket: ARCHIVE_BUCKET,
          prefix: archive.prefix,
          manifestSha256: session.manifestSha256,
        };
        await updateManifest(configPath, (manifest) => {
          manifest.offboarded.archive = session.recorded;
        });
      },
    ),
  ];
}

// "a", "a, and b", "a, b, and c".
function listed(parts) {
  if (parts.length < 3) return parts.join(", and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

// An Artifacts-only Site's code: a git bundle of every ref of its Artifacts
// repository, made from a mirror clone; `session.refs` become the refs it
// holds, which the verification reads again from the repository.
function codeItem(site, at, session) {
  const { ops, archive } = site;
  const { refs } = archive.code;
  const count = Object.keys(refs).length;
  if (count === 0) {
    return done(
      "Archive",
      `the Artifacts repository ${artifactsRepositoryName(ops)} has no refs: there is no code to archive`,
    );
  }
  return todo(
    "Archive",
    `${at}code.bundle ← the ${count} ref${count > 1 ? "s" : ""} of the Artifacts repository ${artifactsRepositoryName(ops)} (a git bundle of every ref)`,
    (p) =>
      p.code.bundle(async ({ path, refs: bundled }) => {
        const bucket = await p.r2(ARCHIVE_BUCKET);
        const stored = await bucket.upload(
          `${archive.prefix}code.bundle`,
          createReadStream(path),
          "application/x-git-bundle",
        );
        session.files.push({ path: "code.bundle", ...stored });
        session.refs = bundled;
      }),
  );
}

// Every media object into one ZIP, streamed object by object.
async function archiveUploads(providers, archive) {
  const { ops } = providers;
  const media = await providers.r2(ops.media.bucket);
  const objects = await media.list();
  const zip = zipStream(
    objects.map((object) => ({
      name: object.key,
      modified: object.lastModified,
      open: async () =>
        listedBytes((await media.get(object.key)).body, object, ops.media.bucket, archive.prefix),
    })),
  );
  const bucket = await providers.r2(ARCHIVE_BUCKET);
  const stored = await bucket.upload(`${archive.prefix}uploads.zip`, zip, "application/zip");
  return { path: "uploads.zip", ...stored, entries: objects.length };
}

// An object's `body`, which throws at its end unless it held as many bytes
// as `object`'s listing in `bucket` says: a body cut short without an error
// must not be archived (and verified) as if it were whole. What the run
// already wrote under the archive's `prefix` blocks a rerun until moved.
async function* listedBytes(body, object, bucket, prefix) {
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.length;
    yield chunk;
  }
  if (size !== object.size) {
    throw new Error(
      `${object.key} read ${size} bytes, but r2://${bucket} lists ${object.size}: stopping before anything is deleted. Move what this run wrote under r2://${ARCHIVE_BUCKET}/${prefix} aside, then run gq offboard --archive again.`,
    );
  }
}

// What manifest.json records: each file, and where everything came from.
// An Artifacts-only Site's refs are those code.bundle holds.
function manifestOf(site, { files, refs }, date) {
  const { ops, archive, ploi, frontend, ci } = site;
  return {
    project: ops.project,
    archivedAt: date.toISOString(),
    gq: VERSION,
    bucket: ARCHIVE_BUCKET,
    prefix: archive.prefix,
    files,
    sources: {
      media: { bucket: ops.media.bucket, domain: ops.media.domain },
      backups: { bucket: ops.backups.bucket, prefix: archive.backupsFrom },
      releases: { bucket: ops.releases.bucket },
      ciBackups: { bucket: ops.ci.backupBucket },
      ploi: {
        serverId: ops.ploi.serverId,
        siteId: ops.ploi.siteId ?? null,
        domain: ops.domains.admin,
        database: { name: ops.ploi.database, id: ploi.database?.id ?? null },
        systemUser: { name: ops.ploi.systemUser, id: ploi.systemUser?.id ?? null },
      },
      frontend: {
        worker: frontend.worker,
        domain: ops.domains.frontend,
        d1: frontend.d1 ? { name: frontend.d1.name, id: frontend.d1.uuid } : null,
        stages: frontend.stores.map(({ stage, d1 }) => ({
          worker: `${frontend.worker}-${stage}`,
          d1: { name: d1.name, id: d1.uuid },
        })),
      },
      ci: {
        worker: ci.worker,
        workflows: ci.workflows,
        containerApplication: ci.container?.name ?? null,
      },
      artifacts: {
        namespace: ops.artifacts.namespace,
        repo: ops.artifacts.repo,
        ...(site.artifactsOnly ? { refs } : {}),
      },
      github: site.artifactsOnly ? null : { repository: ops.github.repository, head: archive.head },
      cloudflare: {
        accountId: ops.cloudflare.accountId,
        zoneId: ops.cloudflare.zoneId,
        zoneName: ops.cloudflare.zoneName ?? null,
      },
      sigillo: { projectId: ops.sigillo?.projectId ?? null },
    },
  };
}

// Reads every archived file back and compares it with what was written;
// throws, naming each difference, before anything is deleted.
async function verifyArchive(providers, prefix, session) {
  const bucket = await providers.r2(ARCHIVE_BUCKET);
  const problems = [];
  for (const file of session.manifest.files) {
    const read = await readBack(bucket, `${prefix}${file.path}`, {
      tail: file.path === "uploads.zip",
    });
    if (!read) {
      problems.push(`${file.path} can't be read back`);
      continue;
    }
    if (read.size !== file.size)
      problems.push(`${file.path} is ${read.size} bytes, not ${file.size}`);
    else if (read.sha256 !== file.sha256) problems.push(`${file.path}'s sha256 differs`);
    if (file.entries !== undefined) {
      const entries = zipEntryCount(read.tail);
      const objects = (await (await providers.r2(providers.ops.media.bucket)).list()).length;
      if (entries !== objects) {
        problems.push(
          `uploads.zip holds ${entries ?? "no readable"} entries, but ${providers.ops.media.bucket} has ${objects} objects`,
        );
      }
    }
  }
  // Nothing pushed to an Artifacts-only Site's repository since code.bundle
  // was made: it is deleted next.
  if (session.refs) {
    const differing = differingRefs(await providers.code.refs(), session.refs);
    if (differing.length > 0) {
      problems.push(
        `the Artifacts repository ${artifactsRepositoryName(providers.ops)}'s refs differ from code.bundle's (${differing.join(", ")})`,
      );
    }
  }
  const manifest = await readBack(bucket, `${prefix}manifest.json`);
  if (manifest?.sha256 !== session.manifestSha256) problems.push("manifest.json differs");
  if (problems.length > 0) {
    throw new Error(
      `The archive at r2://${ARCHIVE_BUCKET}/${prefix} failed verification: ${problems.join("; ")}. Nothing was deleted. Move the unverified files there aside, then run gq offboard --archive again.`,
    );
  }
}

// An object's size and sha256 (and its last bytes, with `tail`), streamed;
// null when it can't be read.
async function readBack(bucket, key, { tail = false } = {}) {
  let response;
  try {
    response = await bucket.get(key);
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  let size = 0;
  let last = Buffer.alloc(0);
  for await (const chunk of response.body ?? []) {
    hash.update(chunk);
    size += chunk.length;
    if (tail) last = Buffer.concat([last, chunk]).subarray(-ZIP_TAIL_BYTES);
  }
  return { size, sha256: hash.digest("hex"), tail: last };
}

// The live infrastructure, deleted in gq-smoke-down's order once the archive
// is recorded: Ploi, the Workers and their D1 store, Workflows and
// containers, the buckets (emptied with keys scoped to each) and the Site's
// own backups, Artifacts, the Site's own DNS records, the project's tokens,
// then GitHub's webhook. Whatever isn't named as the project's own is left,
// as manual.
function deletionItems(site, { configPath }) {
  const { ops, ploi, frontend, ci, backups } = site;
  // `item` deletes `what` only when `name` is the project's own in `role`.
  const own = (area, what, role, name, item, howTo = "delete it by hand") =>
    isOwn(ops, role, name)
      ? item
      : manual(
          area,
          `${what} isn't ${ops.project}'s own (gq names it ${ownName(ops.project, role)}); ${howTo} if it should go`,
        );
  return [
    ploi.site
      ? todo(
          "Ploi",
          `delete the site ${ploi.site.domain ?? ops.domains.admin} (${ops.ploi.siteId}) and forget ploi.siteId in gq.ops.json`,
          async (p) => {
            await p.ploi.deleteSite();
            await forgetSiteId(configPath);
            // Ploi refuses to delete the system user until the site is gone.
            await p.ploi.siteDeleted();
          },
        )
      : ops.ploi.siteId
        ? todo("Ploi", `forget ploi.siteId in gq.ops.json (the site is deleted)`, () =>
            forgetSiteId(configPath),
          )
        : done("Ploi", `the site ${ops.domains.admin} is deleted`),
    ploi.database
      ? todo("Ploi", `delete the database ${ploi.database.name} (${ploi.database.id})`, (p) =>
          p.ploi.deleteDatabase(ploi.database.id),
        )
      : done("Ploi", `the database ${ops.ploi.database} is deleted`),
    ploi.systemUser && ploi.sharing.length > 0
      ? manual(
          "Ploi",
          `the system user ${ploi.systemUser.name} stays: ${ploi.sharing.map(({ domain }) => domain).join(", ")} ${ploi.sharing.length > 1 ? "run" : "runs"} as it too; delete it by hand once nothing does`,
        )
      : ploi.systemUser
        ? todo(
            "Ploi",
            `delete the system user ${ploi.systemUser.name} (${ploi.systemUser.id})`,
            (p) => p.ploi.deleteSystemUser(ploi.systemUser.id),
          )
        : done("Ploi", `the system user ${ops.ploi.systemUser} is deleted`),
    frontend.exists
      ? own(
          "Frontend",
          `the Worker ${frontend.worker}`,
          "frontendWorker",
          frontend.worker,
          todo("Frontend", `delete the Worker ${frontend.worker}`, (p) =>
            p.cloudflare.deleteWorker(frontend.worker),
          ),
        )
      : done("Frontend", `the Worker ${frontend.worker} is deleted`),
    frontend.d1
      ? own(
          "Frontend",
          `the D1 store ${frontend.d1.name}`,
          "publicationsStore",
          frontend.d1.name,
          todo("Frontend", `delete the D1 store ${frontend.d1.name} (${frontend.d1.uuid})`, (p) =>
            p.cloudflare.deleteD1(frontend.d1.uuid),
          ),
        )
      : done("Frontend", `the D1 store ${frontend.d1Name} is deleted`),
    // Its other stages, each tied to the project by its publication store.
    ...frontend.stages.map((worker) =>
      todo("Frontend", `delete the Worker ${worker}`, (p) => p.cloudflare.deleteWorker(worker)),
    ),
    ...frontend.stores.map(({ d1 }) =>
      todo("Frontend", `delete the D1 store ${d1.name} (${d1.uuid})`, (p) =>
        p.cloudflare.deleteD1(d1.uuid),
      ),
    ),
    ...frontend.unclear.map((worker) => unclearStage("Frontend", ops.project, worker)),
    ...frontend.unbound.map((d1) =>
      manual(
        "Frontend",
        `the D1 store ${d1.name} is named like one of ${ops.project}'s stages' publication stores, but no ${frontend.worker}-<stage> Worker binds it; check it by hand`,
      ),
    ),
    ci.exists
      ? own(
          "CI",
          `the Worker ${ci.worker}`,
          "ciWorker",
          ci.worker,
          todo("CI", `delete the Worker ${ci.worker}`, (p) => p.cloudflare.deleteWorker(ci.worker)),
        )
      : done("CI", `the Worker ${ci.worker} is deleted`),
    ...(ci.workflows.length > 0
      ? ci.workflows.map((name) =>
          own(
            "CI",
            `the Workflow ${name}`,
            name === ops.ci.worker ? "ciWorkflow" : "mirrorWorkflow",
            name,
            todo("CI", `delete the Workflow ${name}`, (p) => p.cloudflare.deleteWorkflow(name)),
          ),
        )
      : [done("CI", "its Workflows are deleted")]),
    ci.container
      ? own(
          "CI",
          `the container application ${ci.container.name}`,
          "ciContainer",
          ci.container.name,
          todo(
            "CI",
            `delete the container application ${ci.container.name} (${ci.container.id})`,
            (p) => p.cloudflare.deleteContainerApplication(ci.container.id),
          ),
        )
      : done("CI", "no container application is left"),
    !site.mediaOwn
      ? manual(
          "Media",
          `the custom domain ${ops.media.domain} stays on ${ops.media.bucket}, which isn't ${ops.project}'s own (gq names it ${ownName(ops.project, "mediaBucket")}); remove it by hand if it should go`,
        )
      : site.mediaDomain
        ? todo(
            "Media",
            `remove the custom domain ${ops.media.domain} from ${ops.media.bucket}`,
            (p) => p.cloudflare.removeBucketDomain(ops.media.bucket, ops.media.domain),
          )
        : done("Media", `the custom domain ${ops.media.domain} is removed`),
    ...site.buckets.map(({ name, exists, role }) =>
      exists
        ? own(
            "R2",
            `the bucket ${name}`,
            role,
            name,
            todo("R2", `empty ${name} (with a key scoped to it) and delete it`, async (p) => {
              await deleteObjects(await p.r2(name), await (await p.r2(name)).list());
              await p.cloudflare.deleteBucket(name);
            }),
            "empty and delete it by hand",
          )
        : done("R2", `the bucket ${name} is deleted`),
    ),
    ...(backups.withBucket
      ? []
      : [
          backups.objects.length > 0
            ? todo(
                "R2",
                `delete the ${backups.objects.length} backups under r2://${backups.bucket}/${backups.prefix} once archived; the bucket and everything else in it stay`,
                async (p) => deleteObjects(await p.r2(backups.bucket), backups.objects),
              )
            : done("R2", `no backup is left under r2://${backups.bucket}/${backups.prefix}`),
        ]),
    site.artifacts
      ? own(
          "Artifacts",
          `the repository ${ops.artifacts.namespace}/${ops.artifacts.repo}`,
          "artifactsRepository",
          ops.artifacts.repo,
          todo(
            "Artifacts",
            `delete the repository ${ops.artifacts.namespace}/${ops.artifacts.repo}`,
            (p) =>
              p.cloudflare.deleteArtifactsRepository(ops.artifacts.namespace, ops.artifacts.repo),
          ),
        )
      : done(
          "Artifacts",
          `the repository ${ops.artifacts.namespace}/${ops.artifacts.repo} is deleted`,
        ),
    manual(
      "Artifacts",
      `the empty namespace ${ops.artifacts.namespace} stays; delete it in the dashboard if it should go`,
    ),
    // The zone is shared (other Sites' hosts live in it): only the records
    // that serve this Site's hosts, named exactly as them, go.
    ...(site.mediaOwn
      ? []
      : [
          manual(
            "DNS",
            `${ops.media.domain} stays: it serves ${ops.media.bucket}, which isn't ${ops.project}'s own; delete its record by hand if it should go`,
          ),
        ]),
    ...site.apexHosts.map((host) =>
      manual(
        "DNS",
        `${host} is the zone's apex: gq deletes no record there; delete the Site's by hand`,
      ),
    ),
    ...site.records.map((record) =>
      SERVING_RECORDS.has(record.type)
        ? todo("DNS", `delete ${record.type} ${record.name} → ${record.content}`, (p) =>
            p.cloudflare.deleteDnsRecord(record.id),
          )
        : manual(
            "DNS",
            `${record.type} ${record.name} → ${record.content} stays: only A, AAAA and CNAME records serve the Site; delete it by hand if it should go`,
          ),
    ),
    done("DNS", `the zone ${site.zoneName} and every other record in it stay`),
    // Last on Cloudflare: phase 1 only disabled them.
    ...(site.tokens.length > 0
      ? site.tokens.map((token) =>
          todo("Tokens", `delete ${token.name}`, (p) => p.cloudflare.deleteToken(token)),
        )
      : [done("Tokens", `no GETQUICK ${ops.project.toUpperCase()} token is left`)]),
    ...(site.artifactsOnly
      ? []
      : [
          ci.hook
            ? todo(
                "GitHub",
                `delete the push webhook ${ci.hook.id} on ${ops.github.repository}`,
                (p) => p.github.deleteHook(ci.hook.id),
              )
            : done("GitHub", "no push webhook to the CI Worker is left"),
        ]),
  ];
}

function forgetSiteId(configPath) {
  return updateManifest(configPath, (manifest) => {
    delete manifest.ploi.siteId;
  });
}

// Deletes `objects` (as listed) through `bucket`, a key scoped to it.
async function deleteObjects(bucket, objects) {
  for (let index = 0; index < objects.length; index += DELETE_CONCURRENCY) {
    await Promise.all(
      objects.slice(index, index + DELETE_CONCURRENCY).map(({ key }) => bucket.delete(key)),
    );
  }
}
