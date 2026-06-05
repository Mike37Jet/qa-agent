# Llevar el Agente QA a producción

En local funciona con `ngrok` + dos terminales. Para producción necesitas que corra
**solo, 24/7, con una URL fija y de forma segura**. Esta guía cubre qué cambia.

---

## Resumen de lo que cambia vs. local

| Aspecto | Local (hoy) | Producción |
|---|---|---|
| URL pública | ngrok (cambia al reiniciar) | URL fija (dominio o host del PaaS) |
| Proceso | dos terminales manuales | servicio gestionado que se reinicia solo |
| Webhook ClickUp | re-registrar cada vez | registrar una vez con la URL fija |
| Seguridad | webhook abierto | verificación de firma del webhook |
| Secretos | archivo `.env` | variables de entorno del proveedor (secrets) |
| Credenciales Anthropic | login / API key personal | **API Key** de Console dedicada |

---

## Paso 1 — Elegir dónde desplegar

Opciones de menor a mayor esfuerzo:

- **Railway / Render** (recomendado para empezar): deploy desde el repo, URL fija con HTTPS, secrets en el panel. Plan barato (~$5/mes).
- **VPS propio** (DigitalOcean, EC2, Hetzner): más control, requiere configurar Nginx + dominio + systemd.
- **Contenedor** (Docker) en cualquiera de los anteriores: lo más portable y aislado (recomendado por seguridad — ver Paso 6).

---

## Paso 2 — Adaptar el servidor

El código ya corre headless. Solo dos detalles:

1. **El puerto debe leer la variable del proveedor.** Railway/Render inyectan `PORT`. Ya
   usamos `WEBHOOK_PORT`; añade un fallback en `src/webhook-server.ts`:

   ```ts
   const PORT = process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3721";
   ```

2. **Quitar ngrok.** En producción no se usa el túnel; la URL la da el proveedor.
   El script `npm run tunnel` solo es para local.

> Importante: en producción **el `REPO_PATH` debe existir en el servidor**. El servidor
> necesita una copia del repo PHP con `git` y PEST instalados para que el agente trabaje
> (ver Paso 4).

---

## Paso 3 — Secretos como variables de entorno (no subir `.env`)

`.env` ya está en `.gitignore` — nunca se commitea. En el panel del proveedor define
como **secrets**:

```
ANTHROPIC_API_KEY
CLICKUP_TOKEN
CLICKUP_TEAM_ID
REPO_PATH
WEBHOOK_SECRET     ← nuevo, ver Paso 5
```

El agente se paga con **créditos de API del Console** (la `sk-ant-...` + saldo prepago),
NO con la suscripción Pro de claude.ai. Son dos bolsas de dinero separadas:

- **Suscripción Pro** (claude.ai) → tu uso interactivo cuando chateas. El agente no la toca.
- **Créditos de API** (los que recargas en el Console) → lo que consume este agente, por token.
  A ~$0.10 por scaffold, $5 alcanzan para ~50 tareas.

Para producción, usa una API Key **dedicada** (no la misma que para experimentar) con un
**límite de gasto** configurado en el Console, para controlar el presupuesto.

---

## Paso 4 — El repo PHP en el servidor

El agente ejecuta `git` y `pest` sobre un repo real. En el servidor:

```bash
git clone <repo-php> /app/repo-php
cd /app/repo-php && composer install
```

- Configura una **clave SSH de solo-deploy** para que el agente pueda hacer fetch/branch.
- El agente hace **commit local, nunca push** (decisión de diseño). El push/PR lo decide
  un humano o un paso de CI controlado.
- Considera correr la Fase 2 (validación) mejor dentro de **CI** (GitHub Actions) al abrir
  el PR, en vez de en este servidor — ver Paso 7.

---

## Paso 5 — Seguridad: verificar la firma del webhook (IMPORTANTE)

Hoy el endpoint `/webhook` acepta cualquier POST. En producción **cualquiera con la URL
podría disparar el agente**. ClickUp firma cada webhook con HMAC-SHA256 usando el `secret`
que devuelve al crearlo (cabecera `X-Signature`).

Hay que validar esa firma antes de procesar. Esquema:

```ts
import crypto from "node:crypto";

app.post("/webhook", express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf; }
}), (req, res) => {
  const signature = req.header("X-Signature");
  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET!)
    .update((req as any).rawBody)
    .digest("hex");
  if (signature !== expected) {
    return res.status(401).json({ ok: false, reason: "firma inválida" });
  }
  // ... resto del handler
});
```

El `WEBHOOK_SECRET` es el campo `secret` que devolvió la API al crear el webhook (lo viste
en la respuesta JSON). Guárdalo como variable de entorno.

---

## Paso 6 — Aislamiento (recomendado)

El agente ejecuta comandos de shell. Para que un comando inesperado no afecte el host,
córrelo en un **contenedor / sandbox**:

- Imagen con Node + PHP + Composer + PEST + git.
- Sin credenciales del host montadas, solo las variables de entorno necesarias.
- `permissionMode` se queda en `"default"` — **nunca** `"bypassPermissions"` fuera de un
  sandbox aislado.

---

## Paso 7 — Registrar el webhook definitivo

Una sola vez, con la **URL fija** del proveedor (ya no ngrok):

```bash
node -e "
const {config}=require('dotenv'); config();
fetch('https://api.clickup.com/api/v2/team/'+process.env.CLICKUP_TEAM_ID+'/webhook', {
  method:'POST',
  headers:{'Authorization':process.env.CLICKUP_TOKEN,'Content-Type':'application/json'},
  body: JSON.stringify({ endpoint:'https://tu-dominio.com/webhook', events:['taskCommentPosted'] })
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)));
"
```

Guarda el `secret` que devuelve → es tu `WEBHOOK_SECRET` (Paso 5).

---

## Paso 8 — Arranque permanente

- **Railway / Render**: el comando de arranque es `npm run webhook`. Se reinicia solo.
- **VPS con systemd**: crea un servicio que ejecute `npm run webhook`, con `Restart=always`.
- **Docker**: `CMD ["npm","run","webhook"]` + política de reinicio `unless-stopped`.

---

## Checklist de producción

- [ ] Desplegado en host con URL fija HTTPS
- [ ] Secretos como variables de entorno (no `.env` en el repo)
- [ ] API Key de Anthropic dedicada del Console
- [ ] Repo PHP clonado en el servidor con `composer install`
- [ ] Verificación de firma HMAC del webhook activa (Paso 5)
- [ ] Servidor corriendo en contenedor / sandbox aislado
- [ ] Webhook registrado con la URL definitiva
- [ ] Proceso con reinicio automático
- [ ] (Opcional) Fase 2 movida a CI en el PR

---

## Mejoras futuras (roadmap)

- Mover la **validación (Fase 2)** a un GitHub Action que corra al abrir/actualizar el PR
  de la rama `DEV-XXXX` (el SDK corre headless, ideal para CI).
- Configurar **Infection** en el repo PHP para que el mutation testing sea real (MSI ≥ 80%).
- Dashboard de métricas: tareas scaffoldeadas, veredictos PASS/FAIL, tiempo por tarea.
- Reintentos y cola si llegan varios webhooks a la vez.
