# weindie

Source for [weindie.com](https://weindie.com).

WeIndie is a small independent workbench for practical AI work. The site explains
what WeIndie is, and gives each skill (`/spec`, `/drift`, `/kiss`, `/ship`) a
page you can send to someone.

The set is deliberately *not* named after one of its members, and all four are
labelled simply as WeIndie skills.

`skill.json` has an optional `partOf` field that overrides that label, for a
skill that belongs to a named method. It is currently unused. `/spec` carried
`partOf: Spec First` until that method had somewhere public to point at —
which it does not, so the label was a claim a reader could not check, and
"spec-first" already means something else in API design. The field is kept for
the day that changes; setting it is one line and the build does the rest.

## The model

    canonical skill  +  platform packaging  =  platform download
    canonical skill  +  your preferences    =  custom skill

There is exactly one version of each skill. There are no separate Claude Code,
Cursor or Codex variants — only different install paths.

## What is here

    skills/
      catalogue.json        which skills exist, in what order, and the default label
      <slug>/SKILL.md       the canonical skill — the single source of truth
      <slug>/skill.json     page content and customisation options

    changelog.json          what changed and when — also the site version

    fonts/                  self-hosted woff2 + OFL licences (no third-party requests)

    src/
      site.css              styling shared by every generated page
      home.html             homepage template
      skill.js              skill-page behaviour (copy, customise, diff, download)

      changelog.html        changelog template
      not-built.html        "what was left out" template
      404.html              not-found page template

    build.js                the generator — no dependencies

Everything else in the repository root is **generated**. Do not edit it by hand:

    index.html              homepage
    changelog.html          changelog       -> weindie.com/changelog
    not-built.html          what was left out -> weindie.com/not-built
    feed.xml                Atom feed of the changelog
    404.html                not-found page
    <slug>.html             skill page      -> weindie.com/<slug>
    <slug>/SKILL.md         raw skill       -> weindie.com/<slug>/SKILL.md
    og.png, og/<slug>.png   link-preview cards

The page is `<slug>.html` rather than `<slug>/index.html` on purpose: Cloudflare
Pages serves `/kiss` straight from `kiss.html`, where a directory would
308-redirect to `/kiss/` and leave the address bar disagreeing with the canonical
tag. These URLs get pasted into conversations, so the short form should be what
people end up on.

## Build

    node build.js

Requires Node, and Google Chrome for the link-preview cards. The cards are laid
out as HTML in `.cache/og/` and screenshotted headless at 1200x630, because they
use the site's own webfonts and an SVG rasteriser only sees system fonts. PNGs
are only re-rendered when their source HTML changes, so a normal build does no
image work.

The build refuses to run if a skill is inconsistent. It checks that:

- the `name` in SKILL.md frontmatter matches the folder name
- `metadata.source` matches the public URL
- every customisation option has exactly one default
- each default option line appears in SKILL.md **exactly once**
- no non-default option line appears in SKILL.md
- the bullets under "Defaults you can change" correspond one-to-one with the
  options in `skill.json`

That last set is what keeps customisation honest: the browser generates a custom
skill by replacing those exact lines, so if the text drifts apart the build stops
rather than silently producing a file that changes nothing.

The changelog is held to the same standard — see below.

## Adding a skill

1. `mkdir skills/<slug>` and add `SKILL.md` and `skill.json`. Copy an existing
   pair — the shapes are small and self-explanatory.
2. Add the slug to `skills/catalogue.json`.
3. `node build.js`, then commit the generated output.

Nothing assumes a particular number of skills.

## Changelog

`changelog.json` is the source for `/changelog`, `/feed.xml` **and the version
in the footer**. There is no version string anywhere else, so the footer and the
changelog cannot disagree.

    {
      "entries": [
        {
          "date": "2026-09-03",
          "site": "1.2",                    optional — a site release
          "skills": { "spec": "0.2" },      optional — skill versions this moved
          "title": "A way in",
          "body": ["one paragraph", "another"]
        }
      ]
    }

Entries are newest first, and an entry needs `site`, `skills` or both. `body` is
an array of plain paragraphs rather than Markdown, so the build stays dependency
free — same reason `skill.json` stores structured strings.

The build refuses to run unless:

- every date is a real `YYYY-MM-DD`, and no entry is newer than the one above it
- every entry has a title and at least one non-empty paragraph
- every slug named under `skills` is in the catalogue
- every skill has at least one entry, and **the newest entry naming a skill
  states that skill's current version in SKILL.md**
- no two entries produce the same feed id
- at least one entry declares a `site` version

That fourth rule is the point of the file: bump a skill's version and the build
stops until you have written what changed. The site asks people to read a file
before running it, so it owes them a way to find out when the file moved.

Feed ids are `https://weindie.com/changelog#<date>-<version>`, which is also the
anchor on the page. They are permanent — never regenerate an id for an entry that
has already been published, or every reader will show it as new.

## Frontmatter

SKILL.md frontmatter stays inside the six fields of the
[Agent Skills specification](https://agentskills.io/specification). Version and
source live in the `metadata` map so the file remains spec-valid:

    ---
    name: drift
    description: ...
    license: MIT
    metadata:
      version: "0.1"
      source: https://weindie.com/drift
    ---

A customised download adds `based_on: WeIndie /drift v0.1` to the same map.

## Local preview

    python3 -m http.server 8787

Then <http://127.0.0.1:8787/>. Locally, skill pages need the extension
(`/kiss.html`) — Cloudflare Pages resolves the extensionless `/kiss` in
production, Python's server does not.

## Type

Two self-hosted faces, latin subset, ~78 kB total:

    IBM Plex Mono   structure, labels, code, skill names
    Newsreader      questions and prose (one variable file, weights 400-600)

They are served from `/fonts/` rather than a font CDN so the site keeps making
zero third-party requests. See `fonts/README.md`.

## Theme

Light and dark, driven entirely by CSS custom properties. A small script in
`<head>` applies a stored choice before the first paint; with no stored choice
there is no `data-theme` attribute and `prefers-color-scheme` decides. Never
declare a colour inside a `@media (prefers-color-scheme)` or `[data-theme]`
block — only redefine tokens there, or the un-stamped state breaks.

There is also a print stylesheet: ink on white, panels open, controls hidden.

## Privacy

No analytics, no trackers, no third-party requests, no build-time or run-time
network calls, no cookies. Problem matching, customisation and download
generation all happen in the visitor's browser.

One thing is stored: the theme toggle writes `weindie-theme` to `localStorage`
so a chosen light or dark setting survives a reload. Nothing else is kept, and
nothing is ever sent anywhere. The claim on the site — that what you type stays
in the browser — is literally true. Keep it that way, and keep this paragraph
accurate: the whole argument here is that the claims survive inspection.

## Deployment

Production is **Cloudflare Pages**, project `weindie-site`, connected to this
repository. Pushing to `main` deploys automatically.

The Pages project kept its original name when the repository was renamed from
`weindie-site` to `weindie`. They are separate things: Pages tracks the
repository by id rather than by name, so the rename did not break the link.

    Production branch    main
    Build command        (none — generated output is committed)
    Output directory     / (repository root)
    Pages hostname       weindie-site.pages.dev
    Canonical hostname   weindie.com

Pages has no build command on purpose: the generated files are committed, so the
deployed site is exactly what is in the repository, and Pages stays a plain
static host. Run `node build.js` before committing.

`https://www.weindie.com` redirects to `https://weindie.com` with a 301 that
preserves the path and query string.

## Reporting a problem

Open an issue: <https://github.com/aarontaylor-dev/weindie/issues>.

A skill that misfired is the most useful thing to report — the site tells people
to read a file before they run it, so a file that behaves unexpectedly is a
defect in the writing, not in the reader.

## Licensing

MIT — see `LICENSE.txt`. This covers the site and the skills.

The site copy says the work can be used, changed and forked; the licence is what
makes that true rather than merely stated. Each canonical `SKILL.md` also carries
`license: MIT` in its frontmatter, so a downloaded skill states its own terms
without needing to be traced back here.

`LICENSE.txt` rather than `LICENSE` so the same file is both recognised by GitHub
and served as readable text at <https://weindie.com/LICENSE.txt>.

The copyright line names **Aaron Taylor**, so the grant has an identifiable
holder. A fork should put its own name there.
