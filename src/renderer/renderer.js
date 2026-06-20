const state = {
  projectPath: "",
  busy: false,
  activeTab: "changes",
  expandedAreaIndex: null,
  lastReport: null
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  apiKey: $("#apiKey"),
  baseUrl: $("#baseUrl"),
  changeClusters: $("#changeClusters"),
  chooseProject: $("#chooseProject"),
  closeEvidence: $("#closeEvidence"),
  emptyState: $("#emptyState"),
  effectiveProxy: $("#effectiveProxy"),
  evidenceCode: $("#evidenceCode"),
  evidenceDrawer: $("#evidenceDrawer"),
  evidenceTitle: $("#evidenceTitle"),
  focusItems: $("#focusItems"),
  model: $("#model"),
  noticeStrip: $("#noticeStrip"),
  noticeDetails: $("#noticeDetails"),
  progress: $("#progress"),
  projectPath: $("#projectPath"),
  provider: $("#provider"),
  proxyUrl: $("#proxyUrl"),
  results: $("#results"),
  reviewStats: $("#reviewStats"),
  reviewTitle: $("#reviewTitle"),
  runReview: $("#runReview"),
  saveSettings: $("#saveSettings"),
  structureAreas: $("#structureAreas"),
  tabChanges: $("#tabChanges"),
  tabStructure: $("#tabStructure"),
  changesPanel: $("#changesPanel"),
  structurePanel: $("#structurePanel"),
  testConnection: $("#testConnection")
};

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.runReview.disabled = isBusy;
  elements.chooseProject.disabled = isBusy;
  elements.saveSettings.disabled = isBusy;
  elements.testConnection.disabled = isBusy;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function evidenceButton(ref) {
  const label = ref.label || `${ref.path}:${ref.startLine}`;
  return `<button class="evidence-link" type="button" data-path="${escapeHtml(ref.path)}" data-start="${Number(ref.startLine)}" data-end="${Number(ref.endLine || ref.startLine)}">${escapeHtml(label)}</button>`;
}

function renderEvidenceRefs(refs) {
  if (!refs?.length) return "";
  return `<div class="evidence-row">${refs.map(evidenceButton).join("")}</div>`;
}

function firstSentence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1] : text;
}

function truncate(value, max = 150) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function renderFileChips(files) {
  if (!files?.length) return "";
  return `<div class="file-list">${files
    .map(
      (file) =>
        `<button class="chip file-chip evidence-link" type="button" data-path="${escapeHtml(file)}" data-start="1" data-end="1">${escapeHtml(file)}</button>`
    )
    .join("")}</div>`;
}

function renderStats(result) {
  elements.reviewStats.innerHTML = `
    <div class="stat-line">
      ${Number(result.changedFileCount)} changed · ${Number(result.scannedFileCount)} scanned · ${Number(result.cachedSummaryCount)} cached · ${Number(result.newSummaryCount)} summarized
    </div>
  `;
}

function friendlyError(error) {
  return String(error?.message || error || "Review failed.")
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
}

function renderReport(result) {
  const { report } = result;
  state.lastReport = report;
  state.activeTab = "changes";
  state.expandedAreaIndex = null;
  elements.emptyState.classList.add("hidden");
  elements.results.classList.remove("hidden");
  elements.reviewTitle.textContent = report.isFirstReview
    ? "Snapshot baseline created"
    : "Review since last snapshot";
  renderStats(result);

  const notices = [...(report.parserWarnings || []), ...(report.notices || [])].filter(Boolean);
  elements.noticeDetails.classList.toggle("hidden", notices.length === 0);
  elements.noticeStrip.innerHTML = notices
    .map((notice) => `<div class="notice">${escapeHtml(notice)}</div>`)
    .join("");

  renderTabs();
  renderStructureAreas(report.structureAreas);

  elements.changeClusters.innerHTML = report.changeClusters.length
    ? report.changeClusters
        .map(
          (cluster) => `
            <article class="change-card">
              <div class="area-label">${escapeHtml(cluster.area)}</div>
              <div>
                <p>${escapeHtml(cluster.summary)}</p>
                ${renderFileChips(cluster.files)}
                ${renderEvidenceRefs(cluster.evidenceRefs)}
              </div>
            </article>
          `
        )
        .join("")
    : `<article class="card"><p>No file changes since the last review snapshot.</p></article>`;

  elements.focusItems.innerHTML = report.focusItems
    .map(
      (item) => `
        <article class="focus-card">
          <div class="area-label">${escapeHtml(item.label)}</div>
          <div>
            <p>${escapeHtml(item.why)}</p>
            ${renderEvidenceRefs(item.evidenceRefs)}
          </div>
        </article>
      `
    )
    .join("");
}

