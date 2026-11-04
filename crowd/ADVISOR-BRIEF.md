# SplatScout Club (beta): brief for the club advisor

**In one line:** a closed beta that lets club members contribute sharp photos of shared campus spaces from their
phones, tagged by building, floor and room, so the club can build 3D models of campus from many people's photos.
Points, missions and a leaderboard make it a friendly competition.

## Why this exists

A full scan of one room by one person takes 10–20 minutes, so few people will do it. A single photo takes seconds.
The 3D models (Gaussian splats) need photos that overlap, are sharp, and are filed by where they were taken, and
they look best when a room is covered in several kinds of light (morning, afternoon, evening, night), which one
person on one visit can't do. Many people each adding a few photos can.

## What works today

On the phone (the SplatScout web app):
- **Join** with an invite code, a handle (shown on the leaderboard) and by agreeing to the rules.
- **Take photos**: pick the building (GPS suggests it, you confirm), floor and room, then shoot. A photo that is
  blurry, too dark or almost the same as one just taken is not kept. Camera only, no gallery uploads.
- Photos are saved on the phone first and sent in the background, so it works with a poor signal.
- **Club screen**: your points and rank, the leaderboard (this week / all time), missions, and what happened to
  each photo you sent. **Leave the club** deletes everything you sent.

On the club PC (SplatStation, a page only that PC can open):
- **Sync** downloads new photos and checks each one (size, sharpness, light, duplicates, GPS far from the
  building, wrong phone clock) for a first opinion. A person then looks at each thumbnail and accepts or rejects.
- **Accepting awards points**; **rejecting deletes the photo** here and in the cloud, with a reason shown to the
  member.
- **Missions** ("Hayden lobby, evening light, +3 per photo"), **invite codes**, member pause/rename/remove, and the
  list of off-limits buildings.
- **Build a capture**: the accepted photos of one room become a capture that the existing pipeline turns into a
  3D model. Tested up to the capture appearing in *Ready to process*; training a model from real club photos of a
  room has not been tried yet (see limits).

## How a photo travels

phone camera → checked on the phone → saved on the phone → sent over HTTPS to the club's private database
(Supabase) → downloaded by the club PC → looked at by a club member → **accepted** (stays on the club PC, earns
points) or **rejected** (deleted everywhere) → accepted photos of a room become a 3D model on the club PC.

## Safeguards built in

| Concern | What the beta does |
|---|---|
| Who can take part | Invite code, handle and agreed rules. The database accepts nothing from anyone else, and a stranger can't even read the leaderboard. Codes are limited in uses and can be switched off. |
| Where people may photograph | Residence halls and housing, health and counseling, police and courts, and children's centers can't be picked in the app, and the database refuses them even if someone bypasses the app. The list comes from OpenStreetMap's building types, and the club can add or remove any building. The rules also exclude restrooms, locker rooms, labs, offices and classes in session. |
| People in photos | Rules say no people. **Photos are checked by a person, not by software**: a photo showing someone is rejected and deleted. There is no automatic face detection or blurring yet. |
| Screens and documents | Rules say to keep them out of frame; checked in the same human review. |
| Privacy of the files | Photos go to a private bucket. A phone can read, add and delete only its own. Photos carry no GPS or camera metadata inside the file; the GPS reading, building, room and phone model are stored in the database row. |
| Withdrawing | Any member can delete all of their photos, scans and profile from the Club screen. The club can also remove a member and everything they sent. Models already built from a photo are not undone automatically (the consent text says so). |
| Cheating | Points are only ever set by the club PC, after a person has looked: a phone can't give itself points. Near-duplicates, GPS far from the building, and a wrong phone clock are flagged. Base points stop at 100 a day; a phone can add at most 400 photos a day. |
| Admin access | The database's secret key lives only on the club PC, and the admin tools answer only that PC (not other devices on the Wi-Fi). |
| Spam and storage | Closed beta; per-phone daily limit; storage on the free plan is about 1 GB (roughly 2,000 photos), and accepted photos can be moved off the cloud to the PC. |

