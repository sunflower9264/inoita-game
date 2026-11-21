# 云存档与账号

云存档是旁路能力：玩家在标题页的「开始游戏 → 存档槽」页右上角进入。启动、读档、进游戏和自动存档都不依赖服务器；云服务不可达时只在云存档页提示，本机存档照常使用。

## 玩家流程

1. 在存档槽页点「云存档」。
2. 在云存档面板里直接填写账号、密码并注册；已有账号直接登录。账号和密码框就在面板内，不再弹单独的输入层。
3. 已登录后：
   - 「导入本机存档」把本机自动槽和 10 个手动槽里能读取的存档上传到云端。
   - 「下载云存档」会先询问是否覆盖已有槽位。每个云档通过正式读档校验、目标地图能加载后才写回同号槽。坏档保留本机原档，其他槽继续下载。验证中退出会保留当前槽原档。
   - 「修改密码」输入当前密码、新密码和确认新密码；成功后换发新 token，旧 token 立即失效。
4. 返回或 Escape 回到存档槽页。

同一账号只允许一个有效 token。在另一台设备成功登录后，旧设备的 token 立即失效；旧设备下次云操作会提示重新登录，但本机存档和游戏不受影响。输错密码或账号锁定不会踢掉当前已登录的会话。打开云页时如果 token 剩余不足 7 天，会自动续期；整条登录链最多 90 天。

## 账号与锁定

- 账号 3–24 个码点，允许字母、数字、下划线和汉字；NFKC 归一化，大小写不敏感。
- 密码 6–64 个码点，区分大小写；没有找回渠道，界面会明确提示。
- 连续输错 3 次锁定 15 分钟；锁定期内即使密码正确也返回锁定。锁状态写入账号文件，服务重启不会重置。
- 成功登录清零失败计数；错误密码只增加计数，不替换当前会话。
- 修改密码要验证当前密码；新密码不能与当前密码相同。当前密码输错也计入 3 次锁定；改密成功换发新 token，旧 token（包括发起请求的那个）失效。
- token 有效期 30 天；剩余不足 7 天时，打开云存档页会自动续期并换发新 token。一条登录链最多延续 90 天，到达后必须重新登录；重新登录或改密会开始新的 90 天链。
- 续期是懒触发：只在打开云页时检查，不在游戏内定时或后台请求；超过 30 天没打开云页，token 自然过期，需要重新登录。

## HTTP 接口

所有接口在 `/__cloud` 下；鉴权用 `Authorization: Bearer <token>`，JSON 请求体。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/__cloud/register` | 无 | 注册并返回 token |
| POST | `/__cloud/login` | 无 | 登录；返回新 token，旧 token 失效 |
| POST | `/__cloud/password` | Bearer | 修改密码；验证当前密码，返回新 token |
| POST | `/__cloud/refresh` | Bearer | 剩余不足 7 天时换发新 token；未到窗口返回 `renewed:false` |
| POST | `/__cloud/logout` | Bearer | 删除当前会话 |
| GET | `/__cloud/saves` | Bearer | 列出云端槽位摘要；兼作 token 校验 |
| PUT | `/__cloud/saves/:slot` | Bearer | 上传一个槽位；`:slot` 是 `auto` 或 `0..9` |
| GET | `/__cloud/saves/:slot` | Bearer | 下载一个槽位 |

错误响应统一是 `{ error, message, ... }`：

- `400 invalid-input`：账号、密码、请求体或存档结构不合法。
- `401 invalid-credentials`：密码错误（登录或改密的当前密码），带 `remainingAttempts`。
- `401 unauthorized`：token 无效、过期、到达 90 天链上限，或被新登录/改密替换。
- `404 save-not-found`：云端没有该槽。
- `409 account-exists`：注册重名。
- `413 too-large`：请求体超过 8 KiB（账号）或 2 MiB（存档）。
- `415 unsupported-media-type`：不是 `application/json`。
- `423 locked`：账号锁定，带 `retryAfterSeconds` 和 `Retry-After`。
- `429 too-many-requests`：认证接口限流，带 `retryAfterSeconds` 和 `Retry-After`。
- `503 cloud-unavailable`：云服务初始化失败。
- `507 storage-full`：账号存档配额或磁盘空间不足。

列表响应里的每个槽带 `slot`、`format`、`bytes`、`summary`、`savedAt`、`updatedAt`。客户端在下载前按 `format` 拒绝未来版本和过旧版本。

## 服务端数据

默认数据目录是项目根目录的 `.cloud-save/`（开发服务用 `.cloud-save-dev/`）：

```text
.cloud-save/
  accounts/<sha256(账号归一化)>.json
  saves/<sha256(账号归一化)>/<slot>.json
  sessions.json
