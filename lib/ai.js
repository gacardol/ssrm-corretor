/* Integracao com a Google Gemini API (gratuita) para gerar conteudo de catalogo
   em portugues brasileiro, processando ASINs em LOTE.

   Estrategia de performance (~10 min para 10K ASINs):
   - BATCH_SIZE: 50 ASINs por chamada (1 prompt com os 50, resposta em JSON array)
   - CONCURRENCY: 4 chamadas em paralelo -> 200 ASINs por "rodada"
   - Modelo: gemini-2.0-flash

   Regras de negocio:
   - Titulo: 80-150 caracteres. Formato: [Marca] + [Produto] + [Caracteristica] + [Medida/Qtd] + [Uso/Beneficio]
   - 5 bullet points (beneficios e caracteristicas)
   - Descricao: minimo 200 caracteres
   - generic_keywords: maximo 250 bytes
   - So aplica o que foi pedido em "needs" (campos vazios). Nao sobrescreve dados existentes. */

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_KEYWORDS_BYTES = 250;

const BATCH_SIZE = 50;   // ASINs por chamada
const CONCURRENCY = 4;   // chamadas simultaneas
const MAX_RETRIES = 3;   // tentativas por lote em caso de rate limit (429)
const RETRY_WAIT_MS = 30000; // espera entre retries (30s)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Verifica se a IA esta configurada (chave presente). */
function isAiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/* Processa uma lista de itens (qualquer tamanho) em lotes de 50, com 4 chamadas
   em paralelo. Retorna um array alinhado por ASIN com o conteudo gerado.
   onProgress(opcional) recebe { batchDone, batchTotal, asinsDone, asinsTotal }. */
