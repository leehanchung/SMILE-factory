import test from "node:test";
import assert from "node:assert/strict";
import { newState, restoreState, normalizeState, attachmentMetadata, createFolder, renameThread, deleteThread, setThreadFolder, searchThreads, sendMessage, exportMarkdown, MODELS } from "../web/workspace/model.js";

test("conversation and report persist with model and metadata, never file bytes", () => {
  let state = createFolder(newState(), "Comparisons", "folder-1"); state.model = MODELS[2];
  const sent = sendMessage(state, { id: "thread-1", prompt: "Compare two algorithms", folderId: "folder-1", attachments: [{ name: "results.csv", size: 42, type: "text/csv", secretContents: "never copied" }], now: "2026-11-10T00:00:00Z" });
  assert.equal(sent.threadId, "thread-1"); assert.equal(state.threads.length, 0);
  const restored = restoreState(JSON.stringify(sent.state));
  assert.deepEqual(restored, sent.state); assert.equal(restored.threads[0].messages.length, 2);
  assert.equal(restored.threads[0].folderId, "folder-1"); assert.equal(restored.threads[0].model, MODELS[2]);
  assert.match(restored.threads[0].report, /no model was called/); assert.match(restored.threads[0].report, /metadata only/);
  assert.ok(!JSON.stringify(restored).includes("never copied"));
  const reply = sendMessage(restored, { threadId: "thread-1", id: "unused", prompt: "Which metrics?" });
  assert.equal(reply.state.threads.length, 1); assert.equal(reply.state.threads[0].messages.length, 4);
});
test("malformed or future storage restores to an empty safe workspace", () => {
  for (const raw of [null, "", "{", "null", "[]", '{"version":2}']) assert.deepEqual(restoreState(raw), newState());
  const state = normalizeState({ version: 1, folders: [null, { id: "f", name: "Work" }, { id: "f", name: "duplicate" }], threads: [null, { id: "t", messages: [null, { role: "system", content: "ignored" }, { role: "user", content: 42, attachments: {} }], folderId: "missing" }, { id: "t" }], model: "unknown" });
  assert.equal(state.folders.length, 1); assert.equal(state.threads.length, 1); assert.equal(state.threads[0].folderId, null);
  assert.deepEqual(state.threads[0].messages, [{ role: "user", content: "", attachments: [] }]); assert.equal(state.model, MODELS[0]);
});
test("rename, search, folder move, and deletion operate on selected thread", () => {
  let state = sendMessage(newState(), { id: "a", prompt: "Investigate calibration" }).state;
  state = sendMessage(state, { id: "b", prompt: "Investigate speed" }).state;
  state = renameThread(state, "a", "Reliability"); state = createFolder(state, "Eval", "f"); state = setThreadFolder(state, "a", "f");
  assert.deepEqual(searchThreads(state, "CALIBRATION", "f").map(t => t.id), ["a"]);
  assert.deepEqual(searchThreads(state, "", null).map(t => t.id), ["b"]);
  assert.equal(renameThread(state, "a", "   "), state);
  assert.deepEqual(deleteThread(state, "b").threads.map(t => t.id), ["a"]);
  assert.equal(setThreadFolder(state, "a", "missing").threads.find(t => t.id === "a").folderId, null);
});
test("user markup remains literal text in model and exports", () => {
  const prompt = '<img src=x onerror="alert(1)">';
  const result = sendMessage(newState(), { id: "x", prompt });
  assert.equal(result.state.threads[0].messages[0].content, prompt);
  assert.ok(exportMarkdown(result.state.threads[0]).includes(prompt));
  assert.match(exportMarkdown(result.state.threads[0]), /No model called/);
  assert.deepEqual(attachmentMetadata([{ name: "file", size: -1 }, null]), [{ name: "file", size: 0, type: "" }]);
});
test("empty requests and identifier collisions do not create threads", () => {
  const state = newState(); assert.equal(sendMessage(state, { id: "a", prompt: " " }).state, state);
  const created = sendMessage(state, { id: "a", prompt: "Hello" }).state;
  assert.equal(sendMessage(created, { id: "a", prompt: "Collision" }).state, created);
});
