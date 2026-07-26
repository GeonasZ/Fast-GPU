# Fast GPU Console

Fast GPU Console 是一个跨云 GPU 调度与验收平台。目前接入 PPIO、Hyperstack 和 RunPod，统一提供实时报价、实例生命周期管理、自动环境部署、多 GPU 遥测、硬件性能测试、外网直连检查和 S3 数据导入。

> 继续调研或替换厂商前，请先阅读 [GPU 云厂商选型要求与淘汰记录](PROVIDER_SELECTION_REQUIREMENTS.md)，避免重复推荐已淘汰厂商。接入适配器不代表厂商已经通过最终付款、容量和实机验收。

## 快速启动

首次运行需要先安装依赖、配置环境变量，再选择启动方式。下面按 Windows / PowerShell 给出步骤。

### 1. 环境要求

- Node.js **22.5 或更高版本**（见 `package.json` 的 `engines.node`）。
- 首次安装依赖会下载 Electron 二进制（约 200MB），并本地编译 `node-pty` 原生模块，请确保网络通畅，并且系统已安装编译工具链（Windows 上需要 Visual Studio Build Tools 与 Python，即 `npm config set msvs_version 2019` 这类原生模块构建所需的工具）。

### 2. 安装依赖

```powershell
npm install
```

这一步会读取 `package.json` 与 `package-lock.json`，安装运行依赖（`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`）与开发依赖（`electron`）。完成后会生成 `node_modules/`，该目录已被 `.gitignore` 忽略，不要提交。

### 3. 配置环境变量

```powershell
Copy-Item .env.example .env
notepad .env
```

按实际情况填入各厂商 API key 与平台配置。`.env` 已被忽略，密钥不要提交。完整变量列表见 [.env.example](.env.example)。

### 4. 选择启动方式

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 本机一体化（推荐首次试用） | `npm run start:all` | 通过 Electron 一次性启动控制面 + 本地客户端窗口，无需浏览器 |
| 仅网页端 | `npm run start:web` | 启动服务端，浏览器访问 <http://localhost:4173> |
| 仅本地客户端 | `npm run start:local` | 单独打开连接指定控制面的客户端窗口 |

首次运行 `start:all` 会创建 `.data/local-client.key` 与 `.data/local-fleet.sqlite`，请备份这两个文件。

### 5. 验证安装

```powershell
npm test
npm run check
```

全部通过即代表依赖与运行时环境正常。

## 当前功能

### GPU 市场与厂商接入

- 从厂商 API 获取真实 GPU 型号、区域、库存和报价，不生成模拟商品。
- 价格明确标注 `CNY/hour` 或 `USD/hour`，避免忽略货币单位。
- PPIO：支持地区库存展开和创建接口。
- Hyperstack：通过 `/core/flavors` 与 `/pricebook` 获取 GPU 和美元小时价格，通过 VM API 自动创建实例。
- RunPod：通过 GraphQL 获取 GPU 库存和价格，通过 REST v1 管理 Pods。
- 商品列表与提交之间发生库存竞争时，返回 `stale_inventory`，页面提示“库存页面已过期”，自动刷新，而不是归咎于平台故障。

### 一键自动部署

创建实例后不需要人工 SSH 安装。平台通过供应商启动参数或 Hyperstack cloud-init 自动执行：

1. 检查 Ubuntu 24.04 和 NVIDIA 驱动。
2. 优先拉取 `nvcr.io/nvidia/pytorch:26.03-py3`。
3. 验证 `nvidia-smi`、`nvcc`、PyTorch CUDA 可用性，并实际执行 GPU 矩阵运算。
4. 安装 Node.js、fio、iperf3、rclone、nvbandwidth、最新版 Codex CLI 和 Claude Code CLI。
5. 启动实例 Agent。
6. 根据配置从 S3-compatible 存储同步数据到本地盘。
7. 将实际 CUDA、驱动、镜像和部署阶段回报给控制面。

Hyperstack 默认要求 R580+ 驱动和 CUDA 13.2。只有用户明确勾选时，才允许回退至 `nvcr.io/nvidia/pytorch:25.03-py3` / CUDA 12.8；回退结果会明确标记，不能算作满足 CUDA 13 原始要求。自动装机失败会报告具体阶段并清理失败 VM。

