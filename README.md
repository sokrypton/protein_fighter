# Protein Fighter

A two-player-vs-CPU fighting game where both fighters are proteins, drawn live by
[py2Dmol](https://github.com/sokrypton/py2Dmol). Every tick the game poses each
protein with a joint rig, writes the new C-alpha coordinates into one py2Dmol
scene, and py2Dmol works out the secondary structure and cartoon from them. Damage
unfolds residues near each impact: their helices and strands come apart on screen
because the geometry that defined them is gone.

The two fighters are different proteins, each other's inside out:

- **P1**, a 379-residue humanoid from `../dance`: a 14-strand β-barrel body, two
  α-helix arms at the chain ends, β-sheet legs with sheet feet, and a small four-helix
  bundle head
- **P2**, a 424-residue helical fighter: an eight-helix bundle body, two β-hairpin arms
  that grow out of the loops on the front helices, a single α-helix for each leg
  hanging from the back helices at the chain ends, finishing in a short helix foot,
  and a small eight-strand β-barrel head on the loop at the back

Both hang off the same joints (hips, knees, ankles, shoulders, elbows, neck) at the same
heights, so one set of moves drives both. And either can be any protein: see *Custom proteins*.

## Play

https://sokrypton.github.io/protein_fighter

## Run locally

No build step. Serve the folder and open it:

```
python3 -m http.server 8000
```

then http://localhost:8000. WebGL2 is required.

## Controls

Pick 1 player (against the CPU), 2 players on one keyboard, or REMOTE: a second device
joins over the network. REMOTE shows a QR code; scan it with a phone (or open the link
it encodes) and the fight starts, that device playing P2 with its on-screen keys or
keyboard. Both devices run the game: the guest's keys act on its own screen at once and
go to the host, and the host, whose judgement of every hit is final, sends a small
packet fifteen times a second (each fighter's state and the springs of its motion,
the HUD, the overlay, and any hits, callouts and sounds since the last one) that keeps
the guest in step. The connection is a WebRTC data channel set up through PeerJS's
public signaling server, direct where it can be and through PeerJS's relays where it
can't, so both devices need internet even on one Wi-Fi; PeerJS and the QR library are
vendored with the page (`vendor/`), so a CDN that is slow or blocked cannot keep the
game from connecting. A status line under the timer shows the packet rate and the
link's state on both sides. A TURN server of your own can be given as
`?turn=turn:host:port&tu=user&tp=password` before pressing REMOTE; the join link carries
it to the guest. A guest that drops without a word (a dead browser, a lost network, a
phone that slept) is noticed by the host within six seconds of silence and its seat
freed, and a guest that stops hearing the host for that long reconnects on its own; the
same link works throughout. PeerJS's own link to its signaling server (a WebSocket
with a heartbeat every five seconds) drops whenever a phone sleeps, a tab goes to the
background or the server hiccups; that is not the game's link, which is a direct
channel between the two browsers and carries on, so such a drop is ridden out and the
peer reconnected under the same id, with a backoff, and the status line says "signal
lost" meanwhile. A join link of the host's stays good across it. A connection that
fails says what the browser saw, and a signaling server that hands out no id within
fifteen seconds is reported rather than waited on. Two computers on home networks
usually connect directly through STUN (Google's and Cloudflare's, so one blocked
somewhere still leaves the other); pairs that need a relay — a phone on cellular data,
a Wi-Fi that isolates its clients (a hotel's, a campus's), or a strict corporate NAT —
get Cloudflare's TURN relay (UDP, TCP, and TLS over 443): its short-lived credentials
come from the worker in `worker/` (deployed at protein-fighter-turn.sokrypton.workers.dev;
`npx wrangler deploy` there after `npx wrangler secret put TURN_KEY_SECRET`), and are
fetched when a connection is about to be made and waited on for up to five seconds, the connection going ahead without them
after that (the status line then says "no relay"). A TURN server of your own can be
supplied instead through `?turn=`, and `?relay=1` allows only the relay. A watcher's link is the join link
with `&watch=1` on the end.

