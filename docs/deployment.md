# 部署说明

本文档面向二次开发后的 `HuFakai/infinite-canvas` 仓库。你的代码已经不同于原作者仓库，部署时不要直接使用原作者镜像。默认端口约定如下：

- 前端：`13000`
- 后端：`18080`
- 前端代理：`/api/* -> http://127.0.0.1:18080`

## 本地非 Docker 启动

本地开发需要两个终端，分别启动 Go 后端和 Next.js 前端。

### 1. 准备环境

建议版本：

- Go 1.25 或更高
- Node.js 22 或更高
- npm 10 或更高

首次运行：

```bash
git clone https://github.com/HuFakai/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
```

如果你已经在本地有项目，只需要确认 `.env` 存在即可。

### 2. 启动后端

在项目根目录运行：

```bash
go run .
```

默认后端监听：

```text
http://127.0.0.1:18080
```

健康检查：

```bash
curl http://127.0.0.1:18080/api/health
```

如果本机设置了代理，`curl` 访问本机端口时可以显式关闭代理：

```bash
curl -x "" http://127.0.0.1:18080/api/health
```

### 3. 启动前端

另开一个终端：

```bash
cd web
npm install
npm run dev
```

默认前端地址：

```text
http://localhost:13000
```

如果后端端口不是 `18080`，启动前端时单独指定：

```bash
API_BASE_URL=http://127.0.0.1:你的后端端口 npm run dev
```

### 4. 常用本地命令

类型检查：

```bash
cd web
npx tsc --noEmit
```

后端测试：

```bash
go test ./...
```

前端生产构建：

```bash
cd web
npm run build
```

## 自行构建二开镜像

这里有两种方案，你可以按服务器条件选择。

### 方案 A：把代码上传到服务器，在服务器构建镜像

这是最直观的方案。流程是：

1. 服务器拉取你的 GitHub 仓库代码。
2. 在服务器上执行 `docker compose up -d --build`。
3. Docker 根据当前源码构建镜像。
4. 构建完成后自动启动容器。

命令：

```bash
mkdir -p /opt/apps
cd /opt/apps
git clone https://github.com/HuFakai/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
docker compose up -d --build
```

当前 [docker-compose.yml](/Users/fakaihu/Documents/project/image2/infinite-canvas/docker-compose.yml:1) 已经是“从当前源码构建镜像”的模式：

```yaml
services:
  app:
    image: infinite-canvas:local
    build:
      context: .
      dockerfile: Dockerfile
    container_name: infinite-canvas
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    ports:
      - "13000:13000"
    restart: unless-stopped
```

启动后访问：

```text
http://服务器IP:13000
```

在 1Panel 中使用时，把这个仓库目录作为 Compose 项目导入即可。后续更新：

```bash
git pull
docker compose up -d --build
```

### 方案 B：GitHub 自动构建镜像，服务器只拉镜像运行

这个方案更适合长期维护。流程是：

1. 你把二次开发代码 push 到 `HuFakai/infinite-canvas`。
2. GitHub Actions 自动构建镜像。
3. 镜像发布到 GitHub Container Registry。
4. 服务器的 1Panel 或 Compose 只负责拉镜像运行。

仓库内已经有工作流：

```text
.github/workflows/docker-image.yml
```

它会在 `main` 或 `master` 分支 push 后发布：

```text
ghcr.io/HuFakai/infinite-canvas:latest
```

打版本 tag 也会发布版本镜像：

```bash
git tag v0.1.0
git push origin v0.1.0
```

服务器上的 Compose 可以写成：

```yaml
services:
  app:
    image: ghcr.io/hufakai/infinite-canvas:latest
    container_name: infinite-canvas
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    ports:
      - "13000:13000"
    restart: unless-stopped
```

注意：如果 GHCR 镜像是私有的，服务器需要先 `docker login ghcr.io`。如果你把包设置为公开，服务器可以直接拉取。

## 1Panel 部署建议

推荐优先级：

1. 想最快跑通：服务器拉代码后执行 `docker compose up -d --build`。
2. 想以后升级方便：GitHub Actions 构建 `ghcr.io/hufakai/infinite-canvas:latest`，1Panel 拉你的镜像。
3. 不想用 Docker：用上面的 `nohup` 简化源码部署，跑稳后再考虑 systemd。

生产环境建议：

- 不要使用默认 `ADMIN_PASSWORD`。
- 不要使用默认 `JWT_SECRET`。
- 用 1Panel 站点代理到 `127.0.0.1:13000`。
- 开启 HTTPS。
- 定期备份 `.env` 和 `data`。

## 自定义前后端接口

本项目分为 Next.js 前端和 Go 后端。默认部署时：

- Go 后端监听 `18080`。
- Next.js 前端监听 `13000`。
- 前端通过 `/api/*` 代理到后端。

### 开发环境修改接口地址

前端开发代理由 `API_BASE_URL` 控制：

```bash
cd web
API_BASE_URL=http://127.0.0.1:18080 npm run dev
```

如果后端改到 `19080`：

```bash
PORT=19080 go run .
cd web
API_BASE_URL=http://127.0.0.1:19080 npm run dev
```

