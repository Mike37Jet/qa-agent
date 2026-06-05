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
    if git clone "$PHP_REPO_URL" "$REPO_PATH"; then
      echo "▶ composer install ..."
      ( cd "$REPO_PATH" && composer install --no-interaction --prefer-dist ) \
        || echo "⚠ composer install falló (revisa el repo PHP)."
    else
      echo "⚠ git clone falló. Revisa PHP_REPO_URL / el token y vuelve a desplegar."
    fi
  else
    echo "▶ Repo PHP ya presente en $REPO_PATH (volumen persistente)."
  fi
}

prepare_repo &

echo "▶ Arrancando webhook server ..."
exec npm run webhook
