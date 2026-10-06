// .env editing shared by commands that patch a site's environment file.

export function parseDotenv(source) {
  const env = {};
  for (const line of source.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
  return env;
}

// Sets each key in place (or appends it), leaving every other line — salts,
// comments, WP_SITEURL="${WP_HOME}/wp" — as it is.
export function applyEnv(source, values) {
  let output = source;
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}='${value}'`;
    const pattern = new RegExp(`^${key}=.*$`, "mu");
    const current = pattern.exec(output);
    if (current?.[0] === line || parseDotenv(current?.[0] ?? "")[key] === value) continue;
    output = current ? output.replace(pattern, line) : `${output.replace(/\n*$/u, "\n")}${line}\n`;
    changed.push(key);
  }
  return { output, changed };
}
