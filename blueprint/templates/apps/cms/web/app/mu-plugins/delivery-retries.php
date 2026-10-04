<?php

/**
 * Plugin Name: {{Project}} Delivery Retries
 * Description: Retries the events the Frontend hasn't confirmed, on the server's own schedule, and tells editors when the public website is behind WordPress.
 * Author: {{Project}}
 * License: GPL-2.0-or-later
 */

/*
 * Publishing succeeds in WordPress whether or not the Frontend refreshes what
 * an event names (publication-events.php, settings-events.php). Each kind of
 * event keeps its last event and its delivery on record: per entry in post
 * meta, per shared setting in an option. This plugin reads those records as
 * one list of deliveries, whatever the event's action (a publication, a
 * withdrawal or a setting), and:
 *
 * - retries the ones the Frontend didn't confirm: a failed one after a
 *   growing delay (1, 2, 5, 10 and 30 minutes, then hourly), until it has been
 *   tried MAX_ATTEMPTS times, and a pending one whose own request ended before
 *   sending it. A retry sends the same event, so the Frontend recognises it
 *   and its ordering still holds. `wp gq-events retry-due` does this; the
 *   server's cron runs it every minute (`gq ploi events` adds the crontab).
 *   WP-Cron isn't used: production disables it, and it only runs on visits.
 * - asks the Frontend, after each run's retries, to reconcile: to compare what
 *   it serves with what WordPress publishes and refresh what differs, so a
 *   change whose own event was never recorded or sent (a hook that didn't
 *   fire, a change made outside the editor) still reaches visitors within
 *   minutes (ADR 0009). The run's outcome is kept in RECONCILIATION_OPTION;
 *   `wp gq-events reconcile` asks for one at once.
 * - reports what is delayed: to editors on the entry's screen, in the page and
 *   post lists and on the Dashboard; to operators in Site Health and with
 *   `wp gq-events delays`. Neither shows a secret or an event's body.
 *
 * Another kind of event adds its records through the `gq_events_deliveries`
 * filter (see deliveries()).
 */

declare(strict_types=1);

namespace GetQuick\Site\DeliveryRetries;

use WP_Post;
use WP_REST_Request;

/** Seconds to wait after the nth failed attempt before the next; the last repeats. */
const DELAYS = [60, 120, 300, 600, 1800, 3600];

/** Attempts after which retries stop and the delivery is reported as failed (about seven hours). */
const MAX_ATTEMPTS = 12;

/** Seconds a pending event waits for its own request to send it before a retry takes over. */
const PENDING_GRACE = 120;

/** The scheduler's last run: when, and what it did. */
const SCHEDULER_OPTION = 'gq_events_scheduler';

/** Held while a run sends events, so overlapping runs don't send the same ones. */
const LOCK_OPTION = 'gq_events_retry_lock';

const LOCK_SECONDS = 300;

/** Seconds a run spends starting deliveries; the rest wait for the next run. */
const RUN_BUDGET = 45;

/** Without a run for this long, the scheduler counts as not running. */
const SCHEDULER_STALE = 300;

/** The command the server's cron runs every minute. */
const COMMAND = 'wp gq-events retry-due --quiet';

/** The last reconciliation the Frontend was asked for: when, how it went, and when it last matched WordPress. */
const RECONCILIATION_OPTION = 'gq_reconciliation';

/** Seconds the Frontend has to answer a reconciliation: it reads WordPress, within its own budget. */
const RECONCILE_TIMEOUT = 60;

/** Without a reconciliation that matched WordPress for this long, missed changes may go unnoticed. */
const RECONCILIATION_STALE = 600;

/** The shared settings, as editors are told about them. */
const SETTING_NAMES = [
    'menus' => 'The menus',
    'logo' => 'The logo',
    'identity' => 'The site title, tagline or icon',
    'design' => 'The design',
];

/** How editors are told about a setting, or one language's ("menus:en": "The menus (en)"). */
function setting_name(string $subject): string
{
    [$setting, $language] = array_pad(explode(':', $subject, 2), 2, null);
    $name = SETTING_NAMES[$setting] ?? $setting;

    return $language === null ? $name : "{$name} ({$language})";
}

