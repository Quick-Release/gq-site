export function validPreviewUrl(value: unknown, audience?: boolean): boolean;
export function previewBindings<T>(
  ops: { preview?: { cmsUrl: string; audience: string } },
  env: Record<string, string | undefined>,
  redact: (value: string) => T,
): Record<string, string | T>;
