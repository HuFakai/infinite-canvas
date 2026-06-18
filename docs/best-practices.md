---
title: 最佳实践
description: 无限画布（私有版）的架构、安全、开发与运维规范，新增功能时的标准做法
---

# 最佳实践

本文面向在**私有化版本**上继续开发和运维的人。它不重复 [AGENTS.md](../AGENTS.md) 的分层约定，而是补充“为什么这样做”和“新增东西时照着哪段现成代码抄”。读完应能安全地加一个接口、一个 AI 渠道、一个存储后端，而不在安全或一致性上踩坑。

## 1. 架构与请求链路

技术栈：后端 Go + Gin + GORM（SQLite/MySQL/Postgres 三选一），前端 Next.js App Router + React + TypeScript + Ant Design + Zustand + Tailwind。

请求链路是关键，很多安全判断都依赖它：

```
浏览器 → nginx(公网) → Next.js(:13000) → /api/[...path] 透传 → Go(:18080, 仅本机)
```

- Go 后端**只监听 127.0.0.1**，不直接对公网开放（见 `.env` 的 `PORT`、Dockerfile 的 `API_BASE_URL`）。
- 但 `web/src/app/api/[...path]/route.ts` 是一个 catch-all 代理，把**所有** `/api/*`（全部方法）原样转发给 Go。**因此后端每一个路由实际都经由公网可达**——不要以为“只监听本机”就等于内网安全。新增后端路由时，鉴权要在路由层显式挂中间件，别依赖网络隔离。
- 该代理会注入 `X-Forwarded-Host` / `X-Forwarded-Proto`。Gin 侧 `SetTrustedProxies(nil)`（`router/router.go`），所以 `c.ClientIP()` 拿到的是代理的回环地址，不是真实客户端 IP——任何“按 IP”的逻辑（限流、审计）在这套拓扑下都不可靠，要按用户名/账号维度做。

## 2. 分层职责（边界，别越界）

| 层 | 目录 | 只做 | 不要做 |
|---|---|---|---|
| handler | `handler/` | 解析 HTTP 入参、调 service、`OK`/`Fail` 返回 | 业务逻辑、直接访问 DB |
| service | `service/` | 业务逻辑、校验、默认值、鉴权、ID/时间、出站请求 | 直接拼 SQL、写 HTTP 响应 |
| repository | `repository/` | GORM 查询 | 业务判断 |
| model | `model/` | 结构体、枚举、简单方法 | 任何 IO |

中间件 `middleware/`、路由 `router/`、配置 `config/`。新增代码先判断属于哪层，不要在 handler 里写 GORM，也不要在 service 里写 `http.ResponseWriter`。

## 3. 后端开发规范

- **统一响应**：所有业务接口返回 `{ code, data, msg }`，用 `handler/response.go` 的 `OK` / `Fail` / `FailWithStatus` / `FailError`。不要自己拼 JSON。
- **可安全外露的错误**：service 层返回给用户的错误用 `service` 包里的 `safeMessageError{message: ...}`（实现了 `SafeMessage()`）。`FailError` 只会把实现了 `SafeMessage()` 的错误原文返回，其余一律降级为“操作失败”，避免把内部细节/堆栈漏给前端。
- **列表/分页**：复用 `model.Query` + `Normalize()` + `Offset()`（`model/query.go`，`PageSize` 上限 500）。排序子句必须是**硬编码常量**（如 `Order("created_at desc")`），筛选值走 GORM 占位符 `Where("x = ?", v)`——当前代码无字符串拼接 SQL，保持这个习惯就不会有注入。
- **解码要校验**：会改写数据的接口，`json.NewDecoder(...).Decode(&x)` 的错误**必须处理**并拒绝（见 `handler/settings.go` 的 `AdminSaveSettings`）。否则畸形 JSON 会变成零值结构体把配置清空。只读/无害接口可以宽松。
- **ID 与时间**：用 `service.newID(prefix)`（UUID）和 `service.now()`（RFC3339 字符串）。

## 4. 前端开发规范

- API 调用集中在 `web/src/services/api/`，统一走 `request.ts` 的封装（自动带 `Authorization`）。
- 跨页面状态放 `web/src/stores/`（Zustand）。`useUserStore` 用 `persist` 把 **token 存在 localStorage**——这意味着任何同源 XSS 都能偷走它，所以前端绝不能把不可信内容当 HTML 渲染（见安全章）。
- 全局状态/配置就地从 store/hook 取，不要层层透传 props（AGENTS.md 已约定）。
- 类型检查由 CI 的 `bunx tsc --noEmit` 把关；注意 `next.config.ts` 里 `ignoreBuildErrors: true` 只让 `next build` 忽略类型错误，**CI 的 tsc 仍会拦**，所以类型必须真过。
- 闭包陷阱：在 SSE/事件回调里给外层 `let x: T | null = null` 赋值，TS 跨闭包推断不到，外部读取会被误判为 `null`/`never`。读取处用 `x as T | null` 显式断言（见 `services/api/image.ts` `parseResponsesStreamResponse`）。