/** Now, in seconds. Filterable so a proof can move time on. */
function now(): int
{
    return (int) apply_filters('gq_events_now', time());
}

/** Whether publication-events.php, which signs and sends events, is loaded. */
function available(): bool
{
    return function_exists('GetQuick\\Site\\PublicationEvents\\deliver');
}

/**
 * Every event on record and its delivery, as
 * `['subject', 'label', 'event', 'delivery', 'deliver' => fn(array $event): array, 'post'?]`.
 * `deliver` sends the event and records how it went, the way the event's own
 * plugin does. Entries come from publication-events.php's records (post meta,
 * or its option for deleted entries), whatever the event's action (publish
 * or withdraw); settings from settings-events.php's options; another kind of
 * event adds its own through `gq_events_deliveries`.
 */
function deliveries(): array
{
    if (! available()) {
        return [];
    }
    $deliveries = [];
    $posts = get_posts([
        'post_type' => \GetQuick\Site\PublicationEvents\POST_TYPES,
        'post_status' => array_values(get_post_stati()),
        'posts_per_page' => -1,
        'meta_key' => \GetQuick\Site\PublicationEvents\META_KEY,
        'fields' => 'ids',
        'suppress_filters' => true,
    ]);
    // A deleted entry's withdrawal is kept in an option until it is refreshed.
    $deleted = get_option(\GetQuick\Site\PublicationEvents\DELETED_OPTION, []);
    $deleted = is_array($deleted) ? array_keys($deleted) : [];
    foreach (array_unique(array_map('intval', [...$posts, ...$deleted])) as $post_id) {
        $recorded = \GetQuick\Site\PublicationEvents\recorded($post_id);
        if ($recorded === null) {
            continue;
        }
        $deliveries[] = [
            'subject' => "post:{$post_id}",
            'label' => (string) ($recorded['event']['entry']['uri'] ?? ''),
            'post' => $post_id,
            'event' => $recorded['event'],
            'delivery' => $recorded['delivery'],
            'deliver' => static fn(array $event): array => \GetQuick\Site\PublicationEvents\deliver($post_id, $event),
        ];
    }
    if (function_exists('GetQuick\\Site\\SettingsEvents\\deliver')) {
        // Each setting's, and on a multilingual Site each language's own ("menus:en").
        foreach (\GetQuick\Site\SettingsEvents\subjects() as $setting) {
            $recorded = \GetQuick\Site\SettingsEvents\recorded($setting);
            if ($recorded === null) {
                continue;
            }
            $deliveries[] = [
                'subject' => "setting:{$setting}",
                'label' => $setting,
                'event' => $recorded['event'],
                'delivery' => $recorded['delivery'],
                'deliver' => static fn(array $event): array => \GetQuick\Site\SettingsEvents\deliver($setting, $event),
            ];
        }
    }

    return (array) apply_filters('gq_events_deliveries', $deliveries);
}

/**
 * Where a delivery stands, and when it is next due (null: never again on its
 * own):
 * - delivered: the Frontend refreshed it at the first attempt;
 * - recovered: it did after earlier attempts failed;
 * - pending: being sent by the request that recorded it; due once that
 *   request has had PENDING_GRACE to finish (it may have been interrupted);
 * - retrying: failed, and due after the delay for its attempts;
 * - failed: failed MAX_ATTEMPTS times; only an operator's retry or a newer
 *   event sends it again.
 */
function assess(array $delivery): array
{
    $status = (string) ($delivery['status'] ?? '');
    $attempts = (int) ($delivery['attempts'] ?? 0);
    if ($status === 'refreshed') {
        return ['state' => $attempts > 1 ? 'recovered' : 'delivered', 'due' => null];
    }
    if ($status === 'pending') {
        return ['state' => 'pending', 'due' => (int) ($delivery['queuedAt'] ?? 0) + PENDING_GRACE];
    }
    if ($attempts >= MAX_ATTEMPTS) {
        return ['state' => 'failed', 'due' => null];
    }
    $delay = DELAYS[min(max($attempts, 1), count(DELAYS)) - 1];

    return ['state' => 'retrying', 'due' => (int) ($delivery['attemptedAt'] ?? 0) + $delay];
}

