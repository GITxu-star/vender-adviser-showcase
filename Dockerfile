# ============================================================
# 地摊顾问 —— 前后端同源单容器镜像
# 阶段 1：Node 构建前端 dist
# 阶段 2：Python 运行 FastAPI，并托管 dist（同源，无需 CORS / 无需两个域名）
# 用法：docker compose up -d --build
# ============================================================

# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web
WORKDIR /web

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 同源部署：前端请求走相对路径 /api，由同一个 FastAPI 进程处理
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# ---------- 阶段 2：后端 + 静态前端 ----------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    FRONTEND_DIST=/app/frontend/dist

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
# 国内服务器直连 PyPI 会超时，改用腾讯云内网镜像源
RUN pip config set global.index-url https://mirrors.cloud.tencent.com/pypi/simple \
    && pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=web /web/dist ./frontend/dist

# 向量库目录（首次启动若无 vector.db 会自动用 SILICONFLOW_API_KEY 重建）
RUN mkdir -p /app/backend/data

WORKDIR /app/backend
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
