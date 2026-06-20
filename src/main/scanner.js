const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language } = require("web-tree-sitter");
const { languageByExtension, supportedExtensions } = require("../shared/schema");

const ignoredDirectoryNames = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".tauri",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

const ignoredFileNames = new Set([
  ".DS_Store",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock"
]);

const maxFileBytes = 260 * 1024;
let parserInitPromise = null;
const languagePromises = new Map();
const wasmByLanguage = {
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm"
};

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function shouldIgnorePath(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((part) => ignoredDirectoryNames.has(part));
}

function shouldScanFile(filePath, stats) {
  if (stats.size > maxFileBytes) return false;
  if (ignoredFileNames.has(path.basename(filePath))) return false;
  return supportedExtensions.has(path.extname(filePath));
}

function walkProject(projectPath) {
  const files = [];
  const stack = [projectPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (shouldIgnorePath(current)) continue;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) stack.push(nextPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let stats;
      try {
        stats = fs.statSync(nextPath);
      } catch {
        continue;
      }
      if (shouldScanFile(nextPath, stats)) files.push(nextPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function readTextFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function classifyPath(relativePath, language) {
  const lower = relativePath.toLowerCase();
  const signals = [];

  if (/auth|login|session|token|jwt|oauth|password/.test(lower)) signals.push("auth");
  if (/db|database|model|schema|migration|query|repository|store/.test(lower)) signals.push("data");
  if (/component|page|view|ui|style|css|html|tsx|jsx|svelte|vue/.test(lower)) signals.push("ui");
  if (/worker|job|queue|cron|task|schedule/.test(lower)) signals.push("background jobs");
  if (/ai|llm|openai|anthropic|prompt|completion|embedding/.test(lower)) signals.push("ai calls");
  if (/config|env|settings|manifest|package\.json|vite|webpack|electron|tauri/.test(lower)) signals.push("config");
  if (/test|spec|fixture|mock/.test(lower)) signals.push("tests");
  if (!signals.length && language) signals.push(language);

  return signals.slice(0, 3);
}

function addSymbol(symbols, name, kind, line, evidenceText) {
  if (!name || symbols.some((symbol) => symbol.name === name && symbol.line === line)) return;
  symbols.push({
    name,
    kind,
    line,
    evidenceText: evidenceText.trim().slice(0, 180)
  });
}

function extractSymbolsWithFallback(source, language) {
  const symbols = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    const line = index + 1;
    const trimmed = lineText.trim();

    if (language === "python") {
      const defMatch = trimmed.match(/^def\s+([A-Za-z_][\w]*)\s*\(/);
      const asyncDefMatch = trimmed.match(/^async\s+def\s+([A-Za-z_][\w]*)\s*\(/);
      const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)/);
      if (defMatch) addSymbol(symbols, defMatch[1], "function", line, trimmed);
      if (asyncDefMatch) addSymbol(symbols, asyncDefMatch[1], "function", line, trimmed);
      if (classMatch) addSymbol(symbols, classMatch[1], "class", line, trimmed);
      return;
    }

    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?/);
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    const methodMatch = trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);

    if (functionMatch) addSymbol(symbols, functionMatch[1], "function", line, trimmed);
    if (arrowMatch && /=>|function|\(/.test(trimmed)) addSymbol(symbols, arrowMatch[1], "function", line, trimmed);
    if (classMatch) addSymbol(symbols, classMatch[1], "class", line, trimmed);
    if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[1])) {
      addSymbol(symbols, methodMatch[1], "method", line, trimmed);
    }
  });

  return symbols.slice(0, 80);
}

function nodeText(source, node) {
  return source.slice(node.startIndex, node.endIndex);
}

function findChild(node, type) {
  return node.namedChildren.find((child) => child.type === type);
}

function walkTree(node, visit) {
  visit(node);
  for (const child of node.namedChildren) walkTree(child, visit);
}

async function loadTreeSitterLanguage(language) {
  const wasmPath = wasmByLanguage[language];
  if (!wasmPath) return null;

  if (!parserInitPromise) parserInitPromise = Parser.init();
  await parserInitPromise;

  if (!languagePromises.has(language)) {
    languagePromises.set(
      language,
      Language.load(path.resolve(__dirname, "../../node_modules", wasmPath)).catch(() => null)
    );
  }
  return languagePromises.get(language);
}

