# DPI Finder

An aim-trainer style browser test that measures how you move your mouse and recommends the DPI (and in-game sensitivity, eDPI and cm/360) you aim best with.

## How it works

1. Enter your current DPI and, optionally, the game and sensitivity you want to match.
2. The test captures your mouse (Pointer Lock, with raw input where the browser supports it) and plays a warm-up followed by rounds at five hidden sensitivities, from 60% to 165% of your current one, in random order.
3. Each round has **flicks** (click each target as fast as you can) and **tracking** (keep the crosshair on a strafing target).
4. For every round it measures:
   - Flick throughput (Fitts' law bits/second) and accuracy
   - Overshoot and undershoot of the first ballistic movement
   - Number of corrective sub-movements
   - Tracking time on target and whether you lead or trail the target
5. Flick and tracking scores are combined, a curve is fitted across the tested sensitivities, and its peak becomes the recommendation.

Everything runs in the browser; no data leaves your machine.

## Running locally

It's a static site with no build step. Serve the folder with any static server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000. Pointer Lock needs `http://localhost` or HTTPS.

## Tests

```sh
node test/analysis.test.js
```

## Deploying

The site is plain HTML, CSS and JS, so GitHub Pages serves it directly from the `main` branch root. Cloudflare Pages works the same way (no build command, output directory `/`) if you'd rather use it.

## Notes on accuracy

- Chrome and Edge support raw (unaccelerated) mouse input in Pointer Lock. Other browsers apply OS acceleration and pointer speed, so turn off "Enhance pointer precision" and keep Windows pointer speed at 6/11.
- The browser cannot read your mouse's hardware DPI, which is why the test asks for it.
