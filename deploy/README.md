# Deploying the tournament server (Debian LXC on Proxmox)

The server runs in Docker inside the container. Data and logs live in `/mnt/data`, and
the Proxmox firewall controls who can reach it.

| Port | What | Who may connect |
|---|---|---|
| 8788 | Game server (raw TCP) | Everyone (players connect directly) |
| 8790 | Admin HTTP API | The Discord bot and the reverse proxy only |

## 1. Prepare the container (on the Proxmox host)

- **Static IP:** give the container a fixed LAN IP (static, or a DHCP reservation). The
  firewall, the bot and your router's port forward all point at it.
- **Docker support:** Docker inside an unprivileged LXC needs nesting and keyctl. Container
  → Options → Features → tick **nesting** and **keyctl**, then restart the container.
  (Or on the host: `pct set <CTID> --features nesting=1,keyctl=1`.)
- **/mnt/data:** if `/mnt/data` is a bind mount from the host into an *unprivileged*
  container, the container's root is uid 100000 on the host. If the server later fails
  with "permission denied" writing there, run on the host:
  `chown -R 100000:100000 <host path that is mounted as /mnt/data>`.

## 2. Install Docker (inside the container)

```bash
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh
docker compose version
```

## 3. Configure and start the server (inside the container)

```bash
cd /path/to/BalatroMultiplayerAPI-Server-conjoined
git switch tourney-admin && git pull
mkdir -p /mnt/data/balatro/data /mnt/data/balatro/logs
cp .env.example .env
nano .env
```

In `.env`:
- `ADMIN_TOKEN`: generate with `openssl rand -hex 32`. Put the same value in the bot's
  `BALA_ADMIN_TOKEN`.
- `ADMIN_HTTP_BIND`: this container's LAN IP (e.g. `192.168.1.50`).
- `DATA_DIR` / `LOGS_DIR`: already point at `/mnt/data/balatro/...`.

```bash
docker compose up -d --build
docker compose exec socket node dist/admin-cli.js status   # should print the settings
tail -f /mnt/data/balatro/logs/server.log                   # live log
```

Moving data from an earlier run? Stop the server, copy the old `./data/*` into
`/mnt/data/balatro/data/`, then start it again.

## 4. Log rotation (inside the container)

Everything the server prints goes to `/mnt/data/balatro/logs/server.log` (and to
`docker compose logs`). Rotate it daily, keeping 30 days:

```bash
cp deploy/logrotate/balatro-server-log /etc/logrotate.d/balatro-server-log
logrotate -d /etc/logrotate.d/balatro-server-log   # dry run: should list server.log
```

## 5. Firewall (on the Proxmox host)

Use Proxmox's firewall rather than ufw: Docker bypasses ufw for published ports, but
Proxmox filters traffic before it reaches the container.

1. **Turn on the datacenter firewall** without changing how the host itself is reached:
   Datacenter → Firewall → Options → **Firewall: Yes**, and leave **Input Policy: ACCEPT**.
   (Guest firewalls only work while this is on. If you ever set the datacenter input
   policy to DROP, first add rules allowing 8006 and 22 from your LAN, or you'll lock
   yourself out of the Proxmox UI.)
2. **Turn on the firewall for the container's network card:** Container → Network →
   `net0` → Edit → tick **Firewall**.
3. **Add the rules:** copy `deploy/proxmox/ct-firewall.fw.example` to the host as
   `/etc/pve/firewall/<CTID>.fw`, then edit the IPs (your LAN, the bot's machine, the
   proxy). It enables the container firewall with input policy DROP. You can also do the
   same in the UI: Container → Firewall (rules) and Firewall → Options.

## 6. Router

Forward TCP **8788** from your public IP to the container's LAN IP. Don't forward 8790.
Players set `server_url` (your public IP or hostname) and `server_port=8788` in the mod's
`.env`.

## 7. Check it

From the bot's machine (allowed):
```bash
curl -s http://<container IP>:8790/admin/status -H "Authorization: Bearer <ADMIN_TOKEN>"
```
From any other LAN machine this should time out (blocked):
```bash
curl -m 5 http://<container IP>:8790/admin/status
```
And the game port should be reachable from outside your network (e.g. from your phone on
mobile data): `nc -vz <public IP> 8788`.

## Updating

```bash
git pull && docker compose up -d --build
```
Data, logs and settings in `/mnt/data` are kept.
