import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

const AGENT_NAME = process.env.GIT_AUTHOR_NAME ?? "QA Agent";
// Generación del test (frecuente): Haiku por defecto, barato.
const SCAFFOLD_MODEL = (process.env.SCAFFOLD_MODEL ?? "claude-haiku-4-5") as any;
// Delta razonado (ocasional): Sonnet por defecto, más fiable comparando specs.
const DELTA_MODEL = (process.env.DELTA_MODEL ?? "claude-sonnet-4-5") as any;

// Nombre de la rama = ID de la tarea + etiqueta opcional.
// La etiqueta viene del comentario de ClickUp ("@agente_qa genera billing-qa" → argv[3]),
// con prioridad sobre la variable de entorno BRANCH_SUFFIX (fallback global para pruebas).
// Ej: taskId=DEV-8697 + label="billing-qa" → rama DEV-8697-billing-qa. Sin etiqueta → DEV-8697.
const branchLabel = (process.argv[3] || process.env.BRANCH_SUFFIX || "").replace(/^-+/, "").trim();
const BRANCH = branchLabel ? `${taskId}-${branchLabel}` : taskId;

// El nombre del archivo SIEMPRE usa el ID puro (no el sufijo de rama).
const TEST_REL = `tests/Feature/${taskId}Test.php`;

// Marcadores del snapshot del Gherkin que se guarda en el header del test.
// Permiten que futuras regeneraciones comparen la spec vieja vs la nueva.
const SNAP_START = "=== GHERKIN SNAPSHOT (no editar) ===";
const SNAP_END = "=== FIN GHERKIN SNAPSHOT ===";

// ─── Helpers ──────────────────────────────────────────────────────────────

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
  } catch (e: any) {
    if (opts.allowFail) return "";
    throw new Error(`git ${args.join(" ")} falló: ${e.stderr || e.message}`);
  }
}

// Trae la tarea de ClickUp y extrae SOLO el bloque Gherkin.
async function fetchGherkin(id: string): Promise<string> {
  const url = `https://api.clickup.com/api/v2/task/${id}?custom_task_ids=true&team_id=${teamId}`;
  const res = await fetch(url, { headers: { Authorization: clickupToken! } });
  if (!res.ok) throw new Error(`ClickUp API respondió ${res.status} al traer ${id}`);
  const data = (await res.json()) as { text_content?: string; description?: string };
  const full = data.text_content ?? data.description ?? "";
  const idx = full.indexOf("Feature:");
  return idx >= 0 ? full.slice(idx).trim() : full.trim();
}