/**
 * Asks the Frontend to reconcile with WordPress (a signed `reconcile` event)
 * and records how it went: `reconciled` (it matches WordPress now), `behind`
 * (it caught up partly, the rest at the next run), `busy` (another run was
 * under way) or `failed`, with the reason and a message that never holds the
 * key. Resolves to the record, or null where events aren't configured outside
 * production (local development without a Frontend store), or the
 * `gq_events_reconcile` filter turns it off.
 */
function reconcile(): ?array
{
    $configured = \GetQuick\Site\PublicationEvents\endpoint() !== ''
        && \GetQuick\Site\PublicationEvents\secret() !== '';
    if (
        (! $configured && wp_get_environment_type() !== 'production')
        || ! apply_filters('gq_events_reconcile', true)
    ) {
        return null;
    }
    $outcome = \GetQuick\Site\PublicationEvents\send([
        'site' => \GetQuick\Site\PublicationEvents\SITE,
        'id' => wp_generate_uuid4(),
        'action' => 'reconcile',
        'occurredAt' => (int) floor(microtime(true) * 1000),
    ], RECONCILE_TIMEOUT);
    $status = ($outcome['status'] ?? '') === 'refreshed'
        ? ((string) ($outcome['frontendStatus'] ?? '') ?: 'reconciled')
        : 'failed';
    $record = [
        'ranAt' => now(),
        'status' => $status,
        'reconciledAt' => $status === 'reconciled' ? now() : (reconciliation()['reconciledAt'] ?? null),
        'reason' => (string) ($outcome['reason'] ?? ''),
        'message' => (string) ($outcome['message'] ?? ''),
    ];
    update_option(RECONCILIATION_OPTION, $record, false);
    if ($status === 'failed') {
        error_log(sprintf('Reconciliation: the Frontend didn\'t reconcile (%s): %s', $record['reason'], $record['message']));
    }

    return $record;
}

/**
 * The last reconciliation, and whether it is stale: events are configured and
 * reconciliation on, but the Frontend hasn't matched WordPress within
 * RECONCILIATION_STALE.
 */
function reconciliation(): array
{
    wp_cache_delete(RECONCILIATION_OPTION, 'options');
    $record = get_option(RECONCILIATION_OPTION);
    $record = is_array($record) ? $record : [];
    $reconciled_at = isset($record['reconciledAt']) ? (int) $record['reconciledAt'] : null;
    $expected = available()
        && \GetQuick\Site\PublicationEvents\endpoint() !== ''
        && \GetQuick\Site\PublicationEvents\secret() !== ''
        && apply_filters('gq_events_reconcile', true);

    return [
        'ranAt' => isset($record['ranAt']) ? (int) $record['ranAt'] : null,
        'status' => (string) ($record['status'] ?? ''),
        'reconciledAt' => $reconciled_at,
        'reason' => (string) ($record['reason'] ?? ''),
        'message' => (string) ($record['message'] ?? ''),
        'stale' => $expected && ($reconciled_at === null || now() - $reconciled_at > RECONCILIATION_STALE),
    ];
}

/** The last reconciliation in one line, for operators. */
function reconciliation_text(array $reconciliation): string
{
    if ($reconciliation['ranAt'] === null) {
        return 'The public website hasn\'t been reconciled with WordPress yet.';
    }
    $matched = $reconciliation['reconciledAt'] !== null ? gmdate('c', $reconciliation['reconciledAt']) : 'never';

    return sprintf(
        'Reconciliation last ran at %1$s: %2$s%3$s. The public website last matched WordPress at %4$s.',
        gmdate('c', $reconciliation['ranAt']),
        $reconciliation['status'],
        $reconciliation['status'] === 'failed' ? " ({$reconciliation['reason']}: {$reconciliation['message']})" : '',
        $matched,
    );
}

