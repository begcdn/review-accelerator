const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { initDb, getOrCreateProject, getLatestSnapshot, saveSnapshotAndReview } = require("../src/main/db");
const { diffSnapshots, scanProject } = require("../src/main/scanner");

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-accelerator-"));
  const fixtureSource = path.join(__dirname, "../test-fixtures/sample-app");
  const projectPath = path.join(tempRoot, "sample-app");
  const dbPath = path.join(tempRoot, "state.sqlite");

  copyDir(fixtureSource, projectPath);
  initDb(dbPath);

  const firstScan = await scanProject(projectPath);
  assert.equal(firstScan.files.length, 3);
  assert(firstScan.files.some((file) => file.path === "src/auth.js"));
  const authFile = firstScan.files.find((file) => file.path === "src/auth.js");
  assert(authFile.skeleton.symbols.length >= 2);
  assert.equal(authFile.skeleton.parser, "tree-sitter");

  const project = getOrCreateProject(dbPath, projectPath);
  saveSnapshotAndReview(dbPath, project.id, firstScan, {
    structureAreas: [],
    changeClusters: [],
    focusItems: [],
    notices: []
  });

  const latest = getLatestSnapshot(dbPath, project.id);
  assert(latest);
  assert.equal(latest.files.length, 3);

  fs.appendFileSync(path.join(projectPath, "src/auth.js"), "\nexport function destroySession() {\n  return null;\n}\n");
  fs.writeFileSync(path.join(projectPath, "src/config.js"), "export const emailEnabled = true;\n");

  const secondScan = await scanProject(projectPath);
  const changes = diffSnapshots(latest.files, secondScan.files);
  assert(changes.some((change) => change.status === "modified" && change.path === "src/auth.js"));
  assert(changes.some((change) => change.status === "added" && change.path === "src/config.js"));

  console.log("Smoke test passed: tree-sitter scanning, snapshot storage, and diffing work.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
