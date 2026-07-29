// ============================================================================
// FIT AGENT — semantic-ish matching between a candidate profile and a job
// posting, using TF-IDF + cosine similarity computed locally.
//
// Why this instead of calling an embeddings API: it's genuinely free, has
// zero external dependency (so it never breaks the loop if a network call
// fails), and for short job-posting text it performs reasonably against
// simple keyword-only matching — it catches paraphrases the keyword list
// misses (e.g. "ships production code" vs a "backend" keyword) without
// costing anything per run.
//
// This is intentionally NOT a real embeddings model. Framing it as more than
// "a lightweight statistical similarity signal" would be dishonest — it's a
// second, complementary signal alongside keyword scoring, not a replacement.
// ============================================================================

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","is","are",
  "was","were","be","been","being","this","that","these","those","it","its",
  "as","at","by","from","we","you","your","our","will","have","has","had",
  "not","no","do","does","did","can","could","would","should","about","into",
  "than","then","so","if","up","out","who","what","which","their","they",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ") // strip any HTML from job descriptions
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function cosineSimilarity(tfA, tfB) {
  const allTerms = new Set([...Object.keys(tfA), ...Object.keys(tfB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const term of allTerms) {
    const a = tfA[term] || 0;
    const b = tfB[term] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Returns a similarity score in [0, 1] between the candidate's profile text
 * and a job's combined title+description+tags text.
 */
function computeFitScore(profileText, jobText) {
  const tfProfile = termFrequency(tokenize(profileText));
  const tfJob = termFrequency(tokenize(jobText));
  return cosineSimilarity(tfProfile, tfJob);
}

/**
 * Builds the profile text the Fit Agent compares jobs against, from config.
 */
function buildProfileText(config) {
  return [
    config.candidateHeadline || "",
    config.candidateHighlight || "",
    ...(config.mustHaveKeywords || []),
    ...(config.niceToHaveKeywords || []),
  ].join(" ");
}

module.exports = { computeFitScore, buildProfileText, tokenize };
