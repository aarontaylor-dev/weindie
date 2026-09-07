/* The page chrome, matching weindie.com.
 *
 * Same masthead, same footer, same numbered section rail, same theme boot
 * script, same fonts served from the same paths. The stylesheet is not a copy
 * of the site's design — it *is* the site's stylesheet, lifted straight out of
 * ../src/site.css at deploy time. If the site's palette changes, these pages
 * change with it, and neither can drift from the other.
 *
 * A small amount of extra CSS is defined here for things the main site has no
 * component for: an article, a writer card, a state list, a cost table.
 */

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23315c4d'/%3E%3Cpath d='M8 22L14 10M18 22l6-12' fill='none' stroke='%23fbfaf7' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E";

const THEME_BOOT =
  "try{var t=localStorage.getItem('weindie-theme');" +
  "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

const THEME_JS = `(function(){
  var btn=document.getElementById('theme');if(!btn)return;
  var root=document.documentElement,label=btn.querySelector('.vh'),t;
  function current(){var s=root.getAttribute('data-theme');return s||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');}
  function paint(){var n=current()==='dark'?'light':'dark',x='Switch to '+n+' theme';
    btn.setAttribute('aria-label',x);btn.setAttribute('title',x);if(label)label.textContent=x;}
  btn.addEventListener('click',function(){
    root.classList.add('theming');clearTimeout(t);t=setTimeout(function(){root.classList.remove('theming')},340);
    var n=current()==='dark'?'light':'dark';root.setAttribute('data-theme',n);
    try{localStorage.setItem('weindie-theme',n)}catch(e){}paint();});
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',paint);paint();
})();`;

const THEME_ICON = `<svg class="tsvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <mask id="tcut"><rect width="24" height="24" fill="#fff"/><circle class="cut" cx="15.5" cy="8.5" r="7" fill="#000"/></mask>
        <circle class="orb" cx="12" cy="12" r="5" mask="url(#tcut)"/>
        <g class="rays" stroke-linecap="round">
          <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
          <line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/>
          <line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/>
        </g>
      </svg>`;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Components the main site does not have. Everything is expressed in its
   tokens — no new colours, no cards, separation by rule and space. */
const EXTRA = `
  .phead{padding:52px 0 0}
  .phead h1{font-family:var(--mono);font-weight:500;font-size:clamp(38px,7vw,64px);line-height:.98;letter-spacing:-.045em}
  .phead .lede{margin-top:20px;font-size:18px;max-width:33em}
  .phead .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}

  .feed{border-top:2px solid var(--ink);margin-top:44px}
  .entry{display:grid;grid-template-columns:154px minmax(0,1fr);gap:var(--gut);
    padding:26px 0;border-bottom:1px solid var(--rule);text-decoration:none;color:inherit}
  .entry:hover{background:var(--sunk)}
  .entry .who{font-family:var(--mono);font-size:13px;color:var(--accent);line-height:1.5}
  .entry .who span{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:3px}
  .entry h2{font-size:23px;line-height:1.2;font-weight:500;letter-spacing:-.01em}
  .entry p{color:var(--muted);margin-top:7px}
  .meta{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--faint);margin-top:10px;
    display:flex;flex-wrap:wrap;gap:4px 14px}

  .essay{max-width:34em}
  .essay p{margin:0 0 22px;font-size:18.5px;line-height:1.62}
  .essay p:last-child{margin-bottom:0}
  .essay h3{font-family:var(--mono);font-size:12px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--faint);margin:34px 0 12px;font-weight:500}

  .prov{display:grid;grid-template-columns:200px minmax(0,1fr);gap:2px 20px;
    font-family:var(--mono);font-size:12.5px;line-height:1.7}
  .prov dt{color:var(--faint)}
  .prov dd{margin:0;color:var(--ink)}

  .cites{margin:0;padding:0;list-style:none;border-top:1px solid var(--rule)}
  .cites li{padding:11px 0;border-bottom:1px solid var(--rule)}
  .cites a{font-size:16px}
  .cites .src{font-family:var(--mono);font-size:11px;color:var(--faint);display:block;margin-top:3px;
    letter-spacing:.05em;word-break:break-all}

  .states{margin:0;padding:0;list-style:none}
  .states li{padding:11px 0;border-top:1px solid var(--rule);color:var(--muted)}
  .states li:first-child{border-top:0;padding-top:0}
  .states b{color:var(--ink);font-weight:400}
  .conf{font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.06em}

  .numbers{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:13px}
  .numbers th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--faint);padding:0 12px 8px 0;border-bottom:1px solid var(--ink)}
  .numbers td{padding:9px 12px 9px 0;border-bottom:1px solid var(--rule);color:var(--ink)}
  .numbers td.n{text-align:right;font-variant-numeric:tabular-nums}
  .numbers th.n{text-align:right}
  .numbers tr:hover td{background:var(--sunk)}

  /* Outlines rather than a ruled background, so a row that does not divide
     evenly leaves paper in the gap instead of a grey block. */
  .bignum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;margin-bottom:26px}
  .bignum div{background:var(--paper);padding:14px 16px;outline:1px solid var(--rule)}
  .bignum b{display:block;font-family:var(--mono);font-size:26px;font-weight:400;letter-spacing:-.02em}
  .bignum span{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  .note{font-family:var(--mono);font-size:12px;line-height:1.7;color:var(--faint);max-width:44em}
  .note b{color:var(--ink);font-weight:500}
  .empty{color:var(--muted);font-style:italic}

  @media (max-width:820px){
    .entry{grid-template-columns:1fr;gap:8px}
    .prov{grid-template-columns:1fr;gap:0}
    .prov dt{margin-top:10px}
  }
`;

