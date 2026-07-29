// ============================================================================
// DREAM JOB WATCHER — the core Loop Engineering agent
//
// This file IS the "loop". It does not wait for a prompt. It:
//   1. Perceives  -> pulls live jobs from free public APIs
//   2. Filters    -> applies your preference rules
//   3. Remembers  -> checks a local memory file so it never repeats a job
//   4. Decides    -> scores each new job against your profile
//   5. Acts       -> drafts a tailored application note (template-based, free)
//   6. Gates      -> NEVER auto-applies. A human always approves before send.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { computeFitScore, buildProfileText } = require("./fitAgent");
const { reviewNote, repairNote } = require("./noteQualityAgent");

const MEMORY_PATH = path.join(__dirname, "..", "data", "memory.json");
const CONFIG_PATH = path.join(__dirname, "..", "data", "config.json");

// ---------------------------------------------------------------------------
// Memory: the thing that makes this a LOOP instead of a one-off script.
// Without memory, every run would re-show you the same 200 jobs forever.
// ---------------------------------------------------------------------------
function loadMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    return { seenIds: [], lastRun: null, runCount: 0 };
  }
  return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    throw new Error(`Could not read data/config.json: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // BUGFIX: config.json is meant to be hand-edited (per the README), so a
    // typo here is a realistic, likely failure mode — not an edge case.
    // A raw JSON.parse stack trace doesn't tell you what to do about it;
    // this does.
    throw new Error(
      `data/config.json contains invalid JSON and could not be parsed ` +
      `(${err.message}). Check for a missing comma, quote, or bracket. ` +
      `Tip: paste the file into a JSON validator to find the exact spot.`
    );
  }
}

// ---------------------------------------------------------------------------
// Data sources — free, public, no API key, no scraping (ToS-clean)
// ---------------------------------------------------------------------------
async function fetchRemoteOK() {
  try {
    const res = await fetch("https://remoteok.com/api", {
      headers: {
        "User-Agent": "DreamJobWatcher/1.0 (personal project)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) throw new Error(`RemoteOK HTTP ${res.status}`);
    const data = await res.json();
    // RemoteOK's first array element is metadata, not a job — skip it.
    return data
      .filter((j) => j && j.id && j.position)
      .map((j) => ({
        id: `remoteok_${j.id}`,
        source: "RemoteOK",
        title: j.position,
        company: j.company || "Unknown",
        location: j.location || "Remote",
        tags: j.tags || [],
        url: j.url || j.apply_url || null,
        description: j.description || "",
        postedAt: j.date || null,
        isRemote: true, // RemoteOK is remote-only by definition
      }));
  } catch (err) {
    console.error("[fetchRemoteOK] failed:", err.message);
    return [];
  }
}

async function fetchArbeitnow() {
  try {
    const res = await fetch("https://www.arbeitnow.com/api/job-board-api");
    if (!res.ok) throw new Error(`Arbeitnow HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((j) => ({
      id: `arbeitnow_${j.slug}`,
      source: "Arbeitnow",
      title: j.title,
      company: j.company_name || "Unknown",
      location: j.location || (j.remote ? "Remote" : "Unknown"),
      tags: j.tags || [],
      url: j.url || null,
      description: j.description || "",
      postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
      // Arbeitnow exposes an explicit boolean — trust it over text matching,
      // since a job can be remote without the word "remote" appearing anywhere.
      isRemote: Boolean(j.remote),
    }));
  } catch (err) {
    console.error("[fetchArbeitnow] failed:", err.message);
    return [];
  }
}

