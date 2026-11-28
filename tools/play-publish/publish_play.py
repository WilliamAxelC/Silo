#!/usr/bin/env python3
"""Upload a Silo app bundle to Google Play with the Android Publisher API (no third-party packages).

Needs a Google Cloud service account that was invited in Play Console (Users and permissions) with release rights
for Silo, and its JSON key OUTSIDE this repo, with the key file's path in SILO_PLAY_KEY. The first bundle for a new app must be uploaded by hand in Play Console; after that this works.

  python3 tools/play-publish/publish_play.py check
  python3 tools/play-publish/publish_play.py upload path/to/app.aab --notes notes.json [--track internal]
      [--status completed|draft] [--dry-run]

notes.json: {"en-US": "What's new ...", "id": "Yang baru ..."} (Play allows 500 characters per language).
--dry-run uploads into a temporary edit, validates it and throws it away, so nothing is published.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PACKAGE = 'dev.cuang.silo'
SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'
UPLOAD_API = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications'
NOTES_LIMIT = 500


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def load_key(path: str) -> dict:
    with open(path) as f:
        key = json.load(f)
    if key.get('type') != 'service_account' or 'private_key' not in key:
        sys.exit(f'{path} is not a service account key (type "service_account").')
    return key


def access_token(key: dict) -> str:
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    claims = b64url(json.dumps({
        'iss': key['client_email'], 'scope': SCOPE, 'aud': key['token_uri'], 'iat': now, 'exp': now + 3600,
    }).encode())
    signing_input = f'{header}.{claims}'.encode()
    # openssl needs the key in a file: a private temp dir, removed straight after.
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o700)
        pem = os.path.join(tmp, 'k.pem')
        fd = os.open(pem, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(key['private_key'])
        sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', pem], input=signing_input,
                             capture_output=True, check=True).stdout
    assertion = f'{header}.{claims}.{b64url(sig)}'
    body = urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                   'assertion': assertion}).encode()
    return request('POST', key['token_uri'], body, {'Content-Type': 'application/x-www-form-urlencoded'})['access_token']


def request(method, url, body=None, headers=None, token=None):
    headers = dict(headers or {})
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        try:
            detail = json.loads(detail)['error']['message']
        except Exception:
            pass
        sys.exit(f'{method} {url.split("?")[0]} failed ({e.code}): {detail}')
    return json.loads(raw) if raw else {}


def load_notes(path):
    if not path:
        return []
    with open(path) as f:
        notes = json.load(f)
    out = []
    for lang, text in notes.items():
        text = text.strip()
        if len(text) > NOTES_LIMIT:
            sys.exit(f'Release notes for {lang} are {len(text)} characters; Play allows {NOTES_LIMIT}.')
        out.append({'language': lang, 'text': text})
    return out


def cmd_check(args, token):
    edit = request('POST', f'{API}/{PACKAGE}/edits', {}, token=token)
    try:
        tracks = request('GET', f'{API}/{PACKAGE}/edits/{edit["id"]}/tracks', token=token).get('tracks', [])
        for t in tracks:
            for r in t.get('releases', []):
                print(f'{t["track"]:12} {r.get("status", ""):10} {r.get("name", "")} versionCodes={r.get("versionCodes", [])}')
        if not tracks:
            print('Access works; no releases on any track yet.')
    finally:
        request('DELETE', f'{API}/{PACKAGE}/edits/{edit["id"]}', token=token)


def cmd_upload(args, token):
    notes = load_notes(args.notes)
    edit_id = request('POST', f'{API}/{PACKAGE}/edits', {}, token=token)['id']
    committed = False
    try:
        with open(args.aab, 'rb') as f:
            data = f.read()
        print(f'Uploading {os.path.basename(args.aab)} ({len(data) / 1e6:.1f} MB)...')
        bundle = request('POST', f'{UPLOAD_API}/{PACKAGE}/edits/{edit_id}/bundles?uploadType=media', data,
                         {'Content-Type': 'application/octet-stream'}, token=token)
        code = bundle['versionCode']
        release = {'versionCodes': [str(code)], 'status': args.status}
        if args.name:
            release['name'] = args.name
        if notes:
            release['releaseNotes'] = notes
        request('PUT', f'{API}/{PACKAGE}/edits/{edit_id}/tracks/{args.track}',
                {'track': args.track, 'releases': [release]}, token=token)
        request('POST', f'{API}/{PACKAGE}/edits/{edit_id}:validate', token=token)
        if args.dry_run:
            print(f'Dry run OK: versionCode {code} would go to {args.track} as {args.status}. Nothing published.')
            return
        request('POST', f'{API}/{PACKAGE}/edits/{edit_id}:commit', token=token)
        committed = True
        print(f'Done: versionCode {code} is on the {args.track} track ({args.status}).')
    finally:
        if not committed:
            request('DELETE', f'{API}/{PACKAGE}/edits/{edit_id}', token=token)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--key', default=os.environ.get('SILO_PLAY_KEY', ''))
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check', help='check access and list the releases on each track')
    up = sub.add_parser('upload', help='upload an AAB to a track')
    up.add_argument('aab')
    up.add_argument('--track', default='internal', help='internal (default), alpha, beta or production')
    up.add_argument('--status', default='completed', choices=['completed', 'draft'],
                    help='completed rolls out on that track; draft waits for you in Play Console')
    up.add_argument('--notes', help='JSON file {"en-US": "...", "id": "..."}')
    up.add_argument('--name', help='release name shown in Play Console (default: Play picks one)')
    up.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    if not args.key or not os.path.exists(args.key):
        sys.exit('No service account key: set SILO_PLAY_KEY to the key file (kept outside the repo, mode 600).')
    if args.cmd == 'upload' and args.track == 'production' and args.status == 'completed' and not args.dry_run:
        sys.exit('Refusing to roll out straight to production: use --status draft and press Release in Play Console.')
    token = access_token(load_key(args.key))
    {'check': cmd_check, 'upload': cmd_upload}[args.cmd](args, token)


if __name__ == '__main__':
    main()
