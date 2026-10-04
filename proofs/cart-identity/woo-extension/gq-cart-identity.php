<?php
/**
 * Plugin Name: GQ cart identity (proof)
 * Description: Retires Woo Store API cart bearers across native identity changes. Proof
 * only, for gq-site issue #57; not enabled for any Site.
 *
 * Woo's Cart-Token is a signed pointer to a session key with no revocation. This plugin
 * keeps a registry of session keys that belong to a customer or have been retired, and
 * enforces three rules on every Store API request that presents a valid Cart-Token:
 *
 * 1. A retired key is refused (401 gq_cart_bearer_retired), whoever presents it.
 * 2. A customer's key (registered to them, or Woo's user-ID key) is honoured only for that
 *    customer's native WordPress login (401 gq_cart_identity_required).
 * 3. A guest key presented with a WordPress login is refused (409
 *    gq_cart_transition_required), so Woo never merges a saved cart into a guest key.
 *
 * Sign-in (POST /wp-json/gq-cart-identity/v1/sign-in) moves the guest session to a fresh
 * key registered to the customer, retires the guest key, and re-arms Woo's native
 * saved-cart merge for the fresh key. Sign-out (POST .../sign-out) retires the current
 * key and ends this browser's native WordPress session. Woo's saved cart is untouched.
 */

namespace GQ\CartIdentity;

use Automattic\WooCommerce\StoreApi\Utilities\CartTokenUtils;
use WP_Error;
use WP_REST_Request;

defined( 'ABSPATH' ) || exit;

const SCHEMA = 1;

function registry(): string {
	return $GLOBALS['wpdb']->prefix . 'gq_cart_bearers';
}

function sessions(): string {
	return $GLOBALS['wpdb']->prefix . 'woocommerce_sessions';
}

function install(): void {
	if ( (int) get_option( 'gq_cart_identity_schema' ) === SCHEMA ) {
		return;
	}
	global $wpdb;
	$wpdb->query(
		'CREATE TABLE IF NOT EXISTS ' . registry() . ' (
			session_key char(32) NOT NULL,
			owner_id bigint(20) unsigned NOT NULL,
			state varchar(8) NOT NULL,
			successor_key char(32) NULL,
			changed_at bigint(20) unsigned NOT NULL,
			PRIMARY KEY (session_key)
		) ' . $wpdb->get_charset_collate()
	);
	update_option( 'gq_cart_identity_schema', SCHEMA, false );
}
add_action( 'init', __NAMESPACE__ . '\install' );

/** The session key a valid Cart-Token on this request points to, or null. */
function presented_key(): ?string {
	if ( ! class_exists( CartTokenUtils::class ) ) {
		return null;
	}
	$token = CartTokenUtils::get_request_cart_token();
	if ( '' === $token || ! CartTokenUtils::validate_cart_token( $token ) ) {
		return null;
	}
	$key = (string) CartTokenUtils::get_cart_token_payload( $token )['user_id'];
	return '' === $key ? null : $key;
}

/** @return object|null The registry row for a session key. */
function record( string $key ) {
	global $wpdb;
	return $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM %i WHERE session_key = %s', registry(), $key ) );
}

/** The customer a session key belongs to, or 0 for a guest key. */
function owner( string $key, $row ): int {
	if ( $row ) {
		return (int) $row->owner_id;
	}
	// Woo keys a signed-in customer's own sessions by their user ID.
	if ( ctype_digit( $key ) && get_userdata( (int) $key ) ) {
		return (int) $key;
	}
	return 0;
}

function refuse( string $code, string $message, int $status ): WP_Error {
	return new WP_Error( $code, $message, array( 'status' => $status ) );
}

/**
 * Whether WordPress matched this request to a Store API route. WordPress matches routes
 * case-insensitively and lets `rest_route` override the path, while Woo's cart routes
 * load the Cart-Token session whatever the casing, so decide by the handler that will
 * actually run rather than by the requested route's spelling.
 */
function is_store_api( array $handler, WP_REST_Request $request ): bool {
	if ( 0 === strpos( strtolower( $request->get_route() ), '/wc/store/' ) ) {
		return true;
	}
	$callback = $handler['callback'] ?? null;
	return is_array( $callback ) && is_object( $callback[0] )
		&& 0 === strpos( get_class( $callback[0] ), 'Automattic\\WooCommerce\\StoreApi\\' );
}

/**
 * Enforce the bearer rules after routing and before any Store API permission check or
 * callback. A refusal replaces any earlier validation error, so a refused bearer always
 * gets the same answer. Batch sub-requests pass through here as well, and all of them
 * carry the outer request's Cart-Token.
 */
function guard( $result, $handler, WP_REST_Request $request ) {
	if ( ! is_store_api( (array) $handler, $request ) ) {
		return $result;
	}
	return refusal() ?? $result;
}

