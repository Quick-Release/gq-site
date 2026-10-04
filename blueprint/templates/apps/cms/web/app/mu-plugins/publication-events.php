<?php

/**
 * Plugin Name: {{Project}} Publication Events
 * Description: Tells the Frontend when a page or post is published, updated or withdrawn, so its public copy follows without a deploy.
 * Author: {{Project}}
 * License: GPL-2.0-or-later
 */

/*
 * Each publication of a page or post becomes an event: an identity, the time
 * it happened, the entry's WPGraphQL id and its URI (and the one it left, if
 * it moved). On a multilingual Site (Polylang) it also names the entry's
 * language, its URI is in that language's directory (`/en/about/`), and a
 * language's front page is at that language's home (`/en/`). It is recorded
 * on the entry (post meta `_gq_publication_event`) as pending before it is
 * sent, then posted to the Frontend's /gq/events, signed with
 * PUBLICATION_EVENT_SECRET (HMAC-SHA256 of "<timestamp>.<body>"). The
 * Frontend refreshes the entry from WordPress's public GraphQL, so the event
 * carries no content.
 *
 * An entry that stops being public (unpublished, made private or
 * password-protected, trashed, or deleted while published) sends a withdraw
 * event with the URI it had while published: the Frontend stops serving it
 * at once, without reading WordPress, and only a later publication brings it
 * back. A deleted entry's event and delivery are kept in the option
 * `gq_publication_events_deleted` until it is refreshed, since its post meta
 * goes with it.
 *
 * Publishing never waits on it or fails because of it: the event is sent at
 * the end of the request, after the editor's response where PHP-FPM allows,
 * with a bounded timeout, and its outcome (refreshed, or failed with a
 * reason) is recorded on the entry for a retry and for reporting. `wp gq-events`
 * lists pending and failed events, checks the Frontend accepts this Site's
 * events, and sends an entry's event again.
 */

declare(strict_types=1);

namespace GetQuick\Site\PublicationEvents;

use WP_Post;

/** The Site the events are for; the Frontend refuses any other. */
const SITE = '{{project}}';

/** The entry's last event and its delivery. */
const META_KEY = '_gq_publication_event';

/** Deleted entries' last events and their deliveries, by post id, until refreshed. */
const DELETED_OPTION = 'gq_publication_events_deleted';

/** The post types the Frontend serves as entries. */
const POST_TYPES = ['page', 'post'];

/** Seconds the Frontend has to refresh an event before it counts as failed. */
const TIMEOUT = 15;

/**
 * A setting from the environment (Bedrock defines .env values as constants)
 * or the process environment; '' when unset.
 */
function setting(string $name): string
{
    $value = defined($name) ? constant($name) : getenv($name);

    return is_string($value) ? trim($value) : '';
}

/** The Frontend's event endpoint, or '' without a Frontend URL. */
function endpoint(): string
{
    $frontend = function_exists('getquick_config_frontend_url')
        ? (string) getquick_config_frontend_url()
        : setting('GETQUICK_FRONTEND_URL');

    return $frontend === '' ? '' : rtrim($frontend, '/') . '/gq/events';
}

/** The key events are signed with, or '' when it isn't set or too short to trust. */
function secret(): string
{
    $secret = setting('PUBLICATION_EVENT_SECRET');

    return strlen($secret) >= 32 ? $secret : '';
}

/**
 * The entry's URI as WPGraphQL gives it: a path, its language's home for a
 * language's front page.
 */
function uri_of(WP_Post $post): string
{
    $home = front_page_home($post);
    if ($home !== null) {
        return $home;
    }

    $path = (string) wp_parse_url((string) get_permalink($post), PHP_URL_PATH);

    return $path === '' ? '/' : $path;
}

/**
 * The home a page is the front page of, or null: `/` for the static front
 * page. With Polylang, which filters `page_on_front` per language, each of its
 * translations is its language's front page, at `/<slug>/` (the default
 * language's at `/`).
 */
function front_page_home(WP_Post $post): ?string
{
    if ($post->post_type !== 'page' || get_option('show_on_front') !== 'page') {
        return null;
    }
    $front = (int) get_option('page_on_front');
    if ($front === 0) {
        return null;
    }
    if (function_exists('pll_get_post_translations') && function_exists('pll_default_language')) {
        $language = array_search($post->ID, array_map('intval', pll_get_post_translations($front)), true);
        if (is_string($language)) {
            return $language === pll_default_language('slug') ? '/' : "/{$language}/";
        }
    }

    return $front === $post->ID ? '/' : null;
}

