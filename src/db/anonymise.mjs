// What a commerce Site's database sync replaces before WordPress sees the
// imported copy (ADR 0017): customers' and orders' personal data. The live
// database is never touched; this only rewrites the local copy, right after
// its import, so no developer machine keeps a shop's customers by default.
//
// Store staff keep their accounts: only users whose only role is customer
// (or subscriber, WooCommerce's default before 3.x) are anonymised, each to
// customer-<ID>@example.invalid with no password. Every order's billing and
// shipping data, its customer note, IP address and user agent are blanked in
// both order stores (HPOS tables and legacy order post meta), as are the
// customer lookup table, reviews' and order notes' authors, download logs and
// the WooCommerce sessions (carts), which are emptied.
//
// Statements are built only for the tables the database has (WooCommerce's
// set depends on its version and on whether HPOS is on).

const ANONYMOUS_DOMAIN = "example.invalid";

// A table prefix is letters, digits and underscores (Bedrock's DB_PREFIX).
function assertPrefix(prefix) {
  if (!/^\w+$/u.test(prefix)) throw new Error(`Unexpected table prefix: ${prefix}`);
}

const anonymousEmail = (id) => `CONCAT('customer-', ${id}, '@${ANONYMOUS_DOMAIN}')`;

/**
 * The SQL that anonymises a commerce Site's customers and orders, for the
 * tables `tables` lists (the database's own, with their prefix), or an empty
 * string when it has none of them.
 */
export function anonymisationSql(prefix, tables) {
  assertPrefix(prefix);
  const has = (name) => tables.includes(`${prefix}${name}`);
  const t = (name) => `\`${prefix}${name}\``;
  const statements = [];

  if (has("users") && has("usermeta")) {
    // Users whose capabilities grant only customer (or subscriber).
    const customers = `SELECT user_id FROM ${t("usermeta")} WHERE meta_key = '${prefix}capabilities' AND meta_value IN ('a:1:{s:8:"customer";b:1;}', 'a:1:{s:10:"subscriber";b:1;}')`;
    statements.push(
      `CREATE TEMPORARY TABLE gq_customers (user_id BIGINT UNSIGNED PRIMARY KEY) ${customers}`,
      `UPDATE ${t("users")} SET user_email = ${anonymousEmail("ID")}, user_login = CONCAT('customer-', ID), user_nicename = CONCAT('customer-', ID), display_name = CONCAT('Customer ', ID), user_url = '', user_pass = '', user_activation_key = '' WHERE ID IN (SELECT user_id FROM gq_customers)`,
      `UPDATE ${t("usermeta")} SET meta_value = '' WHERE user_id IN (SELECT user_id FROM gq_customers) AND meta_key IN ('first_name', 'last_name', 'description')`,
      `UPDATE ${t("usermeta")} SET meta_value = CONCAT('Customer ', user_id) WHERE user_id IN (SELECT user_id FROM gq_customers) AND meta_key = 'nickname'`,
      `DELETE FROM ${t("usermeta")} WHERE user_id IN (SELECT user_id FROM gq_customers) AND meta_key = 'session_tokens'`,
      `DROP TEMPORARY TABLE gq_customers`,
    );
    // Every account's saved addresses: no one's are needed locally.
    statements.push(
      `UPDATE ${t("usermeta")} SET meta_value = '' WHERE meta_key LIKE 'billing\\_%' OR meta_key LIKE 'shipping\\_%'`,
    );
  }

  // HPOS: the order and its addresses.
  if (has("wc_orders")) {
    statements.push(
      `UPDATE ${t("wc_orders")} SET billing_email = ${anonymousEmail("id")}, customer_note = NULL, ip_address = NULL, user_agent = NULL`,
    );
  }
  if (has("wc_order_addresses")) {
    statements.push(
      `UPDATE ${t("wc_order_addresses")} SET first_name = NULL, last_name = NULL, company = NULL, address_1 = NULL, address_2 = NULL, city = NULL, state = NULL, postcode = NULL, phone = NULL, email = ${anonymousEmail("order_id")}`,
    );
  }
  // Legacy order storage (and HPOS's compatibility copy): order post meta.
  if (has("postmeta") && has("posts")) {
    statements.push(
      `UPDATE ${t("postmeta")} SET meta_value = '' WHERE (meta_key LIKE '\\_billing\\_%' OR meta_key LIKE '\\_shipping\\_%' OR meta_key IN ('_customer_ip_address', '_customer_user_agent')) AND post_id IN (SELECT ID FROM ${t("posts")} WHERE post_type IN ('shop_order', 'shop_order_placehold', 'shop_order_refund', 'shop_subscription'))`,
      `UPDATE ${t("posts")} SET post_excerpt = '' WHERE post_type = 'shop_order'`,
    );
  }
  if (has("wc_customer_lookup")) {
    statements.push(
      `UPDATE ${t("wc_customer_lookup")} SET username = CONCAT('customer-', customer_id), first_name = '', last_name = '', email = ${anonymousEmail("customer_id")}, city = '', state = '', postcode = '', billing_phone = '', shipping_phone = ''`,
    );
  }
  // Reviews' and order notes' authors.
  if (has("comments")) {
    statements.push(
      `UPDATE ${t("comments")} SET comment_author = 'Customer', comment_author_email = '', comment_author_IP = '', comment_author_url = '', comment_agent = '' WHERE comment_type IN ('review', 'order_note') AND user_id NOT IN (SELECT user_id FROM ${t("usermeta")} WHERE meta_key = '${prefix}capabilities' AND (meta_value LIKE '%administrator%' OR meta_value LIKE '%shop_manager%'))`,
    );
  }
  if (has("wc_download_log")) {
    statements.push(`UPDATE ${t("wc_download_log")} SET user_ip_address = NULL`);
  }
  if (has("woocommerce_downloadable_product_permissions")) {
    statements.push(
      `UPDATE ${t("woocommerce_downloadable_product_permissions")} SET user_email = ${anonymousEmail("permission_id")}`,
    );
  }
  // Carts and their sessions: nothing a local copy needs.
  if (has("woocommerce_sessions")) statements.push(`DELETE FROM ${t("woocommerce_sessions")}`);

  return statements.length === 0 ? "" : `${statements.join(";\n")};\n`;
}

/** The query that lists the imported database's tables, one per line. */
export const LIST_TABLES_SQL =
  "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()";
