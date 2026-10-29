# Office art

The studio page's office (`worker/studio/office/office.js`) moves its robots in code: walking,
typing, carrying work, coffee. This folder holds the robots and furniture as small **three.js**
models (`models.js`). `render.mjs` photographs each model in headless Chromium into the
transparent PNGs the page loads from `worker/studio/office/art/` (listed in `manifest.json`).
It's the same approach as the Barcadia miniatures. Every picture comes from the same model, so a
robot always looks like itself, and changing a colour or a hat is a code edit plus a re-render.

What's rendered: the seven hover robots (no arms or legs; the page adds floating hands), the desk,
the coffee counter, the water cooler, the server rack, the sofa, the plant and your inbox. That's
14 PNGs, about 300 KB in total. Anything missing from the manifest stays code-drawn on the page.

## Re-render

```
cd tools/office-art
npm install
npx playwright install chromium   # skip if this machine already has Playwright's Chromium
node render.mjs                   # everything
node render.mjs scout desk        # just these
```

On Windows it renders on the discrete GPU, using the same Chromium flags as the Barcadia tools.
Anywhere else it uses Chromium's software WebGL, which is slower but gives the same pixels for
stills. Commit `worker/studio/office/art/`, then `git pull` and rebuild the worker on the VPS.

If the Chromium you want to use lives somewhere else, point `CHROMIUM_PATH` at it.

## Changing the look

- Robot colours and gear are in `CREW` at the top of `models.js`, using the same colours as the
  agents on the page. Each robot's gear (dish, pencil, headphones, clapperboard, glasses, paper
  plane, bar chart) is built a few lines below.
- The camera angle and lights are in `render.html`. Keep the angle, or the sprites won't match
  the office's front-on view.
- The size each sprite is saved at is in `render.mjs` (`ASSETS`), and where the page draws it is
  in `office.js` (`PROP_BOX`).
