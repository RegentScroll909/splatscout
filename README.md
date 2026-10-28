# SplatScout — AR capture coach for Gaussian splats

SplatScout is a phone app (a web app you install from Chrome, with no app store) that helps you capture
building interiors well enough to make **clean Gaussian splats**. While you scan, it:

- **Guides you around the space in AR**: you mark the scan area by tapping its corners on the floor, then
  each pass draws a path on the floor and an arrow under the centre cross gives one instruction at a time:
  walk to the path, turn or tilt the phone ("Turn right 40°", "Tilt up 20°"), then sidestep along it. It only
  ever points ahead (no shuffling back and forth in corners), takes the photo when you stand on a spot, and
  skips spots that can't be reached. The last pass sends you to the spots that still need angles.
- **Keeps its place in your scan (2.1, 2.2)**: when tracking is lost, the position jumps, or the AR session
  stops (screen off, app closed, another day), the next view is matched against the surfaces already scanned,
  so the scan area, coverage and path come back instead of starting over. Along a hallway, where plain walls
  fit anywhere, the camera image is compared with your earlier photos (signs, posters, door numbers) to tell
  where along it you are. If it takes a while, tap your spot on the map; or fine-tune by hand, or start a new
  map if a room has changed.
- **Scan bounds (2.0, 2.2)**: only what's inside the outline counts (half a hallway, one end of a lobby), and
  you can tap Skip to leave out spots you can't capture well, like windows and mirrors. SplatStation crops the
  finished splat to the same outline. A rough rectangle is enough: the path keeps clear of the walls the
  phone finds, so corners can sit inside a wall (around a hallway's door recesses, say) and spots behind a
  wall drop out.
- **Paints coverage onto the real surfaces in AR**: red = captured from 1 angle, amber = 2, green = 3+.
  Dots sit on the actual surfaces and hide behind furniture and walls; depth noise floating in mid-air is
  filtered out and carved away.
- **Takes the photos for you, while you walk.** It keeps the sharpest frame of each stretch once you've
  moved far enough for good overlap, without making you stop, and skips blurry, dark and duplicate frames.
- **Coaches you live**, one instruction at a time: slow down, you're turning in place, too close, blank
  wall, window blowing out, tracking lost, gap in overlap, wrong height for this pass… Optional voice coaching.
- **Walks you through a capture plan** for the type of space (room, hallway, large hall, stairwell,
  object, freestyle), pass by pass (eye level, overhead, low, cross, details), with progress for each pass.
- **Points you at what's missing** with an AR beacon and the centre arrow, and shows a live floor-plan map
  with the scan area and the path.
- **Grades the capture (A–F) before you leave the room**, with concrete fixes ("23% of surfaces were seen
  from one angle — walk the red areas"; "4 photos are soft — remove them").
- **Exports a ZIP** of sharp, well-spaced photos for your splat pipeline, and you choose what goes in it
  (leave out blurry photos, a pass, or a separate AR map). AR mode also includes the camera poses
  (Nerfstudio `transforms.json` and a COLMAP text model) and a coloured depth point cloud.

Two capture engines:

| | **AR mode** (Android + Chrome, e.g. Pixel) | **Camera mode** (iPhone, any phone) |
|---|---|---|
| Tracking | Full 3D position (ARCore via WebXR) | Orientation only (motion sensors) |
| Coverage | Real surfaces via ARCore depth, from how many angles | View directions around you, from how many spots |
| Parallax check | Exact (metres moved) | Estimated from image motion vs. gyro |
| Photo size | AR camera stream (usually ~1920 px long side) | Full camera stream (up to 4K) |
| Extras in export | Camera poses + depth point cloud | — |

There's also a **Practice room**: a virtual classroom that runs the full pipeline on a laptop or phone,
so club members can learn the technique before scanning a real building.

The repo also contains **SplatStation** ([`station/`](station/)), the PC side. It turns SplatScout exports
(or plain phone videos) into finished Gaussian splats on your NVIDIA GPU, with no Python and no cloud.
See [SplatStation](#splatstation-turn-captures-into-splats-on-your-pc) below.

---

## 1. Put it on your phone

**Live app: https://regentscroll909.github.io/splatscout/**. Open it in Chrome on your phone, then use
Chrome menu → *Add to Home screen / Install app*. Every push to `main` redeploys it automatically
(see [`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

The app is plain static files in [`app/`](app/), with no build step. Cameras and AR need **HTTPS**, so if you want
your own copy, host it somewhere that serves HTTPS:

**Option A: Netlify Drop (2 minutes, no account setup beyond sign-in)**
1. Go to app.netlify.com/drop and drag the **`app` folder** onto the page.
2. Open the `https://….netlify.app` link on your Pixel in **Chrome**.

**Option B: GitHub Pages (best for the club)**
1. Create a GitHub repo and upload the *contents* of `app/` to its root (`index.html` at the top level).
2. Repo → Settings → Pages → *Deploy from a branch* → `main` / root.
3. Share `https://<you>.github.io/<repo>/` with the club.

Then, on the phone: Chrome menu → **Add to Home screen / Install app**. It works offline afterwards
(handy in basements). When you publish an update, bump `CACHE` in [`app/sw.js`](app/sw.js) so phones refresh.

**Option C: test straight from this PC over USB** (no hosting needed)
```bash
npm start
```
```bash
adb reverse tcp:8080 tcp:8080
```
Then open `http://localhost:8080` in Chrome on the phone. Over USB it counts as `localhost`, which the
browser treats as secure.

**Phone requirements for AR mode:** Chrome on Android with *Google Play Services for AR* installed (preinstalled
on Pixels). The first time, allow the camera and the AR prompt. If AR isn't available, the app switches to Camera
mode automatically.

## 2. Capture

1. **New capture** → building, room, type of space → AR tracked → tick the pre-flight checklist.
2. **Start AR capture**, then **mark the scan area**: aim the centre cross at the floor in each corner and tap
   **Corner** (or tap the spot on screen), then **Done**. *Skip* scans without an outline. A rough rectangle
   is fine: in a hallway, mark it out to the back of the door recesses; the path keeps clear of the walls.
3. **Follow the arrow** under the centre cross at a slow, steady walk. Photos are automatic and you don't need
   to stop. Each pass moves on to the next by itself.
4. **Fill the gaps**: the last pass puts a ring on the floor where to stand and a ring on the surface to aim at.
   The capture is complete at about **Area 85%**. Use **Skip** (left) for windows, mirrors or unreachable corners.
5. If **Re-aligning** appears (tracking was lost), sweep the phone over something you scanned before until it
   says *Found it*. In a hallway, aim at something that only appears once (a sign, a poster, a door number).
   If it takes a while, tap **Show me on the map** and tap where you're standing. To continue another time:
   **Capture more → Continue in AR**.
6. **Done** grades the capture on the spot: *Keep capturing* or *Finish & review*.
7. In Review: check the fixes, then **Export**, choose what to include, and **Save ZIP**.

The in-app **Capture guide** is the full field manual: golden rules, technique for each type of space,
lighting, tricky surfaces, and a "splat symptom → capture fix" table.

## 3. Use the export in your pipeline

```
Building_Room_YYYYMMDD/
  images/0001.jpg …            ← point your splat pipeline here
  splatscout.json              per-photo metrics, flags, poses, capture metadata, scan area ("bounds")
  poses/transforms.json        AR camera poses (Nerfstudio / Instant-NGP, OpenGL convention)
  poses/colmap/sparse/0/       same poses as a COLMAP text model (cameras/images/points3D + rigs/frames)
  poses/points.ply             coloured AR depth points on confirmed surfaces inside the scan area
  coverage.png, README.txt
```

- The photos are already sharp, well-spaced keyframes, so skip any "extract frames from video" step. Treat them as a
  single camera (`--ImageReader.single_camera 1` in COLMAP).
- If your pipeline only takes video:
  ```bash
  ffmpeg -framerate 4 -i images/%04d.jpg -c:v libx264 -crf 14 -pix_fmt yuv420p capture.mp4
  ```
- `bounds` in `splatscout.json` is the scan area in the pose coordinates: a floor polygon `[[x, z], …]` at
  `floorY` (y up, metres). Crop your trained splat to it to drop floaters outside the area.
- The AR poses are optional. They are phone tracking (centimetre-level drift), useful to seed or check
  reconstruction of plain-walled rooms where SfM struggles. The COLMAP model loads directly in COLMAP 4.x
  (`model_analyzer`, `point_triangulator`, …).

## SplatStation: turn captures into splats on your PC

SplatStation runs on the PC with the GPU. It collects your captures, and turns the ones you choose into
finished Gaussian splats:

```
SplatScout ZIP  ─┐                        ┌─ COLMAP 4 (GPU SIFT + matching)
phone video     ─┼─► inbox / upload / USB ─┤   • AR poses → triangulate + bundle-adjust (fast, robust)
                 │                        │   • no poses → global SfM, moved into the AR frame when the phone had poses
                 │                        └─ Brush (trains the splat on the GPU) ─► library/<Building>/<Room>/<date>/scene.ply
```

With a SplatScout 2.0 capture that has a scan area, the finished splat is **cropped to that outline** (plus 0.5 m),
which removes floaters seen through windows or past the area. The uncropped splat stays in the job folder.
Turn it off on the dashboard (*Crop splats to the scan area*).

**Start it:** double-click **`start-station.cmd`** (or run `node station/station.mjs`), then open
**http://localhost:8787**. The dashboard shows captures ready to process, the queue, a progress bar for each stage,
live GPU load and VRAM, a library of finished splats, and a 3D viewer.

**You decide what runs.** New captures land in *Ready to process* with their photo count, grade and scan area.
Pick the quality, whether to use the phone's AR positions and whether to crop, then press **Process**. Queued jobs
can be held or moved to the front, and *Pause after the current job* stops the queue. To have everything start by
itself instead, tick *Process new captures by themselves* under Defaults.

**Get captures in, any of these ways:**
- **USB (easiest with your Pixel):** plug the phone in. The SplatScout exports in the phone's *Download* folder are
  listed under *Phone over USB*; tick the ones you want and press **Import** (needs USB debugging on; uses `adb`).
  *Copy new exports from the phone by themselves* under Defaults brings back automatic import.
- **Drag and drop** a ZIP or video onto the dashboard (tick *Start processing as soon as they arrive* to skip the
  Process step).
- **From the phone over Wi-Fi:** open the "From a phone on the same Wi-Fi" address shown on the dashboard and
  upload. Put that address in SplatScout → Settings → *SplatStation address* to get an "Open SplatStation" button
  after each export. Campus Wi-Fi often blocks phone-to-PC traffic; use USB there.
- **Copy files** into `%USERPROFILE%\SplatStation\inbox`.

**Quality presets** (choose on the dashboard; you can re-train any finished job with a different preset):

| Preset | Steps | Training resolution | Use it for |
|---|---|---|---|
| Quick preview | 7,000 | 1280 px | Checking a capture right after you scan it |
| Standard | 30,000 | 1920 px | Normal archive quality |
| High | 50,000 | 2560 px | Showcase scenes, 4K camera-mode captures |

On the RTX 5080, the practice room (309 photos) took **2 min 19 s end to end on Quick**: about 80 s for the camera
solve and 58 s of training. Training time grows roughly with the step count; the dashboard shows a live estimate.

**Output:** `%USERPROFILE%\SplatStation\library\<Building>\<Room>\<date>\` contains `scene.ply` (standard 3DGS
format, works in SuperSplat, Postshot, Unity/Unreal plugins and the web viewers), `info.json` (photos, camera-solve
quality, training stats, capture grade) and `thumb.jpg`. Click **View** for the built-in viewer, or **Edit in
SuperSplat** to crop and clean floaters.

**Walk through it.** In the viewer, press **🚶 Walk** to explore the splat in first person, at the height the phone
was held. Use W A S D (or ↑ ↓, with ← → to turn), click the scene and move the mouse to look around, hold Shift to
hurry, press G for ghost mode (fly through walls; G again lands you on the floor) and M to hide the mini-map; click
the mini-map to jump somewhere. On a phone or tablet the left thumb walks and the right thumb looks. Walls,
furniture and the edge of the scanned floor stop you, and you slide along them instead of sticking. SplatStation
works this out from the splat itself: it finds the floor below where the phone went, treats solid splats between
knee and head height as walls and furniture, and keeps you where it saw floor and inside the scan area. Plain
white walls are often too faint to block on their own, but the scanned floor stops at them, so they hold you in
too. The map is saved next to the splat (`scene.walk.json`) the first time it's needed. Splats from a video have
no real-world size, so their walking height assumes the phone was held 1.5 m up.

**What it needs:** an NVIDIA GPU, plus the following, all found automatically. Paths can be changed in
`%USERPROFILE%\SplatStation\station.config.json`.
- COLMAP 4.x with CUDA (`C:\Tools\COLMAP`).
- Brush v0.3 (`C:\Tools\Brush\brush_app.exe`, from github.com/ArthurBrussee/brush releases).
- ffmpeg (video input only).
- adb (USB import only).

## 4. What was tested, and what still needs your Pixel

Tested on this PC:
- **Core checks**: `npm run check` (37 checks): sensor/screen orientation maths, projection, angular
  velocity, sharpness and texture detection, image-motion tracking, coverage counting, free-space carving of
  depth noise, the flying-pixel depth filter, scan bounds, guide paths and pass completion, never sending you
  backwards, completing and skipping spots, re-alignment (any heading, rejecting look-alike rooms and plain
  walls, drift), hallway re-alignment (depth alone can't place you along it, the photos can), hallway paths
  kept off the walls when the outline is drawn around the door recesses, lined-up sessions sharing one map,
  photos while walking, coaching priority/hysteresis, scoring, COLMAP/transforms export, ZIP validity,
  splat cropping, and walk mode (floor, walls, a plain wall of big flat splats, a table, a doorway, floor holes,
  floaters, sliding along walls, an upside-down splat of unknown size, COLMAP text and binary camera files).
- **Walk mode** on three real hallway splats from the library (Memorial Union lobby and Ggg, Hayden Library):
  the maps built in 0.1–0.3 s; walking straight out from the start in 36 directions never left the scanned
  floor; following the phone's own path got blocked on 7 of 411 legs in the lobby (where the phone was held
  out close to a wall) and on none in the other two. In the viewer: walking, mouse and touch look, the touch
  stick, ghost mode and landing, jumping from the mini-map, and back to orbiting. Only checked at a few frames
  per second in a preview window, not yet at full speed on the RTX 5080.
- **Hallway re-alignment (2.2)** in the new Practice hallway (18 m, door recesses both sides, posters and
  numbered doors, planked floor and tiled ceiling) and the Practice room, with photo-taking paused so a bad
  result couldn't spoil the next. Continuing a scan in a new, turned and shifted session locked in 2–4 s
  within 1–3 cm. Per scene, 24 events: tracking lost for 2 s with ARCore keeping its coordinates (resumed at
  once), lost with its coordinates shifted 0.6 m and 8°, and 0.6 m / 25° jumps. All came back within 6 cm,
  4.4 s (room) and 5.4 s (hallway) on average, none stuck. Tapping a spot 36 cm off on the map locked in 2 s
  within 7 cm. Earlier rounds of this test exposed wrong locks: from repeated floor and ceiling patterns
  (photo matching now uses walls, doors and signs only), from middling photo matches (now "not sure"), and
  from the quick post-loss check correcting over a narrow view (it now only confirms an unchanged position;
  anything else gets the full search).
- **Re-alignment in the Practice room**, which now starts every later session in shifted, turned coordinates
  like a real AR session: resuming a capture found its place within 2 cm about 10 s after starting; a simulated
  60 cm / 12° tracking jump and a 2 s tracking loss were both put back within 6 cm; lining up by hand from 9 cm
  and 4° off snapped to within 1 cm.
- **Full guided captures** in the Practice room, simulated with the Pixel's AR camera geometry (860×1920,
  35° wide in portrait), driven frame by frame through the real pipeline with an autopilot that follows the
  guide at walking pace: marking the scan area, all five passes advancing by themselves, gap filling,
  coverage, saving, grading, review and export. The 51 m² room reaches "scan area complete" (85%) after about
  7.5 minutes and 92% after 9.
- **Tuned on your first real Pixel captures**: in v1, photos came every 2.2 s (median) because a photo was only
  attempted once the phone was nearly still. 2.0 evaluates frames while you move and uses a blur model
  calibrated to the AR camera's real focal length.
- **Pose export checked with COLMAP 4.2**: the exported model loads directly. Triangulating with the app's poses
  held fixed gives 0.65 px mean reprojection error. COLMAP's own SfM agrees with the exported camera positions
  to a median of 1.5 mm.
- **The AR code path** (WebXR session, GPU camera readback, ARCore depth sampling, overlay, session-ended
  handling) runs against a simulated WebXR device, and saved photos come out upright.

Not yet tested, because it needs real hardware: a live ARCore session on your Pixel. Things to look at on the first run:
- The camera resolution Chrome provides (shown in Settings → *Show live debug numbers*, `cam` line).
- If AR photos ever come out **upside down**, turn off Settings → *AR frame orientation fix*.
- Coaching thresholds (speed, blur) may want small tweaks once real indoor footage is in. Settings →
  *Photo pace* gives three presets.
- Marking corners relies on ARCore finding the floor: point the phone at the floor and move it slowly until the
  cursor appears.
- Photo matching (2.2) was tuned on rendered scenes. Real hallways have exposure changes, motion blur and
  identical doors. If re-aligning in a real hallway still struggles, the capture's `alignLog` in the export
  records each lock with its photo score, which says whether the threshold needs moving.

## 5. For developers

```
app/js/core/      platform-independent logic (analysis, coverage, depth filter, scan bounds, guide, walkable floor
                  plan, re-alignment + photo matching, keyframes, coaching, plans, scoring, export formats)
app/js/sources/   xrSource (WebXR/ARCore), cameraSource (getUserMedia + orientation), demoSource/demoScene (practice room, hallway)
app/js/capture/   session engine, 3D overlay (+ guide geometry), minimap, audio
app/js/data/      IndexedDB storage, settings, ZIP export
app/js/ui/        screens
tools/            serve.mjs (dev server), check.mjs (self-checks), make-icons.mjs
station/          SplatStation: station.mjs (server, queue, inbox), lib/ (zip, COLMAP, Brush, crop, walk maps, video, adb),
                  web/ (dashboard, viewer, walk.js: walk-mode collision shared with the self-checks)
```

- `npm start`: local server on http://localhost:8080
- `npm run check`: core self-checks (Node 20+)
- `npm run icons`: regenerate the PNG icons

No dependencies, no build step. Photos are stored on the phone in IndexedDB until you delete them.
