import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { build } from "esbuild";
import YAML from "yaml";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "getnote-sync-test-"));
const outputFile = path.join(tempDir, "sync-unit.cjs");

await build({
  stdin: {
    contents: [
      'export * from "./src/sync/decisions.ts";',
      'export * from "./src/sync/path-mapper.ts";',
      'export * from "./src/sync/markdown.ts";',
      'export * from "./src/sync/state.ts";',
      'export * from "./src/sync/attachments.ts";',
      'export * from "./src/api/normalize.ts";',
    ].join("\n"),
    resolveDir: projectRoot,
    sourcefile: "sync-unit-entry.ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: outputFile,
});

const {
  buildTopicFolderMap,
  filterExcludedTopicRefs,
  attachmentOwnerNoteId,
  noteFilename,
  normalizeNoteDetail,
  normalizeNoteListItem,
  normalizeSearchResults,
  normalizeTopic,
  mirrorContentsEquivalent,
  remoteHash,
  renderNoteMarkdown,
  readMirrorIdentity,
  renamePushMapping,
  sanitizeSegment,
  shouldSkipMirror,
  topicRefs,
  validateVaultFolder,
} = await import(`${new URL(`file://${outputFile}`).href}?v=${Date.now()}`);

after(async () => rm(tempDir, { recursive: true, force: true }));

const topic = (id, name) => ({ topic_id: id, id, name });
const note = (overrides = {}) => ({
  id: "1918605423840367588",
  note_id: "1918605423840367588",
  note_type: "plain_text",
  title: "测试笔记",
  content: "正文",
  ref_content: "",
  source: "",
  tags: [{ id: "tag-1", name: "标签", type: "user" }],
  topics: [{ id: "topic-1", name: "知识库" }],
  created_at: "2026-08-17T00:00:00Z",
  updated_at: "2026-08-17T01:00:00Z",
  children_count: 0,
  is_child_note: false,
  ...overrides,
});

test("仅远端和本地均未变化时跳过镜像", () => {
  assert.equal(shouldSkipMirror({
    force: false,
    remoteHashMatches: true,
    localFileExists: true,
    localHashMatches: true,
  }), true);
  assert.equal(shouldSkipMirror({
    force: false,
    remoteHashMatches: true,
    localFileExists: true,
    localHashMatches: false,
  }), false);
  assert.equal(shouldSkipMirror({
    force: true,
    remoteHashMatches: true,
    localFileExists: true,
    localHashMatches: true,
  }), false);
});

test("路径片段清理非法字符和上级目录片段", () => {
  const result = sanitizeSegment('../财务\\报告:*?"<>|', "fallback");
  assert.equal(result.includes("/"), false);
  assert.equal(result.includes("\\"), false);
  assert.equal(result.includes(".."), false);
});

test("同步根目录只接受 Vault 内安全相对路径", () => {
  assert.equal(validateVaultFolder("资料/得到同步"), "资料/得到同步");
  assert.throws(() => validateVaultFolder("../Vault外"), /安全相对路径/);
  assert.throws(() => validateVaultFolder(".obsidian\\plugins"), /安全相对路径/);
});

test("同名知识库生成稳定且不同的目录", () => {
  const folders = buildTopicFolderMap([topic("topic-1", "同名"), topic("topic-2", "同名")]);
  assert.equal(folders.get("topic-1"), "同名-topic-1");
  assert.equal(folders.get("topic-2"), "同名-topic-2");
});

test("笔记文件名包含 ID 后缀且无归类时映射到 null", () => {
  assert.equal(noteFilename(note({ title: "" })), "未命名-40367588.md");
  assert.deepEqual(topicRefs(note({ topics: [] })), [null]);
});

test("拉取同步排除 Obsidian 知识库，但保留其他知识库和未归类笔记", () => {
  const excluded = new Set(["topic-obsidian"]);
  assert.deepEqual(
    filterExcludedTopicRefs(note({ topics: [{ id: "topic-obsidian", name: "Obsidian" }] }), excluded),
    [],
  );
  assert.deepEqual(
    filterExcludedTopicRefs(note({ topics: [
      { id: "topic-obsidian", name: "Obsidian" },
      { id: "topic-1", name: "知识库" },
    ] }), excluded),
    [{ id: "topic-1", name: "知识库" }],
  );
  assert.deepEqual(filterExcludedTopicRefs(note({ topics: [] }), excluded), [null]);
});

test("Markdown 包含可解析的镜像元数据和标签", () => {
  const markdown = renderNoteMarkdown(note(), undefined, { id: "topic-1", name: "知识库" }, new Map(), true);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1];
  assert.ok(frontmatter);
  const data = YAML.parse(frontmatter);
  assert.equal(data.getnote_id, "1918605423840367588");
  assert.equal(data.getnote_mirror, true);
  assert.deepEqual(data.tags, ["标签"]);
});

test("孤立镜像可按远端身份接管且忽略同步时间差异", () => {
  const first = renderNoteMarkdown(note(), undefined, { id: "topic-1", name: "知识库" }, new Map(), true);
  const second = first.replace(/getnote_synced_at: .+/, "getnote_synced_at: 2026-08-18T00:00:00.000Z");
  assert.deepEqual(readMirrorIdentity(first), {
    noteId: "1918605423840367588",
    topicId: "topic-1",
  });
  assert.equal(mirrorContentsEquivalent(first, second), true);
  assert.equal(mirrorContentsEquivalent(first, `${second}\n本地修改`), false);
});

test("知识库关系变化会改变远端哈希", () => {
  assert.notEqual(remoteHash(note()), remoteHash(note({ topics: [] })));
});

test("运行时适配器统一字符串 ID 并补齐可选数组", () => {
  const normalized = normalizeNoteListItem({
    id: 1918605423840367588n,
    note_type: "plain_text",
    title: null,
  });
  assert.equal(normalized.note_id, "1918605423840367588");
  assert.equal(normalized.title, "");
  assert.deepEqual(normalized.tags, []);
  assert.deepEqual(normalized.topics, []);

  const detail = normalizeNoteDetail({ note_id: "note-1", attachments: null });
  assert.deepEqual(detail.attachments, []);
});

test("运行时适配器拒绝缺失关键身份字段", () => {
  assert.throws(() => normalizeNoteListItem({ title: "无 ID" }), /note_id/);
  assert.throws(() => normalizeTopic({ name: "无 ID" }), /topic_id/);
});

test("语义搜索跳过无法打开详情的无 ID 召回条目", () => {
  const results = normalizeSearchResults([
    { note_id: "note-1", title: "有效结果", content: "正文" },
    { title: "接口返回但缺少 ID", content: "无法打开详情" },
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].note_id, "note-1");
});

test("文件重命名直接迁移推送映射且保留远端身份", () => {
  const state = {
    schemaVersion: 1,
    pullMappings: {},
    pushMappings: {
      "旧路径.md": {
        localPath: "旧路径.md",
        remoteNoteId: "remote-1",
        remoteTopicId: "topic-1",
        lastPushedHash: "hash-1",
        lastPushedAt: "2026-08-17T00:00:00Z",
      },
    },
  };

  assert.equal(renamePushMapping(state, "旧路径.md", "新路径.md"), true);
  assert.equal(state.pushMappings["旧路径.md"], undefined);
  assert.deepEqual(state.pushMappings["新路径.md"], {
    localPath: "新路径.md",
    remoteNoteId: "remote-1",
    remoteTopicId: "topic-1",
    lastPushedHash: "hash-1",
    lastPushedAt: "2026-08-17T00:00:00Z",
  });
  assert.equal(renamePushMapping(state, "不存在.md", "其他.md"), false);
});

test("仅识别同步根目录下由插件命名的附件", () => {
  assert.equal(
    attachmentOwnerNoteId("得到同步资料/Obsidian/_attachments/1918736851984876424-1.jpg", "得到同步资料"),
    "1918736851984876424",
  );
  assert.equal(
    attachmentOwnerNoteId("其他目录/Obsidian/_attachments/1918736851984876424-1.jpg", "得到同步资料"),
    undefined,
  );
  assert.equal(
    attachmentOwnerNoteId("得到同步资料/Obsidian/_attachments/用户图片.jpg", "得到同步资料"),
    undefined,
  );
});
