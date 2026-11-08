# SplatScout — AR capture coach for Gaussian splats

SplatScout is a phone app (a web app you install from Chrome, with no app store) that helps you capture
building interiors well enough to make **clean Gaussian splats**. While you scan, it:

- **Guides you around the space in AR**: you mark the scan area by tapping its corners on the floor, then
  each pass draws a path on the floor and an arrow under the centre cross gives one instruction at a time:
  walk to the path, turn or tilt the phone ("Turn right 40°", "Tilt up 20°"), then sidestep along it. It only
  ever points ahead (no shuffling back and forth in corners), takes the photo when you stand on a spot, and
  skips spots that can't be reached. The last pass sends you to the spots that still need angles, sweeping
  along in one direction at the height you hold the phone, and says it's done at 93% (2.3). A skipped spot
  never comes back.
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
  In front of a plain wall it asks for slower turns, and it warns "Tracking is slipping" (and holds photos)
  before tracking is lost (2.3).
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

**iPhone:** Safari on iOS still has no WebXR AR, and every iPhone browser has to use Safari's engine, so no web
app can reach ARKit's tracking; AR mode would need a native iOS app (built on a Mac with Xcode and an Apple
developer account). Camera mode works on iPhones today, and SplatStation can merge an iPhone's camera-mode
photos with a Pixel's AR capture of the same place, which gives them the Pixel's positions, size and level.

There's also a **Practice room**: a virtual classroom that runs the full pipeline on a laptop or phone,
so club members can learn the technique before scanning a real building.

The repo also contains **SplatStation** ([`station/`](station/)), the PC side. It turns SplatScout exports
(or plain phone videos and 360° videos) into finished Gaussian splats on your NVIDIA GPU, with no Python and no cloud.
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
7. In Review: check the fixes, then **Export**, choose what to include, and **Save ZIP**. Or **Upload** it to
   the club database (below).

The in-app **Capture guide** is the full field manual: golden rules, technique for each type of space,
lighting, tricky surfaces, and a "splat symptom → capture fix" table.

### The club (beta): photos and scans from many people

Anyone invited can add to one shared dataset, filed by building, floor and room, for SplatStation to turn into
splats (and merge, when several people covered the same room). It is a **closed beta**: you join with an invite
code, a handle (shown on the leaderboard) and by agreeing to the rules, and the club database accepts nothing
from anyone else. **[crowd/ADVISOR-BRIEF.md](crowd/ADVISOR-BRIEF.md)** explains what it does, the safeguards, and
what is still open (permission, consent wording, faces); it also has a five-minute demo script.

- **Club** (home screen): join, your points and rank, missions, the leaderboard (this week / all time) and the
  photos you sent with what the club made of each. *Leave the club* deletes everything you sent.
- **Take photos** (single photos, no full scan needed): pick the building, floor and room, then shoot. Each photo
  is checked on the spot and a bad one isn't kept: motion blur (compared with what the camera just saw), too dark
  or washed out, or almost the same view as a photo you just took. The shutter ring turns green when the camera is
  steady. Photos are saved on the phone first and sent in the background, so it works without a signal; once
  sent, only a thumbnail stays on the phone. Camera only: there is no gallery upload.
- **Track position (AR)** (Take photos → *Camera*): the photos are taken inside an AR session (the scan's WebXR
  tracking, without depth) and each one keeps where the phone was: its AR pose (position and direction, in metres),
  the AR camera's lens and the AR session it belongs to. Within one session the poses agree to centimetres, so
  SplatStation starts COLMAP from them (below): the photos line up faster and the splat comes out in metres, so the
  Campus page gets the space's real floor area. AR photos are the AR camera's own frames, smaller than ordinary
  ones (860×1920, about 1.7 MP, on the club's Pixel; ordinary photos are kept at about 2–3 MP), so which makes the
  better splat is for **Measure quality** on SplatStation to settle (the held-back PSNR of splats of the same
  space). No photo while AR is unsure of its position (the ring turns amber). Going up or down the stairs, the
  height change suggests the new floor ("You went up about 4.2 m. Now on floor 2?"): one tap confirms it, *Same
  floor* counts from there. A new AR session starts whenever tracking starts over somewhere else.
- **Which building:** *Find my building* uses GPS to pick from ASU's buildings (outlines from OpenStreetMap, all
  four campuses). It only picks by itself when the fix is good to 40 m and inside one building; indoors GPS is
  often off by 10–50 m, so it offers the nearby buildings to tap instead. Typed names are matched to the same
  list ("Schwada Building" → Schwada Classroom Office Building), so everyone's photos of a building land together.
  Floor and room come from you (the sign by the door).
