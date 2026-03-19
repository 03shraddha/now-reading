import type { Theme } from "../types";

// Domain-to-theme mapping (substring match on domain)
const DOMAIN_MAP: [string, Theme][] = [
  // tech
  ["github.com",         "tech"],
  ["stackoverflow.com",  "tech"],
  ["ycombinator.com",    "tech"],
  ["news.ycombinator",   "tech"],
  ["dev.to",             "tech"],
  ["verge.com",          "tech"],
  ["wired.com",          "tech"],
  ["arstechnica.com",    "tech"],
  ["techcrunch.com",     "tech"],
  ["producthunt.com",    "tech"],
  ["hackernoon.com",     "tech"],
  ["technologyreview.com", "tech"],
  // science
  ["arxiv.org",          "science"],
  ["nature.com",         "science"],
  ["science.org",        "science"],
  ["pubmed.ncbi",        "science"],
  ["biorxiv.org",        "science"],
  ["medrxiv.org",        "science"],
  ["phys.org",           "science"],
  ["scientificamerican.com", "science"],
  ["newscientist.com",   "science"],
  ["cell.com",           "science"],
  // economics
  ["economist.com",      "economics"],
  ["ft.com",             "economics"],
  ["bloomberg.com",      "economics"],
  ["wsj.com",            "economics"],
  ["reuters.com",        "economics"],
  ["imf.org",            "economics"],
  ["worldbank.org",      "economics"],
  ["marginalrevolution.com", "economics"],
  ["nber.org",           "economics"],
  // philosophy
  ["aeon.co",            "philosophy"],
  ["plato.stanford.edu", "philosophy"],
  ["iep.utm.edu",        "philosophy"],
  ["psyche.co",          "philosophy"],
  ["philosophynow.org",  "philosophy"],
  ["3quarksdaily.com",   "philosophy"],
  // art
  ["artforum.com",       "art"],
  ["pitchfork.com",      "art"],
  ["criterion.com",      "art"],
  ["artsy.net",          "art"],
  ["hyperallergic.com",  "art"],
  ["theguardian.com/music", "art"],
  ["letterboxd.com",     "art"],
  ["designobserver.com", "art"],
];

// Title keyword fallback — first match wins
const KEYWORD_MAP: { theme: Theme; words: string[] }[] = [
  { theme: "tech",       words: ["software", "programming", "artificial intelligence", "machine learning", "startup", "open source", "developer", "llm", "gpu", "api", "algorithm", "neural", "robotics", "semiconductor"] },
  { theme: "science",    words: ["research", "study", "biology", "physics", "chemistry", "mathematics", "genome", "quantum", "experiment", "clinical trial", "vaccine", "astrophysics", "neuroscience"] },
  { theme: "economics",  words: ["economy", "inflation", "gdp", "market", "trade", "monetary policy", "fiscal", "investment", "finance", "central bank", "interest rate", "recession"] },
  { theme: "philosophy", words: ["ethics", "consciousness", "meaning of", "epistemology", "metaphysics", "moral philosophy", "existential", "phenomenology", "rationality", "free will"] },
  { theme: "art",        words: ["music", "film", "cinema", "design", "exhibition", "gallery", "novel", "poetry", "album", "architecture", "painting", "sculpture", "literature"] },
];

export function classifyTheme(domain: string, title: string | null): Theme | null {
  // 1. Domain substring match (most reliable)
  for (const [pattern, theme] of DOMAIN_MAP) {
    if (domain.includes(pattern)) return theme;
  }
  // 2. Title keyword match (fallback)
  const lower = (title ?? "").toLowerCase();
  for (const { theme, words } of KEYWORD_MAP) {
    if (words.some((w) => lower.includes(w))) return theme;
  }
  return null;
}