async function generateContentForAsins(items, onProgress) {
  if (!isAiConfigured()) {
    const err = new Error("IA nao conectada - configure a GEMINI_API_KEY no .env");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  const results = new Array(items.length);

  // Quebra em lotes de 50, guardando os indices originais de cada item.
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push({ start: i, items: items.slice(i, i + BATCH_SIZE) });
  }

  const batchTotal = batches.length;
  const asinsTotal = items.length;
  let batchDone = 0;
  let asinsDone = 0;

  // Pool de workers com concorrencia 4.
  let nextBatch = 0;
  async function worker() {
    while (nextBatch < batches.length) {
      const b = batches[nextBatch++];
      let generated;
      try {
        generated = await generateBatch(b.items, (info) => {
          // repassa avisos de retry para a UI
          if (typeof onProgress === "function") {
            onProgress({ batchDone, batchTotal, asinsDone, asinsTotal, notice: info });
          }
        });
      } catch (err) {
        console.error(`Falha no lote (inicio ${b.start}):`, err.message);
        generated = b.items.map((it) => ({ ...fallbackContent(it), _fallback: true, _error: err.message }));
      }
      // Reaplica na posicao original, casando por ASIN.
      const byAsin = indexByAsin(generated);
      b.items.forEach((item, k) => {
        const found = byAsin[item.asin] || generated[k] || {};
        results[b.start + k] = finalizeItem(item, found);
      });
      batchDone++;
      asinsDone += b.items.length;
      if (typeof onProgress === "function") onProgress({ batchDone, batchTotal, asinsDone, asinsTotal });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* Gera o conteudo de um lote de ASINs numa unica chamada Gemini.
   Em caso de rate limit (429), tenta novamente ate MAX_RETRIES vezes,
   esperando RETRY_WAIT_MS (30s) entre as tentativas.
   notify(opcional) recebe avisos textuais para a UI (ex.: aguardando retry). */
async function generateBatch(batchItems, notify) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGemini(batchItems);
    } catch (err) {
      lastErr = err;
      // So vale a pena re-tentar em rate limit (429). Outros erros falham direto.
      if (err.code === "RATE_LIMIT" && attempt < MAX_RETRIES) {
        const secs = Math.round(RETRY_WAIT_MS / 1000);
        const msg = `Limite da IA atingido (429). Tentativa ${attempt}/${MAX_RETRIES} - aguardando ${secs}s...`;
        console.warn(msg);
        if (typeof notify === "function") notify(msg);
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* Faz a chamada HTTP unica ao Gemini para um lote. */
async function callGemini(batchItems) {
  const prompt = buildBatchPrompt(batchItems);

  const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text:
            "Voce e um especialista em SEO de catalogo da Amazon Brasil. " +
            "Escreve sempre em portugues brasileiro, claro e vendedor, sem inventar dados tecnicos nao informados. " +
            "Responde SEMPRE e SOMENTE com um array JSON valido, sem texto extra, sem markdown.",
        }],
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Gemini ${resp.status}: ${text.slice(0, 300)}`);
    if (resp.status === 429) err.code = "RATE_LIMIT";
    throw err;
  }

  const data = await resp.json();
  const raw =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) throw new Error("Resposta da IA nao e um array JSON valido.");
  return parsed;
}

/* Monta o prompt com TODOS os ASINs do lote, pedindo um array JSON de volta. */
function buildBatchPrompt(batchItems) {
  const list = batchItems
    .map((it, i) =>
      `${i + 1}. ASIN: ${it.asin || "(desconhecido)"} | Titulo atual: ${it.item_name || "(vazio)"} | Loja: ${it.seller_name || "(desconhecida)"}`
    )
    .join("\n");

  return [
    `Gere conteudo de catalogo para os ${batchItems.length} produtos abaixo. Use o titulo atual e a loja para inferir do que se trata cada produto.`,
    "",
    list,
    "",
    "Responda com um ARRAY JSON. Cada elemento deve ter EXATAMENTE estas chaves:",
    "{",
    '  "asin": o ASIN do produto (igual ao da lista),',
    '  "item_name": titulo SEO Amazon BR entre 80 e 150 caracteres, formato [Marca] + [Produto] + [Caracteristica] + [Medida/Quantidade] + [Uso/Beneficio],',
    '  "bullet_points": array com exatamente 5 strings (beneficios e caracteristicas),',
    '  "product_description": descricao completa, no minimo 200 caracteres,',
    '  "generic_keywords": palavras-chave relevantes separadas por espaco, no maximo 250 bytes',
    "}",
    "",
    "Regras: portugues brasileiro; um elemento por ASIN, na mesma ordem; nao invente certificacoes, voltagem ou medidas " +
      "que nao possam ser inferidas; se nao souber a marca, omita a marca do titulo; nao use aspas duplas dentro dos textos.",
  ].join("\n");
}

/* Indexa o array retornado pela IA por ASIN para casar com os itens enviados. */
function indexByAsin(arr) {
  const map = {};
  for (const el of arr) {
    if (el && el.asin) map[String(el.asin).trim()] = el;
  }
  return map;
}

/* Aplica clamps/regras e devolve apenas os campos requeridos por "needs" do item. */
function finalizeItem(item, gen) {
  const needs = item.needs || {};
  return {
    asin: item.asin,
    item_name: needs.title ? clampTitle(gen.item_name || "") : undefined,
    bullet_points: needs.bullets ? normalizeBullets(gen.bullet_points) : undefined,
    product_description: needs.description ? ensureMinDescription(gen.product_description || "", item) : undefined,
    generic_keywords: needs.keywords ? clampKeywordsBytes(gen.generic_keywords || "") : undefined,
    _fallback: gen._fallback || undefined,
  };
}

/* ---------------- Helpers de conteudo ---------------- */

function clampTitle(t) {
  let title = String(t || "").replace(/\s+/g, " ").trim();
  if (title.length > 150) title = title.slice(0, 150).trim();
  return title;
}

function normalizeBullets(arr) {
  let bullets = Array.isArray(arr) ? arr.map((b) => String(b || "").replace(/\s+/g, " ").trim()).filter(Boolean) : [];
  bullets = bullets.slice(0, 5);
  while (bullets.length < 5) bullets.push("");
  return bullets;
}

function ensureMinDescription(desc, item) {
  let d = String(desc || "").replace(/\s+/g, " ").trim();
  if (d.length >= 200) return d;
  const base = item.item_name || item.seller_name || "Produto";
  const filler =
    ` ${base} com otimo custo-beneficio, ideal para o dia a dia. Produto de qualidade, pratico de usar e duravel, ` +
    "pensado para atender as necessidades do consumidor brasileiro com seguranca e conforto.";
  while (d.length < 200) d = (d + filler).trim();
  return d.slice(0, 2000);
}

/* generic_keywords tem limite em BYTES (UTF-8), nao caracteres. */
function clampKeywordsBytes(str) {
  let s = String(str || "").replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(s, "utf8") <= MAX_KEYWORDS_BYTES) return s;
  const words = s.split(" ");
  while (words.length && Buffer.byteLength(words.join(" "), "utf8") > MAX_KEYWORDS_BYTES) words.pop();
  return words.join(" ");
}

/* Extrai JSON (array ou objeto) mesmo que venha com texto/markdown ao redor. */
function parseJsonLoose(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (e2) { /* tenta objeto */ }
    }
    const os = text.indexOf("{");
    const oe = text.lastIndexOf("}");
    if (os !== -1 && oe !== -1 && oe > os) {
      try { return JSON.parse(text.slice(os, oe + 1)); } catch (e3) { return null; }
    }
    return null;
  }
}

/* Conteudo de fallback por item quando uma chamada de lote falha,
   para nao travar o processamento dos 10K ASINs. */
function fallbackContent(item) {
  const name = (item.item_name || "Produto").replace(/\s+/g, " ").trim();
  const seller = (item.seller_name || "").trim();
  let t = name;
  if (seller && !t.toLowerCase().includes(seller.toLowerCase())) t = `${seller} ${t}`;
  t = `${t} - Produto de Qualidade para Uso Diario, Pratico e Duravel`;
  return {
    asin: item.asin,
    item_name: clampTitle(t.length < 80 ? `${t} com Otimo Custo-Beneficio para o Seu Dia a Dia` : t),
    bullet_points: normalizeBullets([
      `Produto ${name} ideal para uso no dia a dia`,
      "Material de qualidade, pensado para durabilidade e praticidade",
      "Facil de usar e adaptado as necessidades do consumidor brasileiro",
      "Otimo custo-beneficio, unindo qualidade e preco justo",
      "Perfeito para presente ou uso pessoal, com acabamento cuidadoso",
    ]),
    product_description: ensureMinDescription(
      `${name} foi desenvolvido para oferecer praticidade e qualidade no dia a dia. ` +
        "Com acabamento cuidadoso e materiais selecionados, e uma otima escolha para quem busca durabilidade e bom desempenho.",
      item
    ),
    generic_keywords: clampKeywordsBytes(
      `${name} qualidade pratico duravel custo beneficio uso diario presente brasil`.toLowerCase()
    ),
  };
}

module.exports = {
  generateContentForAsins,
  isAiConfigured,
  GEMINI_MODEL,
  BATCH_SIZE,
  CONCURRENCY,
};
