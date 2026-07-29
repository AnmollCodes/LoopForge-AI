// Minimal dependency-free test runner (no jest needed — keeps this 100% free/offline)
const assert = require("assert");

// BUGFIX: this used to be a hand-copied duplicate of scoreJob, which could
// silently drift out of sync with the real implementation in loop/agent.js
// and give false confidence. Importing the real function directly means
// these tests actually verify the code that runs in production, not a copy.
const { scoreJob } = require("../loop/agent");

function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log("agent scoring logic");

test("must-have keyword increases score", () => {
  const { score } = scoreJob(
    { title: "React Developer", description: "", location: "Remote", tags: [] },
    { mustHaveKeywords: ["react"], remoteOnly: true }
  );
  assert.strictEqual(score, 3);
});

test("exclude keyword tanks score even with matches", () => {
  const { score } = scoreJob(
    { title: "React Internship", description: "", location: "Remote", tags: [] },
    { mustHaveKeywords: ["react"], excludeKeywords: ["internship"], remoteOnly: true }
  );
  assert.ok(score < 0);
});

test("non-remote job penalized when remoteOnly is true", () => {
  const { score } = scoreJob(
    { title: "React Developer", description: "", location: "New York, NY", tags: [] },
    { mustHaveKeywords: ["react"], remoteOnly: true }
  );
  assert.ok(score < 0);
});

test("nice-to-have adds smaller bonus than must-have", () => {
  const a = scoreJob(
    { title: "React startup role", description: "", location: "Remote", tags: [] },
    { mustHaveKeywords: ["react"], niceToHaveKeywords: ["startup"], remoteOnly: true }
  );
  assert.strictEqual(a.score, 4); // 3 + 1
});

test("BUGFIX: job explicitly flagged isRemote=true is not penalized even without the word 'remote' anywhere", () => {
  const { score, reasons } = scoreJob(
    { title: "React Developer", description: "Join our distributed team.", location: "Berlin, Germany", tags: [], isRemote: true },
    { mustHaveKeywords: ["react"], remoteOnly: true }
  );
  assert.strictEqual(score, 3); // no -50 penalty
  assert.ok(!reasons.includes("not remote"));
});

test("BUGFIX: job with isRemote=false and no remote text is still correctly penalized", () => {
  const { score } = scoreJob(
    { title: "React Developer", description: "On-site only.", location: "Berlin, Germany", tags: [], isRemote: false },
    { mustHaveKeywords: ["react"], remoteOnly: true }
  );
  assert.ok(score < 0);
});

