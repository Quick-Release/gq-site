// A page's or post's raw content on the production CMS over REST, as the
// agent user: read at `context=edit` (`content.raw`, the markup as stored),
// written with POST to the same resource, and its revisions listed and read,
// since the revision each write leaves is the rollback (ADR 0011).

const POST_FIELDS = "id,type,status,link,modified_gmt,content";

function rawContent(post, what) {
  const raw = post?.content?.raw;
  if (typeof raw !== "string") {
    throw new Error(`${what} came back without content.raw; the agent user can't edit it.`);
  }
  return raw;
}

function summary(post, raw) {
  return {
    id: post.id,
    type: post.type,
    status: post.status,
    link: post.link,
    modifiedGmt: post.modified_gmt,
    raw,
  };
}

export async function readPost(request, base, id) {
  const post = await request("GET", `/wp-json/wp/v2/${base}/${id}`, {
    query: { context: "edit", _fields: POST_FIELDS },
  });
  return summary(post, rawContent(post, `${base}/${id}`));
}

export async function writePost(request, base, id, raw) {
  const post = await request("POST", `/wp-json/wp/v2/${base}/${id}`, {
    query: { context: "edit", _fields: POST_FIELDS },
    body: { content: raw },
  });
  return summary(post, rawContent(post, `${base}/${id}`));
}

/** Its revisions' IDs, newest first. */
export async function revisionIds(request, base, id) {
  const revisions = await request("GET", `/wp-json/wp/v2/${base}/${id}/revisions`, {
    query: { per_page: 100, orderby: "id", order: "desc", _fields: "id" },
  });
  if (!Array.isArray(revisions)) throw new Error(`${base}/${id}/revisions isn't a list.`);
  return revisions.map((revision) => revision.id);
}

export async function readRevision(request, base, id, revision) {
  const read = await request("GET", `/wp-json/wp/v2/${base}/${id}/revisions/${revision}`, {
    query: { context: "edit", _fields: "id,parent,modified_gmt,content" },
  });
  return {
    id: read.id,
    parent: read.parent,
    modifiedGmt: read.modified_gmt,
    raw: rawContent(read, `revision ${revision}`),
  };
}
