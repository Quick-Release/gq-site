<?php

/**
 * Plugin Name: {{Project}} Settings Events
 * Description: Tells the Frontend when a shared setting (menus, logo, site identity, design presets) changes, so every page shows it without republishing.
 * Author: {{Project}}
 * License: GPL-2.0-or-later
 */

/*
 * A change to a shared setting becomes a "settings" event, sent the way
 * publication-events.php sends a publication (its endpoint, key and signature)
 * and recorded the same way: as pending before it is sent, then refreshed or
 * failed with a reason, here in an option per setting
 * (`gq_settings_event_<setting>`). The Frontend refreshes what the setting is
 * part of from WordPress's public GraphQL, so the event carries no content.
 *
 * The settings and the changes that send them, as the GETQUICK packages store
 * them (GQ Design's Branding and Design screens, Appearance → Menus, the
 * Customizer and the Site Editor all write these):
 *
 * - menus: a menu or menu item saved or deleted, or the menu locations changed
 *   (the Frontend shows the primary location's menu);
 * - logo: the `site_logo` option (the Customizer's `custom_logo` syncs to it);
 * - identity: the `blogname`, `blogdescription` and `site_icon` options;
 * - design: the theme's global styles (`wp_global_styles`, where GQ Design
 *   saves the palette) or the active theme (its theme.json presets).
 *
 * On a multilingual Site (Polylang), a language has its own menus and its
 * own title and tagline, so a change to them names that language (the
 * event's `language`, its slug) and the Frontend refreshes only its rows:
 *
 * - menus: a language's menu locations (the `polylang` option's
 *   `nav_menus`; the theme's mods hold only the default language's), or a
 *   menu saved that is assigned in it;
 * - identity: a language's string translations (its title and tagline, in
 *   the `_pll_strings_translations` meta of its language term).
 *
 * The rest (the logo, the icon, the design, the site's own title and
 * tagline, which a language without a translation of them shows, and a menu
 * deleted) is shared: its event names no language, and the Frontend
 * refreshes every language's rows. Each setting, and each language's own,
 * records its events apart (`gq_settings_event_<setting>` and
 * `gq_settings_event_<setting>:<language>`).
 *
 * One event per setting (and language) per request, sent at the end of it;
 * saving never waits on it or fails because of it.
 */

declare(strict_types=1);

namespace GetQuick\Site\SettingsEvents;

use WP_Post;

use function GetQuick\Site\PublicationEvents\endpoint;
use function GetQuick\Site\PublicationEvents\secret;
use function GetQuick\Site\PublicationEvents\send;

/** The Site the events are for; the Frontend refuses any other. */
const SITE = '{{project}}';

/** Each setting's last event and its delivery: an option per setting. */
const OPTION_PREFIX = 'gq_settings_event_';

/** The shared settings the Frontend refreshes. */
const SETTINGS = ['menus', 'logo', 'identity', 'design'];

/** The settings a language has its own of, on a multilingual Site. */
const LANGUAGE_SETTINGS = ['menus', 'identity'];

/** Polylang's string translations, a term meta of each language's term. */
const STRINGS_META = '_pll_strings_translations';

/** The options that hold a setting. */
const OPTIONS = [
    'blogname' => 'identity',
    'blogdescription' => 'identity',
    'site_icon' => 'identity',
    'site_logo' => 'logo',
];

/** Whether publication-events.php, which signs and sends events, is loaded. */
function available(): bool
{
    return function_exists('GetQuick\\Site\\PublicationEvents\\send');
}

/** The Site's languages (Polylang's slugs), the default first; none without Polylang. */
function languages(): array
{
    return function_exists('pll_languages_list') ? array_values((array) pll_languages_list(['fields' => 'slug'])) : [];
}

/** Polylang's default language's slug, or null without Polylang. */
function default_language(): ?string
{
    $language = function_exists('pll_default_language') ? pll_default_language('slug') : null;

    return is_string($language) && $language !== '' ? $language : null;
}

/** What a setting's events are recorded as: the setting, or "<setting>:<language>" for one language's. */
function subject(string $setting, ?string $language = null): string
{
    return $language === null ? $setting : "{$setting}:{$language}";
}

/** Every subject events are recorded as: each setting, then each language's own. */
function subjects(): array
{
    $subjects = SETTINGS;
    foreach (languages() as $language) {
        foreach (LANGUAGE_SETTINGS as $setting) {
            $subjects[] = subject($setting, $language);
        }
    }

    return $subjects;
}

/** The subject an event is about. */
function subject_of(array $event): string
{
    return subject((string) $event['setting'], isset($event['language']) ? (string) $event['language'] : null);
}

function event_for(string $setting, ?string $language = null): array
{
    return [
        'site' => SITE,
        'id' => wp_generate_uuid4(),
        'action' => 'settings',
        'occurredAt' => (int) floor(microtime(true) * 1000),
        'setting' => $setting,
    ] + ($language === null ? [] : ['language' => $language]);
}