## 5. 安全实践（重点）

这套系统有三个天然高危面：**代理外部 URL**、**分发用户上传内容**、**对接用户可配置的第三方端点**。下面每条都有现成实现可抄。

### 5.1 出站抓取用户给的 URL —— 必须防 SSRF

任何“服务端去拉取一个调用方提供的 URL”的新代码，**一律复用** `handler/ssrf.go` 的 `newSSRFSafeClient(timeout)`：

- 用 `net.Dialer.Control` 在真正建连时校验目标 IP，拦截环回/私网/链路本地（含云元数据 `169.254.169.254`）/CGNAT——**每次拨号（含重定向后）都校验**，因此同时挡住 DNS rebinding 和重定向绕过。
- `CheckRedirect` 限制跳数并强制 http(s)。
- 调用方还需：限制响应 `Content-Type`（如只接受 `image/*`）、用 `io.LimitReader` 限大小、加 `X-Content-Type-Options: nosniff`、出错时**不要回传底层错误文本**（否则内网探测的连接被拒/超时差异会泄露拓扑）。

参考实现：`handler/storage.go` 的 `ProxyImage`。

例外：对接**已知的对象存储端点**（用户自配的 S3/MinIO）不能套私网黑名单——自建 MinIO 跑在内网是合法场景。那条链路（`service/storage.go`）只加超时 + 大小上限，靠凭据本身鉴权。

### 5.2 分发用户上传内容 —— 防存储型 XSS

`/api/files/:id/content` 等返回用户文件的接口，**绝不能原样回显客户端上传时声称的 Content-Type**。用 `handler/storage.go` 的 `safeDownloadContentType`：只有图片/音视频按原类型内联，其余（尤其是 `text/html` 和**可内嵌脚本的 `image/svg+xml`**）一律 `application/octet-stream` + `Content-Disposition: attachment`，并始终加 `nosniff`。原因见 5.0：token 在 localStorage，一旦同源 HTML 被执行就是账号接管。

### 5.3 一切读入内存的 body / 响应都要设上限

请求体用 `http.MaxBytesReader`（见 `UploadFile`、AI 代理 `proxyAIRequest`、`media_reference.go`）；出站响应体用 `io.LimitReader`（见 `service/storage.go` 的 `getS3Object`、下载回退）。没有上限的 `io.ReadAll` 就是内存耗尽 DoS 的入口。

### 5.4 私密配置不出前端

API Key、存储密钥、OAuth secret 等属于 settings 的 `private` 部分。返回给管理员前用 `service/settings.go` 的 `hidePrivateAPIKeys` 置空；保存时用 `keepPrivateAPIKeys` / `keepPrivateStorageSecrets` / `keepPrivateAuthSecrets` 保留旧值（前端传空=不改）。**新增任何私密字段，必须同时接入这两条链路**，否则要么泄露、要么一保存就被清空。

### 5.5 认证与凭据

- JWT 用 HS256，`service.ParseToken` 校验签名算法（挡 alg=none / 算法混淆）。`CurrentAuthUser` 每次请求回查 DB 以便实时封禁——别为了省一次查询去掉它。
- 登录（`service.Login`）：用户不存在时也跑一次 dummy bcrypt 比对抹平计时（防用户枚举）；按用户名做内存失败计数 + 退避锁定（按 IP 无效，见第 1 节）。
- 管理员凭据**唯一来源是 `.env`**（`ADMIN_USERNAME` / `ADMIN_PASSWORD`），无站内改密入口。`service.EnsureDefaultAdmin` 在每次启动时按 `.env` **校正既有管理员**（改名 + 密码不匹配才重写），改密码就是改 `.env` 后重启。
- `.env` 含明文口令与 `JWT_SECRET`，权限必须 `600`。`JWT_SECRET` 用强随机；留空或等于默认值时会**每次启动随机生成**（会话随重启失效，且多副本不一致），正式部署务必显式设置。

### 5.6 S3 兼容签名

`service/storage.go` 手写了 SigV4（为避免引入重型 AWS SDK）。改动注意：`canonicalURI` 必须等于**真正发送的请求路径**（用 `request.URL.EscapedPath()`），否则 endpoint 带 path 前缀或 key 含特殊字符时签名对不上。若未来要扩展更多 S3 操作，优先考虑换成 `minio-go`，别让手写签名越长越脆。

## 6. 配置与数据

