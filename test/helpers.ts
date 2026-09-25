/** Shared test helpers (no dependencies). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/**
 * Minimal XML well-formedness check: balanced tags, quoted attributes, no raw
 * `&` or `<` in text. Enough to catch every bug class an SVG generator makes.
 */
export function assertWellFormedXml(xml: string, label = "xml"): void {
  const stack: string[] = [];
  let i = 0;
  const body = xml.replace(/<\?xml[^>]*\?>/, "");
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    i++;
    if (m[0].startsWith("<!--") || m[0].startsWith("<![CDATA[")) continue;
    if (m[6]) assert.fail(`${label}: stray '<' or malformed tag near: ${body.slice(m.index, m.index + 80)}`);
    if (m[5] !== undefined) {
      const text = m[5];
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text), `${label}: unescaped & in text: ${text.slice(0, 60)}`);
      continue;
    }
    const [, close, name, attrs, selfClose] = m;
    if (attrs && /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(attrs)) assert.fail(`${label}: unescaped & in attributes of <${name}>`);
    if (close) {
      assert.equal(stack.pop(), name, `${label}: mismatched </${name}>`);
    } else if (!selfClose) {
      stack.push(name!);
    }
  }
  assert.equal(stack.length, 0, `${label}: unclosed <${stack.join("><")}>`);
  assert.ok(i > 0, `${label}: empty document`);
}

export function hasBinary(bin: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [bin]).status === 0;
}

/** Render an SVG with rsvg-convert (if installed) and return the PNG size in bytes. */
export function rsvgRender(svgPath: string, pngPath: string): number | null {
  if (!hasBinary("rsvg-convert")) return null;
  const r = spawnSync("rsvg-convert", ["-w", "320", "-o", pngPath, svgPath]);
  assert.equal(r.status, 0, `rsvg-convert failed for ${svgPath}: ${r.stderr?.toString()}`);
  return spawnSync("stat", ["-c", "%s", pngPath]).stdout ? Number(spawnSync("stat", ["-c", "%s", pngPath]).stdout.toString().trim()) : 0;
}