async function postClickupComment(text: string): Promise<void> {
  const url = `https://api.clickup.com/api/v2/task/${taskId}/comment?custom_task_ids=true&team_id=${teamId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: clickupToken!, "Content-Type": "application/json" },
    body: JSON.stringify({ comment_text: text, notify_all: false }),
  });
  if (!res.ok) throw new Error(`ClickUp comment falló ${res.status}: ${await res.text()}`);
}

function extractSnapshot(fileContent: string): string {
  const a = fileContent.indexOf(SNAP_START);
  const b = fileContent.indexOf(SNAP_END);
  if (a < 0 || b < 0 || b <= a) return "";
  return fileContent.slice(a + SNAP_START.length, b).trim();
}

// Corre el agente y devuelve el texto final (result). Loguea las tool_use.
async function runAgent(prompt: string, allowedTools: string[], maxTurns: number, model: any): Promise<string> {
  let result = "";
  for await (const message of query({
    prompt,
    options: {
      cwd: repoPath,
      allowedTools,
      permissionMode: "default",
      settingSources: [],
      model,
      maxTurns,
    },
  }) as AsyncIterable<SDKMessage>) {
    if (message.type === "assistant") {
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use") console.log(`  → ${block.name}`, block.input?.command ?? "");
      }
    }
    if (message.type === "result") {
      result = (message as any).result ?? (message as any).error ?? "";
    }
  }
  return result;
}

// ─── Modo de operación según el estado de la rama ───────────────────────────
// NEW   : la rama no existe en el remoto → crear desde main + generar + push
// REGEN : la rama existe pero solo el agente la tocó → regenerar + push
// DELTA : la rama existe y el dev ya implementó → NO tocar, comentar el delta
type Mode = "NEW" | "REGEN" | "DELTA";

function prepareAndDetectMode(): Mode {
  // Verifica que el repo esté realmente clonado antes de tocar git.
  if (!existsSync(join(repoPath!, ".git"))) {
    throw new Error(
      `El repo PHP no está clonado en ${repoPath} (no existe ${repoPath}/.git). ` +
      `Posibles causas: el clonado de arranque aún no termina, falló, o el volumen /data no está montado. ` +
      `Revisa en la consola de Railway: ls -la ${repoPath}`
    );
  }

  // Sincroniza el remoto con el token actual (puede haber cambiado a write).
  const repoUrl = process.env.PHP_REPO_URL;
  if (repoUrl) git(["remote", "set-url", "origin", repoUrl], { allowFail: true });

  git(["fetch", "origin", "--prune"], { allowFail: true });
  git(["fetch", "origin", "main"], { allowFail: true });

  const remoteExists = git(["ls-remote", "--heads", "origin", BRANCH], { allowFail: true }).length > 0;

  if (!remoteExists) {
    // Crea la rama desde main actualizado.
    git(["checkout", "main"], { allowFail: true });
    git(["reset", "--hard", "origin/main"], { allowFail: true });
    git(["checkout", "-B", BRANCH]);
    return "NEW";
  }

  // La rama existe: trae el estado del remoto.
  git(["checkout", "-B", BRANCH, `origin/${BRANCH}`]);

  // SEGURIDAD: ¿la rama tiene commits de un HUMANO (no del agente)?
  // Miramos los commits propios de la rama (los que NO están en main).
  // Si hay aunque sea uno de un autor distinto a "QA Agent" → es una rama del
  // equipo → modo DELTA: NUNCA se hace push ni se modifica el archivo, solo se
  // deja un comentario en ClickUp. El agente solo pushea a ramas 100% suyas.
  const branchAuthorsRaw = git(["log", `origin/${BRANCH}`, "^origin/main", "--format=%an"], { allowFail: true });
  const branchAuthors = branchAuthorsRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const hasHumanCommits = branchAuthors.some((a) => a !== AGENT_NAME);
  return hasHumanCommits ? "DELTA" : "REGEN";
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function generatePrompt(gherkin: string): string {
  return `
${rules}

Tarea a procesar: ${taskId}

Genera el archivo de prueba PEST y escríbelo con la herramienta Write en la ruta exacta:
  ${TEST_REL}

El archivo DEBE empezar con un bloque de comentario que contenga el SNAPSHOT del Gherkin,
EXACTAMENTE entre estos marcadores (esto permite comparar la spec en futuras regeneraciones):

/*
${SNAP_START}
${gherkin}
${SNAP_END}
*/

Debajo del snapshot, genera los tests siguiendo las reglas del prompt (describe + un it() por
Scenario, comentarios Given/When/Then, expect() reales o ->todo(), TODO(dev) donde falte detalle).

IMPORTANTE:
- NO ejecutes git, NO hagas commit ni push: de eso se encarga el sistema automáticamente.
- Solo escribe el archivo con Write y valida la sintaxis con: php -l ${TEST_REL}
- Informa en pocas líneas cuántos escenarios generaste.

=== GHERKIN ===
${gherkin}
=== FIN GHERKIN ===
`;
}

function deltaPrompt(oldGherkin: string, newGherkin: string): string {
  return `
La especificación (Gherkin) de la tarea ${taskId} cambió, y el dev YA implementó tests sobre la
versión anterior en el archivo ${TEST_REL}. NO se debe tocar su código: tu única tarea es redactar
un resumen claro y accionable de QUÉ cambió entre la spec anterior y la nueva, para que el dev
ajuste sus tests a mano.

Redacta un comentario breve en markdown con:
- Escenarios AGREGADOS, ELIMINADOS o RENOMBRADOS (menciona sus nombres).
- Parámetros nuevos o modificados en los Examples / tablas.
- Cambios en pasos Given / When / Then.
Sé concreto y menciona los nombres de los escenarios afectados. NO incluyas código PEST completo,
solo el delta de la especificación. Devuelve SOLO el texto del comentario (sin preámbulos).

=== GHERKIN ANTERIOR ===
${oldGherkin || "(no disponible: el test no tenía snapshot previo; describe la spec nueva y pide al dev revisar todos los escenarios)"}

=== GHERKIN NUEVO ===
${newGherkin}
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Iniciando scaffold para tarea ${taskId}...\n`);

  const gherkin = await fetchGherkin(taskId);
  if (!gherkin) throw new Error(`No se encontró Gherkin en la descripción de ${taskId}`);
  console.log(`📄 Gherkin extraído (${gherkin.length} chars)`);

  const mode = prepareAndDetectMode();
  console.log(`🔎 Modo: ${mode} (rama ${BRANCH})\n`);

  if (mode === "DELTA") {
    // El dev ya implementó: NO tocamos el archivo. Generamos y publicamos el delta.
    const oldFile = git(["show", `origin/${BRANCH}:${TEST_REL}`], { allowFail: true });
    const oldGherkin = extractSnapshot(oldFile);

    console.log("✋ El dev ya implementó este test. Generando resumen del delta...\n");
    const delta = await runAgent(deltaPrompt(oldGherkin, gherkin), [], 8, DELTA_MODEL);

    const comment =
      `🤖 **qa-agent**: la especificación cambió y este test ya tiene implementación del dev, ` +
      `así que NO modifiqué el archivo para no romper tu trabajo.\n\n` +
      `**Cambios en la spec que debes revisar:**\n\n${delta}`;

    await postClickupComment(comment);
    console.log(`\n✅ Delta publicado como comentario en ClickUp. El archivo del dev NO se tocó.`);
    return;
  }

  // NEW o REGEN: el agente (re)genera el archivo; el sistema hace commit + push.
  await runAgent(generatePrompt(gherkin), ["Write", "Bash"], 15, SCAFFOLD_MODEL);

  const dirty = git(["status", "--porcelain", TEST_REL], { allowFail: true }).length > 0;
  if (!dirty) {
    console.log(`\nℹ️ Sin cambios en ${TEST_REL} (la regeneración produjo el mismo contenido). No se hace commit.`);
    return;
  }

  const msg =
    mode === "NEW"
      ? `test(${taskId}): scaffold BDD desde ClickUp`
      : `test(${taskId}): regenera scaffold BDD desde ClickUp`;

  git(["add", TEST_REL]);
  git(["commit", "-m", msg]);
  git(["push", "-u", "origin", BRANCH]);

  console.log(`\n✅ ${mode === "NEW" ? "Creado" : "Regenerado"} y pusheado a origin/${BRANCH}.`);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
