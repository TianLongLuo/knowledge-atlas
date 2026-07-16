# Knowledge Atlas deployment and Notion synchronization guide

This document is written for a deployment agent. Follow the order below and do not skip the verification section. PostgreSQL is the canonical store; ChromaDB is the search index; Notion is a bidirectional external copy.

## 1. What this release changes

- Notes created on the website are created in PostgreSQL, indexed in ChromaDB, and written to the configured Notion database.
- Website edits save to PostgreSQL immediately. Notion writes are debounced per document and serialized, so rapid autosaves become one external update instead of repeated block replacement.
- The Notion database title property is discovered from its schema. It does not have to be named `Name`.
- Long notes are uploaded in batches of 100 blocks; the previous silent 100-block truncation is removed.
- Notion requests retry up to three times. A failed write remains saved in Atlas, is recorded as `notion_writeback/failed`, and is retried during the next automatic Notion synchronization cycle.
- A missing Notion `Tags` property is created automatically as `multi_select`; existing `Tags`/`Tag`/`标签` fields are reused. `Category`/`Type`/`分类` is populated when present as `select`.
- The document list and dashboard use one cross-source exact-content identity. A completed full Notion sync also removes exact duplicate PostgreSQL/vector rows while preserving merged tags and Notion page aliases.
- The document editor has a compact, content-aligned toolbar and a wider independent writing surface.

## 2. Required services and persistent data

The supplied `docker-compose.yml` runs:

| Service | Purpose | Persistent volume |
| --- | --- | --- |
| `postgres` | Canonical documents, chunks, sync states, conversations | `postgres_data` |
| `backend` | API, embedding, Notion and DeepSeek integration | `chroma_data` mounted at `/app/data/chroma` |
| `frontend` | Next.js interface and same-origin API proxy | none |

Never delete the two named volumes during a normal update. Do not use `docker compose down -v` unless permanent data deletion is intended.

## 3. Notion preparation

1. Create or reuse a Notion internal integration and copy its secret.
2. Open the target Notion database, add the integration through **Connections**, and grant permission to read, insert, and update content.
3. Copy the database ID from its URL. Use the database ID, not a page ID and not a view ID.
4. Confirm that the database contains exactly one title property. Its display name may be English or Chinese.
5. Optional: add a `Category` select property. Atlas creates `Tags` automatically if it is absent, so the integration must be allowed to update the database schema.

A valid token that has not been connected to the database will still fail with a Notion permission/object-not-found error. Sharing the database with the integration is mandatory.

## 4. Environment configuration

From the repository root:

```bash
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "import bcrypt, getpass; p=getpass.getpass().encode(); print(bcrypt.hashpw(p, bcrypt.gensalt()).decode())"
```

Write the generated values and deployment-specific settings into `.env`:

```dotenv
POSTGRES_USER=atlas
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_DB=knowledge_atlas

SECRET_KEY=<at-least-32-random-characters>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH='<bcrypt-hash-including-dollar-signs>'

NOTION_API_KEY=<notion-integration-secret>
NOTION_DATABASE_ID=<notion-database-id>
NOTION_AUTO_SYNC_ENABLED=true
NOTION_AUTO_SYNC_INTERVAL_MINUTES=5
NOTION_WRITEBACK_DEBOUNCE_SECONDS=3

DEEPSEEK_API_KEY=<deepseek-key>
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_SECONDS=45

CORS_ORIGINS=["https://knowledge.example.com"]
SESSION_COOKIE_SECURE=true
```

For local HTTP-only testing, use `SESSION_COOKIE_SECURE=false` and set `CORS_ORIGINS` to the exact local frontend origin. Never commit `.env`.

## 5. First deployment

```bash
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 backend
```

Both `postgres` and `backend` must become healthy. The frontend is available on port `3000` by default.

For a public site, terminate TLS with Caddy, Nginx, or the existing platform proxy and forward all traffic to the frontend. The frontend proxies `/api/*` to the backend through the internal Docker network, so the backend port does not need to be public.

## 6. Updating an existing deployment

