#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Prepara el repo PHP en REPO_PATH (sobre el volumen persistente) y arranca
# el servidor de webhooks. Idempotente: si el repo ya existe, no reclona.
# ─────────────────────────────────────────────────────────────────────────────

: "${REPO_PATH:?Falta REPO_PATH}"          # ej: /data/repo-php
: "${PHP_REPO_URL:?Falta PHP_REPO_URL}"    # ej: https://x-access-token:TOKEN@github.com/org/repo.git

# Identidad para los commits que hace el agente.
git config --global user.email "${GIT_AUTHOR_EMAIL:-qa-agent@bot.local}"
git config --global user.name  "${GIT_AUTHOR_NAME:-QA Agent}"
git config --global --add safe.directory "$REPO_PATH"

if [ ! -d "$REPO_PATH/.git" ]; then
  echo "▶ Clonando repo PHP en $REPO_PATH ..."
  git clone "$PHP_REPO_URL" "$REPO_PATH"
  echo "▶ composer install ..."
  ( cd "$REPO_PATH" && composer install --no-interaction --prefer-dist )
else
  echo "▶ Repo PHP ya presente en $REPO_PATH (volumen persistente)."
fi

echo "▶ Arrancando webhook server ..."
exec npm run webhook