### 实时 Telemetry

浏览器不直接执行 CLI，调用链为：

```text
浏览器 SSE
  → 平台后端
  → 带 Bearer Token 的实例 Agent API
  → 实例内 execFile("nvidia-smi", [...])
  → NVIDIA 驱动与真实 GPU
  → JSON
  → 网页展示
```

Agent 每次执行预定义的 `nvidia-smi` 查询，返回每张 GPU 的：

- GPU 编号和型号
- 实时利用率
- 已用/总显存
- 温度
- 功耗

多卡实例会逐卡展示。页面初始 `--` 表示尚未收到 Agent 数据，不是模拟值。Agent API 不提供通用 Shell 执行入口，用户不能从网页构造任意 CLI 命令。

### 性能测试报告

`POST /benchmark` 在实例内部执行真实测试，生成 `/var/lib/gpu-fleet/benchmark.json`。网页可展示并导出完整 JSON，包括：

- 每张 GPU 的型号和 PCI Bus ID
- PCIe 当前/最大 generation
- PCIe 当前/最大 lanes
- `nvbandwidth` 测得的显存、PCIe 和 NVLink 带宽
- `nvidia-smi nvlink -s` 状态
- `nvidia-smi topo -m` GPU 拓扑
- 多卡实例运行真实 NCCL `all_reduce`，检查驱动、通信库和卡间通信是否可用
- 遥测比较每张卡的型号、显存容量和利用率差异；合计显存不表示自动形成连续显存池
- `/data` 本地盘 fio 读写 MB/s 与 IOPS
- Cloudflare 100 MB 下载/上传速度
- 五个外部主站的直连结果

测试依赖缺失或命令失败时，报告显示 `FAIL` 和真实错误，不会用演示数值补齐。

### 外网直连验收

实例使用 `curl --noproxy '*'` 直接测试：

- Hugging Face
- Cloudflare
- AWS
- OpenAI
- Google

报告包含远端 IP、HTTP 状态、DNS/TCP/TLS/总耗时和错误信息。OpenAI 未携带业务 API key 时返回 `401` 仍能证明域名、DNS、TCP 和 TLS 可达。

直连失败时平台会如实标记阻断，不会悄悄改用镜像、VPN 或代理。业务下载可以另设 fallback，但 fallback 结果不能冒充“主站直连成功”。

### S3-compatible 数据导入

配置 S3 后，bootstrap 使用 rclone 执行：

```text
S3-compatible bucket/prefix
  → rclone sync --checksum
  → /data/datasets/fineweb
```

对象存储支持 Cloudflare R2 与阿里云 OSS 单独或同时启用。`STORAGE_PRIMARY_PROVIDER` 取 `r2` 或 `oss`，决定新实例首次同步的数据源；两套启用配置都会作为同名 `rclone` remote 下发到实例。

相关环境变量：

- `STORAGE_PRIMARY_PROVIDER`
- `R2_S3_ENABLED`、`R2_S3_ENDPOINT`、`R2_S3_BUCKET`、`R2_S3_PREFIX`、`R2_S3_REGION`、`R2_S3_ACCESS_KEY_ID`、`R2_S3_SECRET_ACCESS_KEY`
- `OSS_S3_ENABLED`、`OSS_S3_ENDPOINT`、`OSS_S3_BUCKET`、`OSS_S3_PREFIX`、`OSS_S3_REGION`、`OSS_S3_ACCESS_KEY_ID`、`OSS_S3_SECRET_ACCESS_KEY`

建议使用只读、限定 bucket/prefix、短有效期凭据。当前已实现“桶到本地盘”的真实同步；FineWeb-Edu 离线入桶、对象清单、总大小、checksum、Parquet 可读性和网页实时任务状态仍需接入正式验收。网页中的静态“33 GB 就绪”不能作为数据完整性证据。

正式 S3 验收应检查：

