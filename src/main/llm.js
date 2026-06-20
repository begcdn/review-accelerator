const { spawnSync } = require("node:child_process");
const { ProxyAgent } = require("undici");

const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6"
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1"
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro"
  }
};
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_BASE_URL = PROVIDERS[DEFAULT_PROVIDER].defaultBaseUrl;
const DEFAULT_MODEL = PROVIDERS[DEFAULT_PROVIDER].defaultModel;

let cachedSystemProxyUrl = null;

function readMacSystemProxyUrl() {
  if (process.platform !== "darwin") return "";
  if (cachedSystemProxyUrl !== null) return cachedSystemProxyUrl;

  const result = spawnSync("scutil", ["--proxy"], { encoding: "utf8" });
  if (result.status !== 0) {
    cachedSystemProxyUrl = "";
    return cachedSystemProxyUrl;
  }

  const output = result.stdout || "";
  const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
  const httpsHost = output.match(/HTTPSProxy\s*:\s*(.+)/)?.[1]?.trim();
  const httpsPort = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]?.trim();
  const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
  const httpHost = output.match(/HTTPProxy\s*:\s*(.+)/)?.[1]?.trim();
  const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1]?.trim();

  if (httpsEnabled && httpsHost && httpsPort) {
    cachedSystemProxyUrl = `http://${httpsHost}:${httpsPort}`;
  } else if (httpEnabled && httpHost && httpPort) {
    cachedSystemProxyUrl = `http://${httpHost}:${httpPort}`;
  } else {
    cachedSystemProxyUrl = "";
  }
  return cachedSystemProxyUrl;
}

function getProxyUrl(settings) {
  return (
    settings.proxyUrl ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    readMacSystemProxyUrl() ||
    ""
  ).trim();
}

function makeFetchOptions(settings) {
  const proxyUrl = getProxyUrl(settings);
  if (!proxyUrl) return {};
  if (!/^https?:\/\//i.test(proxyUrl)) {
    throw new Error("Proxy URL must start with http:// or https://. SOCKS proxies need an HTTP/mixed proxy port.");
  }
  return {
    dispatcher: new ProxyAgent(proxyUrl)
  };
}

function getProvider(settings) {
  return PROVIDERS[settings.provider] ? settings.provider : DEFAULT_PROVIDER;
}

function getDefaultBaseUrl(provider) {
  return PROVIDERS[provider]?.defaultBaseUrl || DEFAULT_BASE_URL;
}

function getDefaultModel(provider) {
  return PROVIDERS[provider]?.defaultModel || DEFAULT_MODEL;
}

function getBaseUrl(settings) {
  const provider = getProvider(settings);
  return (settings.baseUrl || getDefaultBaseUrl(provider)).replace(/\/$/, "");
}

function getModel(settings) {
  const provider = getProvider(settings);
  return settings.model || getDefaultModel(provider);
}

function compactSkeleton(file) {
  return {
    path: file.path,
    language: file.language,
    lineCount: file.lineCount,
    purposeHints: file.purposeHints,
    symbols: file.skeleton.symbols.slice(0, 30).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      evidenceText: symbol.evidenceText
    })),
    imports: file.skeleton.imports.slice(0, 25).map((item) => ({
      target: item.target,
      line: item.line,
      evidenceText: item.evidenceText
    }))
  };
}

function extractJson(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("The LLM response did not contain JSON.");
}