1. Back up PostgreSQL before changing code.
2. Pull the intended commit with a fast-forward-only update.
3. Keep the existing `.env`, `postgres_data`, and `chroma_data`.
4. Rebuild both application images.

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > knowledge_atlas_before_update.sql
git pull --ff-only origin main
docker compose up -d --build backend frontend
docker compose ps
```

This release does not add a database migration. `sync_states` and document metadata already hold the additional synchronization state. The first completed Notion sync reconciles exact duplicate rows created by older deployments.

## 7. Mandatory verification

### Service checks

```bash
curl -fsS https://knowledge.example.com/api/health
curl -fsS https://knowledge.example.com/api/ready
docker compose logs --tail=200 backend
```

Expected:

- `/api/health` reports `"notion_configured": true`.
- `/api/ready` returns HTTP 200 with PostgreSQL and Chroma both `true`.
- Backend logs contain no repeating Notion permission or schema errors.

### End-to-end website to Notion test

1. Sign in to Atlas.
2. Create a uniquely titled note such as `Notion writeback check 2026-07-15` and add several paragraphs.
3. Wait until the editor shows **Saved**, then allow several seconds for the debounced Notion write.
4. Open the configured Notion database and confirm that exactly one page with that title exists and contains the complete body.
5. Edit the same Atlas note, wait for **Saved**, and refresh Notion.
6. Confirm that the same page changed and that the old body was not duplicated below the new body.
7. Add tags in Atlas and confirm they appear in the Notion `Tags` multi-select property. If it did not exist, confirm Atlas created it.

### Synchronization state check

After authenticating in the browser, the application can read:

```text
GET /api/sync/status?source_type=notion_writeback
```

Each website note uses its Atlas document ID as `source_id`. A healthy entry has `status: completed` and a recent `last_synced_at`. A failed entry includes a safe `error_message` and will be retried automatically.

To retry one note immediately:

```text
POST /api/sync/notion/writeback/{document_id}
```

This endpoint requires the normal authenticated Atlas session.

## 8. Failure diagnosis

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `notion_configured: false` | Missing environment values or stale container | Set both Notion variables and rebuild/recreate `backend` |
| `object_not_found` or permission error | Database not connected to integration, or wrong ID | Share the database with the integration and verify the database ID |
| Database has no title property | Wrong target object or malformed database | Point `NOTION_DATABASE_ID` to a real Notion database |
| Atlas says saved but warns Notion will retry | Local save succeeded; external write failed | Read `notion_writeback` status and backend logs; fix configuration, then use the retry endpoint or wait for automatic sync |
| Duplicate body text from old deployments | Previous append-only updater | Edit and save the note once with this release; the complete body will replace top-level blocks |
| Long note incomplete | Deployment still runs an old backend image | Rebuild backend and verify the running Git commit/image |
| Repeated HTTP 429 | Notion rate limit | Increase `NOTION_WRITEBACK_DEBOUNCE_SECONDS`; let automatic retries run; avoid multiple backend replicas writing the same database |

Useful commands:

```bash
docker compose logs --since=15m backend
docker compose exec backend python -c "from config import settings; print(bool(settings.notion_api_key), settings.notion_database_id)"
docker compose restart backend
```

The second command intentionally prints only whether a token exists, never the token itself.

## 9. Data consistency rules for operators and future agents

1. PostgreSQL is authoritative for website edits. A Notion outage must not delete or roll back the local note.
2. ChromaDB is derived search data. Re-index it from PostgreSQL/Notion if it is lost; do not treat it as the only document store.
3. Do not introduce another direct document write path. All website create/update/delete operations must continue through `NoteService`.
4. Do not append the full body on every Notion update. Replace old top-level blocks and upload every batch.
5. Preserve `metadata.notion_page_id`, `metadata.notion_content_hash`, and the `notion_writeback` sync state.
6. Full-sync starts use a PostgreSQL advisory lock. Per-document debounce is process-local, so keep one backend application worker unless that queue is moved to Redis or another distributed worker.
7. Before declaring deployment complete, perform the create-and-edit test in both Atlas and Notion.

## 10. Rollback

The release has no schema migration, so code rollback is straightforward:

```bash
git checkout <previous-known-good-commit>
docker compose up -d --build backend frontend
docker compose ps
```

Keep the volumes. If a data restore is genuinely required, stop writers first and restore the PostgreSQL dump made before deployment. A code rollback alone does not require deleting or restoring data.