/** The entry's language (Polylang's slug), or null on a Site without Polylang. */
function language_of(WP_Post $post): ?string
{
    $language = function_exists('pll_get_post_language') ? pll_get_post_language($post->ID, 'slug') : null;

    return is_string($language) && $language !== '' ? $language : null;
}

/** WPGraphQL's global id of a page or post. */
function node_id(WP_Post $post): string
{
    return base64_encode('post:' . $post->ID);
}

/**
 * The publication event a saved entry gives, or null: only a public page or
 * post that is published (a password-protected one is withdrawn instead).
 */
function event_for(WP_Post $post, ?WP_Post $before): ?array
{
    if (
        ! in_array($post->post_type, POST_TYPES, true)
        || $post->post_status !== 'publish'
        || $post->post_password !== ''
        || wp_is_post_revision($post)
        || wp_is_post_autosave($post)
    ) {
        return null;
    }

    $uri = uri_of($post);
    $previous = $before instanceof WP_Post && $before->post_status === 'publish' ? uri_of($before) : null;

    return [
        'site' => SITE,
        'id' => wp_generate_uuid4(),
        'action' => 'publish',
        'occurredAt' => (int) floor(microtime(true) * 1000),
        'entry' => array_filter(
            [
                'id' => node_id($post),
                'uri' => $uri,
                'previousUri' => $previous !== $uri ? $previous : null,
                'language' => language_of($post),
            ],
            static fn($value) => $value !== null,
        ),
    ];
}

/**
 * The withdraw event a saved entry gives, or null: a page or post that was
 * published and isn't public now (another status, or a password), at the URI
 * it had while published. A published one with a password withdraws on every
 * save, so the Frontend never keeps it.
 */
function withdrawal_for(WP_Post $post, ?WP_Post $before): ?array
{
    if (! in_array($post->post_type, POST_TYPES, true) || wp_is_post_revision($post) || wp_is_post_autosave($post)) {
        return null;
    }
    $protected = $post->post_status === 'publish' && $post->post_password !== '';
    $unpublished = $before instanceof WP_Post && $before->post_status === 'publish' && $post->post_status !== 'publish';
    if (! $protected && ! $unpublished) {
        return null;
    }

    return [
        'site' => SITE,
        'id' => wp_generate_uuid4(),
        'action' => 'withdraw',
        'occurredAt' => (int) floor(microtime(true) * 1000),
        'entry' => entry_of($post, uri_of($unpublished ? $before : $post)),
    ];
}

/** A withdrawn entry, as its event names it: its id, the URI it had and its language. */
function entry_of(WP_Post $post, string $uri): array
{
    return array_filter(
        ['id' => node_id($post), 'uri' => $uri, 'language' => language_of($post)],
        static fn($value) => $value !== null,
    );
}

/** Posts being deleted in this request: their records go to DELETED_OPTION. */
function deleting(?int $post_id = null): array
{
    static $deleting = [];
    if ($post_id !== null) {
        $deleting[$post_id] = true;
    }

    return $deleting;
}

/** Records an entry's event and its delivery state. */
function record(int $post_id, array $event, array $delivery): void
{
    if (get_post($post_id) instanceof WP_Post && ! isset(deleting()[$post_id])) {
        update_post_meta($post_id, META_KEY, wp_slash(['event' => $event, 'delivery' => $delivery]));

        return;
    }
    $deleted = get_option(DELETED_OPTION, []);
    $deleted = is_array($deleted) ? $deleted : [];
    unset($deleted[$post_id]);
    if ($delivery['status'] !== 'refreshed') {
        $deleted[$post_id] = ['event' => $event, 'delivery' => $delivery];
    }
    update_option(DELETED_OPTION, $deleted, false);
}

/** The entry's last event and its delivery, if it has one. */
function recorded(int $post_id): ?array
{
    $recorded = get_post_meta($post_id, META_KEY, true);
    if (! is_array($recorded)) {
        $deleted = get_option(DELETED_OPTION, []);
        $recorded = is_array($deleted) ? ($deleted[$post_id] ?? null) : null;
    }

    return is_array($recorded) && isset($recorded['event'], $recorded['delivery']) ? $recorded : null;
}

/** Events to send at the end of this request, by entry: only an entry's last one. */
function queue(?array $add = null, ?int $post_id = null): array
{
    static $queued = [];
    if ($add !== null && $post_id !== null) {
        unset($queued[$post_id]);
        $queued[$post_id] = $add;
    }

    return $queued;
}