async function callChatCompletion(settings, messages) {
  const system = messages.find((message) => message.role === "system")?.content || "";
  const user = messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n\n");
  return callLlmJson(settings, system, user);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlmJson(settings, system, user, options = {}) {
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your LLM API key before running a review.");
  }

  const provider = getProvider(settings);
  const baseUrl = getBaseUrl(settings);
  const model = getModel(settings);
  let response;

  try {
    const fetchOptions = makeFetchOptions(settings);
    if (provider === "anthropic") {
      response = await fetchWithTimeout(
        `${baseUrl}/messages`,
        {
          method: "POST",
          ...fetchOptions,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            max_tokens: options.maxTokens || 4096,
            temperature: options.temperature ?? 0.2,
            system,
            messages: [{ role: "user", content: user }]
          })
        },
        options.timeoutMs || 90000
      );
    } else {
      response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          ...fetchOptions,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            temperature: options.temperature ?? 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ]
          })
        },
        options.timeoutMs || 90000
      );
    }
  } catch (error) {
    const reason =
      error.name === "AbortError"
        ? "The LLM request timed out."
        : "The app could not reach the LLM provider.";
    throw new Error(
      `${reason} Check Provider (${provider}), Base URL (${baseUrl}), Proxy URL (${getProxyUrl(settings) || "none"}), and network access.`
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM request failed (${response.status}). ${detail.slice(0, 240)}`);
  }

  const json = await response.json();
  const content =
    provider === "anthropic"
      ? json.content?.find((part) => part.type === "text")?.text
      : json.choices?.[0]?.message?.content;
  if (!content) throw new Error("The LLM returned an empty response.");
  return extractJson(content);
}

async function testLlmConnection(settings) {
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your LLM API key before testing the connection.");
  }

  const provider = getProvider(settings);
  const baseUrl = getBaseUrl(settings);

  try {
    let response;
    if (provider === "anthropic") {
      response = await fetchWithTimeout(
        `${baseUrl}/messages`,
        {
          method: "POST",
          ...makeFetchOptions(settings),
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: getModel(settings),
            max_tokens: 64,
            system: "You are a connection test. Return JSON only.",
            messages: [{ role: "user", content: "Return {\"ok\":true}." }]
          })
        },
        20000
      );
    } else {
      response = await fetchWithTimeout(
        `${baseUrl}/models`,
        {
          method: "GET",
          ...makeFetchOptions(settings),
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        },
        20000
      );
    }

    if (response.ok) {
      return {
        ok: true,
        message: `Connected to ${provider} at ${baseUrl}${getProxyUrl(settings) ? " through proxy" : ""}.`
      };
    }

    const detail = await response.text();
    throw new Error(`Provider responded with ${response.status}. ${detail.slice(0, 180)}`);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Connection test timed out. Provider: ${provider}. Base URL: ${baseUrl}. Proxy URL: ${getProxyUrl(settings) || "none"}.`);
    }
    if (/^Provider responded/.test(error.message)) throw error;
    throw new Error(
      `Connection test failed. Provider: ${provider}. Base URL: ${baseUrl}. Proxy URL: ${getProxyUrl(settings) || "none"}. ${error.message}`
    );
  }
}

function validateEvidenceRefs(items, fileMetaByPath) {
  const clampRef = (ref) => {
    if (!ref || !fileMetaByPath.has(ref.path)) return null;
    const meta = fileMetaByPath.get(ref.path);
    const startLine = Math.min(meta.lineCount, Math.max(1, Number(ref.startLine || ref.line || 1)));
    const endLine = Math.min(meta.lineCount, Math.max(startLine, Number(ref.endLine || ref.startLine || ref.line || 1)));
    return {
      path: ref.path,
      startLine,
      endLine,
      label: String(ref.label || `${ref.path}:${startLine}`).slice(0, 100)
    };
  };

  return (items || [])
    .map(clampRef)
    .filter(Boolean)
    .slice(0, 8);
}

function fallbackEvidence(paths, fileMetaByPath) {
  for (const filePath of paths || []) {
    const meta = fileMetaByPath.get(filePath);
    if (!meta) continue;
    const firstSymbol = meta.symbols[0];
    const line = firstSymbol?.line || 1;
    return [
      {
        path: filePath,
        startLine: line,
        endLine: line,
        label: firstSymbol ? `${firstSymbol.name} in ${filePath}` : `${filePath}:${line}`
      }
    ];
  }
  return [];
}

const verdictPatterns = [
  /\bbuggy\b/i,
  /\bincorrect\b/i,
  /\bwrong\b/i,
  /\bbroken\b/i,
  /\binsecure\b/i,
  /\bunsafe\b/i,
  /\bvulnerab(?:le|ility)\b/i,
  /\bsecurity issue\b/i,
  /\bsafe to\b/i,
  /\bshould be fixed\b/i,
  /\bwill break\b/i
];

function containsVerdictLanguage(value) {
  return verdictPatterns.some((pattern) => pattern.test(String(value || "")));
}