/** Takes the run lock unless a run that started less than LOCK_SECONDS ago holds it. */
function lock(): bool
{
    global $wpdb;
    $take = static fn(): bool => (bool) $wpdb->query($wpdb->prepare(
        "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')",
        LOCK_OPTION,
        (string) (time() + LOCK_SECONDS),
    ));
    if ($take()) {
        return true;
    }
    $until = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
        LOCK_OPTION,
    ));
    if ($until > time()) {
        return false;
    }
    // Left by a run that was killed: take it over.
    $wpdb->delete($wpdb->options, ['option_name' => LOCK_OPTION, 'option_value' => (string) $until]);

    return $take();
}

function unlock(): void
{
    global $wpdb;
    $wpdb->delete($wpdb->options, ['option_name' => LOCK_OPTION]);
}

/**
 * Sends every delivery that is due, oldest first, then asks the Frontend to
 * reconcile, and records the run. Resolves to what it did: `['ran' =>
 * false]` when another run holds the lock, else the deliveries it sent
 * (subject, label, event id and outcome), how many due ones it left for the
 * next run, and the reconciliation's record (null where events aren't
 * configured outside production).
 */
function run_due(): array
{
    if (! lock()) {
        return ['ran' => false];
    }
    $sent = [];
    $deferred = 0;
    $reconciliation = null;
    try {
        $due = [];
        foreach (deliveries() as $delivery) {
            $assessed = assess($delivery['delivery']);
            if ($assessed['due'] !== null && $assessed['due'] <= now()) {
                $due[] = $delivery + ['dueAt' => $assessed['due']];
            }
        }
        usort($due, static fn(array $a, array $b): int => $a['dueAt'] <=> $b['dueAt']);
        $started = time();
        foreach ($due as $delivery) {
            if (time() - $started >= RUN_BUDGET) {
                $deferred++;

                continue;
            }
            $outcome = ($delivery['deliver'])($delivery['event']);
            $sent[] = [
                'subject' => $delivery['subject'],
                'label' => $delivery['label'],
                'event' => (string) ($delivery['event']['id'] ?? ''),
                'action' => (string) ($delivery['event']['action'] ?? ''),
                'status' => (string) ($outcome['status'] ?? ''),
                'reason' => (string) ($outcome['reason'] ?? ''),
                'attempts' => (int) ($outcome['attempts'] ?? 0),
            ];
        }
        // After the retries, so a delivered event isn't also found as a change.
        $reconciliation = reconcile();
    } finally {
        unlock();
    }
    $refreshed = count(array_filter($sent, static fn(array $row): bool => $row['status'] === 'refreshed'));
    update_option(SCHEDULER_OPTION, [
        'ranAt' => now(),
        'sent' => count($sent),
        'refreshed' => $refreshed,
        'failed' => count($sent) - $refreshed,
        'deferred' => $deferred,
        'reconciliation' => $reconciliation['status'] ?? null,
    ], false);

    return ['ran' => true, 'sent' => $sent, 'deferred' => $deferred, 'reconciliation' => $reconciliation];
}

/** The scheduler's last run, and whether it is running (a run within SCHEDULER_STALE). */
function scheduler(): array
{
    wp_cache_delete(SCHEDULER_OPTION, 'options');
    $run = get_option(SCHEDULER_OPTION);
    $ran_at = is_array($run) ? (int) ($run['ranAt'] ?? 0) : 0;

    return ['ranAt' => $ran_at ?: null, 'running' => $ran_at > 0 && now() - $ran_at <= SCHEDULER_STALE];
}

/** Each delivery that isn't confirmed, or recovered within the last day, with its state. */
function delays(): array
{
    $rows = [];
    foreach (deliveries() as $delivery) {
        $assessed = assess($delivery['delivery']);
        if ($assessed['state'] === 'delivered') {
            continue;
        }
        if (
            $assessed['state'] === 'recovered'
            && now() - (int) ($delivery['delivery']['attemptedAt'] ?? 0) > DAY_IN_SECONDS
        ) {
            continue;
        }
        $rows[] = $delivery + ['state' => $assessed['state'], 'dueAt' => $assessed['due']];
    }

    return $rows;
}

