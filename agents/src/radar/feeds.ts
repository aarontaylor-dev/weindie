/* Reading public feeds.
 *
 * Deliberately small. Radar asks each source for its own feed — the file the
 * publisher put there for exactly this purpose — and reads the summary the
 * publisher wrote. It does not follow links, does not fetch article bodies, and
 * does not crawl. A site that offers a feed has said what it wants read.
 *
 * There is no XML parser here on purpose. Adding one to lift four fields out of
 * two well-known formats would be more dependency than the job is worth, and the
 * text is untrusted either way: everything below goes through sanitise().
 */

import { RADAR } from '../config';
import { sanitise } from './sanitise';

export interface FeedItem {
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  excerpt: string;
  flagged: boolean;
}

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1] : undefined;
};

const cdata = (s?: string) =>
  s === undefined ? undefined : s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();

/* Atom puts the URL in an attribute; RSS puts it in the element body. */
function linkOf(entry: string): string | undefined {
  const rss = cdata(tag(entry, 'link'));
  if (rss && /^https?:\/\//i.test(rss)) return rss;
  const atom =
    /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(entry) ??
    /<link[^>]*href=["']([^"']+)["']/i.exec(entry);
  return atom?.[1];
}

function isoOrUndefined(s?: string): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function parseFeed(xml: string, limit: number): FeedItem[] {
  const entries = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const out: FeedItem[] = [];

  for (const entry of entries.slice(0, limit)) {
    const url = linkOf(entry);
    const rawTitle = cdata(tag(entry, 'title'));
    if (!url || !rawTitle) continue;

    /* Titles are untrusted too — a feed title is a fine place to hide an
       instruction, and it is the one field that reaches a page. */
    const title = sanitise(rawTitle, 200).text;
    if (!title) continue;

    const bodyRaw =
      cdata(tag(entry, 'content:encoded')) ??
      cdata(tag(entry, 'description')) ??
      cdata(tag(entry, 'summary')) ??
      cdata(tag(entry, 'content')) ??
      '';
    const body = sanitise(bodyRaw, 1600);

    out.push({
      title,
      url,
      author: cdata(tag(entry, 'dc:creator')) ?? cdata(tag(tag(entry, 'author') ?? '', 'name')),
      publishedAt:
        isoOrUndefined(cdata(tag(entry, 'pubDate'))) ??
        isoOrUndefined(cdata(tag(entry, 'published'))) ??
        isoOrUndefined(cdata(tag(entry, 'updated'))),
      excerpt: body.text,
      flagged: body.flagged || sanitise(rawTitle, 200).flagged,
    });
  }
  return out;
}

export async function fetchFeed(feedUrl: string): Promise<{ items: FeedItem[]; status: string }> {
  try {
    const res = await fetch(feedUrl, {
      headers: { 'user-agent': RADAR.userAgent, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(RADAR.fetchTimeoutMs),
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) return { items: [], status: `http ${res.status}` };
    const xml = await res.text();
    return { items: parseFeed(xml, RADAR.maxItemsPerSource), status: 'ok' };
  } catch (e: any) {
    return { items: [], status: `error: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}