function renderTabs() {
  const isChanges = state.activeTab === "changes";
  elements.tabChanges.classList.toggle("active", isChanges);
  elements.tabStructure.classList.toggle("active", !isChanges);
  elements.tabChanges.setAttribute("aria-selected", String(isChanges));
  elements.tabStructure.setAttribute("aria-selected", String(!isChanges));
  elements.changesPanel.classList.toggle("hidden", !isChanges);
  elements.structurePanel.classList.toggle("hidden", isChanges);
}

function renderKeyFunctions(area) {
  if (!area.keyFunctions?.length) {
    return "";
  }

  return `
    <div class="function-list">
      ${area.keyFunctions
        .map(
          (fn) => `
            <article class="function-item">
              <div>
                <h4>${escapeHtml(fn.name)}</h4>
                <p>${escapeHtml(fn.description)}</p>
              </div>
              ${renderEvidenceRefs(fn.evidenceRefs)}
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTechnicalDetail(area) {
  return `
    <details class="technical-detail">
      <summary>Technical detail</summary>
      <div class="technical-block">
        <h4>Files</h4>
        ${renderFileChips(area.livesIn)}
        <h4>Area evidence</h4>
        ${renderEvidenceRefs(area.evidenceRefs)}
        ${
          area.keyFunctions?.length
            ? `<h4>Function refs</h4>${area.keyFunctions
                .map(
                  (fn) => `
                    <div class="technical-function">
                      <strong>${escapeHtml(fn.name)}</strong>
                      ${fn.signature ? `<code>${escapeHtml(fn.signature)}</code>` : ""}
                      ${renderEvidenceRefs(fn.evidenceRefs)}
                    </div>
                  `
                )
                .join("")}`
            : ""
        }
      </div>
    </details>
  `;
}

function renderStructureAreas(areas) {
  elements.structureAreas.innerHTML = (areas || [])
    .map((area, index) => {
      const expanded = state.expandedAreaIndex === index;
      return `
        <article class="area-card ${expanded ? "expanded" : ""}">
          <button class="area-summary" type="button" data-area-index="${index}" aria-expanded="${expanded}">
            <div>
              <h3>${escapeHtml(area.name)}</h3>
              <p>${escapeHtml(truncate(firstSentence(area.purpose), 155))}</p>
            </div>
            <span>${Number(area.livesIn?.length || 0)} files</span>
          </button>
          ${
            expanded
              ? `<div class="area-expanded">
                  <p class="area-purpose">${escapeHtml(area.purpose)}</p>
                  <section>
                    <h4>Key functions</h4>
                    ${renderKeyFunctions(area)}
                  </section>
                  ${renderTechnicalDetail(area)}
                </div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

async function saveSettings() {
  const settings = await window.reviewAccelerator.saveSettings({
    apiKey: elements.apiKey.value,
    baseUrl: elements.baseUrl.value,
    model: elements.model.value,
    provider: elements.provider.value,
    proxyUrl: elements.proxyUrl.value,
    lastProjectPath: state.projectPath
  });
  elements.effectiveProxy.textContent = settings.effectiveProxyUrl
    ? `Using proxy: ${settings.effectiveProxyUrl}`
    : "No proxy detected.";
  elements.progress.textContent = "Settings saved.";
  return settings;
}

async function testConnection() {
  try {
    setBusy(true);
    elements.progress.textContent = "Testing LLM connection.";
    const result = await window.reviewAccelerator.testConnection({
      apiKey: elements.apiKey.value,
      baseUrl: elements.baseUrl.value,
      model: elements.model.value,
      provider: elements.provider.value,
      proxyUrl: elements.proxyUrl.value
    });
    elements.progress.textContent = result.message || "Connection works.";
  } catch (error) {
    elements.progress.textContent = friendlyError(error);
  } finally {
    setBusy(false);
  }
}

async function chooseProject() {
  const folder = await window.reviewAccelerator.chooseProject();
  if (!folder) return;
  state.projectPath = folder;
  elements.projectPath.value = folder;
  await saveSettings();
}

async function runReview() {
  try {
    setBusy(true);
    elements.progress.textContent = "Preparing review.";
    await saveSettings();
    const result = await window.reviewAccelerator.runReview(state.projectPath);
    renderReport(result);
    elements.progress.textContent = "Review ready.";
  } catch (error) {
    elements.progress.textContent = friendlyError(error);
  } finally {
    setBusy(false);
  }
}

async function openEvidence(target) {
  const payload = {
    path: target.dataset.path,
    startLine: Number(target.dataset.start),
    endLine: Number(target.dataset.end)
  };
  const evidence = await window.reviewAccelerator.readEvidence(payload);
  elements.evidenceTitle.textContent = `${evidence.path}:${evidence.startLine}`;
  elements.evidenceCode.innerHTML = evidence.lines
    .map(
      (line) => `
        <div class="code-line ${line.highlighted ? "highlighted" : ""}">
          <span class="line-number">${line.number}</span>
          <span class="line-text">${escapeHtml(line.text || " ")}</span>
        </div>
      `
    )
    .join("");
  elements.evidenceDrawer.classList.remove("hidden");
}

async function init() {
  const settings = await window.reviewAccelerator.getSettings();
  state.projectPath = settings.lastProjectPath || "";
  elements.projectPath.value = state.projectPath;
  elements.provider.innerHTML = (settings.providers || [])
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}" data-base-url="${escapeHtml(provider.defaultBaseUrl)}" data-model="${escapeHtml(provider.defaultModel)}">${escapeHtml(provider.label)}${provider.id === "anthropic" ? " (recommended)" : ""}</option>`
    )
    .join("");
  elements.provider.value = settings.provider || "anthropic";
  elements.apiKey.value = settings.apiKey || "";
  elements.baseUrl.value = settings.baseUrl || "";
  elements.model.value = settings.model || "";
  elements.proxyUrl.value = settings.proxyUrl || "";
  elements.effectiveProxy.textContent = settings.effectiveProxyUrl
    ? `Using proxy: ${settings.effectiveProxyUrl}`
    : "No proxy detected.";

  window.reviewAccelerator.onProgress((payload) => {
    if (payload?.message) elements.progress.textContent = payload.message;
  });

  elements.chooseProject.addEventListener("click", chooseProject);
  elements.saveSettings.addEventListener("click", saveSettings);
  elements.testConnection.addEventListener("click", testConnection);
  elements.runReview.addEventListener("click", runReview);
  elements.provider.addEventListener("change", () => {
    const option = elements.provider.selectedOptions[0];
    elements.baseUrl.value = option?.dataset.baseUrl || elements.baseUrl.value;
    elements.model.value = option?.dataset.model || elements.model.value;
  });
  elements.tabChanges.addEventListener("click", () => {
    state.activeTab = "changes";
    renderTabs();
  });
  elements.tabStructure.addEventListener("click", () => {
    state.activeTab = "structure";
    renderTabs();
  });
  elements.closeEvidence.addEventListener("click", () => elements.evidenceDrawer.classList.add("hidden"));
  document.body.addEventListener("click", (event) => {
    const areaButton = event.target.closest(".area-summary");
    if (areaButton && state.lastReport) {
      const index = Number(areaButton.dataset.areaIndex);
      state.expandedAreaIndex = state.expandedAreaIndex === index ? null : index;
      renderStructureAreas(state.lastReport.structureAreas);
      return;
    }
    const target = event.target.closest(".evidence-link");
    if (target) openEvidence(target);
  });
}

init();
