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
heights, so one set of moves drives both.

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
can't, so both devices need internet even on one Wi-Fi; the page loads PeerJS and a QR
library from unpkg. A status line under the timer shows the packet rate and the
link's state on both sides. A TURN server of your own can be given as
`?turn=turn:host:port&tu=user&tp=password` before pressing REMOTE; the join link carries
it to the guest. A guest that drops without a word (a dead browser, a lost network, a
phone that slept) is noticed by the host within six seconds of silence and its seat
freed, and a guest that stops hearing the host for that long reconnects on its own; the
same link works throughout. A connection that fails says what the browser saw. Two computers on
home networks usually connect directly through STUN; a phone on cellular data, or a
strict corporate NAT, needs a relay, and PeerJS's public relay hands out no relay
candidates any more (measured September 2026), so those pairs need a TURN server of
your own through `?turn=`.

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
  bouncing on their toes and throwing punches and kicks at the air, with a switch over each
  head, BARREL or BUNDLE; the fighter below swaps as you choose, and a guest picks its own. The settings (players, CPU level, colouring) sit in a
  column between them, under START
- Punch and kick change with what you are doing. Crouching they become low attacks,
  which unfold only the legs. In the air they hit from above. Pressing jump and an
  attack together gives the air attack, whichever lands first
- Left alone for two seconds, a protein slowly refolds
- Reading the colours: each protein is coloured by pLDDT, AlphaFold's per-residue
  confidence (dark blue confident, orange disordered). The map under each health bar is
  a PAE plot, computed as AlphaFold defines aligned error: each row lines the protein up
  on one residue (its frame from that alpha carbon and its two neighbours), and each
  column is how far another residue then sits from where it was at the start of the
  round, dark green at 0 Å to white at 30 Å. A limb that swings lights up against the
  body. A stretch that unfolds goes white along its rows but not its columns: lined up on
  a disordered residue, nothing else can be placed, while the folded body still places
  the loose chain roughly where it hangs. It updates live
- Damage is local, and felt by the limb that took it. A hit unfolds a patch around the
  impact, wider for a heavier blow, on the struck side, and deepest where the chain is
  already loose. A leg that has taken the kicks limps: shorter, lower steps, the hips
  dropping onto it, a slower turn, a lower kick; a battered arm punches short and drops
  out of the guard. A protein on bad legs is shoved further, stumbles, and is slower to
  gather itself. A protein whose legs are gone can still fight with its upper body, and
  only a protein unfolded all over is knocked out
- Esc pause

Damage is shown in AlphaFold pLDDT colours: dark blue is intact, orange is
unfolded. Unfolded residues are a chain under gravity, and the more a protein has
unfolded, the harder each blow throws that chain around. A knocked-out protein falls
apart on the floor, and the next round it pulls itself back together. CA–CA bonds are
held at 3.8 Å throughout.

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
steps at sixty, at a pixel ratio of 1.5 at most, with three subdivisions per helix
residue instead of four (`?detail=2` or `4` on the address to try others), and the
PAE maps refreshed a quarter as often. Everywhere, a frame that has fallen behind
steps at most three times to catch up, a moment of slow motion rather than a spiral.
`?fps` on the address shows, under the timer, frames and draws a second and the script
cost of each, to read off a phone.

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
- `tests/play.js` — plays the game in headless Chrome: a fight against the CPU with a
  walk, a block, strikes, a heat shock, a throw and a PAE click, checking each registered
  and nothing threw; `--remote` runs a host and a guest in two browsers over PeerJS. A
  minute or two, since the browser draws with software OpenGL
- `cell.js` — the cell behind the fight and the effects over it: membrane, vesicles, a
  mitochondrion, ribosomes, microtubules, shadows, sparks, ligands, footfall ripples,
  all drawn to the game's camera

The walk in `game.js` is learned from `../dance/humanoid_v8_walk.pdb` (CMU mocap 07_01
retargeted onto this rig): each thigh and shin's pitch over a stride, reduced to three
harmonics and driven by distance walked so the feet don't skate.
- `vendor/py2Dmol.embed.min.js` — py2Dmol's embed bundle, byte-identical to the build in
  `../py2Dmol/py2Dmol/resources/bundles/` at its commit `4a45940`. It carries the change
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
  game rebuilding the viewer after it

To update py2Dmol, copy a newer `py2Dmol.embed.min.js` over the vendored one.
