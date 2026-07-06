/* Corretor de Catalogo Massivo SSR-M - frontend.
   Fluxo: upload CSV -> diagnostico/dashboard -> gerar correcoes com IA -> exportar flat files / relatorio.
   Processamento em memoria no navegador; IA e export feitos via backend. */

/* ---------------- Regras de negocio ---------------- */
const RULES = {
  TITLE_MIN: 80,
  TITLE_MAX: 150,
  MIN_IMAGES: 3,
};

/* ---------------- Estado global ---------------- */
const state = {
  rows: [],        // linhas do CSV (objetos) + diagnostico + correcoes
  filtered: [],    // linhas apos filtro
  columnMap: {},   // campo interno -> nome real da coluna no CSV
};

/* ---------------- Mapeamento flexivel de colunas ----------------
   O Andi/Workbench pode exportar o CSV com nomes de coluna variados.
   Aqui definimos, para cada campo interno, os nomes aceitos (case-insensitive).
   type:
     - "string"   texto simples
     - "num"      numerico
     - "presence" "has_*": aceita boolean (true/false) OU a propria coluna de
                  conteudo (ex: bullet_points com texto) -> presenca = true */
const COLUMN_SCHEMA = [
  { field: "asin",                 label: "ASIN",                  type: "string",   required: true,
    aliases: ["asin", "product_id", "product id", "asin_id"] },
  { field: "merchant_customer_id", label: "ID do Seller",          type: "string",
    aliases: ["merchant_customer_id", "mcid", "merchant_id"] },
  { field: "seller_name",          label: "Nome do Seller",        type: "string",
    aliases: ["seller_name", "merchant_name", "seller", "nome_loja"] },
  { field: "am_alias",             label: "Nome do AM",            type: "string",
    aliases: ["am_alias", "alias", "account_manager", "nam"] },
  { field: "item_name",            label: "Titulo",                type: "string",
    aliases: ["item_name", "title", "titulo", "product_name"] },
  { field: "has_bullet_points",    label: "Bullet Points",         type: "presence",
    aliases: ["has_bullet_points", "bullet_points", "bullets"] },
  { field: "has_description",      label: "Descricao",             type: "presence",
    aliases: ["has_description", "description", "descricao"] },
  { field: "has_main_image",       label: "Imagem Principal",      type: "presence",
    aliases: ["has_main_image", "main_image", "imagem"] },
  { field: "image_count",          label: "Qtd. de Imagens",       type: "num",
    aliases: ["image_count", "images", "num_images", "qty_images"] },
  { field: "has_keywords",         label: "Keywords",              type: "presence",
    aliases: ["has_keywords", "keywords", "generic_keywords"] },
  { field: "cdq_grade",            label: "CDQ Grade",             type: "string",
    aliases: ["cdq_grade", "composite_grade", "grade"] },
  { field: "idq_score",            label: "IDQ Score",             type: "num",
    aliases: ["idq_score", "composite_score", "score"] },
  { field: "idq_grade",            label: "IDQ Grade",             type: "string",
    aliases: ["idq_grade"] },
  { field: "glance_views_90d",     label: "Glance Views (90d)",    type: "num",
    aliases: ["glance_views_90d", "glance_views", "gv_trailing_90_days", "gv"] },
  { field: "promotion_type",       label: "Tipo de Deal",          type: "string",
    aliases: ["promotion_type", "deal_type", "tipo_deal"] },
];

/* Constroi o mapa campo interno -> nome real da coluna, a partir do header do CSV.
   Match case-insensitive e ignorando espacos nas pontas. Retorna tambem os campos
   obrigatorios que nao foram encontrados. */
