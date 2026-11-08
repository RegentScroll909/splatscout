# SplatScout Club (beta): brief for the club advisor

**In one line:** a closed beta that lets club members scan shared campus spaces with their phones, one room or
area at a time, so the club can build a 3D map of campus from many people's scans. A club member reviews every
3D model before anyone sees it. Points, missions and a leaderboard make it a friendly competition.

## Why full scans, not single photos

The 3D models (Gaussian splats) need one consistent scene: one lighting, one arrangement of the furniture, and
overlapping photos from planned spots all around the space. An earlier version of the beta collected single
photos from many people instead. That was retired: photos taken by different people at different times mix
daylight, lamps and moved chairs into blotchy, ghosted models, and photos taken here and there rarely cover a room
well (a room needs about 100–200 overlapping photos). A full scan with the app's capture coach takes one person
10–20 minutes and produces exactly that consistent set, graded A to F as it goes.

## What works today

On the phone (the SplatScout web app):
- **Join** with an invite code, a handle (shown on the leaderboard) and by agreeing to the rules.
- **Scan** a space with the capture coach: pick the building (GPS suggests it, you confirm), floor and room, then
  follow the guide. The coach grades the scan; **only scans graded B or better can be sent** (the database refuses
  anything else).
- **Club screen**: your points and rank, the leaderboard (this week / all time), missions ("Scan the Hayden reading
  room, +15") with a *Scan here* button, and what happened to each scan you sent. **Leave the club** deletes
  everything you sent.
- **Campus map**: ASU's buildings coloured by how much of their floor area the club's approved models cover, and
  which spaces still need a scan.

On the club PC (SplatStation, pages only that PC can open):
- **Import** a member's scan: it becomes a capture the existing pipeline turns into a 3D model (10–25 minutes).
- **Review**: a club member looks at the finished model, in the viewer and placed among the building's other models,
  and **approves** it (it goes on the campus map and the member gets their points) or **doesn't** (the member sees
  the reason in the app; nothing goes on the map).
- **Missions**, **invite codes**, member pause/rename/remove, and the list of off-limits buildings.
- **Campus page**: every building's coverage (as a share of its floor area), floor by floor, with where the photos
  of each model were taken.

## How a scan travels

phone camera and AR tracking → graded by the coach on the phone → sent over HTTPS to the club's private database
(Supabase) → downloaded by the club PC → built into a 3D model → looked at by a club member → **approved** (on the
campus map, points for the member) or **not approved** (off the map, with a reason).

## Safeguards built in

| Concern | What the beta does |
|---|---|
| Who can take part | Invite code, handle and agreed rules. The database accepts nothing from anyone else, and a stranger can't even read the leaderboard. Codes are limited in uses and can be switched off. |
| Where people may scan | Residence halls and housing, health and counseling, police and courts, and children's centers can't be picked in the app, and the database refuses them even if someone bypasses the app. The list comes from OpenStreetMap's building types, and the club can add or remove any building. The rules also exclude restrooms, locker rooms, labs, offices and classes in session. |
| People in scans | Rules say no people (pause until they've gone). **Every model is checked by a person before it is published**: one showing someone isn't approved. There is no automatic face detection or blurring yet. |
| Screens and documents | Rules say to keep them out of view; checked in the same human review. |
| Privacy of the files | Scans go to a private bucket. A phone can read, add and delete only its own. Photos carry no GPS or camera metadata inside the files; the GPS reading, building, room and phone model are stored in the database row. |
| Withdrawing | Any member can delete all of their scans and profile from the Club screen. The club can also remove a member and everything they sent. Models already built from a scan are not undone automatically (the consent text says so). |
| Cheating | Points are only ever set by the club PC, when a person approves a model: a phone can't give itself points or approve itself. Only scans graded B or better can be sent; re-scanning a space already on the map as Good earns little unless a mission asks for it. |
| Admin access | The database's secret key lives only on the club PC, and the admin tools answer only that PC (not other devices on the Wi-Fi). |
| Spam and storage | Closed beta; storage on the free plan is about 1 GB (a few scans at a time), and scans move off the cloud to the PC once imported. |

The database rules are tested on a real PostgreSQL (who can add what, scans only and graded B or better, points
only from the club PC, members-only views, bans, leaving) and the apps by 64 automated checks.

## What we need from you (decisions, not code)

1. **Permission and scope.** May club members scan shared interior spaces of campus buildings for this purpose? Is
   there anywhere ASU wants excluded beyond the default list? Who at ASU should be told?
2. **Consent and rules wording.** The text in the app is a draft, marked as one (`app/js/core/clubrules.js`). It
   should say who owns the scans and models, how models may be shown, how long data is kept, and how to withdraw.
3. **People and faces.** Is human review of every model enough for a closed beta of club members? What is required
   before the beta is opened more widely (automatic face blurring, a privacy review, minors on campus)?
4. **The competition.** Do prizes or public rankings need approval? Should membership be limited to people with an
   asu.edu address? (Accounts today are anonymous plus a handle and invite code, so clearing a phone's browser data
   loses the account and its points; asu.edu verification is not built.)
5. **Where the data lives.** Free Supabase plan today. For the long term: ASU storage, and a faculty sponsor for
   the ASU supercomputer account (Sol's scratch space is cleared after about 30 days, so it is not an archive).
6. **Who administers.** Whoever holds the PC with the secret key can see every scan and approves what is
   published. Who should that be?

## Known limits (honest list)

- **Phone tracking slips at plain walls.** Scans can lose their place in front of blank walls; work is under way
  so a scan carries on as a second part that the club PC joins up, and the coach warns earlier. Painter's tape or
  sticky notes on long blank stretches help (and show in the model).
- **Fewer, bigger contributions.** A scan takes 10–20 minutes, so fewer people will contribute than with quick
  photos; missions point them at the spaces the map needs.
- **Review is manual**, about a few minutes per model; it fits a club beta, not thousands of scans.
- **GPS indoors** is often off by 10–50 m and can't tell floors apart, so it only suggests the building; floor and
  room are typed by the member.
- **Two kinds of identity gaps:** handles are not checked against real people, and a handle can't be recovered on
  a new phone.

## Suggested pilot

Club members only, one or two buildings, a few weeks. Measure: how many scans are sent and approved, how long review
takes, how much of each building's floor area the approved models cover, and how good they are (the PC measures
each model's quality on photos held back from training). Then decide on asu.edu login, automatic face detection and
blurring, ASU storage, and processing on the supercomputer.

## Demo script (about 5 minutes, plus a model built beforehand)

Before: SplatStation running on the PC with the club key set up; the app open on a phone; an invite code made on
SplatStation's **Club** page (**Members and invites → New code**); one member's scan already imported and built.

1. **Phone:** Club → Join (handle, invite code, tick the rules). Point out the rules and the draft consent.
2. **Phone:** Start a scan → *Find my building* → pick the room → follow the coach for a minute. Show the grade on
   the review screen, that **Upload to the club** only appears at B or better, and that a residence hall can't be
   chosen.
3. **PC:** Club page → **Scans** → the built model → **View the splat** and **Place it in the building** → **Approve**
   (the button shows the points: grade, new floor area, mission). Turn another one down to show the reason list.
4. **Phone:** Club screen: points, rank and the leaderboard update; *My scans* shows the approval, and the reason for
   the one turned down. Campus map: the space is now on the map.
5. **PC:** add a **mission** ("Scan the reading room"), then show it on the phone with its *Scan here* button.
