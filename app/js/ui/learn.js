// Capture guide: the field manual, available offline inside the app.

import { h, mount } from './dom.js';
import { icon } from './icons.js';

const SECTIONS = [
  {
    title: 'Why capture quality decides everything',
    body: `
<p>A Gaussian splat is only as good as its photos. Training first works out where every photo was taken (structure-from-motion), then optimises millions of small coloured blobs until they reproduce the photos. Almost every bad splat traces back to the capture:</p>
<ul>
<li><b>Blurry photos</b> make soft, smeary areas, and they break the camera solve.</li>
<li><b>Too little overlap</b> between neighbouring photos makes the solve fail or split into pieces.</li>
<li><b>Turning in place</b> gives no depth information (no parallax), so you get floaters and fog.</li>
<li><b>Surfaces seen from one angle</b> look right from that angle and fall apart from any other.</li>
<li><b>Changing light or exposure</b> causes blotchy colour, haze and floaters.</li>
</ul>
<p>SplatScout watches all of this live, so you find problems while you're still standing in the room.</p>`,
  },
  {
    title: 'Guided capture: the fast way to a complete scan',
    open: true,
    body: `
<ol>
<li><b>Hold the phone sideways (landscape).</b> The AR camera sees 70° across in landscape but only 35° upright, so a sideways scan finishes much sooner.</li>
<li><b>Mark the scan area.</b> When AR starts, aim the centre cross at the floor in each corner of the space and tap <b>Corner</b> (or tap the spot on screen). Tap <b>Done</b>. Only surfaces inside the outline count, so you can capture half a hallway, or leave out what you can see through a window.</li>
<li><b>Follow the arrow.</b> Each pass draws a trail on the floor. The arrow under the centre cross gives one instruction at a time: <b>walk</b> to the path, <b>turn</b> or <b>tilt</b> the phone ("Turn right 40°", "Tilt up 20°", "Turn around"), then <b>sidestep</b> along it. The ring shows exactly where to aim. The trail fills in on the map as you go, and the next pass starts by itself.</li>
<li><b>Keep walking.</b> Photos are taken automatically while you move at a slow, steady pace. You don't need to stop. If you see "A little slower", ease off a bit.</li>
<li><b>Fill the gaps.</b> The last pass sends you to the spots that still need angles: walk to the ring on the floor, aim at the red area inside the blue ring, and hold for a second. Repeat until the app says the area is complete (about <b>85%</b>).</li>
<li><b>Skip what you can't capture.</b> Tap <b>Skip</b> (left), then tap a window, mirror or a corner you can't reach. It stops counting. Can't reach a spot the path wants? A <b>Skip this spot</b> button appears after a few seconds, and spots that can't be reached are skipped by themselves after about 15 seconds. You never have to shuffle back and forth: the guide only points ahead of you.</li>
</ol>
<p class="small muted">Every dot doesn't have to be green. Corners behind furniture and the tops of tall cabinets rarely matter. The area percentage weighs green fully and amber half, and 85% trains well.</p>`,
  },
  {
    title: 'If tracking is lost or the AR session stops',
    body: `
<p>Phone AR sometimes loses its place: in the dark, in front of a blank wall, or when the phone goes to sleep and AR has to start again. SplatScout notices and puts you back in your scan instead of starting over:</p>
<ul>
<li><b>Tracking lost or the position jumps:</b> photos pause for a moment while the view is checked against what you already scanned. If it still lines up, you carry on. If not, the <b>Re-aligning</b> panel appears.</li>
<li><b>Re-aligning:</b> sweep the phone slowly over walls and furniture you scanned before. Corners, doors and furniture work best; a plain wall could be anywhere. When it matches, the dots settle back onto the surfaces and you carry on where you left off.</li>
<li><b>Coming back later</b> (screen off, app closed, another day): open the capture and tap <b>Capture more → Continue in AR</b>. Stand roughly where one of the photos shown was taken and aim the same way, which makes the match faster. Tap <b>I'm here</b> to tell the app.</li>
<li>If it can't find its place (furniture moved, the room changed), <b>Line up by hand</b>: drag to slide the dots onto the walls, twist with two fingers to turn them, then <b>Use this position</b>. Or <b>Start a new map</b>: that session gets its own coordinates and its photos are still exported.</li>
<li>Think the dots don't sit on the surfaces any more? Tap <b>Align</b> (left) to check.</li>
</ul>`,
  },
  {
    title: 'The 8 golden rules',
    body: `
<ol>
<li><b>Slow and steady.</b> Walk at museum pace without stopping. The app keeps the sharpest frame of every stretch.</li>
<li><b>Move, don't pivot.</b> Every new photo should be taken from a slightly different <i>position</i>, not just a different angle. Sidestep ("crab walk") along walls.</li>
<li><b>Three angles minimum.</b> Every surface should be photographed from 3 or more clearly different directions. In AR mode that's the colour: red → amber → green.</li>
<li><b>Stay about 1 m from surfaces.</b> Closer and frames can't overlap; much farther and detail is lost. In big halls, walk up to the things that matter.</li>
<li><b>Three heights.</b> Eye level, overhead tilted down, waist tilted up. That's how tabletops, ceilings and the undersides of things get covered.</li>
<li><b>Fixed light, no flash.</b> All lights on and unchanged. Never use the phone's flashlight: light that moves with you ruins splats.</li>
<li><b>Nothing moves.</b> No people walking through, no doors swinging, no screens playing video.</li>
<li><b>Close the loop.</b> End each lap a little past where it started, and walk through doorways slowly in both directions.</li>
</ol>`,
  },
  {
    title: 'Reading the screen',
    body: `
<ul>
<li><b>Status banner</b> (top): the most important problem to fix right now. Red = stop and fix, amber = adjust, cyan = tip. While everything is fine it gets out of the way and the arrow does the talking.</li>
<li><b>Readouts</b> (top right): Speed, Sharp, Light, Detail, Depth (parallax) and Track. Keep the dots green.</li>
<li><b>AR colours on surfaces</b>: <span class="red">red</span> = photographed from 1 angle, <span class="amber">amber</span> = 2 angles, <span class="green">green</span> = 3+ angles, faint blue = seen but not photographed yet, grey = outside the scan area or skipped. Dots behind walls and furniture are hidden.</li>
<li><b>Light outline on the floor</b>: the scan area you marked.</li>
<li><b>Trail and chevrons on the floor</b>: the path for this pass.</li>
<li><b>Arrow under the centre cross</b>: the one thing to do next (walk, turn, tilt, sidestep or hold steady). <b>Ring</b> (green when you're on target): where to point the phone. In gap mode a ring on the floor and a ghost phone show where to stand.</li>
<li><b>Tools</b> (left): <b>Area</b> redraws the outline, <b>Skip</b> stops counting a surface you tap, <b>Guide</b> shows or hides the path, <b>Align</b> re-checks the position against the scan.</li>
<li><b>Map</b> (bottom left): the floor plan of what's scanned, the scan area, the planned path (green where done), and where you are. Tap it to enlarge. In camera mode it's a panorama of every direction around you.</li>
<li><b>Pass pill</b> (top): the current step of the plan and its progress. Tap it for instructions, to switch passes, or to change the scan area. <b>Area %</b> next to it is how complete the whole scan area is.</li>
<li><b>Shutter</b> (bottom right): forces a photo. Normally unnecessary, since photos are automatic.</li>
<li><b>Done</b>: grades the capture on the spot, so you can keep going if something's missing.</li>
</ul>`,
  },
  {
    title: 'Technique by space',
    body: `
<p><b>Rooms.</b> Eye-level lap along the walls aimed across the room, then the same lap overhead (tilted down), then low (tilted up). Then zig-zag through the middle around furniture. Finish with corners, ceiling, floor and doorways.</p>
<p><b>Hallways.</b> Never walk straight down the middle aimed down the hall: there's almost no parallax. Crab-walk along one wall aimed at the opposite wall at about 30° down the hall, then come back along the other side. Add a high and a low centre pass.</p>
<p><b>Large halls and atriums.</b> Perimeter lap, then lanes about 3 m apart (lawnmower pattern). Tilt up for balconies and ceilings. Distant surfaces get few pixels, so go close to anything important.</p>
<p><b>Stairwells.</b> One step at a time, pausing on each. At landings, turn while stepping sideways. Look up and down the well from every landing. Hold the rail.</p>
<p><b>Objects and features.</b> Orbit at about 1–1.5 m at three heights, about one photo per 10°, then one wider ring for context.</p>
<p><b>Linking rooms.</b> Capture each room separately (one capture per room keeps things manageable), but walk 2–3 m through each doorway into the next space. Those overlapping photos let you merge rooms later.</p>`,
  },
  {
    title: 'Lighting and exposure',
    body: `
<ul>
<li>Turn on every light and keep them on. Mixed daylight plus lamps is fine, as long as it doesn't change.</li>
<li><b>Windows</b> are the most common problem: blown-out glass becomes fog and floaters. Close the blinds if you can, or keep windows at the edge of the frame and capture that wall last.</li>
<li>Avoid sun patches moving across the floor. Overcast days or evenings with interior lights give the most even results.</li>
<li>In dim rooms move <i>extra</i> slowly: the camera uses slower shutter speeds and blurs more easily.</li>
<li>Camera mode on Android can lock exposure, white balance and focus (pass sheet → Camera). Point at a typical view, then lock.</li>
</ul>`,
  },
  {
    title: 'Tricky surfaces',
    body: `
<ul>
<li><b>Blank walls.</b> Nothing to match. Keep edges, trim, outlets or furniture in every frame. Step back rather than pointing at a plain wall from close up.</li>
<li><b>Glass, mirrors, glossy floors, screens.</b> Splats can't fully represent reflections. Capture them at angles from several positions, and turn monitors off.</li>
<li><b>Thin things</b> (railings, chair legs, plants) need many close, overlapping views from all around.</li>
<li><b>Dark corners and under tables</b>: low pass, tilted up and in.</li>
<li><b>Very large or tall spaces</b>: expect lower detail far away. Prioritise what matters for the archive.</li>
</ul>`,
  },
  {
    title: 'Fixing bad splats: symptom → capture fix',
    body: `
<table class="fix-table">
<tr><th>You see</th><th>Likely cause</th><th>Next capture</th></tr>
<tr><td>Floaters and fog in the air</td><td>Turning in place, too few angles, blown windows</td><td>Sidestep more; make surfaces green; manage windows</td></tr>
<tr><td>Soft, smeared area</td><td>Blurry photos there, or seen only from far away</td><td>Slower, closer, more light; remove blurry photos</td></tr>
<tr><td>Holes and missing ceiling/floor</td><td>No views from those angles</td><td>Overhead and low passes; look straight up and down</td></tr>
<tr><td>Doubled or ghosted geometry</td><td>Camera solve errors from gaps or repeated patterns</td><td>Denser overlap; close loops; more unique detail in frame</td></tr>
<tr><td>Solve fails or splits into pieces</td><td>Gaps in overlap, blank walls, lens switching</td><td>Watch for "Gap" warnings; one fixed lens; keep detail in frame</td></tr>
<tr><td>Blotchy colours</td><td>Exposure or white balance changing</td><td>Steady light; lock exposure where possible</td></tr>
</table>`,
  },
  {
    title: 'Getting photos into your splat pipeline',
    body: `
<ol>
<li>Review → <b>Export</b>. Choose what to include (leave out blurry photos, a pass, or an AR map that wasn't lined up), then <b>Build ZIP → Save ZIP</b>. On Android the ZIP goes to <i>Downloads</i>. The home screen shows which captures are exported and which have new photos since.</li>
<li>With <b>SplatStation</b> running on the PC, plug the phone in over USB: its exports are listed under <b>Phone over USB</b>, and you tick the ones to import. Imported captures wait under <b>Ready to process</b> until you pick the quality and press <b>Process</b>. (Both can be made automatic in Defaults.) Otherwise move the ZIP to your PC (Quick Share, Google Drive…) and drop it on the dashboard.</li>
<li>Point your pipeline at <code>images/</code>. These are already sharp, well-spaced keyframes, so skip any "extract frames from video" step.</li>
<li>All photos come from one camera with fixed settings, so treat them as a single camera (e.g. COLMAP <code>--ImageReader.single_camera 1</code>).</li>
<li>If your pipeline only takes video: <code>ffmpeg -framerate 4 -i images/%04d.jpg -c:v libx264 -crf 14 -pix_fmt yuv420p capture.mp4</code></li>
<li><b>Optional (AR mode):</b> <code>poses/</code> contains the phone's camera poses (transforms.json and a COLMAP text model) plus coloured depth points. They are approximate, but can seed or speed up reconstruction of hard, plain-walled rooms.</li>
</ol>`,
  },
  {
    title: 'Club archive standards',
    body: `
<ul>
<li>One capture per room or area; name rooms the way they're signed (e.g. "Room 214", "North Lobby").</li>
<li>Use the same building name every time; the app groups captures by it.</li>
<li>Aim for grade <b>A or B</b> before leaving the room. Use "Done" to check, and keep going if needed.</li>
<li>Write anything unusual in Notes (blinds closed, furniture moved, areas off-limits).</li>
<li>Keep the exported ZIPs. They contain the photos <i>and</i> the metadata (who, when, quality, poses), which is useful for the archive.</li>
</ul>`,
  },
];

export function learnScreen(root, { navigate }) {
  mount(
    root,
    h('div.page',
      h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/'), 'aria-label': 'Back' }, icon('back')), h('h1', 'Capture guide')),
      SECTIONS.map((s) => h('details.card.guide', { open: !!s.open }, h('summary', s.title), h('div.guide-body', { html: s.body }))),
      h('button.btn.primary.block', { onclick: () => navigate('#/new?practice=1') }, 'Try it in the Practice room'),
    ),
  );
}