function buildColumnMap(headerFields) {
  const headers = (headerFields || []).filter((h) => h != null && String(h).trim() !== "");
  // lookup: nome normalizado (lower/trim) -> nome original da coluna
  const lookup = {};
  headers.forEach((h) => { lookup[String(h).trim().toLowerCase()] = h; });

  const map = {};
  const missingRequired = [];
  for (const def of COLUMN_SCHEMA) {
    let found = null;
    for (const alias of def.aliases) {
      const hit = lookup[alias.toLowerCase()];
      if (hit !== undefined) { found = hit; break; }
    }
    map[def.field] = found; // pode ser null se nao achou
    if (!found && def.required) missingRequired.push(def.label);
  }
  return { map, missingRequired };
}

function schemaFor(field) { return COLUMN_SCHEMA.find((d) => d.field === field); }

/* ---------------- Boot ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  setupUpload();
  setupFilters();
  setupGenerate();
  setupExport();
  checkHealth();
});

async function checkHealth() {
  const el = document.getElementById("aiStatus");
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    if (d.aiUp) {
      el.textContent = "IA conectada (Gemini: " + d.model + ")";
      el.classList.remove("warn");
      el.classList.add("ok");
    } else {
      el.textContent = "IA nao configurada - defina GEMINI_API_KEY no .env";
      el.classList.remove("ok");
      el.classList.add("warn");
    }
  } catch (e) {
    el.textContent = "Backend offline";
    el.classList.add("warn");
  }
}

/* ---------------- Upload ---------------- */
function setupUpload() {
  const dz = document.getElementById("dropzone");
  const input = document.getElementById("csvInput");

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
}

function handleFile(file) {
  const errEl = document.getElementById("uploadError");
  errEl.textContent = "";
  document.getElementById("fileName").textContent = file.name;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: (res) => {
      try {
        // 1. Le o header e monta o mapeamento flexivel de colunas.
        const headerFields = (res.meta && res.meta.fields) || [];
        const { map, missingRequired } = buildColumnMap(headerFields);

        // 2. Coluna obrigatoria (ASIN) precisa existir.
        if (missingRequired.length) {
          errEl.textContent = `Coluna ${missingRequired.join(" e ")} nao encontrada no CSV. Verifique o arquivo exportado do Andi.`;
          return;
        }
        state.columnMap = map;

        const asinCol = map.asin;
        const dataRows = (res.data || []).filter((r) => String(r[asinCol] || "").trim() !== "");
        if (!dataRows.length) {
          errEl.textContent = `Nenhuma linha valida encontrada (coluna "${asinCol}" sem valores).`;
          return;
        }

        state.rows = dataRows.map((r) => normalizeRow(r, map)).map(diagnoseRow);
        renderColumnMapping(map, headerFields);
        buildDashboard();
        document.getElementById("dashboardCard").classList.remove("hidden");
        document.getElementById("generateCard").classList.remove("hidden");
        document.getElementById("exportCard").classList.remove("hidden");
      } catch (err) {
        errEl.textContent = "Erro ao processar: " + err.message;
      }
    },
    error: (err) => { errEl.textContent = "Erro ao ler o CSV: " + err.message; },
  });
}

/* Normaliza nomes/valores de uma linha usando o mapeamento de colunas detectado.
   map = { campoInterno: nomeRealDaColunaNoCsv | null } */