const genericDescriptionPatterns = [
  /\bstuff\b/i,
  /\bthings\b/i,
  /\bvarious\b/i,
  /\boperations\b/i,
  /\bfunctionality\b/i,
  /\bbackend\b\s+\bstuff\b/i,
  /\bfrontend\b\s+\bstuff\b/i,
  /\bunderstand this area\b/i,
  /\blinked code\b/i
];

function containsGenericFiller(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (genericDescriptionPatterns.some((pattern) => pattern.test(text))) return true;
  if (/^(handles|manages|processes|supports|provides|implements)\s+(llm|api|backend|frontend|ui|data|app|application|project|code|files?)[\s.]*$/i.test(text)) {
    return true;
  }
  return false;
}

function safeNotice(notice) {
  return containsVerdictLanguage(notice) ? null : String(notice).slice(0, 180);
}

function hasConcretePurpose(value) {
  const purpose = String(value || "").trim();
  if (purpose.length < 28) return false;
  if (/^(understand|review|see|check)\b/i.test(purpose)) return false;
  if (/linked code|this area|this section|various files/i.test(purpose)) return false;
  if (containsGenericFiller(purpose)) return false;
  if (!/[.!?]$/.test(purpose)) return false;
  return !containsVerdictLanguage(purpose);
}

function hasConcreteFunctionDescription(value) {
  const description = String(value || "").trim();
  if (description.length < 32) return false;
  if (containsGenericFiller(description)) return false;
  if (containsVerdictLanguage(description)) return false;
  if (!/[.!?]$/.test(description)) return false;
  return /\b(reads?|sends?|calls?|posts?|fetches?|returns?|writes?|stores?|loads?|parses?|opens?|creates?|updates?|deletes?|extracts?|hashes?|routes?|renders?|scans?|summari[sz]es?|validates?|normalizes?|persists?|invokes?|compares?|selects?|saves?|builds?|groups?|filters?)\b/i.test(description);
}

function isTrivialPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return (
    /(^|\/)(readme|license|changelog|code_of_conduct|security|contributing)(\.[a-z0-9]+)?$/.test(lower) ||
    /(^|\/)(package-lock|pnpm-lock|yarn\.lock|cargo\.lock|poetry\.lock)$/.test(lower) ||
    /(^|\/)(package|tsconfig|vite\.config|webpack\.config|eslint\.config|prettier\.config)\.[a-z0-9]+$/.test(lower)
  );
}

function normalizeStructureAreas(areas, validPaths, fileMetaByPath) {
  return (areas || [])
    .slice(0, 10)
    .map((area) => {
      const livesIn = (area.livesIn || area.files || []).filter((item) => validPaths.has(item)).slice(0, 16);
      const evidenceRefs = validateEvidenceRefs(area.evidenceRefs, fileMetaByPath);
      const keyFunctions = (area.keyFunctions || area.functions || [])
        .slice(0, 6)
        .map((item) => {
          const path = item.path || item.file || item.evidenceRefs?.[0]?.path;
          const refs = validateEvidenceRefs(item.evidenceRefs || [{ path, startLine: item.line || item.startLine, endLine: item.endLine, label: item.name }], fileMetaByPath);
          return {
            name: String(item.name || item.symbol || item.label || "Function").slice(0, 90),
            description: String(item.description || item.purpose || item.summary || "").trim().slice(0, 260),
            path,
            line: Number(item.line || item.startLine || refs[0]?.startLine || 1),
            signature: String(item.signature || item.evidenceText || "").trim().slice(0, 220),
            evidenceRefs: refs
          };
        })
        .filter((item) => validPaths.has(item.path))
        .filter((item) => item.evidenceRefs.length)
        .filter((item) => hasConcreteFunctionDescription(item.description))
        .slice(0, 4);
      return {
        name: String(area.name || "Area").slice(0, 80),
        purpose: String(area.purpose || "").trim().slice(0, 260),
        livesIn,
        evidenceRefs,
        keyFunctions
      };
    })
    .filter((area) => hasConcretePurpose(area.purpose))
    .filter((area) => area.keyFunctions.length >= 2)
    .filter((area) => !(area.livesIn.length === 1 && isTrivialPath(area.livesIn[0])))
    .map((area) => ({
      ...area,
      evidenceRefs: area.evidenceRefs.length ? area.evidenceRefs : fallbackEvidence(area.livesIn, fileMetaByPath)
    }))
    .filter((area) => area.evidenceRefs.length)
    .slice(0, 8);
}

