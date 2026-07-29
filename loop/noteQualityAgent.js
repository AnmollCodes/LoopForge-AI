// ============================================================================
// NOTE QUALITY AGENT — reviews the drafted outreach note against a small,
// concrete rubric before it's shown to the human, and repairs the common
// failure modes automatically. This is the loop reviewing its own output,
// not just producing it — the "checks its own work" step from the loop
// engineering pattern (perceive -> decide -> act -> CHECK -> gate).
//
// Deliberately rule-based, not another LLM call: the checks below are things
// a template can mechanically get wrong (missing company name, leftover
// "undefined", too short/long), and fixing them with rules is free, instant,
// and fully deterministic — it never introduces a new failure mode of its
// own the way a second generative pass could.
// ============================================================================

function reviewNote(note, job) {
  const issues = [];

  if (!note || note.trim().length < 40) {
    issues.push("note is too short to be usable");
  }
  if (note && note.length > 1200) {
    issues.push("note is unusually long");
  }
  if (note && /undefined|null|\[object Object\]/.test(note)) {
    issues.push("note contains a template artifact");
  }
  if (job.company && note && !note.includes(job.company)) {
    issues.push("note does not mention the company name");
  }
  if (job.url && note && !note.includes(job.url)) {
    issues.push("note is missing the role link");
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Attempts a mechanical repair for the issues reviewNote can find.
 * Returns a possibly-modified note; never throws, never calls out to
 * anything external.
 */
function repairNote(note, job, config) {
  let fixed = note || "";

  if (job.company && !fixed.includes(job.company)) {
    fixed = fixed.replace(
      /at\s+[^\n.]+?\s+and wanted/i,
      `at ${job.company} and wanted`
    );
    if (!fixed.includes(job.company)) {
      fixed += `\n\n(Regarding the ${job.title} role at ${job.company}.)`;
    }
  }
  if (job.url && !fixed.includes(job.url)) {
    fixed += `\n\nRole link: ${job.url}`;
  }
  fixed = fixed.replace(/undefined|null|\[object Object\]/g, "").trim();

  return fixed;
}

module.exports = { reviewNote, repairNote };