function normalizeRow(r, map) {
  // valor cru de um campo interno (via nome real da coluna); "" se coluna ausente
  const raw = (field) => {
    const col = map[field];
    return col && r[col] !== undefined ? r[col] : "";
  };
  // presenca de conteudo: para campos "has_*".
  // Se a coluna mapeada for do tipo booleano (has_*), interpreta true/false.
  // Se for a coluna de conteudo real (ex: bullet_points), presenca = tem texto.
  const presence = (field) => {
    const col = map[field];
    if (!col) return false;                          // coluna ausente = NAO TEM
    const val = r[col];
    if (val === undefined || val === null) return false; // NULL/vazio = NAO TEM
    const s = String(val).trim();
    if (s === "") return false;                      // vazio = NAO TEM
    const low = s.toLowerCase();
    // TEM conteudo: Y / true / 1 / yes / sim
    if (["true", "1", "yes", "sim", "y"].includes(low)) return true;
    // NAO TEM: N / false / 0 / no / nao / vazio / placeholders de nulo
    if (["false", "0", "no", "nao", "não", "n", "-", "null", "nulo", "nan", "na", "n/a", "none", "undefined", "#n/a"].includes(low)) return false;
    // qualquer outro texto (conteudo real, ex: bullets em texto) = TEM
    return true;
  };

  return {
    asin: String(raw("asin") || "").trim(),
    merchant_customer_id: String(raw("merchant_customer_id") || "").trim(),
    seller_name: String(raw("seller_name") || "").trim(),
    item_name: String(raw("item_name") || "").trim(),
    glance_views_90d: toNum(raw("glance_views_90d")),
    am_alias: String(raw("am_alias") || "").trim() || "(sem AM)",
    has_bullet_points: presence("has_bullet_points"),
    has_description: presence("has_description"),
    has_main_image: presence("has_main_image"),
    image_count: toNum(raw("image_count")),
    has_keywords: presence("has_keywords"),
    idq_grade: String(raw("idq_grade") || "").trim(),
    idq_score: raw("idq_score"),
    cdq_grade: String(raw("cdq_grade") || "").trim(),
    promotion_type: String(raw("promotion_type") || "").trim(),
    // correcoes geradas
    fix: null,
  };
}

function toBool(v) {
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "sim" || s === "y";
}
function toNum(v) { const n = Number(String(v).replace(/[^0-9.-]/g, "")); return isNaN(n) ? 0 : n; }

/* Diagnostico de problemas por linha. */
function diagnoseRow(r) {
  const titleLen = (r.item_name || "").length;
  r.problems = {
    title: titleLen === 0 || titleLen < RULES.TITLE_MIN,
    bullets: !r.has_bullet_points,
    description: !r.has_description,
    keywords: !r.has_keywords,
    images: (r.image_count || 0) < RULES.MIN_IMAGES,
  };
  r.needsAi = r.problems.title || r.problems.bullets || r.problems.description || r.problems.keywords;
  return r;
}

/* ---------------- Mapeamento detectado (UI) ----------------
   Mostra, com nomes amigaveis, qual coluna do CSV foi associada a cada campo. */
function renderColumnMapping(map, headerFields) {
  const el = document.getElementById("columnMapping");
  if (!el) return;

  const rows = COLUMN_SCHEMA.map((def) => {
    const col = map[def.field];
    const ok = !!col;
    const status = ok
      ? `<span class="col-ok">✔ ${escapeHtml(col)}</span>`
      : `<span class="col-missing">— nao encontrada</span>`;
    return `<tr>
        <td>${escapeHtml(def.label)}${def.required ? ' <span class="req">*</span>' : ""}</td>
        <td>${status}</td>
      </tr>`;
  }).join("");

  // Colunas do CSV que nao foram reconhecidas (informativo).
  const mapped = new Set(Object.values(map).filter(Boolean).map((c) => String(c).toLowerCase()));
  const unknown = (headerFields || []).filter((h) => h && !mapped.has(String(h).trim().toLowerCase()));

  el.innerHTML = `
    <details open>
      <summary>Colunas detectadas no CSV</summary>
      <table class="col-map-table">
        <thead><tr><th>Campo</th><th>Coluna no arquivo</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${unknown.length ? `<p class="muted small">Colunas ignoradas (nao reconhecidas): ${unknown.map(escapeHtml).join(", ")}</p>` : ""}
      <p class="muted small"><span class="req">*</span> obrigatoria</p>
    </details>`;
  el.classList.remove("hidden");
}

