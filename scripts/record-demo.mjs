// Graba un video corto de la demo (dashboard + simulador de WhatsApp) con Playwright.
// Uso: node scripts/record-demo.mjs [ruta-salida.webm]
// Levanta su propio servidor (proveedor scripted, store en memoria) salvo que se pase BASE_URL.
// Guarda capturas de control en <salida>-frames/ para revisar el resultado.
import { chromium } from "@playwright/test";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] ?? "demo-video/omnichannel-demo.webm");
const FRAMES = OUT.replace(/\.webm$/, "") + "-frames";
const PORT = Number(process.env.PORT ?? 8790);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
async function startServer() {
  if (process.env.BASE_URL) return;
  server = spawn("pnpm exec tsx src/node.ts", {
    shell: true,
    env: { ...process.env, PORT: String(PORT), DB_PATH: "memory", LLM_PROVIDER: "scripted" },
    stdio: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("El servidor no respondió en /health");
}
function stopServer() {
  if (!server) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {}
}

// ---------- Overlays inyectados (no tocan el código de la app) ----------
const OVERLAY_CSS = `
  main { height: calc(100vh - 74px - 92px) !important; }
  section h2 { z-index: 3; }
  #demo-cap { position: fixed; left: 0; right: 0; bottom: 0; height: 92px; z-index: 9998;
    background: #0f172a; color: #f8fafc; display: flex; align-items: center; gap: 18px; padding: 0 28px;
    font: 500 19px/1.35 "Segoe UI", system-ui, sans-serif; border-top: 3px solid #3b82f6; }
  #demo-cap .pill { flex: none; background: #3b82f6; color: #fff; border-radius: 999px; padding: 6px 14px;
    font-weight: 700; font-size: 15px; letter-spacing: .02em; }
  #demo-cap .txt { transition: opacity .35s; }
  #demo-cap .txt small { display: block; color: #94a3b8; font-size: 15px; font-weight: 400; margin-top: 2px; }
  #demo-cap code { background: #1e293b; padding: 1px 6px; border-radius: 4px; font-size: 16px; color: #93c5fd; }
  #demo-card { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column; justify-content: center;
    padding: 0 110px; background: radial-gradient(circle at 20% 20%, #1e3a8a 0%, #0f172a 55%, #020617 100%);
    color: #f8fafc; font-family: "Segoe UI", system-ui, sans-serif; transition: opacity .6s; }
  #demo-card .kicker { color: #93c5fd; font-size: 18px; letter-spacing: .14em; text-transform: uppercase; font-weight: 600; }
  #demo-card h1 { font-size: 54px; margin: 14px 0 12px; line-height: 1.1; }
  #demo-card p { font-size: 24px; color: #cbd5e1; margin: 6px 0; max-width: 1000px; line-height: 1.4; }
  #demo-card .tags { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 26px; }
  #demo-card .tags span { border: 1px solid #334155; background: #0b1225; border-radius: 999px; padding: 6px 14px; font-size: 16px; color: #cbd5e1; }
  #demo-card .note { margin-top: 30px; font-size: 17px; color: #fbbf24; }
  #demo-card .url { font-family: ui-monospace, Consolas, monospace; font-size: 26px; color: #93c5fd; margin-top: 18px; }
  .demo-hl { outline: 3px solid #f59e0b !important; outline-offset: 2px; border-radius: 8px; transition: outline-color .3s; }
`;

async function injectOverlay(page) {
  await page.evaluate((css) => {
    if (document.getElementById("demo-style")) return;
    const st = document.createElement("style"); st.id = "demo-style"; st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement("div"); cap.id = "demo-cap";
    cap.innerHTML = '<span class="pill"></span><div class="txt"></div>';
    document.body.appendChild(cap);
    // Cosmético: el template deja saltos de línea antes del rótulo de cada burbuja (white-space: pre-wrap).
    const trim = () => document.querySelectorAll("#msgs .msg").forEach((m) => {
      const n = m.firstChild;
      if (n && n.nodeType === 3 && !n.textContent.trim()) n.remove();
    });
    new MutationObserver(trim).observe(document.getElementById("msgs"), { childList: true });
    trim();
  }, OVERLAY_CSS);
}

async function caption(page, pill, html, sub = "") {
  await page.evaluate(([p, h, s]) => {
    const cap = document.getElementById("demo-cap");
    cap.querySelector(".pill").textContent = p;
    cap.querySelector(".pill").style.display = p ? "" : "none";
    const t = cap.querySelector(".txt");
    t.innerHTML = h + (s ? `<small>${s}</small>` : "");
  }, [pill, html, sub]);
}

async function card(page, html, ms) {
  await page.evaluate((h) => {
    let c = document.getElementById("demo-card");
    if (!c) { c = document.createElement("div"); c.id = "demo-card"; document.body.appendChild(c); }
    c.innerHTML = h; c.style.opacity = "1"; c.style.display = "flex";
  }, html);
  await sleep(ms);
}
async function hideCard(page) {
  await page.evaluate(() => { const c = document.getElementById("demo-card"); if (c) c.style.opacity = "0"; });
  await sleep(700);
  await page.evaluate(() => { const c = document.getElementById("demo-card"); if (c) c.style.display = "none"; });
}

async function highlight(page, selector, on = true) {
  await page.evaluate(([sel, v]) => {
    document.querySelectorAll(".demo-hl").forEach((e) => e.classList.remove("demo-hl"));
    if (!v || !sel) return;
    for (const part of sel.split(",").map((x) => x.trim())) {
      const last = part.endsWith(":last");
      const els = [...document.querySelectorAll(last ? part.slice(0, -5) : part)];
      (last ? els.slice(-1) : els).forEach((e) => e.classList.add("demo-hl"));
    }
  }, [selector, on]);
}

// Las columnas son <section> con scroll propio; la app no hace autoscroll del chat.
async function scrollChatBottom(page) {
  await page.evaluate(() => { const s = document.querySelector("main > section:nth-child(2)"); s.scrollTo({ top: s.scrollHeight, behavior: "smooth" }); });
}
async function scrollSide(page, target) {
  await page.evaluate((t) => {
    const s = document.querySelector("main > section:nth-child(3)");
    if (t === "top") return s.scrollTo({ top: 0, behavior: "smooth" });
    const els = document.querySelectorAll(t);
    const el = els[els.length - 1];
    if (el) s.scrollTo({ top: el.offsetTop - s.offsetTop - 44, behavior: "smooth" });
  }, target);
}

let shot = 0;
async function frame(page, name) {
  shot++;
  await page.screenshot({ path: path.join(FRAMES, `${String(shot).padStart(2, "0")}-${name}.png`) });
}

async function sendAsCustomer(page, text, expectSelector) {
  await page.getByTestId("sim-text").click();
  await page.getByTestId("sim-text").pressSequentially(text, { delay: 55 });
  await sleep(400);
  await page.getByTestId("sim-send").click();
  if (expectSelector !== false) {
    // Espera a que, en la conversación seleccionada, el mensaje del cliente tenga respuesta de la IA.
    await page.waitForFunction((t) => {
      const m = [...document.querySelectorAll("#msgs .msg")];
      const i = m.map((x) => x.classList.contains("customer") && x.textContent.includes(t)).lastIndexOf(true);
      return i >= 0 && m.slice(i + 1).some((x) => x.classList.contains("ai"));
    }, text, { timeout: 10_000 });
  }
  await sleep(300);
  await scrollChatBottom(page);
}

// ---------- Guion ----------
async function main() {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(path.dirname(OUT), { recursive: true });
  await startServer();

  const browser = await chromium.launch();
  try { await record(browser); } finally { await browser.close(); }
}

async function record(browser) {
  const tmpVideoDir = path.join(path.dirname(OUT), ".rec-tmp");
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "es-AR",
    recordVideo: { dir: tmpVideoDir, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const mark = (label) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${label}`);

  await page.goto(`${BASE}/dashboard`);
  await page.getByTestId("kpis").getByText("scripted").waitFor();
  await injectOverlay(page);

  // 1. Placa inicial
  mark("placa inicial");
  await card(page, `
    <div class="kicker">Demo · Forward Deployed Engineering</div>
    <h1>Omnichannel AI Agent Handoff</h1>
    <p>Atención al cliente multiagente por WhatsApp y voz: la IA resuelve con los sistemas del cliente y deriva a una persona, con contexto, cuando corresponde.</p>
    <div class="tags"><span>TypeScript</span><span>Hono</span><span>Node 22</span><span>Router + especialistas + supervisor</span><span>RAG con citas</span><span>Playbook por cliente</span><span>Evals con gates</span></div>
    <div class="note">Datos 100 % sintéticos (ISPs ficticios Fibrasur y AndesLink) · proveedor LLM determinístico <b>scripted</b>, sin modelo ni costos</div>`, 7500);
  await frame(page, "placa-inicial");
  await hideCard(page);

  // 2. Recorrido de la bandeja
  mark("bandeja");
  await caption(page, "Bandeja", "Bandeja omnicanal: conversaciones y simulador de WhatsApp, chat, y panel de derivación con la traza de cada turno.",
    "Arriba, KPIs en vivo: contención de la IA, cola humana, latencia p95 y proveedor LLM (<code>scripted</code>).");
  await highlight(page, '[data-testid="kpis"]');
  await sleep(3500);
  await highlight(page, "#simBox");
  await sleep(2500);
  await highlight(page, null, false);

  // 3. Consulta de deuda
  mark("deuda");
  await caption(page, "1 · Deuda", "La clienta (Lucía, Fibrasur) pregunta cuánto debe por WhatsApp.");
  await sendAsCustomer(page, "¿Cuánto debo?");
  await caption(page, "1 · Deuda", "El agente de <b>billing</b> responde con el saldo real del ERP vía <code>get_balance</code>.",
    "El LLM decide la intención; el monto lo afirma el código a partir del tool, nunca el modelo.");
  await highlight(page, '[data-testid="msg-ai"]:last');
  await sleep(4000);
  await frame(page, "deuda-respuesta");
  await caption(page, "1 · Traza", "Traza del turno: guardrail → router (intención y confianza) → especialista → tools → guardrail de salida → supervisor.",
    "Cada paso con su latencia y la decisión final: <code>continue</code> (la IA sigue a cargo).");
  await highlight(page, '[data-testid="trace"]');
  await scrollSide(page, '[data-testid="trace"]');
  await sleep(6000);
  await frame(page, "deuda-traza");
  await highlight(page, null, false);

  // 4. Promesa de pago
  mark("promesa");
  await caption(page, "2 · Promesa", "La clienta propone pagar el viernes.");
  await sendAsCustomer(page, "Puedo pagar el viernes");
  await caption(page, "2 · Promesa", "Promesa dentro de la política de Fibrasur (≤ $ 60.000, ≤ 10 días): se registra en el ERP con número de gestión.",
    "Las reglas de negocio se validan dentro del tool <code>register_payment_promise</code>; si la fecha no se dijo, se pregunta.");
  await highlight(page, '[data-testid="msg-ai"]:last');
  await scrollSide(page, '[data-testid="trace"]');
  await sleep(6500);
  await frame(page, "promesa");
  await highlight(page, null, false);

  // 5. Consulta técnica con RAG
  mark("rag");
  await caption(page, "3 · Soporte", "Ahora un problema técnico: sin internet y la luz LOS en rojo.");
  await sendAsCustomer(page, "No tengo internet, la luz LOS está en rojo");
  await caption(page, "3 · Soporte RAG", "El agente técnico responde desde la base de conocimiento del cliente y <b>cita la fuente</b>.",
    "Si la KB no respalda la respuesta, se abstiene en lugar de inventar.");
  await highlight(page, '[data-testid="msg-ai"]:last');
  await scrollSide(page, '[data-testid="trace"]');
  await sleep(7000);
  await frame(page, "rag-cita");
  await highlight(page, null, false);

  // 6. Handoff
  mark("handoff");
  await caption(page, "4 · Handoff", "La clienta pide hablar con una persona.");
  await sendAsCustomer(page, "Quiero hablar con una persona");
  await scrollSide(page, "top");
  await caption(page, "4 · Handoff", "El supervisor (reglas en código, no un LLM) deriva: motivo <code>explicit_request</code>, ticket en el CRM y cola.",
    "El agente humano recibe un resumen y la ficha CRM/ERP: la clienta no tiene que repetir nada.");
  await highlight(page, '#side .box:nth-child(-n+3)');
  await sleep(7500);
  await frame(page, "handoff-ficha");
  await highlight(page, null, false);

  // 7. Agente humano toma la conversación
  mark("claim");
  await caption(page, "5 · Humano", "Valentina, agente de primer nivel, toma la conversación desde la bandeja.");
  await highlight(page, '[data-testid="claim"]');
  await sleep(2000);
  await page.getByTestId("claim").click();
  await page.getByTestId("conv-status").getByText("con humano").waitFor();
  await highlight(page, '[data-testid="conv-status"]');
  await caption(page, "5 · Humano", "Estado: <b>con humano</b>. La IA queda en pausa para esta conversación.");
  await sleep(3500);
  await highlight(page, null, false);
  await caption(page, "5 · Humano", "Si la clienta escribe ahora, la IA no responde: el mensaje queda para la agente.");
  await sendAsCustomer(page, "Gracias, espero", false);
  await page.getByTestId("msg-customer").last().getByText("Gracias, espero").waitFor();
  await scrollChatBottom(page);
  await sleep(3500);
  await scrollSide(page, '[data-testid="reply-text"]');
  await page.getByTestId("reply-text").click();
  await page.getByTestId("reply-text").pressSequentially("Hola Lucía, soy Valentina. Veo tu promesa PRM-00001 y la falla con luz LOS: te agendo la visita técnica ahora.", { delay: 22 });
  await sleep(600);
  await page.getByTestId("reply-send").click();
  await page.getByTestId("msg-human_agent").first().waitFor();
  await scrollChatBottom(page);
  await caption(page, "5 · Humano", "La agente responde por el mismo canal, con todo el contexto del resumen.");
  await highlight(page, '[data-testid="msg-human_agent"]');
  await sleep(5000);
  await frame(page, "humano-responde");
  await highlight(page, null, false);

  // 8. Devolver a la IA
  mark("release");
  await caption(page, "6 · Devolver", "Resuelto el caso, la agente devuelve la conversación a la IA.",
    "También puede cerrarla: el cierre dispara un webhook post-conversación (workflow n8n: CSAT + nota en CRM).");
  await scrollSide(page, '[data-testid="release"]');
  await highlight(page, '[data-testid="release"]');
  await sleep(2500);
  await page.getByTestId("release").click();
  await page.getByTestId("conv-status").getByText("IA", { exact: true }).waitFor();
  await scrollSide(page, "top");
  await scrollChatBottom(page);
  await highlight(page, '[data-testid="conv-status"]');
  await sleep(4000);
  await frame(page, "devuelta-ia");
  await highlight(page, null, false);

  // 9. Mismo mensaje, otro tenant
  mark("andeslink");
  await caption(page, "7 · Playbook", "Mismo núcleo, otro cliente: AndesLink (Perú) tiene su propio playbook.",
    "Trato de usted, moneda PEN, umbrales más conservadores y promesas de pago deshabilitadas.");
  await page.getByTestId("sim-tenant").selectOption("andeslink");
  await highlight(page, "#simBox");
  await sleep(3500);
  await highlight(page, null, false);
  await sendAsCustomer(page, "¿Cuánto debo?");
  await sleep(3000);
  await caption(page, "7 · Playbook", "El mismo mensaje que en Fibrasur registró una promesa…");
  await sendAsCustomer(page, "Puedo pagar el viernes");
  await scrollSide(page, "top");
  await caption(page, "7 · Playbook", "…en AndesLink deriva a un asesor: <code>intent_disabled</code>, cola <code>mesa-de-ayuda</code>.",
    "La diferencia está en el YAML del cliente (validado con schema), no en el código.");
  await highlight(page, '[data-testid="handoff-reason"], [data-testid="msg-ai"]:last');
  await sleep(7500);
  await frame(page, "andeslink-handoff");
  await highlight(page, null, false);

  // 10. Placa final
  mark("placa final");
  await caption(page, "", "");
  await card(page, `
    <div class="kicker">Código, decisiones y resultados</div>
    <h1>Omnichannel AI Agent Handoff</h1>
    <div class="url">github.com/manuXD270516/omnichannel-ai-agent-handoff</div>
    <p style="margin-top:26px">61 tests · 59 escenarios golden con gates en CI · e2e con Playwright · medición publicada con <b>qwen2.5:7b</b> local</p>
    <p>Correlo en local: <code style="font-family:ui-monospace,Consolas,monospace;color:#93c5fd">pnpm install &amp;&amp; pnpm start</code></p>
    <div class="note">Datos sintéticos · proveedor determinístico <b>scripted</b> en este video</div>`, 7500);
  await frame(page, "placa-final");
  mark("fin");

  const video = page.video();
  await context.close();
  if (existsSync(OUT)) rmSync(OUT);
  await video.saveAs(OUT);
  await video.delete();
  rmSync(tmpVideoDir, { recursive: true, force: true });
  console.log(`Video: ${OUT}\nCapturas: ${FRAMES}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(stopServer);
