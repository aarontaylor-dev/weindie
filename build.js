#!/usr/bin/env node
/*
 * WeIndie site build.
 *
 * Reads the canonical skills in skills/ and writes the public pages.
 * No dependencies, no framework. Run: node build.js
 *
 *   skills/<slug>/SKILL.md    canonical skill — the single source of truth
 *   skills/<slug>/skill.json  page content and customisation options
 *   skills/catalogue.json     which skills exist, and in what order
 *   changelog.json            what changed, and when — also the site version
 *
 * Generated output (do not edit by hand):
 *   <slug>.html         the public page          -> https://weindie.com/<slug>
 *   <slug>/SKILL.md     copy of the canonical    -> https://weindie.com/<slug>/SKILL.md
 *   index.html          homepage
 *   changelog.html      the changelog          -> https://weindie.com/changelog
 *   not-built.html      what was left out      -> https://weindie.com/not-built
 *   feed.xml            Atom feed of the changelog
 *   og.svg, og/<slug>.svg + .png   link-preview cards
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const ORIGIN = 'https://weindie.com';
const REPO = 'https://github.com/aarontaylor-dev/weindie';
const ISSUES = REPO + '/issues';
/* A personal address rather than an on-brand one: it is already the author of
   every commit in this public repository, so forwarding hi@weindie.com to it
   would protect nothing and cost a working mail setup. Empty disables the line. */
const CONTACT = 'hi@aarontaylor.me';
/* The author's index of the other work. It links down to weindie; without this
   the link only goes one way, and a set of sites with one-way links reads as a
   set of unrelated sites. */
const HUB = 'https://aarontaylor.me';
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Only touch a file when its contents actually change, so mtimes stay meaningful
   (the PNG step below compares them) and rebuilds produce no spurious diffs. */
const write = (p, s) => {
  const full = path.join(ROOT, p);
  if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') === s) return;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, s);
};
const fail = m => { console.error('build failed: ' + m); process.exit(1); };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
/* Safe to embed inside <script>. */
const json = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');

/* Where each environment looks for Agent Skills. Verified against vendor docs. */
const PLATFORMS = [
  {
    id: 'claude', name: 'Claude Code',
    project: '.claude/skills/<slug>/SKILL.md',
    user: '~/.claude/skills/<slug>/SKILL.md',
    note: 'Project skills also load from any parent directory up to the repository root. On a name clash, a personal skill wins over a project one.',
    docs: 'https://code.claude.com/docs/en/skills', docsLabel: 'Claude Code skills documentation'
  },
  {
    id: 'cursor', name: 'Cursor',
    project: '.cursor/skills/<slug>/SKILL.md',
    user: '~/.cursor/skills/<slug>/SKILL.md',
    note: 'Cursor also reads .agents/skills/, .claude/skills/ and .codex/skills/, so a skill installed for another tool is usually already available.',
    docs: 'https://cursor.com/docs/skills', docsLabel: 'Cursor skills documentation'
  },
  {
    id: 'codex', name: 'OpenAI / Codex',
    project: '.agents/skills/<slug>/SKILL.md',
    user: '~/.agents/skills/<slug>/SKILL.md',
    note: 'Codex scans .agents/skills in every directory from the working directory up to the repository root.',
    docs: 'https://developers.openai.com/codex/skills', docsLabel: 'Codex skills documentation'
  },
  {
    id: 'generic', name: 'Generic',
    project: '.agents/skills/<slug>/SKILL.md',
    user: '~/.agents/skills/<slug>/SKILL.md',
    note: 'The Agent Skills specification defines the folder and the SKILL.md format, but leaves it to each tool to decide where to look. .agents/skills/ is the most widely read location — check your tool if it is not picked up.',
    docs: 'https://agentskills.io/specification', docsLabel: 'Agent Skills specification'
  }
];

/* ---------------------------------------------------------------- parsing */

