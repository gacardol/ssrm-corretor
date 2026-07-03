# Corretor de Catalogo Massivo SSR-M

Ferramenta interna para o time de Account Managers (SSR-M) da Amazon Brasil. Recebe um CSV exportado do Andi/Workbench, diagnostica problemas de catalogo, gera correcoes com IA (titulo, bullets, descricao, keywords) e exporta flat files separados por seller no formato aceito pelo Seller Central para upload em massa.

> A ferramenta **nao envia nada** para o seller. E 100% uso interno do time. Nao mexe em preco, estoque ou imagens.

## IA via Google Gemini (gratuita)

A geracao de conteudo usa a **Google Gemini API** (modelo `gemini-2.0-flash`), gratuita.

1. Pegue sua chave em [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Coloque no `.env`: `GEMINI_API_KEY=sua_chave`.

### Processamento em lote (rapido)

- **50 ASINs por chamada** (1 prompt com os 50, resposta em array JSON).
- **4 chamadas em paralelo** -> 200 ASINs por rodada.
- Tempo estimado: **~10 minutos para 10K ASINs**.
- A tela mostra o progresso em tempo real: `Processando lote 3 de 200 (150/10000 ASINs)`.
- **Retry automatico em rate limit (429)**: cada lote tenta ate 3 vezes, esperando 30s entre as tentativas. Se esgotar, aquele lote usa conteudo de fallback e o processamento continua. A tela mostra o aviso de espera durante o retry.

## Como rodar localmente

```bash
cd ssrm-corretor
npm install
copy .env.example .env   # (no Windows; use cp no Mac/Linux) e cole sua GEMINI_API_KEY
npm start
```

Abra http://localhost:3000

Sem `GEMINI_API_KEY`, a tela mostra **"IA nao configurada - defina GEMINI_API_KEY no .env"** e a geracao falha ate configurar a chave.

## Fluxo de uso

1. **Upload** do CSV (use `exemplo-catalogo.csv` para testar).
2. **Diagnostico**: dashboard com % sem bullets/descricao/keywords, titulo curto, menos de 3 imagens, ranking de sellers e breakdown por AM. Filtros por AM, seller e tipo de problema.
3. **Gerar Correcoes**: processa em lote (50 ASINs/chamada, 4 em paralelo) com barra de progresso, apenas os campos vazios.
4. **Exportar**:
   - **Todos** -> ZIP com 1 `.xlsx` por seller (`{merchant_customer_id}_{seller_name}.xlsx`).
   - **Por AM** -> ZIP so dos sellers de um AM.
   - **Relatorio interno** -> Excel com aba por AM + KPIs.

## Formato do CSV de entrada

Colunas esperadas: `asin, merchant_customer_id, seller_name, item_name, glance_views_90d, am_alias, has_bullet_points, has_description, has_main_image, image_count, has_keywords, idq_grade, idq_score, cdq_grade`

## Flat file de saida

Colunas: `product_id, product_id_type (ASIN), item_name, bullet_point1..5, product_description, generic_keywords, update_delete (PartialUpdate)`. So vem preenchido o que foi corrigido.

## Regras de negocio

- Titulo: 80-150 caracteres, formato `[Marca] + [Produto] + [Caracteristica] + [Medida/Qtd] + [Uso/Beneficio]`
- 5 bullet points
- Descricao: minimo 200 caracteres
- generic_keywords: maximo 250 **bytes**
- So gera para campos **vazios** (nao sobrescreve dados existentes)
- Portugues brasileiro

## Deploy no Render.com

1. Suba esta pasta num repositorio Git.
2. No Render: New > Web Service, aponte para o repo. O `render.yaml` ja define build/start.
3. Em Environment, adicione `GEMINI_API_KEY` (e opcionalmente `GEMINI_MODEL`).

## Stack

Node.js + Express, papaparse (CSV no front), exceljs (planilhas), archiver (ZIP), IA via Google Gemini (`gemini-2.0-flash`) com processamento em lote. Sem banco de dados - processamento em memoria.
