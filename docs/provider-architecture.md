# 厂商模块与声明式配置设计

## 目标与兼容契约

平台按 `cloud_compute/<provider>`、`s3/<provider>` 和 `startup_profiles/<profile>` 隔离实现。外层只消费注册表公开的统一接口，不判断厂商细节。

以下值是持久化兼容契约，不得因目录或展示名称变化而改名：

- 云算力厂商 ID：`ppio`、`autodl`、`runpod`、`hyperstack`。
- 对象存储厂商 ID：`r2`、`oss`。
- 特殊加密记录：`__hyperstack_config__`、`__object_storage_config__`、`__object_storage_uploads__`、`__control_plane_config__`。
- S3 环境字段：`STORAGE_PRIMARY_PROVIDER`，以及 `R2_S3_*`、`OSS_S3_*` 全部既有字段。
- SQLite 表、加密算法、AAD 和 `FLEET_CREDENTIAL_ENCRYPTION_KEY` 均保持不变。重构不复制、不解密后重写已有 Key。

## 目录职责

- `lib/cloud_compute/common/`：仅放跨厂商且语义完全一致的 HTTP、状态归一化和接口校验。
- `lib/cloud_compute/<provider>/`：该厂商 API adapter、实例创建/操作、SSH 获取、启动配置和 UI 字段声明。
- `lib/s3/common/`：S3 协议级上传、下载、分片和探测工具。
- `lib/s3/<provider>/`：Endpoint 规范、默认值、字段声明和该厂商特有动作。
- `lib/startup_profiles/<profile>/`：每一种开机配置独立维护；云厂商模块显式选择配置。

## 声明文件

每个厂商目录包含 `provider.yaml`。为避免引入 YAML 运行时依赖，文件采用 YAML 1.2 接受的 JSON 子集；加载器仍按 YAML 配置对待并进行结构校验。

顶层元素：

| 字段 | 含义 |
| --- | --- |
| `id` | 永久厂商 ID，同时是数据库中的 `provider` 值 |
| `kind` | `cloud_compute` 或 `s3` |
| `title` / `description` | 页面展示文案 |
| `portals` | 厂商官网、充值页或获取 Key 页 |
| `fields` | 表单字段数组，顺序即展示顺序 |

字段元素：

| 字段 | 含义 |
| --- | --- |
| `id` | DOM 与请求体字段名 |
| `storageKey` | 服务端/数据库中使用的既有名称；迁移时不得随意变化 |
| `label` / `placeholder` | 标题与占位提示 |
| `control` | `text`、`password`、`url`、`checkbox`、`select` 或 `popup` |
| `masked` | 回显时是否只显示掩码；密码字段必须为 `true` |
| `required` | 启用该厂商时是否必填 |
| `default` | 未保存过值时的默认值 |
| `readOnly` | 是否禁止用户直接编辑；常用于固定下拉值 |
| `hint` | 控件旁的补充状态或约束说明 |
| `options` | 写死的下拉/弹窗选项，元素为 `{value,label}` |
| `optionsSource` | 动态选项请求：`{method,url,itemsPath,valuePath,labelPath}` |
| `portal` | 字段旁外链按钮：`{label,url}` |
| `autoFill` | 自动请求填充：`{label,method,url,valuePath,decoder}` |
| `derive` | 根据另一个字段本地推导值：`{sourceField,template}`，不执行任意代码 |

`decoder` 当前允许 `json`、`text`、`base64-json`。前端不得执行配置中的任意代码；`url` 只能是同源 `/api/` 路径，外部网站只能通过 `portal` 打开，防止声明文件变成任意请求或脚本入口。

云厂商声明还可使用以下顶层元素：

| 字段 | 含义 |
| --- | --- |
| `clientModule` | 厂商目录内的前端扩展文件名；服务端只允许加载声明的文件 |
| `launch` | 实例创建表单的能力开关，例如容器/VM 类型、托管 SSH、厂商镜像 |
| `offerPresentation` | 报价列表展示模式；特殊展示逻辑由 `clientModule` 实现 |
| `instanceAccess` | 厂商实例的发现与 SSH 接入说明 |
| `provisioningRequirements` | 创建前需要满足的环境字段组合 |
| `errorPolicies` | 厂商错误码对应的库存或重试策略 |

