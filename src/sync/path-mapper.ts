import type { KnowledgeTopic, NoteListItem, NoteTopicRef } from "../api/contracts";

const ILLEGAL_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]/g;
const ILLEGAL_SEGMENT_TEST = /[\\:*?"<>|\u0000-\u001f]/;

export function validateVaultFolder(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  const segments = trimmed.split("/");
  if (!trimmed || segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || ILLEGAL_SEGMENT_TEST.test(segment)
  ))) {
    throw new Error("同步根目录必须是 Vault 内的安全相对路径");
  }
  return segments.join("/");
}

export function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(ILLEGAL_SEGMENT, "_")
    .replace(/\.\.+/g, ".")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

export function buildTopicFolderMap(topics: KnowledgeTopic[]): Map<string, string> {
  const baseCounts = new Map<string, number>();
  for (const topic of topics) {
    const base = sanitizeSegment(topic.name, `知识库-${topic.topic_id}`);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  return new Map(topics.map((topic) => {
    const base = sanitizeSegment(topic.name, `知识库-${topic.topic_id}`);
    const name = (baseCounts.get(base) ?? 0) > 1
      ? `${base}-${topic.topic_id}`
      : base;
    return [topic.topic_id, name];
  }));
}

export function noteFilename(note: NoteListItem): string {
  const title = sanitizeSegment(note.title, "未命名");
  return `${title}-${note.note_id.slice(-8)}.md`;
}

export function topicRefs(note: NoteListItem): Array<NoteTopicRef | null> {
  return note.topics.length > 0 ? note.topics : [null];
}

export function filterExcludedTopicRefs(
  note: NoteListItem,
  excludedTopicIds: Set<string>,
): Array<NoteTopicRef | null> {
  return topicRefs(note).filter((topic) => !topic || !excludedTopicIds.has(topic.id));
}
