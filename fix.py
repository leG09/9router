# -*- coding: utf-8 -*-
# Decode mojibake: the garbled Chinese was produced by reading UTF-8 bytes as
# cp1252. Reconstruct by encoding the mojibake string back to bytes with
# cp1252 (treating straight apostrophes as their cp1252 0x91 counterpart) and
# decoding those bytes as UTF-8.
import io
import re

raw = io.open('raw.txt', encoding='utf-8').read()


def fix(s: str) -> str:
    candidates = [s.replace("'", '\u2018'), s]  # smart-quote first, then raw
    best = None
    for c in candidates:
        try:
            d = c.encode('cp1252').decode('utf-8')
        except Exception:
            continue
        if '\ufffd' not in d:
            return d
        if best is None:
            best = d
    return best if best is not None else s


pat = re.compile(r'^(\s*-\s*name:\s*")(.*)("\s*)$')
out = []
mapping = []
for line in raw.split('\n'):
    m = pat.match(line)
    if m:
        fixed = fix(m.group(2))
        mapping.append((m.group(2), fixed))
        out.append(m.group(1) + fixed + m.group(3))
    else:
        out.append(line)

body = '\n'.join(out)
if raw.endswith('\n'):
    body += '\n'
io.open('proxies-fixed.yaml', 'w', encoding='utf-8', newline='').write(body)

print('=== GARBLED -> FIXED ==')
for i, (orig, fixed) in enumerate(mapping, 1):
    print(f'{i:2d}. {orig!r}  =>  {fixed}')
print()
print('=== FULL FIXED FILE ===')
print(io.open('proxies-fixed.yaml', encoding='utf-8').read())