function findFile(files, predicate) {
  return files.find((file) => predicate(file.path));
}

function findSymbol(files, filePath, names) {
  const file = files.find((item) => item.path === filePath);
  if (!file) return null;
  const wanted = Array.isArray(names) ? names : [names];
  const symbol = (file.skeleton?.symbols || []).find((item) => wanted.includes(item.name));
  if (!symbol) return null;
  return {
    path: file.path,
    line: symbol.line,
    name: symbol.name,
    signature: symbol.evidenceText,
    evidenceRefs: [{ path: file.path, startLine: symbol.line, endLine: symbol.line, label: symbol.name }]
  };
}

function inferredFunction(files, filePath, names, description) {
  const symbol = findSymbol(files, filePath, names);
  if (!symbol) return null;
  return {
    name: symbol.name,
    description,
    path: symbol.path,
    line: symbol.line,
    signature: symbol.signature,
    evidenceRefs: symbol.evidenceRefs
  };
}

function addInferredCoverageAreas(areas, files) {
  const next = [...areas];
  const hasAreaFor = (prefix) => next.some((area) => area.livesIn.some((filePath) => filePath.startsWith(prefix)));
  const hasExact = (filePath) => files.some((file) => file.path === filePath);

  if (!hasAreaFor("src/renderer/") && hasExact("src/renderer/renderer.js")) {
    const keyFunctions = [
      inferredFunction(files, "src/renderer/renderer.js", "renderReport", "Renders change clusters, focus items, structure areas, review notes, and stats into the DOM after a review completes."),
      inferredFunction(files, "src/renderer/renderer.js", "runReview", "Saves current settings, invokes the review:run IPC method, and sends the returned report into renderReport."),
      inferredFunction(files, "src/renderer/renderer.js", "openEvidence", "Requests source lines through evidence:read and displays the returned path and highlighted lines in the evidence drawer."),
      inferredFunction(files, "src/renderer/renderer.js", "init", "Loads saved settings, fills the provider and project controls, and wires buttons, tabs, expansion, and evidence clicks.")
    ].filter(Boolean);
    if (keyFunctions.length >= 2) {
      next.push({
        name: "Review results interface",
        purpose: "Renders the What changed and Structure map tabs from renderer.js, sends review/settings IPC calls through window.reviewAccelerator, and opens clicked evidence lines in the drawer.",
        livesIn: ["src/renderer/index.html", "src/renderer/renderer.js", "src/renderer/styles.css"].filter(hasExact),
        keyFunctions,
        evidenceRefs: keyFunctions[0].evidenceRefs
      });
    }
  }

  if (!hasAreaFor("src/main/llm.js") && hasExact("src/main/llm.js")) {
    const keyFunctions = [
      inferredFunction(files, "src/main/llm.js", "callLlmJson", "Posts prompts to Anthropic /messages or OpenAI-compatible /chat/completions, then extracts and parses the returned JSON text."),
      inferredFunction(files, "src/main/llm.js", "generateStructureAreas", "Builds the structure prompt from scanned files, calls the LLM, and retries when areas are missing concrete purposes or major surfaces."),
      inferredFunction(files, "src/main/llm.js", "normalizeReport", "Validates evidence references, removes verdict and filler language, and keeps only concrete areas, focus items, and key functions."),
      inferredFunction(files, "src/main/llm.js", "summarizeFile", "Sends a compact file skeleton and excerpt to the LLM and returns the parsed file summary JSON.")
    ].filter(Boolean);
    if (keyFunctions.length >= 2) {
      next.push({
        name: "LLM review synthesis",
        purpose: "Builds provider-specific LLM requests from llm.js, parses JSON replies into file summaries and structure areas, and filters returned text through evidence and filler checks.",
        livesIn: ["src/main/llm.js", "src/main/reviewer.js"].filter(hasExact),
        keyFunctions,
        evidenceRefs: keyFunctions[0].evidenceRefs
      });
    }
  }

  if (!hasAreaFor("scripts/") && !hasAreaFor("test-fixtures/") && hasExact("scripts/contract-test.js")) {
    const keyFunctions = [
      inferredFunction(files, "scripts/contract-test.js", "main", "Creates a temporary fixture project, mocks LLM engines, runs buildReview twice, and asserts structure, caching, diffing, and guardrails."),
      inferredFunction(files, "scripts/smoke-test.js", "main", "Copies sample files, scans and stores a snapshot, edits files, rescans, and asserts added and modified file detection.")
    ].filter(Boolean);
    if (keyFunctions.length >= 2) {
      next.push({
        name: "Review workflow tests",
        purpose: "Runs smoke and contract scripts that create sample projects, call the review pipeline, and assert snapshot diffing, caching, evidence, and language guardrails.",
        livesIn: ["scripts/contract-test.js", "scripts/smoke-test.js", "test-fixtures/sample-app/src/auth.js", "test-fixtures/sample-app/src/db.py"].filter(hasExact),
        keyFunctions,
        evidenceRefs: keyFunctions[0].evidenceRefs
      });
    }
  }

  return next.slice(0, 8);
}