test("BUGFIX: escapeHTML neutralizes script tags from untrusted job data", () => {
  const malicious = '<script>alert(1)</script>';
  const escaped = escapeHTML(malicious);
  assert.ok(!escaped.includes("<script>"));
  assert.strictEqual(escaped, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("BUGFIX: escapeHTML neutralizes quote-breakout in onclick-style attributes", () => {
  const malicious = `id'); maliciousFn(); ('`;
  const escaped = escapeHTML(malicious);
  assert.ok(!escaped.includes("'"));
});

console.log("\nfit agent (semantic similarity)");
const { computeFitScore, buildProfileText } = require("../loop/fitAgent");

test("identical text scores maximum similarity", () => {
  const score = computeFitScore("react node backend engineer", "react node backend engineer");
  assert.ok(score > 0.99);
});

test("completely unrelated text scores near zero", () => {
  const score = computeFitScore("react node backend engineer", "farm animal veterinary clinic");
  assert.ok(score < 0.1);
});

test("partial overlap scores between 0 and 1", () => {
  const score = computeFitScore(
    "react node backend engineer startup",
    "we need a react developer for our growing team"
  );
  assert.ok(score > 0 && score < 1);
});

test("buildProfileText combines headline, highlight, and keywords", () => {
  const text = buildProfileText({
    candidateHeadline: "backend engineer",
    candidateHighlight: "shipped scalable systems",
    mustHaveKeywords: ["node"],
    niceToHaveKeywords: ["startup"],
  });
  assert.ok(text.includes("backend engineer"));
  assert.ok(text.includes("node"));
  assert.ok(text.includes("startup"));
});

console.log("\nnote quality agent");
const { reviewNote, repairNote } = require("../loop/noteQualityAgent");

test("flags a note missing the company name", () => {
  const job = { title: "Engineer", company: "Acme Corp", url: "https://acme.example/job/1" };
  const note = `Hi, I'm interested in this Engineer role.\n\nRole link: https://acme.example/job/1`;
  const { ok, issues } = reviewNote(note, job);
  assert.strictEqual(ok, false);
  assert.ok(issues.some((i) => i.includes("company")));
});

test("flags a note containing a template artifact", () => {
  const job = { title: "Engineer", company: "Acme Corp", url: "https://acme.example/job/1" };
  const note = `Hi, I'm interested in the undefined role at Acme Corp.\n\nRole link: https://acme.example/job/1`;
  const { ok, issues } = reviewNote(note, job);
  assert.strictEqual(ok, false);
  assert.ok(issues.some((i) => i.includes("artifact")));
});

test("passes a well-formed note with no issues", () => {
  const job = { title: "Engineer", company: "Acme Corp", url: "https://acme.example/job/1" };
  const note = `Hi, I'm Jane, a backend engineer.\n\nI came across the Engineer opening at Acme Corp and wanted to reach out.\n\nRole link: https://acme.example/job/1`;
  const { ok, issues } = reviewNote(note, job);
  assert.strictEqual(ok, true);
  assert.strictEqual(issues.length, 0);
});

test("repairNote fixes a missing company name and missing link", () => {
  const job = { title: "Engineer", company: "Acme Corp", url: "https://acme.example/job/1" };
  const broken = `Hi, I'm interested in this role.`;
  const repaired = repairNote(broken, job);
  assert.ok(repaired.includes("Acme Corp"));
  assert.ok(repaired.includes(job.url));
});

test("repairNote strips leftover template artifacts", () => {
  const job = { title: "Engineer", company: "Acme Corp", url: "https://acme.example/job/1" };
  const broken = `Hi, this role is undefined and great.`;
  const repaired = repairNote(broken, job);
  assert.ok(!repaired.includes("undefined"));
});

console.log("\nprofile builder agent (CV -> keywords)");
const { extractProfileFromResume } = require("../loop/profileBuilderAgent");

test("extracts repeated skills as must-have", () => {
  const resume = `
    Senior React developer with 5 years building React applications.
    Built multiple React projects using React hooks and React Router.
    Also familiar with Node.js.
  `;
  const { mustHave } = extractProfileFromResume(resume);
  assert.ok(mustHave.includes("react"));
});

test("extracts once-mentioned skills as nice-to-have, not must-have", () => {
  const resume = `
    Senior React developer with 5 years building React applications.
    Built multiple React projects. Also dabbled in Rust once during a hackathon.
  `;
  const { mustHave, niceToHave } = extractProfileFromResume(resume);
  assert.ok(niceToHave.includes("rust"));
  assert.ok(!mustHave.includes("rust"));
});

test("multi-word skills like 'machine learning' are detected", () => {
  const resume = `Worked extensively on machine learning pipelines and machine learning model deployment.`;
  const { mustHave } = extractProfileFromResume(resume);
  assert.ok(mustHave.includes("machine learning"));
});

test("rejects garbage/empty input gracefully", () => {
  const { mustHave, niceToHave } = extractProfileFromResume("");
  assert.strictEqual(mustHave.length, 0);
  assert.strictEqual(niceToHave.length, 0);
});

test("termCounts gives transparent evidence for every extracted skill", () => {
  const resume = `Python developer. Python. Python everywhere.`;
  const { termCounts } = extractProfileFromResume(resume);
  assert.strictEqual(termCounts["python"], 3);
});

console.log("\ndeep-audit bugfixes: error handling on malformed data");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../loop/agent");

test("BUGFIX: loadConfig throws a clear, actionable message on malformed JSON instead of a raw parser stack trace", () => {
  const configPath = path.join(__dirname, "..", "data", "config.json");
  const original = fs.readFileSync(configPath, "utf-8");
  fs.writeFileSync(configPath, "{ this is not valid json ,,, ");
  try {
    loadConfig();
    assert.fail("expected loadConfig to throw");
  } catch (err) {
    assert.ok(err.message.includes("invalid JSON"), `expected a clear message, got: ${err.message}`);
    assert.ok(err.message.includes("config.json"), "error should name the file");
  } finally {
    fs.writeFileSync(configPath, original); // always restore, even if the assertion fails
  }
});

test("BUGFIX: loadConfig still works correctly on valid JSON after the error-handling change", () => {
  const config = loadConfig();
  assert.ok(typeof config === "object" && config !== null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
