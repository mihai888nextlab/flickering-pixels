# Deploying Flickering Pixels

The whole app runs on one Linux server with Docker Compose (`docker-compose.prod.yml`). There are no accounts and no database.

| Service | What it is                                 | Reachable from internet |
|---------|--------------------------------------------|-------------------------|
| `caddy` | HTTPS (free Let's Encrypt cert, auto-renew) | yes, ports 80/443       |
| `web`   | Next.js app (`Dockerfile`)                  | no (only via Caddy)     |
| `api`   | SPHEREx FastAPI backend                     | no (only via Next.js)   |

Bookmarks are saved in each visitor's browser (`localStorage`), not on the server.

## 1. Server

- Any VPS with Ubuntu 24.04: Google Cloud, Hetzner, DigitalOcean, OVH, etc.
- Size: at least 2 vCPU, 4 GB RAM and 40 GB disk. Astropy and reprojection use a lot of memory, and the SPHEREx cache grows over time. If the boot disk is small, put Docker's data on a bigger disk (`"data-root"` in `/etc/docker/daemon.json`).
- In the provider's firewall, open ports 22, 80 and 443.

Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Domain

At your DNS provider, create these records pointing to the server's IP:

- `A` record for `example.com`
- `A` record for `www.example.com` (optional)

Wait until `ping example.com` shows the server IP.

## 3. Get the code onto the server and configure it

```bash
git clone https://github.com/mihai888nextlab/flickering-pixels.git
cd flickering-pixels
cp .env.production.example .env.production
nano .env.production
```

In `.env.production`, set `DOMAIN`. `GROQ_API_KEY` (gallery poems) and `SPHEREX_CONCURRENCY` are optional.

## 4. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

The first build takes a few minutes. Then open `https://example.com`.

## Everyday commands

The `dc` alias below saves typing:

```bash
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.production'
dc ps                          # status
dc logs -f web api             # live logs
git pull && dc up -d --build   # deploy a new version
dc restart api                 # restart one service
```

## Notes

- **Python jobs live in memory.** The `api` backend runs with a single worker, so restarting `api` cancels any loads in progress. The downloaded cutouts are kept in the `spherex-cache` volume and survive the restart.
- **The build reads `SPHEREX_API_URL`.** Next.js applies its rewrites at build time. If you rename the `api` service, change the `SPHEREX_API_URL` build argument in `docker-compose.prod.yml` to match.
- **Trying it locally.** Set `DOMAIN=localhost` and Caddy serves a self-signed certificate.
