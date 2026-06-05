import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import express, { Request, Response } from "express";
import { execFile } from "node:child_process";
import { join } from "node:path";
import crypto from "node:crypto";

const app = express();
// Captura el body crudo para poder verificar la firma HMAC del webhook.
app.use(express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));

// En PaaS (Railway/Render) el puerto lo inyecta el proveedor en PORT.
const PORT = process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3721";
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN!;
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID!;
// Secreto que devuelve ClickUp al crear el webhook. Si está definido, se exige firma válida.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const KEYWORD_SCAFFOLD = "@agente_qa genera";
const KEYWORD_VALIDATE = "@agente_qa valida";

// Estados de ClickUp que disparan la validación (en minúsculas)
const COMPLETE_STATUSES = ["complete", "completado", "done", "cerrado"];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getCustomId(internalTaskId: string): Promise<string | null> {
  const url = `https://api.clickup.com/api/v2/task/${internalTaskId}`;
  const res = await fetch(url, {
    headers: { Authorization: CLICKUP_TOKEN },
  });
  if (!res.ok) return null;
  const data = await res.json() as { custom_id?: string };
  return data.custom_id ?? null;
}

async function getCommentText(internalTaskId: string, commentId: string): Promise<string> {
  const url = `https://api.clickup.com/api/v2/task/${internalTaskId}/comment`;
  const res = await fetch(url, {
    headers: { Authorization: CLICKUP_TOKEN },
  });
  if (!res.ok) return "";
  const data = await res.json() as { comments?: Array<{ id: string; comment_text?: string; comment?: Array<{ text: string }> }> };
  const found = (data.comments ?? []).find((c) => c.id === commentId);
  if (!found) return "";
  // ClickUp devuelve el texto en comment_text o dentro de comment[].text
  return found.comment_text ?? (found.comment ?? []).map((b) => b.text).join("") ?? "";
}

function runAgent(script: "scaffold" | "validate", taskId: string): void {
  const scriptFile = join(__dirname, `phase${script === "scaffold" ? "1" : "2"}-${script}.ts`);
  console.log(`\n▶ Ejecutando ${script} para ${taskId}...`);

  execFile("npx", ["tsx", scriptFile, taskId], { cwd: join(__dirname, "..") }, (err, stdout, stderr) => {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    if (err) console.error(`[${taskId}] Error en ${script}:`, err.message);
    else console.log(`[${taskId}] ${script} completado.`);
  });
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

app.post("/webhook", async (req: Request, res: Response) => {
  // ── Seguridad: verifica la firma HMAC-SHA256 de ClickUp ───────────────────
  // Sin esto, cualquiera con la URL podría disparar el agente.
  if (WEBHOOK_SECRET) {
    const signature = req.header("X-Signature");
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update((req as any).rawBody ?? Buffer.from(""))
      .digest("hex");
    if (!signature || signature !== expected) {
      console.warn("  ✗ Firma de webhook inválida — rechazado");
      res.status(401).json({ ok: false, reason: "firma inválida" });
      return;
    }
  }

  const payload = req.body as {
    event?: string;
    task_id?: string;
    history_items?: Array<{
      field: string;
      after?: { status?: string } | string;
      comment?: { text_content?: string; comment?: Array<{ text: string }> };
    }>;
  };

  const { event, task_id } = payload;
  console.log(`\n← Webhook recibido: event=${event}, task_id=${task_id}`);

  if (!task_id) {
    res.json({ ok: false, reason: "sin task_id" });
    return;
  }

  let shouldValidate = false;
  let shouldScaffold = false;

  // ── Trigger 1: cambio de estado a "complete" (DESACTIVADO por ahora) ────────
  // if (event === "taskStatusUpdated") {
  //   const newStatus = payload.history_items
  //     ?.find((h) => h.field === "status")
  //     ?.after?.status?.toLowerCase() ?? "";
  //   if (COMPLETE_STATUSES.includes(newStatus)) {
  //     console.log(`  → Estado cambiado a "${newStatus}": lanzando validación`);
  //     shouldValidate = true;
  //   }
  // }

  // ── Trigger 2: comentario con keyword ────────────────────────────────────
  if (event === "taskCommentPosted") {
    // ClickUp envía el texto en history_items[0].comment.text_content
    const commentData = payload.history_items?.[0]?.comment as any;
    const commentText: string =
      commentData?.text_content ??
      (commentData?.comment ?? []).map((b: any) => b.text).join("") ??
      "";

    console.log(`  → Comentario: "${commentText.slice(0, 80)}"`);

    const text = commentText.toLowerCase();
    if (text.includes(KEYWORD_VALIDATE)) {
      console.log(`  → "${KEYWORD_VALIDATE}" detectado: lanzando validación`);
      shouldValidate = true;
    } else if (text.includes(KEYWORD_SCAFFOLD)) {
      console.log(`  → "${KEYWORD_SCAFFOLD}" detectado: lanzando scaffold`);
      shouldScaffold = true;
    }
  }

  // ── Trigger 3: tarea pasa a "in progress" → scaffold (DESACTIVADO por ahora)
  // if (event === "taskStatusUpdated") {
  //   const newStatus = payload.history_items
  //     ?.find((h) => h.field === "status")
  //     ?.after?.status?.toLowerCase() ?? "";
  //   if (["in progress", "en progreso", "ready for dev"].includes(newStatus)) {
  //     console.log(`  → Estado "${newStatus}": lanzando scaffold`);
  //     shouldScaffold = true;
  //   }
  // }

  // Responde rápido a ClickUp (debe responder en < 5 s o reintenta)
  res.json({ ok: true, validate: shouldValidate, scaffold: shouldScaffold });

  // Corre los agentes en background sin bloquear la respuesta
  if (shouldValidate || shouldScaffold) {
    const customId = await getCustomId(task_id);
    if (!customId) {
      console.error(`  ✗ No se pudo obtener custom_id para task_id=${task_id}`);
      return;
    }
    console.log(`  → custom_id resuelto: ${customId}`);
    if (shouldScaffold) runAgent("scaffold", customId);
    if (shouldValidate) runAgent("validate", customId);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, agent: "qa-agent webhook", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🎯 Webhook server corriendo en http://localhost:${PORT}`);
  console.log(`   POST /webhook  ← ClickUp envía aquí`);
  console.log(`   GET  /health   ← ping de estado`);
  console.log(`\n   Triggers activos:`);
  console.log(`   • Comentario "${KEYWORD_SCAFFOLD}"  → scaffold (genera archivo PEST)`);
  console.log(`   • Comentario "${KEYWORD_VALIDATE}"   → validate (verifica pruebas)\n`);
});
