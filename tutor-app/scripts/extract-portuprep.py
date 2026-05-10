import html
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
src = root / "как на счет сделать свой софт для подготовки к португальскому.html"
s = src.read_text(encoding="utf-8", errors="replace")
parts = re.split(r'<span class="token token triple-quoted-string"[^>]*>', s)
chunks: list[str] = []
for part in parts[1:]:
    i = part.find("</span>")
    if i >= 0:
        chunks.append(part[:i])
raw = "".join(chunks)
raw_u = html.unescape(raw)
start = raw_u.find("<!DOCTYPE")
if start < 0:
    raise SystemExit(f"no DOCTYPE in unescaped, len={len(raw_u)}")
end = raw_u.rfind("</html>")
if end < start:
    raise SystemExit("no </html>")
doc = raw_u[start : end + 7]
out = Path(__file__).resolve().parents[1] / "public" / "portuprep-extracted.html"
out.write_text(doc, encoding="utf-8")
print(f"Wrote {out} ({len(doc)} chars)")