/** What went wrong, in an editor's words. */
function reason_text(string $reason): string
{
    return match ($reason) {
        'network' => 'the public website couldn\'t be reached',
        'refresh' => 'the public website couldn\'t read it from WordPress',
        'rejected' => 'the public website refused it, which needs an operator',
        'not-configured' => 'public delivery isn\'t set up on this server',
        default => 'it couldn\'t be delivered',
    };
}

function time_text(int $timestamp): string
{
    return wp_date((string) get_option('time_format'), $timestamp) ?: '';
}

/**
 * What an editor is told about a delivery, or null when there's nothing to
 * say. `$what` names it ("This page", "The menus").
 */
function notice(array $delivery, string $what): ?array
{
    $assessed = assess($delivery);
    $attempts = (int) ($delivery['attempts'] ?? 0);
    $retries = scheduler()['running']
        ? ($assessed['due'] !== null
            ? sprintf('It is retried automatically, next around %s.', time_text(max($assessed['due'], now())))
            : '')
        : 'Automatic retries aren\'t running on this server: ask the site\'s operator to retry it.';

    return match ($assessed['state']) {
        'pending' => [
            'type' => 'info',
            'message' => sprintf('%s is saved in WordPress and is being delivered to the public website.', $what),
        ],
        'retrying' => [
            'type' => 'warning',
            'message' => trim(sprintf(
                '%1$s is saved in WordPress, but the public website hasn\'t been updated yet: %2$s. Visitors still see the previous version. %3$s',
                $what,
                reason_text((string) ($delivery['reason'] ?? '')),
                $retries,
            )),
        ],
        'failed' => [
            'type' => 'error',
            'message' => sprintf(
                '%1$s is saved in WordPress, but the public website couldn\'t be updated after %2$d attempts: %3$s. Visitors still see the previous version. Ask the site\'s operator to retry it.',
                $what,
                $attempts,
                reason_text((string) ($delivery['reason'] ?? '')),
            ),
        ],
        'recovered' => now() - (int) ($delivery['attemptedAt'] ?? 0) <= DAY_IN_SECONDS
            ? [
                'type' => 'success',
                'message' => sprintf(
                    '%1$s reached the public website at %2$s, after %3$d attempts.',
                    $what,
                    time_text((int) ($delivery['attemptedAt'] ?? 0)),
                    $attempts,
                ),
            ]
            : null,
        default => null,
    };
}

/** The entry's delivery as its editor sees it: its state and the notice, if any. */
function entry_report(int $post_id): array
{
    $recorded = available() ? \GetQuick\Site\PublicationEvents\recorded($post_id) : null;
    if ($recorded === null) {
        return ['state' => 'none', 'notice' => null];
    }
    $what = get_post_type($post_id) === 'post' ? 'This post' : 'This page';

    return [
        'state' => assess($recorded['delivery'])['state'],
        'notice' => notice($recorded['delivery'], $what),
    ];
}

// --- The scheduler --------------------------------------------------------

