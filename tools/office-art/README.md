# Office art (run on your PC)

The studio page's office (`worker/studio/office/office.js`) draws its robots and furniture in
code. This folder makes nicer still art for them on your own GPU, once. The page keeps moving
everything in code (walking, typing, carrying work, coffee), so only the look changes. Anything
you haven't generated yet stays code-drawn, so you can do one asset at a time.

What gets made: the seven robots (as hover robots with no arms or legs; the page adds floating
hands), a desk, the coffee counter, the water cooler, the server rack, the sofa, a plant, your
inbox and the view out of the window. That's 16 PNGs, together well under 1 MB.

## How it runs

It's one Python script with no app to install. It runs **Z-Image Turbo** (Alibaba Tongyi, 6B,
Apache 2.0, so commercial use is fine) straight on the GPU through Hugging Face diffusers. To fit
in 8 GB, the transformer is loaded from a quantised GGUF file (`jayn7/Z-Image-Turbo-GGUF`, Q4_K_M,
5 GB), and model offload moves each part onto the GPU only while it is working. Each image takes
8 steps. rembg (MIT) cuts the background away on the CPU.

The first run downloads about 15 GB into the Hugging Face cache (`%USERPROFILE%\.cache\huggingface`).
To remove everything afterwards, delete that cache folder and the `.venv` folder.

## Once: set up (Windows, in this folder)

```
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -U diffusers transformers accelerate gguf huggingface_hub "rembg[cpu]" pillow
```

The RTX 50 series needs the CUDA 12.8 (`cu128`) build of torch or newer. If
`from diffusers import ZImagePipeline` fails, your diffusers is too old: run
`pip install git+https://github.com/huggingface/diffusers`.

## Make and pick

```
python generate.py make                    # 4 versions of all 16 assets
python generate.py make --only scout,desk  # just some, or more tries of one
```

Every image is saved to `out/` (git ignores that folder), and `out/pick.html` opens with all the
candidates on a checkerboard, so you can see where the background was cut away. Note the label
under the one you like for each asset, then:

```
python generate.py pick scout=3 writer=1 narrator=4 editor=2 checker=1 publisher=2 analyst=3 desk=1
```

This crops each pick, scales it to the size the page draws it at (2–3× larger, so it stays sharp
on phone screens), and writes it to `worker/studio/office/art/` along with `manifest.json`.
Commit the `art` folder, then `git pull` and rebuild the worker on the VPS. To go back to the
code-drawn version of something, delete its line from `manifest.json`.

If it runs out of GPU memory, try `--offload sequential` (slower) or `--quant Q3_K_M` (smaller).
If the output looks soft, `--quant Q6_K` is sharper.

## Changing the look

The prompts are in `assets.json`. `style` goes on every robot and prop, and `robot` is the
template for each robot, using its `color` and `gear`. Keep "plain pure white background" in the
style, because the cut-out depends on it. Z-Image Turbo runs without a negative prompt, so if a
robot comes out with arms or legs, make more candidates.
