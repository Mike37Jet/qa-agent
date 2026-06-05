#!/usr/bin/env bash
# NOTA: sin `set -e` a propósito. Si el clonado del repo falla, NO queremos
# que el contenedor muera: el servidor debe quedar arriba para que el
# healthcheck de Railway pase y podamos ver los logs del error.
set -uo pipefail

# Evita que git se cuelgue pidiendo usuario/clave por consola si el token es malo.
export GIT_TERMINAL_PROMPT=0

# ─────────────────────────────────────────────────────────────────────────────
# Prepara el repo PHP en REPO_PATH (sobre el volumen). Corre en SEGUNDO PLANO
# para no bloquear el arranque del servidor ni el healthcheck. Idempotente.
# ─────────────────────────────────────────────────────────────────────────────
prepare_repo() {
  if [ -z "${REPO_PATH:-}" ] || [ -z "${PHP_REPO_URL:-}" ]; then
    echo "⚠ REPO_PATH o PHP_REPO_URL sin definir. El server arranca igual,"
    echo "  pero el agente no podrá trabajar el repo hasta configurarlos en Railway → Variables."
    return
  fi

  git config --global user.email "${GIT_AUTHOR_EMAIL:-qa-agent@bot.local}"
  git config --global user.name  "${GIT_AUTHOR_NAME:-QA Agent}"
  git config --global --add safe.directory "$REPO_PATH"

  if [ ! -d "$REPO_PATH/.git" ]; then
    echo "▶ Clonando repo PHP en $REPO_PATH ..."
    # NOTA: el scaffold (Fase 1) solo necesita el código + git + `php -l`.
    # NO se corre `composer install`: instalar la app Laravel completa (PHP 8.4,
    # ~40 extensiones, BD, redis) no aplica para generar un archivo de prueba.
    # La validación (Fase 2, que sí corre pest) va mejor en CI. Ver RAILWAY.md.
    git clone "$PHP_REPO_URL" "$REPO_PATH" \
      && echo "▶ Repo PHP listo en $REPO_PATH (sin composer install)." \
      || echo "⚠ git clone falló. Revisa PHP_REPO_URL / el token y vuelve a desplegar."
  else
    echo "▶ Repo PHP ya presente en $REPO_PATH (volumen persistente)."
  fi
}

prepare_repo &

echo "▶ Arrancando webhook server ..."
exec npm run webhook