Which arm or leg a strike uses is chosen as it begins: the sounder of the two, or
either at random when they are as sound as each other, so a fighter with one battered
leg kicks with the other and a whole one does not always lead with the same.

| | P1 (left hand) | P2 (right hand) |
| --- | --- | --- |
| move | W A S D | ↑ ← ↓ → |
| punch | F | . (or numpad 1) |
| kick | G | / (or numpad 2) |
| block | H | , (or numpad 3) |

Playing the CPU, both sets drive P1, and J / K / L punch, kick and block as well.

- Walk left and right
- Jump: tap for a short hop, hold for a full jump that clears the other fighter; add a
  direction to jump forward or back
- Crouch
- Block: hold back, away from the other fighter (as Street Fighter has it), or hold the
  block key, which also roots the feet (as Mortal Kombat has it), and a blow is taken on
  the guard: no unfolding, a shove back and a short brace, though a battered arm lets some
  of it through. A low attack gets under a standing guard, so
  block it crouching; an attack from the air comes over a crouching guard, so block it
  standing. The CPU braces now and then too
- Holding forward, punch is a straight with a lunge and kick a roundhouse, the rear leg
  swung round high: slower to come out, harder when they land. The drop kick from a jump
  is the heaviest blow of all, as in Street Fighter
- A special, punch and kick together, once every four seconds, and it differs by
  protein. The barrel's is the barrel roll: it drops onto its side, so the barrel's own
  axis lies across the screen, and rolls along the membrane as the wheel it is; whoever it
  runs over is tripped, flung into a tumble to land in a heap. The bundle's is the helix spin:
  it whirls twice round with both paddles out, ligands flying off their tips, and can catch
  you twice; it shoves hard. The thin meter under each health bar fills as it comes back and lights when it is ready
- A punch or kick pressed while you cannot act (reeling from a blow, braced behind a block,
  still recovering from your own move, or in the freeze as a blow lands) is kept for half a
  second and comes out the moment you are free, read with the directions held then, as a
  fighting game's input buffer has it. So a press timed a little early is not lost, and the
  answer to a blow is the kick you pressed while taking it
- Hits in a row while the other is still reeling count up as a combo, each with its
  damage; the CPU on HARD blocks most of what it sees coming, hits back while you are
  recovering and kicks you out of the air, so a strike thrown over and over is a bad
  idea. EASY and NORMAL are gentler
- The title screen is the character select: the two fighters warm up on the membrane,
  bouncing on their toes and throwing punches and kicks at the air, with a switch under each
  one's feet, BARREL, BUNDLE or CUSTOM; the fighter above swaps as you choose, and a guest
  picks its own. The settings (players, CPU level, colouring) sit in a
  column between them, under START
- Punch and kick change with what you are doing. Crouching they become low attacks,
  which unfold only the legs. In the air they hit from above. Pressing jump and an
  attack together gives the air attack, whichever lands first
- Left alone for two seconds, a protein slowly refolds
- Reading the colours: each protein is coloured by pLDDT, AlphaFold's per-residue
  confidence (dark blue confident, orange disordered). The map under each health bar is
  a PAE plot, computed as AlphaFold defines aligned error: each row lines the protein up
  on one residue (its frame from that alpha carbon and its two neighbours), and each
  column is how far another residue then sits from where the body's undamaged pose has
  it this frame, dark green at 0 Å to white at 30 Å: motion costs nothing, damage shows.
  A stretch that unfolds goes white along its rows but not its columns: lined up on a
  disordered residue, nothing else can be placed, while the folded body still places
  the loose chain roughly where it hangs. It updates live. On a big protein the map is
  at most 64 pixels a side and only every few residues is aligned on (the rows), every
  residue still scored, so the update costs about the same whatever the size; a model
  from the AlphaFold DB has its own PAE drawn underneath as the floor
