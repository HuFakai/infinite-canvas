<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

无限画布是一款面向 AI 生图创作的开源工作台。本仓库是基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 二次开发的纯生图分支，重点增强了生图工作台、画布图片工具、创作工作流、账号同步、S3/R2 对象存储、会员/支付/OIDC 和部署文档，适合个人服务器或小团队自托管使用。

视频/音频能力已经从当前分支移除；需要完整视频/音频合并成果的用户可使用分支 `codex/video-audio-upstream-v0.3.3`。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种数据库结构和存储格式都可能直接调整，欢迎关注后续更新，当前更适合个人/本地部署，不建议直接公网多人共用。
>
> 如果你需要稳定维护自己的分支，建议自行 fork 后独立开发。二次开发与 PR 请保留原作者信息和前端页面标识。

## 核心功能

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
- AI 创作：支持 OpenAI 兼容接口和 Gemini 协议的 Images API、Responses API、图生图、参考图编辑、流式接收、Base64 图片返回和文本问答。
- 生图工作台：支持侧边/悬浮底部工作台、多任务并发、历史结果合并展示、分类管理、失败详情、参考图缩略图、图片体积展示、4K 尺寸选项和“我的素材”复用。
- 创作工作流：支持公开/个人模板、变量表单、AI 创建工作流、单图/多图系列工作流、参考图输入和结果自动进入生图历史。
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布；支持网页 Agent Loop 和本地 Canvas Agent 纯生图工具子集。
- 提示词与素材：提示词库、服务器素材库和“我的素材”可在生图、画布 AI 和工作流中复用。
- 会员与支付：合入上游 PR #43 的会员套餐、订单、ZPay/支付宝/微信配置、OIDC 登录和站点配置。
- 存储：保留浏览器 IndexedDB，本版本新增 SQLite 元数据 + S3/R2 图片对象存储，可配置 Cloudflare R2。

完整功能说明见 [docs/features.md](docs/features.md)。

如果你在为担心没有合适的生图API来发愁，可以查看该免费生图项目：[chatgpt2api](https://github.com/basketikun/chatgpt2api)

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query。
- 后端：Go、Gin、GORM。
- 存储：SQLite、本地 IndexedDB、S3 兼容对象存储、Cloudflare R2。
- 部署：源码部署、Docker Compose、GitHub Actions 构建镜像、1Panel。

## 快速开始

当前 `main` 分支是纯生图平台：

```bash
git clone https://github.com/HuFakai/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
# 修改默认账号密码等信息
docker compose up -d --build
```

服务器更新当前 `main` 分支：

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose up -d --build
```

需要视频/音频能力的用户使用保留分支 `codex/video-audio-upstream-v0.3.3`。该分支保留本地合并过的视频创作台、视频/音频画布节点、Seedance/Agnes 视频链路和音频能力，适合有视频/音频需求的用户自行拉取部署：

```bash
git clone -b codex/video-audio-upstream-v0.3.3 https://github.com/HuFakai/infinite-canvas.git infinite-canvas-video-audio
cd infinite-canvas-video-audio
cp .env.example .env
docker compose up -d --build
```

已有仓库切换到视频/音频保留分支：

```bash
git fetch origin
git checkout codex/video-audio-upstream-v0.3.3
git pull --ff-only origin codex/video-audio-upstream-v0.3.3
docker compose up -d --build
```

本地非 Docker 开发运行：

```bash
cp .env.example .env
go run .
```

另开一个终端：

```bash
cd web
npm install
npm run dev
```

运行后默认端口 13000，可访问 `http://localhost:13000`。

如果你 fork 后进行了二次开发，部署时需要使用当前源码构建或发布你自己的镜像，优先参考更完整的 [Docker 部署说明](docs/deployment.md)。

如需要拉取提示词，可前往：`http://localhost:13000/admin/prompts`

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/bj30FtS5/5.png" alt="5" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/hxRvjw51/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 文档

- [功能介绍](docs/features.md)
- [Docker 部署](docs/deployment.md)
- [本地开发](docs/local-development.md)
- [画布节点操作手册](docs/canvas-node-manual.md)
- [画布快捷键](docs/canvas-shortcuts.md)
- [待测试](docs/pending-test.md)
- [待办事项](docs/todo.md)
- [后端数据库说明](docs/backend-database.md)
- [系统配置数据结构](docs/system-settings.md)
- [接口响应约定](docs/api-response.md)
- [图片接口故障模拟器](docs/image-api-fixtures.md)
- [上游/二开功能归属与合并检查](docs/upstream-merge-v0.3.3.md)
- [上游与生图参考项目功能审查](docs/upstream-and-playground-review.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)

## 二开说明

本仓库保留原项目 AGPL-3.0 协议。若你继续 fork 或部署二开版本，请保留原作者信息和协议声明，并使用当前源码或自己的镜像部署，不要直接套用原作者镜像。

## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)

点击链接加入群聊【AI创作开源 交流群】：https://qm.qq.com/q/JOeM3SGEuG

## 开源协议

本项目使用 GNU Affero General Public License v3.0，见 [LICENSE](LICENSE)。

## Star History

<a href="https://www.star-history.com/?repos=HuFakai%2Finfinite-canvas&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=HuFakai/infinite-canvas&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=HuFakai/infinite-canvas&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=HuFakai/infinite-canvas&type=date&legend=top-left" />
 </picture>
</a>
