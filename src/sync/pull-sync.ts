import { normalizePath, Notice, requestUrl, TFile, Vault } from "obsidian";
import type { KnowledgeTopic, NoteDetail, NoteListItem, NoteTopicRef } from "../api/contracts";
import { GetNoteReadApi } from "../api/getnote-api";
import type { PluginSettings } from "../settings";
import type { PluginState, PullMapping } from "./state";
import { mappingKey } from "./state";
import {
  buildTopicFolderMap,
  filterExcludedTopicRefs,
  noteFilename,
  sanitizeSegment,
  validateVaultFolder,
} from "./path-mapper";
import {
  hashText,
  mirrorContentsEquivalent,
  readMirrorIdentity,
  remoteHash,
  renderNoteMarkdown,
} from "./markdown";
import { shouldSkipMirror } from "./decisions";
import { attachmentOwnerNoteId } from "./attachments";

export interface SyncSummary {
  total: number;
  created: number;
  updated: number;
  moved: number;
  skipped: number;
  conflicts: number;
  trashed: number;
  failed: number;
}

export class PullSync {
  private running?: Promise<SyncSummary>;

  constructor(
    private vault: Vault,
    private api: GetNoteReadApi,
    private settings: PluginSettings,
    private state: PluginState,
    private saveState: () => Promise<void>,
    private onStatus: (message: string) => void,
  ) {}