### 生产环境修改接口地址

源码部署时，启动前端时设置：

```bash
API_BASE_URL=http://127.0.0.1:18080 HOSTNAME=0.0.0.0 PORT=13000 npm run start
```

systemd 部署时，修改 `infinite-canvas-web.service`：

```ini
Environment=API_BASE_URL=http://127.0.0.1:18080
```

Docker 部署时，如果 Go 后端仍在同一个容器内，不需要改；Dockerfile 默认用：

```bash
API_BASE_URL=http://127.0.0.1:18080
```

当前单容器 Dockerfile 的启动命令里写了 `PORT=18080` 和 `API_BASE_URL=http://127.0.0.1:18080`，如果要改内部后端端口，需要同步修改 [Dockerfile](/Users/fakaihu/Documents/project/image2/infinite-canvas/Dockerfile:41) 的 `CMD`。

如果你拆成两个容器或两个服务器，需要把前端容器里的 `API_BASE_URL` 指向后端服务地址，并把后端独立服务的 `PORT` 设为对应端口，例如：

```yaml
services:
  web:
    command: sh -c "cd /app/web && HOSTNAME=0.0.0.0 PORT=13000 API_BASE_URL=http://api:18080 npm run start"
    environment:
      API_BASE_URL: http://api:18080
  api:
    environment:
      PORT: 18080
```

### 反向代理建议

推荐只对外暴露前端站点：

```text
https://你的域名 -> 127.0.0.1:13000
```

不要直接把 `18080` 暴露到公网。所有浏览器请求都从前端域名的 `/api/*` 进入，再由 Next.js 转发到 Go 后端。

### 跨域说明

默认同域方案不需要 CORS。只有当你让浏览器直接访问另一个域名的 Go 后端时，才需要额外处理跨域和鉴权头。生产部署优先使用同域 `/api/*` 代理，配置更简单。

## 常见问题

### Docker 构建 Go 后端依赖超时

如果构建卡在 `RUN go build -o /server .`，并看到类似：

```text
Get "https://proxy.golang.org/...": i/o timeout
```

说明服务器访问 Go 官方模块代理不稳定。当前 Dockerfile 已设置：

```dockerfile
ENV GOPROXY=https://goproxy.cn,direct
```

拉取最新代码后重新构建：

```bash
git pull
docker compose up -d --build
```

如果仍然超时，可以在服务器上先测试：

```bash
docker run --rm golang:1.25-alpine sh -c 'GOPROXY=https://goproxy.cn,direct go env GOPROXY'
```

### Docker 构建运行镜像 apt 很慢

如果构建卡在类似下面这一步：

```text
[stage-2 7/8] RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
```

通常是服务器访问 Debian 官方源 `deb.debian.org` 很慢。当前 Dockerfile 已将运行镜像的 apt 源默认切换为阿里云镜像：

```dockerfile
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
```

这里故意使用 `http`，因为 `node:22-bookworm-slim` 在安装 `ca-certificates` 前可能还没有系统证书，使用 `https` 源会先触发证书校验失败。

拉取最新代码后重新构建即可：

```bash
git pull
docker compose up -d --build
```

如果想看更详细的构建输出，可以使用：

```bash
docker compose build --progress=plain
docker compose up -d
```

如果你所在服务器访问阿里云镜像也慢，可以临时换成清华源构建：

```bash
docker compose build --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn --progress=plain
docker compose up -d
```

### Docker Compose 提示变量未设置

如果执行 `docker compose up -d --build` 时出现：

```text
WARN The "Nf4" variable is not set. Defaulting to a blank string.
```

通常是 `.env` 中的密码、JWT Secret 或 API Key 含有 `$`，Docker Compose 会把 `$xxx` 当作环境变量插值。

解决方式二选一：

1. 用单引号包住包含 `$` 的值：

```env
JWT_SECRET='abc$Nf4$Kr1'
ADMIN_PASSWORD='pass$Nf4'
```

2. 或把 `$` 写成 `$$`：

```env
JWT_SECRET=abc$$Nf4$$Kr1
ADMIN_PASSWORD=pass$$Nf4
```

修改后重新执行：

```bash
docker compose up -d --build
```

### 为什么不能继续用原作者镜像

原作者镜像只包含原作者仓库构建出的代码，不包含你在 `HuFakai/infinite-canvas` 中做的二次开发。你的部署必须来自当前源码构建，或者来自你自己发布的镜像。

### 本地前端提示接口连接失败

确认后端正在运行：

```bash
curl http://127.0.0.1:18080/api/health
```

如果后端不是 `18080`，启动前端时指定：

```bash
API_BASE_URL=http://127.0.0.1:你的后端端口 npm run dev
```

### Docker 部署后数据丢失

确认挂载了数据目录：

```yaml
volumes:
  - ./data:/app/data
```

SQLite 数据库默认在：

```text
data/infinite-canvas.db
```

### 端口被占用

本地开发可以临时换前端端口：

```bash
cd web
npm run dev -- -p 13001
```

Docker Compose 可以改端口映射：

```yaml
ports:
  - "13001:13000"
```
