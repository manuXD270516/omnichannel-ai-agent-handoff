import { expect, test } from "@playwright/test";

async function sendAsCustomer(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("sim-text").fill(text);
  await page.getByTestId("sim-send").click();
}

test("cliente por WhatsApp → handoff → agente toma, responde y devuelve a la IA", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("kpis")).toContainText("scripted");

  await page.getByTestId("sim-from").fill("+5491155550101");
  await sendAsCustomer(page, "¿Cuánto debo?");
  await expect(page.getByTestId("messages")).toContainText("18.450");
  await expect(page.getByTestId("conv-status")).toHaveText("IA");

  await sendAsCustomer(page, "No entiendo la factura, quiero hablar con una persona");
  await expect(page.getByTestId("conv-status")).toHaveText("en cola");
  await expect(page.getByTestId("handoff-reason")).toHaveText("explicit_request");
  await expect(page.getByTestId("handoff-summary")).toContainText("explicit_request");
  await expect(page.getByTestId("conv-list")).toContainText("Lucía Fernández");

  await page.getByTestId("agent-name").fill("Valentina (N1)");
  await page.getByTestId("claim").click();
  await expect(page.getByTestId("conv-status")).toHaveText("con humano");

  // Con el humano a cargo, un mensaje del cliente no recibe respuesta de la IA.
  const aiBefore = await page.getByTestId("msg-ai").count();
  await sendAsCustomer(page, "Gracias por atenderme");
  await expect(page.getByTestId("msg-customer").last()).toContainText("Gracias por atenderme");
  expect(await page.getByTestId("msg-ai").count()).toBe(aiBefore);

  await page.getByTestId("reply-text").fill("Hola Lucía, soy Valentina. La factura incluye el recargo por mora.");
  await page.getByTestId("reply-send").click();
  await expect(page.getByTestId("msg-human_agent")).toContainText("soy Valentina");

  await page.getByTestId("release").click();
  await expect(page.getByTestId("conv-status")).toHaveText("IA");

  await sendAsCustomer(page, "¿Cuánto debo?");
  await expect(page.getByTestId("msg-ai").last()).toContainText("18.450");
  await expect(page.getByTestId("trace").first()).toContainText("router.triage");
});

test("baja en AndesLink: deriva siempre a un humano con ficha del CRM", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByTestId("sim-tenant").selectOption("andeslink");
  await page.getByTestId("sim-from").fill("+51987650103");
  await sendAsCustomer(page, "Deseo cancelar mi contrato");
  await expect(page.getByTestId("handoff-reason")).toHaveText("always_human_intent");
  await expect(page.locator("#side")).toContainText("Elena Rojas");
  await expect(page.getByTestId("msg-ai").last()).toContainText("asesor de AndesLink");
});