function normalizeReport(report, files, diff) {
  const validPaths = new Set(files.map((file) => file.path));
  const fileMetaByPath = new Map(
    files.map((file) => [
      file.path,
      {
        lineCount: file.lineCount || 1,
        symbols: file.skeleton?.symbols || []
      }
    ])
  );
  let removedVerdicts = 0;
  const parserWarnings = files
    .filter((file) => file.skeleton && file.skeleton.parser !== "tree-sitter")
    .slice(0, 1)
    .map((file) => file.skeleton.parserNote);

  const structureAreas = addInferredCoverageAreas(
    normalizeStructureAreas(report.structureAreas, validPaths, fileMetaByPath),
    files
  );

  return {
    generatedAt: new Date().toISOString(),
    isFirstReview: diff.isFirstReview,
    parserWarnings,
    structureAreas,
    changeClusters: (report.changeClusters || []).slice(0, 8).map((cluster) => ({
      area: String(cluster.area || "Project").slice(0, 60),
      summary: containsVerdictLanguage(cluster.summary)
        ? (removedVerdicts += 1, "Changed since the last review. Use the linked evidence to inspect the purpose.")
        : String(cluster.summary || "Changed since the last review.").slice(0, 340),
      files: (cluster.files || []).filter((item) => validPaths.has(item)).slice(0, 12),
      evidenceRefs: validateEvidenceRefs(cluster.evidenceRefs, fileMetaByPath)
    }))
    .map((cluster) => ({
      ...cluster,
      evidenceRefs: cluster.evidenceRefs.length ? cluster.evidenceRefs : fallbackEvidence(cluster.files, fileMetaByPath)
    }))
    .filter((cluster) => cluster.evidenceRefs.length),
    focusItems: (report.focusItems || []).slice(0, 3).map((item) => ({
      label: String(item.label || "Review this code").slice(0, 90),
      why: containsVerdictLanguage(item.why) || containsGenericFiller(item.why)
        ? (removedVerdicts += 1, "")
        : String(item.why || "").slice(0, 220),
      evidenceRefs: validateEvidenceRefs(item.evidenceRefs, fileMetaByPath),
      fallbackFiles: [item.path, item.file, ...(item.files || [])].filter(Boolean)
    }))
    .map((item) => ({
      ...item,
      evidenceRefs: item.evidenceRefs.length ? item.evidenceRefs : fallbackEvidence(item.fallbackFiles, fileMetaByPath)
    }))
    .filter((item) => item.why.length >= 28)
    .filter((item) => item.evidenceRefs.length),
    notices: [
      "This is a comprehension report, not a correctness review.",
      "Dependency and impact notes describe what the scanner can see, not everything runtime code may do.",
      ...(removedVerdicts
        ? ["Some LLM text was hidden because it crossed into correctness or security judgment."]
        : []),
      ...(report.notices || []).map(safeNotice).filter(Boolean)
    ].slice(0, 5)
  };
}