1. `rclone size --json` 的对象数与总字节数。
2. `rclone check` 无差异。
3. 本地文件数、总大小和 checksum 与桶内一致。
4. 随机读取 Parquet schema 和样本行。
5. `/data` 确实位于实例本地高速盘。

### 容量竞争与恢复

- 创建时库存被其他用户占用：提示页面库存已过期并刷新商品。
- 非 RunPod 厂商启动容量不足：可查找同 GPU 型号、同数量的候选资源，用户确认后才重新创建；不会自动降级 GPU 数量或 CUDA 要求。
- RunPod 停止后重新启动时，原物理机 GPU 可能已被占用。
- 平台不提供跨资源或跨供应商迁移。库存变化只会触发库存刷新和重试提示，不会弹出迁移候选或代替供应商执行迁移。

### 安全边界

- API key 只保存在服务端，绝不放入浏览器代码。
- 实例 Agent 使用 Bearer Token。
- RunPod Agent 通过平台 HTTPS proxy 暴露。
- Hyperstack VM 不分配 Public/Floating IP；SSH 仅通过 Tailscale 网络访问。
- 不应向实例下发 S3 管理员凭据。

## 本地启动

### 网页端

```powershell
npm run start:web
```

打开 <http://localhost:4173>。网页端可以管理实例和复制同步命令；直接读取本机目录并运行 `rsync` 时会提示使用本地客户端。

### 本地客户端

```powershell
npm run start:local -- https://gpu.example.com
```

也可以通过环境变量指定：

```powershell
$env:FLEET_SERVER_URL="https://gpu.example.com"
npm run start:local
```

该命令只打开连接指定控制面的客户端窗口，不会在本机启动另一套完整服务。远程 URL 必须使用 HTTPS；`localhost` 允许使用 HTTP。

客户端窗口会在本地保存上次关闭时的位置和尺寸，下次启动自动恢复；普通网页模式不会调整浏览器窗口。

### 服务端与客户端一体启动

同一台主机既作为控制面又作为日常操作客户端时，只需运行：

```powershell
npm run start:all
```

该命令会通过 Electron 一次性启动本机控制面、遥测接收服务、本地执行能力和独立应用窗口，不需要 Edge、Chrome，也不需要再运行 `start:web`。关闭客户端窗口后，它启动的本地服务会自动停止。Electron 只提供桌面窗口，页面、API 和服务端实现仍与 Web 部署共用。首次运行会创建 `.data/local-client.key` 和 `.data/local-fleet.sqlite`，请备份这两个文件。

实例首次装机始终以 SSH 为引导通道：供应商启动命令只确保 `sshd` 存在并运行，平台在真实 SSH 握手成功后上传并执行本地 `bootstrap.sh` 与 Agent 文件。因此 SSH 模式不要求公网控制面地址。也可以在“平台设置”中切换为 Cloudflare Named Tunnel，并手动填写固定 HTTPS `BASE_URL`；Tunnel 只用于 Agent 遥测、心跳和受限的轻量接口，不参与首次安装。平台不创建临时 Tunnel；本地客户端会检测并安装 `cloudflared`，通过浏览器完成 `cloudflared tunnel login` 授权，创建或复用与域名对应的 Named Tunnel，将 DNS 路由到本机平台端口。

要求 Node.js 22.5+。首次运行需先执行 `npm install` 安装依赖（见上方「快速启动」），运行依赖包括 `node-pty`、`@xterm/xterm`、`@xterm/addon-fit`，桌面窗口另需开发依赖 `electron`。

```powershell
$env:PPIO_API_KEY="..."
$env:HYPERSTACK_API_KEY="..."
$env:RUNPOD_API_KEY="..."
$env:FLEET_SSH_PORT="22022" # 必须是非 22 端口

npm test
npm start
```

打开 <http://localhost:4173>。

只读资源发现接口：

```text
GET /api/providers/ppio/discovery
GET /api/providers/hyperstack/discovery
GET /api/providers/runpod/discovery
GET /api/offers
GET /api/instances
```

### AutoDL 社区镜像转存（实验性）

在“供应商账户中心 → AutoDL”中可将社区镜像 UUID 转存为当前账号的个人镜像。平台会创建临时按量实例，启动后关机并保存镜像，确认个人镜像状态可用后再释放实例。