- Damage is local, and felt by the limb that took it. A hit unfolds a patch around the
  impact, wider for a heavier blow, on the struck side, and deepest where the chain is
  already loose. A leg that has taken the kicks limps: shorter, lower steps, the hips
  dropping onto it, a slower turn, a lower kick; a battered arm punches short and drops
  out of the guard. A protein on bad legs is shoved further, stumbles, and is slower to
  gather itself. A protein whose legs are gone can still fight with its upper body, and
  only a protein unfolded all over is knocked out
- Esc pause

Damage is shown in AlphaFold pLDDT colours: dark blue is intact, orange is
unfolded. The pLDDT each residue shows is real lDDT: for every pair of residues within
15 Å of each other at the bell, whether their distance now is within 0.5, 1, 2 and 4 Å
of what it is in the body's undamaged pose this frame, the four averaged (`lddt.js`, the
Cα definition AlphaFold's pLDDT predicts), smoothed along the chain and over a few
frames so the colours do not flicker. Scored against the pose the rig wants rather
than the stance at the bell, so walking, punching and a bending loop cost nothing and
only what a blow has knocked off the pose counts; scaled by the residue's own pLDDT
where the model came with one, and a residue the model itself had loose shows that
pLDDT, since hanging off the pose is its nature (and so does a body still gathering
itself up at a round's start, which lags the pose for a moment without being hurt). So a struck patch turns orange because
its geometry has gone, and the number on the HUD is the mean. Health is what the protein has left to lose: the built-in fighters start with
nothing loose; a model with low-confidence stretches starts whole in its own natural
state and is knocked out when what it had folded has all come apart. Unfolded residues
are a chain under gravity, and the more a protein has unfolded, the harder each blow
throws that chain around. A knocked-out protein falls apart on the floor, and the next
round it pulls itself back together. Every CA–CA bond is held at its own length in the
scaffold throughout (3.8 Å, or what a real structure's cis peptide has).

Music and effects are synthesised in the browser with WebAudio; SOUND ON/OFF toggles both.

The moon or sun button in the bottom left corner switches between the dark and light
themes, and the COLOUR switch on the title screen picks how the proteins are
coloured: by pLDDT (damage), as a rainbow along the chain, blue at the N-terminus to
red at the C-terminus, which shows how each protein is threaded, or by secondary
structure. Both choices are remembered. Clicking a PAE map lights the two stretches of
residues that pixel scores on the body. The camera follows the fight, closing in when the fighters are close and
pulling back as they part, so the game fits a phone as well as a monitor; on a
touchscreen the on-screen keys are the controls. The button in the bottom right corner
goes full screen, on the phone's side, where the browser allows it (Android, the
desktops); iOS has no full-screen API for a page, and there Add to Home Screen gives
the same: the manifest opens the game full screen in landscape. A phone is drawn lighter to keep
the fight at speed: the cartoon at most thirty times a second while the fight itself
steps at sixty, at a pixel ratio of 1.5 at most, and the PAE maps refreshed a quarter
as often. Everywhere the cartoon is drawn at three subdivisions per helix residue rather
than py2Dmol's default four, a slightly chunkier look at three quarters of the cost
(`?detail=2`, the floor, or `4` on the address to compare). Everywhere, a frame that has fallen behind
steps at most three times to catch up, a moment of slow motion rather than a spiral.
`?fps` on the address shows, under the timer, frames and draws a second and the script
cost of each, to read off a phone.

## Custom proteins

CUSTOM on either fighter's switch opens a small panel (and again, once one is loaded, to choose another). A PDB id fetches the entry from
the RCSB and a UniProt accession the model from the AlphaFold DB, as py2Dmol's own
fetch box takes them (an AlphaFold model comes with its per-residue pLDDT and its PAE);
a PDB or mmCIF file from any predictor can be dropped instead; GFP, hemoglobin,
insulin and ubiquitin are there to try. py2Dmol reads the file, the same
parser the viewer uses, and `custom_pdb.js` makes a fighter of the C-alpha trace:

- stood on its longest axis, whichever way up gives the better body;
- its protruding stretches found (exposed, reaching out beyond the body, running out
  and back at most once, built of helix or strand) and given roles by which way they
  point: up a head, down legs, across arms; the rest is the torso;
- what it lacks grown out of its own chain (legs as a pair, one found alone given up
  and both grown; an arm found alone kept, the other grown to it): every free terminus and every surface
  loop is scored for the limb (for a leg the lowest and the nearest to where a hip
  belongs, a little to its own side of the middle and on the fighting plane, so a long
  body's legs stand close together and its kicks pass its own front; for an arm the
  furthest out at mid height; the second leg a stance's width from the first, and
  which is left and which is right is where they are), a
  terminus with a bonus since continuing a free end adds no cut (a large one for a leg,
  so a free end anywhere in the lower half makes a leg; a modest one for an arm), and
  the best wins; a terminus is continued as an alpha helix, a
  loop extended as a pair of strands, out and back (a leg's two strands sit left and
  right across the body, a pair seen side by side from the front, and lines from the
  side, where the fight is watched); at least one limb takes a
  terminus; a grown limb is built to ideal geometry and carries pLDDT 100; a limb
  grows where its anchor is,
  so a body may come out lopsided, as its shape gives, and each leg is made long enough
  from its own anchor to reach the floor; the two sides need not match;
- its special by its size: up to 250 residues it whirls, the bundle's helix spin (the
  hurricane), above that it has the mass for the heat shock, the wave along the
  membrane; its fold (py2Dmol's own secondary-structure assignment) is read and
  reported;
- a predicted model's pLDDT (read only from a file that says it is a prediction; a
  crystal structure's B-factors are left alone) sets which residues start loose; they
  sit at the model's own coordinates until a blow moves them, and refold back to them.

The protein is never scaled: a scaled protein has bonds that are no longer 3.8 Å, which
py2Dmol draws as coil and the physics pulls apart. The grown legs are sized to the
torso instead. Up to 3000 residues; a body taller than the built-in ones opens the
view out (its head may be clipped a little) and one whose feet stand deep widens the
floor. The card is mostly a preview: the built body as it
will stand, in a viewer of its own with the model's pLDDT colours, turning slowly until
dragged (a file dropped anywhere on the page opens the card and reads it), drawn at one pixel per CSS pixel with a coarse cartoon while the arena holds
still behind the card (py2Dmol keeps one GL canvas per page, the arena's on-page
layer, so the arena's last frame is kept on its own canvas while the preview draws), so a fighter can be looked over; a line under it gives the
name, size, pLDDT and special, and a blue FIGHT appears once a structure is in (a click
on the veil, or Escape, leaves the card). Over a REMOTE link a custom fighter is sent to
the other side when it is chosen, or when a newcomer joins; a guest loads its own.

Begun by Ian Anderson (github.com/ianandersonlol/protein_fighter): the parsing, the
orientation, the arm search, the helix legs, the floating body and the signature moves
were his; what stands now reads through py2Dmol, finds a whole armature and grows the
rest from the chain, and fights with the game's own specials.

## Files

- `index.html` — page, HUD, styles
- `game.js` — combat, CPU, damage and unfolding, the body physics, PAE, sound, and the
  py2Dmol scene
- `net.js` — remote play: the PeerJS connection and the QR code; the state packets and
  the guest's drawing are in `game.js`
- `motion.js` — how a fighter moves, in one pass: pose on springs, hips, planted feet that
  step, two-bone leg IK, then the rig; the arms, head and shins swing on their own
  springs, and a blow jolts them
- `rig.js` — forward kinematics for either protein: rigid domains on joints, arms
  hinged at the elbow, hinge loops relaxed (from `../dance`)
- `rig_data.js` — the humanoid's C-alpha scaffold, joint pivots and rigid domains,
  generated by `scripts/build_barrel_fighter.py`, a self-contained port of humanoid v8
  from `../dance` (it also writes `scripts/barrel_fighter.pdb`)
- `rig_data_helix.js` — the same for the helical fighter, generated by
  `scripts/build_helix_fighter.py` (and `scripts/helix_fighter.pdb`). Rerun a builder
  after changing its design
- `tests/rig_pose.js`, `tests/secondary_structure.js` — run with `node`: the first
  poses both rigs through the game's motion and checks every CA–CA bond and rigid
  domain holds; the second runs py2Dmol's own secondary-structure assignment over each
  scaffold and checks that helices read as helix and sheets as strand
- `custom_pdb.js` — any protein as a fighter: py2Dmol reads it, its limbs are found and the
  missing ones grown from its chain, its special chosen by its fold, and the fetch by id
  (see *Custom proteins*); `lddt.js` — lDDT on alpha carbons, prepared once from the stance
  and scored each PAE update
- `tests/custom_rig.js` — run with `node`: GFP, hemoglobin and FUS (AlphaFold models in
  `tests/structures/`, from Ian Anderson's fork) and the built-in scaffolds as
  files, read, rigged and posed through a punch, a kick and a walk, every bond held,
  the legs on the floor; PDB and mmCIF agree; chain breaks, the size limit and the lDDT
- `tests/play_custom.js` — GFP dropped as a file in headless Chrome: read, rigged, fought, rolled
- `tests/play.js` — plays the game in headless Chrome: a fight against the CPU with a
  walk, a block, strikes, a heat shock, a throw and a PAE click, checking each registered
  and nothing threw; `--remote` runs a host and a guest in two browsers over PeerJS, knocks P2 out and
  checks the guest sees the round's end with no button of its own (the host refolds, and
  the guest is told so) and the host's REFOLD moves both on, drops the host's
  signaling socket mid-match and checks the match goes on, the peer comes back under the
  same id and a watcher can still join on the same link; `--remote --relay` allows both
  sides only the relay and checks the route taken is relay to relay, so the worker and
  Cloudflare's TURN are what is tested. Chrome runs muted. A
  minute or two, since the browser draws with software OpenGL
- `cell.js` — the cell behind the fight and the effects over it: membrane, vesicles, a
  mitochondrion, ribosomes, microtubules, shadows, sparks, ligands, footfall ripples,
  all drawn to the game's camera

The walk in `game.js` is learned from `../dance/humanoid_v8_walk.pdb` (CMU mocap 07_01
retargeted onto this rig): each thigh and shin's pitch over a stride, reduced to three
harmonics and driven by distance walked so the feet don't skate.
- `vendor/peerjs.min.js` (PeerJS 1.5.5, MIT) and `vendor/qrcode.js` (qrcode-generator
  1.4.4, MIT) — the connection and the QR code, vendored so the game does not depend on
  a CDN to connect.
- `vendor/py2Dmol.embed.min.js` — py2Dmol's embed bundle, byte-identical to the build in
  `../py2Dmol/py2Dmol/resources/bundles/` at its commit `c426f34`. It carries the change
  that lets `replaceFrame` animate without rebuilding the cartoon mesh (the camera and
  extent are held across same-size frames, and the mesh is updated in place: the
  "station" draw the game switches on), the fix for ribbon loops flickering as they
  move (each quad split along its shorter diagonal), and the rule that with the camera
  pinned a growing extent is not a rebuild (before it, the first jump of a round and the
  fighters walking apart each cost a full rebuild, a hitch of 50–95 ms), and that a run
  of frames whose geometry keeps changing no longer retires the in-place path for good,
  and direct presentation, py2Dmol's default since that commit: its WebGL canvas sits in
  the page under its own canvas instead of being copied into it every frame, which on a
  phone was three passes over the whole screen per frame, and a bare embed that follows
  its element's size, so a resize redraws at the new size the same frame instead of the
  game rebuilding the viewer after it, and `py2Dmol.paeFromJSON`, the reader for a model's
  PAE JSON

To update py2Dmol, copy a newer `py2Dmol.embed.min.js` over the vendored one.
