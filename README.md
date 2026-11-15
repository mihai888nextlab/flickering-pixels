# Flickering Pixels

Blink NASA SPHEREx survey passes to find things that move in the infrared sky.

- `/tool`: sky map with a guided tour
- `/data-analysis`: blink bench (bands, spectra, moving objects, bookmarks)
- `/gallery`: the gallery

The app has two parts that run side by side:

| Part | Folder | Port |
|------|--------|------|
| Website (Next.js) | project root | 3000 |
| SPHEREx backend (Python, FastAPI) | `spherex-blink-demo/` | 8000 |

No accounts and no database. Bookmarks are saved in the browser.

## Requirements (Windows, macOS, Linux)

- **Node.js 20 or newer**: https://nodejs.org
- **Python 3.10 or newer** (3.12 recommended): https://www.python.org/downloads/
  - Windows: tick **"Add python.exe to PATH"** in the installer.
  - macOS: `brew install python@3.12` also works.
  - Linux (Debian/Ubuntu): `sudo apt install python3 python3-venv`

## First time

From the project folder, in any terminal (PowerShell, Terminal, bash):

```bash
npm install
npm run setup
```

`npm run setup` finds Python, creates `spherex-blink-demo/.venv`, and installs the backend's packages. It takes a few minutes the first time.

## Run it

```bash
npm run dev:all
```

This starts the backend and the website together. Open http://localhost:3000, and press **Ctrl+C** to stop both.

To run them in two separate terminals instead:

```bash
npm run spherex:api   # terminal 1: backend on http://127.0.0.1:8000
npm run dev           # terminal 2: website on http://localhost:3000
```

### Optional settings

Put these in `.env.local` (copy `.env.example`):

- `GROQ_API_KEY`: AI-written poems in the gallery.

These are environment variables for the run commands:

- `SPHEREX_PORT`: backend port (default `8000`).
- `SPHEREX_API_URL`: where the website finds the backend (default `http://127.0.0.1:8000`).
- `PORT`: website port (default `3000`).

## Troubleshooting

- **`Python 3.10+ not found`**: install Python (see above), open a new terminal, and run `npm run setup` again.
- **`Another next dev server is already running`**: a dev server is already running for this folder. Use that one, or stop it first.
- **`address already in use` / port 8000 busy**: another backend is running. Stop it, or use another port (`SPHEREX_PORT=8010` and `SPHEREX_API_URL=http://127.0.0.1:8010`).
- **Sharing the folder between Windows and WSL**: `.venv` only works on the system that made it. `npm run setup` rebuilds it for the system you run it on.

## Deploying

See [DEPLOY.md](DEPLOY.md). The deployment uses Docker and runs on any Linux server.
