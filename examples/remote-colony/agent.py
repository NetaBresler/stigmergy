#!/usr/bin/env python3
"""agent.py — a Stigmergy agent in ~70 lines of Python standard library.

    STIGMERGY_URL=http://127.0.0.1:8787 \\
    STIGMERGY_TOKEN=stg_... \\
    python3 examples/remote-colony/agent.py

There is no Stigmergy Python package. There doesn't need to be: the colony is
reachable over plain JSON-HTTP, so an agent in any language is a few requests.
This one enacts the Triager role. Point it at a triager token and it competes
for claims against the TypeScript triager exactly the same way — the medium
doesn't know or care what language deposited a signal.
"""

import json
import os
import time
import urllib.request
import urllib.error

URL = os.environ.get("STIGMERGY_URL", "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("STIGMERGY_TOKEN")
if not TOKEN:
    raise SystemExit("Set STIGMERGY_TOKEN (printed by server.ts on startup).")


def call(route, body):
    """POST {body} to /v1{route}; return the parsed JSON response."""
    req = urllib.request.Request(
        f"{URL}/v1{route}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = json.loads(err.read().decode("utf-8")).get("error", {})
        raise SystemExit(f"{err.code} {detail.get('code')}: {detail.get('message')}")


def main():
    session = call("/session", {})
    roles = [r["name"] for r in session["roles"]]
    print(f"connected as {session['agentId']} — roles: {', '.join(roles)}")
    if "Triager" not in roles:
        raise SystemExit("This Python agent enacts the Triager role; hand it a triager token.")

    while True:
        queue = call("/view", {"role": "Triager"})["signals"]
        if not queue:
            time.sleep(1.0)
            continue

        target = queue[0]
        claimed = call("/claim", {"role": "Triager", "signalId": target["id"], "until": "2m"})
        if not claimed["claimed"]:
            continue  # another triager won the race

        payload = target["payload"]
        # Postgres numeric columns arrive as strings on the wire (same as the
        # in-process API, where JS would coerce them silently). Coerce here.
        title, severity = payload["title"], int(payload["severity"])
        verdict = "invalid" if "typo" in title else "duplicate" if severity == 3 else "confirm"
        boost = 4 - severity if verdict == "confirm" else 0

        strength = target.get("strength", 0.0)
        print(f"[{session['agentId']}] {verdict:<9} \"{title}\" (strength {strength:.2f})")
        call("/deposit", {
            "role": "Triager",
            "type": "triage_note",
            "payload": {
                "bug_id": target["id"],
                "bug_title": title,
                "verdict": verdict,
                "body": f"auto-triage by {session['agentId']} (python)",
                "recommended_boost": boost,
            },
        })
        time.sleep(1.0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
