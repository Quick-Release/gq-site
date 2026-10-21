<?php

// Exercise the actual registered field resolvers and JSON scalar. WordPress
// boundaries are deterministic substitutes, not a reimplementation of Block.
error_reporting(E_ALL);
ini_set('display_errors', '0');
$warnings = [];
set_error_handler(function ($severity, $message, $file, $line) use (&$warnings) {
    $warnings[] = [$severity, $message, basename($file), $line];
    return true;
});
define('ABSPATH', __DIR__);
define('OBJECT', 'OBJECT');
$fields = [];
$scalar = null;
function add_action($name, $callback) { $callback(); }
function register_graphql_scalar($name, $config) { $GLOBALS['scalar'] = $config['serialize']; }
function register_graphql_field($type, $name, $config) { $GLOBALS['fields'][$name] = $config; }
function __($text, ...$args) { return $text; }
function wp_reset_postdata() {}
function setup_postdata($post) {}
function render_block($data) { return $data['innerHTML']; }
function apply_filters($name, $value, ...$args) { return $value; }
function wp_json_encode($value) { return json_encode($value); }
function get_stylesheet_directory() { return $GLOBALS['theme']; }
function get_template_directory() { return $GLOBALS['theme']; }
function get_stylesheet() { return 'test'; }
function get_page_by_path(...$args) { return (object) ['post_content' => '{"styles":{}}']; }
function get_option($key) { return $key === 'sticky_posts' ? [7] : '0'; }
function get_page_template_slug($id) { return 'single'; }
function get_block_template($id, $type) { return (object) ['content' => json_encode($GLOBALS['template'])]; }
function parse_blocks($content) { return json_decode($content, true); }
function get_post($id = null) {
    return (object) ['ID' => 7, 'post_type' => 'post', 'post_name' => 'entry', 'post_content' => json_encode($GLOBALS['content'])];
}
class WP_Query {
    public $found_posts = 1;
    private $position = 0;
    public function __construct($args) { $GLOBALS['queries'][] = $args; }
    public function have_posts() { return $this->position < 1; }
    public function the_post() { $this->position++; }
}
function block($name, $attrs = [], $html = '<div></div>', $children = []) {
    return ['blockName' => $name, 'attrs' => $attrs, 'innerHTML' => $html, 'innerBlocks' => $children];
}
$theme = $argv[2];
$content = [
    block('core/paragraph', [], '<p>Hello</p>'),
    block('core/paragraph', ['align' => 'center', 'style' => ['elements' => ['button' => ['color' => 'red']]]], '<p>Aligned</p>'),
    block('core/group', [], '<section><p>Nested</p></section>', [block('core/paragraph', [], '<p>Nested</p>')]),
    block('core/button', [], '<div><a href="/target">Go</a></div>'),
    block('core/heading', [], '<h2>Heading</h2>'),
    block('core/spacer', [], ''),
    block('core/query', ['queryId' => 12, 'query' => ['perPage' => 2]], '<div></div>', [
        block('core/post-template', [], '<ul class="posts"></ul>', [block('core/paragraph', [], '<p>Result</p>')]),
    ]),
];
$template = [block('core/group', [], '<main><p>Template</p></main>', [block('core/post-content')])];
require $argv[1].'/plugin.php';
$responses = [];
$queries = [];
$initialLibxml = libxml_use_internal_errors();
for ($mask = 0; $mask < 32; $mask++) {
    $args = [];
    foreach (['postTemplate', 'attributes', 'htmlContent', 'dynamicContent', 'originalContent'] as $bit => $key) {
        $args[$key] = (bool) ($mask & (1 << $bit));
    }
    $raw = $fields['blocks']['resolve']((object) ['ID' => 7, 'uri' => '/entry/'], $args, null, null);
    $responses[] = $raw; // compares JSON key ordering as well as field presence
    $responses[] = json_encode(['data' => ['blocks' => $scalar($raw)]]);
}
// The lookup also accepts query blocks without an explicit queryId.
$responses[] = json_encode(WPGraphQLBlocks\get_query_by_id(12, [
    (object) ['name' => 'core/query', 'attributes' => []],
    (object) ['name' => 'core/query', 'attributes' => ['queryId' => 12]],
]));
restore_error_handler();
echo json_encode(['responses' => $responses, 'queries' => $queries, 'warnings' => $warnings,
    'libxmlRestored' => libxml_use_internal_errors() === $initialLibxml]);