- 手动模式由用户选择 GPU。
- 自动模式读取 AutoDL 未公开的网页报价接口，在用户设置的最高人民币时价内选择当前最低价。接口失效、价格或库存不明确时不会创建实例。
- 创建后会通过官方实例详情复核实际时价；超过上限时会尝试立即关机。
- 保存失败时仅尝试关机，不自动释放实例，避免丢失可恢复环境。
- 提交前必须确认实例运行费和可能产生的镜像存储费。

网页接口变化时可覆盖：

```powershell
$env:AUTODL_WEB_MARKET_BASE="https://www.autodl.com"
$env:AUTODL_WEB_MARKET_PATH="/api/v1/market/list"
```

该实验工具不改变 `PROVIDER_SELECTION_REQUIREMENTS.md` 中 AutoDL 的 `BANNED` 状态，也不能作为 CUDA 13 合规证明。

实例 Agent 相关接口：

```text
GET  /api/instances/:id/telemetry
POST /api/instances/:id/benchmark
GET  /api/instances/:id/benchmark
```

## 自动部署配置

完整变量参见 [.env.example](.env.example)。生产环境应由 Secret Manager 注入密钥，不要提交 `.env`。

```powershell
$env:BASE_URL="https://gpu.example.com"

$env:HYPERSTACK_ENVIRONMENT="..."
$env:HYPERSTACK_KEY_NAME="..."
$env:HYPERSTACK_IMAGE_NAME="Ubuntu 24.04 R580 with Docker"
$env:HYPERSTACK_IMAGE_USER="ubuntu"
$env:TAILSCALE_AUTH_KEY="..." # 仅由服务端 Secret Manager 注入

npm start
```

控制面必须能被新实例访问。Hyperstack 基础镜像必须真实存在，并预装 Docker、NVIDIA Container Toolkit 和兼容的 NVIDIA 驱动。

## 测试

```powershell
npm test
node --check server.js
node --check agent/agent.js
node --check public/app.js
```

现有测试覆盖厂商适配器、密钥缺失、价格币种、PPIO 价格单位、RunPod REST 配置和 Hyperstack 自动 CUDA 验证参数。真实 GPU、网络、S3 和厂商容量只能在已付费实例上完成端到端验收。

## 已知限制

- S3 网页状态尚未接入完整性校验结果。
- Hyperstack Agent 尚未使用 HTTPS。
- CLI 安装使用最新版，尚未将最终版本号固化到验收报告。
- 本地环境无法验证真实 GPU 数值，必须在云端实例运行 benchmark。

# Credential storage

## Web accounts and local single-user mode

`npm run start:all` is a local, single-user application. It binds its control
plane to `127.0.0.1` and does not show login or registration.

`npm run start:web` enables Web accounts. Remote clients opened with
`npm run start:local -- https://gpu.example.com` use the same Web login and
registration screen. Passwords are stored as salted scrypt hashes and sessions
use HttpOnly cookies. Set `FLEET_ALLOW_REGISTRATION=false` to disable new public
registrations.

All persistent credentials are stored in the SQLite database configured by
`FLEET_DATABASE_PATH` (default: `.data/fleet.sqlite`). Keep the database and its
WAL files on a persistent volume.

The control plane creates a unique `FLEET_AGENT_ID` and `FLEET_AGENT_SECRET` for
each instance. Agent secrets are stored only as scrypt hashes. Managed SSH
private keys are encrypted with AES-256-GCM before they are written to the
`ssh_credentials` table. Set `FLEET_CREDENTIAL_ENCRYPTION_KEY` to a stable,
random 32-byte base64 or hexadecimal key. Store this key in the deployment
secret manager, never in the repository or beside the database. Losing or
changing it makes existing managed SSH keys unreadable.

Removing an instance revokes only that instance's Agent credential. SSH
credentials are removed after provider deletion is confirmed. The legacy
`FLEET_AGENT_TOKEN`, `FLEET_SSH_STORE_DIR`, `connections.json`, and plaintext
private-key storage are not supported.