/** Records a subject's event and its delivery state. */
function record(string $subject, array $event, array $delivery): void
{
    update_option(OPTION_PREFIX . $subject, ['event' => $event, 'delivery' => $delivery], false);
}

/** A subject's last event and its delivery, if it has one. */
function recorded(string $subject): ?array
{
    wp_cache_delete(OPTION_PREFIX . $subject, 'options');
    $recorded = get_option(OPTION_PREFIX . $subject);

    return is_array($recorded) && isset($recorded['event'], $recorded['delivery']) ? $recorded : null;
}

/** Events to send at the end of this request, by subject. */
function queue(?array $add = null): array
{
    static $queued = [];
    if ($add !== null) {
        $queued[subject_of($add)] = $add;
    }

    return $queued;
}

/**
 * A shared setting changed, for every language or (`language`) in one: its
 * event is recorded as pending and sent at the end of the request. Further
 * changes to it in the same request move its time on, so one event covers
 * them all.
 */
function changed(string $setting, ?string $language = null): void
{
    if (
        ! available()
        || ! in_array($setting, SETTINGS, true)
        || ($language !== null && ! in_array($setting, LANGUAGE_SETTINGS, true))
    ) {
        return;
    }
    // Not configured outside production (such as local development without a
    // Frontend store): nothing to record. In production it is a failure to fix.
    if ((endpoint() === '' || secret() === '') && wp_get_environment_type() !== 'production') {
        return;
    }

    $subject = subject($setting, $language);
    $queued = queue();
    if (isset($queued[$subject])) {
        $event = $queued[$subject];
        $event['occurredAt'] = (int) floor(microtime(true) * 1000);
        queue($event);

        return;
    }
    $event = event_for($setting, $language);
    record($subject, $event, ['status' => 'pending', 'attempts' => 0, 'queuedAt' => time()]);
    if ($queued === []) {
        add_action('shutdown', __NAMESPACE__ . '\\send_queued', 1001);
    }
    queue($event);
}

