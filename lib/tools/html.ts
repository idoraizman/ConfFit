/**
 * Links on a page that look like they lead to submission rules.
 *
 * `htmlToText` throws hrefs away, which leaves a ReAct agent standing on a
 * venue's landing page with no way to see that the rules are one click below it
 * at /author-instructions/. Search cannot always supply that URL — from a
 * datacenter the only engine that answers returns homepages — so the page's own
 * navigation is the more reliable route to it.
 */
export function guideLinks(html: string, baseUrl: string, limit = 10): string[] {
  const GUIDE = /author|instruction|guide|format|submission|submit|call.?for.?paper|cfp|camera.?ready|template/i
  const out: string[] = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < limit) {
    const href = m[1]
    if (/^(mailto|javascript|tel):/i.test(href)) continue
    const label = htmlToText(m[2])
    if (!GUIDE.test(href) && !GUIDE.test(label)) continue
    let absolute: string
    try {
      absolute = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:/i.test(absolute) || seen.has(absolute)) continue
    seen.add(absolute)
    out.push(label.trim() ? `${absolute} ("${label.trim().slice(0, 60)}")` : absolute)
  }
  return out
}

/** Minimal HTML → text extraction. Keeps CFP pages readable without a parser dep. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<h([1-6])[^>]*>/gi, '\n\n## ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
