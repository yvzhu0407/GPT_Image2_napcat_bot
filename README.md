# GPT Image2 NapCat Bot

一个基于 `NapCat WebSocket + CLIProxyAPI + OpenAI SDK` 的 QQ 群机器人。

当前支持：

- `#画图 ...`
- 回复图片后 `反推`
- 回复文本或图片后 `Chat ...`
- `3K_H / 3K_V` 尺寸标记

## 架构

运行链路是：

1. `NapCat-Docker` 提供 QQ 登录和 WebSocket Server
2. 本项目通过 WebSocket 接 NapCat
3. 本项目通过 `CLIProxyAPI` 的 OpenAI 兼容接口访问 `responses`
4. 生成图片先落盘到本地 `output/`
5. NapCat 容器通过挂载目录读取图片文件并回发到群里

## 项目文件

- [napcat_ws.js](./napcat_ws.js)
  负责连接 NapCat WebSocket、解析命令、排队、回消息
- [get_img.js](./get_img.js)
  负责文本生图、图生图、反推、Chat
- [.env.example](./.env.example)
  环境变量模板

## 依赖

- Node.js 20+
- Docker / Docker Compose
- 一个可用的 QQ 账号
- 一个可用的 CLIProxyAPI 实例

## 1. 部署 NapCat-Docker

参考仓库：

- NapCat-Docker: https://github.com/NapNeko/NapCat-Docker

NapCat-Docker 官方 README 给出的默认端口包括 `3001`（WebSocket）和 `6099`（WebUI），并说明可持久化这些目录：

- `/app/.config/QQ`
- `/app/napcat/config`
- `/app/napcat/plugins`

本项目还需要额外挂载一个图片输出目录，给 NapCat 读取生成后的图片。

可以直接用下面这份 `docker-compose.yml`：

```yaml
version: "3.8"

services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: always
    network_mode: bridge
    environment:
      - NAPCAT_UID=${NAPCAT_UID}
      - NAPCAT_GID=${NAPCAT_GID}
    ports:
      - "3001:3001"
      - "6099:6099"
    volumes:
      - ./napcat/QQ:/app/.config/QQ
      - ./napcat/config:/app/napcat/config
      - ./napcat/plugins:/app/napcat/plugins
      - ./output:/app/shared-output
```

启动：

```bash
NAPCAT_UID=$(id -u) NAPCAT_GID=$(id -g) docker compose up -d
```

查看日志和默认 token：

```bash
docker logs napcat
```

WebUI：

```text
http://<你的服务器IP>:6099/webui
```

说明：

- `3001` 是本项目默认连接的 WebSocket 端口
- `./output:/app/shared-output` 是关键挂载
- 后面 `.env` 里的 `NAPCAT_MOUNT_OUTPUT_DIR` 必须和 `/app/shared-output` 保持一致

## 2. 部署 CLIProxyAPI

参考：

- CLIProxyAPI GitHub: https://github.com/router-for-me/CLIProxyAPI
- 基础配置文档: https://help.router-for.me/configuration/basic
- OpenAI Compatibility 文档: https://help.router-for.me/configuration/provider/openai-compatibility

本项目只要求：

1. OpenAI 兼容接口对外监听一个本地端口
2. 该端口提供 `/v1/images/generations`，如果还要用 `反推` / `Chat` 则额外提供 `/v1/responses`
3. 你给这个机器人分配一个可调用的 API Key

一个最小 `config.yaml` 示例：

```yaml
host: "127.0.0.1"
port: 8317

api-keys:
  - "replace-with-your-local-client-key"

debug: false
request-retry: 1
```

如果你还要走 OpenAI-compatible provider，可以按官方文档继续补：

```yaml
openai-compatibility:
  - name: "your-provider"
    base-url: "https://provider.example.com/v1"
    api-key-entries:
      - api-key: "provider-key"
    models:
      - name: "upstream-model-name"
        alias: "local-model-alias"
```

本项目默认会连：

```text
http://127.0.0.1:8317/v1
```

如果你改了 CLIProxyAPI 端口，就要同步改 `.env` 里的 `OPENAI_BASE_URL`。

## 3. 配置本项目

安装依赖：

```bash
npm install
```

复制环境变量模板：

```bash
cp .env.example .env
```

示例：