function frontmatter(md, where) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) fail(where + ': no frontmatter');
  const out = { metadata: {} };
  let inMeta = false;
  for (const raw of m[1].split('\n')) {
    if (/^\s*$/.test(raw)) continue;
    if (/^metadata:\s*$/.test(raw)) { inMeta = true; continue; }
    const indented = /^\s+\S/.test(raw);
    if (inMeta && indented) {
      const kv = /^\s+([\w-]+):\s*(.*)$/.exec(raw);
      if (kv) out.metadata[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
      continue;
    }
    inMeta = false;
    const kv = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function loadSkill(slug) {
  const where = 'skills/' + slug;
  const canonical = read(where + '/SKILL.md');
  const meta = JSON.parse(read(where + '/skill.json'));
  const fm = frontmatter(canonical, where + '/SKILL.md');

  if (fm.name !== slug) fail(where + ': frontmatter name "' + fm.name + '" must match the folder name');
  if (!fm.description) fail(where + ': frontmatter needs a description');
  const version = fm.metadata.version, source = fm.metadata.source;
  if (!version) fail(where + ': frontmatter metadata needs a version');
  if (source !== ORIGIN + '/' + slug) fail(where + ': metadata.source should be ' + ORIGIN + '/' + slug);

  /* The customisable lines must be exactly the bullets under this heading. */
  const sec = /\n## Defaults you can change\n\n([\s\S]*?)\n\n(- \*\*[\s\S]*)$/.exec(canonical);
  if (!sec) fail(where + ': SKILL.md needs a "## Defaults you can change" section with an intro paragraph and bullets');
  const defaultsNote = sec[1];
  const bullets = sec[2].trim().split('\n').filter(l => l.trim());

  const defaults = [];
  for (const o of meta.options) {
    const d = o.choices.filter(c => c.default);
    if (d.length !== 1) fail(where + ': option "' + o.id + '" needs exactly one default choice');
    for (const c of o.choices) {
      const hits = canonical.split(c.line).length - 1;
      if (c.default && hits !== 1) fail(where + ': the default line for "' + o.id + '/' + c.id + '" appears ' + hits + ' times in SKILL.md — it must appear exactly once');
      if (!c.default && hits !== 0) fail(where + ': the non-default line for "' + o.id + '/' + c.id + '" also appears in SKILL.md');
    }
    defaults.push(d[0].line);
  }
  for (const b of bullets) {
    if (!defaults.includes(b)) fail(where + ': SKILL.md has an adjustable bullet with no matching option in skill.json:\n  ' + b);
  }
  if (defaults.length !== bullets.length) fail(where + ': skill.json has ' + defaults.length + ' options but SKILL.md lists ' + bullets.length + ' adjustable bullets');

  /* Optional, and held to the same standard as everything else: a section that
     exists but says nothing is worse than no section. */
  if (meta.provenance) {
    const body = meta.provenance.body;
    if (!Array.isArray(body) || !body.length || body.some(t => !String(t).trim()))
      fail(where + ': provenance needs at least one non-empty paragraph');
    for (const l of meta.provenance.links || [])
      if (!Array.isArray(l) || l.length !== 3 || l.some(t => !String(t).trim()))
        fail(where + ': each provenance link needs a href, a short key and a description');
  }

  return Object.assign({}, meta, {
    slug, canonical, defaultsNote, version, source,
    description: fm.description,
    raw: ORIGIN + '/' + slug + '/SKILL.md',
    url: ORIGIN + '/' + slug
  });
}

/* Stable and permanent: this is both the Atom entry id and the anchor it points
   at on /changelog, so it must never be regenerated differently for an entry
   that has already been published. */
const entryId = e => (e.date + '-' + (e.site ? 'v' + e.site
  : Object.entries(e.skills).map(([slug, v]) => slug + '-' + v).join('-'))).replace(/\./g, '-');

/* The changelog is held to the same standard as the skills: the build stops
   rather than publish a record that disagrees with the files it describes. */
function loadChangelog(slugs) {
  const where = 'changelog.json';
  const entries = JSON.parse(read(where)).entries;
  if (!Array.isArray(entries) || !entries.length) fail(where + ': needs a non-empty "entries" array');

  const ids = new Set();
  let previous = null;

  entries.forEach((e, i) => {
    const at = where + ' entry ' + (i + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) fail(at + ': date must be YYYY-MM-DD');
    if (new Date(e.date + 'T00:00:00Z').toISOString().slice(0, 10) !== e.date)
      fail(at + ': ' + e.date + ' is not a real date');
    if (!e.title || typeof e.title !== 'string') fail(at + ': needs a title');
    if (!Array.isArray(e.body) || !e.body.length || e.body.some(x => typeof x !== 'string' || !x.trim()))
      fail(at + ': body must be a non-empty array of non-empty paragraphs');
    if (!e.site && !e.skills) fail(at + ': needs "site", "skills" or both — an entry with neither describes nothing');
    for (const [slug, v] of Object.entries(e.skills || {})) {
      if (!slugs.includes(slug)) fail(at + ': names "' + slug + '", which is not in the catalogue');
      if (!v || typeof v !== 'string') fail(at + ': /' + slug + ' needs a version string');
    }

    /* Newest first. Equal dates are fine — file order decides, and file order is
       what the page, the feed and the version lookups below all read. */
    if (previous && e.date > previous)
      fail(at + ': dated ' + e.date + ', which is newer than the entry above it (' + previous + ')');
    previous = e.date;

    e.id = entryId(e);
    if (ids.has(e.id)) fail(at + ': has the same feed id as an earlier entry (' + e.id + ')');
    ids.add(e.id);
  });

  const latest = entries.find(e => e.site);
  if (!latest) fail(where + ': no entry declares a "site" version, so the footer has nothing to show');
  return { entries, siteVersion: latest.site };
}

/* A skill version that moved with nothing said about it is the exact gap the
   changelog exists to close, so an unexplained bump stops the build. */
function checkSkillVersions(entries, skills) {
  for (const s of skills) {
    const said = entries.find(e => e.skills && e.skills[s.slug]);
    if (!said) fail('changelog.json: nothing mentions /' + s.slug + ' — every skill needs at least one entry');
    if (said.skills[s.slug] !== s.version)
      fail('changelog.json: the newest entry for /' + s.slug + ' says v' + said.skills[s.slug] +
        ', but skills/' + s.slug + '/SKILL.md is v' + s.version + ' — write the entry that explains the change');
  }
}

/* ------------------------------------------------------------------- data */

const cat = JSON.parse(read('skills/catalogue.json'));
const skills = cat.skills.map(loadSkill);
const changelog = loadChangelog(cat.skills);
checkSkillVersions(changelog.entries, skills);

/* ------------------------------------------------------------ page pieces */

/* Runs in <head> so an explicit choice is on <html> before the first paint.
   No stored choice means no attribute, which leaves prefers-color-scheme in charge. */
const THEME_BOOT = "try{var t=localStorage.getItem('weindie-theme');" +
  "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

const THEME_JS = `(function(){
  var btn=document.getElementById('theme');if(!btn)return;
  var root=document.documentElement, label=btn.querySelector('.vh'), t;
  function current(){
    var set=root.getAttribute('data-theme');
    if(set)return set;
    return matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
  }
  function paint(){
    var next=current()==='dark'?'light':'dark';
    var text='Switch to '+next+' theme';
    btn.setAttribute('aria-label',text);
    btn.setAttribute('title',text);
    if(label)label.textContent=text;
  }
  btn.addEventListener('click',function(){
    /* Colours only animate during the swap, so nothing pays for it while reading. */
    root.classList.add('theming');
    clearTimeout(t);t=setTimeout(function(){root.classList.remove('theming')},340);
    var next=current()==='dark'?'light':'dark';
    root.setAttribute('data-theme',next);
    try{localStorage.setItem('weindie-theme',next)}catch(e){}
    paint();
  });
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',paint);
  paint();
})();`;

const CSS = read('src/site.css');
const SKILL_JS = read('src/skill.js');
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23315c4d'/%3E%3Cpath d='M8 22L14 10M18 22l6-12' fill='none' stroke='%23fbfaf7' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E";

function head(o) {
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(o.title)}</title>
  <meta name="description" content="${esc(o.description)}">
  <link rel="canonical" href="${esc(o.url)}">
  <link rel="alternate" type="application/atom+xml" title="WeIndie changelog" href="/feed.xml">
  <link rel="icon" href="${FAVICON}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WeIndie">
  <meta property="og:title" content="${esc(o.title)}">
  <meta property="og:description" content="${esc(o.description)}">
  <meta property="og:url" content="${esc(o.url)}">
  <meta property="og:image" content="${esc(o.image)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(o.imageAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(o.title)}">
  <meta name="twitter:description" content="${esc(o.description)}">
  <meta name="twitter:image" content="${esc(o.image)}">
  <meta name="twitter:image:alt" content="${esc(o.imageAlt)}">
  <link rel="preload" href="/fonts/ibm-plex-mono-400.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/ibm-plex-mono-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/newsreader-var.woff2" as="font" type="font/woff2" crossorigin>
  <style>${CSS}</style>
  <script>${THEME_BOOT}</script>`;
}

/* Sun and moon are one shape: the orb grows and a mask circle slides in to
   bite the crescent while the rays retract. Which one shows is decided in CSS
   by the same three-state pattern as the palette, so it is correct before any
   script runs. */
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

const nav = links => `<a class="skip" href="#main">Skip to content</a>
  <header class="wrap nav">
    <a class="brand" href="/">weindie</a>
    <div class="navend">
      <nav class="navlinks">${links}</nav>
      <button class="theme" id="theme" type="button">${THEME_ICON}<span class="vh">Switch theme</span></button>
    </div>
  </header>`;

/* The second row is the door: somewhere to read the source, somewhere to say a
   skill misfired, and somewhere to write. Same register as the first row —
   monospace, quiet, plain text links. The version comes from the changelog so
   the two can never disagree. */
const FOOT_LINKS = [
  `<a href="${REPO}">Source on GitHub</a>`,
  `<a href="${ISSUES}/new">Report a problem</a>`,
  '<a href="/changelog">Changelog</a>',
  CONTACT ? `<a href="mailto:${CONTACT}">${CONTACT}</a>` : ''
].filter(Boolean).join('&nbsp;&middot; ');

const FOOTER = `<footer class="wrap"><div class="foot">\
<b>weindie</b>\
<span>Four small skills for working with AI.</span>\
<span>v${changelog.siteVersion} &middot; early and evolving</span>\
<span><a href="/LICENSE.txt">MIT licensed</a></span>\
</div><div class="foot2">${FOOT_LINKS}</div></footer>`;

/* --------------------------------------------------------- the skill page */

/* Sections are numbered because a skill page is read in order by someone who
   arrived cold: what it is, what it looks like, try it, when, install, own it. */
function block(n, name, inner) {
  return `<section class="blk" id="${name.toLowerCase().replace(/[^a-z]+/g, '-')}">
      <div class="rail">${n ? `<div class="n">&sect; ${n}</div>` : ''}<h2>${esc(name)}</h2></div>
      <div class="body">${inner}</div>
    </section>`;
}

function skillPage(s, all, label) {
  const others = all.filter(x => x.slug !== s.slug);
  const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');

  const example = `<p class="lede">${esc(s.example.caption)}</p>
        <div class="chat">${s.example.turns.map(t => {
          const isSkill = t.who.startsWith('/');
          return `<div class="msg${isSkill ? ' skill' : ''}"><div class="who">${esc(t.who)}</div><p>${esc(t.text)}</p></div>`;
        }).join('')}</div>`;

  const tryOnce = `<p class="lede">Nothing to install. Copy this into a conversation that is already underway, and see whether the idea is useful before you commit to it.</p>
        <pre class="code" id="tryPrompt">${esc(s.tryOnce)}</pre>
        <div class="btnrow"><button class="btn primary" id="copyTry">Copy prompt</button></div>
        <p class="small" style="margin-top:16px">A short, portable version. The installed skill carries the fuller behaviour &mdash; when to stay quiet, how to report, what not to flag &mdash; and neither needs your AI to be able to read this page.</p>`;

  const when = `<p class="lede"><code>/${esc(s.slug)}</code> is allowed to find nothing.</p>
        <div class="two">
          <div><h3>Useful when</h3><ul>${li(s.usefulWhen)}</ul></div>
          <div><h3>Probably not needed when</h3><ul>${li(s.notNeededWhen)}</ul></div>
        </div>`;

  const install = `<p class="lede">One canonical skill, packaged for wherever you work.</p>
        <div class="seg" id="platforms" role="group" aria-label="Environment">
          ${PLATFORMS.map((p, i) => `<button data-platform="${esc(p.id)}" aria-pressed="${i === 0}">${esc(p.name)}</button>`).join('')}
        </div>
        <div class="dest">
          <div class="label">In a project</div>
          <div class="code oneline" id="destPath"></div>
          <div id="destUserRow"><div class="label">For all your projects</div><div class="code oneline" id="destUser"></div></div>
        </div>
        <p class="small" id="platformNote" style="margin-top:14px"></p>
        <div class="btnrow">
          <button class="btn primary" id="dlCanonical">Download SKILL.md</button>
          <button class="btn" id="copyCmd">Copy install command</button>
          <a class="btn" id="docsLink" href="#" target="_blank" rel="noreferrer noopener"></a>
        </div>
        <div class="label" style="margin:18px 0 6px">Or fetch it straight into place</div>
        <div class="code oneline" id="cmd"></div>`;

  const custom = `<p class="lede">A few choices that change how <code>/${esc(s.slug)}</code> behaves. Everything here happens in this browser &mdash; nothing is sent anywhere, and nothing is saved.</p>
        <div class="resting">
          <div class="now" id="restNow"></div>
          <button class="btn primary" id="dlCustom">Download /${esc(s.slug)}</button>
        </div>
        <details class="reveal" id="optsWrap"><summary>Change the defaults</summary><div id="opts"></div></details>
        <div class="changes" id="changes"></div>
        <details class="reveal"><summary>View generated SKILL.md</summary><pre class="code" id="gen"></pre></details>
        <details class="reveal"><summary id="diffTitle">Compare with default</summary><pre class="diff" id="diff"></pre></details>`;

  const source = `<p class="lede">The whole skill, and the same file every download is built from. Nothing downloadable here should be less inspectable than the page explaining it.</p>
        <pre class="code">${esc(s.canonical)}</pre>
        <div class="btnrow"><button class="btn" id="copySource">Copy SKILL.md</button><a class="btn" href="/${esc(s.slug)}/SKILL.md">Open raw file</a></div>`;

  /* Only /spec has this so far. Its method was retired, and that method's own
     address now lands on this page \u2014 so a reader who followed the redirect
     arrives at a skill with no idea why. It is an appendix rather than a
     numbered step: the page's reading order ends at owning the file. */
  const provenance = !s.provenance ? '' : block(null, 'Where this came from',
    `${s.provenance.body.map(t => `<p class="lede">${esc(t)}</p>`).join('')}
        <div class="index">${(s.provenance.links || []).map(([href, k, q]) =>
          `<a href="${esc(href)}"><span class="k">${esc(k)}</span><span class="q">${esc(q)}</span></a>`).join('')}</div>`) + '\n    ';

  const more = `<div class="index">${others.map(o =>
          `<a href="/${o.slug}"><span class="k">/${o.slug}</span><span class="q">${esc(o.question)}</span></a>`).join('')}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  ${head({
    title: '/' + s.slug + ' — WeIndie',
    description: s.share,
    url: s.url,
    image: ORIGIN + '/og/' + s.slug + '.png',
    imageAlt: '/' + s.slug + ' — ' + s.question
  })}
</head>
<body>
  ${nav(others.map(o => `<a href="/${o.slug}">/${o.slug}</a>`).join('') + '<a href="/#skills">All skills</a>')}
  <main class="wrap" id="main">
    <div class="shead">
      <div class="stitle"><h1>/${esc(s.slug)}</h1><span class="ver">${esc(s.partOf ? s.partOf + ' skill' : label)} &middot; v${esc(s.version)}</span></div>
      <h2 class="squestion">${esc(s.question)}</h2>
      <p class="ssummary">${esc(s.summary)}</p>
      <div class="actions seg">
        <a href="#try-once">Try it once</a>
        <a href="#install">Install</a>
        <a href="#make-it-yours">Make it yours</a>
        <a href="#skill-source">SKILL.md</a>${s.provenance ? '\n        <a href="#where-this-came-from">Where this came from</a>' : ''}
      </div>
      <p class="crumbs">Sent this link by someone? <code>/${esc(s.slug)}</code> is a skill you can add to an AI tool &mdash; or just try the prompt below in a conversation you already have open.</p>
    </div>
    ${block(1, 'Example', example)}
    ${block(2, 'Try once', tryOnce)}
    ${block(3, 'When', when)}
    ${block(4, 'Install', install)}
    ${block(5, 'Make it yours', custom)}
    ${block(6, 'Skill source', source)}
    ${provenance}${block(null, 'Other skills', more)}
  </main>
  ${FOOTER}
  <script>window.SKILL=${json({
    slug: s.slug, version: s.version, source: s.source, raw: s.raw,
    canonical: s.canonical, defaultsNote: s.defaultsNote,
    tryOnce: s.tryOnce, options: s.options.map(o => ({
      id: o.id, label: o.label, help: o.help,
      choices: o.choices.map(c => ({ id: c.id, label: c.label, line: c.line, isDefault: !!c.default }))
    })), platforms: PLATFORMS
  })};</script>
  <script>${SKILL_JS}</script>
  <script>${THEME_JS}</script>
</body>
</html>
`;
}

/* ----------------------------------------------------------- link preview */
/* Cards are rendered as HTML in headless Chrome rather than hand-positioned
   SVG, so they use the site's real faces and wrap text by themselves.
   sips could not do this: it rasterises SVG with system fonts only. */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CACHE = '.cache/og';

function fontFace(family, file, weight) {
  const b64 = fs.readFileSync(path.join(ROOT, 'fonts', file)).toString('base64');
  return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${b64}) format("woff2");` +
         `font-weight:${weight};font-style:normal}`;
}
let FACES = null;
const faces = () => (FACES = FACES || [
  fontFace('IBM Plex Mono', 'ibm-plex-mono-400.woff2', 400),
  fontFace('IBM Plex Mono', 'ibm-plex-mono-500.woff2', 500),
  fontFace('Newsreader', 'newsreader-var.woff2', '400 600')
].join(''));

function card(inner) {
  return `<!doctype html><meta charset="utf-8"><style>${faces()}
  *{box-sizing:border-box;margin:0}
  html,body{width:1200px;height:630px}
  body{background:#fbfaf7;color:#16181a;display:flex;flex-direction:column;
    padding:64px 88px 48px;font-family:Newsreader,serif;
    border-top:10px solid #27705a;-webkit-font-smoothing:antialiased}
  .mono{font-family:"IBM Plex Mono",monospace}
  .eyebrow{font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:500;
    letter-spacing:.18em;text-transform:uppercase;color:#27705a}
  .slug{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:96px;
    letter-spacing:-.05em;line-height:1;margin:26px 0 0}
  h1{font-size:78px;line-height:1.06;letter-spacing:-.03em;font-weight:500;margin:22px 0 0;max-width:15em}
  .q{font-size:52px;line-height:1.12;letter-spacing:-.02em;font-weight:500;margin:24px 0 0;max-width:17em}
  .sum{font-size:26px;line-height:1.4;color:#54574f;margin:20px 0 0;max-width:36em}
  .spacer{flex:1}
  .foot{display:flex;justify-content:space-between;align-items:baseline;
    border-top:1px solid #d9d7ce;padding-top:22px}
  .foot .name{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:26px;letter-spacing:.06em;text-transform:uppercase}
  .foot .meta{font-family:"IBM Plex Mono",monospace;font-size:21px;color:#54574f}
  </style>${inner}`;
}

function ogCard(s, label) {
  return card(`<div class="eyebrow">${esc(s.partOf ? s.partOf + ' skill' : label)}</div>
  <div class="slug">/${esc(s.slug)}</div>
  <div class="q">${esc(s.question)}</div>
  <div class="sum">${esc(s.summary)}</div>
  <div class="spacer"></div>
  <div class="foot"><span class="name">weindie</span><span class="meta">weindie.com/${esc(s.slug)} &middot; v${esc(s.version)}</span></div>`);
}

function homeCard(skills) {
  return card(`<div class="eyebrow">Four small skills</div>
  <h1>Skills you can read before you run them.</h1>
  <div class="sum">Small, plain-text skills for working with AI.</div>
  <div class="spacer"></div>
  <div class="foot"><span class="name">weindie</span><span class="meta">${skills.map(s => '/' + esc(s.slug)).join(' &middot; ')}</span></div>`);
}

function renderPng(htmlPath, pngPath) {
  const png = path.join(ROOT, pngPath), html = path.join(ROOT, htmlPath);
  if (fs.existsSync(png) && fs.statSync(png).mtimeMs >= fs.statSync(html).mtimeMs) return;
  fs.mkdirSync(path.dirname(png), { recursive: true });
  try {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=1200,630',
      '--virtual-time-budget=3000', '--screenshot=' + png, 'file://' + html],
      { stdio: 'ignore' });
  } catch (e) {
    fail('could not render ' + pngPath + '.\n' +
      '  Needs Google Chrome at:\n    ' + CHROME + '\n' +
      '  The cards use the site\'s own webfonts, which an SVG rasteriser cannot see.');
  }
  if (!fs.existsSync(png)) fail('Chrome produced no file for ' + pngPath);
  console.log('  card ' + pngPath);
}

