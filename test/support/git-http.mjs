// A real git smart-HTTP endpoint for tests: git's own http-backend (CGI)
// behind a local HTTP server, serving the bare repositories under `root`,
// recording every request's method, path and Authorization header. With
// `redirectTo`, it answers every request with a redirect there instead.
// Nothing leaves 127.0.0.1; tokens in tests are synthetic.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const HTTP_BACKEND = join(
  execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
  "git-http-backend",
);

export async function gitHttpServer(root, { redirectTo } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization ?? null,
    });
    if (redirectTo) {
      response.writeHead(302, { Location: `${redirectTo}${url.pathname}${url.search}` });
      response.end();
      return;
    }
    const backend = spawn(HTTP_BACKEND, [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(backend.stdin);
    const chunks = [];
    backend.stdout.on("data", (chunk) => chunks.push(chunk));
    backend.on("close", () => {
      const output = Buffer.concat(chunks);
      const end = output.indexOf("\r\n\r\n");
      const head = output.subarray(0, end).toString("latin1").split("\r\n");
      const headers = {};
      let status = 200;
      for (const line of head) {
        const [name, ...rest] = line.split(": ");
        if (name.toLowerCase() === "status") status = Number.parseInt(rest.join(": "), 10);
        else if (name) headers[name] = rest.join(": ");
      }
      response.writeHead(status, headers);
      response.end(output.subarray(end + 4));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}