```env
DEBUG=0

NAPCAT_TOKEN=napcat
NAPCAT_WS_URL=ws://127.0.0.1:3001
BOT_DISPLAY_NAME=AI Bot
WHITELIST=["176627392"]

OUTPUT_DIR=output
NAPCAT_MOUNT_OUTPUT_DIR=/app/shared-output

OPENAI_API_KEY=replace-with-your-local-client-key
OPENAI_BASE_URL=http://127.0.0.1:8317/v1
RESPONSES_MODEL=gpt-5.4
IMAGE_MODEL=gpt-image-2

IMAGE_QUALITY=high
IMAGE_FORMAT=png
IMAGE_BACKGROUND=opaque
IMAGE_MODERATION=low
DEFAULT_PROMPT=Generate a clean product shot of a glass honey jar on a light background.
```

## 4. 环境变量说明

### NapCat

- `NAPCAT_TOKEN`
  NapCat WebSocket 鉴权 token
- `NAPCAT_WS_URL`
  NapCat WebSocket 地址，默认 `ws://127.0.0.1:3001`
- `BOT_DISPLAY_NAME`
  合并转发节点显示昵称
- `WHITELIST`
  允许机器人响应的群号列表，格式是 JSON 数组字符串

### 图片输出与挂载

- `OUTPUT_DIR`
  机器人本地保存图片的目录
- `NAPCAT_MOUNT_OUTPUT_DIR`
  同一个目录在 NapCat 容器内的挂载路径

例如：

- 本机保存到 `./output/generated-xxx.png`
- 容器挂载到 `/app/shared-output/generated-xxx.png`

那么就设置：

```env
OUTPUT_DIR=output
NAPCAT_MOUNT_OUTPUT_DIR=/app/shared-output
```

机器人会自动把本地路径转换成容器内路径，再发给 NapCat。

### CLIProxyAPI / OpenAI

- `OPENAI_API_KEY`
  调用 OpenAI 兼容接口时使用的 key
- `OPENAI_BASE_URL`
  OpenAI 兼容入口，例如 `http://127.0.0.1:8000/v1`
- `RESPONSES_MODEL`
  用于 `反推` / `Chat` 的文本模型名；如果后端不提供 `/v1/responses`，这两个功能不可用
- `IMAGE_MODEL`
  发送到 `/v1/images/generations` 的图像模型名

### 生图默认参数

- `IMAGE_QUALITY`
- `IMAGE_FORMAT`
- `IMAGE_BACKGROUND`
- `IMAGE_MODERATION`
- `DEFAULT_PROMPT`

## 5. 启动

```bash
npm run start
```

或者：

```bash
node napcat_ws.js
```

如果需要更多日志：

```bash
DEBUG=1 npm run start
```

## 6. 机器人命令

群里发送 `/help` 会看到实时帮助，当前支持：

- `#画图 提示词`
- 回复图片后 `反推`
- 回复文本或图片后 `Chat 问题`
- 在命令里带 `3K_H` 或 `3K_V`

示例：

```text
#画图 赛博朋克猫娘 3K_V
```

```text
回复一张图后发送：反推
```

```text
回复一张图后发送：Chat 这张图哪里还能优化？
```

```text
回复图片后发送：改图 改成吉卜力风格
```

当前图像接口默认只支持文生图，`改图` 需要后端额外提供图像编辑接口。

## 7. 已知事项

### 1. 图片发送依赖目录挂载

如果 NapCat 在 Docker 内，而机器人在宿主机运行，必须保证：

- `OUTPUT_DIR` 对应的宿主机目录被挂进 NapCat 容器
- `NAPCAT_MOUNT_OUTPUT_DIR` 和容器内路径一致

否则 NapCat 会出现找不到图片文件。

### 2. CLIProxyAPI / 上游网络超时会直接回群失败原因

当前代码会把：

- HTTP 500
- SSE `error`
- `response.failed`

统一转成群消息提示。

### 3. 非流式结果不稳定

当前链路主要依赖流式 SSE 取结果。

## 8. 参考链接

- NapCat-Docker: https://github.com/NapNeko/NapCat-Docker
- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
- CLIProxyAPI Basic Configuration: https://help.router-for.me/configuration/basic
- CLIProxyAPI OpenAI Compatibility: https://help.router-for.me/configuration/provider/openai-compatibility