The database rules are tested on a real PostgreSQL (who can add what, points only from the club PC, members-only
views, the daily limit, bans, leaving) and the apps by 50 automated checks. The beta is also installed on the
club's own database, where a full run passed: a stranger turned away, joining with an invite code, photos sent
through the app's queue, a restricted building refused, review and points on the club PC, and leaving the club
deleting everything.

## What we need from you (decisions, not code)

1. **Permission and scope.** May club members photograph shared interior spaces of campus buildings for this
   purpose? Is there anywhere ASU wants excluded beyond the default list? Who at ASU should be told?
2. **Consent and rules wording.** The text in the app is a draft, marked as one (`app/js/core/clubrules.js`). It
   should say who owns the photos and models, how models may be shown, how long data is kept, and how to withdraw.
3. **People and faces.** Is human review enough for a closed beta of club members? What is required before the
   beta is opened more widely (automatic face blurring, a privacy review, minors on campus)?
4. **The competition.** Do prizes or public rankings need approval? Should membership be limited to people with an
   asu.edu address? (Accounts today are anonymous plus a handle and invite code, so clearing a phone's browser data
   loses the account and its points; asu.edu verification is not built.)
5. **Where the data lives.** Free Supabase plan today. For the long term: ASU storage, and a faculty sponsor for
   the ASU supercomputer account (Sol's scratch space is cleared after about 30 days, so it is not an archive).
6. **Who administers.** Whoever holds the PC with the secret key can see every photo. Who should that be?

## Known limits (honest list)

- **Single photos alone don't make a splat indoors.** A room needs roughly 100 or more overlapping photos from
  several spots. The beta's missions ask for specific views to help, but how many people it takes per room is
  exactly what a pilot would measure. Outdoor spaces and busy lobbies are the likely first successes.
- **Tested on a computer, not yet on real phones.** The camera, GPS and sending were exercised with a synthetic
  camera and a stand-in database in a desktop browser; the database was tested separately on PostgreSQL. A real
  phone test (indoor GPS accuracy, camera behavior, battery, iPhone) is the first thing to do in the pilot.
- **Photos taken in different light or with moved furniture** are kept as separate light slots; nothing yet
  combines them smartly. Building from a single light slot is the safe default.
- **Review is manual**, so it fits tens to a few hundred photos a day, not thousands.
- **GPS indoors** is often off by 10–50 m and can't tell floors apart, so it only suggests the building; floor and
  room are typed by the member.
- **Two kinds of identity gaps:** handles are not checked against real people, and a handle can't be recovered on
  a new phone.

## Suggested pilot

Club members only, one or two buildings, a few weeks. Measure: how many photos are accepted, how long review takes,
how many rooms reach 100+ photos, and how good the resulting models are. Then decide on asu.edu login, automatic
face detection and blurring, ASU storage, and processing on the supercomputer.

## Demo script (about 5 minutes)

Before: SplatStation running on the PC with the club key set up; the app open on a phone; an invite code made on
SplatStation's **Club** page (**Members and invites → New code**).

1. **Phone:** Club → Join (handle, invite code, tick the rules). Point out the rules and the draft consent.
2. **Phone:** Take photos → *Find my building* → pick the room → shoot a few. Show the ring (green when steady),
   hold the phone shaking to show a blurry photo being refused, shoot the same spot twice to show the duplicate
   warning, and try a residence hall to show it can't be chosen.
3. **PC:** Club page → **Sync photos** → look at the thumbnails → **Accept**. Reject one to show the reason list
   and that the photo is deleted.
4. **Phone:** Club screen: points, rank and the leaderboard update; the rejected photo shows why.
5. **PC:** add a **mission** ("evening light"), then show it on the phone. Make a second member on another device
   to show the leaderboard.
6. **PC:** for a room with 10+ accepted photos, **Build a capture** and show it in *Ready to process* on the
   dashboard. Show a finished splat made earlier (training takes 10–25 minutes).
