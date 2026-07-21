# GPU Fleet Console

GPU Fleet Console 是一个跨云 GPU 调度与验收平台。目前接入 PPIO、Hyperstack 和 RunPod，统一提供实时报价、实例生命周期管理、自动环境部署、多 GPU 遥测、硬件性能测试、外网直连检查和 S3 数据导入。

> 继续调研或替换厂商前，请先阅读 [GPU 云厂商选型要求与淘汰记录](PROVIDER_SELECTION_REQUIREMENTS.md)，避免重复推荐已淘汰厂商。接入适配器不代表厂商已经通过最终付款、容量和实机验收。

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

相关环境变量：

- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_PREFIX`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

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
- Hyperstack 不开放公网 22，只允许配置的 `HYPERSTACK_AGENT_CIDR` 访问 Agent 端口 3000。
- Hyperstack 当前 Agent URL 仍为 HTTP + CIDR 白名单，尚未达到完整 TLS/隧道方案。
- 不应向实例下发 S3 管理员凭据。

## 本地启动

要求 Node.js 20+。项目没有第三方 npm 运行依赖。

```powershell
$env:PPIO_API_KEY="..."
$env:HYPERSTACK_API_KEY="..."
$env:RUNPOD_API_KEY="..."

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
$env:HYPERSTACK_AGENT_CIDR="203.0.113.10/32"

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
