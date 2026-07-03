/* Geracao dos flat files Amazon (.xlsx) por seller e do relatorio interno do time.
   Formato flat file aceito pelo Seller Central BR (colunas exatas, update_delete=PartialUpdate).
   So preenche campos que foram corrigidos. */

const ExcelJS = require("exceljs");

/* Colunas do flat file, na ordem exata. */
const FLAT_COLUMNS = [
  "product_id",
  "product_id_type",
  "item_name",
  "bullet_point1",
  "bullet_point2",
  "bullet_point3",
  "bullet_point4",
  "bullet_point5",
  "product_description",
  "generic_keywords",
  "update_delete",
];

/* Monta o workbook (flat file) de um seller.
   seller = { merchant_customer_id, seller_name, rows: [ row, ... ] }
   row pode conter: product_id, item_name, bullet_point1..5, product_description, generic_keywords */
async function buildSellerWorkbook(seller) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Corretor de Catalogo SSR-M";
  wb.created = new Date();

  const ws = wb.addWorksheet("Template");

  // Linha de cabecalho tecnica (nomes das colunas que o Seller Central espera)
  ws.addRow(FLAT_COLUMNS);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF9900" } };

  const rows = Array.isArray(seller.rows) ? seller.rows : [];
  for (const r of rows) {
    ws.addRow([
      r.product_id || "",
      "ASIN",
      r.item_name || "",
      r.bullet_point1 || "",
      r.bullet_point2 || "",
      r.bullet_point3 || "",
      r.bullet_point4 || "",
      r.bullet_point5 || "",
      r.product_description || "",
      r.generic_keywords || "",
      "PartialUpdate",
    ]);
  }

  // Largura amigavel das colunas
  ws.columns.forEach((col, i) => {
    const header = FLAT_COLUMNS[i] || "";
    col.width = header === "product_description" ? 60 : header.startsWith("bullet") ? 40 : 22;
  });

  return wb;
}

/* Relatorio interno do time.
   payload = {
     kpis: { totalCorrigido, totalAsins, glanceImpact },
     byAm: [ { am_alias, sellers: [ { seller_name, qtd, tipos: [..] } ] } ],
     summary: [ { am_alias, sellers, asinsCorrigidos } ]
   } */
async function buildInternalReport(payload) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Corretor de Catalogo SSR-M";
  wb.created = new Date();

  const kpis = payload.kpis || {};
  const byAm = Array.isArray(payload.byAm) ? payload.byAm : [];

  // Aba resumo geral
  const resumo = wb.addWorksheet("Resumo do Time");
  resumo.mergeCells("A1:D1");
  resumo.getCell("A1").value = "Relatorio Interno - Corretor de Catalogo SSR-M";
  resumo.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF232F3E" } };

  resumo.addRow([]);
  const kpiRows = [
    ["Total de ASINs corrigidos", kpis.totalCorrigido || 0],
    ["Total de ASINs analisados", kpis.totalAsins || 0],
    ["Glance views (impacto estimado)", kpis.glanceImpact || 0],
    ["AMs envolvidos", byAm.length],
  ];
  resumo.addRow(["KPI", "Valor"]).font = { bold: true };
  kpiRows.forEach((r) => resumo.addRow(r));
  resumo.getColumn(1).width = 38;
  resumo.getColumn(2).width = 22;

  resumo.addRow([]);
  const head = resumo.addRow(["AM", "Qtd Sellers", "ASINs Corrigidos"]);
  head.font = { bold: true };
  head.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF146EB4" } }));
  for (const am of byAm) {
    const sellers = Array.isArray(am.sellers) ? am.sellers : [];
    const asins = sellers.reduce((s, x) => s + (x.qtd || 0), 0);
    resumo.addRow([am.am_alias || "(sem AM)", sellers.length, asins]);
  }

  // Uma aba por AM
  const usedSheet = new Set(["Resumo do Time"]);
  for (const am of byAm) {
    let name = String(am.am_alias || "AM").replace(/[\\/?*[\]:]/g, "_").slice(0, 28) || "AM";
    let n = 2;
    let final = name;
    while (usedSheet.has(final)) final = `${name}_${n++}`.slice(0, 31);
    usedSheet.add(final);

    const ws = wb.addWorksheet(final);
    const h = ws.addRow(["Seller", "Qtd ASINs Corrigidos", "Tipos de Correcao", "Glance Views"]);
    h.font = { bold: true };
    h.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF9900" } }));
    const sellers = Array.isArray(am.sellers) ? am.sellers : [];
    for (const s of sellers) {
      ws.addRow([
        s.seller_name || "",
        s.qtd || 0,
        Array.isArray(s.tipos) ? s.tipos.join(", ") : s.tipos || "",
        s.glance || 0,
      ]);
    }
    ws.getColumn(1).width = 32;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 40;
    ws.getColumn(4).width = 16;
  }

  return wb;
}

module.exports = { FLAT_COLUMNS, buildSellerWorkbook, buildInternalReport };
