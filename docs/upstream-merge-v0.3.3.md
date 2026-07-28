---
title: 纯生图拆分与 PR #43 合并说明
description: 当前纯生图分支与上游 PR #43 合并后的范围、差异和冲突处理
---

# 纯生图拆分与 PR #43 合并说明

本文档说明本次分支拆分和上游 PR #43 合入结果，目的是让后续测试者明确当前分支到底新增了什么、删除了什么、哪些上游能力没有进入纯生图分支。

## 分支结果

- `codex/video-audio-upstream-v0.3.3`：保留本地已合并的视频/音频能力，已作为独立分支保存。
- `codex/image-only-pr43`：纯生图拆分和 PR #43 合并的历史工作分支，删除视频/音频能力，并合入上游 PR #43 的会员、支付、OIDC、排行榜和站点配置能力；排行榜后来从 `main` 移除。
- `main`：当前发布分支，已采用纯生图平台路线，不再包含视频/音频入口。

## 视频/音频保留分支获取方式

`codex/video-audio-upstream-v0.3.3` 适合仍需要视频创作台、视频/音频画布节点、Seedance/Agnes 视频链路和音频能力的用户。全新部署：

```bash
git clone -b codex/video-audio-upstream-v0.3.3 https://github.com/HuFakai/infinite-canvas.git infinite-canvas-video-audio
cd infinite-canvas-video-audio
cp .env.example .env
docker compose up -d --build
```

已有仓库拉取该分支：

```bash
git fetch origin
git checkout codex/video-audio-upstream-v0.3.3
git pull --ff-only origin codex/video-audio-upstream-v0.3.3
docker compose up -d --build
```

该分支和当前 `main` 的数据结构、功能入口不同，不建议共用同一运行数据目录频繁切换。

## 当前分支保留的本地能力

- 生图工作台：多任务并发、历史结果合并、失败详情、渠道标签、失败重试、底部/侧边工作台。
- 画布图片工具：裁剪、局部重绘配置节点、图片拆分、图片放大、反推提示词、查看大图、自定义快捷工具。
- 创作工作流：公开/个人模板、多图工作流、AI 创建工作流、工作流结果进入生图历史。
- 账号同步：模型配置、对象存储配置、画布数据、生图历史和“我的素材”数据快照。
- 对象存储：SQLite 元数据、S3/R2 图片对象存储、容量统计、上传失败重试。
- AI 日志：本地 JSONL AI 调用日志、后台查询和清理。

## 从 PR #43 合入的上游能力

- 会员套餐和会员订单数据结构。
- 用户会员等级、会员过期时间、OIDC 绑定字段。
- 用户端会员中心和我的订单页面。
- 管理后台会员套餐和订单管理页面。
- ZPay 支付跳转、同步返回、异步通知验签。
- 支付宝和微信支付配置字段及回调入口。
- 通用 OIDC 登录授权和回调。
- 生图排行榜接口和页面曾随 PR #43 合入，当前 `main` 已移除。
- 站点名称、Logo、favicon、描述、版权等公开配置。

## 删除或不再进入当前分支的能力

- 视频创作台页面。
- 视频生成 API：`/api/v1/videos`、`/api/v1/videos/:id`、`/api/v1/videos/:id/content`。
- 音频生成 API：`/api/v1/audio/speech`。
- 用户视频历史同步：`/api/v1/user-data/video-history`。
- 视频/音频画布节点。
- 视频/音频配置节点和模型配置。
- Seedance/Agnes 视频链路。
- 音频独立渠道。
- 视频历史、视频同步、音频素材类型和本地媒体文件缓存。

## 冲突处理原则

- 前端画布、素材、配置弹窗和导航以纯生图清理结果为准，不重新引入视频/音频入口。
- 后端路由保留本地图片、文本、工作流、对象存储、AI 日志和账号同步接口；PR #43 的会员、支付和 OIDC 接口继续保留，排行榜接口已移除。
- 系统设置同时保留本地存储/AI 日志配置和 PR #43 的站点/会员/支付/OIDC 配置。
- 数据库迁移同时保留本地 `storage_objects`、`user_configs`、`creative_workflows`，并加入 PR #43 的 `membership_plans`、`membership_orders`。
- 文档只使用根目录 Markdown 体系，不采用 `docs/content/docs/...` 新文档站结构。

## 未实装的上游能力

- WebDAV 同步暂未实装：它会与当前账号同步、对象存储同步和删除生命周期规则重叠，直接合入容易造成多端覆盖和重复同步。
- AI 超分已按当前模型渠道体系接入，使用参考图编辑请求生成 2K/4K 增强结果；仍需按 `docs/pending-test.md` 完成线上渠道、计费和存储验证。
- 上游视频/音频相关能力不进入当前纯生图分支；需要这些能力请使用 `codex/video-audio-upstream-v0.3.3`。

## 验收重点

- 搜索确认功能代码中不再存在视频/音频入口。
- 生图工作台底部布局在桌面端按钮位于右侧，在移动端不溢出。
- 文本生图、参考图生图、局部重绘、图片拆分、图片放大、素材保存和账号同步仍可用。
- 会员、订单和后台套餐/订单页面可打开并正常请求接口；页面和接口中不再出现排行榜入口。
- OIDC 未配置时普通登录不受影响；配置后登录页显示 OIDC 入口。
- ZPay、支付宝、微信配置保存后不会覆盖已有密钥占位逻辑。
