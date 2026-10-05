<?php
/**
 * Plugin Name: GQ proof runtime (fixture)
 * Description: What a Site's Bedrock provides to the GETQUICK plugins: Composer's PSR-4
 * autoloading and the storefront proxy secret from the runtime environment. The secret
 * comes from a mode-0600 file outside the docroot.
 */

foreach ( array(
	'GetQuick\\Ecommerce\\' => WP_PLUGIN_DIR . '/gq-ecommerce/src/',
	'GetQuick\\Design\\'    => WP_PLUGIN_DIR . '/getquick-design/src/',
) as $prefix => $directory ) {
	spl_autoload_register(
		static function ( string $class ) use ( $prefix, $directory ): void {
			if ( 0 !== strpos( $class, $prefix ) ) {
				return;
			}
			$file = $directory . str_replace( '\\', '/', substr( $class, strlen( $prefix ) ) ) . '.php';
			if ( is_file( $file ) ) {
				require $file;
			}
		}
	);
}

if ( ! defined( 'GETQUICK_STOREFRONT_PROXY_SECRET' ) ) {
	define( 'GETQUICK_STOREFRONT_PROXY_SECRET', trim( (string) file_get_contents( '/var/www/html/.proof/proxy-secret' ) ) );
}
