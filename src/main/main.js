const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { initDb, getSetting, setSetting } = require("./db");
const { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDERS, getDefaultBaseUrl, getDefaultModel, getProvider, getProxyUrl, testLlmConnection } = require("./llm");
const { buildReview } = require("./reviewer");

let mainWindow;
let dbPath;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Review Accelerator",
    backgroundColor: "#f7f5ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function getSettings() {
  const savedProvider = getSetting(dbPath, "provider", "");
  const savedBaseUrl = getSetting(dbPath, "baseUrl", "");
  const savedModel = getSetting(dbPath, "model", "");
  const provider =
    savedProvider ||
    (/(^|\/)openai\.com\b|openai/i.test(savedBaseUrl) || /^gpt-/i.test(savedModel) ? "openai" : DEFAULT_PROVIDER);
  const legacyWeakModel = savedModel === "gpt-4o-mini";
  return {
    provider,
    providers: Object.entries(PROVIDERS).map(([id, info]) => ({
      id,
      label: info.label,
      defaultBaseUrl: info.defaultBaseUrl,
      defaultModel: info.defaultModel
    })),
    apiKey: getSetting(dbPath, "apiKey", ""),
    baseUrl: savedBaseUrl || getDefaultBaseUrl(provider) || DEFAULT_BASE_URL,
    model: legacyWeakModel ? getDefaultModel(provider) : savedModel || getDefaultModel(provider) || DEFAULT_MODEL,
    proxyUrl: getSetting(dbPath, "proxyUrl", ""),
    effectiveProxyUrl: getProxyUrl({ proxyUrl: getSetting(dbPath, "proxyUrl", "") }),
    lastProjectPath: getSetting(dbPath, "lastProjectPath", "")
  };
}

app.whenReady().then(() => {
  dbPath = path.join(app.getPath("userData"), "review-accelerator.sqlite");
  initDb(dbPath);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("project:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a local project folder",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  setSetting(dbPath, "lastProjectPath", result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle("settings:get", () => getSettings());

ipcMain.handle("settings:save", (_event, settings) => {
  const provider = getProvider(settings);
  setSetting(dbPath, "provider", provider);
  setSetting(dbPath, "apiKey", settings.apiKey || "");
  setSetting(dbPath, "baseUrl", settings.baseUrl || getDefaultBaseUrl(provider) || DEFAULT_BASE_URL);
  setSetting(dbPath, "model", settings.model || getDefaultModel(provider) || DEFAULT_MODEL);
  setSetting(dbPath, "proxyUrl", settings.proxyUrl || "");
  if (settings.lastProjectPath) setSetting(dbPath, "lastProjectPath", settings.lastProjectPath);
  return getSettings();
});

ipcMain.handle("settings:testConnection", async (_event, settings) => {
  const mergedSettings = {
    ...getSettings(),
    ...settings
  };
  return testLlmConnection(mergedSettings);
});

ipcMain.handle("review:run", async (event, projectPath) => {
  const settings = getSettings();
  if (!projectPath) throw new Error("Choose a project folder first.");
  setSetting(dbPath, "lastProjectPath", projectPath);
  return buildReview(dbPath, projectPath, settings, (payload) => {
    event.sender.send("review:progress", payload);
  });
});

ipcMain.handle("evidence:read", (_event, payload) => {
  const projectPath = getSetting(dbPath, "lastProjectPath", "");
  if (!projectPath) throw new Error("Choose a project folder first.");
  const filePath = path.resolve(projectPath, payload.path);
  const projectRoot = path.resolve(projectPath);
  const relativePath = path.relative(projectRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Evidence path is outside the selected project.");
  }

  const source = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const startLine = Math.max(1, Number(payload.startLine || 1));
  const endLine = Math.max(startLine, Number(payload.endLine || startLine));
  const before = Math.max(1, startLine - 6);
  const after = Math.min(source.length, endLine + 8);
  const lines = [];

  for (let line = before; line <= after; line += 1) {
    lines.push({
      number: line,
      text: source[line - 1] || "",
      highlighted: line >= startLine && line <= endLine
    });
  }

  return {
    path: payload.path,
    startLine,
    endLine,
    lines
  };
});
