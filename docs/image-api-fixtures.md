---
title: 图片接口故障模拟器
description: 本地复现图片接口异常响应与解析兼容场景
---

# 图片接口故障模拟器

项目内置一个仅用于本地开发的 OpenAI 兼容图片接口模拟器，用于稳定复现中转站常见响应问题，不需要消耗真实渠道额度。

## 启动

```bash
cd web
npm run mock:image-api
```

默认监听 `http://127.0.0.1:17372`。在本地渠道中填写：

- Base URL：`http://127.0.0.1:17372/v1`
- API Key：任意非空字符串
- 协议：OpenAI

拉取模型列表后，可按要测试的接口模式选择以下模型。

| 模型 | 模拟响应 | 预期结果 |
| --- | --- | --- |
| `mock-json-url` | JSON 中返回 HTTP 图片 URL | 生成成功并展示图片 |
| `mock-json-base64` | JSON 中返回 `b64_json` | 生成成功并展示图片 |
| `mock-sse-chunked` | 把 Images/Responses SSE 拆成不规则网络分块 | 生成成功，不受 TCP 分块位置影响 |
| `mock-truncated-json` | JSON 尾部被截断，但已包含完整图片字段 | 提取已返回图片并生成成功 |
| `mock-504-html` | HTTP 504 和 HTML 网关错误页 | 生成失败，详情保留网关响应 |
| `mock-large-base64` | 约 8 MB 的 Base64 图片响应 | 不出现调用栈溢出或字符串截断 |
| `mock-stream-error` | HTTP 200 的 SSE 中返回错误事件 | 生成失败，不把流内错误当作成功 |
| `mock-empty` | HTTP 200 但图片数组为空 | 生成失败，提示没有图片结果 |

`mock-sse-chunked` 会根据请求路径分别返回 Images API 和 Responses API 事件，可切换工作台“接口模式”覆盖两种解析器。`/images/edits` 也接受 multipart 请求，可用于确认参考图和 mask 上传路径。

## 夹具位置

模拟响应保存在 `web/scripts/fixtures/`。夹具使用 `__IMAGE_BASE64__`、`__LARGE_IMAGE_BASE64__` 和 `__IMAGE_URL__` 占位符，服务启动后才注入测试图片，避免把大 Base64 提交到仓库。

该服务只监听 `127.0.0.1`，不要作为公网 API 部署。HTTPS 页面或远程服务器无法直接访问用户电脑上的本地地址，测试时应同时在本机启动前端和模拟器。
