"""Kokoro text-to-speech. Reads a JSON job on stdin, writes one WAV per item, prints durations."""
import json, os, sys, urllib.request

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def ensure_models(models_dir):
    os.makedirs(models_dir, exist_ok=True)
    for name in FILES:
        path = os.path.join(models_dir, name)
        if not os.path.exists(path):
            tmp = path + ".part"
            urllib.request.urlretrieve(BASE + name, tmp)
            os.replace(tmp, path)
    return [os.path.join(models_dir, n) for n in FILES]


def trim(samples, rate, threshold=0.01, keep=0.04):
    """Cut the silence Kokoro leaves at both ends, keeping a few milliseconds."""
    loud = np.where(np.abs(samples) > threshold)[0]
    if not len(loud):
        return samples
    pad = int(keep * rate)
    return samples[max(0, loud[0] - pad): min(len(samples), loud[-1] + pad)]


def main():
    job = json.load(sys.stdin)
    model, voices = ensure_models(job["models_dir"])
    kokoro = Kokoro(model, voices)
    if job.get("list_voices"):
        print(json.dumps({"voices": sorted(kokoro.get_voices())}))
        return
    out = []
    for item in job["items"]:
        samples, rate = kokoro.create(item["text"], voice=job["voice"], speed=job.get("speed", 1.0), lang="en-us")
        samples = trim(samples, rate)
        path = os.path.join(job["outdir"], item["id"] + ".wav")
        sf.write(path, samples, rate)
        out.append({"id": item["id"], "path": path, "seconds": len(samples) / rate})
    print(json.dumps({"items": out}))


if __name__ == "__main__":
    main()
