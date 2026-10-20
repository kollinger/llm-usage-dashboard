import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { conversationDescriptor, sanitizeConversation, createChatUsageIndex, queryChatUsage, periodStart, mergeConversations } = require("../lib/chat-usage");
const { exportUsageEvents, prepareCombinedUsage } = require("../lib/device-sync-data");
const { createUsageAggregation } = require("../lib/usage-aggregation");

const now = Date.now();
const usage = { input_tokens: 80, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 100 };
const event = (providerId, sessionId, timestampMs = now - 1000, extra = {}) => ({
  providerId, sourceId: providerId, timestampMs, model: "fixture-model", usage,
  eventId: `${providerId}:${sessionId}:${timestampMs}`,
  evidence: { sessionId, requestId: providerId === "claudeCode" ? `request-${sessionId}` : undefined },
  conversation: conversationDescriptor(providerId, sessionId, { title: `Title ${sessionId}` }), ...extra
});

const standalone = event("codex", "standalone");
const ticket = { kind: "multica", issueId: "issue-1", workspaceId: "workspace-1", identifier: "FIX-42", title: "Ticket title" };
const owner = event("codex", "owner", now - 1000, { conversation: conversationDescriptor("codex", "owner", { ...ticket, runId: "owner-run", runTitle: "Implement" }) });
const reviewer = event("claudeCode", "review", now - 2000, { conversation: conversationDescriptor("claudeCode", "review", { ...ticket, runId: "review-run", runTitle: "Review" }) });
const unknown = event("gemini", "no-session", now - 5000, { conversation: null });
const old = event("codex", "old", now - 40 * 86_400_000);
const copiedOwner = { ...owner, evidence: { ...owner.evidence, realpath: "/copied/location" } };
const index = createChatUsageIndex([standalone, owner, reviewer, copiedOwner, unknown, old]);
const all = queryChatUsage(index, { now });
assert.equal(all.rows.length, 3);
assert.equal(all.coverage.totalTokens, 500);
assert.equal(all.coverage.assignedTokens, 400);
assert.equal(all.coverage.unassignedTokens, 100);
assert.equal(all.coverage.duplicatesSkipped, 1);
assert.equal(all.rows[0].kind, "multica");
assert.equal(all.rows[0].usage.totalTokens, 200);
assert.equal(all.rows[0].sessionCount, 2);
assert.deepEqual(all.rows[0].providers, ["claudeCode", "codex"]);
assert.equal(all.rows[0].models.length, 2, "same model names retain provider billing semantics");
assert.equal(queryChatUsage(index, { now, period: "week" }).rows.length, 2);
const detail = queryChatUsage(index, { now, id: owner.conversation.id });
assert.equal(detail.row.runs.length, 2);
assert.equal(detail.row.runs.reduce((sum, run) => sum + run.usage.totalTokens, 0), 200);
assert.equal(queryChatUsage(index, { now, id: "a".repeat(64) }).row, null);
assert(!JSON.stringify(all).includes("/copied/location"));
assert(!JSON.stringify(all).includes("workspace-1"));
assert(!JSON.stringify(all).includes("owner-run"));
assert.equal(sanitizeConversation({ ...owner.conversation, id: "../../file" }), null);
assert.equal(conversationDescriptor("codex", "x", { title: "Bearer abcdefghijklmnopqrst /Users/person/private <script>" }).title, "[redacted] [path] script");
for (const title of ["/srv/multica/projects/private/.env", "/private/tmp/customer/order.csv", "/root/.config/secrets.json", "D:\\work\\private.txt", "\\\\nas\\private\\orders.csv"]) {
  assert.equal(conversationDescriptor("codex", "x", { title: `Fix ${title}` }).title, "Fix [path]");
}
assert.equal(conversationDescriptor("codex", "x", { title: "Fix https://example.test/page" }).title, "Fix https://example.test/page");
const unlinkedOwner = { ...owner, conversation: conversationDescriptor("codex", "owner", { title: "Standalone title" }) };
const promoted = exportUsageEvents([{ _usageEvents: [owner, unlinkedOwner] }]).events[0];
assert.equal(promoted.conversation.kind, "multica", "later unlinked copies cannot erase exact ticket metadata");
const conflict = mergeConversations(owner.conversation, conversationDescriptor("codex", "owner", { ...ticket, issueId: "another-issue" }));
assert.equal(conflict.linked, false);
assert.equal(conflict.identifier, null);
assert.equal(mergeConversations(conflict, owner.conversation).linked, false, "conflicting ticket evidence never silently becomes exact again");
assert.notEqual(conversationDescriptor("codex", "same", ticket).id,
  conversationDescriptor("codex", "same", { ...ticket, workspaceId: "workspace-2" }).id);
