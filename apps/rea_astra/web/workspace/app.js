import { STORAGE_KEY, MODELS, newState, restoreState, attachmentMetadata, createFolder, renameThread, deleteThread, setThreadFolder, searchThreads, sendMessage, exportMarkdown } from "./model.js";

const $ = id => document.getElementById(id);
let state, activeId = null, page = "research", draftAttachments = [], storageError = false;
try { state = restoreState(localStorage.getItem(STORAGE_KEY)); } catch { state = newState(); storageError = true; }
const uid = () => crypto.randomUUID();
const selected = () => state.threads.find(t => t.id === activeId);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function status(message) { $("status").textContent = message || (storageError ? "Browser storage unavailable or full. Export JSON to keep your work; changes currently live in memory." : "Local simulation · No model called · Attachments stay on your device"); }
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageError = false; } catch { storageError = true; }
  status();
}
function option(select, value, label) { const item = element("option", null, label); item.value = value; select.append(item); }
function renderFolders() {
  const previous = $("folder-filter").value || "all";
  $("folder-filter").replaceChildren(); option($("folder-filter"), "all", "All folders"); option($("folder-filter"), "", "Unfiled");
  $("thread-folder").replaceChildren(); option($("thread-folder"), "", "No folder");
  for (const folder of state.folders) { option($("folder-filter"), folder.id, folder.name); option($("thread-folder"), folder.id, folder.name); }
  $("folder-filter").value = previous;
  if ($("folder-filter").selectedIndex < 0) $("folder-filter").value = "all";
  $("thread-folder").value = selected()?.folderId || "";
}
function renderSidebar() {
  const container = $("thread-list"); container.replaceChildren();
  const filter = $("folder-filter").value;
  const threads = searchThreads(state, $("search").value, filter === "" ? null : filter);
  if (!threads.length) container.append(element("p", "empty-sidebar", state.threads.length ? "No matching threads." : "Your research starts here. Create a thread to keep your ideas together."));
  for (const thread of threads) {
    const button = element("button", "thread-link" + (thread.id === activeId && page === "research" ? " active" : ""), thread.title);
    button.title = thread.title; button.setAttribute("aria-current", thread.id === activeId && page === "research" ? "page" : "false");
    button.addEventListener("click", () => openThread(thread.id)); container.append(button);
  }
  $("report-count").textContent = String(state.threads.filter(t => t.report).length);
  $("reports-nav").classList.toggle("primary-nav", page === "reports");
  $("new-thread").classList.toggle("primary-nav", !activeId && page === "research");
}
function renderMessages() {
  const thread = selected(), container = $("messages"); container.replaceChildren();
  $("welcome").hidden = !!thread; $("thread-toolbar").hidden = !thread; $("suggestions").hidden = !!thread;
  $("thread-title").textContent = thread?.title || "";
  for (const message of thread?.messages || []) {
    const card = element("article", "message " + message.role);
    card.append(element("div", "message-label", message.role === "user" ? "You" : "✳  Local research simulator"), element("div", "message-text", message.content));
    for (const file of message.attachments) card.append(element("div", "message-attachment", `Attachment metadata: ${file.name} · ${file.size.toLocaleString()} bytes`));
    container.append(card);
  }
}
function download(name, content, type) {
  const blob = new Blob([content], { type }), url = URL.createObjectURL(blob), link = element("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportThread(thread, report = false) { download(`research-${thread.id}.md`, report ? thread.report.replace(/^# .*\n/, `# ${thread.title}\n`) : exportMarkdown(thread), "text/markdown;charset=utf-8"); }
function renderReports() {
  const list = $("reports-list"); list.replaceChildren();
  const reports = state.threads.filter(t => t.report);
  if (!reports.length) list.append(element("p", "empty-sidebar", "No reports yet. Start a thread to create a local research outline."));
  for (const thread of reports) {
    const card = element("article", "report-card"), heading = element("h2", null, thread.title);
    const open = element("button", "quiet-button", "Open thread"), exportButton = element("button", "quiet-button", "Export Markdown");
    open.addEventListener("click", () => openThread(thread.id)); exportButton.addEventListener("click", () => exportThread(thread, true));
    const details = element("details"), summary = element("summary", "quiet-button", "Read outline"), body = element("pre", "report-body", thread.report.replace(/^# .*\n/, `# ${thread.title}\n`));
    details.append(summary, body); card.append(heading, element("p", null, "Local simulation · Proposed investigation, not verified findings"), open, exportButton, details); list.append(card);
  }
}
function renderAttachments() {
  const list = $("attachments"); list.replaceChildren();
  draftAttachments.forEach((file, index) => { const chip = element("span", "attachment-chip", file.name), remove = element("button", null, "×"); remove.type = "button"; remove.setAttribute("aria-label", `Remove ${file.name}`); remove.addEventListener("click", () => { draftAttachments.splice(index, 1); renderAttachments(); }); chip.append(remove); list.append(chip); });
}
function render() {
  $("research-view").hidden = page !== "research"; $("reports-view").hidden = page !== "reports";
  renderFolders(); renderSidebar(); renderMessages(); renderReports(); renderAttachments();
  $("model").value = state.model; $("auto-research").checked = state.autoResearch; status();
}
function openThread(id) { activeId = id; page = "research"; draftAttachments = []; $("prompt").value = ""; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function startThread() { activeId = null; page = "research"; draftAttachments = []; $("prompt").value = ""; render(); $("prompt").focus(); }
for (const model of MODELS) option($("model"), model, model);
$("new-thread").addEventListener("click", startThread);
$("reports-nav").addEventListener("click", () => { page = "reports"; render(); });
$("search").addEventListener("input", renderSidebar); $("folder-filter").addEventListener("change", renderSidebar);
$("new-folder").addEventListener("click", () => { const name = window.prompt("Folder name"); if (!name?.trim()) return; state = createFolder(state, name, uid()); save(); render(); });
$("thread-folder").addEventListener("change", () => { if (!activeId) return; state = setThreadFolder(state, activeId, $("thread-folder").value); save(); renderSidebar(); });
$("rename-thread").addEventListener("click", () => { const thread = selected(); if (!thread) return; const title = window.prompt("Rename thread", thread.title); if (!title?.trim()) return; state = renameThread(state, thread.id, title); save(); render(); });
$("delete-thread").addEventListener("click", () => { const thread = selected(); if (!thread || !window.confirm(`Delete “${thread.title}” and its local report?`)) return; state = deleteThread(state, thread.id); save(); startThread(); });
$("export-thread").addEventListener("click", () => { if (selected()) exportThread(selected()); });
$("export-all").addEventListener("click", () => download("rea-astra-workspace.json", JSON.stringify(state, null, 2), "application/json"));
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", event => { draftAttachments = attachmentMetadata([...draftAttachments, ...event.target.files]); event.target.value = ""; renderAttachments(); status("Attachment names, sizes, and types only. File contents are never read or uploaded."); });
$("model").addEventListener("change", () => { state = { ...state, model: $("model").value }; save(); });
$("auto-research").addEventListener("change", () => { state = { ...state, autoResearch: $("auto-research").checked }; save(); });
$("models-info").addEventListener("click", () => { status("All model choices are local simulations. They do not call a model or change real research quality."); $("model").focus(); });
$("code-prompt").addEventListener("click", () => { $("prompt").value = "Plan a reproducible coding experiment: state the hypothesis, baseline, metrics, and validation steps."; $("prompt").focus(); });
$("repository").addEventListener("change", () => status("Repository selection is a visual demo only. No repository is opened, read, or connected."));
document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => { $("prompt").value = button.dataset.prompt; $("prompt").focus(); }));
$("composer").addEventListener("submit", event => {
  event.preventDefault(); if (!$("prompt").value.trim()) return;
  const result = sendMessage(state, { threadId: activeId, id: uid(), prompt: $("prompt").value, attachments: draftAttachments, folderId: $("thread-folder").value || null });
  if (!result.threadId) { status("Workspace limit reached. Export your work and delete a thread before adding another."); return; }
  state = result.state; activeId = result.threadId; draftAttachments = []; $("prompt").value = ""; save(); render(); $("prompt").focus();
});
$("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $("composer").requestSubmit(); } });
document.addEventListener("keydown", event => { if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); startThread(); } });
render();