async function summarizeFile(settings, file) {
  const payload = {
    file: compactSkeleton(file),
    excerpt: file.excerpt.slice(0, 12000)
  };

  return callChatCompletion(settings, [
    {
      role: "system",
      content:
        "You summarize source files for a code comprehension tool. Do not judge correctness, security, quality, or bugs. Every claim must cite file path and line numbers from the supplied skeleton or excerpt."
    },
    {
      role: "user",
      content: `Return JSON with keys: purpose, responsibilities, keySymbols, evidenceRefs. Keep it concise. Input:\n${JSON.stringify(payload)}`
    }
  ]);
}

function buildReportPayload(scan, previousSnapshot, changes, fileSummaries) {
  const filesForPrompt = scan.files.map((file) => ({
    ...compactSkeleton(file),
    summary: fileSummaries[file.path]
  }));
  const changedForPrompt = changes.map((change) => ({
    status: change.status,
    path: change.path,
    previousHints: change.previous?.purposeHints || [],
    currentHints: change.current?.purposeHints || [],
    currentSymbols: change.current?.skeleton?.symbols?.slice(0, 18) || []
  }));
  return {
    project: scan.projectPath,
    isFirstReview: !previousSnapshot,
    currentFiles: filesForPrompt,
    changedFiles: changedForPrompt
  };
}

const structureSystemPrompt =
  "You are the architecture synthesis layer of a code review accelerator. Group files by user-facing capability first, not technical layer. Prefer capability blocks such as Authentication, Billing, Notifications, Review workflow, Project selection, or LLM review generation. Use layer/concern grouping only when the codebase is thin or has no distinct user-facing features. Do not judge correctness, bugs, quality, or security. Every area and key function must include evidenceRefs with real file paths and line numbers from the input.";

const structureUserInstructions = `Return JSON only: {"structureAreas":[...]}.

Rules:
- Prefer capability grouping over layer grouping. Ask: what can the app/user do because these files exist?
- Target 5-8 areas for a large codebase and fewer for a small one.
- Each area should usually contain multiple related files. Do not create one area per file.
- Never create an area for a single trivial file such as package.json, README, a config file, or a lockfile. Fold those into "Config/build" or omit them.
- area.purpose MUST be one concrete behavioral sentence about what the area reads, sends/calls, returns, stores, changes, renders, or writes. Name real functions, files, endpoints, prompts, env vars, or UI elements visible in the input.
- Do not use generic verbs without an object. Forbidden filler: "Handles LLM operations", "Manages backend stuff", "Processes files", "Supports UI", "Understand this area from the linked code".
- Each area must include 2-4 keyFunctions. Each key function needs name, description, path, line, optional signature, and evidenceRefs. A bare function name is not allowed.
- keyFunction.description must be one concrete sentence saying what the symbol reads/calls/sends/returns/stores/updates/renders.
- Do not return empty purpose fields. Do not use generic filler such as "Understand this area from the linked code."

Good purpose: "Sends scanned source excerpts to the configured LLM Base URL, parses JSON summaries, and retries structure synthesis when a returned area has no concrete purpose."
Bad purpose: "Handles LLM operations."

Good keyFunction: {"name":"callLlmJson","description":"Posts JSON prompts to either Anthropic /messages or OpenAI-compatible /chat/completions, then parses the returned text as JSON.","path":"src/main/llm.js","line":118,"evidenceRefs":[{"path":"src/main/llm.js","startLine":118,"endLine":204,"label":"provider-specific LLM request"}]}
Bad keyFunction: {"name":"callLlmJson","description":"Handles API stuff."}

Each structure area:
{
  "name": "short responsibility name",
  "purpose": "specific concrete sentence.",
  "livesIn": ["path/a.js", "path/b.js"],
  "keyFunctions": [{"name":"symbolName","description":"specific one-line behavior.","path":"path/a.js","line":12,"signature":"optional exact signature","evidenceRefs":[{"path":"path/a.js","startLine":12,"endLine":30,"label":"basis"}]}],
  "evidenceRefs": [{"path":"path/a.js","startLine":12,"endLine":30,"label":"symbol or line basis"}]
}`;

function areaTargetInstruction(fileCount) {
  if (fileCount < 8) return `This project has ${fileCount} scanned files. Target 2-3 broad responsibility areas.`;
  if (fileCount < 25) return `This project has ${fileCount} scanned files. Target 3-5 broad responsibility areas; avoid splitting backend helpers into one-file areas. Backend modules should usually be one or two areas total.`;
  return `This project has ${fileCount} scanned files. Target 5-8 responsibility areas.`;
}

