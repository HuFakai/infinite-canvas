---
title: 数据库说明
description: 当前后端主要数据表与字段说明
---

# 数据库说明

本文档只记录后端当前已经使用的主要数据表。后端使用 GORM 管理数据库连接和表结构迁移，支持 `sqlite`、`mysql`、`postgresql`。

当前启动时执行 `AutoMigrate`，自动维护以下表：

- `users`
- `credit_logs`
- `prompts`
- `assets`
- `settings`
- `storage_objects`
- `user_configs`
- `creative_workflows`

> 私有化版本移除了会员、支付、OIDC/Linux.do 登录和排行榜功能。`users`、`credit_logs`、`settings` 中与这些功能相关的列/字段（`credits`、`aff_*`、`github_id`、`linux_do_id`、`wechat_id`、`oidc_sub`、settings 的 `membership`/`payment`/`auth.oidc`/`auth.linuxDo`/`modelCosts` 等）作为上游 schema 残留保留，但当前不再写入或使用；`membership_plans`、`membership_orders` 表已不再迁移。

## users

系统用户表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `username` | string | 用户名，唯一索引 |
| `password` | string | 密码哈希 |
| `email` | string | 邮箱 |
| `display_name` | string | 昵称 |
| `avatar_url` | string | 头像地址 |
| `role` | string | 角色：`user`、`admin` |
| `credits` | number | 算力点余额（私有版未使用，保留列） |
| `aff_code` | string | 用户邀请码，唯一索引 |
| `aff_count` | number | 已邀请用户数量 |
| `inviter_id` | string | 邀请人用户 ID |
| `github_id` | string | GitHub 用户 ID |
| `linux_do_id` | string | Linux.do 用户 ID |
| `wechat_id` | string | 微信用户 ID |
| `oidc_sub` | string | OIDC subject，索引 |
| `status` | string | 用户状态：`active`、`ban` |
| `last_login_at` | string | 最近登录时间 |
| `extra` | text | 第三方资料等扩展 JSON |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## credit_logs

用户算力点变更流水表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `user_id` | string | 关联用户 ID |
| `type` | string | `admin_adjust`、`ai_consume`、`ai_refund` |
| `amount` | number | 本次变动数量 |
| `balance` | number | 变动后的余额 |
| `related_id` | string | 关联业务 ID |
| `remark` | string | 备注 |
| `extra` | text | 扩展 JSON |
| `created_at` | string | 创建时间 |

## prompts

提示词表。用于保存公开提示词、内置远程提示词、分类和预览内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `cover_url` | string | 封面图 |
| `prompt` | string | 提示词内容 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `preview` | text | Markdown 展示内容 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## assets

服务器素材库表。当前纯生图分支只使用文本和图片素材。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `type` | string | 素材类型：`text`、`image` |
| `cover_url` | string | 封面图 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `description` | string | 描述 |
| `content` | text | 文本或 Markdown 内容 |
| `url` | string | 图片地址 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## settings

系统配置表，只保存两行数据：`public` 和 `private`，配置值为 JSON。

`public.value` 主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `site` | object | 站点名称、描述、Logo、favicon、版权 |
| `modelChannel` | object | 模型渠道公开配置 |
| `auth` | object | 注册开关（私有版已移除 Linux.do/OIDC 登录，对应字段保留为空） |
| `storage` | object | 当前存储模式和是否允许用户自定义对象存储 |

`modelChannel` 主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型列表 |
| `channels` | object[] | 前端可见的渠道摘要 |
| `defaultModel` | string | 默认模型 |
| `defaultImageModel` | string | 默认图片模型 |
| `defaultTextModel` | string | 默认文本模型 |
| `systemPrompt` | string | 旧版系统提示词字段 |
| `systemPrompts` | object | 图片、文本、工作流、工作流 Agent 系统提示词 |
| `allowCustomChannel` | bool | 是否允许用户自定义渠道 |

`private.value` 主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 后端模型渠道列表和密钥 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `aiLog` | object | AI 日志上报和自动清理配置 |
| `storage` | object | 后台 S3/R2 对象存储配置 |

后端返回管理员设置时会隐藏渠道密钥和对象存储密钥；保存时留空表示沿用已保存密钥。

## storage_objects

服务端对象存储元数据表。当前纯生图分支用于图片对象。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `provider_id` | string | 存储提供方 ID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象 Key，唯一索引 |
| `public_url` | string | 公开访问地址 |
| `mime_type` | string | MIME 类型 |
| `bytes` | number | 文件大小，单位字节 |
| `width` | number | 图片宽度 |
| `height` | number | 图片高度 |
| `sha256` | string | 文件 SHA256 |
| `created_by` | string | 上传用户 ID |
| `created_at` | string | 创建时间 |
| `deleted_at` | string | 删除时间 |

## user_configs

用户配置与账号同步数据表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 主键，用户 ID |
| `model_config` | text | 用户模型配置 JSON |
| `storage_provider` | text | 用户自定义对象存储配置 JSON |
| `canvas_data` | text | 画布项目同步数据 JSON |
| `image_history` | text | 生图历史同步数据 JSON |
| `asset_data` | text | “我的素材”同步数据 JSON |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## creative_workflows

创作工作流表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `owner_user_id` | string | 所属用户 ID，公开模板可为空 |
| `scope` | string | 作用域 |
| `name` | string | 工作流名称 |
| `category` | string | 工作流分类 |
| `description` | string | 描述 |
| `data` | text | 工作流配置 JSON |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `last_run_at` | string | 最近运行时间 |

## AI 调用日志

AI 调用日志当前按天写入本地 JSONL 文件，不在 `AutoMigrate` 中创建数据库表。日志目录由 `AI_LOG_DIR` 配置，默认位于 `data/logs/ai-calls`。
