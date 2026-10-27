export function validPreviewUrl(value: unknown, audience?: boolean): boolean;
export type PreviewBindings<T> = {
  GQ_PREVIEW_CMS_URL: string;
  GQ_PREVIEW_AUDIENCE: string;
  GQ_PREVIEW_CMS_USERNAME: T;
  GQ_PREVIEW_CMS_APPLICATION_PASSWORD: T;
  GQ_PREVIEW_ACCESS_CLIENT_ID?: T;
  GQ_PREVIEW_ACCESS_CLIENT_SECRET?: T;
};
export function previewBindings<T>(
  ops: { preview?: { cmsUrl: string; audience: string } },
  env: Record<string, string | undefined>,
  redact: (value: string) => T,
): PreviewBindings<T> | Record<string, never>;
