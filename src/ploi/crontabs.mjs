// The crontabs a Ploi site's CMS runs on its server, each every minute, as
// the site's system user, from its Bedrock app (Ploi keeps a site in
// /home/<user>/<domain>). WP-CLI is in /usr/local/bin on Ploi servers, which
// cron's PATH leaves out.
//
// - The delivery retry crontab (ADR 0008): `wp gq-events retry-due`, a
//   content Site's, which `gq ploi events` adds.
// - The WP-Cron crontab (ADR 0022): `wp cron event run --due-now`, every
//   Site's, which `gq ploi provision` adds. Production sets DISABLE_WP_CRON,
//   so nothing else runs WordPress's scheduled events: scheduled posts,
//   core's cleanups and update checks, and plugins' events (WooCommerce's
//   Action Scheduler among them).
//
// `gq site check` reports each, and `gq offboard` deletes and restores both.

/**
 * What the retry cron runs: the CMS's delivery retries (getquick/gq-content's,
 * or a copied delivery-retries.php on a Site generated before it) send what is
 * due.
 */
export const RETRY_COMMAND = "wp gq-events retry-due --quiet";

/** What the WP-Cron cron runs: every WordPress scheduled event that is due. */
export const WP_CRON_COMMAND = "wp cron event run --due-now --quiet";

export const EVERY_MINUTE = "* * * * *";

function siteNames({ systemUser, domain }) {
  for (const [name, value] of Object.entries({ systemUser, domain })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value ?? "")) {
      throw new Error(
        `The Ploi site's ${name} ${JSON.stringify(value)} can't be used in a crontab.`,
      );
    }
  }
}

function siteCrontab({ systemUser, domain }, command) {
  siteNames({ systemUser, domain });
  return {
    user: systemUser,
    frequency: EVERY_MINUTE,
    command: `cd /home/${systemUser}/${domain}/apps/cms && PATH="/usr/local/bin:$PATH" ${command}`,
  };
}

/** The delivery retry crontab for a Ploi site (ADR 0008). */
export function retryCrontab(site) {
  return siteCrontab(site, RETRY_COMMAND);
}

/**
 * The WP-Cron crontab for a Ploi site (ADR 0022). `flock -n` skips a minute
 * while the previous run still holds the site's lock, so a slow event never
 * runs twice at once; WP-CLI takes no lock of its own. The lock file lives in
 * the system user's home, outside the site and its releases.
 */
export function wpCronCrontab(site) {
  siteNames(site);
  return siteCrontab(
    site,
    `flock -n /home/${site.systemUser}/.gq-wp-cron-${site.domain}.lock ${WP_CRON_COMMAND}`,
  );
}

/** The entry of Ploi's crontab listing that runs `crontab`'s command as its user. */
export function findCrontab(crontabs, crontab) {
  return crontabs.find((entry) => entry.user === crontab.user && entry.command === crontab.command);
}

/**
 * The problems with a crontab the CMS needs (`label` names it): none when
 * `existing` runs every minute.
 */
export function crontabProblems(label, crontab, existing) {
  if (!existing) return [`the server has no crontab running ${crontab.command} as ${crontab.user}`];
  if (existing.frequency !== crontab.frequency) {
    return [`the ${label} runs at "${existing.frequency}", not every minute`];
  }
  return [];
}
