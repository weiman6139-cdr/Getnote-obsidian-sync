# 得到大脑同步

得到大脑与 Obsidian 之间的受控同步插件。

<p align="center">
  <img src="./assets/obsidian-console.png" alt="Obsidian 操作台截图" width="840" />
</p>

## 功能

- 得到大脑到 Obsidian 自动同步。
- Obsidian 到得到大脑手动推送。
- 得到大脑操作台：列表、详情、分页、筛选、搜索、记笔记、标签、知识库归类。
- 图片同步、附件下载、冲突副本、删除回收、孤儿附件清理。
- 当前文件、右键单文件、多选批量推送。

## 双向同步原理

插件采用“得到大脑为远端知识源、Obsidian 为本地镜像与编辑端”的受控双向模型：

- **得到大脑 -> Obsidian**：启动、定时或手动同步时，插件按笔记 ID 拉取远端列表和详情，按知识库映射到 Vault 内的 Markdown 文件，并用 frontmatter 保存远端 ID、知识库 ID、内容哈希和同步时间。
- **Obsidian -> 得到大脑**：用户从命令面板、文件右键、多选右键或操作台明确触发推送。插件根据本地路径和 frontmatter 找到远端笔记，区分创建与更新，并统一写入得到大脑的 `Obsidian` 知识库。
- **变更判断**：同步同时比较远端内容哈希、本地镜像哈希和本地文件状态；两端都未变化时跳过，避免重复写入。
- **安全边界**：自动同步只读拉取；所有创建、更新、标签、知识库归类和删除回收操作都需要用户动作确认，不会因为定时任务自动改写远端内容。
- **冲突与附件**：本地手工修改不会被静默覆盖；插件保留冲突副本和失败清单。图片与附件按远端身份落入专用 `_attachments` 目录，并支持孤儿附件清理。

## 安装

### 社区插件安装

插件通过 Obsidian Community plugins 分发后，可以在 Obsidian 内直接搜索安装。

### 手动安装

将以下文件放入 Vault 的 `.obsidian/plugins/getnote-sync/`：

```text
main.js
manifest.json
styles.css
```

然后在 Obsidian 中启用第三方插件 `得到大脑同步`。

## 配置

在插件设置页填写：

- `API Key`：以 `gk_live_` 开头。
- `Client ID`
- `同步根目录`：默认 `得到同步资料`
- `自动同步间隔`
- `同步标签`
- `下载图片`

点击“测试连接”可验证当前配置。

## 使用

### 自动同步

插件会在启动、定时或手动触发时，把得到大脑内容同步到本地 Vault。

默认目录结构如下：

```text
得到同步资料/
├── <知识库名称>/
│   ├── <笔记标题>-<ID 后 8 位>.md
│   └── _attachments/
└── 未归类/
```

### 手动推送

在 Obsidian 里可以通过以下入口把笔记推送到得到大脑：

- 命令面板：`推送当前笔记到得到大脑`
- 文件右键：推送单个 Markdown 文件
- 多选右键：批量推送 Markdown 文件

所有手动推送统一进入得到大脑的 `Obsidian` 知识库。

### 操作台

打开 `得到大脑操作台` 后，可以：

- 看笔记列表和详情
- 按知识库筛选
- 全局或指定知识库语义搜索
- 创建文本、链接、图片笔记
- 管理标签
- 创建知识库
- 归类笔记到目标知识库

## 截图

<p align="center">
  <img src="./assets/obsidian-settings.png" alt="Obsidian 设置页截图" width="840" />
</p>

<p align="center">
  <img src="./assets/obsidian-console.png" alt="Obsidian 操作台截图" width="840" />
</p>

<p align="center">
  <img src="./assets/obsidian-push-confirm.png" alt="Obsidian 推送确认截图" width="840" />
</p>

## 发布与更新

发布到 Obsidian Community directory 后，用户可以直接在社区插件市场安装。

后续更新只需要：

1. 修改代码并重新构建 `main.js`
2. 更新 `manifest.json` 版本号
3. 创建新的 GitHub Release
4. 上传 `main.js`、`manifest.json`、`styles.css`

## 构建

```bash
npm install
npm run typecheck
npm test
npm run build
```

## 安全

- 自动同步只读拉取。
- 写入、更新、标签和知识库操作都必须由用户动作触发。
- 凭证只保存在插件的 `data.json` 中。
- 写请求不自动重试，避免重复创建。

## 说明

阶段 0 的真实接口验证记录见 [docs/stage-0-findings.md](docs/stage-0-findings.md)。完整设计与验收记录见 [docs/e2e-acceptance-20260817.md](docs/e2e-acceptance-20260817.md)。