const dstNow = Date.parse("2026-10-25T12:00:00Z");
assert.equal(periodStart("today", "Europe/Vienna", dstNow), Date.parse("2026-10-24T22:00:00Z"), "DST ending day starts at UTC+2 midnight");
assert.equal(periodStart("today", "Asia/Kolkata", dstNow), Date.parse("2026-10-24T18:30:00Z"));
assert.throws(() => periodStart("invalid", "UTC", now));
assert.throws(() => periodStart("all", "invalid/timezone", now));

const exported = exportUsageEvents([{ _usageEvents: [owner, reviewer] }]);
assert.equal(exported.events.length, 2);
assert(exported.events.every(row => row.conversation));
assert(!JSON.stringify(exported).includes("issue-1"));
const snapshot = (id) => ({ device: { id, name: "Fixture device" }, capturedAt: new Date(now).toISOString(), events: exported.events });
const snapshots = [snapshot("a".repeat(32)), snapshot("b".repeat(32))];
const newerUnlinked = { ...snapshots[0], capturedAt: new Date(now + 1).toISOString(), events: exportUsageEvents([{ _usageEvents: [unlinkedOwner] }]).events };
const olderLinked = { ...snapshots[1], events: exportUsageEvents([{ _usageEvents: [owner] }]).events };
assert.equal(prepareCombinedUsage({}, [newerUnlinked, olderLinked]).events[0].conversation.linked, true, "older exact metadata promotes an unlinked newer observation");
const combined = prepareCombinedUsage({}, snapshots);
const remote = queryChatUsage(createChatUsageIndex(combined.events), { now });
assert.equal(remote.rows[0].usage.totalTokens, 200, "copied requests from two devices count once");
assert.equal(remote.rows[0].kind, "multica");
assert.equal(remote.coverage.duplicatesSkipped, 2);
const legacy = structuredClone(snapshots[0]);
legacy.events.forEach(row => delete row.conversation);
const legacyReport = queryChatUsage(createChatUsageIndex(prepareCombinedUsage({}, [legacy]).events), { now });
assert.equal(legacyReport.coverage.unassignedTokens, 200, "old signed snapshots cannot invent chat attribution");

const worker = createUsageAggregation();
try {
  await worker.aggregateLocal([{ _usageEvents: [owner, reviewer] }], { device: { id: "local", label: "Local" }, snapshots: [] });
  const result = await worker.chats([], "local", { now, period: "all" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].usage.totalTokens, 200);
  assert.equal((await worker.chats(snapshots, "all", { now })).rows[0].usage.totalTokens, 200);
  assert.equal((await worker.chats([legacy], "all", { now })).coverage.unassignedTokens, 200, "worker invalidates metadata indexes when origin revisions change");
  assert.equal((await worker.chats([], "all", { now })).rows.length, 0, "revoked devices leave no stale chat rows");
} finally { await worker.close(); }
console.log("Chat usage: session and ticket aggregation, copied-request dedupe, provider semantics, detail sums, rolling periods, DST, sync compatibility and worker invalidation passed.");