/* ---------------- Dashboard ---------------- */
function buildDashboard() {
  const rows = state.rows;
  const total = rows.length;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;

  const noBullets = rows.filter((r) => r.problems.bullets).length;
  const noDesc = rows.filter((r) => r.problems.description).length;
  const fewImg = rows.filter((r) => r.problems.images).length;
  const noKw = rows.filter((r) => r.problems.keywords).length;
  const badTitle = rows.filter((r) => r.problems.title).length;

  const kpis = [
    { val: total, lbl: "ASINs carregados" },
    { val: pct(badTitle) + "%", lbl: "Titulo curto/vazio", alert: true },
    { val: pct(noBullets) + "%", lbl: "Sem bullet points", alert: true },
    { val: pct(noDesc) + "%", lbl: "Sem descricao", alert: true },
    { val: pct(fewImg) + "%", lbl: "Menos de 3 imagens", alert: true },
    { val: pct(noKw) + "%", lbl: "Sem keywords", alert: true },
  ];
  document.getElementById("kpiGrid").innerHTML = kpis.map((k) =>
    `<div class="kpi ${k.alert ? "alert" : ""}"><div class="val">${k.val}</div><div class="lbl">${k.lbl}</div></div>`
  ).join("");

  // Ranking sellers (por qtd de ASINs com algum problema)
  const sellerMap = groupCount(rows.filter((r) => r.needsAi || r.problems.images), (r) => r.seller_name || "(sem nome)");
  renderBars("sellerRanking", sellerMap, "orange");

  // Breakdown por AM
  const amMap = groupCount(rows, (r) => r.am_alias);
  renderBars("amBreakdown", amMap, "");

  // Popula selects de filtro e export
  populateSelect("filterAm", uniqueSorted(rows.map((r) => r.am_alias)));
  populateSelect("filterSeller", uniqueSorted(rows.map((r) => r.seller_name).filter(Boolean)));
  populateSelect("exportAmSelect", uniqueSorted(rows.map((r) => r.am_alias)), "Selecione um AM");

  applyFilters();
}

function groupCount(rows, keyFn) {
  const m = {};
  rows.forEach((r) => { const k = keyFn(r); m[k] = (m[k] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function renderBars(elId, entries, cls) {
  const max = entries.length ? entries[0][1] : 1;
  document.getElementById(elId).innerHTML = entries.slice(0, 12).map(([k, v]) =>
    `<div class="bar-item">
       <div class="bar-top"><span>${escapeHtml(k)}</span><strong>${v}</strong></div>
       <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.round((v / max) * 100)}%"></div></div>
     </div>`
  ).join("") || '<p class="muted small">Sem dados.</p>';
}

function uniqueSorted(arr) { return [...new Set(arr)].sort((a, b) => String(a).localeCompare(String(b))); }

function populateSelect(id, values, firstLabel) {
  const sel = document.getElementById(id);
  const keep = firstLabel !== undefined ? firstLabel : "Todos";
  sel.innerHTML = `<option value="">${keep}</option>` + values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
}

/* ---------------- Filtros ---------------- */
function setupFilters() {
  ["filterAm", "filterSeller", "filterProblem"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyFilters)
  );
}

function applyFilters() {
  const am = document.getElementById("filterAm").value;
  const seller = document.getElementById("filterSeller").value;
  const problem = document.getElementById("filterProblem").value;

  state.filtered = state.rows.filter((r) => {
    if (am && r.am_alias !== am) return false;
    if (seller && r.seller_name !== seller) return false;
    if (problem && !r.problems[problem]) return false;
    return true;
  });

  const needing = state.filtered.filter((r) => r.needsAi).length;
  document.getElementById("filterCount").textContent =
    `${state.filtered.length} ASINs no filtro - ${needing} precisam de IA`;
  document.getElementById("genTarget").textContent =
    `${needing} ASINs serao processados (do filtro atual).`;
}

/* ---------------- Geracao com IA ---------------- */
function setupGenerate() {
  document.getElementById("generateBtn").addEventListener("click", runGeneration);
}

async function runGeneration() {
  const btn = document.getElementById("generateBtn");
  const errEl = document.getElementById("genError");
  errEl.textContent = "";

  const targets = state.filtered.filter((r) => r.needsAi);
  if (!targets.length) { errEl.textContent = "Nenhum ASIN no filtro atual precisa de correcao."; return; }

  btn.disabled = true;
  const wrap = document.getElementById("progressWrap");
  const fill = document.getElementById("progressFill");
  const text = document.getElementById("progressText");
  wrap.classList.remove("hidden");
  fill.style.width = "0%";
  text.textContent = `Preparando ${targets.length} ASINs...`;

  const items = targets.map((r) => ({
    asin: r.asin,
    item_name: r.item_name,
    seller_name: r.seller_name,
    needs: {
      title: r.problems.title,
      bullets: r.problems.bullets,
      description: r.problems.description,
      keywords: r.problems.keywords,
    },
  }));

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!resp.ok || !resp.body) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error || ("Erro " + resp.status));
    }

    // Consome o stream SSE (progress / done / error)
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // separa por eventos (\n\n)
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSse(chunk);
        if (!evt) continue;

        if (evt.event === "progress") {
          const p = evt.data;
          const pct = Math.round((p.asinsDone / p.asinsTotal) * 100);
          fill.style.width = pct + "%";
          let msg = `Processando lote ${p.batchDone} de ${p.batchTotal} (${p.asinsDone}/${p.asinsTotal} ASINs)`;
          if (p.notice) msg += ` - ${p.notice}`;
          text.textContent = msg;
        } else if (evt.event === "done") {
          (evt.data.results || []).forEach((res) => {
            const row = targets.find((t) => t.asin === res.asin);
            if (row) applyFix(row, res);
          });
          fill.style.width = "100%";
          text.textContent = `Concluido: ${targets.length} ASINs processados.`;
          showGenSummary(targets);
          finished = true;
        } else if (evt.event === "error") {
          throw new Error(evt.data.error || "Falha na geracao.");
        }
      }
    }
  } catch (err) {
    errEl.textContent = "Falha na geracao: " + err.message;
  } finally {
    btn.disabled = false;
  }
}