  run(force = false): Promise<SyncSummary> {
    if (this.running) return this.running;
    this.running = this.runInternal(force).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runInternal(force: boolean): Promise<SyncSummary> {
    const summary: SyncSummary = {
      total: 0, created: 0, updated: 0, moved: 0, skipped: 0,
      conflicts: 0, trashed: 0, failed: 0,
    };
    const failures: Array<{ noteId: string; message: string }> = [];
    const root = normalizePath(validateVaultFolder(this.settings.syncFolder));
    await ensureFolder(this.vault, root);

    this.onStatus("正在读取知识库...");
    const allTopics = await this.api.listAllTopics();
    const excludedTopicIds = new Set(
      allTopics
        .filter((topic) => topic.name.trim().toLocaleLowerCase() === "obsidian")
        .map((topic) => topic.topic_id),
    );
    const topics = allTopics.filter((topic) => !excludedTopicIds.has(topic.topic_id));
    const topicFolders = buildTopicFolderMap(topics);
    await this.ensureTopicFolders(root, topics, topicFolders);

    this.onStatus("正在读取笔记清单...");
    const allNotes = await this.api.listAllNotes((loaded, total) => {
      this.onStatus(`正在读取笔记清单：${loaded}/${total}`);
    });
    const notes = allNotes.filter((note) =>
      filterExcludedTopicRefs(note, excludedTopicIds).length > 0,
    );
    summary.total = notes.length;

    const desiredKeys = new Set<string>();
    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      this.onStatus(`正在同步：${index + 1}/${notes.length}`);
      try {
        await this.syncNote(root, note, topicFolders, excludedTopicIds, desiredKeys, summary, force);
      } catch (error) {
        summary.failed += 1;
        failures.push({
          noteId: note.note_id,
          message: error instanceof Error ? error.message : String(error),
        });
        console.error("GetNote sync note failed", note.note_id, error);
      }
    }

    for (const [key, mapping] of Object.entries(this.state.pullMappings)) {
      if (mapping.topicId && excludedTopicIds.has(mapping.topicId)) continue;
      if (desiredKeys.has(key)) continue;
      const file = this.vault.getAbstractFileByPath(mapping.localPath);
      if (file instanceof TFile) {
        await this.vault.trash(file, true);
        summary.trashed += 1;
      }
      await this.trashAttachments(mapping.attachmentPaths ?? [], new Set(), summary);
      delete this.state.pullMappings[key];
    }
    await this.trashOrphanAttachments(
      root,
      new Set(allNotes.map((note) => note.note_id)),
      summary,
    );

    const completedAt = new Date().toISOString();
    if (summary.failed === 0) this.state.lastSuccessfulSyncAt = completedAt;
    this.state.syncHistory = [
      ...(this.state.syncHistory ?? []),
      { completedAt, ...summary, failures },
    ].slice(-20);
    await this.saveState();
    const message = `同步完成：${summary.total} 条，新增 ${summary.created}，更新 ${summary.updated}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
    this.onStatus(message);
    new Notice(message);
    return summary;
  }

  private async ensureTopicFolders(
    root: string,
    topics: KnowledgeTopic[],
    topicFolders: Map<string, string>,
  ): Promise<void> {
    const unclassified = sanitizeSegment(this.settings.unclassifiedFolder, "未归类");
    await ensureFolder(this.vault, normalizePath(`${root}/${unclassified}`));
    for (const topic of topics) {
      const folder = topicFolders.get(topic.topic_id);
      if (folder) await ensureFolder(this.vault, normalizePath(`${root}/${folder}`));
    }
  }

  private async syncNote(
    root: string,
    note: NoteListItem,
    topicFolders: Map<string, string>,
    excludedTopicIds: Set<string>,
    desiredKeys: Set<string>,
    summary: SyncSummary,
    force: boolean,
  ): Promise<void> {
    const noteRemoteHash = remoteHash(note);
    let detail: NoteDetail | undefined;

    for (const topic of filterExcludedTopicRefs(note, excludedTopicIds)) {
      const topicId = topic?.id ?? null;
      const key = mappingKey(note.note_id, topicId);
      desiredKeys.add(key);
      const existing = this.state.pullMappings[key];
      const localFileExists = existing
        ? this.vault.getAbstractFileByPath(existing.localPath) instanceof TFile
        : false;
      const localHashMatches = existing && localFileExists
        ? await this.localMirrorIsUnchanged(existing)
        : false;
      if (shouldSkipMirror({
        force,
        remoteHashMatches: existing?.remoteHash === noteRemoteHash,
        localFileExists,
        localHashMatches,
      })) {
        summary.skipped += 1;
        continue;
      }

      if (!detail && requiresDetail(note)) detail = await this.api.getNoteDetail(note.note_id);
      const folder = topic
        ? topicFolders.get(topic.id) ?? sanitizeSegment(topic.name, `知识库-${topic.id}`)
        : sanitizeSegment(this.settings.unclassifiedFolder, "未归类");
      const targetPath = normalizePath(`${root}/${folder}/${noteFilename(note)}`);
      const attachments = detail
        ? await this.downloadImages(root, folder, note.note_id, detail)
        : { links: new Map<string, string>(), paths: [] };
      const markdown = renderNoteMarkdown(
        note,
        detail,
        topic as NoteTopicRef | null,
        attachments.links,
        this.settings.syncTags,
      );
      await this.writeMirror(
        existing,
        targetPath,
        markdown,
        note,
        topicId,
        noteRemoteHash,
        attachments.paths,
        summary,
      );
    }
  }

  private async localMirrorIsUnchanged(mapping: PullMapping): Promise<boolean> {
    const file = this.vault.getAbstractFileByPath(mapping.localPath);
    if (!(file instanceof TFile)) return false;
    return hashText(await this.vault.read(file)) === mapping.localHash;
  }

  private async writeMirror(
    existing: PullMapping | undefined,
    targetPath: string,
    markdown: string,
    note: NoteListItem,
    topicId: string | null,
    noteRemoteHash: string,
    attachmentPaths: string[],
    summary: SyncSummary,
  ): Promise<void> {
    let storedContent = markdown;
    let file = existing
      ? this.vault.getAbstractFileByPath(existing.localPath)
      : this.vault.getAbstractFileByPath(targetPath);

    if (existing && file instanceof TFile && existing.localPath !== targetPath) {
      const target = this.vault.getAbstractFileByPath(targetPath);
      if (target) targetPath = await uniqueMirrorPath(this.vault, targetPath);
      await this.vault.rename(file, targetPath);
      summary.moved += 1;
      file = this.vault.getAbstractFileByPath(targetPath);
    }

    if (file instanceof TFile && existing) {
      const localContent = await this.vault.read(file);
      if (hashText(localContent) !== existing.localHash) {
        const conflictPath = await uniqueConflictPath(this.vault, file.path);
        await this.vault.create(conflictPath, localContent);
        summary.conflicts += 1;
      }
      await this.vault.modify(file, markdown);
      summary.updated += 1;
    } else if (file instanceof TFile) {
      const localContent = await this.vault.read(file);
      const identity = readMirrorIdentity(localContent);
      const isSameMirror = identity?.noteId === note.note_id && identity.topicId === topicId;
      if (isSameMirror && mirrorContentsEquivalent(localContent, markdown)) {
        storedContent = localContent;
        summary.skipped += 1;
      } else if (isSameMirror) {
        const conflictPath = await uniqueConflictPath(this.vault, file.path);
        await this.vault.create(conflictPath, localContent);
        await this.vault.modify(file, markdown);
        summary.conflicts += 1;
        summary.updated += 1;
      } else {
        const safePath = await uniqueMirrorPath(this.vault, targetPath);
        file = await this.vault.create(safePath, markdown);
        targetPath = safePath;
        summary.created += 1;
      }
    } else {
      file = await this.vault.create(targetPath, markdown);
      summary.created += 1;
    }

    await this.trashAttachments(
      existing?.attachmentPaths ?? [],
      new Set(attachmentPaths),
      summary,
    );
    this.state.pullMappings[mappingKey(note.note_id, topicId)] = {
      noteId: note.note_id,
      topicId,
      localPath: file.path,
      remoteHash: noteRemoteHash,
      localHash: hashText(storedContent),
      remoteUpdatedAt: note.updated_at,
      lastSyncedAt: new Date().toISOString(),
      attachmentPaths,
    };
  }

  private async downloadImages(
    root: string,
    folder: string,
    noteId: string,
    detail: NoteDetail,
  ): Promise<{ links: Map<string, string>; paths: string[] }> {
    const links = new Map<string, string>();
    const paths: string[] = [];
    if (!this.settings.downloadImages) return { links, paths };
    const attachmentFolder = normalizePath(`${root}/${folder}/_attachments`);

    for (let index = 0; index < detail.attachments.length; index += 1) {
      const attachment = detail.attachments[index];
      if (!attachment.type.toLowerCase().includes("image") || !attachment.url) continue;
      await ensureFolder(this.vault, attachmentFolder);
      const extension = imageExtension(attachment.url, attachment.type);
      const name = `${noteId}-${index + 1}.${extension}`;
      const path = normalizePath(`${attachmentFolder}/${name}`);
      if (!this.vault.getAbstractFileByPath(path)) {
        const response = await requestUrl({ url: attachment.url, throw: false });
        if (response.status >= 400) throw new Error(`图片下载失败：HTTP ${response.status}`);
        await this.vault.createBinary(path, response.arrayBuffer);
      }
      links.set(attachment.url, `./_attachments/${name}`);
      paths.push(path);
    }
    return { links, paths };
  }

  private async trashAttachments(
    paths: string[],
    retained: Set<string>,
    summary: SyncSummary,
  ): Promise<void> {
    for (const path of paths) {
      if (retained.has(path)) continue;
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      await this.vault.trash(file, true);
      summary.trashed += 1;
    }
  }

  private async trashOrphanAttachments(
    root: string,
    activeNoteIds: Set<string>,
    summary: SyncSummary,
  ): Promise<void> {
    for (const file of this.vault.getFiles()) {
      const noteId = attachmentOwnerNoteId(file.path, root);
      if (!noteId || activeNoteIds.has(noteId)) continue;
      await this.vault.trash(file, true);
      summary.trashed += 1;
    }
  }
}

function requiresDetail(note: NoteListItem): boolean {
  return ["link", "img_text", "internal_record"].includes(note.note_type);
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const segments = normalizePath(path).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

async function uniqueConflictPath(vault: Vault, originalPath: string): Promise<string> {
  const stem = originalPath.replace(/\.md$/i, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = `${stem}.local-conflict-${timestamp}.md`;
  let counter = 1;
  while (vault.getAbstractFileByPath(candidate)) {
    candidate = `${stem}.local-conflict-${timestamp}-${counter}.md`;
    counter += 1;
  }
  return candidate;
}

async function uniqueMirrorPath(vault: Vault, targetPath: string): Promise<string> {
  const stem = targetPath.replace(/\.md$/i, "");
  let counter = 1;
  let candidate = `${stem}-sync.md`;
  while (vault.getAbstractFileByPath(candidate)) {
    candidate = `${stem}-sync-${counter}.md`;
    counter += 1;
  }
  return candidate;
}

function imageExtension(url: string, type: string): string {
  const match = url.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  if (match) return match[1].toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  return "jpg";
}
