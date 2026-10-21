/** Site-owned public document facts; private content must never be passed here. */
export interface DocumentFacts {
  title: string;
  description?: string;
  route: string;
  status: number;
  state: "public" | "private" | "preview" | "withdrawn" | "error" | "redirect";
  language: { lang: string; locale: string; dir: "ltr" | "rtl" };
  translations?: { language: DocumentFacts["language"]; route: string; translation: boolean }[];
}
