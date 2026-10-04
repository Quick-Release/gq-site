// Serves a fetch-style app on a loopback port, like a Worker under local dev.
import { createServer } from "node:http";

export function serve(app) {
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(req.url, origin), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([name, value]) =>
        [value].flat().map((v) => [name, v]),
      ),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await app.fetch(request);
    res.writeHead(response.status, [...response.headers].flat());
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
