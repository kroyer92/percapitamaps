"""Make the art for the studio page's office on your own GPU (Z-Image Turbo through diffusers).

  python generate.py make                 4 candidates of every asset -> out/, then opens out/pick.html
  python generate.py make --only scout,desk --count 6
  python generate.py pick scout=2 desk=1  copies your picks into worker/studio/office/art/ + manifest.json

The page keeps its code-drawn version of anything you have not picked, so you can do this in
parts. Setup (one venv, no other programs): see README.md.
"""
import argparse
import json
import random
import sys
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


# ---------- the model, straight on the GPU ----------
MODEL = "Tongyi-MAI/Z-Image-Turbo"     # Apache 2.0
GGUF_REPO = "jayn7/Z-Image-Turbo-GGUF"  # the same weights, quantised so they fit in 8 GB


def load_pipeline(args):
    """Z-Image Turbo through diffusers. The 6B transformer is loaded from a GGUF file (about 4 GB at
    Q4_K_M) and model offload keeps only the part that is working on the GPU, so an 8 GB card is enough."""
    import torch
    from diffusers import GGUFQuantizationConfig, ZImagePipeline, ZImageTransformer2DModel
    from huggingface_hub import hf_hub_download

    if not torch.cuda.is_available():
        sys.exit("PyTorch can't see the GPU. Install the CUDA build of torch (see README.md).")
    from huggingface_hub import list_repo_files
    match = [f for f in list_repo_files(GGUF_REPO) if f.endswith(f"{args.quant}.gguf")]
    if not match:
        sys.exit(f"No {args.quant} file in {GGUF_REPO}.")
    gguf = hf_hub_download(GGUF_REPO, match[0])
    transformer = ZImageTransformer2DModel.from_single_file(
        gguf, quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16), torch_dtype=torch.bfloat16)
    pipe = ZImagePipeline.from_pretrained(MODEL, transformer=transformer, torch_dtype=torch.bfloat16)
    if args.offload == "model":
        pipe.enable_model_cpu_offload()
    elif args.offload == "sequential":  # slowest, smallest: for when "model" still runs out of memory
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to("cuda")
    return pipe


def render(pipe, text, seed, size):
    import torch
    width, height = size
    return pipe(prompt=text, width=width, height=height, num_inference_steps=9, guidance_scale=0.0,
                generator=torch.Generator("cpu").manual_seed(seed)).images[0]


# ---------- commands ----------
def make(args):
    from rembg import new_session, remove

    cfg = load_assets()
    names = args.only.split(",") if args.only else list(cfg["assets"])
    for name in names:
        if name not in cfg["assets"]:
            sys.exit(f"Unknown asset {name!r}. Known: {', '.join(cfg['assets'])}")
    session = new_session("isnet-general-use")
    print("Loading Z-Image Turbo (the first run downloads about 15 GB)…", flush=True)
    pipe = load_pipeline(args)
    for name in names:
        a = cfg["assets"][name]
        folder = OUT / name
        folder.mkdir(parents=True, exist_ok=True)
        start = len(list(folder.glob("*-raw.png")))
        for i in range(start + 1, start + args.count + 1):
            seed = random.randint(1, 2**31)
            print(f"{name} {i}: rendering (seed {seed})", flush=True)
            img = render(pipe, prompt_for(cfg, a), seed, a["size"]).convert("RGBA")
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
    m.add_argument("--quant", default="Q4_K_M", help=f"which quantised file from {GGUF_REPO}: Q3_K_M is smaller, Q6_K sharper")
    m.add_argument("--offload", choices=["model", "sequential", "none"], default="model")
    m.add_argument("--no-open", action="store_true")
    k = sub.add_parser("pick", help="copy picked candidates into the studio page")
    k.add_argument("choices", nargs="+", metavar="asset=N")
    args = p.parse_args()
    make(args) if args.cmd == "make" else pick(args)


if __name__ == "__main__":
    main()
