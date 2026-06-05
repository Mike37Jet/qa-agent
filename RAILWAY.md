# Desplegar el Agente QA en Railway (24/7, sin nada local)

Guía paso a paso para que el agente corra solo en Railway, con URL fija HTTPS,
secretos seguros, firma de webhook verificada y commits que **persisten**.

Coste aproximado: **~$5/mes** (plan Hobby de Railway tras el crédito de prueba).
Lo único que gasta aparte son los **créditos de API de Anthropic** (~$0.10 por scaffold).

---

## Lo que ya quedó listo en el repo (no tienes que tocarlo)

- `Dockerfile` — imagen con Node + PHP 8.2 + Composer + git.
- `entrypoint.sh` — clona el repo PHP la 1ª vez (sobre el volumen) y arranca el server.
- `railway.json` — build por Dockerfile, healthcheck en `/health`, reinicio automático.
- `.dockerignore` — no sube `node_modules`, `.env`, etc.
- `src/webhook-server.ts` — ahora lee `PORT` del proveedor y **verifica la firma HMAC**.

---

## Paso 0 — Requisitos

- Cuenta en https://railway.app (login con GitHub).
- El código del agente en un repo de **GitHub** (ver Paso 1).
- Un **token/deploy key** para clonar el repo PHP desde el servidor.
- API Key de Anthropic dedicada (Console) con **límite de gasto**.
- Token y Team ID de ClickUp.

---

## Paso 1 — Subir el código del agente a GitHub

El proyecto aún no es un repo git. Desde `qa-agent/`:

```bash
cd qa-agent
git init
git add .
git commit -m "Agente QA listo para Railway"
gh repo create qa-agent --private --source=. --push   # o crea el repo en github.com y haz push
```

> `.env` y `node_modules` NO se suben (están en `.gitignore`). Correcto: los secretos van en Railway, no en el repo.

---

## Paso 2 — Crear el proyecto en Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → elige `qa-agent`.
2. Railway detecta el `Dockerfile` y `railway.json` automáticamente.
3. El primer build fallará o quedará en espera hasta configurar las variables (Paso 3) — normal.

---

## Paso 3 — Variables de entorno (secrets)

En el servicio → pestaña **Variables** → añade:

| Variable | Valor | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Paga el uso del agente (créditos de API) |
| `CLICKUP_TOKEN` | `pk_...` | Leer tareas y comentarios |
| `CLICKUP_TEAM_ID` | `1234567` | Tu workspace |
| `REPO_PATH` | `/data/repo-php` | Dónde vive el repo PHP (en el volumen) |
| `PHP_REPO_URL` | `https://x-access-token:TOKEN@github.com/org/repo-php.git` | Para clonar el repo PHP |
| `WEBHOOK_SECRET` | _(lo obtienes en el Paso 6)_ | Verificar firma del webhook |
| `GIT_AUTHOR_NAME` | `QA Agent` | Autor de los commits |
| `GIT_AUTHOR_EMAIL` | `qa-agent@tu-dominio.com` | Email de los commits |

> **`PHP_REPO_URL` con token**: crea un *fine-grained PAT* o *deploy token* en GitHub con
> acceso **solo a ese repo** y permiso de *Contents: read/write*. Formato:
> `https://x-access-token:ghp_xxx@github.com/org/repo-php.git`.
> Así el agente puede clonar (y más adelante, si quieres, hacer push de la rama).

---

## Paso 4 — Volumen persistente (para que los commits no se pierdan)

El disco de Railway es efímero. El agente hace commits locales → sin volumen se borran en cada redeploy.

1. Servicio → **Settings** → **Volumes** → **New Volume**.
2. **Mount path**: `/data` (coincide con `REPO_PATH=/data/repo-php`).
3. Guarda. Railway redeploya. En el primer arranque, `entrypoint.sh` clona el repo PHP
   dentro del volumen y corre `composer install`. En los siguientes, lo reutiliza.

---

## Paso 5 — Obtener la URL pública fija

1. Servicio → **Settings** → **Networking** → **Generate Domain**.
2. Te da algo como `https://qa-agent-production.up.railway.app`. Esa URL **no cambia**.
3. Verifica que está vivo:

```bash
curl https://qa-agent-production.up.railway.app/health
# → {"ok":true,"agent":"qa-agent webhook",...}
```

---

## Paso 6 — Registrar el webhook en ClickUp y capturar el secret

Una sola vez, con la URL fija de Railway. Necesitas `CLICKUP_TOKEN` y `CLICKUP_TEAM_ID` a mano:

```bash
CLICKUP_TOKEN=pk_xxx
CLICKUP_TEAM_ID=1234567
DOMINIO=https://qa-agent-production.up.railway.app

node -e "
fetch('https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook', {
  method:'POST',
  headers:{'Authorization':'${CLICKUP_TOKEN}','Content-Type':'application/json'},
  body: JSON.stringify({ endpoint:'${DOMINIO}/webhook', events:['taskCommentPosted'] })
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)));
"
```

La respuesta trae `"status":"active"` y, lo importante, un campo **`secret`**:

```json
{ "id": "...", "webhook": { "secret": "ABCD1234...", ... } }
```

4. Copia ese `secret` → pégalo en Railway como `WEBHOOK_SECRET` (Paso 3).
5. Railway redeploya. A partir de ahora el server **rechaza** cualquier POST sin firma válida (HTTP 401).

---

## Paso 7 — Probar de punta a punta

En una tarea de ClickUp que tenga un bloque **Gherkin** en la descripción, comenta:

- `@agente_qa genera` → genera el archivo PEST (rama + commit local).
- `@agente_qa valida` → valida que las pruebas sean fieles al Gherkin.

Mira los logs en Railway → pestaña **Deployments / Logs**. Deberías ver
`← Webhook recibido`, `→ scaffold ...`, y el `✅ RESULTADO`.

---

## Seguridad — checklist

- [x] **Firma HMAC** del webhook verificada (`WEBHOOK_SECRET`) — nadie ajeno dispara el agente.
- [x] Secretos como **variables de Railway**, nunca en el repo (`.env` en `.gitignore`).
- [x] API Key de Anthropic **dedicada y con tope de gasto** en el Console.
- [x] Token del repo PHP **fine-grained, solo ese repo**.
- [x] `permissionMode: "default"` (nunca `bypassPermissions`) — el agente corre acotado.
- [x] Todo dentro del **contenedor** Railway, aislado del resto.
- [x] HTTPS gratis de Railway, reinicio automático (`restartPolicyType: ALWAYS`).

---

## Costos

| Concepto | Coste |
|---|---|
| Railway Hobby (servicio + volumen pequeño) | ~$5/mes |
| Créditos de API Anthropic | ~$0.10 por scaffold (recarga lo que quieras) |
| ClickUp / GitHub | $0 (planes existentes) |

> Si quieres **$0 de infraestructura** y no te importa más configuración manual,
> la alternativa es una VM **Oracle Cloud Always Free** (siempre encendida, gratis de por vida),
> usando el mismo `Dockerfile`. Dímelo y te paso esa variante.

---

## Pendiente de diseño (opcional, recomendado)

Hoy el agente hace `git commit` **local, sin push** ([phase1-scaffold.ts:58](src/phase1-scaffold.ts)).
Con el volumen los commits persisten, pero **siguen viviendo solo en el servidor**.
Para que un humano abra el PR cómodamente, conviene que el agente haga
`git push -u origin DEV-XXXX` al final (el `PHP_REPO_URL` ya trae credenciales con write).
Es un cambio de 1 línea en el prompt de scaffold — avísame y lo hago.
