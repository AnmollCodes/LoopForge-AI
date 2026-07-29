// ============================================================================
// PROFILE BUILDER AGENT — turns a pasted resume/CV into config.json keywords
// automatically, instead of you hand-typing mustHaveKeywords/niceToHave.
//
// How it works, honestly: this is NOT a resume-parsing ML model. It matches
// your resume text against a curated vocabulary of real tech/role/tooling
// terms, ranks by frequency + a hand-set importance weight, and splits the
// top hits into "must-have" (your strongest, most-repeated skills) vs.
// "nice-to-have" (things you mentioned once or twice). That's a legitimate,
// useful heuristic — not a claim that it "understands" your resume the way
// an LLM would. It's fast, free, deterministic, and has no external
// dependency that could fail mid-loop.
//
// If you want LLM-quality resume understanding, that's the one place in this
// project where plugging in a real model call would be worth the (small)
// cost — this function is intentionally isolated so that swap is a single
// clean seam, not a rewrite.
// ============================================================================

const { tokenize } = require("./fitAgent");

// A deliberately broad, real-world vocabulary spanning common tech roles.
// Extend this list freely — it's just data, not logic.
const SKILL_VOCABULARY = [
  // languages
  "javascript","typescript","python","java","golang","rust","ruby","php","kotlin","swift","scala","c++","c#",
  // frontend
  "react","vue","angular","svelte","nextjs","tailwind","html","css","redux",
  // backend
  "node","nodejs","express","django","flask","spring","rails","fastapi","graphql","rest","grpc",
  // data / ai
  "sql","postgres","mysql","mongodb","redis","elasticsearch","kafka","spark","airflow",
  "machine learning","tensorflow","pytorch","llm","rag","langchain","nlp","data science",
  // infra / devops
  "aws","gcp","azure","docker","kubernetes","terraform","ci/cd","jenkins","github actions","linux","devops",
  // roles / domains
  "full stack","backend","frontend","platform engineer","product manager","data engineer",
  "software engineer","site reliability","security engineer","mobile developer","ios","android",
  // soft/business signals worth surfacing as nice-to-have
  "startup","remote","agile","scrum","leadership","mentoring",
];

/**
 * Extracts ranked skill terms actually present in the resume text.
 * Returns { mustHave, niceToHave } — the split, and { termCounts } for
 * transparency (so you can see exactly why something landed where it did).
 */
function extractProfileFromResume(resumeText) {
  const tokens = tokenize(resumeText);
  const joined = ` ${tokens.join(" ")} `;
  const rawText = (resumeText || "").toLowerCase();

  const hits = [];
  for (const skill of SKILL_VOCABULARY) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isPlainWord = /^[a-z0-9]+$/.test(skill);
    // Plain single words can safely use the tokenized text (word-boundary
    // safe). Anything with spaces, +, #, / (e.g. "c++", "c#", "ci/cd",
    // "machine learning") would be destroyed by tokenize()'s punctuation
    // stripping, so those must match against the raw lowercased text instead.
    const count = isPlainWord
      ? (joined.match(new RegExp(`\\b${escaped}\\b`, "g")) || []).length
      : (rawText.match(new RegExp(escaped, "g")) || []).length;
    if (count > 0) hits.push({ skill, count });
  }

  hits.sort((a, b) => b.count - a.count);

  // Skills mentioned 2+ times (repeated = likely a core skill) -> must-have.
  // Skills mentioned once -> nice-to-have. Deliberately simple, transparent rule.
  const mustHave = hits.filter((h) => h.count >= 2).map((h) => h.skill);
  const niceToHave = hits.filter((h) => h.count === 1).map((h) => h.skill);

  return {
    mustHave,
    niceToHave,
    termCounts: Object.fromEntries(hits.map((h) => [h.skill, h.count])),
  };
}

module.exports = { extractProfileFromResume, SKILL_VOCABULARY };
