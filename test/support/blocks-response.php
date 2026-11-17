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
function get_option($key) { return ['sticky_posts' => [7], 'default_comment_status' => 'open'][$key] ?? '0'; }
// Media 5 exists; the custom logo (9) and any other ID do not.
function wp_get_attachment_image_src($id, $size) { return $id === 5 ? ['/media/5.jpg', 800, 600] : false; }
function get_post_meta($id, $key, $single) { return $id === 5 ? 'Media alt' : ''; }
function get_theme_mod($name) { return $name === 'custom_logo' ? 9 : false; }
function get_post_thumbnail_id($id) { return $id ? 5 : 0; }
function get_the_post_thumbnail_url($id, $size) { return $id ? '/media/5.jpg' : false; }
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
    // Sparse media blocks, as importers and the editor serialize them: no
    // width/height/id/url on images, no useFeaturedImage/id on covers.
    block('core/image', [], '<figure><img src="/imported.jpg" alt="Imported"/><figcaption>Caption</figcaption></figure>'),
    block('core/image', ['id' => 5, 'width' => 320, 'height' => 240], '<figure><a href="/full" target="_blank" rel="noopener" class="link"><img src="/5.jpg"/></a></figure>'),
    block('core/image', ['id' => 404], '<figure><img/></figure>'),
    block('core/cover', [], '<div class="wp-block-cover"><p>Cover</p></div>', [block('core/paragraph', [], '<p>Cover</p>')]),
    block('core/cover', ['useFeaturedImage' => true], '<div class="wp-block-cover"></div>'),
    block('core/cover', ['id' => 5, 'url' => '/5.jpg'], '<div class="wp-block-cover"></div>'),
    block('core/audio', [], '<figure><audio src="/a.mp3" preload="auto" autoplay loop></audio></figure>'),
    block('core/media-text', [], '<div class="wp-block-media-text"></div>'),
    block('core/site-logo'),
    block('core/comments', [], '<div class="wp-block-comments"></div>'),
    block('core/query', ['query' => ['perPage' => 2]], '<div></div>', [
        block('core/query-pagination', [], '<nav></nav>', [block('core/query-pagination-numbers')]),
    ]),
];
$template = [block('core/group', [], '<main><p>Template</p></main>', [block('core/post-content')])];
require $argv[1].'/plugin.php';
$responses = [];
$queries = [];
$initialLibxml = libxml_use_internal_errors();
// An entry, then the posts index (no ID), which takes the home-template branch.
foreach ([(object) ['ID' => 7, 'uri' => '/entry/'], (object) ['ID' => 0, 'uri' => '/']] as $node) {
    for ($mask = 0; $mask < 32; $mask++) {
        $args = [];
        foreach (['postTemplate', 'attributes', 'htmlContent', 'dynamicContent', 'originalContent'] as $bit => $key) {
            $args[$key] = (bool) ($mask & (1 << $bit));
        }
        $raw = $fields['blocks']['resolve']($node, $args, null, null);
        $responses[] = $raw; // compares JSON key ordering as well as field presence
        $responses[] = json_encode(['data' => ['blocks' => $scalar($raw)]]);
    }
}
// The lookup also accepts query blocks without an explicit queryId.
$responses[] = json_encode(WPGraphQLBlocks\get_query_by_id(12, [
    (object) ['name' => 'core/query', 'attributes' => []],
    (object) ['name' => 'core/query', 'attributes' => ['queryId' => 12]],
]));
restore_error_handler();
echo json_encode(['responses' => $responses, 'queries' => $queries, 'warnings' => $warnings,
    'libxmlRestored' => libxml_use_internal_errors() === $initialLibxml]);
