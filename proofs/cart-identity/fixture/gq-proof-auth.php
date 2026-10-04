<?php
/**
 * Plugin Name: GQ proof auth bridge (fixture)
 * Description: Proof-only stand-in for a BFF's native auth bridge. Returns a REST nonce for
 * the native WordPress login cookie and exits before WooCommerce initialises, so it never
 * loads (and never consumes Woo's one-shot saved-cart merge into) a cart session.
 */

add_action(
	'plugins_loaded',
	function () {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- issues a nonce; reads nothing else.
		if ( 'rest-nonce' !== ( $_GET['gq-proof-auth'] ?? '' ) ) {
			return;
		}
		nocache_headers();
		header( 'Content-Type: text/plain; charset=utf-8' );
		if ( ! is_user_logged_in() ) {
			status_header( 401 );
			exit;
		}
		echo esc_html( wp_create_nonce( 'wp_rest' ) );
		exit;
	},
	PHP_INT_MAX
);
