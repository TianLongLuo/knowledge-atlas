# Knowledge Atlas

A private knowledge-management app for a Linux server: Notion incremental sync, PostgreSQL document storage, Chroma HNSW vector retrieval, DeepSeek-powered RAG answers, and a readable 2D knowledge map.

## Current Logic

- Documents are stored in PostgreSQL and split into chunks for search and citation.
- Chroma stores embeddings for those chunks. Search and the AI assistant both retrieve from this existing vector database.
- The AI assistant first retrieves relevant chunks, then sends only that context plus the user question to DeepSeek. Answers include citations back to local documents.
- Assistant memory is inspectable: L0 stores raw conversation turns, L1 reports the real Chroma vector count, L2 stores the retrieved context used for each answer, and L3 is reserved for explicitly reviewed profile data. Recent L0 turns are included in the next DeepSeek request.
- The agent status endpoint checks three things separately: whether DeepSeek is configured, whether DeepSeek is reachable, and whether the vector store contains vectors.
- The knowledge map uses Chroma ANN Top-K edges and an Obsidian-style 2D force layout. Source-type pills show the type count and filter the graph; hovering reveals only the strongest links, and linked notes open in an in-page reader.
- Authentication uses `HttpOnly` cookies. Production rejects default secrets, default database passwords, and missing admin password hashes.
- CORS accepts only explicit origins. `/api/health` and `/api/ready` are available for uptime and dependency checks.

## Docker Deployment

Create the server environment file:

```bash
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "import bcrypt, getpass; p=getpass.getpass().encode(); print(bcrypt.hashpw(p, bcrypt.gensalt()).decode())"
```

Put the first command output in `SECRET_KEY`. Put the bcrypt output in `ADMIN_PASSWORD_HASH`; keep quotes around the value because bcrypt hashes contain `$`.

Set a strong `POSTGRES_PASSWORD`, Notion settings if you use Notion sync, and the DeepSeek settings below. Then start the stack:

```bash
docker compose up --build -d
docker compose ps
```

The default app URL is `http://YOUR_SERVER:3000`. For public deployment, put Caddy or Nginx in front, enable HTTPS, set `CORS_ORIGINS` to the real HTTPS origin, and set `SESSION_COOKIE_SECURE=true`.

If `NOTION_API_KEY` and `NOTION_DATABASE_ID` are configured, the backend syncs once at startup and then syncs incrementally every `NOTION_AUTO_SYNC_INTERVAL_MINUTES` minutes.

## DeepSeek And Vector RAG

Create a new DeepSeek key and put it in the server `.env`. Do not commit it to Git.

```dotenv
DEEPSEEK_API_KEY=your_new_deepseek_key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_SECONDS=45

# Must match the embedding model used when the current Chroma database was indexed.
# If you change it, re-index the knowledge base.
EMBEDDING_MODEL=all-MiniLM-L6-v2
```

Apply the change:

```bash
docker compose up -d --build backend
```

Then sign in and open `AI Assistant`. The status line should say:

- `DeepSeek connected` when the key, base URL, model, and outbound network are working.
- `configured but unreachable` when the key exists but the backend cannot reach DeepSeek.
- `Vector store ready (N vectors)` when Chroma has indexed knowledge chunks.

If the assistant still fails, check backend logs:

```bash
docker compose logs --tail=200 backend
```

Test DNS and HTTPS from inside the same backend container:

```bash
docker compose exec backend python -c "import socket; print(socket.gethostbyname('api.deepseek.com'))"
docker compose exec backend python -c "import urllib.request; print(urllib.request.urlopen('https://api.deepseek.com', timeout=10).status)"
```

The UI reports safe, specific diagnostics for HTTP 401 (invalid key), HTTP 404
(base URL/model), HTTP 429 (rate or account limit), connection/DNS errors, and
timeouts. Provider response bodies and credentials are never returned to the browser.

Most failures are one of: expired key, wrong `DEEPSEEK_BASE_URL`, wrong `DEEPSEEK_MODEL`, server egress blocked, or a backend container that was not rebuilt after editing `.env`.

## Local Development

Backend:

```bash
cd backend
cp .env.example .env
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload
```

Frontend:

```bash
cd frontend
npm ci
npm run dev
```

## Verification

```bash
cd backend && pytest -q
cd frontend && npm run lint && npm run build
```

Production database migrations should later be managed with Alembic. `create_all` remains only for first-start compatibility in the current deployment.
