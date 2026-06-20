const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { initDb, getLatestSnapshot, getOrCreateProject } = require("../src/main/db");
const { buildReview } = require("../src/main/reviewer");
const { getProxyUrl, makeFetchOptions, normalizeReport } = require("../src/main/llm");

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function allText(value) {
  return JSON.stringify(value).toLowerCase();
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-accelerator-contract-"));
  const fixtureSource = path.join(__dirname, "../test-fixtures/sample-app");
  const projectPath = path.join(tempRoot, "sample-app");
  const dbPath = path.join(tempRoot, "state.sqlite");
  copyDir(fixtureSource, projectPath);
  initDb(dbPath);

  let summarizeCalls = 0;
  const engines = {
    summarizeFile: async (_settings, file) => {
      summarizeCalls += 1;
      return {
        purpose: `Explains ${file.path}`,
        responsibilities: file.purposeHints,
        keySymbols: file.skeleton.symbols.map((symbol) => symbol.name),
        evidenceRefs: [
          {
            path: file.path,
            startLine: file.skeleton.symbols[0]?.line || 1,
            endLine: file.skeleton.symbols[0]?.line || 1,
            label: file.path
          }
        ]
      };
    },
    generateReviewReport: async (_settings, scan, previousSnapshot, changes) =>
      normalizeReport(
        {
          structureAreas: [
            {
              name: "User access and data persistence",
              purpose: "Creates and verifies user sessions in auth.js, then saves user records through save_user in db.py.",
              livesIn: ["src/auth.js", "src/db.py"],
              keyFunctions: [
                {
                  name: "createSession",
                  description: "Returns a session object with userId and createdAt values from the supplied user.",
                  path: "src/auth.js",
                  line: 1,
                  evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 5, label: "createSession" }]
                },
                {
                  name: "save_user",
                  description: "Returns a record pairing the supplied database connection with the user to persist.",
                  path: "src/db.py",
                  line: 5,
                  evidenceRefs: [{ path: "src/db.py", startLine: 5, endLine: 6, label: "save_user" }]
                }
              ],
              evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 8, label: "session helpers" }]
            },
            {
              name: "Welcome email delivery",
              purpose: "Builds a welcome email string from the user email and pairs it with session verification before background delivery.",
              livesIn: ["jobs/email.js", "src/auth.js"],
              keyFunctions: [
                {
                  name: "sendWelcomeEmail",
                  description: "Returns a welcome message string that includes the supplied user's email address.",
                  path: "jobs/email.js",
                  line: 1,
                  evidenceRefs: [{ path: "jobs/email.js", startLine: 1, endLine: 3, label: "sendWelcomeEmail" }]
                },
                {
                  name: "verifySession",
                  description: "Returns true when the supplied session exists and carries a userId.",
                  path: "src/auth.js",
                  line: 7,
                  evidenceRefs: [{ path: "src/auth.js", startLine: 7, endLine: 9, label: "verifySession" }]
                }
              ],
              evidenceRefs: [{ path: "jobs/email.js", startLine: 1, endLine: 3, label: "email job" }]
            }
          ],
          changeClusters: previousSnapshot
            ? [
                {
                  area: "Auth",
                  summary: "Extended Auth with a session teardown helper.",
                  files: changes.map((change) => change.path),
                  evidenceRefs: [{ path: "src/auth.js", startLine: 12, endLine: 14, label: "destroySession" }]
                }
              ]
            : [],
          focusItems: [
            {
              label: "src/auth.js",
              why: "It defines the visible session entry points reviewers will likely edit first.",
              evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 8, label: "session entry points" }]
            }
          ],
          notices: []
        },
        scan.files,
        { isFirstReview: !previousSnapshot }
      )
  };

  const first = await buildReview(dbPath, projectPath, {}, () => {}, engines);
  assert.equal(first.report.isFirstReview, true);
  assert.equal(first.scannedFileCount, 3);
  assert.equal(first.newSummaryCount, 3);
  assert(first.report.structureAreas.length >= 2);
  assert(first.report.structureAreas.every((area) => area.evidenceRefs.length > 0));
  assert(first.report.structureAreas.every((area) => area.keyFunctions.length >= 2));
  assert(first.report.structureAreas.every((area) => area.keyFunctions.every((fn) => fn.description && fn.evidenceRefs.length > 0)));

  fs.appendFileSync(path.join(projectPath, "src/auth.js"), "\nexport function destroySession() {\n  return null;\n}\n");
  const second = await buildReview(dbPath, projectPath, {}, () => {}, engines);
  assert.equal(second.report.isFirstReview, false);
  assert.equal(second.changedFileCount, 1);
  assert.equal(second.newSummaryCount, 1);
  assert.equal(second.cachedSummaryCount, 2);
  assert(second.report.changeClusters[0].summary.includes("Extended Auth"));
  assert(second.report.focusItems.length >= 1);

  const project = getOrCreateProject(dbPath, projectPath);
  const latest = getLatestSnapshot(dbPath, project.id);
  assert(latest.files.some((file) => file.path === "src/auth.js"));
  assert.equal(summarizeCalls, 4);

  const scrubbed = normalizeReport(
    {
      structureAreas: [
        {
          name: "Auth",
          purpose: "This is buggy and insecure.",
          livesIn: ["src/auth.js"],
          evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 1 }]
        }
      ],
      changeClusters: [
        {
          area: "Auth",
          summary: "This will break login.",
          files: ["src/auth.js"],
          evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 1 }]
        }
      ],
      focusItems: [
        {
          label: "src/auth.js",
          why: "It has a security issue.",
          evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 1 }]
        }
      ],
      notices: ["This code is unsafe."]
    },
    [
      {
        path: "src/auth.js",
        skeleton: { parser: "fallback" }
      }
    ],
    { isFirstReview: false }
  );

  assert(!allText(scrubbed).includes("buggy"));
  assert(!allText(scrubbed).includes("insecure"));
  assert(!allText(scrubbed).includes("will break"));
  assert(!allText(scrubbed).includes("security issue"));
  assert(!allText(scrubbed).includes("unsafe"));
  assert(allText(scrubbed).includes("comprehension report"));
  assert.equal(scrubbed.structureAreas.length, 0);

  const genericStructure = normalizeReport(
    {
      structureAreas: [
        {
          name: "Fallback",
          purpose: "Understand this area from the linked code.",
          livesIn: ["src/auth.js"],
          evidenceRefs: [{ path: "src/auth.js", startLine: 1, endLine: 1 }]
        },
        {
          name: "Package metadata",
          purpose: "Defines package metadata for installing and running the app.",
          livesIn: ["package.json"],
          evidenceRefs: [{ path: "package.json", startLine: 1, endLine: 1 }]
        }
      ]
    },
    [
      { path: "src/auth.js", lineCount: 12, skeleton: { parser: "tree-sitter", symbols: [] } },
      { path: "package.json", lineCount: 12, skeleton: { parser: "tree-sitter", symbols: [] } }
    ],
    { isFirstReview: false }
  );
  assert.equal(genericStructure.structureAreas.length, 0);

  assert.throws(() => makeFetchOptions({ proxyUrl: "socks5://127.0.0.1:7890" }), /Proxy URL must start/);
  assert(makeFetchOptions({ proxyUrl: "" }));
  assert(makeFetchOptions({ proxyUrl: "http://127.0.0.1:7890" }).dispatcher);
  assert.equal(getProxyUrl({ proxyUrl: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");

  console.log("Contract test passed: grounded reports, snapshot diffing, caching, and verdict guardrails work.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
