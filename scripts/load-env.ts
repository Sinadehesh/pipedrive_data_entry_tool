/**
 * Load `.env.local` (then `.env`) into process.env for CLI scripts.
 *
 * Next.js reads these files for `npm run dev`, but scripts run through tsx
 * are plain Node and see only the shell environment — so without this,
 * every script needed `set -a; source .env.local; set +a` first.
 *
 * Must be the FIRST import in each script: the DB client builds its pool
 * from env at module load, and imports evaluate in order.
 *
 * Variables already set in the shell win, so a one-off override like
 * `ANTHROPIC_API_KEY=sk-ant-... npm run try:extract` still works. Missing
 * files are fine — e.g. try:extract needs nothing but that one variable.
 */
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
