"""Make the art for the studio page's office on your own GPU, through a local ComfyUI.

  python generate.py make                 4 candidates of every asset -> out/, then opens out/pick.html
  python generate.py make --only scout,desk --count 6
  python generate.py pick scout=2 desk=1  copies your picks into worker/studio/office/art/ + manifest.json

The page keeps its code-drawn version of anything you have not picked, so you can do this in
parts. Needs ComfyUI running (default http://127.0.0.1:8188) and: pip install "rembg[cpu]" pillow
"""
import argparse
import json
import random
import sys
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
ART = HERE.parent.parent / "worker" / "studio" / "office" / "art"


def load_assets():
    return json.loads((HERE / "assets.json").read_text(encoding="utf-8"))


def prompt_for(cfg, a):
    body = cfg["robot"].format(color=a["color"], gear=a["gear"]) if a["kind"] == "robot" else a["prompt"]
    return body if a["kind"] == "view" else f'{body}, {cfg["style"]}'


# ---------- ComfyUI ----------
def call(server, path, body=None):
    req = urllib.request.Request(server + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def patch(workflow, text, negative, seed, size):
    """Fill in prompt, seed and size, found through the KSampler so an exported workflow works too."""
    wf = json.loads(json.dumps(workflow))
    ks = next((n for n in wf.values() if n["class_type"].startswith("KSampler")), None)
    if not ks:
        sys.exit("The workflow has no KSampler node.")
    ks["inputs"]["seed"] = seed
    wf[ks["inputs"]["positive"][0]]["inputs"]["text"] = text
    neg = ks["inputs"].get("negative")
    if neg and "text" in wf[neg[0]]["inputs"]:
        wf[neg[0]]["inputs"]["text"] = negative
    latent = wf[ks["inputs"]["latent_image"][0]]["inputs"]
    latent["width"], latent["height"] = size
    return wf


def render(server, wf):
    client = str(uuid.uuid4())
    pid = json.loads(call(server, "/prompt", {"prompt": wf, "client_id": client}))["prompt_id"]
    for _ in range(600):  # 10 minutes; Z-Image Turbo takes seconds once loaded
        hist = json.loads(call(server, f"/history/{pid}"))
        if pid in hist:
            entry = hist[pid]
            if entry.get("status", {}).get("status_str") == "error":
                sys.exit(f"ComfyUI reported an error: {json.dumps(entry['status'].get('messages', []))[:800]}")
            for out in entry["outputs"].values():
                for img in out.get("images", []):
                    q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
                    return call(server, f"/view?{q}")
        time.sleep(1)
    sys.exit("ComfyUI did not finish within 10 minutes.")


# ---------- commands ----------
def make(args):
    from io import BytesIO
    from PIL import Image
    from rembg import new_session, remove

    cfg = load_assets()
    workflow = json.loads(Path(args.workflow).read_text(encoding="utf-8"))
    names = args.only.split(",") if args.only else list(cfg["assets"])
    try:
        call(args.server, "/system_stats")
    except OSError:
        sys.exit(f"Can't reach ComfyUI at {args.server}. Start it first (see README.md).")
    session = new_session("isnet-general-use")
    for name in names:
        a = cfg["assets"].get(name) or sys.exit(f"Unknown asset {name!r}. Known: {', '.join(cfg['assets'])}")
        folder = OUT / name
        folder.mkdir(parents=True, exist_ok=True)
        start = len(list(folder.glob("*-raw.png")))
        for i in range(start + 1, start + args.count + 1):
            seed = random.randint(1, 2**31)
            print(f"{name} {i}: rendering (seed {seed})", flush=True)
            png = render(args.server, patch(workflow, prompt_for(cfg, a), cfg["negative"], seed, a["size"]))
            img = Image.open(BytesIO(png)).convert("RGBA")
            img.save(folder / f"{i}-raw.png")
            if a["kind"] != "view":
                img = remove(img, session=session)
            img.save(folder / f"{i}.png")
    sheet()
    print(f"\nPick your favourites in {OUT / 'pick.html'}, then run: python generate.py pick scout=1 desk=2 ...")
    if not args.no_open:
        webbrowser.open((OUT / "pick.html").as_uri())


def sheet():
    cfg = load_assets()
    rows = []
    for name in cfg["assets"]:
        files = sorted((OUT / name).glob("[0-9]*.png"), key=lambda p: p.name) if (OUT / name).exists() else []
        files = [f for f in files if not f.stem.endswith("-raw")]
        if files:
            cells = "".join(f'<figure><img src="{name}/{f.name}"><figcaption>{name}={f.stem}</figcaption></figure>' for f in files)
            rows.append(f"<h2>{name}</h2><div class=row>{cells}</div>")
    (OUT / "pick.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Office art: pick</title><style>"
        "body{font:15px system-ui;margin:24px;background:#eef2f6}h2{margin:24px 0 8px}.row{display:flex;flex-wrap:wrap;gap:12px}"
        "figure{margin:0;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px;padding:8px;border-radius:8px}"
        "img{display:block;max-height:220px;max-width:320px}figcaption{font:600 13px monospace;margin-top:6px;background:#fff;padding:2px 4px}"
        "</style><h1>Pick one per asset</h1><p>Then run <code>python generate.py pick scout=2 desk=1 ...</code> with the labels under the images. "
        "Not happy with any? <code>python generate.py make --only scout</code> adds more.</p>" + "".join(rows),
        encoding="utf-8")


def pick(args):
    from PIL import Image

    cfg = load_assets()
    ART.mkdir(parents=True, exist_ok=True)
    manifest_path = ART / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"robots": {}, "props": {}}
    for choice in args.choices:
        name, _, n = choice.partition("=")
        a = cfg["assets"].get(name) or sys.exit(f"Unknown asset {name!r}")
        src = OUT / name / f"{n}.png"
        if not src.exists():
            sys.exit(f"No candidate {src}")
        img = Image.open(src).convert("RGBA")
        if a["kind"] != "view":
            box = img.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
            img = img.crop(box) if box else img
        img.thumbnail(tuple(a["out"]), Image.LANCZOS)
        filename = f"robot-{name}.png" if a["kind"] == "robot" else f"{name}.png"
        img.save(ART / filename, optimize=True)
        manifest["robots" if a["kind"] == "robot" else "props"][name] = filename
        print(f"{name}: {src.name} -> worker/studio/office/art/{filename} ({img.width}x{img.height})")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("\nCheck it locally by opening the studio page with ?demo, then commit worker/studio/office/art/.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make", help="render candidates in ComfyUI")
    m.add_argument("--only", help="comma-separated assets, e.g. scout,writer,desk")
    m.add_argument("--count", type=int, default=4)
    m.add_argument("--server", default="http://127.0.0.1:8188")
    m.add_argument("--workflow", default=str(HERE / "workflow_api.json"), help="a ComfyUI workflow saved with Export (API)")
    m.add_argument("--no-open", action="store_true")
    k = sub.add_parser("pick", help="copy picked candidates into the studio page")
    k.add_argument("choices", nargs="+", metavar="asset=N")
    args = p.parse_args()
    make(args) if args.cmd == "make" else pick(args)


if __name__ == "__main__":
    main()
