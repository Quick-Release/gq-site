<?php

/**
 * Plugin Name: {{Project}} Content API
 * Description: Keeps this WordPress installation focused on content management and WPGraphQL delivery.
 * Author: {{Project}}
 * License: GPL-2.0-or-later
 */

declare(strict_types=1);

/**
 * This hostname is an admin/API origin, not a public WordPress frontend.
 */
add_action('template_redirect', static function (): void {
    if (is_user_logged_in() || (function_exists('is_graphql_request') && is_graphql_request())) {
        return;
    }

    if (parse_url(home_url('/'), PHP_URL_PATH) === parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH)) {
        wp_safe_redirect(admin_url());
        exit;
    }

    status_header(404);
    nocache_headers();
    exit;
}, 1);

/**
 * Keep the legacy XML-RPC surface disabled; clients should use GraphQL.
 */
add_filter('xmlrpc_enabled', '__return_false');

/**
 * Do not expose the REST API to anonymous callers. Authenticated WordPress
 * users remain able to use the dashboard and editorial tooling.
 *
 * One exception: a Gravity Forms submission, the one REST call a Site's
 * Frontend makes (gq-platform ADR 0009). It is a POST, without a method
 * override, to exactly /gf/v2/forms/<id>/submissions, while gq-content's
 * forms module has Gravity Forms active. Gravity Forms checks the form, its
 * fields and its spam controls itself; reading forms or entries stays closed.
 */
add_filter('rest_authentication_errors', static function ($result) {
    if (!empty($result) || is_user_logged_in()) {
        return $result;
    }

    $forms = function_exists('GetQuick\\Content\\Forms\\active') && \GetQuick\Content\Forms\active();
    $post = ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && !isset($_GET['_method']) && !isset($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
    $route = $GLOBALS['wp']->query_vars['rest_route'] ?? '';
    if ($forms && $post && is_string($route) && preg_match('#^/gf/v2/forms/[1-9][0-9]*/submissions$#D', untrailingslashit($route)) === 1) {
        return $result;
    }

    return new WP_Error(
        'rest_auth_required',
        __('The REST API is available only to authenticated WordPress users.', '{{project}}'),
        ['status' => 401],
    );
});

/**
 * WPGraphQL defaults to a wildcard origin. When origins are configured, limit
 * browser access to the exact comma-separated origins in .env.
 */
add_filter('graphql_response_headers_to_send', static function (array $headers): array {
    $configured = getenv('GRAPHQL_CORS_ORIGINS');
    $origins = array_values(array_filter(array_map('trim', explode(',', is_string($configured) ? $configured : ''))));

    if ($origins === []) {
        return $headers;
    }

    unset($headers['Access-Control-Allow-Origin']);

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (in_array($origin, $origins, true)) {
        $headers['Access-Control-Allow-Origin'] = $origin;
        $headers['Vary'] = 'Origin';
    }

    return $headers;
});