/* Parseia um bloco de evento SSE em { event, data }. */
function parseSse(chunk) {
  const lines = chunk.split("\n");
  let event = "message";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch (e) {
    return null;
  }
}

/* Aplica correcoes na linha - SO nos campos que estavam vazios (problems). */
function applyFix(row, res) {
  if (!res) return;
  const fix = row.fix || {};
  if (row.problems.title && res.item_name) fix.item_name = res.item_name;
  if (row.problems.bullets && Array.isArray(res.bullet_points)) fix.bullet_points = res.bullet_points;
  if (row.problems.description && res.product_description) fix.product_description = res.product_description;
  if (row.problems.keywords && res.generic_keywords) fix.generic_keywords = res.generic_keywords;
  row.fix = fix;
}

function showGenSummary(targets) {
  const fixed = targets.filter((r) => r.fix);
  let titles = 0, bullets = 0, descs = 0, kws = 0;
  fixed.forEach((r) => {
    if (r.fix.item_name) titles++;
    if (r.fix.bullet_points) bullets++;
    if (r.fix.product_description) descs++;
    if (r.fix.generic_keywords) kws++;
  });
  const el = document.getElementById("genSummary");
  el.classList.remove("hidden");
  el.innerHTML = `
    <strong>${fixed.length} ASINs corrigidos.</strong>
    <ul>
      <li>Titulos gerados: ${titles}</li>
      <li>Conjuntos de bullet points: ${bullets}</li>
      <li>Descricoes: ${descs}</li>
      <li>Keywords: ${kws}</li>
    </ul>
    Pronto para exportar os flat files.`;
}

/* ---------------- Exportacao ---------------- */
function setupExport() {
  document.getElementById("exportAllBtn").addEventListener("click", () => exportSellers(null));
  document.getElementById("exportAmBtn").addEventListener("click", () => {
    const am = document.getElementById("exportAmSelect").value;
    if (!am) { document.getElementById("exportError").textContent = "Selecione um AM."; return; }
    exportSellers(am);
  });
  document.getElementById("exportReportBtn").addEventListener("click", exportReport);
}