- **Off limits:** residence halls and housing, health, police and courts, and children's centers can't be picked,
  and the club database refuses photos and scans for them (the list is from OpenStreetMap's building types, and
  SplatStation's Club page can add or remove any building).
- **Points** (decided by SplatStation after a person has looked at the photo): 1 per accepted photo (up to 100 a
  day), +5 for the first photo of a room, +3 for the first photo of a room in morning, afternoon, evening or night
  light, a mission's bonus on top, and 30–130 for a full scan. Light slots are what the dataset needs most: a
  splat built from one lighting condition is much cleaner than one built from a mix.
- **Missions:** the club asks for a view in a kind of light ("Hayden lobby in evening light, +3 each"). A mission
  asking for evening light only scores in the evening.
- **Campus map** (Club → *Campus map*): ASU's buildings coloured by how much of their floor area the club's photos
  cover (one blue, darker = less done; dark grey = off limits), with you on it when location is allowed. Under the map:
  the buildings *near you*, the spaces that are *good to shoot now* (they need the light it is now) and the ones
  closest to Good. Tap a building for its spaces: each has its quality band, its accepted photos in each kind of
  light, and "about 33 more photos in evening light (4–8 pm) would make it Good"; *Take photos here* opens Snap
  with the building, floor and room filled in and says whether it's the right light now. The list of buildings
  under the map has the same information without the map. The numbers come from SplatStation's Campus page,
  which publishes them for members (counts only, no names or GPS points); the phone keeps the last copy for
  places with no signal.
- **Scans** work as before (Upload on the review screen), but now need membership and upload as your handle.
  Photos go one by one, so a dropped connection resumes with **Resume upload**. *Remove from club database*
  deletes your upload again. Photos carry no GPS or camera metadata (they come from the canvas); the GPS reading
  is stored with the capture's details instead.
- **Where it goes:** a Supabase project (free plan: about 1 GB, roughly 3–6 scans or 1,500–2,500 single photos;
  SplatStation's *Free cloud space* moves accepted photos off it). Single photos land in the private
  `club-photos` bucket as `<building>/<floor-room>/<photo id>.jpg`, scans in `captures`, with one row per
  photo or scan. Each phone signs in anonymously and the database rules let it add, finish and delete only its
  own uploads (at most 400 photos a day), never see anyone else's, and never set its own points.
- **Set up** (once, in the Supabase SQL Editor, each in a *new* query): turn on anonymous sign-ins, run
  [`crowd/supabase-setup.sql`](crowd/supabase-setup.sql), then [`crowd/supabase-beta.sql`](crowd/supabase-beta.sql),
  then [`crowd/supabase-campus.sql`](crowd/supabase-campus.sql) (the Campus map's summary: members read it, only
  SplatStation writes it) and [`crowd/supabase-campus-2.sql`](crowd/supabase-campus-2.sql) (each space's floor
  area and the floor counts the club sets; without it phones use typical sizes), and
  [`crowd/supabase-snap-pose.sql`](crowd/supabase-snap-pose.sql) (photo positions from Track position: a `pose`
  column members write only with their own new photo, in a checked shape; without it AR photos are sent without
  their position). Each ends with a one-row result saying it was installed; "Success. No rows returned"
  means an older saved query ran instead. The project URL and publishable key are in `app/js/data/crowd.js`;
  make invite codes on SplatStation's Club page.

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
phone/360 video ─┼─► inbox / upload / USB ─┤   • AR poses → triangulate + bundle-adjust (fast, robust)
                 │                        │   • no poses → global SfM, moved into the AR frame when the phone had poses
                 │                        └─ Brush (trains the splat on the GPU) ─► library/<Building>/<Room>/<date>/scene.ply
```

With a SplatScout 2.0 capture that has a scan area, the finished splat is **cropped to that outline** (plus 0.5 m),
which removes small floaters seen through windows or past the area. Big, faint splats stay wherever they are:
seen only from inside a room, a plain wall can be painted by large blobs metres behind it, and cropping those
away left walls dark and see-through. What the crop removes is kept beside the splat (`scene.outside.ply`).
Turn cropping off on the dashboard (*Crop splats to the scan area*), or change it afterwards in the viewer:
**⬚ Crop** shows the splat from above with the outline on it. Drag its corners, change the margin, or untick it
to keep everything, then press Apply. It takes a few seconds, nothing is trained again, and the camera stays
where it was. What's removed is mostly faint specks beyond the walls, so from inside the room a crop can look like
it did nothing: zoom out, or press *Show only what's removed* to see exactly what it took out.

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
- **Club uploads:** put the Supabase project's secret key in `%USERPROFILE%\SplatStation\crowd.json`
  (`{"url": "https://….supabase.co", "secretKey": "sb_secret_…"}`; it never leaves this PC, and the club tools only
  answer requests from this PC, not from the Wi-Fi). *Club uploads* on the dashboard then lists the scans phones
  sent, by building. **Import** downloads one into *Ready to process* as a normal SplatScout ZIP filed under the
  shared building name and awards the member their points; **Delete** removes it from the club database for good.
- **Club photos & members** (the button on that section, or `/club.html`): **Sync photos** downloads new photos and
  checks each one (size, sharpness against the rest of the outing, light, near-duplicates of the same member's
  photos, GPS far from the building, a wrong phone clock). Each gets a first opinion (*ok*, *review*, *reject*) and
  you look through the thumbnails and **Accept** or **Reject**. Accepting awards the points. **Rejecting deletes
  the photo** here and in the cloud (it may show a person), with the reason shown to the member. Accepted photos
  stay on this PC; *Free cloud space* removes their cloud copies. For a room with 10 or more accepted photos,
  **Build a capture** puts them into *Ready to process* like a camera-mode capture, so they become a splat the
  usual way. Photos taken with *Track position (AR)* bring their AR poses: the AR session with the most photos of
  the room (10 or more) sets the coordinates, its photos go first, and its poses go into the ZIP as the same COLMAP
  model a scan carries, so COLMAP starts from them (with 20 or more) and the splat is in metres. Every AR photo,
  from any session, shares its exact lens; COLMAP places the other photos (other AR sessions, ordinary photos,
  other phones) in rounds, each round triangulating what the last one added (see *What was tested*).
  The page also makes **missions**, **invite codes** (who can join and how many times), pauses, renames
  or removes members (removing deletes everything they sent), and edits the list of off-limits buildings.
- **Campus map** (dashboard header, or `/campus.html`, this PC only): every ASU building on a map, coloured by
  how much of its floor area is covered, with the GPS points where photos and scans were taken. Click a building
  for its floors and spaces (each room or area members tagged), and a space for how good a splat to expect, how
  that number was reached, its size, its photos by light, the splats built from it with a link to the viewer, and
  what would make it better; *Ask members for photos* turns that into a mission. Above the map: the spaces ready
  for a good splat, the campus floor area covered, buildings started, photos, splats and members. Below it, each
  with a table view: **How good a splat to expect** (the rule of thumb for rooms, hallways and large spaces against
  photo count, with the club's spaces and finished splats on it), **Buildings by floor area covered**, **Light
  coverage** (photos per building, or per space, in each kind of light) and **Photos sent per day**, then a
  sortable table of every building and *How the numbers work*.

  The numbers are estimates, and the page says so. A space's expected quality comes from its photos (in a room
  about 125 photos in one kind of light make it Good and 208 Excellent; hallways and big lobbies need more; mixed
  light counts less), from a scan's grade, or from a finished splat (measured, or what it promised less for photos
  COLMAP couldn't place, a high reprojection error or quick training). A building's completion is the share of its
  floor area (footprint from OpenStreetMap × floors) that its spaces cover: each space counts for its own floor
  area, in proportion to how close it is to Good. A space's area is measured when its splat was lined up with the
  phone's AR tracking (so is in metres): from its scan's outline, or, for club photos taken with Track position,
  from the floor the splat shows where the photos were taken (the walk map's floor reachable from the phone's
  path, and the furniture it surrounds; through an open door it runs on up to 3 m); otherwise it's typical for its size (small room 20 m², room 60,
  big room 120, hallway 150, lobby 400, very large space 1,000), guessed from its name until you pick one on the
  space's panel. Floors come from OpenStreetMap, or 2 until you set them on the building's panel. So one small room
  in a four-floor library is a fraction of a percent, and the building's panel shows each floor's share. Offices and
  rooms the club can't enter count too, so a building whose public spaces are all done still shows well under 100%.
  Photos waiting for review count straight away (rejecting one takes it off), and **Live** checks for new ones every
  15 seconds and rings each new point on the map, so the map moves with every photo sent. **Start fresh** counts
  only what arrives from then on, to show a building fill up photo by photo; nothing is deleted, and *Count
  everything again* switches back. Your existing splats are filed under their building by name ("Schwada
  Building" counts for Schwada Classroom Office Building).

  **Publish to members** (top of the page) sends the phones' Campus map a summary: each space's expected quality
  and floor area, its accepted photos per kind of light, how many wait for review, and about how many more photos,
  in which light, would make it Good, plus the floor counts you set. The count is worked out with the same rules (so
  the phone and this page agree, mixed light and scans included). No member names, no GPS points, nothing in
  off-limits buildings. It also publishes by itself a few seconds after you review photos, change a size or a floor
  count, or start fresh, and within a minute of new photos arriving while SplatStation runs. Needs
  `crowd/supabase-campus.sql` run once in the Supabase SQL editor, and `crowd/supabase-campus-2.sql` for sizes and
  floor counts (until then it publishes without them).

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
quality, training stats, capture grade, measured quality) and `thumb.jpg`. Click **View** for the built-in viewer,
or **Edit in SuperSplat** to crop and clean floaters.

**Measure quality (optional).** Everything else said about a splat's quality is a guess from its photos and its
camera solve. For a real number, tick *Measure quality (hold back every 12th photo)* under Defaults, or *Measure
quality* on a capture's card before pressing Process. Brush then keeps every 12th photo out of training, and when
training ends it renders the splat from exactly where each of those photos was taken and compares the two:
**PSNR** (in dB: how far the pixels are off) and **SSIM** (up to 1: whether edges and texture line up), averaged
over the held-back photos. Both show on the job's History card and its Library tile, are saved in `info.json` as
`training.eval` (`{"psnr": 21.7, "ssim": 0.7469, "views": 20, "step": 7000, "every": 12}`), and the Campus map
uses them in place of its estimate. The cost is that the splat trains on about 8% fewer photos (measuring takes
only seconds), so it's off by default: turn it on to compare captures or presets, or re-process a finished capture
with it ticked. SplatStation asks Brush to log (`RUST_LOG=error,brush_cli=info`) and reads the score from its
`Eval iter …: PSNR …, ssim …` line, which also lands in the job's `job.log`.

How to read the numbers, from the club's own captures, each trained on Quick and on Standard with every 12th
photo held back (on the RTX 5080, November 2026). *Score* is what the Campus map makes of the PSNR; *estimate
before* is what it said with no measurement:

| Capture | Photos (held back) | Scan grade | Estimate before | Quick: PSNR · SSIM → score | Standard: PSNR · SSIM → score |
|---|---|---|---|---|---|
| Hayden Library · TestfibL | 481 (41) | B | 80 Good | 27.4 dB · 0.880 → 82 Good | 28.7 dB · 0.886 → 88 Good |
| Schwada · Snall | 1052 (88) | A | 99 Excellent | 26.7 dB · 0.926 → 78 Good | 27.8 dB · 0.926 → 84 Good |
| Schwada · Jfbbch | 413 (35) | A | 88 Good | 25.0 dB · 0.949 → 67 Fair | 27.3 dB · 0.960 → 81 Good |
| Memorial Union · Lobby | 412 (35) | B | 85 Good | 24.7 dB · 0.880 → 64 Fair | 26.5 dB · 0.908 → 78 Good |
| Memorial Union · Ggg | 537 (45) | A | 88 Good | 23.8 dB · 0.902 → 56 Fair | 26.5 dB · 0.924 → 77 Good |
| Schwada · Dd | 233 (20) | C | 64 Fair | 21.8 dB · 0.752 → 40 Rough | 22.9 dB · 0.771 → 49 Rough |

Next to the held-back photos, the splats' renders of them look like this: at 28.7 dB (TestfibL) the two are hard
to tell apart; at 26.5–27.8 dB (Ggg, Lobby, Snall, Jfbbch) walls, furniture and signs are solid and only a little
soft, with some haze or blotches on plain white walls and a blurred TV whose picture changed between photos; at
22.9 dB (Dd) some views are clean, but the glass doors and the perforated stair panels smear and ghost. So the map
scores PSNR in straight lines between these stops: under 20 dB *Not enough yet*, 20 *Rough*, 23 *Fair*, 26
*Good*, 29 *Excellent* (`PSNR_STOPS` in `app/js/core/campusmodel.js`). Photos COLMAP couldn't place still count
against a measured splat. Without a measurement, the map's estimates for five of these six ran 7–15 points high.

What a measurement can't see: it scores the views the phone saw (each held-back photo sits between ones the splat
trained on), not places nobody photographed, so a scan that missed a corner can still score well. Plain walls
score higher than busy shelves (white haze on a white wall costs little), and anything that changed between
photos (a TV, people walking through, the phone's exposure) pulls it down. Quick preview scores 1–3 dB below
Standard on the same photos, so a Quick splat often lands a band lower: the measurement sees that it's softer.

**Walk through it.** In the viewer, press **🚶 Walk** to explore the splat in first person, at the height the phone
was held. Use W A S D (or ↑ ↓, with ← → to turn), click the scene and move the mouse to look around, hold Shift to
hurry, Space to jump, press G for ghost mode (fly through walls; G again lands you on the floor) and M to hide the
mini-map; click the mini-map to go somewhere. On a phone or tablet the left thumb walks, the right thumb looks and
the ⤒ button jumps. Walls,
furniture and the edge of the scanned floor stop you, and you slide along them instead of sticking. SplatStation
works this out from the splat itself: it finds the floor below where the phone went, treats solid splats between
knee and head height as walls and furniture, and keeps you where it saw floor and inside the scan area. Plain
white walls are often too faint to block on their own, but the scanned floor stops at them, so they hold you in
too. The map is saved next to the splat (`scene.walk.json`) the first time it's needed. Splats from a video have
no real-world size, so their walking height assumes the phone was held 1.5 m up.

**360° video: the quickest capture.** A 360 camera (Insta360, Ricoh Theta, GoPro Max and the like) films every
direction at once, so one slow walk through a room or down a hallway, a minute or two, can stand in for a guided
SplatScout session. Export the clip from the camera's app as an ordinary 360° MP4 (equirectangular; the raw
`.insv`/`.360` files aren't read) and drop it in like any video. SplatStation recognises it by its 2:1 frame or its
360 tag, takes the sharpest frame from every half second (up to 160), and cuts each one into eight normal views
around the horizon plus one straight up. None looks down, where you are. COLMAP then solves each frame's nine
views together as one camera rig, and Brush trains on them like photos. To film:
- Hold the camera on a stick above your head, so you're out of the side views.
- Walk slowly and steadily, and keep the horizon level (FlowState or horizon lock on).
- Walk a loop, or go there and back on the other side, so each wall is seen from several places.
- Keep people out of the shot as far as you can.

The catches, compared with SplatScout photos: each view has less detail (a 5.7K camera gives 1440-pixel views and
an 8K one 1920), and there are no AR positions, so there's no scan-area crop and the splat's size is a guess. Walk
mode assumes the camera was held 1.9 m up. Not yet tried with real 360 footage; see below.

**Merge captures from several phones.** Tick **Merge** on two or more captures of the same place (other
phones, other days, an iPhone in camera mode, a phone video) and press **Merge N into one splat**. Each keeps
its own lens; COLMAP matches photos within each capture and across them, solves everything together, and puts
the result in the AR coordinates of the capture with the most AR positions. So the splat has real size and a
level floor, every phone's scan area is used for cropping (moved into those coordinates), and walk mode works.
The original captures stay as they are. 360° videos can't be merged yet.

**What it needs:** an NVIDIA GPU, plus the following, all found automatically. Paths can be changed in
`%USERPROFILE%\SplatStation\station.config.json`.
- COLMAP 4.x with CUDA (`C:\Tools\COLMAP`).
- Brush v0.3 (`C:\Tools\Brush\brush_app.exe`, from github.com/ArthurBrussee/brush releases).
- ffmpeg (video and 360° video input only).
- adb (USB import only).

## 4. What was tested, and what still needs your Pixel

Tested on this PC:
- **Core checks**: `npm run check` (58 checks): sensor/screen orientation maths, projection, angular
  velocity, sharpness and texture detection, image-motion tracking, coverage counting, free-space carving of
  depth noise, the flying-pixel depth filter, scan bounds, guide paths and pass completion, never sending you
  backwards, completing and skipping spots, re-alignment (any heading, rejecting look-alike rooms and plain
  walls, drift), hallway re-alignment (depth alone can't place you along it, the photos can), hallway paths
  kept off the walls when the outline is drawn around the door recesses, the gap pass (spots you can reach at
  the height you hold the phone, a skipped spot never coming back, everywhere you've walked counting as
  reachable), lined-up sessions sharing one map, photos while walking, coaching priority/hysteresis (slower
  turns at plain walls, slipping tracking first), scoring, COLMAP/transforms export, ZIP validity,
  splat cropping (big background splats kept, a crop changed and undone without losing anything), and walk mode (floor, walls, a plain wall of big flat splats, a table, a doorway, floor holes,
  floaters, sliding along walls, an upside-down splat of unknown size, COLMAP text and binary camera files), and the
  360° camera rig (each cut view turned the way ffmpeg cuts it), and merging phones (pairs within and across
  captures; each phone's scan area moved into the main phone's coordinates), and the club (GPS picking a
  building only when sure, typed names matched to the ASU list, housing and health off limits; joining with an
  invite code; the on-phone photo queue sending in the background, waiting out a busy server, stopping on a
  refusal and resuming; leaving deleting everything; scan uploads resuming without sending anything twice;
  SplatStation's first opinions on photos, points for the first photo of a room, a new light and missions with
  the daily limit, a rejected photo deleted everywhere, a capture built from accepted photos, members, invites,
  and refusing requests from the Wi-Fi), and the campus view (expected quality from photos, mixed light, scans and
  finished builds; photos waiting for review counted; floor area covered, floor by floor, with sizes guessed, set
  or measured from a scan; a fresh start and back; photos, splats and queued captures of one room joined into one
  space; campus totals, map points and daily activity), and the phone's campus map (exact photo counts to Good,
  mixed light and scans included; the published summary leaving out names, GPS and off-limits buildings; never
  publishing when the database couldn't be read; members only; building completion on the phone equal to the
  Campus page's, with or without supabase-campus-2.sql; stale rows removed on the next publish; the last copy kept offline),
  and Track position (the pose saved with an AR photo and the shape the database takes, poses the PC can use or
  must refuse, the floor suggested from the height change; AR photos sent with their pose, and without it to a
  database that doesn't take positions yet; a capture built from AR photos with the biggest session's poses as
  COLMAP's model, numbered as COLMAP numbers the files, every AR session sharing its exact lens; the AR model
  renumbered to COLMAP's database; the floor area measured on a walk map, a stray camera kilometres off
  changing nothing). They run against an in-memory stand-in for Supabase
  (`tools/fake-supabase.mjs`; `tools/fake-supabase-server.mjs` serves it so the phone app and SplatStation can be
  tried together; `--demo` fills it with made-up members and photos to try the Campus map). The database rules themselves are tested on a real Postgres with `tools/sql-test.mjs`
  (needs `npm install --no-save @electric-sql/pglite`): who can add what, that points only come from
  SplatStation, members-only views, the daily limit, bans, leaving, the campus summary (members read it,
  strangers and the bare public key see nothing, only the secret key writes it), and photo positions (written
  only with your own new photo, in the right shape, never changed afterwards; restricted places still refused).
- **The guide loop (2.3)**, with a simulated person following every pass of the Practice hallway and room
  (walking, turning, taking the photos the app asks for, pressing Skip when it offers). Before: the last pass
  never ended (in the hallway, still going after 15 minutes with 83 turn reversals and 96 trips back), and since
  2.2 it could even crash on reaching that pass, leaving the guide silent. In some runs it also gave up at once
  with the room 54–75% covered, because a gap in the depth map cut the user's spot off from the rest of the
  floor. After: 40–110 s in the room, 3–3½ minutes in the hallway, both ending at 93%, over 7 runs each.
- **Measured quality (2.6)**: the Schwada "Dd" capture processed end to end with *Measure quality* on (PSNR
  21.7 dB and SSIM 0.747 on its 20 held-back photos, saved in `info.json` and shown on the History card, the
  Library tile and the Campus map), then six of the club's captures trained on Quick and Standard with every 12th
  photo held back. The renders of the held-back views were checked by eye against the photos to set the PSNR
  thresholds: see the table under *Measure quality*. Brush prints nothing to a pipe unless `RUST_LOG` is set.
- **Track position on SplatStation**, with the real Schwada "Dd" scan's 233 photos (860×1920) made into club
  photos: 120 from one AR session (their real AR poses), 80 from a second session in other coordinates (turned 70°
  and moved 6 m) and 33 ordinary photos (smaller, no pose), built by *Build a capture*'s code and processed by the
  usual pipeline (Quick, *Measure quality* on). The AR-pose solve placed 232 of 233 photos at 0.41 px and in
  metres (distances between photos 0.98 of the AR tracking's), the second session's photos a median 10 cm and the
  ordinary ones 9 cm from where AR tracking had them, and the walk map measured 32 m² of floor. The job took 427 s
  against 542 s for the same photos without usable poses (COLMAP's own solve, then lined up with the AR coordinates).
  The splat's held-back PSNR was 20.7–22.4 dB over four runs against 23.1 dB for the one run without poses: here the
  poses bought metres and speed, not a sharper splat, so real club rooms with *Measure quality* on should decide.
  It took four fixes, each now in the self-checks: COLMAP 4.2 refuses a pose model numbered other than its database,
  or with another kind of camera; `image_registrator` never triangulates, so one pass placed only 207 photos; each
  of the second session's photos started from COLMAP's default lens guess (2,304 px for 1,374) and one settled 9 m
  off; and adjusting one outing's poses freely let a weakly linked stretch slide (18 photos over a metre in one run).
- **Cropping** on the Schwada "Snall" splat (2.2 million splats), whose plain white walls came out dark and
  see-through. The walls sat right on the outline and the crop removed only 0.1% of the solid splats at wall
  height, but cropping at 0.5, 1 or 2 m all left them dark: 73,000 large faint splats 7–28 m away outweighed
  everything inside the room about 300 to 1 and were painting the walls. Keeping splats 25 cm and bigger
  brought the walls back, bright and sharp, still cropping 84,000 small ones. Re-cropping took about 2 s; keep
  everything, a moved corner with a 1 m margin and back to the phone's outline gave exactly the first result.
- **Merging (2.3)** on the real Ggg capture split into pretend phones (odd photos with AR; even photos
  either with AR in a frame turned 70° and moved 6 m, or with no AR like an iPhone in camera mode). Both merges
  placed 535–536 of 537 photos at 0.8 px error in about 5 minutes on Quick. The camera-mode photos landed a
  median 8.5 cm (90% within 13 cm) from the AR positions they really had, about the AR session's own drift over
  the hallway; the other phone's scan outline landed within 1 mm of the first one's, with the same floor height.
- **360° video** on a rendered 62-second walk down the Practice hallway and back (1600×800, camera 1.9 m up):
  125 frames picked, cut into 1,125 views in 3 s; COLMAP placed all 1,125 as a 9-view rig at 0.76 px error; the
  Quick splat trained in 39 s, 3 min 10 s end to end. In the viewer it's an upright, recognisable hallway, and
  walk mode found the floor 1.9 m down with walls and door recesses in place. This run also exposed two problems,
  both fixed: Brush 0.3 can't load JPEGs under 16 KB (plain cut views can be that small, so they're padded), and
  walk mode's floor finder used to count splats, so a band of detailed posters outweighed a plain floor (it now
  weighs level surface area). Not yet tried with real 360 footage, which will be noisier, with people and
  exposure changes.
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
- **Track position (AR)** on Snap ran against a simulated WebXR session in a desktop browser (poses, a test
  picture, a 4.2 m climb), not yet in a real AR session. On the Pixel: the AR view behind the Snap screen, the ring
  going green, AR photos the right way up, and whether the floor suggestion holds up on real stairs (in a lift,
  ARCore usually loses tracking, and a new AR session starts with no suggestion). Then process one room shot in AR
  and one in ordinary photos with *Measure quality* on, to see which makes the better splat.

## 5. For developers

```
app/js/core/      platform-independent logic (analysis, coverage, depth filter, scan bounds, guide, walkable floor
                  plan, re-alignment + photo matching, keyframes, coaching, plans, scoring, export formats,
                  clubrules: club points and checks, campusmodel: expected quality and building completion,
                  snappose: the AR pose kept with a Snap photo, and the floor from the height change)
app/js/sources/   xrSource (WebXR/ARCore), cameraSource (getUserMedia + orientation), demoSource/demoScene (practice room, hallway)
app/js/capture/   session engine, 3D overlay (+ guide geometry), minimap, audio
app/js/data/      IndexedDB storage, settings, ZIP export, campus (ASU buildings + GPS), crowd (club uploads),
                  club (membership, leaderboard, missions), snaps (the on-phone photo queue),
                  campusmap (the published campus summary, kept offline; completion by campusmodel's rules)
app/js/ui/        screens
app/data/         asu-buildings.json (from OpenStreetMap: node tools/asu-buildings.mjs refreshes it)
crowd/            supabase-setup.sql + supabase-beta.sql (the club database: tables, private buckets, rules, views),
                  supabase-campus.sql + supabase-campus-2.sql (the summary behind the phone's Campus map),
                  supabase-snap-pose.sql (photo positions from Track position),
                  ADVISOR-BRIEF.md
tools/            serve.mjs (dev server), check.mjs (self-checks), make-icons.mjs, asu-buildings.mjs,
                  fake-supabase.mjs / fake-supabase-server.mjs (stand-in database), sql-test.mjs (database rules on Postgres)
station/          SplatStation: station.mjs (server, queue, inbox, merges), lib/ (zip, COLMAP, Brush, crop, walk maps, video, adb,
                  crowd + club + clubapi: the club, campus: the campus view's data),
                  web/ (dashboard, viewer, walk.js: walk-mode collision shared with the self-checks, club, campus)
```

- `npm start`: local server on http://localhost:8080
- `npm run check`: core self-checks (Node 20+)
- `npm run icons`: regenerate the PNG icons

No dependencies, no build step. Photos are stored on the phone in IndexedDB until you delete them.
Building outlines © OpenStreetMap contributors, available under the Open Database License.
