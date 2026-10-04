// The Frontend's own words, for the pages WordPress doesn't write: the empty
// front page, the 404, "Temporarily unavailable" and local development's
// placeholder, in each page's language on a multilingual Site. Add a language
// by its code (the locale's first part); any other language reads English,
// and so does a monolingual Site, as it always has.
import { multilingual, type SiteLanguage } from "./site-language";

const en = {
  /** The language switcher's label, for screen readers. */
  languages: "Languages",
  frontPageMissing: {
    heading: "The front page is almost ready.",
    text: "Set a page as the front page in WordPress (Settings → Reading) and publish its blocks to show them here.",
  },
  frontPagePlaceholder: {
    heading: "Content is on its way.",
    text: "The front page appears here once the CMS is reachable.",
  },
  frontPageUnavailable: {
    heading: "Temporarily unavailable.",
    text: "The front page can't be loaded right now. Please try again in a few minutes.",
  },
  pageMissing: {
    title: "Page not found",
    heading: "Nothing here.",
    text: "This page doesn't exist in WordPress yet.",
  },
  pageUnavailable: {
    title: "Temporarily unavailable",
    heading: "Temporarily unavailable.",
    text: "This page can't be loaded right now. Please try again in a few minutes.",
  },
  backHome: "Back to the front page",
};

export type Copy = typeof en;

const copies: Record<string, Copy> = {
  en,
  pt: {
    languages: "Idiomas",
    frontPageMissing: {
      heading: "A página inicial está quase pronta.",
      text: "Defina uma página como página inicial no WordPress (Definições → Leitura) e publique os seus blocos para os mostrar aqui.",
    },
    frontPagePlaceholder: {
      heading: "O conteúdo está a caminho.",
      text: "A página inicial aparece aqui assim que o CMS estiver acessível.",
    },
    frontPageUnavailable: {
      heading: "Temporariamente indisponível.",
      text: "Não é possível carregar a página inicial neste momento. Tente novamente dentro de alguns minutos.",
    },
    pageMissing: {
      title: "Página não encontrada",
      heading: "Nada aqui.",
      text: "Esta página ainda não existe no WordPress.",
    },
    pageUnavailable: {
      title: "Temporariamente indisponível",
      heading: "Temporariamente indisponível.",
      text: "Não é possível carregar esta página neste momento. Tente novamente dentro de alguns minutos.",
    },
    backHome: "Voltar à página inicial",
  },
};

/** The words for a page in this language: its own on a multilingual Site, or English. */
export function copyFor(language: SiteLanguage): Copy {
  if (!multilingual) return en;
  return copies[language.locale.split("_")[0] ?? ""] ?? en;
}
