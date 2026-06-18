---
title: 系统配置数据结构
description: settings 表中 public 和 private 配置结构说明
---

# 系统配置数据结构

系统配置保存在 `settings` 表中，目前只使用两行：

| key | 说明 |
| --- | --- |
| `public` | 公开配置，前端可以读取 |
| `private` | 私有配置，只给后端和管理员使用 |

> 私有化版本已移除会员、支付、OIDC / Linux.do 登录和算力点功能。下面只列出当前实际使用的字段；后端为兼容上游可能仍返回空的 `membership`、`payment`、`modelCosts`、`auth.oidc`、`auth.linuxDo` 等字段，可忽略。

## public.value

```json
{
  "modelChannel": {
    "availableModels": ["gpt-5.5", "gpt-image-2"],
    "defaultModel": "gpt-image-2",
    "defaultImageModel": "gpt-image-2",
    "defaultTextModel": "gpt-5.5",
    "systemPrompt": "",
    "allowCustomChannel": true
  },
  "auth": {
    "allowRegister": true
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 认证相关公开配置 |

`modelChannel` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型；保存设置时会自动合并所有已启用私有渠道的模型 |
| `defaultModel` | string | 默认模型，从 `availableModels` 中选择；为空或失效时优先选择文本模型 |
| `defaultImageModel` | string | 默认图片模型，从 `availableModels` 中选择；为空或失效时优先选择 `seedream`、`image`、`gpt-image` 模型 |
| `defaultTextModel` | string | 默认文本模型，从 `availableModels` 中选择；为空或失效时优先选择非图片模型 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | boolean | 是否允许用户在配置弹窗中切换为本地直连渠道，默认允许 |

用户侧请求模式：

| 模式 | 说明 |
| --- | --- |
| 云端渠道 | 使用后端 `/api/v1/*` 代理接口，请求会按模型名匹配 `private.value.channels` 中的可用渠道 |
| 本地直连 | 默认可选；`allowCustomChannel` 关闭后不可选，用户在浏览器本地配置 `baseUrl`、`apiKey` 和模型列表后直接请求模型接口 |

`auth` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `allowRegister` | boolean | 是否允许用户注册，默认允许；关闭后注册入口隐藏，注册接口拒绝新用户创建 |

## private.value

```json
{
  "channels": [
    {
      "protocol": "openai",
      "name": "默认渠道",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-xxx",
      "models": ["gpt-5.5", "gpt-image-2"],
      "weight": 1,
      "enabled": true,
      "remark": ""
    }
  ],
  "promptSync": {
    "enabled": true,
    "cron": "*/5 * * * *"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，当前为 `openai` |
| `name` | string | 渠道名称 |
| `baseUrl` | string | OpenAI 兼容接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每 5 分钟 |
