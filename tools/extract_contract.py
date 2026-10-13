#!/usr/bin/env python3
"""Copy the example payloads from server/API.md into the Swift contract-test fixtures.

Usage: python3 -I tools/extract_contract.py server/API.md app/Packages/FeastCore/Tests/FeastCoreTests/Contract
"""
import json
import re
import sys


def main(api_md: str, out_dir: str) -> int:
    blocks = re.findall(r"```json\n(.*?)```", open(api_md, encoding="utf-8").read(), re.S)
    parsed = []
    for b in blocks:
        try:
            parsed.append(json.loads(b))
        except json.JSONDecodeError:
            pass

    def find(pred, name):
        for j in parsed:
            if isinstance(j, dict) and pred(j):
                return j
        raise SystemExit(f"API.md has no example for {name}")

    home = find(lambda j: "server_now" in j and "today" in j, "home")
    fixtures = {
        "home": home,
        "history": find(lambda j: "days" in j, "history"),
        "sessions": {**find(lambda j: "results" in j, "sessions"), "home": home},
        "register": find(lambda j: "token_expires_at" in j, "register"),
        "dev_alarm": find(lambda j: "fire_at" in j and "window_start" in j, "dev_alarm"),
    }
    for name, obj in fixtures.items():
        with open(f"{out_dir}/{name}.json", "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1)
    print(f"Wrote {len(fixtures)} contract fixtures to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
