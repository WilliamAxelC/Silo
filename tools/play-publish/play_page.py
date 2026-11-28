#!/usr/bin/env python3
"""Builds the unlisted https://cuang.dev/projects/silo/play/ page (Play Console helper) from files in this repo.

  python3 tools/play-publish/play_page.py OUT_DIR

Reads docs/play/releases.json (newest first), each release's Play notes (tools/play-publish/notes-X.json) and its
CHANGELOG.md section, plus the listing text in docs/play/listing/. OUT_DIR/screenshots/ must already hold the
screenshots. Writes OUT_DIR/index.html only; copy the release files (.aab, .apk) into OUT_DIR/releases/ yourself.
"""
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SITE = 'https://cuang.dev/projects/silo/play/'
esc = html.escape


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read().strip()


def changelog_section(version):
    text = read('CHANGELOG.md')
    m = re.search(rf'^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)', text, re.S | re.M)
    if not m:
        return ''
    out, items = [], []

    def flush():
        if items:
            out.append('<ul>' + ''.join(f'<li>{esc(i)}</li>' for i in items) + '</ul>')
            items.clear()

    for line in m.group(1).splitlines():
        if line.startswith('### '):
            flush()
            out.append(f'<p class="sub">{esc(line[4:].strip())}</p>')
        elif line.startswith('- '):
            items.append(line[2:].strip())
        elif line.startswith('  ') and items:
            items[-1] += ' ' + line.strip()
    flush()
    return '\n'.join(out)


def size(n):
    return f'{n / 1e6:.1f} MB'


def release_card(r, latest):
    notes = json.loads(read(r['notes']))
    files = []
    for kind, label in (('aab', 'Google Play bundle (.aab)'), ('apk', 'Website APK (.apk)')):
        f = r.get(kind)
        if f:
            files.append(f'<li><a href="releases/{esc(f["file"])}" download>{label}</a> · {size(f["size"])}<br>'
                         f'<code>sha256 {esc(f["sha256"])}</code></li>')
    badge = ' <span class="badge">latest</span>' if latest else ''
    return f'''<div class="card">
<h3>{esc(r["version"])} <span class="muted">(version code {r["versionCode"]}) · {esc(r["date"])}</span>{badge}</h3>
<p class="sub">Downloads</p>
<ul>{''.join(files)}</ul>
<p class="sub">What's new on Google Play (en-US, {len(notes.get("en-US", ""))}/500)</p>
<pre>{esc(notes.get("en-US", ""))}</pre>
<p class="sub">Indonesian (id, {len(notes.get("id", ""))}/500)</p>
<pre>{esc(notes.get("id", ""))}</pre>
<details><summary>Changelog</summary>
{changelog_section(r["version"])}
</details>
</div>'''


def listing_block(lang, label):
    short = read(f'docs/play/listing/short-{lang}.txt')
    full = read(f'docs/play/listing/full-{lang}.txt')
    return (f'<p class="sub">{label}: short description ({len(short)}/80)</p>\n<pre>{esc(short)}</pre>\n'
            f'<p class="sub">{label}: full description ({len(full)}/4000)</p>\n<pre>{esc(full)}</pre>\n')


def main(out_dir):
    releases = json.loads(read('docs/play/releases.json'))
    current = releases[0]
    shots = sorted(f for f in os.listdir(os.path.join(out_dir, 'screenshots')) if f.endswith('.png'))
    grid = '\n'.join(f'<a href="screenshots/{esc(s)}" download><img src="screenshots/{esc(s)}" alt="{esc(s)}" '
                     f'loading="lazy"></a>' for s in shots)
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Silo Play assets</title>
<style>
:root{{--bg:#f8fafc;--fg:#0f172a;--muted:#475569;--card:#fff;--line:#e2e8f0;--accent:#0369a1;--badge:#dcfce7;--badgefg:#166534}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--line:#1e293b;--accent:#38bdf8;--badge:#14532d;--badgefg:#bbf7d0}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
main{{max-width:960px;margin:0 auto;padding:24px 16px 64px}}
h1{{font-size:28px;margin:0 0 4px}} h2{{font-size:20px;margin:32px 0 8px}} h3{{font-size:18px;margin:0 0 8px}}
p{{color:var(--muted);margin:4px 0 12px}} a{{color:var(--accent)}} .muted{{color:var(--muted);font-weight:400;font-size:15px}}
.sub{{color:var(--fg);font-weight:600;margin:14px 0 4px}} ul{{margin:4px 0 8px;padding-left:20px}} li{{margin:4px 0}}
.badge{{background:var(--badge);color:var(--badgefg);border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}}
video{{width:100%;max-width:360px;border-radius:12px;display:block}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}}
.grid img{{width:100%;border-radius:10px;border:1px solid var(--line)}}
.fg{{width:100%;max-width:640px;border-radius:12px}} .icon{{width:96px;border-radius:20px}}
pre{{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:14px;margin:4px 0 8px}}
code{{word-break:break-all;font-size:13px}} details{{margin-top:8px}} summary{{cursor:pointer;color:var(--accent)}}
</style></head><body><main>
<h1>Silo: Google Play</h1>
<p>Current version <strong>{esc(current["version"])}</strong> (version code {current["versionCode"]}). Store listing files,
release notes, bundles and the foreground service demos. All data shown is made up.</p>

<h2>Releases</h2>
{''.join(release_card(r, i == 0) for i, r in enumerate(releases))}

<h2>Foreground service videos (FOREGROUND_SERVICE_DATA_SYNC)</h2>
<div class="card">
<p class="sub">1. Network processing, Other</p>
<p>Link: <code>{SITE}silo-fgs-datasync.mp4</code></p>
<video src="silo-fgs-datasync.mp4" controls preload="metadata" playsinline></video>
<p>Silo downloads its optional offline AI model (532 MB) only when the user taps Download Model. The download runs in a
dataSync foreground service with an ongoing progress notification (Pause, Cancel), keeps going if the user leaves the
app, checks the file (SHA-256) and stops when done.</p>
</div>
<div class="card">
<p class="sub">2. Local processing, Other</p>
<p>Link: <code>{SITE}silo-fgs-receipts.mp4</code></p>
<video src="silo-fgs-receipts.mp4" controls preload="metadata" playsinline></video>
<p>Silo reads receipt photos the user imports or scans in Receipt Inbox (text recognition and the on-device AI, all on
the phone). Reading runs in a dataSync foreground service with an ongoing "Reading receipts: n of m" notification,
keeps going if the user leaves the app, and stops when the queue is empty.</p>
</div>

<h2>Store listing text</h2>
<div class="card">
{listing_block('en', 'English (en-US)')}{listing_block('id', 'Indonesian (id)')}</div>

<h2>App icon (512 x 512)</h2>
<div class="card"><a href="icon-512.png" download><img class="icon" src="icon-512.png" alt="Silo icon"></a></div>

<h2>Feature graphic (1024 x 500)</h2>
<div class="card"><a href="feature-graphic-1024x500.png" download><img class="fg" src="feature-graphic-1024x500.png" alt="Silo feature graphic"></a></div>

<h2>Phone screenshots (1080 x 1920)</h2>
<div class="card"><p><a href="silo-play-assets.zip" download>Download icon, feature graphic and screenshots (zip)</a></p>
<div class="grid">
{grid}
</div></div>
</main></body></html>
'''
    with open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(page)
    print(f'wrote {out_dir}/index.html ({len(releases)} releases, {len(shots)} screenshots)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