- 运行配置见 `config/config.go`（环境变量 + `.env`）。settings 表分 `public`（前端可见）/ `private`（仅服务端），结构见 [系统配置数据结构](system-settings.md) 与 `model/setting.go`。
- 默认 SQLite，数据落 `data/`（DB、AI 日志 `data/logs/ai-calls`、参考素材 `data/reference-media`、提示词 `data/prompts`）。`data/` 已 gitignore；**备份就是备份整个 `data/` 目录**。
- 切 MySQL/Postgres 只需改 `STORAGE_DRIVER` + `DATABASE_DSN`，GORM `AutoMigrate` 会建表（`repository/db.go`）。
- AI 调用日志会落盘**请求 prompt 原文 + 部分响应**（base64 图片已脱敏，文本未脱敏）。属设计取舍，注意隐私；保留期/开关见 settings 的 `aiLog`，并有定时清理（`service/ai_log.go`）。

## 7. 部署与运维

- 主部署形态：**裸机 + systemd + nginx 反代**（nginx 对外，转发到 Next `:13000`；Go `:18080` 仅本机）。
- Docker 形态（`Dockerfile`）：单容器内 Go API 后台 + Next 前台。已加固为**非 root 运行**、`HEALTHCHECK` 打 `/api/health`、**任一进程退出则容器退出**（`wait -n`）交给编排器重启。镜像构建用 bun，前端锁文件以 `bun.lock` 为准（已移除 `package-lock.json`）。
- 健康检查端点 `/api/health`（`router/router.go`）。
- 升级后注意跑 `go mod tidy` 保持依赖干净（私有版已移除支付相关依赖）。

## 8. 测试与 CI

- 后端：`go test ./...`（覆盖 config/handler/service）。改动后至少跑 `go build ./... && go vet ./... && go test ./...`，并保持 `gofmt` 干净。
- 前端：CI 跑 `bun install --frozen-lockfile` + `bunx tsc --noEmit`（`.github/workflows/ci.yml`）。本地无 bun 时可用 `node_modules/.bin/tsc --noEmit` 代验类型。
- 没有前端单测；改动前端核心逻辑建议手动验证关键路径（登录、生图、画布保存）。

## 9. 已裁剪功能与前端残留

私有版移除了：会员、支付（ZPay/支付宝/微信）、排行榜、邀请返佣、OIDC 登录、Linux.do 登录。处理现状：

- **后端**：路由/业务逻辑已删；但 `model/setting.go` 仍保留 `Payment`/`Membership`/`Auth.LinuxDo`/`Auth.OIDC` 等**结构体与 settings 存取链路**（属“死数据”，无可达漏洞，刻意保留以减小改动面）。`config.go` 仍有 LinuxDo URL 默认值。保存设置时 `keepPrivate*` 会保留这些字段已存的密钥，前端不再下发它们也不会被清空。
- **用户端前端**：干净。导航（`constant/navigation-tools.ts`）、账号菜单、登录页均无指向废弃功能的入口；登录页只有用户名/密码。
- **管理后台前端**：已清理。`app/(admin)/admin/settings/page.tsx` 删除了会员、ZPay/支付宝/微信支付、OIDC、Linux.do 登录配置区块与“模型算力点”表格；`admin/ai-logs` 去掉了“扣点”列；canvas 面板移除了 `modelCosts` 读取；`AuthUser.credits` 及 `AdminSettings` 中相关类型字段（`membership`/`payment`/`auth.oidc`/`auth.linuxDo`/`modelCosts`/`credits`）已删除。前端 `tsc --noEmit` 通过。

> 若以后要把后端也彻底铲除：删 `model/setting.go` 的 `PrivatePaymentSetting`/`PublicMembershipSetting`/`PrivateAuthSetting` 等结构与 `service/settings.go` 的 `keepPrivate*`/`hidePrivateAPIKeys` 对应分支、`config.go` 的 LinuxDo URL，再 `go mod tidy`。当前刻意未做，以隔离改动风险。

## 10. 常见任务怎么做

- **加一个 AI 渠道**：管理后台「设置」加渠道（baseURL/apiKey/models/weight）。选路逻辑 `service.SelectModelChannelForModel`（按 model 过滤 + 权重随机），URL 拼装 `BuildModelChannelURL`，超时 `HTTPClientForChannel`。
- **加一个对象存储 provider**：填 endpoint/bucket/ak/sk/publicBaseURL。出站统一走带超时的 `s3HTTPClient`，签名走 `signS3Request`。务必把新密钥字段接入 5.4 的脱敏/保留链路。
- **加一个后端接口**：在 `router/router.go` 选对分组挂中间件（`UserAuth`/`AdminAuth`/`OptionalAuth`），handler 解析入参 → service 业务 → `OK`/`Fail`；会改数据则校验解码错误；返回结构守 `{code,data,msg}`。
- **加一个前端页面**：放 `app/(user)` 或 `app/(admin)`；API 封装进 `services/api/`；需要进导航就改 `constant/navigation-tools.ts`。
- **加一个“拉取外部 URL”的功能**：直接用 `newSSRFSafeClient`，照第 5.1 节的清单（限类型/限大小/nosniff/不漏错误）。