/* Generated like every other page so it cannot drift from the design tokens. */
function notFoundPage(skills) {
  return read('src/404.html')
    .replace('<!--HEAD-->', head({
      title: 'Not found — WeIndie',
      description: 'That page is not here.',
      url: ORIGIN + '/404',
      image: ORIGIN + '/og.png',
      imageAlt: 'WeIndie'
    }).replace('<meta property="og:type"', '<meta name="robots" content="noindex">\n  <meta property="og:type"'))
    .replace('<!--NAV-->', nav(skills.map(s => `<a href="/${s.slug}">/${s.slug}</a>`).join('')))
    .replace('<!--THEMEJS-->', THEME_JS)
    .replace('<!--FOOTER-->', FOOTER);
}

/* ------------------------------------------------- changelog, feed, not-built */

const skillNav = skills => nav(skills.map(s => `<a href="/${s.slug}">/${s.slug}</a>`).join(''));

/* What an entry is about, shown in the rail: a site release, or the skills it
   moved. Not uppercased like other rail headings — /SPEC is not how any skill
   is written anywhere else on the site. */
const entryTag = e => e.site ? 'v' + esc(e.site)
  : Object.entries(e.skills).map(([slug, v]) => '/' + esc(slug) + ' ' + esc(v)).join(' &middot; ');

