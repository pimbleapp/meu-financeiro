// ============================================================
// /api/noticias — feed de notícias financeiras (mundo + Brasil)
// ============================================================
// Roda como função serverless na Vercel (não vai pro navegador),
// então NÃO expõe nenhuma chave: ela só lê feeds RSS públicos de
// veículos de economia, junta tudo, tira um resumo curto de cada
// e devolve em JSON pro app. O app chama /api/noticias (mesmo
// domínio), por isso não precisa mexer no CSP.
//
// "Resumo" aqui = a própria descrição/chamada que o veículo publica
// no RSS (1-2 frases), com o link pra notícia completa. Sem IA, sem
// custo, e atualiza sozinho conforme os sites publicam.

// Fontes: uma mistura de Brasil (pt) e mundo (en). Se alguma cair,
// as outras continuam — nunca derruba a resposta inteira.
const FONTES = [
  { url: 'https://www.infomoney.com.br/feed/', fonte: 'InfoMoney', idioma: 'pt' },
  { url: 'https://g1.globo.com/rss/g1/economia/', fonte: 'G1 Economia', idioma: 'pt' },
  { url: 'https://www.moneytimes.com.br/feed/', fonte: 'Money Times', idioma: 'pt' },
  { url: 'http://feeds.marketwatch.com/marketwatch/topstories/', fonte: 'MarketWatch', idioma: 'en' },
  { url: 'https://finance.yahoo.com/news/rssindex', fonte: 'Yahoo Finance', idioma: 'en' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', fonte: 'CNBC', idioma: 'en' },
];

const MAX_NOTICIAS = 18;
const TIMEOUT_MS = 5000;

// ---- utilidades de texto ----------------------------------

// Tabela das entidades nomeadas mais comuns em feeds (acentos do português
// + pontuação). As numéricas (&#233; / &#xE9;) são resolvidas genericamente.
const ENTIDADES = {
  quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', deg: '°',
  ordm: 'º', ordf: 'ª', trade: '™', reg: '®',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', ntilde: 'ñ',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  Iacute: 'Í', Icirc: 'Î',
  Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Ccedil: 'Ç', Ntilde: 'Ñ',
};

function decodeEntidades(str) {
  if (!str) return '';
  return String(str)
    // numéricas decimais: &#233;
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return _; }
    })
    // numéricas hexadecimais: &#xE9;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return _; }
    })
    // nomeadas conhecidas (menos &lt; &gt; &amp;, tratadas logo abaixo)
    .replace(/&([a-zA-Z]+);/g, (todo, nome) =>
      Object.prototype.hasOwnProperty.call(ENTIDADES, nome) ? ENTIDADES[nome] : todo
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // &amp; por último, pra não re-decodificar
}

function limparHtml(str) {
  if (!str) return '';
  return decodeEntidades(
    String(str)
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .replace(/<[^>]*>/g, ' ') // tira tags
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function resumir(texto, limite = 220) {
  const limpo = limparHtml(texto);
  if (limpo.length <= limite) return limpo;
  const corte = limpo.slice(0, limite);
  const ultimoEspaco = corte.lastIndexOf(' ');
  return (ultimoEspaco > 80 ? corte.slice(0, ultimoEspaco) : corte).trim() + '…';
}

// Pega o conteúdo da primeira ocorrência de <tag>...</tag> num bloco.
function pegarTag(bloco, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = bloco.match(re);
  return m ? m[1] : '';
}

// ---- parser de RSS 2.0 e Atom (sem dependências) ----------

function parseFeed(xml, fonte) {
  const itens = [];

  // RSS 2.0: <item>...</item>
  const blocosItem = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const bloco of blocosItem) {
    const titulo = limparHtml(pegarTag(bloco, 'title'));
    let link = limparHtml(pegarTag(bloco, 'link'));
    const descricao = pegarTag(bloco, 'description') || pegarTag(bloco, 'content:encoded');
    const data = limparHtml(pegarTag(bloco, 'pubDate') || pegarTag(bloco, 'dc:date'));
    if (titulo && link) {
      itens.push({ titulo, url: link, resumo: resumir(descricao), fonte, dataISO: paraISO(data) });
    }
  }

  // Atom: <entry>...</entry> (ex.: alguns feeds do Yahoo/Google)
  if (itens.length === 0) {
    const blocosEntry = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
    for (const bloco of blocosEntry) {
      const titulo = limparHtml(pegarTag(bloco, 'title'));
      // Atom usa <link href="..."/>
      let link = '';
      const mLink = bloco.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
      if (mLink) link = mLink[1];
      const descricao = pegarTag(bloco, 'summary') || pegarTag(bloco, 'content');
      const data = limparHtml(pegarTag(bloco, 'updated') || pegarTag(bloco, 'published'));
      if (titulo && link) {
        itens.push({ titulo, url: link, resumo: resumir(descricao), fonte, dataISO: paraISO(data) });
      }
    }
  }

  return itens;
}

function paraISO(dataTexto) {
  if (!dataTexto) return null;
  const d = new Date(dataTexto);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- busca de um feed com timeout --------------------------

async function buscarFeed({ url, fonte }) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controle.signal,
      headers: {
        // alguns veículos bloqueiam requisições sem user-agent "de navegador"
        'User-Agent': 'Mozilla/5.0 (compatible; MeuFinanceiroBot/1.0; +https://www.pimble.com.br)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseFeed(xml, fonte);
  } catch (e) {
    return []; // feed fora do ar / timeout: ignora, sem derrubar o resto
  } finally {
    clearTimeout(timer);
  }
}

// ---- handler -----------------------------------------------

export default async function handler(req, res) {
  try {
    const resultados = await Promise.allSettled(FONTES.map(buscarFeed));
    let noticias = [];
    resultados.forEach((r) => {
      if (r.status === 'fulfilled') noticias = noticias.concat(r.value);
    });

    // tira duplicadas (mesmo título ou mesma url)
    const vistos = new Set();
    noticias = noticias.filter((n) => {
      const chave = (n.titulo || '').toLowerCase().slice(0, 80);
      if (!n.titulo || !n.url || vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });

    // ordena por data (mais recente primeiro); sem data vai pro fim
    noticias.sort((a, b) => {
      if (!a.dataISO && !b.dataISO) return 0;
      if (!a.dataISO) return 1;
      if (!b.dataISO) return -1;
      return a.dataISO < b.dataISO ? 1 : -1;
    });

    noticias = noticias.slice(0, MAX_NOTICIAS);

    // Cache na CDN da Vercel: serve a mesma resposta por 30 min pra todo
    // mundo (não martela os veículos) e revalida em segundo plano por +1h.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      atualizadoEm: new Date().toISOString(),
      total: noticias.length,
      noticias,
    });
  } catch (e) {
    return res.status(200).json({ atualizadoEm: new Date().toISOString(), total: 0, noticias: [], erro: true });
  }
}
