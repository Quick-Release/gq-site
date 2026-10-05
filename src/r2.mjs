import { createHash } from "node:crypto";

import { AwsClient } from "aws4fetch";

import { redactText } from "./cli/redact.mjs";

// A streamed upload goes up in parts of this size (R2 wants every part but
// the last to be the same size), so only one part is ever held in memory.
const PART_SIZE = 16 * 1024 * 1024;

// R2 rejects a token's S3 key (401 or 403) for a while after the token is
// created. A key minted just now is retried until R2 first accepts it,
// waiting 2 s, then twice as long each time up to 10 s, for 90 s in all.
const FIRST_WAIT_MS = 2000;
const LONGEST_WAIT_MS = 10_000;
const PROPAGATION_MS = 90_000;

// Minimal R2 (S3 API) client for one bucket:
// release archives are uploaded here and handed to Ploi as short-lived
// presigned GET URLs, and live database backups are uploaded by Ploi through
// presigned PUT URLs. Requests are signed here and sent through the injected
// `fetch`; S3 signing leaves the payload unsigned, so bodies stream as is.
// `minted` ({ now(), sleep(ms) }) says the key was minted just now: R2's
// rejections are waited out until it first accepts the key, and only then.
export function createR2Client({ accountId, bucket, accessKeyId, secretAccessKey, fetch, minted }) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are missing; store the bucket's R2 credentials in the secret store first.",
    );
  }
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const origin = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  const url = (key, query) =>
    `${origin}/${key.split("/").map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`;
  // Until R2 accepts a minted key: when it was minted, and the response R2
  // still rejected once the wait ran out, with how long gq waited.
  const mintedAt = minted?.now();
  let propagating = Boolean(minted);
  const waitedOut = new WeakMap();
  const signedFetch = async (target, { method, body, headers }) => {
    let wait = FIRST_WAIT_MS;
    for (;;) {
      const signed = await client.sign(target, { method, headers });
      const response = await fetch(signed.url, {
        method,
        headers: Object.fromEntries(signed.headers),
        body,
      });
      if (!propagating) return response;
      if (response.status !== 401 && response.status !== 403) {
        // A server error says nothing about the key.
        if (response.status < 500) propagating = false;
        return response;
      }
      const waited = minted.now() - mintedAt;
      if (waited >= PROPAGATION_MS) {
        waitedOut.set(response, waited);
        return response;
      }
      await response.body?.cancel();
      await minted.sleep(Math.min(wait, PROPAGATION_MS - waited));
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    }
  };
  const send = (key, { method, body, headers, query }) =>
    signedFetch(url(key, query), { method, body, headers });
  // Whoever a presigned URL goes to can't wait for R2 to accept the key, so
  // gq waits first, listing one object.
  const presign = async (method, key, expiresSeconds) => {
    if (propagating) {
      const response = await signedFetch(`${origin}?list-type=2&max-keys=1`, { method: "GET" });
      if (!response.ok) throw await failed(`listing ${bucket}`, response);
    }
    const signed = await client.sign(`${url(key)}?X-Amz-Expires=${expiresSeconds}`, {
      method,
      aws: { signQuery: true },
    });
    return signed.url;
  };

  // S3's error code and message, never the rest of its body (which can
  // echo the signed request), and with any credential masked.
  const failed = async (what, response) => {
    const body = await response.text();
    const code = xmlValue(body, "Code");
    const message = xmlValue(body, "Message");
    const detail = code ? `${code}${message ? `: ${message}` : ""}` : body.slice(0, 200);
    return new Error(
      `R2 ${what} failed with ${response.status}: ${redactText(detail)}${propagation(response)}`,
    );
  };
  const propagation = (response) =>
    waitedOut.has(response)
      ? ` (the key was minted just now; gq waited ${Math.round(waitedOut.get(response) / 1000)} s for R2 to accept it)`
      : "";

  async function put(key, body, contentType) {
    const response = await send(key, {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType },
    });
    if (!response.ok) throw await failed(`PUT ${key}`, response);
  }

  // `source` (an async iterable of bytes) as a multipart upload, part by part.
  async function uploadParts(key, source, contentType, onChunk) {
    let uploadId;
    const etags = [];
    let buffered = [];
    let bufferedBytes = 0;
    const sendPart = async (part) => {
      if (!uploadId) {
        const started = await send(key, {
          method: "POST",
          query: "uploads=",
          headers: { "Content-Type": contentType },
        });
        if (!started.ok) throw await failed(`multipart upload of ${key}`, started);
        uploadId = xmlValue(await started.text(), "UploadId");
      }
      const number = etags.length + 1;
      const response = await send(key, {
        method: "PUT",
        query: `partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`,
        body: part,
      });
      if (!response.ok) throw await failed(`part ${number} of ${key}`, response);
      etags.push(response.headers.get("etag"));
    };
    try {
      for await (const chunk of source) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        onChunk(bytes);
        buffered.push(bytes);
        bufferedBytes += bytes.length;
        while (bufferedBytes >= PART_SIZE) {
          const all = Buffer.concat(buffered);
          await sendPart(all.subarray(0, PART_SIZE));
          buffered = [all.subarray(PART_SIZE)];
          bufferedBytes -= PART_SIZE;
        }
      }
      const rest = Buffer.concat(buffered);
      // Small enough for one request.
      if (!uploadId) return put(key, rest, contentType);
      if (rest.length > 0) await sendPart(rest);
      const parts = etags
        .map(
          (etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
        )
        .join("");
      const completed = await send(key, {
        method: "POST",
        query: `uploadId=${encodeURIComponent(uploadId)}`,
        body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
        headers: { "Content-Type": "application/xml" },
      });
      if (!completed.ok) throw await failed(`completing ${key}`, completed);
    } catch (error) {
      if (uploadId) {
        await send(key, {
          method: "DELETE",
          query: `uploadId=${encodeURIComponent(uploadId)}`,
        }).catch(() => {});
      }
      throw error;
    }
  }

  return {
    // Every object under `prefix`: { key, size, lastModified }.
    async list(prefix = "") {
      const objects = [];
      let continuation;
      do {
        const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
        if (prefix) query.set("prefix", prefix);
        if (continuation) query.set("continuation-token", continuation);
        const response = await signedFetch(`${origin}?${query}`, { method: "GET" });
        if (!response.ok) throw await failed(`listing ${bucket}`, response);
        const body = await response.text();
        for (const [, entry] of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
          objects.push({
            key: xmlValue(entry, "Key"),
            size: Number(xmlValue(entry, "Size")),
            lastModified: new Date(xmlValue(entry, "LastModified")),
          });
        }
        continuation = /<IsTruncated>true<\/IsTruncated>/u.test(body)
          ? xmlValue(body, "NextContinuationToken")
          : undefined;
      } while (continuation);
      return objects;
    },
    async delete(key) {
      const response = await send(key, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw await failed(`DELETE ${key}`, response);
    },
    // Streams `source` (an async iterable of bytes or strings) to `key`,
    // hashing it on the way; resolves to { size, sha256 }.
    async upload(key, source, contentType = "application/octet-stream") {
      const hash = createHash("sha256");
      let size = 0;
      await uploadParts(key, source, contentType, (bytes) => {
        hash.update(bytes);
        size += bytes.length;
      });
      return { size, sha256: hash.digest("hex") };
    },
    async exists(key) {
      const response = await send(key, { method: "HEAD" });
      if (response.status === 404) return false;
      if (!response.ok)
        throw new Error(`R2 HEAD ${key} failed with ${response.status}${propagation(response)}`);
      return true;
    },
    async put(key, body, contentType = "application/gzip") {
      const response = await send(key, {
        method: "PUT",
        body,
        headers: { "Content-Type": contentType },
      });
      if (!response.ok)
        throw new Error(`R2 PUT ${key} failed with ${response.status}${propagation(response)}`);
    },
    async get(key) {
      const response = await send(key, { method: "GET" });
      if (!response.ok)
        throw new Error(`R2 GET ${key} failed with ${response.status}${propagation(response)}`);
      return response;
    },
    presignGet(key, expiresSeconds = 1800) {
      return presign("GET", key, expiresSeconds);
    },
    // Lets a server upload one object (e.g. `curl -T`) without R2 credentials.
    presignPut(key, expiresSeconds = 900) {
      return presign("PUT", key, expiresSeconds);
    },
  };
}

// The text of the first <name> element in an S3 XML response, unescaped.
function xmlValue(xml, name) {
  const value = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(xml)?.[1] ?? "";
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

// R2's S3 credentials derive from a Cloudflare API token: the access key ID is
// the token ID and the secret is the SHA-256 of the token value.
export async function s3CredentialsFromToken(tokenId, tokenValue) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenValue));
  const secretAccessKey = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { accessKeyId: tokenId, secretAccessKey };
}
