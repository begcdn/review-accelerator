const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value));
}

function runSql(dbPath, sql, { json = false } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "sqlite3 failed");
  }
  if (!json || !result.stdout.trim()) return [];
  return JSON.parse(result.stdout);
}

function initDb(dbPath) {
  runSql(
    dbPath,
    `
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_review_at TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS snapshot_files (
      snapshot_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      skeleton_json TEXT NOT NULL,
      purpose_hints_json TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, path),
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    );
    CREATE TABLE IF NOT EXISTS cached_file_summaries (
      project_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_path, file_path, hash)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      snapshot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      report_json TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `
  );
}

function getOrCreateProject(dbPath, projectPath) {
  const name = path.basename(projectPath);
  const now = new Date().toISOString();
  runSql(
    dbPath,
    `INSERT OR IGNORE INTO projects(path, name, created_at) VALUES (${sqlString(projectPath)}, ${sqlString(name)}, ${sqlString(now)});`
  );
  return runSql(dbPath, `SELECT * FROM projects WHERE path = ${sqlString(projectPath)} LIMIT 1;`, { json: true })[0];
}

function getLatestSnapshot(dbPath, projectId) {
  const rows = runSql(
    dbPath,
    `SELECT * FROM snapshots WHERE project_id = ${Number(projectId)} ORDER BY id DESC LIMIT 1;`,
    { json: true }
  );
  if (!rows.length) return null;
  const files = runSql(
    dbPath,
    `SELECT * FROM snapshot_files WHERE snapshot_id = ${Number(rows[0].id)} ORDER BY path;`,
    { json: true }
  ).map((row) => ({
    path: row.path,
    hash: row.hash,
    language: row.language,
    size: row.size,
    lineCount: row.line_count,
    skeleton: JSON.parse(row.skeleton_json),
    purposeHints: JSON.parse(row.purpose_hints_json)
  }));
  return { ...rows[0], files };
}

function getCachedSummary(dbPath, projectPath, file) {
  const rows = runSql(
    dbPath,
    `SELECT summary_json FROM cached_file_summaries WHERE project_path = ${sqlString(projectPath)} AND file_path = ${sqlString(file.path)} AND hash = ${sqlString(file.hash)} LIMIT 1;`,
    { json: true }
  );
  return rows.length ? JSON.parse(rows[0].summary_json) : null;
}

function saveCachedSummary(dbPath, projectPath, file, summary) {
  const now = new Date().toISOString();
  runSql(
    dbPath,
    `INSERT OR REPLACE INTO cached_file_summaries(project_path, file_path, hash, summary_json, updated_at)
     VALUES (${sqlString(projectPath)}, ${sqlString(file.path)}, ${sqlString(file.hash)}, ${sqlJson(summary)}, ${sqlString(now)});`
  );
}

function saveSnapshotAndReview(dbPath, projectId, scan, report) {
  const now = new Date().toISOString();
  runSql(dbPath, `INSERT INTO snapshots(project_id, created_at) VALUES (${Number(projectId)}, ${sqlString(now)});`);
  const snapshotId = runSql(
    dbPath,
    `SELECT id FROM snapshots WHERE project_id = ${Number(projectId)} AND created_at = ${sqlString(now)} ORDER BY id DESC LIMIT 1;`,
    { json: true }
  )[0].id;

  for (const file of scan.files) {
    runSql(
      dbPath,
      `INSERT INTO snapshot_files(snapshot_id, path, hash, language, size, line_count, skeleton_json, purpose_hints_json)
       VALUES (${Number(snapshotId)}, ${sqlString(file.path)}, ${sqlString(file.hash)}, ${sqlString(file.language)}, ${Number(file.size)}, ${Number(file.lineCount)}, ${sqlJson(file.skeleton)}, ${sqlJson(file.purposeHints)});`
    );
  }

  runSql(
    dbPath,
    `INSERT INTO reviews(project_id, snapshot_id, created_at, report_json)
     VALUES (${Number(projectId)}, ${Number(snapshotId)}, ${sqlString(now)}, ${sqlJson(report)});`
  );
  runSql(dbPath, `UPDATE projects SET last_review_at = ${sqlString(now)} WHERE id = ${Number(projectId)};`);
  return { snapshotId };
}

function getSetting(dbPath, key, fallback = "") {
  const rows = runSql(dbPath, `SELECT value FROM settings WHERE key = ${sqlString(key)} LIMIT 1;`, { json: true });
  return rows.length ? rows[0].value : fallback;
}

function setSetting(dbPath, key, value) {
  runSql(
    dbPath,
    `INSERT OR REPLACE INTO settings(key, value) VALUES (${sqlString(key)}, ${sqlString(value)});`
  );
}

module.exports = {
  getCachedSummary,
  getLatestSnapshot,
  getOrCreateProject,
  getSetting,
  initDb,
  saveCachedSummary,
  saveSnapshotAndReview,
  setSetting
};
