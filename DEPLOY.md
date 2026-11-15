# Deploying Flickering Pixels

The whole app runs on one Linux server with Docker Compose (`docker-compose.prod.yml`):

| Service   | What it is                                   | Reachable from internet |
|-----------|----------------------------------------------|-------------------------|
| `caddy`   | HTTPS (free Let's Encrypt cert, auto-renew)   | yes, ports 80/443       |
| `web`     | Next.js app (`Dockerfile`)                    | no (only via Caddy)     |
| `api`     | SPHEREx FastAPI backend                       | no (only via Next.js)   |
| `db`      | Postgres 17                                   | no                      |
| `migrate` | Applies `drizzle/` migrations, then exits    | -                       |

## 1. Server

- Any VPS with Ubuntu 24.04: Hetzner, DigitalOcean, OVH, etc.
- Size: at least 2 vCPU, 4 GB RAM and 40 GB disk. Astropy and reprojection use a lot of memory, and the SPHEREx cache grows over time.
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

## 3. Google OAuth

In Google Cloud Console, go to **APIs & Services → Credentials** and open your OAuth client.

1. Add these two URLs:
   - Authorized JavaScript origin: `https://example.com`
   - Authorized redirect URI: `https://example.com/api/auth/callback/google`
2. On the OAuth consent screen, set **Publishing status** to **In production**. Otherwise only test users can sign in.

## 4. Get the code onto the server and configure it

```bash
git clone https://github.com/mihai888nextlab/sigur-nu-nsac.git
cd sigur-nu-nsac
cp .env.production.example .env.production
nano .env.production
```

In `.env.production`:

1. Set `DOMAIN`.
2. Fill in the two secrets:

   ```bash
   openssl rand -hex 24     # use as POSTGRES_PASSWORD
   openssl rand -base64 32  # use as BETTER_AUTH_SECRET
   ```

3. Add the Google client ID and secret.

## 5. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

The first build takes a few minutes. Then open `https://example.com`.

## Everyday commands

The `dc` alias below saves typing:

```bash
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.production'
dc ps                      # status
dc logs -f web api         # live logs
git pull && dc up -d --build   # deploy a new version (migrations run automatically)
dc restart api             # restart one service
```

Back up the database:

```bash
dc exec -T db pg_dump -U flicker flickering_pixels | gzip > backup-$(date +%F).sql.gz
```

Restore a backup:

```bash
gunzip -c backup.sql.gz | dc exec -T db psql -U flicker flickering_pixels
```

## Schema changes

1. On your machine: edit `src/db/schema.ts`, then run `npm run db:generate`.
2. Commit the new file in `drizzle/`.
3. On the server: `git pull && dc up -d --build`. The `migrate` service applies the migration before `web` starts.

## Notes

- **Python jobs live in memory.** The `api` backend runs with a single worker, so restarting `api` cancels any loads in progress. The downloaded cutouts are kept in the `spherex-cache` volume and survive the restart.
- **The build reads `SPHEREX_API_URL`.** Next.js applies its rewrites at build time. If you rename the `api` service, change the `SPHEREX_API_URL` build argument in `docker-compose.prod.yml` to match.
- **Trying it locally.** Set `DOMAIN=localhost` and Caddy serves a self-signed certificate. Google sign-in won't work unless you also add `https://localhost` to the OAuth client.
