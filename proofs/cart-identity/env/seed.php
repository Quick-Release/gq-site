<?php
/**
 * Synthetic fixtures for the cart identity proof, run with `wp eval-file seed.php <mode>`.
 *
 * install   configure Woo and GETQUICK customer accounts; create synthetic products and customers
 * reset     clear every cart session and bearer record, and restore the customer's saved cart
 * versions  print runtime/provider versions
 * drop-registry  delete GQ eCommerce's bearer registry table but not its schema option,
 *                as a restore or failed migration might
 * end-sessions   end every WordPress session of the synthetic customer
 *
 * reset prints the fixture identifiers as JSON for the harness.
 */

$mode = $args[0] ?? '';

const GQ_PROOF_CUSTOMER = 'gq-proof-customer';
const GQ_PROOF_OTHER    = 'gq-proof-other';
const GQ_PROOF_PRODUCTS = array(
	'alpha' => array( 'GQ Proof Alpha', '10.00' ),
	'beta'  => array( 'GQ Proof Beta', '20.00' ),
	'gamma' => array( 'GQ Proof Gamma', '30.00' ),
);

function gq_proof_product_ids(): array {
	$ids = array();
	foreach ( array_keys( GQ_PROOF_PRODUCTS ) as $slug ) {
		$ids[ $slug ] = wc_get_product_id_by_sku( 'gq-proof-' . $slug );
	}
	return $ids;
}

function gq_proof_customer_id(): int {
	$user = get_user_by( 'login', GQ_PROOF_CUSTOMER );
	if ( ! $user ) {
		WP_CLI::error( 'Run install first.' );
	}
	return $user->ID;
}

switch ( $mode ) {
	case 'install':
		update_option( 'woocommerce_coming_soon', 'no' );
		update_option( 'woocommerce_store_pages_only', 'no' );
		update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true ) );
		update_option( 'woocommerce_currency', 'USD' );
		if ( ! class_exists( '\GetQuick\Config\Settings' ) || ! defined( 'GETQUICK_ECOMMERCE_ACTIVE' ) ) {
			WP_CLI::error( 'GETQUICK Config and GQ eCommerce must be active.' );
		}
		\GetQuick\Config\Settings::update( 'store', array( 'customer_accounts_enabled' => true ) );
		if ( ! getquick_config_customer_accounts_enabled() ) {
			WP_CLI::error( 'Customer accounts could not be enabled.' );
		}

		foreach ( GQ_PROOF_PRODUCTS as $slug => list( $name, $price ) ) {
			if ( wc_get_product_id_by_sku( 'gq-proof-' . $slug ) ) {
				continue;
			}
			$product = new WC_Product_Simple();
			$product->set_name( $name );
			$product->set_sku( 'gq-proof-' . $slug );
			$product->set_regular_price( $price );
			$product->set_status( 'publish' );
			$product->save();
		}

		$admin = get_user_by( 'login', 'gq-proof-admin' );
		if ( ! $admin ) {
			WP_CLI::error( 'The proof administrator is missing.' );
		}
		wp_set_password( trim( file_get_contents( '/var/www/html/.proof/admin-password' ) ), $admin->ID );

		foreach ( array(
			GQ_PROOF_CUSTOMER => 'customer-password',
			GQ_PROOF_OTHER    => 'other-password',
		) as $login => $password_file ) {
			if ( get_user_by( 'login', $login ) ) {
				continue;
			}
			$user_id = wp_insert_user(
				array(
					'user_login' => $login,
					'user_pass'  => trim( file_get_contents( '/var/www/html/.proof/' . $password_file ) ),
					'user_email' => $login . '@example.invalid',
					'role'       => 'customer',
				)
			);
			if ( is_wp_error( $user_id ) ) {
				WP_CLI::error( $user_id );
			}
		}
		WP_CLI::success( 'Synthetic store installed.' );
		break;

	case 'reset':
		global $wpdb;
		$customer_id = gq_proof_customer_id();
		$products    = gq_proof_product_ids();

		$wpdb->query( "DELETE FROM {$wpdb->prefix}woocommerce_sessions" );
		// GQ eCommerce's bearer registry, when the installed version has one.
		$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}getquick_ecommerce_cart_bearers" );
		delete_option( 'getquick_ecommerce_cart_bearers_schema' );
		// GQ eCommerce throttles sign-in to 30 per identifier per 10 minutes; back-to-back
		// suites sign the synthetic customers in more often than that.
		$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_getquick\\_auth\\_limit\\_%' OR option_name LIKE '\\_transient\\_timeout\\_getquick\\_auth\\_limit\\_%'" );

		// The customer's Woo saved cart: Alpha x3 and the saved-only Beta x2.
		$saved = array();
		foreach ( array( 'alpha' => 3, 'beta' => 2 ) as $slug => $quantity ) {
			$key           = md5( (string) $products[ $slug ] );
			$saved[ $key ] = array(
				'key'          => $key,
				'product_id'   => $products[ $slug ],
				'variation_id' => 0,
				'variation'    => array(),
				'quantity'     => $quantity,
			);
		}
		update_user_meta( $customer_id, '_woocommerce_persistent_cart_' . get_current_blog_id(), array( 'cart' => $saved ) );
		delete_user_meta( $customer_id, '_woocommerce_load_saved_cart_after_login' );
		WP_Session_Tokens::get_instance( $customer_id )->destroy_all();
		$other = get_user_by( 'login', GQ_PROOF_OTHER );
		delete_user_meta( $other->ID, '_woocommerce_persistent_cart_' . get_current_blog_id() );
		WP_Session_Tokens::get_instance( $other->ID )->destroy_all();

		echo wp_json_encode(
			array(
				'customer' => GQ_PROOF_CUSTOMER,
				'other'    => GQ_PROOF_OTHER,
				'products' => $products,
			)
		) . "\n";
		break;

	case 'versions':
		global $wpdb, $wp_version;
		echo wp_json_encode(
			array(
				'php'         => PHP_VERSION,
				'wordpress'   => $wp_version,
				'woocommerce' => WC_VERSION,
				'database'    => $wpdb->db_server_info(),
				'getquick-config' => defined( 'GETQUICK_CONFIG_VERSION' ) ? GETQUICK_CONFIG_VERSION : null,
				'gq-design'       => defined( 'GETQUICK_DESIGN_VERSION' ) ? GETQUICK_DESIGN_VERSION : null,
				'gq-ecommerce'    => defined( 'GETQUICK_ECOMMERCE_VERSION' ) ? GETQUICK_ECOMMERCE_VERSION : null,
				'gq-ecommerce-active' => defined( 'GETQUICK_ECOMMERCE_ACTIVE' ),
			)
		) . "\n";
		break;

	case 'drop-registry':
		global $wpdb;
		$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}getquick_ecommerce_cart_bearers" );
		WP_CLI::success( 'Registry table dropped.' );
		break;

	case 'end-sessions':
		WP_Session_Tokens::get_instance( gq_proof_customer_id() )->destroy_all();
		WP_CLI::success( 'Customer sessions ended.' );
		break;

	default:
		WP_CLI::error( 'usage: wp eval-file seed.php install|reset|versions|drop-registry|end-sessions' );
}