function cli_commands(): void
{
    if (! defined('WP_CLI') || ! WP_CLI) {
        return;
    }

    $format = [
        'synopsis' => [[
            'type' => 'assoc',
            'name' => 'format',
            'description' => 'table or json.',
            'optional' => true,
            'default' => 'table',
            'options' => ['table', 'json'],
        ]],
    ];

    // The server's cron runs it every minute.
    \WP_CLI::add_command('gq-events retry-due', static function (array $args, array $assoc): void {
        $run = run_due();
        if (! $run['ran']) {
            \WP_CLI::log('Another run is sending events; nothing sent.');

            return;
        }
        $columns = ['subject', 'label', 'event', 'action', 'status', 'reason', 'attempts'];
        if (($assoc['format'] ?? 'table') === 'json') {
            \WP_CLI\Utils\format_items('json', $run['sent'], $columns);

            return;
        }
        if ($run['sent'] !== []) {
            \WP_CLI\Utils\format_items('table', $run['sent'], $columns);
        }
        $refreshed = count(array_filter($run['sent'], static fn(array $row): bool => $row['status'] === 'refreshed'));
        \WP_CLI::success(sprintf(
            'Sent %d due event(s): %d refreshed, %d failed; %d left for the next run.',
            count($run['sent']),
            $refreshed,
            count($run['sent']) - $refreshed,
            $run['deferred'],
        ));
        if ($run['reconciliation'] !== null) {
            \WP_CLI::log(reconciliation_text(reconciliation()));
        }
    }, ['shortdesc' => 'Sends every event the Frontend hasn\'t confirmed that is due for a retry, then asks the Frontend to reconcile with WordPress.'] + $format);

    \WP_CLI::add_command('gq-events reconcile', static function (): void {
        $record = reconcile();
        if ($record === null) {
            \WP_CLI::error('Events aren\'t configured here: GETQUICK_FRONTEND_URL and PUBLICATION_EVENT_SECRET are required.');
        }
        match ($record['status']) {
            'reconciled' => \WP_CLI::success('The public website matches WordPress.'),
            'behind' => \WP_CLI::success('The public website caught up partly; the rest follows at the next run.'),
            'busy' => \WP_CLI::success('Another reconciliation is under way on the public website.'),
            default => \WP_CLI::error("The public website couldn't reconcile ({$record['reason']}): {$record['message']}"),
        };
    }, ['shortdesc' => 'Asks the Frontend to compare what it serves with what WordPress publishes, and refresh what differs.']);

    \WP_CLI::add_command('gq-events delays', static function (array $args, array $assoc): void {
        $rows = array_map(static fn(array $row): array => [
            'subject' => $row['subject'],
            'label' => $row['label'],
            'action' => (string) ($row['event']['action'] ?? ''),
            'event' => (string) ($row['event']['id'] ?? ''),
            'state' => $row['state'],
            'reason' => (string) ($row['delivery']['reason'] ?? ''),
            'attempts' => (int) ($row['delivery']['attempts'] ?? 0),
            'next' => $row['dueAt'] !== null ? gmdate('c', max($row['dueAt'], now())) : '',
            'message' => (string) ($row['delivery']['message'] ?? ''),
        ], delays());
        \WP_CLI\Utils\format_items($assoc['format'] ?? 'table', $rows, ['subject', 'label', 'action', 'event', 'state', 'reason', 'attempts', 'next', 'message']);
        $scheduler = scheduler();
        $last = $scheduler['ranAt'] !== null ? gmdate('c', $scheduler['ranAt']) : 'never';
        // Its JSON stays parseable: the last run goes to stderr only when it is a warning.
        if (! $scheduler['running']) {
            \WP_CLI::warning("The retry scheduler isn't running (last run: {$last}). Its cron runs `" . COMMAND . '` every minute.');
        } elseif (($assoc['format'] ?? 'table') !== 'json') {
            \WP_CLI::log("The retry scheduler last ran at {$last}.");
        }
        $reconciliation = reconciliation();
        if ($reconciliation['stale']) {
            \WP_CLI::warning(reconciliation_text($reconciliation));
        } elseif (($assoc['format'] ?? 'table') !== 'json' && $reconciliation['ranAt'] !== null) {
            \WP_CLI::log(reconciliation_text($reconciliation));
        }
    }, [
        'shortdesc' => 'Lists the deliveries the Frontend hasn\'t confirmed, or recovered within a day, and the retry scheduler\'s last run.',
    ] + $format);
}

// --- Editors and operators ----------------------------------------------

