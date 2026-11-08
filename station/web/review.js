// The building view's review hook. building.html?code=<building>&review=<library path> opens a finished splat among
// its placed neighbours with Approve and Reject buttons; pressing one calls decide() with:
//   {decision: 'approve' | 'reject', key (library path), code (ASU building), room, placement ({s, theta, e, n, floor, dh},
//    already saved in campus.json when approving), reason (reject only, may be '')}
// It answers {ok, message?, next?}: ok false (or a thrown Error) shows the message and leaves the buttons on;
// next is a URL to open afterwards.
//
// Wired to the club's review queue (station/lib/clubapi.mjs, the same as the Club page's buttons): the member's
// scan whose splat this is gets approved (its points, and the splat on the campus map) or not, with the reason.
// A splat made from your own scan has nothing to approve: it is on the campus map as it is.

const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `error ${r.status}`);
  return j;
};

export async function decide(detail) {
  const { scans, configured, error } = await api('/api/club/scans');
  if (configured === false) return { ok: false, message: error || 'The club database isn’t set up on this PC.' };
  const scan = (scans || []).find((x) => x.splat && x.splat.path === detail.key);
  if (!scan) return { ok: true, message: 'This splat is from your own scan: it counts on the campus map as it is.' };
  if (detail.decision === 'approve') {
    const r = await api('/api/club/scan', { op: 'approve', id: scan.id });
    return { ok: true, message: `Approved: @${scan.handle} gets ${r.points} points, and the splat is on the campus map.`, next: 'club.html' };
  }
  await api('/api/club/scan', { op: 'reject', id: scan.id, note: (detail.reason || '').trim() || 'Not approved' });
  return { ok: true, message: `Not approved: @${scan.handle} sees why in the app.`, next: 'club.html' };
}
