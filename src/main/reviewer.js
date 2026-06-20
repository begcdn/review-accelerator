const {
  getCachedSummary,
  getLatestSnapshot,
  getOrCreateProject,
  saveCachedSummary,
  saveSnapshotAndReview
} = require("./db");
const { diffSnapshots, scanProject } = require("./scanner");
const { generateReviewReport, summarizeFile } = require("./llm");

async function buildReview(dbPath, projectPath, settings, progress = () => {}, engines = {}) {
  const fileSummarizer = engines.summarizeFile || summarizeFile;
  const reportGenerator = engines.generateReviewReport || generateReviewReport;
  progress({ phase: "scan", message: "Scanning project files" });
  const project = getOrCreateProject(dbPath, projectPath);
  const previousSnapshot = getLatestSnapshot(dbPath, project.id);
  const scan = await scanProject(projectPath);
  const changes = diffSnapshots(previousSnapshot?.files || [], scan.files);

  progress({ phase: "summaries", message: "Updating changed file summaries" });
  const fileSummaries = {};
  let summarized = 0;
  for (const file of scan.files) {
    const cached = getCachedSummary(dbPath, scan.projectPath, file);
    if (cached) {
      fileSummaries[file.path] = cached;
      continue;
    }

    const summary = await fileSummarizer(settings, file);
    saveCachedSummary(dbPath, scan.projectPath, file, summary);
    fileSummaries[file.path] = summary;
    summarized += 1;
    progress({
      phase: "summaries",
      message: `Summarized ${summarized} changed file${summarized === 1 ? "" : "s"}`
    });
  }

  progress({ phase: "report", message: "Grouping changes by meaning" });
  const report = await reportGenerator(settings, scan, previousSnapshot, changes, fileSummaries);
  const saved = saveSnapshotAndReview(dbPath, project.id, scan, report);

  return {
    project: {
      id: project.id,
      path: scan.projectPath,
      name: project.name
    },
    snapshotId: saved.snapshotId,
    previousSnapshotId: previousSnapshot?.id || null,
    changedFileCount: changes.length,
    scannedFileCount: scan.files.length,
    cachedSummaryCount: scan.files.length - summarized,
    newSummaryCount: summarized,
    report
  };
}

module.exports = {
  buildReview
};
