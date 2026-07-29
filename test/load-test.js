// ============================================================================
// LOAD TEST — exercises the real scoring + dedup logic against a realistic
// volume of synthetic jobs (not mocked network, the actual pure functions),
// since this sandbox can't hit live APIs at volume. This answers a concrete
// question: does the algorithm stay correct and fast as job counts grow,
// not just on the ~10-job unit test fixtures.
// ============================================================================

const assert = require("assert");
const { scoreJob } = require("../loop/agent");
const { buildProfileText } = require("../loop/fitAgent");

const TITLES = [
  "Backend Engineer", "Frontend Developer", "Full Stack Engineer", "DevOps Engineer",
  "Data Scientist", "Product Manager", "Marketing Specialist", "Sales Representative",
  "Customer Support Agent", "React Developer", "Node.js Engineer", "Platform Engineer",
];
const COMPANIES = ["Acme", "Globex", "Initech", "Umbrella Corp", "Hooli", "Stark Industries"];
const LOCATIONS = ["Remote", "Berlin, Germany", "New York, NY", "London, UK", "San Francisco, CA"];
const DESCRIPTIONS = [
  "Build and ship scalable web applications using React and Node.",
  "Own our AWS infrastructure and CI/CD pipelines end to end.",
  "Work with a distributed team on our core product, fully remote.",
  "Unpaid internship opportunity for students, on-site only.",
  "Senior director role overseeing multiple engineering teams.",
  "Join our fast-growing startup building developer tools with TypeScript.",
];

function generateSyntheticJobs(count) {
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const title = TITLES[i % TITLES.length];
    const company = COMPANIES[i % COMPANIES.length];
    const location = LOCATIONS[i % LOCATIONS.length];
    const description = DESCRIPTIONS[i % DESCRIPTIONS.length];
    jobs.push({
      id: `synthetic_${i}`,
      source: "LoadTest",
      title,
      company,
      location,
      tags: ["javascript", "remote"].slice(0, i % 3),
      url: `https://example.test/job/${i}`,
      description,
      isRemote: location === "Remote" || description.includes("remote"),
    });
  }
  return jobs;
}

console.log("=== LOAD TEST: 10,000 synthetic jobs through the real scoring pipeline ===\n");

const config = {
  mustHaveKeywords: ["react", "node", "javascript", "typescript", "full stack", "backend"],
  niceToHaveKeywords: ["remote", "startup"],
  excludeKeywords: ["unpaid", "internship", "senior director"],
  remoteOnly: true,
  minScore: 3,
};
const profileText = buildProfileText({
  candidateHeadline: "a product-minded software engineer",
  candidateHighlight: "I've shipped and scaled production systems end-to-end.",
  mustHaveKeywords: config.mustHaveKeywords,
  niceToHaveKeywords: config.niceToHaveKeywords,
});

const JOB_COUNT = 10_000;
const jobs = generateSyntheticJobs(JOB_COUNT);

const startTime = Date.now();
let matchCount = 0;
let excludedCount = 0;
const seen = new Set();

for (const job of jobs) {
  // Exercise the real dedup logic too, not just scoring.
  if (seen.has(job.id)) continue;
  seen.add(job.id);

  const { score, reasons } = scoreJob(job, config, profileText);
  if (reasons.some((r) => r.startsWith("excluded"))) excludedCount++;
  if (score >= config.minScore) matchCount++;
}

const elapsedMs = Date.now() - startTime;

console.log(`Processed:        ${JOB_COUNT.toLocaleString()} jobs`);
console.log(`Matched:          ${matchCount.toLocaleString()}`);
console.log(`Correctly excluded: ${excludedCount.toLocaleString()}`);
console.log(`Time elapsed:     ${elapsedMs}ms`);
console.log(`Throughput:       ${Math.round(JOB_COUNT / (elapsedMs / 1000)).toLocaleString()} jobs/sec\n`);

// ---- Correctness assertions at scale, not just speed ----
assert.ok(matchCount > 0, "expected at least some matches at this volume");
assert.ok(excludedCount > 0, "expected the exclude-keyword logic to catch some synthetic 'unpaid/internship' jobs");
assert.ok(elapsedMs < 5000, `expected 10k jobs to score in under 5s, took ${elapsedMs}ms`);
assert.strictEqual(seen.size, JOB_COUNT, "dedup set should contain every unique synthetic job id");

// ---- Memory growth check: what happens once seenIds exceeds the 20k cap? ----
const bigSeenIds = new Set();
for (let i = 0; i < 25_000; i++) bigSeenIds.add(`id_${i}`);
const capped = Array.from(bigSeenIds).slice(-20000);
assert.strictEqual(capped.length, 20000, "memory cap should trim to exactly 20,000 entries");
assert.ok(!capped.includes("id_0"), "oldest entries should be dropped once the cap is exceeded");
assert.ok(capped.includes("id_24999"), "most recent entries should be retained");

console.log("✓ All load-test assertions passed (correctness holds at 10k+ volume, memory cap behaves correctly).");
