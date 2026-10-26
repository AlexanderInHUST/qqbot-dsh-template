# 迁移到 Windows + WSL2

把正在 Mac 上跑的整套服务原样搬到 Windows 的 WSL2 里：QQ 登录态、长期记忆、B 站登录、DSH 会话和配置都带过去，不用重新扫码。

整体思路：代码走 git，密钥和运行期数据走一个迁移包（`scripts/migrate-export.sh` 生成），在新机器上 `scripts/migrate-import.sh` 一次恢复。

## 迁移包里有什么

| 内容 | 来源 | 为什么不放 git |
|---|---|---|
| `.env` | 模型中转站 Key、SnowLuma noVNC 密码 | 密钥 |
| `config/qq-bridge/config.json` | OneBot accessToken、白名单、主人 QQ 等 | 含 token；控制台会写回这个文件 |
| `config/`、`roles/` 的当前版本 | 导出那一刻的配置和人格卡 | 以防提交后又改过 |
| 7 个 docker 卷 | 见下表 | 运行期数据 |

| 卷 | 内容 |
|---|---|
| `qq-gateway-data` / `qq-client-config` / `qq-client-data` | SnowLuma 和 QQ 客户端：登录态、设备信息、OneBot 设置 |
| `dsh-home` | DSH 配置和全部会话记录 |
| `bridge-state` | qq-bridge 状态：会话映射、唤醒配置、黑话、表情包、控制台令牌 |
| `extras-state` | 长期记忆、搬图记录 |
| `sandbox-browser` | 沙箱 Chromium 的用户目录（B 站登录） |

迁移包里的东西足够冒充这个 QQ 号和 B 站账号，只用 U 盘、`scp` 这类私下渠道拷贝，用完删掉。

## 第 0 步：准备 Windows

1. 开启 WSL2，装一个 Ubuntu（24.04 或 22.04）：管理员 PowerShell 里 `wsl --install -d Ubuntu-24.04`。
2. 给 WSL 足够的内存。整套服务上限约 7.5G，在 `%UserProfile%\.wslconfig` 里写：

   ```ini
   [wsl2]
   memory=12GB
   ```

   改完在 PowerShell 里 `wsl --shutdown` 再打开。
3. 装 Docker，二选一：
   - **Docker Desktop**（简单）：安装时勾选 WSL2 后端，Settings → Resources → WSL integration 里打开 Ubuntu。内存由上面的 `.wslconfig` 决定。
   - **WSL 里直接装 docker-ce**（不依赖 Docker Desktop）：先在 `/etc/wsl.conf` 里加 `[boot]` `systemd=true`，`wsl --shutdown` 重启后按 Docker 官方 Ubuntu 文档装 `docker-ce docker-ce-cli containerd.io docker-compose-plugin`，再 `sudo usermod -aG docker $USER`，重新登录。
4. 在 Ubuntu 里确认：`docker info` 能连上，`docker compose version` 是 v2，`id` 显示 `uid=1000 gid=1000`（WSL 默认的第一个用户就是）。

## 第 1 步：在 Mac 上导出

```sh
cd ~/qqbot_agent
git status                 # 确认改动都提交了，没提交的配置改动也会进迁移包，但代码改动只走 git
scripts/migrate-export.sh  # 停掉所有服务，生成 qqbot-migrate-<时间>.tar
```

导出后**不要再在 Mac 上启动**这套服务：同一个 QQ 号在两台机器同时在线，容易被踢下线或触发风控。

把代码带过去（三选一）：推到你自己的私有 git 仓库再在 WSL 里 clone；或者 `git bundle create qqbot.bundle --all` 拷过去 `git clone qqbot.bundle qqbot_agent`；或者直接把整个目录拷过去（记得带上 `.git`）。迁移包单独拷。

## 第 2 步：在 WSL 里导入

**项目一定要放在 WSL 自己的文件系统里**（例如 `~/qqbot_agent`），不要放在 `/mnt/c/...`：Windows 盘上权限不生效、文件读写很慢。

```sh
cd ~
git clone <你的仓库或 qqbot.bundle> qqbot_agent
cd qqbot_agent
scripts/migrate-import.sh /path/to/qqbot-migrate-<时间>.tar
```

`migrate-import.sh` 会：

1. 恢复 `.env`（权限 600）、`config/`、`roles/`（`config.json` 权限 640）。
2. 用迁移包恢复 7 个卷，保留文件的数字属主（沙箱 10001、extras 10002、控制面 1000）。
3. 跑 `scripts/preflight.sh --fix`，检查 Docker、目录位置、uid、换行符、密钥和端口。

`preflight.sh` 有“失败”项就先按提示处理，全部通过再继续。

## 第 3 步：构建和启动

```sh
docker compose build        # 第一次大约 10~20 分钟，会从 GitHub 拉 qq-bridge、从 npm 装 DSH 和 Playwright 的 Chromium
docker compose up -d
docker compose ps           # 8 个容器都应该是 Up
```

