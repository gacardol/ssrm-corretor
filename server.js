/* Corretor de Catalogo Massivo SSR-M
   Backend Express: integracao com o Ollama (IA local, gratuita) para gerar conteudo
   em portugues BR, e geracao dos flat files (.xlsx) + ZIP por seller / por AM.
   100% uso interno do time. Nao envia nada para o seller. */

require("dotenv").config();
const path = require("path");
const express = require("express");
const archiver = require("archiver");
const ExcelJS = require("exceljs");
const { generateContentForAsins, isAiConfigured, GEMINI_MODEL, BATCH_SIZE, CONCURRENCY } = require("./lib/ai");
const { buildSellerWorkbook, buildInternalReport } = require("./lib/flatfile");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* Saude / config visivel para o front. Checa se a GEMINI_API_KEY esta configurada. */
app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    aiUp: isAiConfigured(),
    model: GEMINI_MODEL,
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
  });
});

/* Geracao de conteudo com IA em LOTE, com progresso via SSE.
   Body: { items: [{ asin, item_name, seller_name, needs: {...} }] }
   Stream de eventos:
     event: progress -> data: { batchDone, batchTotal, asinsDone, asinsTotal }
     event: done     -> data: { results: [...] }
     event: error    -> data: { error } */
app.post("/api/generate", async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Nenhum item enviado." });

  // Server-Sent Events
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const results = await generateContentForAsins(items, (p) => send("progress", p));
    send("done", { results });
    res.end();
  } catch (err) {
    console.error("Erro /api/generate:", err);
    send("error", { error: err.message || "Falha ao gerar conteudo.", code: err.code || null });
    res.end();
  }
});

/* Exporta ZIP com 1 flat file .xlsx por seller (merchant_customer_id).
   Body: { sellers: [{ merchant_customer_id, seller_name, rows: [...] }] } */
app.post("/api/export/sellers", async (req, res) => {
  try {
    const sellers = Array.isArray(req.body && req.body.sellers) ? req.body.sellers : [];
    if (!sellers.length) return res.status(400).json({ error: "Nenhum seller para exportar." });
    await streamSellersZip(res, sellers, "flat-files-ssrm.zip");
  } catch (err) {
    console.error("Erro /api/export/sellers:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* Exporta ZIP somente dos sellers de um AM (o front ja filtra e manda os sellers do AM). */
app.post("/api/export/am", async (req, res) => {
  try {
    const sellers = Array.isArray(req.body && req.body.sellers) ? req.body.sellers : [];
    const am = (req.body && req.body.am_alias) || "am";
    if (!sellers.length) return res.status(400).json({ error: "Nenhum seller para esse AM." });
    const safe = String(am).replace(/[^a-zA-Z0-9_-]/g, "_");
    await streamSellersZip(res, sellers, `flat-files-${safe}.zip`);
  } catch (err) {
    console.error("Erro /api/export/am:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* Relatorio interno do time (Excel com aba por AM + KPIs). */
app.post("/api/export/report", async (req, res) => {
  try {
    const payload = req.body || {};
    const workbook = await buildInternalReport(payload);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="relatorio-interno-ssrm.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Erro /api/export/report:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* Helper: monta o ZIP fazendo stream das planilhas por seller. */
async function streamSellersZip(res, sellers, zipName) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => { throw err; });
  archive.pipe(res);

  const usedNames = new Set();
  for (const seller of sellers) {
    const wb = await buildSellerWorkbook(seller);
    const buffer = await wb.xlsx.writeBuffer();
    let base = `${seller.merchant_customer_id || "seller"}_${seller.seller_name || ""}`
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 120) || "seller";
    let name = `${base}.xlsx`;
    let n = 2;
    while (usedNames.has(name)) name = `${base}_${n++}.xlsx`;
    usedNames.add(name);
    archive.append(Buffer.from(buffer), { name });
  }
  await archive.finalize();
}

app.listen(PORT, () => {
  console.log(`Corretor SSR-M rodando em http://localhost:${PORT}`);
  console.log(`IA via Google Gemini (modelo: ${GEMINI_MODEL}, lote: ${BATCH_SIZE}, paralelo: ${CONCURRENCY})`);
  if (!isAiConfigured()) {
    console.warn("AVISO: GEMINI_API_KEY nao definida no .env. A geracao por IA vai falhar ate configurar a chave.");
  }
});