/* Agrupa as linhas corrigidas por seller, montando as rows do flat file. */
function buildSellersPayload(filterAm) {
  const bySeller = {};
  for (const r of state.rows) {
    if (!r.fix) continue; // so exporta o que foi corrigido
    if (filterAm && r.am_alias !== filterAm) continue;
    const key = r.merchant_customer_id || r.seller_name || "seller";
    if (!bySeller[key]) {
      bySeller[key] = {
        merchant_customer_id: r.merchant_customer_id,
        seller_name: r.seller_name,
        am_alias: r.am_alias,
        rows: [],
      };
    }
    const fix = r.fix;
    const bp = fix.bullet_points || [];
    bySeller[key].rows.push({
      product_id: r.asin,
      item_name: fix.item_name || "",
      bullet_point1: bp[0] || "",
      bullet_point2: bp[1] || "",
      bullet_point3: bp[2] || "",
      bullet_point4: bp[3] || "",
      bullet_point5: bp[4] || "",
      product_description: fix.product_description || "",
      generic_keywords: fix.generic_keywords || "",
    });
  }
  return Object.values(bySeller);
}

async function exportSellers(filterAm) {
  const errEl = document.getElementById("exportError");
  errEl.textContent = "";
  const sellers = buildSellersPayload(filterAm);
  if (!sellers.length) {
    errEl.textContent = filterAm
      ? "Nenhum seller corrigido para esse AM. Gere as correcoes primeiro."
      : "Nenhuma correcao gerada ainda. Clique em 'Gerar Correcoes'.";
    return;
  }
  const url = filterAm ? "/api/export/am" : "/api/export/sellers";
  const body = filterAm ? { am_alias: filterAm, sellers } : { sellers };
  await downloadPost(url, body, filterAm ? `flat-files-${safeName(filterAm)}.zip` : "flat-files-ssrm.zip", errEl);
}

async function exportReport() {
  const errEl = document.getElementById("exportError");
  errEl.textContent = "";

  const corrected = state.rows.filter((r) => r.fix);
  if (!corrected.length) { errEl.textContent = "Gere as correcoes antes de exportar o relatorio."; return; }

  // Monta byAm -> sellers
  const amMap = {};
  let glanceImpact = 0;
  for (const r of corrected) {
    glanceImpact += r.glance_views_90d || 0;
    if (!amMap[r.am_alias]) amMap[r.am_alias] = {};
    const sKey = r.seller_name || r.merchant_customer_id || "seller";
    if (!amMap[r.am_alias][sKey]) amMap[r.am_alias][sKey] = { seller_name: sKey, qtd: 0, tipos: new Set(), glance: 0 };
    const s = amMap[r.am_alias][sKey];
    s.qtd++;
    s.glance += r.glance_views_90d || 0;
    if (r.fix.item_name) s.tipos.add("titulo");
    if (r.fix.bullet_points) s.tipos.add("bullets");
    if (r.fix.product_description) s.tipos.add("descricao");
    if (r.fix.generic_keywords) s.tipos.add("keywords");
  }

  const byAm = Object.entries(amMap).map(([am_alias, sellersObj]) => ({
    am_alias,
    sellers: Object.values(sellersObj).map((s) => ({ ...s, tipos: [...s.tipos] })),
  }));

  const payload = {
    kpis: {
      totalCorrigido: corrected.length,
      totalAsins: state.rows.length,
      glanceImpact,
    },
    byAm,
  };

  await downloadPost("/api/export/report", payload, "relatorio-interno-ssrm.xlsx", errEl);
}

/* Faz POST e baixa o arquivo binario retornado. */
async function downloadPost(url, body, filename, errEl) {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error || ("Erro " + resp.status));
    }
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    if (errEl) errEl.textContent = "Falha ao exportar: " + err.message;
  }
}

/* ---------------- Util ---------------- */
function safeName(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
