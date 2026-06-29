// Two-terminal animated demo for mesh landing page.
//
// Alice and Bob run side-by-side. The choreography shows the full workflow:
//   1. Both init and start mesh in parallel
//   2. Alice adds a repo
//   3. Alice runs mesh invite → token appears
//   4. Bob runs mesh join <token> → handshake → both configs updated
//   5. Bob clones and pushes; Alice's node syncs in real time

(function () {
  const elAlice = document.getElementById("term-alice");
  const elBob   = document.getElementById("term-bob");
  if (!elAlice || !elBob) return;

  // ── Terminal class ────────────────────────────────────────────────────────
  // Each instance manages one terminal element: fixed-height, lines scroll up.

  class Terminal {
    constructor(el) {
      this.el = el;
      this._cursor = null;
    }

    // Append a line div, trim overflow from the top.
    addLine(cls, text) {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      this.el.appendChild(div);
      this._trim();
      return div;
    }

    // Append a blank spacer.
    blank() { this.addLine("t-out", ""); }

    clear() {
      while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    }

    _trim() {
      while (this.el.scrollHeight > this.el.clientHeight && this.el.firstChild) {
        this.el.removeChild(this.el.firstChild);
      }
    }

    // Attach blinking cursor to a target element.
    _attachCursor(target) {
      this._detachCursor();
      this._cursor = document.createElement("span");
      this._cursor.className = "t-cursor";
      target.appendChild(this._cursor);
    }

    _detachCursor() {
      if (this._cursor) { this._cursor.remove(); this._cursor = null; }
    }

    // Type text character by character into el, trimming after each char.
    async _type(target, text, speed) {
      for (const ch of text) {
        if (this._cursor) {
          target.insertBefore(document.createTextNode(ch), this._cursor);
        } else {
          target.appendChild(document.createTextNode(ch));
        }
        this._trim();
        await sleep(speed + (Math.random() * speed * 0.5 | 0));
      }
    }

    // Render a prompt + command line, type the command, then run outputFn.
    async cmd(prompt, command, speed, outputFn) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:0.5ch;flex-wrap:nowrap";

      const pEl = document.createElement("span");
      pEl.className = "t-prompt";
      pEl.textContent = prompt;
      pEl.style.flexShrink = "0";

      const cEl = document.createElement("span");
      cEl.className = "t-cmd";
      cEl.style.cssText = "word-break:break-all";

      row.appendChild(pEl);
      row.appendChild(cEl);
      this.el.appendChild(row);
      this._trim();

      this._attachCursor(cEl);
      await sleep(140);
      await this._type(cEl, command, speed);
      this._detachCursor();
      await sleep(180);

      if (outputFn) await outputFn();
    }

    // Output a line after an optional delay.
    async out(cls, text, delay = 0) {
      if (delay) await sleep(delay);
      this.addLine(cls, text);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const TOKEN = "mesh1.AWGIIEfuVOW-fQAj9MFohqaB" +
                "AGstU2_aGWKnjH222CdMk6Kocq1bXi";

  // ── choreography ──────────────────────────────────────────────────────────

  async function runDemo(alice, bob) {
    alice.clear();
    bob.clear();

    // ── Phase 1: both init + start in parallel ───────────────────────────
    await Promise.all([
      alice.cmd("alice ~ $", "mesh init", 60, async () => {
        await alice.out("t-out", "generating ed25519 keypair...", 220);
        await alice.out("t-success", "✓  mesh initialized", 100);
      }),
      (async () => {
        await sleep(300); // Bob starts a beat later
        await bob.cmd("bob ~ $", "mesh init", 60, async () => {
          await bob.out("t-out", "generating ed25519 keypair...", 220);
          await bob.out("t-success", "✓  mesh initialized", 100);
        });
      })(),
    ]);

    await sleep(300);

    await Promise.all([
      alice.cmd("alice ~ $", "mesh start", 60, async () => {
        await alice.out("t-out", "listening on https://localhost:7979", 300);
        await alice.out("t-success", "✓  mesh running", 80);
      }),
      (async () => {
        await sleep(200);
        await bob.cmd("bob ~ $", "mesh start", 60, async () => {
          await bob.out("t-out", "listening on https://localhost:7979", 300);
          await bob.out("t-success", "✓  mesh running", 80);
        });
      })(),
    ]);

    await sleep(400);

    // ── Phase 2: Alice adds repo ─────────────────────────────────────────
    await alice.cmd("alice ~ $", "mesh add-repo api ~/src/api", 48, async () => {
      await alice.out("t-out", "mirroring → ~/.mesh/repos/api.git", 380);
      await alice.out("t-success", "✓  api added (12 commits)", 150);
    });

    await sleep(400);

    // ── Phase 3: Alice invites ───────────────────────────────────────────
    await alice.cmd("alice ~ $", "mesh invite", 60, async () => {
      await alice.out("t-out", "token (expires in 10 min):", 280);
      await alice.out("t-success", TOKEN, 80);
      alice.blank();
    });

    await sleep(350);

    // Bob idles while Alice's token is visible — then joins
    // Show Bob starting to type, Alice's terminal calm

    // ── Phase 4: Bob joins — the handshake moment ─────────────────────────
    await bob.cmd("bob ~ $", "mesh join " + TOKEN, 22, async () => {
      await bob.out("t-out", "verifying token...", 300);
      await bob.out("t-out", "connecting to alice (192.168.1.12:7979)...", 350);
      await bob.out("t-out", "exchanging pubkeys...", 300);
      bob.blank();

      // Alice's node reacts while Bob's output is still coming in
      const aliceNotify = (async () => {
        await sleep(100);
        await alice.out("t-info", "← bob joined the mesh", 0);
        await alice.out("t-success", "✓  bob added to mesh.toml", 120);
      })();

      await bob.out("t-success", "✓  alice added to mesh.toml", 0);
      await bob.out("t-out", "syncing api.git  ████████████  100%", 400);
      await bob.out("t-success", "✓  connected  (1 peer, 1 repo)", 150);
      bob.blank();

      await aliceNotify;
    });

    await sleep(450);

    // ── Phase 5: Bob clones and pushes ───────────────────────────────────
    await bob.cmd("bob ~ $", "git clone https://localhost:7979/api.git", 36, async () => {
      await bob.out("t-out", "Cloning into 'api'...", 280);
      await bob.out("t-out", "Receiving objects: 100% (47/47), done.", 320);
      await bob.out("t-success", "✓  cloned", 80);
    });

    await sleep(350);

    await bob.cmd("bob ~/api $", "git push origin main", 48, async () => {
      await bob.out("t-out", "Enumerating objects: 3, done.", 280);
      await bob.out("t-out", "Writing objects: 100% (3/3), done.", 200);
      await bob.out("t-success", "✓  refs/heads/main → mesh", 100);
      bob.blank();

      // Alice's node syncs while Bob finishes
      const aliceSync = (async () => {
        await sleep(200);
        await alice.out("t-info", "← push from bob (api/main)", 0);
        await alice.out("t-success", "✓  synced 3 new commits", 180);
      })();

      await bob.out("t-info", "  gossip: notifying peers...", 350);
      await bob.out("t-success", "  ✓  alice's node synced", 500);

      await aliceSync;
    });

    await sleep(2500);
  }

  // ── loop ──────────────────────────────────────────────────────────────────

  const alice = new Terminal(elAlice);
  const bob   = new Terminal(elBob);

  async function loop() {
    await sleep(500);
    while (true) {
      await runDemo(alice, bob);
    }
  }

  loop();
})();
