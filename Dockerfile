# Imagen del Agente QA: Node (servidor + SDK) + PHP + Composer + git + PEST
FROM node:22-bookworm-slim

# ── Dependencias del sistema: PHP, Composer, git ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
      php8.2-cli php8.2-mbstring php8.2-xml php8.2-curl php8.2-zip \
 && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencias de Node (capa cacheable) ─────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# ── Código del agente ─────────────────────────────────────────────────────────
COPY . .

# Entrypoint: clona el repo PHP si hace falta y arranca el servidor.
RUN chmod +x /app/entrypoint.sh

# Railway inyecta PORT; lo documentamos.
EXPOSE 3721

ENTRYPOINT ["/app/entrypoint.sh"]
