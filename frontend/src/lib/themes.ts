import type { Theme } from "../types";

// Domain-to-theme mapping (substring match on domain)
const DOMAIN_MAP: [string, Theme][] = [
  // ── tech ──────────────────────────────────────────────────────
  ["github.com",              "tech"],
  ["stackoverflow.com",       "tech"],
  ["ycombinator.com",         "tech"],
  ["news.ycombinator",        "tech"],
  ["dev.to",                  "tech"],
  ["verge.com",               "tech"],
  ["wired.com",               "tech"],
  ["arstechnica.com",         "tech"],
  ["techcrunch.com",          "tech"],
  ["producthunt.com",         "tech"],
  ["hackernoon.com",          "tech"],
  ["technologyreview.com",    "tech"],
  ["huggingface.co",          "tech"],
  ["anthropic.com",           "tech"],
  ["openai.com",              "tech"],
  ["deepmind.com",            "tech"],
  ["simonwillison.net",       "tech"],
  ["haskellforall.com",       "tech"],
  ["apenwarr.ca",             "tech"],
  ["vercel.com",              "tech"],
  ["netlify.com",             "tech"],
  ["x.com",                   "tech"],
  ["twitter.com",             "tech"],
  ["medium.com",              "tech"],
  ["substack.com",            "tech"],
  ["om.co",                   "tech"],
  ["paulgraham.com",          "tech"],
  ["stratechery.com",         "tech"],
  ["understandingai.org",     "tech"],
  ["cmo-skills.com",          "tech"],
  ["r2d3.us",                 "tech"],
  ["tableof.me",              "tech"],
  // ── science ───────────────────────────────────────────────────
  ["arxiv.org",               "science"],
  ["nature.com",              "science"],
  ["science.org",             "science"],
  ["pubmed.ncbi",             "science"],
  ["biorxiv.org",             "science"],
  ["medrxiv.org",             "science"],
  ["phys.org",                "science"],
  ["scientificamerican.com",  "science"],
  ["newscientist.com",        "science"],
  ["cell.com",                "science"],
  ["quantamagazine.org",      "science"],
  ["ourworldindata.org",      "science"],
  // ── economics ─────────────────────────────────────────────────
  ["economist.com",           "economics"],
  ["ft.com",                  "economics"],
  ["bloomberg.com",           "economics"],
  ["wsj.com",                 "economics"],
  ["reuters.com",             "economics"],
  ["imf.org",                 "economics"],
  ["worldbank.org",           "economics"],
  ["marginalrevolution.com",  "economics"],
  ["nber.org",                "economics"],
  ["vox.com",                 "economics"],
  ["moneycontrol.com",        "economics"],
  ["zerodha.com",             "economics"],
  ["thedailybrief",           "economics"],
  ["conversationswithtyler.com", "economics"],
  // ── philosophy ────────────────────────────────────────────────
  ["aeon.co",                 "philosophy"],
  ["plato.stanford.edu",      "philosophy"],
  ["iep.utm.edu",             "philosophy"],
  ["psyche.co",               "philosophy"],
  ["philosophynow.org",       "philosophy"],
  ["3quarksdaily.com",        "philosophy"],
  ["edge.org",                "philosophy"],
  ["waitbutwhy.com",          "philosophy"],
  ["theatlantic.com",         "philosophy"],
  ["theguardian.com",         "philosophy"],
  ["newyorker.com",           "philosophy"],
  ["bbc.com",                 "philosophy"],
  ["theargumentmag.com",      "philosophy"],
  ["brainpickings.org",       "philosophy"],
  ["sophielwang.com",         "philosophy"],
  // ── art ───────────────────────────────────────────────────────
  ["artforum.com",            "art"],
  ["pitchfork.com",           "art"],
  ["criterion.com",           "art"],
  ["artsy.net",               "art"],
  ["hyperallergic.com",       "art"],
  ["letterboxd.com",          "art"],
  ["designobserver.com",      "art"],
  ["goodreads.com",           "art"],
  ["webnovel.com",            "art"],
  ["nytimes.com",             "art"],
];

// Title keyword fallback — first match wins
const KEYWORD_MAP: { theme: Theme; words: string[] }[] = [
  { theme: "tech",       words: ["software", "programming", "artificial intelligence", "machine learning", "startup", "open source", "developer", "llm", "gpu", "api", "algorithm", "neural", "robotics", "semiconductor", "code", "coding", "ai model", "dataset", "inference"] },
  { theme: "science",    words: ["research", "study", "biology", "physics", "chemistry", "mathematics", "genome", "quantum", "experiment", "clinical trial", "vaccine", "astrophysics", "neuroscience", "evolution", "climate", "data science"] },
  { theme: "economics",  words: ["economy", "inflation", "gdp", "market", "trade", "monetary policy", "fiscal", "investment", "finance", "central bank", "interest rate", "recession", "tax", "accountant", "financial", "stock", "startup funding", "venture", "geopolitics", "iran", "war", "sanctions"] },
  { theme: "philosophy", words: ["ethics", "consciousness", "meaning of", "epistemology", "metaphysics", "moral", "existential", "phenomenology", "rationality", "free will", "democracy", "politics", "think for yourself", "popper", "machiavelli", "liberty", "ideology"] },
  { theme: "art",        words: ["music", "film", "cinema", "design", "exhibition", "gallery", "novel", "poetry", "album", "architecture", "painting", "sculpture", "literature", "book", "reading", "podcast", "documentary"] },
];

// Deterministic fallback — same domain always maps to the same theme
const FALLBACK_THEMES: Theme[] = ["tech", "philosophy", "economics", "science", "art"];
function _fallback(domain: string): Theme {
  const hash = domain.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return FALLBACK_THEMES[hash % FALLBACK_THEMES.length];
}

export function classifyTheme(domain: string, title: string | null): Theme {
  // 1. Domain substring match (most reliable)
  for (const [pattern, theme] of DOMAIN_MAP) {
    if (domain.includes(pattern)) return theme;
  }
  // 2. Title keyword match
  const lower = (title ?? "").toLowerCase();
  for (const { theme, words } of KEYWORD_MAP) {
    if (words.some((w) => lower.includes(w))) return theme;
  }
  // 3. Deterministic fallback — every link gets a theme
  return _fallback(domain);
}