function changelogPage(entries, skills) {
  const items = entries.map(e => `<section class="blk entry" id="${esc(e.id)}">
      <div class="rail"><div class="n">${esc(e.date)}</div><h2>${entryTag(e)}</h2></div>
      <div class="body">
        <h3>${esc(e.title)}</h3>
        <div class="prose">${e.body.map(x => `<p>${esc(x)}</p>`).join('')}</div>
      </div>
    </section>`).join('\n    ');

  return read('src/changelog.html')
    .replace('<!--HEAD-->', head({
      title: 'Changelog — WeIndie',
      description: 'What changed in the skills and the site, and when. No schedule — entries appear when something actually changes.',
      url: ORIGIN + '/changelog',
      image: ORIGIN + '/og.png',
      imageAlt: 'WeIndie — what changed, and when.'
    }))
    .replace('<!--NAV-->', skillNav(skills))
    .replace('<!--ENTRIES-->', items)
    .replace('<!--THEMEJS-->', THEME_JS)
    .replace('<!--FOOTER-->', FOOTER);
}

function notBuiltPage(skills) {
  return read('src/not-built.html')
    .replace('<!--HEAD-->', head({
      title: 'Not built — WeIndie',
      description: 'Things that were considered for WeIndie and deliberately left out, and the reason for each.',
      url: ORIGIN + '/not-built',
      image: ORIGIN + '/og.png',
      imageAlt: 'WeIndie — things considered, and deliberately left out.'
    }))
    .replace('<!--NAV-->', skillNav(skills))
    .replace('<!--REPORT-->', `<a href="${ISSUES}">the issue tracker</a>`)
    .replace('<!--THEMEJS-->', THEME_JS)
    .replace('<!--FOOTER-->', FOOTER);
}