/** Sends a subject's event and records how it went. */
function deliver(string $subject, array $event): array
{
    $previous = recorded($subject);
    $attempts = $previous !== null && ($previous['event']['id'] ?? null) === $event['id']
        ? (int) ($previous['delivery']['attempts'] ?? 0)
        : 0;

    $outcome = send($event);
    $delivery = $outcome + ['attempts' => $attempts + 1, 'attemptedAt' => time()];
    // A newer event recorded meanwhile (another request) keeps its own state.
    $current = recorded($subject);
    if ($current === null || ($current['event']['id'] ?? null) === $event['id']) {
        record($subject, $event, $delivery);
    }

    if ($outcome['status'] !== 'refreshed') {
        error_log(sprintf(
            'Settings events: %s for %s was not refreshed (%s): %s',
            $event['id'],
            $subject,
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
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
        fastcgi_finish_request();
    }
    foreach ($queued as $subject => $event) {
        deliver((string) $subject, $event);
    }
}

/** The menu locations the theme's mods hold: the default language's alone, with Polylang. */
function theme_locations(): array
{
    $mods = get_option('theme_mods_' . get_option('stylesheet'));

    return is_array($mods) && is_array($mods['nav_menu_locations'] ?? null) ? $mods['nav_menu_locations'] : [];
}

/** Polylang's menu locations for the current theme: location => [language => menu id]. */
function language_locations(?array $options = null): array
{
    $options ??= get_option('polylang');
    $locations = is_array($options) ? ($options['nav_menus'][get_option('stylesheet')] ?? []) : [];

    return is_array($locations) ? $locations : [];
}

/**
 * Where a menu is shown: null for every language (assigned to a theme
 * location, on a Site without Polylang), else the languages it is assigned
 * in; [] when it is assigned nowhere.
 */
function shown_in(int $menu_id): ?array
{
    $assigned = in_array($menu_id, array_map('intval', theme_locations()), true);
    $default = default_language();
    if ($default === null) {
        return $assigned ? null : [];
    }
    $languages = $assigned ? [$default] : [];
    foreach (language_locations() as $menus) {
        foreach ((array) $menus as $language => $id) {
            if ((int) $id === $menu_id) {
                $languages[] = (string) $language;
            }
        }
    }

    return array_values(array_unique($languages));
}

/** A menu was saved: its languages' menus changed, if it is shown. */
function menu_changed(int $menu_id): void
{
    $languages = shown_in($menu_id);
    if ($languages === null) {
        changed('menus');

        return;
    }
    foreach ($languages as $language) {
        changed('menus', $language);
    }
}

/**
 * Options: identity and the logo. The theme's mods hold the menu locations
 * (the default language's, with Polylang) and the Customizer's logo;
 * Polylang's option, each language's menu locations.
 */
function option_changed(string $option, mixed $old = null, mixed $value = null): void
{
    if (isset(OPTIONS[$option])) {
        changed(OPTIONS[$option]);

        return;
    }
    if ($option === 'polylang') {
        $before = language_locations(is_array($old) ? $old : []);
        $after = language_locations(is_array($value) ? $value : []);
        $changed = [];
        foreach (array_unique([...array_keys($before), ...array_keys($after)]) as $location) {
            $was = (array) ($before[$location] ?? []);
            $is = (array) ($after[$location] ?? []);
            foreach (array_unique([...array_keys($was), ...array_keys($is)]) as $language) {
                if ((int) ($was[$language] ?? 0) !== (int) ($is[$language] ?? 0)) {
                    $changed[(string) $language] = true;
                }
            }
        }
        foreach (array_keys($changed) as $language) {
            changed('menus', (string) $language);
        }

        return;
    }
    if ($option !== 'theme_mods_' . get_option('stylesheet')) {
        return;
    }
    $old = is_array($old) ? $old : [];
    $value = is_array($value) ? $value : [];
    if (($old['nav_menu_locations'] ?? []) != ($value['nav_menu_locations'] ?? [])) {
        changed('menus', default_language());
    }
    if (($old['custom_logo'] ?? null) != ($value['custom_logo'] ?? null)) {
        changed('logo');
    }
}

/**
 * A language's string translations changed: its title and tagline may have.
 * Not while the site's own title or tagline changes: Polylang then moves
 * every language's translations to the new text, and that change's event,
 * for every language, follows.
 */
function strings_changed(int $term_id, string $meta_key): void
{
    if (
        $meta_key !== STRINGS_META
        || doing_action('update_option_blogname')
        || doing_action('update_option_blogdescription')
    ) {
        return;
    }
    $term = get_term($term_id, 'language');
    if ($term instanceof \WP_Term) {
        changed('identity', $term->slug);
    }
}

add_action('updated_option', __NAMESPACE__ . '\\option_changed', 10, 3);
add_action('added_option', static fn(string $option, mixed $value) => option_changed($option, null, $value), 10, 2);
add_action('deleted_option', static fn(string $option) => option_changed($option), 10, 1);

add_action('added_term_meta', static fn(int $meta_id, int $term_id, string $meta_key) => strings_changed($term_id, $meta_key), 10, 3);
add_action('updated_term_meta', static fn(int $meta_id, int $term_id, string $meta_key) => strings_changed($term_id, $meta_key), 10, 3);
add_action('deleted_term_meta', static fn(array $meta_ids, int $term_id, string $meta_key) => strings_changed($term_id, $meta_key), 10, 3);

add_action('wp_update_nav_menu', static fn(int $menu_id) => menu_changed($menu_id), 10, 1);
add_action('wp_update_nav_menu_item', static fn(int $menu_id) => menu_changed($menu_id), 10, 1);
add_action('wp_delete_nav_menu', static fn() => changed('menus'), 10, 0);
add_action('deleted_post', static function (int $post_id, ?WP_Post $post = null): void {
    if ($post instanceof WP_Post && $post->post_type === 'nav_menu_item') {
        changed('menus');
    }
}, 10, 2);

add_action('save_post_wp_global_styles', static fn() => changed('design'), 10, 0);
add_action('switch_theme', static function (): void {
    changed('design');
    changed('menus');
}, 10, 0);

if (defined('WP_CLI') && WP_CLI && available()) {
    /**
     * Settings events: what was sent to the Frontend for each shared setting,
     * and how it went.
     */
    \WP_CLI::add_command('gq-events settings', new class {
        /**
         * Lists each shared setting's last event and its delivery.
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
            $rows = [];
            foreach (subjects() as $subject) {
                $recorded = recorded($subject);
                $rows[] = [
                    'setting' => $subject,
                    'event' => $recorded['event']['id'] ?? '',
                    'status' => $recorded['delivery']['status'] ?? 'none',
                    'reason' => $recorded['delivery']['reason'] ?? '',
                    'attempts' => $recorded['delivery']['attempts'] ?? 0,
                    'message' => $recorded['delivery']['message'] ?? '',
                ];
            }
            \WP_CLI\Utils\format_items($assoc['format'] ?? 'table', $rows, ['setting', 'event', 'status', 'reason', 'attempts', 'message']);
        }

        /**
         * Sends a setting's last event again (the same event, so the Frontend
         * recognises it), or a new one if it has none.
         *
         * <setting>
         * : menus, logo, identity or design; a language's menus or identity
         * as menus:<language> or identity:<language>.
         */
        public function retry(array $args): void
        {
            $subject = (string) $args[0];
            if (! in_array($subject, subjects(), true)) {
                \WP_CLI::error("No setting {$subject}; one of: " . implode(', ', subjects()) . '.');
            }
            [$setting, $language] = array_pad(explode(':', $subject, 2), 2, null);
            $event = recorded($subject)['event'] ?? event_for($setting, $language);
            $delivery = deliver($subject, $event);
            if ($delivery['status'] !== 'refreshed') {
                \WP_CLI::error("Not refreshed ({$delivery['reason']}): {$delivery['message']}");
            }
            \WP_CLI::success("Refreshed the {$subject} on the Frontend.");
        }
    });
}