async function extractSymbolsWithTreeSitter(source, language) {
  const treeSitterLanguage = await loadTreeSitterLanguage(language);
  if (!treeSitterLanguage) return null;

  const parser = new Parser();
  parser.setLanguage(treeSitterLanguage);
  const tree = parser.parse(source);
  const symbols = [];

  walkTree(tree.rootNode, (node) => {
    if (language === "javascript") {
      if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
        const name = findChild(node, "identifier");
        addSymbol(symbols, name && nodeText(source, name), "function", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
      if (node.type === "class_declaration") {
        const name = findChild(node, "identifier");
        addSymbol(symbols, name && nodeText(source, name), "class", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
      if (node.type === "method_definition") {
        const property = findChild(node, "property_identifier") || findChild(node, "identifier");
        addSymbol(symbols, property && nodeText(source, property), "method", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
      if (node.type === "variable_declarator") {
        const name = findChild(node, "identifier");
        const value = node.namedChildren.find((child) => child.type === "arrow_function" || child.type === "function_expression");
        if (value) addSymbol(symbols, name && nodeText(source, name), "function", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
    }

    if (language === "python") {
      if (node.type === "function_definition") {
        const name = findChild(node, "identifier");
        addSymbol(symbols, name && nodeText(source, name), "function", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
      if (node.type === "class_definition") {
        const name = findChild(node, "identifier");
        addSymbol(symbols, name && nodeText(source, name), "class", node.startPosition.row + 1, nodeText(source, node).split(/\r?\n/)[0]);
      }
    }
  });

  return symbols.slice(0, 80);
}

function extractImports(source, language) {
  const imports = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    const trimmed = lineText.trim();
    const line = index + 1;

    if (language === "python") {
      const match = trimmed.match(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/);
      if (match) imports.push({ target: match[1] || match[2], line, evidenceText: trimmed.slice(0, 180) });
      return;
    }

    const importMatch = trimmed.match(/^import\s+.*?\s+from\s+["'](.+?)["']/);
    const bareImportMatch = trimmed.match(/^import\s+["'](.+?)["']/);
    const requireMatch = trimmed.match(/require\(["'](.+?)["']\)/);
    if (importMatch || bareImportMatch || requireMatch) {
      imports.push({
        target: (importMatch || bareImportMatch || requireMatch)[1],
        line,
        evidenceText: trimmed.slice(0, 180)
      });
    }
  });

  return imports.slice(0, 80);
}

async function buildFileRecord(projectPath, filePath) {
  const relativePath = path.relative(projectPath, filePath);
  const source = readTextFile(filePath);
  if (source === null) return null;

  const extension = path.extname(filePath);
  const language = languageByExtension[extension] || "text";
  const buffer = Buffer.from(source, "utf8");
  const lines = source.split(/\r?\n/);
  const treeSitterSymbols = await extractSymbolsWithTreeSitter(source, language);
  const symbols = treeSitterSymbols || extractSymbolsWithFallback(source, language);
  const imports = extractImports(source, language);

  return {
    path: relativePath,
    absolutePath: filePath,
    hash: sha256(buffer),
    size: buffer.byteLength,
    language,
    purposeHints: classifyPath(relativePath, language),
    lineCount: lines.length,
    excerpt: lines.slice(0, 160).join("\n"),
    skeleton: {
      parser: treeSitterSymbols ? "tree-sitter" : "fallback-symbol-extractor",
      parserNote: treeSitterSymbols
        ? "Parsed with tree-sitter."
        : "Tree-sitter is not configured for this language yet, so this scan used language-aware symbol extraction.",
      symbols,
      imports
    }
  };
}

async function scanProject(projectPath) {
  const absoluteProjectPath = path.resolve(projectPath);
  const files = [];
  for (const filePath of walkProject(absoluteProjectPath)) {
    const record = await buildFileRecord(absoluteProjectPath, filePath);
    if (record) files.push(record);
  }

  return {
    projectPath: absoluteProjectPath,
    scannedAt: new Date().toISOString(),
    files
  };
}

function diffSnapshots(previousFiles, currentFiles) {
  const previousByPath = new Map((previousFiles || []).map((file) => [file.path, file]));
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const changes = [];

  for (const file of currentFiles) {
    const previous = previousByPath.get(file.path);
    if (!previous) {
      changes.push({ status: "added", path: file.path, current: file });
    } else if (previous.hash !== file.hash) {
      changes.push({ status: "modified", path: file.path, previous, current: file });
    }
  }

  for (const file of previousFiles || []) {
    if (!currentByPath.has(file.path)) {
      changes.push({ status: "removed", path: file.path, previous: file });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  classifyPath,
  diffSnapshots,
  extractSymbolsWithFallback,
  scanProject
};
