export const STORAGE_KEY = "rea_astra.workspace.v1";
export const MODELS = ["Silico research (simulated)", "Fast research (simulated)", "Deep research (simulated)"];
const clean = (value, limit = 20000) => typeof value === "string" ? value.slice(0, limit) : "";
export const newState = () => ({ version: 1, folders: [], threads: [], model: MODELS[0], autoResearch: true });

export function attachmentMetadata(files) {
  return Array.from(files || []).slice(0, 20).filter(f => f && typeof f.name === "string").map(f => ({
    name: clean(f.name, 300), size: Number.isFinite(f.size) && f.size >= 0 ? f.size : 0, type: clean(f.type, 100),
  }));
}
export function normalizeState(value) {
  const state = newState();
  if (!value || value.version !== 1) return state;
  const ids = new Set();
  for (const folder of Array.isArray(value.folders) ? value.folders.slice(0, 100) : []) {
    const id = clean(folder?.id, 100), name = clean(folder?.name, 100).trim();
    if (!id || !name || ids.has(id)) continue;
    ids.add(id); state.folders.push({ id, name });
  }
  const threadIds = new Set();
  for (const thread of Array.isArray(value.threads) ? value.threads.slice(0, 500) : []) {
    const id = clean(thread?.id, 100);
    if (!id || threadIds.has(id)) continue;
    threadIds.add(id);
    state.threads.push({ id, title: clean(thread.title, 200).trim() || "Untitled research",
      folderId: state.folders.some(f => f.id === thread.folderId) ? thread.folderId : null,
      createdAt: clean(thread.createdAt, 50), model: MODELS.includes(thread.model) ? thread.model : MODELS[0],
      messages: (Array.isArray(thread.messages) ? thread.messages : []).slice(-1000).filter(m => m && ["user", "assistant"].includes(m.role)).map(m => ({ role: m.role, content: clean(m.content), attachments: attachmentMetadata(Array.isArray(m.attachments) ? m.attachments : []) })),
      report: clean(thread.report, 50000),
    });
  }
  state.model = MODELS.includes(value.model) ? value.model : MODELS[0];
  state.autoResearch = typeof value.autoResearch === "boolean" ? value.autoResearch : true;
  return state;
}
export function restoreState(raw) {
  try { return normalizeState(JSON.parse(raw)); } catch { return newState(); }
}
export function createFolder(state, name, id) {
  const title = clean(name, 100).trim();
  if (!title || state.folders.some(f => f.id === id) || state.folders.length >= 100) return state;
  return { ...state, folders: [...state.folders, { id, name: title }] };
}
export function renameThread(state, id, title) {
  const name = clean(title, 200).trim();
  if (!name) return state;
  return { ...state, threads: state.threads.map(t => t.id === id ? { ...t, title: name } : t) };
}
export function deleteThread(state, id) {
  return { ...state, threads: state.threads.filter(t => t.id !== id) };
}
export function setThreadFolder(state, id, folderId) {
  const folder = state.folders.some(f => f.id === folderId) ? folderId : null;
  return { ...state, threads: state.threads.map(t => t.id === id ? { ...t, folderId: folder } : t) };
}
export function searchThreads(state, query, folderId = "all") {
  const needle = clean(query).toLowerCase().trim();
  return state.threads.filter(t => (folderId === "all" || t.folderId === folderId) && (!needle || [t.title, ...t.messages.map(m => m.content)].join("\n").toLowerCase().includes(needle)));
}
export function simulateResearch(prompt, autoResearch = true, attachmentCount = 0) {
  return `Local simulation — no model was called, no web search was performed, and no experiment was run.\n\nResearch question\n${prompt}\n\nSuggested investigation\n1. Define a measurable question and a baseline.\n2. Collect primary evidence and record its provenance.\n3. Compare alternatives using a small reproducible experiment.\n4. Summarize results, uncertainty, and next steps.\n\n${autoResearch ? "Auto-research is enabled in this demo; these are proposed steps only." : "Auto-research is off; this is a planning outline only."}\n${attachmentCount ? `${attachmentCount} attachment(s) recorded as metadata only; their contents were not read or uploaded.` : "No attachments were used."}\n\nEvidence status\nNo external evidence has been collected. All suggested findings remain unverified.`;
}
export function sendMessage(state, { threadId, id, prompt, folderId = null, attachments = [], now = new Date().toISOString() }) {
  const content = clean(prompt).trim();
  if (!content) return { state, threadId: threadId || null };
  const existing = state.threads.find(t => t.id === threadId);
  if (!existing && (state.threads.some(t => t.id === id) || state.threads.length >= 500)) return { state, threadId: null };
  const meta = attachmentMetadata(attachments), response = simulateResearch(content, state.autoResearch, meta.length);
  const thread = existing || { id, title: content.replace(/\s+/g, " ").slice(0, 70), folderId: state.folders.some(f => f.id === folderId) ? folderId : null, createdAt: now, messages: [], model: state.model, report: "" };
  const updated = { ...thread, model: state.model, messages: [...thread.messages, { role: "user", content, attachments: meta }, { role: "assistant", content: response, attachments: [] }].slice(-1000), report: `# ${thread.title}\n\n${response}\n` };
  return { state: { ...state, threads: [updated, ...state.threads.filter(t => t.id !== updated.id)] }, threadId: updated.id };
}
export function exportMarkdown(thread) {
  if (!thread) return "# Local simulation\n\nNo thread selected.\n";
  return `# ${thread.title}\n\nLocal simulation. No model called.\n\n` + thread.messages.map(m => `## ${m.role === "user" ? "You" : "Local research simulator"}\n\n${m.content}\n${m.attachments.length ? "\nAttachments (metadata only):\n" + m.attachments.map(a => `- ${a.name} (${a.size} bytes)`).join("\n") : ""}`).join("\n\n") + "\n";
}