function getMissingSurfaceNotes(areas, files) {
  const paths = files.map((file) => file.path || file);
  const notes = [];
  const hasRendererFiles = paths.some((filePath) => filePath.startsWith("src/renderer/"));
  const hasMainFiles = paths.some((filePath) => filePath.startsWith("src/main/"));
  const hasTestFiles = paths.some((filePath) => filePath.startsWith("scripts/") || filePath.startsWith("test-fixtures/"));
  const includesRenderer = areas.some((area) => area.livesIn.some((filePath) => filePath.startsWith("src/renderer/")));
  const includesMain = areas.some((area) => area.livesIn.some((filePath) => filePath.startsWith("src/main/")));
  const includesTests = areas.some((area) => area.livesIn.some((filePath) => filePath.startsWith("scripts/") || filePath.startsWith("test-fixtures/")));

  if (hasRendererFiles && !includesRenderer) notes.push("missing renderer/UI area for src/renderer/*");
  if (hasMainFiles && !includesMain) notes.push("missing main-process/review engine area for src/main/*");
  if (hasTestFiles && !includesTests && paths.length < 25) notes.push("missing tests/fixtures area for scripts/* or test-fixtures/*");
  return notes;
}

function structureLooksFragmented(areas, fileCount, files = []) {
  if (fileCount >= 8 && fileCount < 25 && areas.length < 3) return true;
  if (fileCount >= 25 && areas.length < 5) return true;
  if (getMissingSurfaceNotes(areas, files).length) return true;
  if (fileCount < 8) return areas.length > 3;
  if (fileCount < 25) {
    const singleFileAreas = areas.filter((area) => area.livesIn.length === 1 && !isTrivialPath(area.livesIn[0]));
    const backendAreaCount = areas.filter((area) => area.livesIn.some((filePath) => filePath.startsWith("src/main/"))).length;
    return areas.length > 5 || singleFileAreas.length > 1 || backendAreaCount > 2;
  }
  return false;
}

async function generateStructureAreas(settings, payload, scan) {
  const targetInstruction = areaTargetInstruction(scan.files.length);
  const surfaceInstruction = getMissingSurfaceNotes([], scan.files).length
    ? `Mandatory coverage: ${getMissingSurfaceNotes([], scan.files).join("; ")}.`
    : "";
  let response = await callLlmJson(
    settings,
    structureSystemPrompt,
    `${structureUserInstructions}

${targetInstruction}
${surfaceInstruction}
- For small and medium projects, prefer broad areas that contain several related files, such as "Review backend", "LLM synthesis", "Renderer interface", and "Tests/fixtures".
- Prefer product capabilities such as "Run a review", "Summarize source files", "Open evidence lines", "Save review snapshots", and "Configure LLM providers" over generic layer names like "Backend" or "Frontend".
- A one-file area is allowed only when that file is a uniquely central subsystem; otherwise fold it into a related responsibility.
- If the file list includes both src/main and src/renderer, do not spend all areas on src/main. Use one or two backend areas plus one renderer/UI area.
- Do not create a standalone database/config area in a small project when it can be folded into backend orchestration or persistence.
- Do not invent behavior that is not visible in the provided code. For example, do not claim syntax highlighting, auth, billing, or background jobs unless concrete symbols show it.

Input:
${JSON.stringify(payload)}`,
    { maxTokens: 4096 }
  );

  const first = normalizeReport({ structureAreas: response.structureAreas }, scan.files, {
    isFirstReview: payload.isFirstReview
  }).structureAreas;

  if (
    first.length > 0 &&
    first.every((area) => hasConcretePurpose(area.purpose)) &&
    !structureLooksFragmented(first, scan.files.length, scan.files)
  ) {
    return first;
  }

  const missingSurfaceNotes = getMissingSurfaceNotes(first, scan.files);
  response = await callLlmJson(
    settings,
    structureSystemPrompt,
    `${structureUserInstructions}

Retry because the previous answer had missing or generic purposes. Return only areas with concrete purposes. Drop an area if you cannot explain what it does from the provided code evidence.
Also merge narrow one-file areas into broader related responsibilities when the project has fewer than 25 scanned files. For this project size, do not exceed the target area count above.
If the previous answer collapsed too many capabilities into one area, split it into the target number of capability areas using the file evidence. For a medium app, one area for the entire app is not acceptable.
${missingSurfaceNotes.length ? `The previous answer also failed coverage: ${missingSurfaceNotes.join("; ")}. Include those surfaces if the files exist.` : ""}

Previous answer:
${JSON.stringify(response)}

Input:
${JSON.stringify(payload)}`,
    { maxTokens: 4096, temperature: 0.1 }
  );

  return normalizeReport({ structureAreas: response.structureAreas }, scan.files, {
    isFirstReview: payload.isFirstReview
  }).structureAreas.slice(0, scan.files.length < 25 ? 5 : 8);
}