/** Reports delays to editors and operators. */
function reporting(): void
{
    add_action('rest_api_init', static function (): void {
        register_rest_route('gq-events/v1', '/entries/(?P<id>\d+)', [
            'methods' => 'GET',
            'callback' => static fn(WP_REST_Request $request): array => entry_report((int) $request['id']),
            'permission_callback' => static fn(WP_REST_Request $request): bool => current_user_can('edit_post', (int) $request['id']),
        ]);
    });

    /*
     * The block editor: the entry's delivery as a notice when it opens, and again
     * after each save, while the save's event is delivered at the end of that
     * request (up to 15 seconds).
     */
    add_action('enqueue_block_editor_assets', static function (): void {
        $post = get_post();
        if (! $post instanceof WP_Post || ! in_array($post->post_type, ['page', 'post'], true)) {
            return;
        }
        wp_register_script('gq-public-delivery', false, ['wp-data', 'wp-api-fetch', 'wp-notices', 'wp-editor'], null, true);
        wp_enqueue_script('gq-public-delivery');
        wp_add_inline_script('gq-public-delivery', sprintf(
            <<<'JS'
            (() => {
              const { dispatch, select, subscribe } = wp.data;
              const path = %s;
              const show = (report) => {
                const notices = dispatch("core/notices");
                notices.removeNotice("gq-public-delivery");
                if (report && report.notice) {
                  notices.createNotice(report.notice.type, report.notice.message, {
                    id: "gq-public-delivery",
                    isDismissible: true,
                  });
                }
              };
              show(%s);
              let saving = false;
              subscribe(() => {
                const editor = select("core/editor");
                const now = editor.isSavingPost() && !editor.isAutosavingPost();
                if (saving && !now) {
                  for (const wait of [3000, 10000, 20000]) {
                    setTimeout(() => wp.apiFetch({ path }).then(show, () => {}), wait);
                  }
                }
                saving = now;
              });
            })();
            JS,
            wp_json_encode("/gq-events/v1/entries/{$post->ID}"),
            wp_json_encode(entry_report($post->ID)),
        ));
    });

    // The classic editor shows the entry's delivery as an admin notice.
    add_action('admin_notices', static function (): void {
        $screen = get_current_screen();
        if ($screen === null || $screen->base !== 'post' || $screen->is_block_editor()) {
            return;
        }
        $post = get_post();
        if (! $post instanceof WP_Post) {
            return;
        }
        $notice = entry_report($post->ID)['notice'];
        if ($notice !== null) {
            wp_admin_notice(esc_html($notice['message']), ['type' => $notice['type'], 'dismissible' => true]);
        }
    });

    // The page and post lists mark entries the public website is behind on.
    add_filter('display_post_states', static function (array $states, WP_Post $post): array {
        $recorded = \GetQuick\Site\PublicationEvents\recorded($post->ID);
        $label = match ($recorded === null ? null : assess($recorded['delivery'])['state']) {
            'pending' => 'Public update pending',
            'retrying' => 'Public update delayed',
            'failed' => 'Public update failed',
            default => null,
        };
        if ($label !== null) {
            $states['gq-public-delivery'] = $label;
        }

        return $states;
    }, 10, 2);

    /*
     * The Dashboard, the lists and the screens shared settings are changed on
     * summarise what the public website is behind on (pending deliveries are left
     * out: they are normally done within seconds).
     */
    add_action('admin_notices', static function (): void {
        $screen = get_current_screen();
        $screens = ['dashboard', 'edit-page', 'edit-post', 'nav-menus', 'themes', 'options-general'];
        if ($screen === null || ! in_array($screen->id, $screens, true) || ! current_user_can('edit_posts')) {
            return;
        }
        $items = [];
        $failed = false;
        foreach (delays() as $row) {
            if (! in_array($row['state'], ['retrying', 'failed'], true)) {
                continue;
            }
            $failed = $failed || $row['state'] === 'failed';
            $setting = str_starts_with($row['subject'], 'setting:') ? substr($row['subject'], 8) : null;
            $name = $setting !== null
                ? setting_name($setting)
                : trim(sprintf('%s (%s)', get_the_title((int) ($row['post'] ?? 0)), $row['label']));
            $items[] = sprintf(
                '<li>%s: %s</li>',
                esc_html($name),
                esc_html($row['state'] === 'failed' ? 'failed, not retried' : reason_text((string) ($row['delivery']['reason'] ?? ''))),
            );
        }
        if ($items === []) {
            return;
        }
        $retries = scheduler()['running']
            ? 'Delayed changes are retried automatically.'
            : 'Automatic retries aren\'t running on this server: ask the site\'s operator.';
        wp_admin_notice(
            '<p>' . esc_html('These changes are saved in WordPress but not yet on the public website, which still shows their previous versions:') . '</p>'
            . '<ul>' . implode('', $items) . '</ul><p>' . esc_html($retries) . '</p>',
            ['type' => $failed ? 'error' : 'warning', 'paragraph_wrap' => false],
        );
    });

    add_filter('site_status_tests', static function (array $tests): array {
        $tests['direct']['gq_public_delivery'] = [
            'label' => 'Public website delivery',
            'test' => __NAMESPACE__ . '\\site_health',
        ];

        return $tests;
    });
}

