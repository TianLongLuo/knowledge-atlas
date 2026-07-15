# Knowledge Atlas

A private knowledge-management app for a Linux server: Notion incremental sync, PostgreSQL document storage, Chroma HNSW vector retrieval, DeepSeek-powered RAG answers, and a readable 2D knowledge map.

For production rollout, Notion permissions, end-to-end checks, troubleshooting, and rollback, follow [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).

## Current Logic

- Documents are stored in PostgreSQL and split into chunks for search and citation.
- Chroma stores embeddings for those chunks. Search and the AI assistant both retrieve from this existing vector database.
- The AI assistant first retrieves relevant chunks, then sends only that context plus the user question to DeepSeek. Answers include citations back to local documents.
- Assistant memory is inspectable: L0 stores raw conversation turns, L1 reports the real Chroma vector count, L2 stores the retrieved context used for each answer, and L3 stores evidence-backed insight candidates. Recent L0 turns and only user-confirmed L3 insights are included in later DeepSeek requests.
- The agent status endpoint checks three things separately: whether DeepSeek is configured, whether DeepSeek is reachable, and whether the vector store contains vectors.
- The knowledge graph uses document-level Chroma ANN neighbors, Mutual-KNN noise filtering, a Canvas force engine, zoom/pan/node dragging, normalized source types, tag filters, global and depth-1/2/3 local graphs, and an in-page note reader.
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

### Personal knowledge and reflection memory

Every assistant turn follows the same grounded pipeline:

1. Store the raw user turn as L0 conversation evidence.
2. Retrieve relevant chunks from Chroma. If nothing relevant is found, do not ask the model to invent an answer.
3. Store the exact retrieved context as L2 retrieval evidence.
4. Send the retrieved notes, recent conversation, and user-confirmed long-term insights to DeepSeek.
5. Return citations and store the assistant turn.
6. Ask DeepSeek for at most one durable insight candidate. The candidate remains `pending` and is excluded from future prompts until the user confirms it.

The UI offers three modes:

- `Knowledge`: direct answers grounded in notes.
- `Reflection`: separates explicit evidence from inference and asks a clarifying question.
- `Socratic`: explores assumptions and trade-offs without making decisions for the user.

The review queue allows each proposed value, goal, belief, tension, or pattern to be confirmed or rejected. Rejected and pending hypotheses are never treated as established facts about the user.

### Obsidian-style knowledge graph

- `react-force-graph-2d` provides a continuously simulated Canvas graph with zoom, pan, drag-to-pin, fit-to-screen, and stable collision-free positioning.
- Node colors represent normalized source types (`Notion`, `Manual note`, `Web page`, `File`, `Imported`, `Unknown`). Importer-specific labels no longer become arbitrary graph types.
- Tags and source types can be independently filtered.
- Hovering focuses direct relationships; selecting a note enables depth-1/2/3 local graph exploration.
- The note reader can open the full document or start a document-scoped AI conversation.

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
