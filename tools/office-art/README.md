# Office art (run on your PC)

The studio page's office (`worker/studio/office/office.js`) draws its robots and furniture in
code. This folder makes nicer still art for them on your own GPU, once. The page keeps moving
everything in code (walking, typing, carrying work, coffee), so only the look changes. Anything
you haven't generated yet stays code-drawn, so you can do one asset at a time.

What gets made: the seven robots (as hover robots with no arms or legs; the page adds floating
hands), a desk, the coffee counter, the water cooler, the server rack, the sofa, a plant, your
inbox and the view out of the window. That's 16 PNGs, together well under 1 MB.

## Model

**Z-Image Turbo** (Alibaba Tongyi, 6B, Apache 2.0, so commercial use is fine), in ComfyUI.
It needs 8 steps, which takes a few seconds per image on an RTX 5060 once the model is loaded.
`workflow_api.json` loads the weights as fp8 (`weight_dtype: fp8_e4m3fn`), so the model fits in
8 GB. Background removal uses rembg (MIT) with the `isnet-general-use` model, on the CPU.

## Once: install

1. Install ComfyUI. On Windows, the portable build or ComfyUI Desktop from comfy.org both work.
   Start it.
2. In ComfyUI, open **Workflow → Browse Templates**, choose **Z-Image Turbo** and let it download
   the missing models. It puts three files in the right folders:
   `models/diffusion_models/z_image_turbo_bf16.safetensors`,
   `models/text_encoders/qwen_3_4b.safetensors` and `models/vae/ae.safetensors`.
   Press Run once to check it makes an image.
3. In a terminal, in this folder: `pip install "rembg[cpu]" pillow`

If your files have other names (for example a ready-made fp8 or GGUF build), either edit the three
file names in `workflow_api.json`, or open your working workflow in ComfyUI and use
**Workflow → Export (API)**. Then pass that file with `--workflow my_workflow.json`. The script
finds the prompt, seed and size through the KSampler node, so any normal text-to-image workflow
works.

If ComfyUI runs out of memory, restart it with `--lowvram`.

## Every time you want new art

```
python generate.py make                    # 4 candidates of all 16 assets, about 5 minutes
python generate.py make --only scout,desk  # just some, or more tries of one
```

Every image is saved to `out/` (git ignores that folder), and `out/pick.html` opens with all the
candidates on a checkerboard, so you can see where the background was cut away. Note the label
under the one you like for each asset, then:

```
python generate.py pick scout=3 writer=1 narrator=4 editor=2 checker=1 publisher=2 analyst=3 desk=1
```

This crops each pick, scales it to the size the page draws it at (2–3× larger, so it stays sharp on phone screens),
and writes it to `worker/studio/office/art/` along with `manifest.json`. To check the result,
open the page with `?demo`, or run the worker locally. Commit the `art` folder, then
`git pull` and rebuild the worker on the VPS.

To go back to the code-drawn version of something, delete its line from `manifest.json`.

## Changing the look

The prompts are in `assets.json`. `style` goes on every robot and prop, and `robot` is the
template for each robot, using its `color` and `gear`. Keep "plain pure white background" in the
style, because the cut-out depends on it. If the robots come out with arms or legs, run more
candidates; the negative prompt does little at Z-Image Turbo's cfg 1.