/** Site Health: whether the public website has every change, and the retry scheduler runs. */
function site_health(): array
{
    $rows = delays();
    $scheduler = scheduler();
    $reconciliation = reconciliation();
    $behind = array_filter($rows, static fn(array $row): bool => in_array($row['state'], ['retrying', 'failed'], true));
    $failed = array_filter($rows, static fn(array $row): bool => $row['state'] === 'failed');
    $configured = \GetQuick\Site\PublicationEvents\endpoint() !== '' && \GetQuick\Site\PublicationEvents\secret() !== '';
    $production = wp_get_environment_type() === 'production';

    $status = 'good';
    $label = 'The public website has every published change';
    if ($behind !== []) {
        $status = 'recommended';
        $label = 'The public website is behind on some changes';
    } elseif ($reconciliation['stale']) {
        $status = 'recommended';
        $label = 'The public website hasn\'t been reconciled with WordPress recently';
    }
    if ($failed !== [] || ($production && $configured && ! $scheduler['running'])) {
        $status = 'critical';
        $label = $failed !== []
            ? 'The public website couldn\'t be updated with some changes'
            : 'Public delivery retries aren\'t running';
    }

    $list = implode('', array_map(static fn(array $row): string => sprintf(
        '<li><code>%s</code> (%s): %s, %s, %d attempt(s)%s</li>',
        esc_html($row['subject']),
        esc_html($row['label']),
        esc_html($row['state']),
        esc_html((string) ($row['delivery']['reason'] ?? '')),
        (int) ($row['delivery']['attempts'] ?? 0),
        esc_html(isset($row['delivery']['message']) ? ': ' . $row['delivery']['message'] : ''),
    ), $rows));
    $last = $scheduler['ranAt'] !== null ? gmdate('c', $scheduler['ranAt']) : 'never';

    return [
        'label' => $label,
        'status' => $status,
        'badge' => ['label' => 'Performance', 'color' => $status === 'good' ? 'blue' : 'red'],
        'description' => '<p>' . esc_html('WordPress tells the public website about each publication and shared setting change. A change it hasn\'t confirmed is retried by the server\'s cron; visitors keep seeing the previous version meanwhile.') . '</p>'
            . ($list !== '' ? '<ul>' . $list . '</ul>' : '')
            . '<p>' . esc_html(sprintf(
                'The retry scheduler last ran: %1$s. The server\'s cron should run `%2$s` every minute (gq ploi events adds it).',
                $last,
                COMMAND,
            )) . '</p>'
            . '<p>' . esc_html('Each run also asks the public website to reconcile with WordPress, which catches a change whose own delivery was lost. ' . reconciliation_text($reconciliation)) . '</p>',
        'actions' => '',
        'test' => 'gq_public_delivery',
    ];
}

// Once every must-use plugin is loaded: publication-events.php sends the events.
add_action('muplugins_loaded', static function (): void {
    if (available()) {
        cli_commands();
        reporting();
    }
});