async function generateChangeDigest(settings, payload) {
  const instructions = `Return JSON only with keys: changeClusters, focusItems, notices.

Schema:
{
  "changeClusters": [
    {
      "area": "responsibility name",
      "summary": "one concrete sentence about what changed and what it is for.",
      "files": ["changed/path.js"],
      "evidenceRefs": [{"path":"changed/path.js","startLine":10,"endLine":20,"label":"basis"}]
    }
  ],
  "focusItems": [
    {
      "label": "file or function name",
      "why": "why a human should understand this before editing.",
      "path": "path/to/file.js",
      "evidenceRefs": [{"path":"path/to/file.js","startLine":10,"endLine":20,"label":"basis"}]
    }
  ],
  "notices": []
}

Rules:
- changeClusters are one sentence per meaning cluster, not one per file.
- Each changeCluster must include files and evidenceRefs.
- Use responsibility names from the structure summaries when possible.
- focusItems must contain 2-3 files/functions worth understanding before editing.
- Each focusItem must include a path or evidenceRefs.
- focusItem.why must name concrete behavior visible in the code, such as the exact function it calls, renders, sends, stores, parses, or returns.
- If there are changed files, changeClusters must not be empty.
- If there are scanned files, focusItems must not be empty.
- If you infer impact, phrase it as "visible code suggests" or "what I can see".

Input:
${JSON.stringify(payload)}`;

  let response = await callLlmJson(
    settings,
    "You create change-comprehension summaries for AI-generated code. Explain what changed since the last snapshot in architectural language. Never judge correctness, bugs, quality, or security. Every change cluster and focus item must include evidenceRefs with real file paths and line numbers from the input.",
    instructions,
    { maxTokens: 3072 }
  );

  const normalized = normalizeReport(response, payload.currentFiles, {
    isFirstReview: payload.isFirstReview
  });
  const needsRetry =
    (payload.changedFiles.length > 0 && normalized.changeClusters.length === 0) ||
    (payload.currentFiles.length > 0 && normalized.focusItems.length === 0);
  if (!needsRetry) return response;

  response = await callLlmJson(
    settings,
    "You create change-comprehension summaries for AI-generated code. Never return empty changeClusters when changed files exist, and never return empty focusItems when scanned files exist. Include real files and evidenceRefs.",
    `${instructions}

Retry because the previous answer normalized to empty changeClusters or focusItems. Use the provided changedFiles and currentFiles to produce grounded items.

Previous answer:
${JSON.stringify(response)}`,
    { maxTokens: 3072, temperature: 0.1 }
  );

  return response;
}

async function generateReviewReport(settings, scan, previousSnapshot, changes, fileSummaries) {
  const payload = buildReportPayload(scan, previousSnapshot, changes, fileSummaries);
  const structureAreas = await generateStructureAreas(settings, payload, scan);
  const changeReport = await generateChangeDigest(settings, {
    ...payload,
    structureAreas
  });

  return normalizeReport({
    structureAreas,
    changeClusters: changeReport.changeClusters || [],
    focusItems: changeReport.focusItems || [],
    notices: changeReport.notices || []
  }, scan.files, {
    isFirstReview: !previousSnapshot
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDERS,
  generateReviewReport,
  generateStructureAreas,
  getDefaultBaseUrl,
  getDefaultModel,
  getProxyUrl,
  getProvider,
  makeFetchOptions,
  normalizeReport,
  summarizeFile,
  testLlmConnection
};