```

- 账号文件保存显示用账号、scrypt 密码哈希、创建时间和失败计数/锁定截止。
- 存档文件是 `{version:1, slot, format, bytes, summary, savedAt, updatedAt, game}`。
- `sessions.json` 只保存 token 哈希、账号、当前 token 过期时间、会话链起点和 90 天链上限；每账号最多一条。
- 文件权限 0600，目录 0700；写入用同目录临时文件 + rename。
- 单账号最多 11 个槽，单档 2 MiB，账号总配额 16 MiB。
- 每账号只保留一个有效会话；token 30 天过期，剩余 7 天内可续期，续期换新 token 但不延长 90 天链上限。旧版 `sessions.json` 没有链字段时按 `createdAt` 当起点、自动补 90 天上限。

## 安全

- 密码用 scrypt（`N=32768, r=8, p=1, keylen=32`，随机 16 字节盐，`maxmem=64 MiB`），比较用 `timingSafeEqual`；不存在账号也跑一次 dummy scrypt，减少账号枚举的时序差异。
- 最多同时跑 2 个 scrypt；认证接口按 IP 限流（登录 10 次/5 分钟，注册 3 次/小时）。
- token 是 32 字节随机值，服务端只存 SHA-256 哈希；不接受超长或格式非法 token。
- 续期在剩余 7 天内才换发新 token，旧 token 立即失效；90 天链上限防止 token 被无限续命。被盗 token 最多用到下一次续期，正主重新登录会让盗用者的 token 失效。
- CORS 只放行同源和 `https://appassets.androidplatform.net`；其他来源返回 403。不使用 cookie，不使用 `*`。2.0.0 的 APK 通过本地 `/__cloud` 代理发出请求，服务端看到的是原生请求、没有浏览器 Origin；这条 CORS 规则主要留给网页版和旧壳。
- 不记录密码、token 或请求体。
- 生产 4014 只监听 127.0.0.1，HTTPS 由 nginx 在 443 终止；APK 的云地址必须是 HTTPS。

## 离线与降级

- 云客户端只在打开云页（含续期检查）、登录或点击上传/下载时请求；没有轮询和后台同步。
- 请求 12 秒超时；离开云页会 abort。返回按钮始终可用。
- 网络错误、超时、5xx、429 不清 token；只有带鉴权的 401 清 token。续期网络失败时保留旧 token，继续尝试列云端。
- 云服务初始化失败时 `serve-built.ts` 只把 `/__cloud` 降级为 503 JSON，静态首页和游戏继续提供。
- 云存档写入失败只影响当前操作；本机存档读写、读档和游戏不经过云客户端。

## 本地运行与部署

```bash
npm run serve -- --cloud-data /tmp/inoita-cloud
```

或直接：

```bash
node tools/serve-built.ts --port 4104 --host 127.0.0.1 --cloud-data /tmp/inoita-cloud
```

开发服务 `npm run dev` 在 4003 同源挂载 `/__cloud`，数据写 `.cloud-save-dev/`。Vite 的 `server.fs.deny` 挡住这两个数据目录，避免通过 `/@fs/` 读取账号文件。

部署顺序：

1. 上线 `tools/serve-built.ts` 和 `tools/cloud-save-*.ts`，创建可写的 `.cloud-save/`，重启 4004。
2. nginx 加 `client_max_body_size 4m`，`nginx -t` 后 reload。
3. `npm run build` 部署客户端。
4. 需要 APK 时再 `npm run apk` 并 `npm run verify:apk`。

旧客户端不会调用 `/__cloud`，先服务端后客户端最安全。云接口在 `serve-built.ts` 里，不能只替换静态产物；必须重启 `inoita-game.service`。

## 备份与恢复

备份整个 `.cloud-save/` 即可，包含账号、会话和云端存档。恢复时停服务、替换目录、再启动；账号密码哈希和会话都跟着恢复。

## 限制

- 没有密码找回、邮箱或手机号验证；忘记密码只能重新注册。修改密码需要当前密码。
- 没有自动同步和冲突合并；同槽写入是 last-write-wins。
- 没有逐槽手动操作界面，v1 是批量导入/下载并确认覆盖。
- 不支持多个 Node 进程同时写同一个数据目录。
- 云端保留上传时的原始格式。客户端可备份和恢复格式 1 的存档。
- 活跃玩家每 90 天需要重新登录一次；超过 30 天不打开云页也会过期。续期不是后台心跳。