/**
 * Signs and posts an event, waiting up to $timeout seconds (TIMEOUT unless
 * given). Resolves to the delivery outcome: refreshed, or failed with a reason
 * (not-configured, network, rejected, refresh) and a message safe to show
 * (never the secret).
 */
function send(array $event, ?int $timeout = null): array
{
    $endpoint = endpoint();
    $secret = secret();
    if ($endpoint === '' || $secret === '') {
        return [
            'status' => 'failed',
            'reason' => 'not-configured',
            'message' => 'GETQUICK_FRONTEND_URL and a PUBLICATION_EVENT_SECRET of 32 characters or more are required.',
        ];
    }

    $body = (string) wp_json_encode($event);
    $timestamp = (string) time();
    $response = wp_remote_post($endpoint, [
        'timeout' => $timeout ?? (int) apply_filters('gq_publication_events_timeout', TIMEOUT),
        'redirection' => 0,
        'headers' => [
            'Content-Type' => 'application/json',
            'GQ-Event-Timestamp' => $timestamp,
            'GQ-Event-Signature' => 'v1=' . hash_hmac('sha256', $timestamp . '.' . $body, $secret),
        ],
        'body' => $body,
    ]);

    if (is_wp_error($response)) {
        return ['status' => 'failed', 'reason' => 'network', 'message' => $response->get_error_message()];
    }

    $code = (int) wp_remote_retrieve_response_code($response);
    $answer = json_decode((string) wp_remote_retrieve_body($response), true);
    $answer = is_array($answer) ? $answer : [];
    if ($code === 200) {
        return ['status' => 'refreshed', 'frontendStatus' => (string) ($answer['status'] ?? '')];
    }

    // 503 with a report: the Frontend recorded the event but its refresh kept
    // the stored version. Anything else: the Frontend didn't accept it.
    $reason = $code === 503 && isset($answer['event']) ? 'refresh' : 'rejected';
    $message = isset($answer['error']) && is_string($answer['error'])
        ? $answer['error']
        : (refresh_failure($answer) ?? "The Frontend answered HTTP {$code}.");

    return ['status' => 'failed', 'reason' => $reason, 'httpStatus' => $code, 'message' => $message];
}

/**
 * The first part of a refresh the Frontend kept its stored version of, and
 * why ("timeout: WordPress didn't answer within 8 seconds"), from its report.
 */
function refresh_failure(array $answer): ?string
{
    if (isset($answer['failure']['reason'], $answer['failure']['message']) && is_string($answer['failure']['message'])) {
        return "{$answer['failure']['reason']}: {$answer['failure']['message']}";
    }
    foreach ($answer as $value) {
        if (! is_array($value)) {
            continue;
        }
        if (($value['outcome'] ?? null) === 'kept' && isset($value['failure']['reason'], $value['failure']['message'])) {
            return "{$value['failure']['reason']}: {$value['failure']['message']}";
        }
        $nested = refresh_failure($value);
        if ($nested !== null) {
            return $nested;
        }
    }

    return null;
}

/** Sends an entry's recorded event and records how it went. */
function deliver(int $post_id, array $event): array
{
    $previous = recorded($post_id);
    $attempts = $previous !== null && ($previous['event']['id'] ?? null) === $event['id']
        ? (int) ($previous['delivery']['attempts'] ?? 0)
        : 0;

    $outcome = send($event);
    $delivery = $outcome + ['attempts' => $attempts + 1, 'attemptedAt' => time()];
    // A newer event recorded meanwhile (another request) keeps its own state.
    $current = recorded($post_id);
    if ($current === null || ($current['event']['id'] ?? null) === $event['id']) {
        record($post_id, $event, $delivery);
    }

    if ($outcome['status'] !== 'refreshed') {
        error_log(sprintf(
            'Publication events: %s for post %d was not refreshed (%s): %s',
            $event['id'],
            $post_id,
            $outcome['reason'],
            $outcome['message'],
        ));
    }

    return $delivery;
}

/** Sends this request's events, after the editor's response where PHP-FPM allows. */
function send_queued(): void
{
    $queued = queue();
    if ($queued === []) {
        return;
    }
    if (function_exists('fastcgi_finish_request') && ! headers_sent()) {
        // Flush output buffers first, so the response is complete.
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
        fastcgi_finish_request();
    }
    foreach ($queued as $post_id => $event) {
        deliver((int) $post_id, $event);
    }
}

