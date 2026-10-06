// A v* tag (what `pnpm push <major|minor|fix>` pushes) is a release.
export function isRelease(params: { trigger: "push" | "tag"; tag?: string }): boolean {
  return params.trigger === "tag" && /^v\d/u.test(params.tag ?? "");
}
