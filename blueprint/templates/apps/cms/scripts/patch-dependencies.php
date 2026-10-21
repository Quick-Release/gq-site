<?php

// Managed by @getquick/site. Runs with Composer's PHP, without Node or WordPress.
// Stage first: patch may report reversed/already-applied hunks during repair.
// Only the verified final bytes, never patch's exit status, authorize a write.
declare(strict_types=1);

$cms = dirname(__DIR__);
$relativeFiles = [
    'plugin.php' => '7dee3f7934efa6a70c8c1666f36cb65dd0805ca0a8570ec03d577fb87edc0499',
    'includes/utils.php' => '6c391ea3dbe2e0dc819f45fd267a61d7a3d4f60f3e0eed6d6086dd19cafd2624',
];
$plugin = $cms . '/web/app/plugins/wpgraphql-blocks';
$stage = null;
$pending = [];
$exitCode = 0;

function runPatchTool(array $command, string $cwd, ?string $input = null): array
{
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $cwd);
    if (!is_resource($process)) {
        throw new RuntimeException('Cannot start ' . implode(' ', $command));
    }
    fwrite($pipes[0], $input ?? '');
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);

    return [proc_close($process), $output];
}

try {
    $source = file_get_contents($plugin . '/plugin.php');
    if ($source === false || !preg_match('/^\s*\* Version: 2\.2\.0\s*$/m', $source)) {
        throw new RuntimeException('Missing or unsupported wpgraphql-blocks; expected version 2.2.0.');
    }
    $stage = sys_get_temp_dir() . '/gq-blocks-' . bin2hex(random_bytes(12));
    $stagedPlugin = $stage . '/web/app/plugins/wpgraphql-blocks';
    if (!mkdir($stagedPlugin . '/includes', 0700, true)) {
        throw new RuntimeException('Cannot create patch staging directory.');
    }
    $alreadyApplied = true;
    foreach ($relativeFiles as $file => $hash) {
        if (!is_file($plugin . '/' . $file) || !copy($plugin . '/' . $file, $stagedPlugin . '/' . $file)) {
            throw new RuntimeException('Missing or unreadable wpgraphql-blocks/' . $file);
        }
        $alreadyApplied = $alreadyApplied && hash_file('sha256', $plugin . '/' . $file) === $hash;
    }
    if (!$alreadyApplied) {
        $patch = file_get_contents($cms . '/patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch');
        if ($patch === false) {
            throw new RuntimeException('Missing managed wpgraphql-blocks patch; run gq sync.');
        }
        // Apply each hunk independently: patch --forward otherwise guesses
        // that an entire file is reversed when only its first hunk is present.
        $header = '';
        foreach (preg_split('/(?=^--- |^@@ )/m', $patch) as $part) {
            if (str_starts_with($part, '--- ')) {
                $header = $part;
            } elseif (str_starts_with($part, '@@ ')) {
                [$status, $output] = runPatchTool(
                    ['patch', '-p1', '--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-r', '/dev/null'],
                    $stage,
                    $header . $part,
                );
                if ($status > 1) {
                    throw new RuntimeException('Cannot apply patch (GNU patch is required): ' . $output);
                }
            }
        }
    }
    // Validate every file before touching any installed source, even on reruns.
    foreach ($relativeFiles as $file => $hash) {
        if (hash_file('sha256', $stagedPlugin . '/' . $file) !== $hash) {
            throw new RuntimeException('Source drift in wpgraphql-blocks/' . $file . '; expected reviewed 2.2.0 bytes. Re-review the dependency patch before upgrading; do not bypass it.');
        }
        [$status, $output] = runPatchTool([PHP_BINARY, '-l', $stagedPlugin . '/' . $file], $stage);
        if ($status !== 0) {
            throw new RuntimeException('PHP syntax check failed: ' . $output);
        }
    }
    // Prepare replacements beside their destinations, then rename atomically
    // per file. Interruption between renames is repaired on the next invocation.
    foreach ($relativeFiles as $file => $hash) {
        if (hash_file('sha256', $plugin . '/' . $file) === $hash) {
            continue;
        }
        $target = $plugin . '/' . $file;
        $temporary = tempnam(dirname($target), '.gq-patch-');
        if ($temporary === false) {
            throw new RuntimeException('Cannot stage replacement for ' . $file);
        }
        $pending[$target] = $temporary;
        if (!copy($stagedPlugin . '/' . $file, $temporary) || !chmod($temporary, fileperms($target) & 0777)) {
            throw new RuntimeException('Cannot prepare replacement for ' . $file);
        }
    }
    foreach ($pending as $target => $temporary) {
        if (!rename($temporary, $target)) {
            throw new RuntimeException('Cannot replace ' . $target . '; rerun Composer to repair.');
        }
    }
    echo 'wpgraphql-blocks 2.2.0 warning patch ' . ($alreadyApplied ? 'already applied' : 'applied') . ' and PHP syntax verified.' . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, 'GETQUICK dependency patch failed: ' . $error->getMessage() . PHP_EOL);
    $exitCode = 1;
} finally {
    foreach ($pending as $temporary) {
        if (is_file($temporary)) {
            unlink($temporary);
        }
    }
    if ($stage !== null && is_dir($stage)) {
        foreach (array_keys($relativeFiles) as $file) {
            if (is_file($stage . '/web/app/plugins/wpgraphql-blocks/' . $file)) {
                unlink($stage . '/web/app/plugins/wpgraphql-blocks/' . $file);
            }
        }
        foreach (['/web/app/plugins/wpgraphql-blocks/includes', '/web/app/plugins/wpgraphql-blocks', '/web/app/plugins', '/web/app', '/web', ''] as $directory) {
            rmdir($stage . $directory);
        }
    }
}
exit($exitCode);