/* Atom rather than RSS: unambiguous dates, required stable ids, and every reader
   supports it. Dates in changelog.json are days, so entries sit at midnight UTC.
   Bodies are plain paragraphs, escaped twice on purpose — once so the text is
   valid HTML, once so that HTML survives as XML character data. */
function feedXml(entries) {
  const stamp = d => d + 'T00:00:00Z';
  const entryXml = e => `  <entry>
    <title>${esc(e.title)}</title>
    <id>${ORIGIN}/changelog#${e.id}</id>
    <link rel="alternate" type="text/html" href="${ORIGIN}/changelog#${e.id}"/>
    <updated>${stamp(e.date)}</updated>
    <published>${stamp(e.date)}</published>
${Object.keys(e.skills || {}).map(slug => `    <category term="/${slug}"/>\n`).join('')}\
${e.site ? `    <category term="site"/>\n` : ''}\
    <content type="html">${esc(e.body.map(x => '<p>' + esc(x) + '</p>').join(''))}</content>
  </entry>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>WeIndie</title>
  <subtitle>What changed in the skills and the site, and when.</subtitle>
  <id>${ORIGIN}/feed.xml</id>
  <link rel="self" type="application/atom+xml" href="${ORIGIN}/feed.xml"/>
  <link rel="alternate" type="text/html" href="${ORIGIN}/changelog"/>
  <updated>${stamp(entries[0].date)}</updated>
  <author><name>WeIndie</name></author>
  <rights>MIT</rights>
${entries.map(entryXml).join('\n')}
</feed>
`;
}

