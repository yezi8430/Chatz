# 发版流程（服务端 → GitHub + GHCR）

> **English**: [RELEASE.en.md](RELEASE.en.md)

镜像仓库：`ghcr.io/yezi8430/chatz`（公开仓库，Actions 自动构建推送）

## 标签是怎么来的

`.github/workflows/docker-ghcr.yml` 里 `docker/metadata-action` 的规则：

| 规则 | 产出标签 | 触发条件 |
|---|---|---|
| `type=ref,event=branch` | `main` | 推到主分支 |
| `type=semver,pattern={{version}}` | `1.0.0` | **推了 `v1.0.0` 这样的 tag** |
| `type=semver,pattern={{major}}.{{minor}}` | `1.0` | 同上 |
| `type=sha,prefix=sha-,format=short` | `sha-527fec1` | 任何 push |
| `type=raw,value=latest` | `latest` | 主分支构建 |

⚠️ **不打 tag 就永远只有 `latest` / `main` / `sha-xxxx`**，所以 `sha-527fec1` 不是乱码，
只是「当时还没有版本号，只能用提交哈希当标签」。要版本号 → 打 tag。

## 发一个新版本（复制即用）

```bash
cd <服务端目录>

# 1. 改版本号（package.json + 需要同步的地方）
#    - package.json 的 "version"
#    - 有 UI 展示版本号的话也一起改
git add -A
git commit -m "release: v1.0.1"

# 2. 打 tag 并推送（tag 名必须以 v 开头、三段数字，才能匹配 v*.*.*）
git tag v1.0.1
git push origin main
git push origin v1.0.1

# 3. 等 Actions 跑完（大概 2-5 分钟），确认新标签出现
curl -s "https://ghcr.io/token?scope=repository:yezi8430/chatz:pull&service=ghcr.io" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))"
#   拿到的 token 记为 $TK，然后：
curl -s -H "Authorization: Bearer $TK" "https://ghcr.io/v2/yezi8430/chatz/tags/list"
#   应该能看到 1.0.1 和 1.0
```

## 服务器上升级

```bash
cd /root/chatz/chatz
docker compose pull
docker compose up -d
```

⚠️ 如果输出 `Skipped - No image to be pulled`，说明**本地这份 `docker-compose.yml`
还是老的**（或者 `image:` 那行写的是 `build: .`）。要么改文件，要么重新拉一份：

```bash
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/yezi8430/Chatz/main/docker-compose.yml
```

## 服务器上该用哪个标签

- **`latest`（compose 默认）**：跟随主分支最新构建，push 完在服务器上 `pull` 就能拿到，
  升级**不用改 compose**。代价：可能带上还没发版的改动。
- `1.0`：自动跟随 1.0.x 补丁，升到 1.1 需要手动改一次。
- `1.0.0`：钉死版本，`docker compose pull` 不会把你升上去，但每次发版要手动改。

当前 `docker-compose.yml` 里写的是 `ghcr.io/yezi8430/chatz:latest`（不钉版本）。
想换成别的就改那一行 `image:`，重新 pull 即可。

## 坑

| 现象 | 原因 / 处理 |
|---|---|
| 只有 `sha-xxxx` 没有版本号 | 没打 tag，或 tag 名不是 `v1.2.3` 格式 |
| Actions 报 403 | job 缺 `permissions: packages: write` |
| `must be lowercase` | GHCR 镜像名必须全小写。仓库叫 `Chatz`（大写）⇒ `github.repository` 带大写，而 `build-push-action` 的 `outputs: type=image,name=...` **不像 metadata-action 那样自动转小写**。工作流里已加 `Normalize image name` 步骤，别再绕过它直接拼名字 |
| `unknown/unknown` 混进 manifest | buildx 默认生成 provenance attestation，`imagetools create` 会把它当成一个平台。两个 build 步骤都已加 `provenance: false` |
| 整个 run 卡在 Queued 十几分钟然后被取消 | **先看 <https://www.githubstatus.com>**。GitHub 故障期间 x86 runner 会排队不到（ARM runner 反而正常）；与代码无关，等恢复后 Re-run 即可。注意排队阶段别点 Cancel —— 取消后 amd64 只推了 digest 没打 tag，`latest` 不会更新 |
| 构建十几分钟然后超时 | 旧的单 job `platforms: linux/amd64,linux/arm64` 写法（arm64 走 QEMU 模拟）才会这样。现在是 3 个 job：amd64 与 arm64 **各自原生 runner 并行**，再用 `imagetools create` 合成，全流程约 40 秒 |
| 容器启动了但代码是旧的 | 镜像部署的；`docker compose restart` 没用，必须 `pull` + `up -d` |
| Dockerfile 改了但没生效 | 同上，`pull` 拿的是新镜像，本地没重新 build |
| shell 脚本在容器里报 `^M` | `.gitattributes` 已强制 LF；新增脚本别用 Windows 换行 |

## 安全

- `.env` 已在 `.gitignore` 里，**任何真实密钥都不要写进仓库 / 文档**。
  `src/tokenGen.js`、`docs/*.md` 里的示例必须是 `cz.xxxxxxxx...` 这种占位符。
- 换主密钥：改 `.env` 的 `AUTH_TOKEN`（或 `AUTH_TOKEN_FILE` 指向的文件），然后
  `docker compose up -d --force-recreate`。启动时 `src/migrate.js` 会把 devices 表的
  「默认 Token」行同步成新值，**并把生效值写回 `meta.auth_token`**（v1.2.1 起）。
  🔴 三个高频坑（2026-10-05 实测）：
  - `.env` 里那行**行首还留着 `#`** ⇒ 效果等同没设，而 compose 是 `required: false`，
    一点错都不报。自查 `docker compose config | grep AUTH_TOKEN`。
  - 只做 `docker compose restart` / 普通 `up -d` ⇒ **不重读 env_file**，值进不了容器。
    必须 `--force-recreate`。
  - `AUTH_TOKEN_FILE` 指向的文件读不到 ⇒ 服务端**拒绝启动**（不会静默用回旧值）。
  换完看日志：`[文件]` / `[环境变量]` = 成功；`[数据库]` = 没换掉（还是库里那枚）。
  超管还要重新登录一次（他的登录 token 就是主密钥）。

- ⚠️ **v1.2.1 之前**：env / 文件来源的值**不会**写回 `meta.auth_token`，于是库里停在
  很久以前的旧值。那时"删掉 `.env` 里的 AUTH_TOKEN"是危险的 —— 会静默回落到旧密钥。
  升级到 1.2.1 之后先带 env 启动一次（触发同步），再删就安全了。
