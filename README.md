# Knowledge Atlas

面向 Linux 服务器的个人知识管理平台：Notion 增量同步、PostgreSQL 文档库、Chroma HNSW 向量检索、RAG 问答和交互式 3D 语义图谱。

## 本次工程基线

- Graph 后端通过 Chroma ANN Top‑K 建边，不再做全量 `O(n²)` 余弦比较。
- Graph 前端采用空间哈希近邻力、单批次 `LineSegments`、共享几何/材质、稳定节点 ID、局部一层图、节点搜索和完整 WebGL 资源回收。
- 登录使用 `HttpOnly` Cookie；生产环境拒绝默认密钥、默认数据库密码和未配置管理员密码。
- CORS 只接受显式来源；提供存活 `/api/health` 与依赖就绪 `/api/ready` 探针。
- 前后端文档、搜索、AI、同步和仪表盘契约已经统一。
- 提供 Docker Compose、非 root 镜像、健康检查和 GitHub Actions。

## Docker 部署

```bash
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "import bcrypt, getpass; p=getpass.getpass().encode(); print(bcrypt.hashpw(p, bcrypt.gensalt()).decode())"
```

把两条命令的结果分别填入 `.env` 的 `SECRET_KEY` 和 `ADMIN_PASSWORD_HASH`；bcrypt hash 含有 `$`，请保留 `ADMIN_PASSWORD_HASH='...'` 的单引号。再设置强随机 `POSTGRES_PASSWORD`、Notion 和 DeepSeek 配置，然后启动：

```bash
docker compose up --build -d
docker compose ps
```

默认入口是 `http://服务器地址:3000`。公网部署时应在前面放置 Caddy 或 Nginx、启用 HTTPS，把 `CORS_ORIGINS` 改为真实 HTTPS 域名，并设置 `SESSION_COOKIE_SECURE=true`。

## 本地开发

后端：

```bash
cd backend
cp .env.example .env
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload
```

前端：

```bash
cd frontend
npm ci
npm run dev
```

## 验证

```bash
cd backend && pytest -q
cd frontend && npm run lint && npm run build
```

生产数据库结构后续应通过 Alembic migration 管理；`create_all` 仅保留用于当前首次启动兼容。