/* The footer's doors, with room to say what each one is for — plus the one that
   only earns a line here: weindie is one of several things by the same author,
   and the hub is the only page that lists the others.
   Keys stay short: the index reserves 130px for them. */
const DOORS = [
  [REPO, 'Source', 'github.com/aarontaylor-dev/weindie'],
  [ISSUES + '/new', 'Report', 'A skill misfired, or a page here is wrong'],
  ['/changelog', 'Changelog', 'What changed, and when'],
  ['/not-built', 'Not built', 'What was considered and deliberately left out'],
  [HUB, 'Elsewhere', 'The rest of the work — aarontaylor.me'],
  CONTACT ? ['mailto:' + CONTACT, 'Email', CONTACT] : null
].filter(Boolean).map(([href, k, q]) =>
  `<a href="${esc(href)}"><span class="k">${esc(k)}</span><span class="q">${esc(q)}</span></a>`).join('');

function homePage(skills, cat) {
  const template = read('src/home.html');
  const index = skills.map(s =>
    `<a href="/${s.slug}"><span class="k">/${s.slug}</span><span class="q">${esc(s.question)}</span></a>`).join('');
  const choices = skills.map(s =>
    `<button data-key="${esc(s.slug)}" aria-pressed="false">${esc(s.homeLabel)}</button>`).join('');
  const data = json(skills.map(s => ({
    slug: s.slug, question: s.question, summary: s.summary, match: s.match || []
  })));
  return template
    .replace('<!--HEAD-->', head({
      title: 'WeIndie — Skills you can read before you run them',
      description: 'Small, plain-text skills for working with AI. Read the whole thing before you install it, change what you disagree with, and keep it.',
      url: ORIGIN + '/',
      image: ORIGIN + '/og.png',
      imageAlt: 'WeIndie — skills you can read before you run them.'
    }))
    .replace('<!--POSITION-->', esc(cat.position))
    .replace('<!--INDEX-->', index)
    .replace('<!--CHOICES-->', choices)
    .replace('<!--PROJECT_BLURB-->', esc(cat.blurb))
    .replace('<!--DOORS-->', DOORS)
    .replace('<!--NAV-->', nav('<a href="#skills">The skills</a><a href="#which-one">Which one</a><a href="#what-this-is">What this is</a>'))
    .replace('<!--THEMEJS-->', THEME_JS)
    .replace('<!--FOOTER-->', FOOTER)
    .replace('<!--DATA-->', data);
}

/* ------------------------------------------------------------------ main */

console.log('weindie build — ' + skills.length + ' skills, ' +
  changelog.entries.length + ' changelog entries');

for (const s of skills) {
  /* <slug>.html, not <slug>/index.html: Cloudflare Pages serves /kiss straight
     from kiss.html, where a directory would 308-redirect to /kiss/ and leave the
     address bar disagreeing with the canonical tag. The short URL is the point. */
  write(s.slug + '.html', skillPage(s, skills, cat.label));
  write(s.slug + '/SKILL.md', s.canonical);
  write(CACHE + '/' + s.slug + '.html', ogCard(s, cat.label));
  renderPng(CACHE + '/' + s.slug + '.html', 'og/' + s.slug + '.png');
  console.log('  page /' + s.slug);
}
write(CACHE + '/home.html', homeCard(skills));
renderPng(CACHE + '/home.html', 'og.png');
write('index.html', homePage(skills, cat));
write('changelog.html', changelogPage(changelog.entries, skills));
write('not-built.html', notBuiltPage(skills));
write('feed.xml', feedXml(changelog.entries));
write('404.html', notFoundPage(skills));
console.log('  page /, /changelog, /not-built, /feed.xml');
console.log('done');