/** Why the presented Cart-Token may not be used by this request, or null if it may. */
function refusal(): ?WP_Error {
	$key = presented_key();
	if ( null === $key ) {
		return null;
	}
	$row = record( $key );
	if ( $row && 'retired' === $row->state ) {
		return refuse( 'gq_cart_bearer_retired', 'This cart session has been retired.', 401 );
	}
	$owner = owner( $key, $row );
	if ( $owner ) {
		return get_current_user_id() === $owner
			? null
			: refuse( 'gq_cart_identity_required', 'This cart belongs to a signed-in customer.', 401 );
	}
	if ( is_user_logged_in() ) {
		return refuse( 'gq_cart_transition_required', 'Sign in to move this guest cart first.', 409 );
	}
	return null;
}
add_filter( 'rest_request_before_callbacks', __NAMESPACE__ . '\guard', 0, 3 );

function token_for( string $key ): array {
	return array( 'cart_token' => CartTokenUtils::get_cart_token( $key ) );
}

/**
 * Give the signed-in customer a fresh cart identity, carrying the presented guest cart.
 *
 * The guest key is retired first, with a unique insert, so a concurrent or repeated
 * sign-in for the same guest key cannot copy it twice. A repeat by the same customer
 * receives the successor key again without another copy or merge.
 */
function sign_in( WP_REST_Request $request ) {
	global $wpdb;
	install();
	$user_id = get_current_user_id();
	$fresh   = wc_rand_hash( 'c_', 30 );
	$now     = time();
	$expiry  = CartTokenUtils::get_cart_token_expiration();
	$data    = null;
	$key     = presented_key();

	if ( null !== $key && ctype_digit( $key ) ) {
		// Woo's user-ID key is never claimed or retired: it is shared by the customer's
		// cookie sessions. Only its owner may start from it, and starts fresh.
		if ( owner( $key, null ) !== $user_id ) {
			return refuse( 'gq_cart_identity_required', 'This cart belongs to another customer.', 403 );
		}
		$key = null;
	}

	if ( null !== $key ) {
		$claimed = $wpdb->query(
			$wpdb->prepare(
				'INSERT IGNORE INTO %i (session_key, owner_id, state, successor_key, changed_at) VALUES (%s, %d, %s, %s, %d)',
				registry(),
				$key,
				$user_id,
				'retired',
				$fresh,
				$now
			)
		);
		if ( 1 !== $claimed ) {
			$row = record( $key );
			if ( $row && (int) $row->owner_id === $user_id ) {
				if ( 'owned' === $row->state ) {
					return token_for( $key );
				}
				$successor = $row->successor_key ? record( $row->successor_key ) : null;
				if ( $successor && 'owned' === $successor->state ) {
					return token_for( $row->successor_key );
				}
			}
			return refuse( 'gq_cart_bearer_unusable', 'This cart session cannot be signed in.', 409 );
		}
		$data = $wpdb->get_var( $wpdb->prepare( 'SELECT session_value FROM %i WHERE session_key = %s', sessions(), $key ) );
	}

	$wpdb->insert(
		registry(),
		array(
			'session_key' => $fresh,
			'owner_id'    => $user_id,
			'state'       => 'owned',
			'changed_at'  => $now,
		)
	);
	if ( null !== $data ) {
		$wpdb->insert(
			sessions(),
			array(
				'session_key'    => $fresh,
				'session_value'  => $data,
				'session_expiry' => $expiry,
			)
		);
	}
	if ( null !== $key ) {
		$wpdb->delete( sessions(), array( 'session_key' => $key ) );
	}
	// Woo merges the saved cart into the next cart it loads for this customer. Other
	// requests (any page view) may have consumed that one-shot flag since wp_login, so
	// re-arm it for the fresh key: the merge itself stays Woo's.
	update_user_meta( $user_id, '_woocommerce_load_saved_cart_after_login', 1 );
	return token_for( $fresh );
}

/** Retire this browser's cart identity and end its native WordPress session. */
function sign_out( WP_REST_Request $request ) {
	global $wpdb;
	install();
	$user_id = get_current_user_id();
	$key     = presented_key();
	$retired = false;
	if ( null !== $key && owner( $key, record( $key ) ) === $user_id && ! ctype_digit( $key ) ) {
		$wpdb->update(
			registry(),
			array(
				'state'      => 'retired',
				'changed_at' => time(),
			),
			array( 'session_key' => $key )
		);
		$wpdb->delete( sessions(), array( 'session_key' => $key ) );
		$retired = true;
	}
	wp_logout();
	return array(
		'cart_retired' => $retired,
		'signed_out'   => true,
	);
}

add_action(
	'rest_api_init',
	function () {
		foreach ( array(
			'sign-in'  => __NAMESPACE__ . '\sign_in',
			'sign-out' => __NAMESPACE__ . '\sign_out',
		) as $route => $callback ) {
			register_rest_route(
				'gq-cart-identity/v1',
				'/' . $route,
				array(
					'methods'             => 'POST',
					'callback'            => $callback,
					'permission_callback' => 'is_user_logged_in',
				)
			);
		}
	}
);