## 现有按钮抽象

- 厂商官网/充值/Key 页面：顶层 `portals`，或依附字段的 `portal`。
- 保存并验证 Key：固定命令，由云厂商注册表的 `validateCredential` 能力承接。
- 多 Key 的添加、切换、重命名、导出、删除：属于通用 Key 管理器，不进入厂商声明，也不改现有 SQLite 结构。
- Hyperstack 刷新 Environment/Keypair/Image：三个 `select + optionsSource` 字段，共用资源发现请求。
- S3 启用、主存储选择、保存与读写测试：通用 S3 命令；Endpoint、Bucket、Region、Access Key 和 Secret 由声明生成。
- R2 Account ID 推导 Endpoint：`autoFill`；请求只返回可填值，不直接持久化。
- 静态 Region：`options`；需要实时发现时使用 `optionsSource`。

## 实例能力接口

每个云厂商模块必须实现同一套实例接口：`initialize`、`resolveSsh`、`installPackages`、`upload`、`download`、`outboundProbe`、`gpuBenchmark`、`shouldUsePasswordTerminal`。协议级 SSH 执行与传输可复用公共工具，但厂商如何得到主机、端口、用户名和凭据必须留在厂商目录。卡片层只接收归一化后的实例、SSH 状态、外网探测和基准测试结果。

## 前端扩展

通用页面只提供 `registerProviderExtension(id, extension)` 与生命周期钩子，不包含厂商 ID 或分支。声明了 `clientModule` 的厂商可在自己的目录内实现报价行、地区库存、实例价格补全、账户资源表单等特殊交互。扩展通过 `/provider-assets/<provider>/<declared-file>` 加载，路径和文件名都必须与注册表声明匹配，不能任意读取其他文件。

实例列表刷新后，通用层广播 `instancesLoaded`；需要补充价格或状态的厂商自行处理。厂商扩展加载晚于首次实例请求时也会再次收到当前实例，避免并发启动造成首屏缺失。

## S3 装机载荷

既有 `R2_S3_*`、`OSS_S3_*` 字段继续原样保存和传递。注册表根据每个 S3 目录的声明与实现，将启用项额外归一化为 `FLEET_STORAGE_PROVIDERS_B64`；通用 `agent/bootstrap.sh` 只解析 `{name,provider,endpoint,accessKeyId,secretAccessKey,region}` 数组，不知道任何厂商 ID、环境变量前缀或默认 Region。新增 S3 厂商只需新增目录，不修改通用装机脚本。

## 开机配置目录

每个内置配置位于 `lib/startup_profiles/<profile>/`，并包含：

- `profile.yaml`：稳定 ID、显示名称、`profileType`、镜像、CUDA 主版本、推荐状态和默认角色。
- `startup.sh`：该配置首次开机执行的独立脚本。

注册表按目录扫描配置；`image-profile-store` 保留原有 preset ID，所以已有选择和数据库记录无需迁移。自定义配置仍沿用原数据库结构，不会被内置目录覆盖。

## 通用层约束

`server.js`、通用前端、`agent/bootstrap.sh`、`agent/telemetry.py`、校验模块及 `cloud_compute/common`、`s3/common` 不得出现任何已注册厂商 ID。自动化测试会从注册表读取 ID 并扫描这些文件。旧路径只允许保留无逻辑的 re-export 兼容入口，不能在其中实现厂商行为。

## 迁移规则

1. 先注册新目录并保留旧入口 re-export，避免一次性修改所有调用方。
2. 每迁移一个厂商，同时迁移 startup 与实例能力，并对原返回结构做契约测试。
3. UI 改为读声明后，服务端仍接受原请求体字段；未知已保存字段不得在保存时被清空。
4. 发布前用现有数据库副本做只读状态检查，确认所有 provider ID、Key 数量与后四位不变。