export interface PageOpts {
  title: string;
  description: string;
  path: string;
  origin: string;
}

export function page(o: PageOpts, main: string): Response {
  const url = o.origin + o.path;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(o.title)}</title>
  <meta name="description" content="${esc(o.description)}">
  <link rel="canonical" href="${esc(url)}">
  <link rel="icon" href="${FAVICON}">
  <meta name="robots" content="noindex">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WeIndie">
  <meta property="og:title" content="${esc(o.title)}">
  <meta property="og:description" content="${esc(o.description)}">
  <link rel="preload" href="/fonts/ibm-plex-mono-400.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/ibm-plex-mono-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/newsreader-var.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/site.css">
  <style>${EXTRA}</style>
  <script>${THEME_BOOT}</script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="wrap nav">
    <a class="brand" href="/">weindie</a>
    <div class="navend">
      <nav class="navlinks">
        <a href="/thoughts">Thoughts</a>
        <a href="/writers">Writers</a>
        <a href="/status">Status</a>
      </nav>
      <button class="theme" id="theme" type="button">${THEME_ICON}<span class="vh">Switch theme</span></button>
    </div>
  </header>
  <main class="wrap" id="main">${main}</main>
  <footer class="wrap"><div class="foot"><b>weindie</b><span>Independent tools for navigating work with AI.</span><span>Writers v0.1 &middot; an experiment</span><span><a href="/LICENSE.txt">MIT licensed</a></span></div><div class="foot2"><a href="https://github.com/aarontaylor-dev/weindie">Source on GitHub</a>&nbsp;&middot; <a href="/writers">What these writers are</a>&nbsp;&middot; <a href="/status">What they cost</a>&nbsp;&middot; <a href="mailto:hi@aarontaylor.me">hi@aarontaylor.me</a></div></footer>
  <script>${THEME_JS}</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
        "img-src 'self' data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export function block(n: string | null, name: string, inner: string) {
  return `<section class="blk" id="${name.toLowerCase().replace(/[^a-z]+/g, '-')}">
      <div class="rail">${n ? `<div class="n">&sect; ${n}</div>` : ''}<h2>${esc(name)}</h2></div>
      <div class="body">${inner}</div>
    </section>`;
}

export const notFound = (origin: string) =>
  page(
    { title: 'Not found — WeIndie', description: 'No such page.', path: '/404', origin },
    `<div class="phead"><h1>404</h1><p class="lede">Nothing here. Try <a href="/thoughts">the thoughts</a> or
     <a href="/writers">the writers</a>.</p></div>`,
  );

/* Body text arrives as plain paragraphs separated by blank lines. Rendering it
   as text and nothing else is a security decision as much as a stylistic one:
   an essay is prose, so there is no path by which a model or a source could put
   markup on a page. */
export function paragraphs(body: string) {
  return body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, ' ')}</p>`).join('\n');
}

export function excerpt(body: string, chars = 200) {
  const first = body.split(/\n{2,}/)[0]?.trim() ?? '';
  return first.length > chars ? first.slice(0, chars).replace(/\s\S*$/, '') + '…' : first;
}

export const shortDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
