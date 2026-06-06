import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const taskId = process.argv[2];
if (!taskId) throw new Error("Uso: npm run validate -- DEV-XXXX");

const repoPath = process.env.REPO_PATH;
if (!repoPath) throw new Error("Falta REPO_PATH en .env");

const clickupToken = process.env.CLICKUP_TOKEN;
if (!clickupToken) throw new Error("Falta CLICKUP_TOKEN en .env");

const teamId = process.env.CLICKUP_TEAM_ID;
if (!teamId) throw new Error("Falta CLICKUP_TEAM_ID en .env");

const rules = readFileSync(join(__dirname, "../prompts/validate.md"), "utf8");

// Trae la tarea y extrae SOLO el Gherkin (evita meter ~140k chars de JSON al contexto).
async function fetchGherkin(id: string): Promise<string> {
  const url = `https://api.clickup.com/api/v2/task/${id}?custom_task_ids=true&team_id=${teamId}`;
  const res = await fetch(url, { headers: { Authorization: clickupToken! } });
  if (!res.ok) throw new Error(`ClickUp API respondió ${res.status} al traer ${id}`);
  const data = (await res.json()) as { text_content?: string; description?: string };
  const full = data.text_content ?? data.description ?? "";
  const idx = full.indexOf("Feature:");
  return idx >= 0 ? full.slice(idx).trim() : full.trim();
}

async function main() {
  console.log(`\n🔍 Iniciando validación para tarea ${taskId}...\n`);

  const gherkin = await fetchGherkin(taskId);
  if (!gherkin) throw new Error(`No se encontró Gherkin en la descripción de ${taskId}`);
  console.log(`📄 Gherkin extraído (${gherkin.length} chars)\n`);

  const prompt = `
${rules}

Tarea: ${taskId}

A continuación tienes el Gherkin (fuente de verdad, ya extraído de ClickUp).
NO hagas curl para obtenerlo: úsalo tal cual.

=== GHERKIN ===
${gherkin}
=== FIN GHERKIN ===

Ejecuta, en orden:
1. Lee el archivo actual: tests/Feature/${taskId}Test.php
2. Obtén el diff contra el commit de scaffold:
   git log --oneline | grep "scaffold BDD" para identificar el hash,
   luego: git diff <hash> -- tests/Feature/${taskId}Test.php
3. Comprueba el mapeo step → expect() según las reglas de validación.
4. Corre la suite de pruebas: ./vendor/bin/pest --filter=${taskId}
5. Corre mutation testing sobre el código cubierto:
   ./vendor/bin/infection --filter=<archivos-src-afectados> --min-msi=80
   (Si infection no está disponible, omite este paso y menciónalo en el veredicto.)
6. Emite el veredicto PASS/FAIL con la lista exacta de problemas y los steps afectados.
7. Guarda el veredicto en /tmp/veredicto-${taskId}.txt
8. Publica el veredicto como comentario en la tarea de ClickUp (payload pequeño, esto sí por curl):
   curl -s -X POST -H "Authorization: ${clickupToken}" \
     -H "Content-Type: application/json" \
     -d '{"comment_text":"<veredicto>"}' \
     "https://api.clickup.com/api/v2/task/${taskId}/comment?custom_task_ids=true&team_id=${teamId}"
`;

  for await (const message of query({
    prompt,
    options: {
      cwd: repoPath,
      // Fase 2: solo lectura + ejecutar pruebas; no escribe archivos del repo
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      permissionMode: "default",
      // Aísla el agente: sin plugins del usuario (memoria, etc.) ni settings del FS.
      settingSources: [],
      // Modelo configurable via variable de entorno VALIDATE_MODEL en Railway.
      // Default: claude-sonnet-4-5 (~$0.05/validación)
      // Para ahorrar: claude-haiku-4-5 (~$0.005/validación)
      model: (process.env.VALIDATE_MODEL ?? "claude-sonnet-4-5") as any,
      maxTurns: 20,
    },
  }) as AsyncIterable<SDKMessage>) {
    if (message.type === "assistant") {
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use") {
          console.log(`  → ${block.name}`, block.input?.command ?? "");
        }
      }
    }

    if (message.type === "result") {
      const isSuccess = (message as any).subtype === "success";
      const icon = isSuccess ? "📋" : "❌";
      console.log(`\n${icon} VEREDICTO:\n`, (message as any).result ?? (message as any).error);
    }
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