// Optional: any company's public Greenhouse board, zero key needed.
// Add slugs to config.json -> greenhouseCompanies: ["stripe", "notion", ...]
async function fetchGreenhouse(companySlug) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || []).map((j) => ({
      id: `greenhouse_${companySlug}_${j.id}`,
      source: `Greenhouse:${companySlug}`,
      title: j.title,
      company: companySlug,
      location: j.location?.name || "Unknown",
      tags: [],
      url: j.absolute_url || null,
      description: "",
      postedAt: j.updated_at || null,
      isRemote: /remote/i.test(j.location?.name || ""),
    }));
  } catch (err) {
    console.error(`[fetchGreenhouse:${companySlug}] failed:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Filtering + scoring — the "decide" step
// ---------------------------------------------------------------------------
function scoreJob(job, config, profileText) {
  const text = `${job.title} ${job.description} ${(job.tags || []).join(" ")}`.toLowerCase();
  let score = 0;
  const reasons = [];

  for (const kw of config.mustHaveKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score += 3;
      reasons.push(`matches "${kw}"`);
    }
  }
  for (const kw of config.niceToHaveKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score += 1;
      reasons.push(`bonus: "${kw}"`);
    }
  }
  for (const kw of config.excludeKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score -= 100;
      reasons.push(`excluded: contains "${kw}"`);
    }
  }
  if (config.remoteOnly) {
    const looksRemote =
      job.isRemote === true ||
      /remote/i.test(job.location || "") ||
      text.includes("remote");
    if (!looksRemote) {
      score -= 50;
      reasons.push("not remote");
    }
  }

  // Fit Agent: a second, independent signal alongside keyword matching.
  // Scaled modestly (max +6) so it nudges ranking without letting a false
  // positive from text similarity alone override real exclude-keyword hits.
  let fitScore = 0;
  if (profileText) {
    fitScore = computeFitScore(profileText, text);
    const bonus = Math.round(fitScore * 6);
    if (bonus > 0) {
      score += bonus;
      reasons.push(`semantic fit ${(fitScore * 100).toFixed(0)}%`);
    }
  }

  return { score, reasons, fitScore };
}

// ---------------------------------------------------------------------------
// Drafting — template-based, deterministic, free (no LLM call required).
// If you want AI-personalized notes, plug an LLM call in here — clearly
// isolated so the rest of the loop never depends on a paid API.
// ---------------------------------------------------------------------------
function draftNote(job, config) {
  const opener =
    config.candidateName && config.candidateHeadline
      ? `Hi, I'm ${config.candidateName}, ${config.candidateHeadline}.`
      : `Hi, I'm interested in this role.`;

  return [
    `${opener}`,
    ``,
    `I came across the ${job.title} opening at ${job.company} and wanted to reach out directly.`,
    config.candidateHighlight
      ? `${config.candidateHighlight}`
      : `My background lines up closely with what this role needs.`,
    `I'd welcome the chance to talk about how I could contribute to the team.`,
    ``,
    `Role link: ${job.url}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// THE LOOP ITSELF
// ---------------------------------------------------------------------------
async function runLoopOnce() {
  const config = loadConfig();
  const memory = loadMemory();
  const seen = new Set(memory.seenIds);

  console.log(`\n[Loop] Run #${memory.runCount + 1} starting @ ${new Date().toISOString()}`);

  const sourcePromises = [fetchRemoteOK(), fetchArbeitnow()];
  for (const slug of config.greenhouseCompanies || []) {
    sourcePromises.push(fetchGreenhouse(slug));
  }
  const results = await Promise.all(sourcePromises);
  const allJobs = results.flat();

  console.log(`[Loop] Perceived ${allJobs.length} total postings across ${results.length} sources.`);

  const freshJobs = allJobs.filter((j) => !seen.has(j.id));
  console.log(`[Loop] ${freshJobs.length} are new (memory filtered out ${allJobs.length - freshJobs.length} already-seen).`);

  const profileText = buildProfileText(config);
  let repairedCount = 0;

  const matches = [];
  for (const job of freshJobs) {
    const { score, reasons } = scoreJob(job, config, profileText);
    seen.add(job.id); // remember it regardless of score, so we never re-evaluate it
    if (score >= (config.minScore ?? 3)) {
      let note = draftNote(job, config);

      // Note Quality Agent: check the draft, repair mechanically if it fails
      // the rubric, and log when a repair was actually needed.
      const review = reviewNote(note, job);
      if (!review.ok) {
        note = repairNote(note, job, config);
        repairedCount += 1;
      }

      matches.push({
        ...job,
        score,
        reasons,
        draftNote: note,
        status: "pending_review", // <-- the human gatekeeper gate
      });
    }
  }

  if (repairedCount > 0) {
    console.log(`[Loop] Note Quality Agent repaired ${repairedCount} draft(s) before review.`);
  }

  matches.sort((a, b) => b.score - a.score);

  console.log(`[Loop] ${matches.length} passed your filters and are ready for your review.`);

  // Persist memory
  const runTimestamp = new Date().toISOString();
  memory.seenIds = Array.from(seen).slice(-20000); // cap growth
  memory.lastRun = runTimestamp;
  memory.runCount += 1;
  saveMemory(memory);

  // Stamp matches with this run's timestamp so the UI can badge fresh ones.
  const stampedMatches = matches.map((m) => ({ ...m, scannedAt: runTimestamp }));

  // Persist today's matches for the UI to read
  const outPath = path.join(__dirname, "..", "data", "matches.json");
  let existing = [];
  if (fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    } catch (err) {
      // BUGFIX: this used to throw here uncaught — but by this point,
      // memory.json has ALREADY been saved (these jobs are marked "seen").
      // Crashing here would silently and permanently lose this run's
      // matches with no way to recover them (memory would never let them
      // be re-evaluated). Recovering with an empty array preserves this
      // run's results and only loses history from before the corruption.
      console.error(`[Loop] WARNING: existing matches.json was corrupted and could not be read (${err.message}). Starting fresh — this run's matches are still saved, but older history is lost.`);
      existing = [];
    }
  }
  const combined = [...stampedMatches, ...existing].slice(0, 500); // keep last 500
  fs.writeFileSync(outPath, JSON.stringify(combined, null, 2));

  return stampedMatches;
}

module.exports = { runLoopOnce, loadMemory, loadConfig, scoreJob };

// Allow running directly: `node loop/agent.js`
if (require.main === module) {
  runLoopOnce()
    .then((matches) => {
      console.log(`\n[Loop] Done. ${matches.length} new matches written to data/matches.json`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Loop] Fatal error:", err);
      process.exit(1);
    });
}