所有镜像都有 amd64 版本（SnowLuma 官方镜像是 amd64 + arm64 的多架构镜像，digest 不用改），本地镜像会按新机器的架构重新构建。

## 第 4 步：QQ 登录和验证

1. Windows 浏览器打开 http://127.0.0.1:6081（SnowLuma 的 noVNC，密码在 `.env` 的 `SNOWLUMA_VNC_PASSWD`），QQ 停在登录界面就点“登录”。
   换了机器和 IP，QQ 有可能要求扫码或手机确认，按提示做就行；卷里的设备信息已经带过来了，一般只需要点一下。
2. 看 bridge 是否连上：

   ```sh
   docker compose logs -f bridge
   # 应该看到：SnowLuma 已连接、机器人昵称: 鱼妹、DSH 已就绪（模式: reserved2）
   ```

3. 用大号私聊她一句，或在群 1100000001 里叫她“鱼妹”，确认能回。
4. 其他页面（都只在本机）：DSH Web http://127.0.0.1:3080，qq-bridge 控制台 http://127.0.0.1:3100，沙箱桌面 http://127.0.0.1:6080。
   用 Docker Desktop 时这些端口直接出现在 Windows 的 127.0.0.1 上；用 WSL 里的 docker-ce 时靠 WSL 的 localhost 转发（默认开着），打不开就在 WSL 里 `curl -I http://127.0.0.1:3080` 先确认服务本身是好的。

确认没问题后，删掉两边的迁移包和 Mac 上的 `backups/migrate-*`。Mac 上的卷可以留着当备份，确定不用了再 `docker compose down -v`（这一步不可恢复）。

## WSL 上和 Mac 不一样的地方

- **文件权限是真的。** Mac 的 Docker Desktop 不检查绑定挂载文件的权限，Linux 会。所以 `config.json` 必须属于 uid 1000、权限 640：dsh/bridge 以 uid 1000 读写它，extras（uid 10002）通过 `docker-compose.yml` 里的 `group_add: ["1000"]` 读它。WSL 用户不是 uid 1000 时，`sudo chown 1000:1000 config/qq-bridge/config.json`。
- **控制台改配置写不回文件。** `config.json` 是单个文件的绑定挂载，qq-bridge 控制台保存设置时用“写临时文件再改名”的方式覆盖它，在 Linux 上会因为挂载点不能被替换而失败（Mac 上也一样）。改配置就直接编辑宿主机上的 `config/qq-bridge/config.json`，再 `docker compose restart bridge`。
- **换行符。** 仓库带了 `.gitattributes` 强制 LF。如果曾在 Windows 一侧（比如 Windows 的 git）检出过，脚本可能变成 CRLF，容器会报 `/bin/sh^M` 之类的错；`scripts/preflight.sh --fix` 会改回来。
- **固定 IP。** SnowLuma 固定在 egress 网络的 172.19.0.2，其他容器只从 172.19.1.0/24 自动分配。如果新机器上 172.19.0.0/16 已被别的 docker 网络或公司 VPN 占用，`docker compose up` 会报网段冲突，需要把 `docker-compose.yml` 里 egress 的 `subnet`、`ip_range` 和 snowluma 的 `ipv4_address` 一起改成别的网段。
- **Docker 重启后要点一次登录。** 和 Mac 一样，Docker（或 WSL）重启后 QQ 会停在登录界面，去 6081 点一下；bridge 会一直等到能连上为止。
- **WSL 会自己休眠。** 关掉所有 WSL 终端一段时间后 WSL 可能停掉，机器人就离线了。用 Docker Desktop 时它会让 WSL 一直运行；用 docker-ce 时可以在 `.wslconfig` 的 `[wsl2]` 里加 `vmIdleTimeout=-1`，并保持一个 WSL 进程在跑（或者用任务计划程序在开机时执行 `wsl -d Ubuntu-24.04 -e true`）。

## 回滚

迁移出问题时，在 WSL 里 `docker compose down`，回到 Mac 上 `docker compose up -d` 即可：导出时 Mac 上的卷没有被改动。两边不要同时运行。

## 出问题时先看

| 现象 | 多半是 |
|---|---|
| `preflight.sh` 报项目在 `/mnt/` 下 | 挪到 `~/qqbot_agent` |
| extras 日志里 `PermissionError: '/config/qq-bridge.json'` | `config.json` 权限不是 640，或不属于 gid 1000 |
| bridge 日志里 `EACCES` 读写 `config.json` | `config.json` 不属于 uid 1000 |
| `config.json` 变成了一个目录 | 启动时文件不存在，docker 自动建了目录；删掉后重新导入 |
| `Address already in use`（网络） | 172.19.0.2 被占了：`docker compose down` 再 `up -d`（down 会重建网络） |
| `Pool overlaps with other one on this address space` | 172.19.0.0/16 和别的网络冲突，见上面“固定 IP” |
| bridge 一直打印“还连不上 SnowLuma 的 OneBot” | QQ 停在登录界面，去 6081 点登录 |
