# Cómo levantar el Agente QA (local)

Guía rápida para arrancar todo en tu máquina. Asume que ya clonaste el proyecto.

---

## 1. Requisitos previos

- **Node.js 18+** (`node --version`)
- **git**, **PHP 8.3+** y **Composer** en el repo PHP objetivo
- Una **API Key de Anthropic** (`sk-ant-...`) → https://platform.claude.com
- Un **token de ClickUp** (`pk_...`) → ClickUp → Settings → API de ClickUp
- Una cuenta de **ngrok** (gratis) → https://ngrok.com → "Your Authtoken"

---

## 2. Instalar dependencias

```bash
cd qa-agent
npm install
```

---

## 3. Configurar el `.env`

Copia la plantilla y rellena tus valores:

```bash
cp .env.example .env
```

Edita `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...          # tu API key de Anthropic
CLICKUP_TOKEN=pk_...                  # token personal de ClickUp
CLICKUP_TEAM_ID=1234567               # ID del workspace
REPO_PATH=/ruta/absoluta/al/repo-php  # repo donde está PEST
WEBHOOK_PORT=3721                     # opcional (default 3721)
NGROK_AUTHTOKEN=...                   # authtoken de ngrok
```

Verifica que carga bien:

```bash
node -e "require('dotenv').config({override:true}); ['ANTHROPIC_API_KEY','CLICKUP_TOKEN','CLICKUP_TEAM_ID','REPO_PATH','NGROK_AUTHTOKEN'].forEach(k=>console.log(k+':', process.env[k]?'OK':'FALTA'))"
```

---

## 3.1 — ¿Con qué cuenta / token corre el agente?

El agente puede pagar su uso de **tres** formas. El orden de prioridad es:

1. **`ANTHROPIC_API_KEY` activa en `.env`** → usa **créditos de API** (saldo prepago del Console).
   Gasta dinero por token (~$0.10/scaffold). Es lo recomendado para **producción**.
2. **API key comentada + `CLAUDE_CONFIG_DIR` apuntando a un directorio con login** → usa la
   **suscripción** (Pro/Max) de la cuenta de ese directorio. No gasta créditos. Ideal para **probar**.
3. **API key comentada y sin `CLAUDE_CONFIG_DIR`** → usa tu login global de Claude Code
   (`~/.claude`), es decir tu cuenta personal.

### Usar una cuenta de suscripción SOLO para el agente (sin tocar tu Claude Code personal)

```bash
# 1. Login de la cuenta deseada en un directorio separado (abre el navegador):
CLAUDE_CONFIG_DIR="$HOME/.claude-qa-agent" npx @anthropic-ai/claude-code login

# 2. En el .env del agente, comenta la API key y apunta al directorio:
#    # ANTHROPIC_API_KEY=sk-ant-...
#    CLAUDE_CONFIG_DIR=/Users/<tu-usuario>/.claude-qa-agent
```

Verifica qué cuenta quedó en ese directorio:

```bash
cat ~/.claude-qa-agent/.claude.json | python3 -c "import sys,json; a=json.load(sys.stdin).get('oauthAccount',{}); print(a.get('emailAddress'), '·', a.get('billingType') or a.get('organizationType'))"
```

> Tu sesión normal de Claude Code (la del día a día) sigue usando `~/.claude` y tu cuenta
> personal. El agente solo usa la cuenta de `CLAUDE_CONFIG_DIR`. No se pisan.

### Para producción

Descomenta `ANTHROPIC_API_KEY` en el `.env` (tiene prioridad sobre todo) y usa una API key
dedicada con límite de gasto. La suscripción tiene límites más estrictos y no es ideal para
uso automático 24/7. Ver `PRODUCCION.md`.

---

## 4. Levantar el servidor y el túnel

Necesitas **dos terminales** abiertas en `qa-agent/`:

```bash
# Terminal 1 — servidor que recibe los webhooks de ClickUp
npm run webhook
```

```bash
# Terminal 2 — túnel HTTPS público hacia el servidor local
npm run tunnel
```

La Terminal 2 te dará una URL pública, por ejemplo:

```
https://xxxx-xx.ngrok-free.app
```

---

## 5. Registrar el webhook en ClickUp (solo la primera vez)

ClickUp no muestra los webhooks en la UI, se crean por API. Reemplaza la URL por la tuya de ngrok y ejecuta:

```bash
node -e "
const {config}=require('dotenv'); config({override:true});
fetch('https://api.clickup.com/api/v2/team/'+process.env.CLICKUP_TEAM_ID+'/webhook', {
  method:'POST',
  headers:{'Authorization':process.env.CLICKUP_TOKEN,'Content-Type':'application/json'},
  body: JSON.stringify({ endpoint:'https://XXXX.ngrok-free.app/webhook', events:['taskCommentPosted'] })
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)));
"
```

Debe responder con `"status": "active"`.

> ⚠️ La URL de ngrok cambia cada vez que reinicias el túnel (en el plan free).
> Si reinicias, vuelve a registrar el webhook con la URL nueva.

---

## 6. Usarlo

En cualquier tarea de ClickUp que tenga un bloque **Gherkin** en la descripción, escribe un comentario:

| Comentario | Qué hace |
|---|---|
| `@agente_qa genera` | Genera el archivo PEST desde el Gherkin (rama + commit local) |
| `@agente_qa valida` | Valida que las pruebas sean fieles al Gherkin y deja el veredicto |

Verás la actividad en la **Terminal 1** (logs del servidor).

---

## Comandos sueltos (sin webhook)

Si quieres correr el agente a mano sin pasar por ClickUp:

```bash
npm run scaffold -- DEV-8697     # genera el archivo PEST
npm run validate -- DEV-8697     # valida las pruebas
```

---

## Verificar que el servidor está vivo

```bash
curl http://localhost:3721/health
```
