# 服务端部署手册（阿里云轻量 / 2C2G）

服务端是**零运行时依赖**的：`node:http` + `node:sqlite` + `node:crypto`。
部署时不需要 `npm install`，把代码拷上去、`node` 跑起来就行。

- 宿主：Alibaba Cloud Linux（RHEL 系，用 `dnf`）
- 规格：2 vCPU / 2 GiB / 40 GiB ESSD（够用，但要加 swap，见第 2 步）
- Node：**≥ 22.5**（`node:sqlite` 从这个版本开始有）

> 没有域名也能先跑：用 `http://<公网IP>:3000` 自测（开发期）。
> 但 App 上架需要 App 备案，而 App 备案要填域名——见设计文档 §11.11。

---

## 1. 拿代码

```bash
sudo mkdir -p /opt/refillpal && sudo chown "$USER" /opt/refillpal
cd /opt/refillpal
git clone <你的仓库地址> .
```

只需要 `server/` 和 `packages/refillpal-core/` 两个目录，但整个仓库拷过去最省事。

## 2. 加 swap（2 GiB 内存必做）

不加 swap 时，Node + SQLite 在某些时刻会被 OOM killer 干掉，表现为「服务莫名重启」。

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # 确认 Swap 一行有 2.0Gi
```

## 3. 装 Node 22 LTS

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node -v   # 需要 >= 22.5
```

## 4. 建目录与配置

```bash
sudo useradd --system --home /opt/refillpal --shell /sbin/nologin refillpal || true
sudo mkdir -p /var/lib/refillpal /var/backups/refillpal /etc/refillpal
sudo chown -R refillpal:refillpal /var/lib/refillpal /var/backups/refillpal

# JWT 密钥：随机 32 字节，只存在服务器上
openssl rand -hex 32
```

写入 `/etc/refillpal/env`（权限 600，**不要进 git**）：

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DB_FILE=/var/lib/refillpal/refillpal.db
JWT_SECRET=<上一步生成的 64 位十六进制>
JWT_TTL_SECONDS=2592000
CORS_ORIGIN=*
```

```bash
sudo chmod 600 /etc/refillpal/env
sudo chown refillpal:refillpal /etc/refillpal/env
```

> `HOST=127.0.0.1` 是有意的：让 Node 只监听本机，由 Caddy/nginx 对外。

## 5. 先手动跑一次

```bash
sudo -u refillpal env $(cat /etc/refillpal/env | xargs) node /opt/refillpal/server/src/main.js
```

另开一个终端：

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"data":{"status":"ok","time":"..."}}
```

**成功标志**：返回 `ok: true`，并且 `/var/lib/refillpal/refillpal.db` 已被创建。`Ctrl+C` 停掉。

## 6. systemd 托管

`/etc/systemd/system/refillpal-api.service`：

```ini
[Unit]
Description=RefillPal API
After=network.target

[Service]
Type=simple
User=refillpal
Group=refillpal
WorkingDirectory=/opt/refillpal
EnvironmentFile=/etc/refillpal/env
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/usr/bin/node server/src/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now refillpal-api
sudo systemctl status refillpal-api
sudo journalctl -u refillpal-api -f    # 看实时日志
```

**成功标志**：`active (running)`，`curl http://127.0.0.1:3000/api/health` 有返回。

## 7. 对外暴露（二选一）

### 7.1 有域名 + 备案：Caddy 自动 HTTPS（推荐）

```bash
sudo dnf install -y caddy    # 或按官方文档装
```

`/etc/caddy/Caddyfile`：

```
api.your-domain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl enable --now caddy
```

Caddy 会自动申请并续期 Let's Encrypt 证书。**成功标志**：`curl https://api.your-domain.com/api/health` 返回 `ok`。

> 阿里云安全组放行 80 / 443；5432 与 3000 不要对外开放。

### 7.2 没域名（仅开发/内测）

直接把 `HOST` 改成 `0.0.0.0`，安全组放行 3000，用 `http://<公网IP>:3000` 访问。

⚠️ 这条只适合开发自测：大陆服务器用 IP 对外提供服务同样需要备案（见设计文档 §11.11），
且 App 正式包要求 HTTPS。**别用它长期跑**。

## 8. 备份（必做）

数据丢了就是一年的记录。用 SQLite 的 `VACUUM INTO` 生成一致快照（不能直接 `cp`）：

```bash
# 手动跑一次
DB_FILE=/var/lib/refillpal/refillpal.db \
  sudo -u refillpal node /opt/refillpal/server/scripts/backup.js /var/backups/refillpal
```

`/etc/cron.d/refillpal-backup`（每天 03:10，保留 30 天）：

```cron
10 3 * * * refillpal DB_FILE=/var/lib/refillpal/refillpal.db node /opt/refillpal/server/scripts/backup.js /var/backups/refillpal
```

**恢复**：

```bash
sudo systemctl stop refillpal-api
sudo -u refillpal cp /var/backups/refillpal/refillpal-20260925-0310.db /var/lib/refillpal/refillpal.db
sudo systemctl start refillpal-api
```

建议每月做一次恢复演练（恢复到临时库、用 `sqlite3` 或一段 Node 脚本读一下行数），
**没演练过的备份不算备份**。

## 9. 升级

```bash
cd /opt/refillpal
git pull
sudo systemctl restart refillpal-api
```

不需要 `npm install`（零依赖），也不需要停库。数据库表结构是幂等的 `CREATE ... IF NOT EXISTS`。

## 10. 健康检查与排查

| 现象 | 先看哪里 |
| --- | --- |
| 502 / 连不上 | `systemctl status refillpal-api`、`journalctl -u refillpal-api -n 100` |
| 能连上但 401 | 客户端有没有带 `Authorization: Bearer <token>`；token 是否过期 |
| 注册报 `EMAIL_TAKEN` | 邮箱已注册，直接登录 |
| 启动报 `生产环境必须设置 JWT_SECRET` | `/etc/refillpal/env` 里没配或没被 systemd 读到 |
| 启动报 `node:sqlite` 找不到 | Node 版本 < 22.5 |
| 服务时不时重启 | 大概率 OOM：确认 swap 已开、`NODE_OPTIONS=--max-old-space-size=384` 生效 |
| 备份文件很小/为空 | 检查 `DB_FILE` 路径是否指向真实库 |

## 11. App 连上来

App 的接口地址在构建时注入：

```bash
cd apps/mobile
EXPO_PUBLIC_API_BASE_URL=https://api.your-domain.com npx expo start
```

开发期也可以用局域网：`EXPO_PUBLIC_API_BASE_URL=http://192.168.1.10:3000`（需 `HOST=0.0.0.0`）。

**成功标志**：App 里注册 → 建家 → 加物品 → 记一笔，服务端日志出现对应的 `POST /api/... 200`。
