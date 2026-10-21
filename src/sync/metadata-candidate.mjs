import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const METADATA_CANDIDATE = "gq.metadata-candidate.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function recordMetadataCandidate(root, artifact) {
  if (!isAbsolute(artifact) || !artifact.endsWith(".tgz")) {
    throw new Error(
      "--metadata-candidate requires an absolute packed .tgz path, never a registry version.",
    );
  }
  const sha256 = digest(await readFile(artifact));
  await writeFile(
    join(root, METADATA_CANDIDATE),
    JSON.stringify({ artifact, sha256 }, null, 2) + "\n",
  );
}
export async function metadataCandidate(root) {
  let record;
  try {
    record = JSON.parse(await readFile(join(root, METADATA_CANDIDATE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !isAbsolute(record.artifact ?? "") ||
    !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "") ||
    digest(await readFile(record.artifact)) !== record.sha256
  ) {
    throw new Error(
      "Metadata candidate artifact changed or is invalid; no metadata activation or registry fallback is allowed.",
    );
  }
  return record;
}
