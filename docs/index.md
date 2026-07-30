# 无限画布文档索引

## 项目介绍

- [功能介绍](features.md)
- [Docker 部署](deployment.md)
- [本地开发](local-development.md)
- [第三方 GitHub 提示词仓库](third-party-prompt-repositories.md)

## 操作手册

- [画布节点操作手册](canvas-node-manual.md)
- [画布快捷键](canvas-shortcuts.md)

## 开发文档

- [接口响应约定](api-response.md)
- [系统配置数据结构](system-settings.md)
- [后端数据库说明](backend-database.md)
- [画布数据结构](canvas-data-structure.md)
- [图片接口故障模拟器](image-api-fixtures.md)

## 合并与差异

- [纯生图拆分与 PR #43 合并说明](upstream-merge-v0.3.3.md)
- [上游非视频音频功能合并说明](upstream-non-av-agent-gemini.md)
- [上游与生图参考项目功能审查](upstream-and-playground-review.md)

## 项目进度

- [待测试](pending-test.md)
- [TODO](todo.md)
- [v0.3.7 发布说明](release-v0.3.7.md)
- [v0.3.6 发布说明](release-v0.3.6.md)

## 说明

- 当前画布项目和“我的素材”主要保存在浏览器本地；账号同步保存配置和数据快照，不等同于完整云端媒体同步。
- 本地直连模式下，AI API Key 保存在浏览器本地，并由前端直接请求 OpenAI 兼容接口。
- 当前 `main` 分支是纯生图平台；视频/音频能力已转移到 `codex/video-audio-upstream-v0.3.3`。获取和 Docker 部署命令见 [Docker 部署](deployment.md) 与 [纯生图拆分与 PR #43 合并说明](upstream-merge-v0.3.3.md)。
