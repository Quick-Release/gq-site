// How gq names a Site's own Cloudflare resources (infra/frontend.run.ts,
// infra/ci/wrangler.jsonc, gq-smoke-up's gq.ops.json), which offboarding
// finds them by and never reaches past: the zone, the Ploi server and the
// account are shared, and gq.ops.json may name another project's resource.

// The production Frontend Worker.
export function frontendWorker(project) {
  return `${project}-fe`;
}

// The D1 publication store of the production Frontend, or of `stage`'s.
export function publicationsStore(project, stage) {
  return stage ? `${project}-fe-publications-${stage}` : `${project}-fe-publications`;
}

// The name gq gives each resource it provisions for `project`, by its role.
export function ownName(project, role) {
  return {
    mediaBucket: `${project}-media`,
    releasesBucket: `${project}-releases`,
    ciBackupBucket: `${project}-ci-backups`,
    frontendWorker: frontendWorker(project),
    publicationsStore: publicationsStore(project),
    ciWorker: `${project}-ci`,
    ciWorkflow: `${project}-ci`,
    mirrorWorkflow: `${project}-mirror`,
    ciContainer: `${project}-ci-cisandbox`,
    artifactsRepository: project,
  }[role];
}

// Whether `name`, in `role`, is the project's own: exactly the name gq gives
// it. A look-alike (`<project>-shop-media`) may be another project's, so
// offboarding leaves it to the operator, whatever gq.ops.json says.
export function isOwn(project, role, name) {
  return name === ownName(project, role);
}

// gq.ops.json `artifacts`'s repository, as `<namespace>/<repo>`.
export function artifactsRepositoryName(ops) {
  return `${ops.artifacts.namespace}/${ops.artifacts.repo}`;
}

// The Worker binding that ties a Frontend stage to its publication store.
export const PUBLICATION_BINDING = "PUBLICATION_DB";

// A non-production stage's name: one word, so `<project>-fe-<stage>` can't
// be another project's Worker (`<project>-fe-shop-fe` is project
// `<project>-fe-shop`'s), and never `fe` (`<project>-fe-fe` is project
// `<project>-fe`'s production Worker).
const STAGE = /^[a-z0-9_]+$/u;

// Among the account's `workers`, those named like one of the Frontend's
// non-production stages ([{ stage, worker }]), and the names that start like
// one but can't be (`unclear`). A name alone doesn't make a stage: see
// frontendStages() in steps.mjs.
export function stageCandidates(project, workers) {
  const prefix = `${frontendWorker(project)}-`;
  const candidates = [];
  const unclear = [];
  for (const worker of workers) {
    if (!worker.startsWith(prefix)) continue;
    const stage = worker.slice(prefix.length);
    if (STAGE.test(stage) && stage !== "fe") candidates.push({ stage, worker });
    else unclear.push(worker);
  }
  return { candidates, unclear };
}

// Among the D1 `stores`, those named as a non-production stage's publication
// store ([{ stage, d1 }]).
export function publicationsStages(project, stores) {
  const prefix = `${publicationsStore(project)}-`;
  return stores
    .filter(({ name }) => name.startsWith(prefix) && STAGE.test(name.slice(prefix.length)))
    .map((d1) => ({ stage: d1.name.slice(prefix.length), d1 }));
}
