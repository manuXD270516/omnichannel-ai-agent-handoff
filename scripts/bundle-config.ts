/**
 * Valida los playbooks (YAML) contra el schema y los empaqueta junto con la KB
 * en un módulo TS. Así el mismo artefacto corre en Node y en Cloudflare Workers
 * (que no tiene filesystem) y un playbook inválido rompe el build, no producción.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse } from "yaml";
import { parsePlaybook, type KbDoc, type TenantBundle } from "../src/core/playbook";

const root = join(import.meta.dirname, "..");
const bundles: Record<string, TenantBundle> = {};

for (const file of readdirSync(join(root, "playbooks")).filter((f) => f.endsWith(".yaml"))) {
  const playbook = parsePlaybook(parse(readFileSync(join(root, "playbooks", file), "utf8")));
  const kbDir = join(root, "kb", playbook.kb.collection);
  const kb: KbDoc[] = readdirSync(kbDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = readFileSync(join(kbDir, f), "utf8").replace(/\r\n/g, "\n");
      const title = (text.match(/^# (.+)$/m)?.[1] ?? f).trim();
      return { id: basename(f, ".md"), title, text };
    });
  if (kb.length === 0) throw new Error(`La KB ${playbook.kb.collection} está vacía`);
  bundles[playbook.tenant.id] = { playbook, kb };
}

mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(
  join(root, "src", "generated", "tenants.ts"),
  `// Generado por scripts/bundle-config.ts. No editar a mano.\nimport type { TenantBundle } from "../core/playbook";\n\nexport const TENANTS: Record<string, TenantBundle> = ${JSON.stringify(bundles, null, 2)};\n`,
);
const dashboard = readFileSync(join(root, "src", "dashboard", "dashboard.html"), "utf8");
writeFileSync(
  join(root, "src", "generated", "dashboard.ts"),
  `// Generado por scripts/bundle-config.ts desde src/dashboard/dashboard.html. No editar a mano.\nexport const DASHBOARD_HTML: string = ${JSON.stringify(dashboard)};\n`,
);
console.log(`Playbooks válidos: ${Object.keys(bundles).join(", ")}`);
