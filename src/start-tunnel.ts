import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import { execSync, spawn } from "node:child_process";

const token = process.env.NGROK_AUTHTOKEN;
const port = process.env.WEBHOOK_PORT ?? "3721";

if (!token) throw new Error("Falta NGROK_AUTHTOKEN en .env");

// Configura el token (solo la primera vez, pero es idempotente)
execSync(`ngrok config add-authtoken ${token}`, { stdio: "inherit" });

// Levanta el túnel
const ngrok = spawn("ngrok", ["http", port, "--log=stdout"], { stdio: "inherit" });

ngrok.on("close", (code) => {
  console.log(`ngrok terminó con código ${code}`);
});
