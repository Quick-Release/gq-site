// The SQL a commerce Site's db sync anonymises its local copy with: built
// only for the tables the copy has, and refusing a prefix it can't quote.
// (It was also run against WooCommerce 11.2.1's own table definitions on
// MariaDB 11.8 when written; this pins its shape.)
import assert from "node:assert/strict";
import test from "node:test";

import { anonymisationSql } from "../../src/db/anonymise.mjs";

const ALL = [
  "users",
  "usermeta",
  "posts",
  "postmeta",
  "comments",
  "wc_orders",
  "wc_order_addresses",
  "wc_customer_lookup",
  "wc_download_log",
  "woocommerce_downloadable_product_permissions",
  "woocommerce_sessions",
];

test("anonymises every customer and order table the copy has", () => {
  const sql = anonymisationSql(
    "wp_",
    ALL.map((name) => `wp_${name}`),
  );
  for (const table of ALL) assert.match(sql, new RegExp(`\`wp_${table}\``, "u"), table);
  // Customers only: staff keep their accounts.
  assert.match(
    sql,
    /meta_key = 'wp_capabilities' AND meta_value IN \('a:1:\{s:8:"customer";b:1;\}'/u,
  );
  assert.match(sql, /user_pass = ''/u);
  assert.match(sql, /@example\.invalid/u);
  assert.ok(sql.trimEnd().endsWith(";"));
});

test("skips the tables the copy doesn't have, and a non-WooCommerce copy gets nothing", () => {
  const sql = anonymisationSql("shop_", ["shop_wc_orders", "shop_options"]);
  assert.match(sql, /UPDATE `shop_wc_orders`/u);
  assert.doesNotMatch(sql, /shop_users|shop_postmeta|shop_woocommerce_sessions/u);
  assert.equal(anonymisationSql("wp_", ["wp_options"]), "");
});

test("refuses a table prefix that isn't letters, digits and underscores", () => {
  assert.throws(() => anonymisationSql("wp_`; DROP", ["wp_users"]), /Unexpected table prefix/u);
});
