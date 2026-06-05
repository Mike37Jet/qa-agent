import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const taskId = process.argv[2];
if (!taskId) throw new Error("Uso: npm run scaffold -- DEV-XXXX");

const repoPath = process.env.REPO_PATH;
if (!repoPath) throw new Error("Falta REPO_PATH en .env");

const clickupToken = process.env.CLICKUP_TOKEN;
if (!clickupToken) throw new Error("Falta CLICKUP_TOKEN en .env");

const teamId = process.env.CLICKUP_TEAM_ID;
if (!teamId) throw new Error("Falta CLICKUP_TEAM_ID en .env");

const rules = readFileSync(join(__dirname, "../prompts/scaffold.md"), "utf8");

// Trae la tarea de ClickUp y extrae SOLO el bloque Gherkin.
// (Evita meter el JSON completo de la tarea —~140k chars— al contexto del agente:
//  ese era el costo real. Aquí pasamos ~5k chars de Gherkin limpio.)
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
  console.log(`\n🚀 Iniciando scaffold para tarea ${taskId}...\n`);

  const gherkin = await fetchGherkin(taskId);
  if (!gherkin) throw new Error(`No se encontró Gherkin en la descripción de ${taskId}`);
  console.log(`📄 Gherkin extraído (${gherkin.length} chars)\n`);

  const prompt = `
${rules}

Tarea a procesar: ${taskId}

A continuación tienes el bloque Gherkin de la tarea (ya extraído de ClickUp).
NO necesitas hacer ninguna llamada de red ni curl: usa este texto tal cual.

=== GHERKIN ===
${gherkin}
=== FIN GHERKIN ===

Pasos que debes ejecutar, en orden:
1. Crea y cámbiate a la rama: git checkout -b ${taskId}
2. Genera el archivo de prueba PEST aplicando el mapeo, en tests/Feature/${taskId}Test.php
3. Verifica que el archivo es PHP válido: php -l tests/Feature/${taskId}Test.php
4. Haz commit local: git add tests/Feature/${taskId}Test.php && git commit -m "test(${taskId}): scaffold BDD desde ClickUp"
5. NO hagas push. Informa el resultado en pocas líneas.
`;

  for await (const message of query({
    prompt,
    options: {
      cwd: repoPath,
      // Sin curl: el agente solo escribe el archivo y corre git/php.
      allowedTools: ["Write", "Edit", "Bash"],
      permissionMode: "default",
      // Aísla el agente: NO carga plugins del usuario (memoria, etc.),
      // CLAUDE.md ni settings del filesystem → menos tokens, sin pasos extra.
      settingSources: [],
      maxTurns: 15,
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
      const icon = isSuccess ? "✅" : "❌";
      console.log(`\n${icon} RESULTADO:\n`, (message as any).result ?? (message as any).error);
    }
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