/** Records an entry's event as pending and sends it at the end of the request. */
function enqueue(int $post_id, array $event): void
{
    // Not configured outside production (such as local development without a
    // Frontend store): nothing to record. In production it is a failure to fix.
    if ((endpoint() === '' || secret() === '') && wp_get_environment_type() !== 'production') {
        return;
    }

    record($post_id, $event, ['status' => 'pending', 'attempts' => 0, 'queuedAt' => time()]);
    if (queue() === []) {
        add_action('shutdown', __NAMESPACE__ . '\\send_queued', 1000);
    }
    queue($event, $post_id);
}

add_action('wp_after_insert_post', static function (int $post_id, WP_Post $post, bool $update, ?WP_Post $before): void {
    $event = event_for($post, $before) ?? withdrawal_for($post, $before);
    if ($event !== null) {
        enqueue($post_id, $event);
    }
}, 10, 4);

// Deleting a published entry outright (not through the trash) withdraws it too.
add_action('before_delete_post', static function (int $post_id, WP_Post $post): void {
    if (
        ! in_array($post->post_type, POST_TYPES, true)
        || $post->post_status !== 'publish'
        || wp_is_post_revision($post)
    ) {
        return;
    }
    deleting($post_id);
    enqueue($post_id, [
        'site' => SITE,
        'id' => wp_generate_uuid4(),
        'action' => 'withdraw',
        'occurredAt' => (int) floor(microtime(true) * 1000),
        'entry' => entry_of($post, uri_of($post)),
    ]);
}, 10, 2);

if (defined('WP_CLI') && WP_CLI) {
    /**
     * Publication events: what was sent to the Frontend, and how it went.
     */
    \WP_CLI::add_command('gq-events', new class {
        /**
         * Lists the entries whose last event is pending or failed.
         *
         * ## OPTIONS
         *
         * [--format=<format>]
         * : table or json.
         * ---
         * default: table
         * ---
         */
        public function status(array $args, array $assoc): void
        {
            $posts = get_posts([
                'post_type' => POST_TYPES,
                'post_status' => 'any',
                'posts_per_page' => -1,
                'meta_key' => META_KEY,
                'fields' => 'ids',
            ]);
            $deleted = get_option(DELETED_OPTION, []);
            $rows = [];
            foreach ([...$posts, ...array_keys(is_array($deleted) ? $deleted : [])] as $post_id) {
                $recorded = recorded((int) $post_id);
                if ($recorded === null || $recorded['delivery']['status'] === 'refreshed') {
                    continue;
                }
                $rows[] = [
                    'post' => $post_id,
                    'uri' => $recorded['event']['entry']['uri'] ?? '',
                    'event' => $recorded['event']['id'],
                    'status' => $recorded['delivery']['status'],
                    'reason' => $recorded['delivery']['reason'] ?? '',
                    'attempts' => $recorded['delivery']['attempts'] ?? 0,
                    'message' => $recorded['delivery']['message'] ?? '',
                ];
            }
            \WP_CLI\Utils\format_items($assoc['format'] ?? 'table', $rows, ['post', 'uri', 'event', 'status', 'reason', 'attempts', 'message']);
        }

        /**
         * Sends a signed check event: proves this CMS has the Site's event
         * secret and the Frontend accepts this Site's events. Changes nothing.
         */
        public function check(): void
        {
            $outcome = send([
                'site' => SITE,
                'id' => wp_generate_uuid4(),
                'action' => 'check',
                'occurredAt' => (int) floor(microtime(true) * 1000),
            ]);
            if ($outcome['status'] !== 'refreshed') {
                \WP_CLI::error("The Frontend didn't accept this Site's events ({$outcome['reason']}): {$outcome['message']}");
            }
            \WP_CLI::success('The Frontend at ' . endpoint() . ' accepts ' . SITE . '\'s events.');
        }

        /**
         * Sends an entry's last event again (the same event, so the Frontend
         * recognises it), or a new one if it has none.
         *
         * <post-id>
         * : The page or post.
         */
        public function retry(array $args): void
        {
            $post_id = (int) $args[0];
            $post = get_post($post_id);
            $event = recorded($post_id)['event'] ?? ($post instanceof WP_Post ? event_for($post, null) : null);
            if ($event === null) {
                \WP_CLI::error("Post {$args[0]} isn't a published page or post, and has no event to send.");
            }
            $delivery = deliver($post_id, $event);
            if ($delivery['status'] !== 'refreshed') {
                \WP_CLI::error("Not refreshed ({$delivery['reason']}): {$delivery['message']}");
            }
            \WP_CLI::success("Refreshed {$event['entry']['uri']} on the Frontend.");
        }
    });
}
