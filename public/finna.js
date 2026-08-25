/* FINNA — the FinGuard copilot's face.
 *
 * A small animated SVG character that sits beside the assistant's answers and
 * reacts to what the copilot is doing: idling while it waits, thinking while a
 * question is in flight, and talking while an answer is being read out onto the
 * page.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * The look and the state vocabulary (idle / thinking / blink / alert) are taken
 * from `bloub`, an animated SVG avatar by Jérémy (@worlz_), MIT licensed:
 *     https://github.com/jeremy-prt/bloub
 * bloub is Vue 3 + Vite + TypeScript + Tailwind. This app is plain browser JS
 * with no bundler and a CSP of `script-src 'self'`, so a drop-in was not
 * possible; this is an independent implementation in the app's own idiom, and
 * the geometry here is written from scratch rather than copied. Credit belongs
 * upstream.
 *
 * ── Why a character at all ───────────────────────────────────────────────────
 * The copilot can take several seconds to answer, and a silent pane reads as a
 * broken one. Finna makes the wait legible: thinking is visibly different from
 * finished, and from failed.
 *
 * ── What it must never do ────────────────────────────────────────────────────
 * Finna is decoration over a state machine, and states come from what the
 * REQUEST is actually doing — never from a timer that guesses. She must not
 * imply an answer exists before one does, and she must not keep "talking" after
 * a request has failed: `error` is a real state with its own face, because a
 * cheerful avatar over a failed request is a small lie about the system.
 */
(function (global) {
  "use strict";

  var VIEW = 316;                 // viewBox is -158 -158 316 316, as in bloub
  var R = 100;                    // body radius within that box

  /* Respect the OS setting. An avatar that bobs and blinks forever is exactly
     the kind of motion people disable for vestibular reasons, and the states
     still read perfectly well when they are static. */
  function reducedMotion() {
    return global.matchMedia
      && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  var STATES = ["idle", "thinking", "speaking", "happy", "error"];

  /* MOUTH SHAPES ARE SET FROM JS, NOT CSS.
     `d` is a real CSS property and Chromium reports CSS.supports('d', ...) as
     true, but a stylesheet `d` did not win over the element's own presentation
     attribute here — every state rendered the same mouth while the eyes and
     colour changed correctly. Rather than depend on that resolving the way the
     spec suggests, the attribute is written directly: it works in every engine
     and there is one obvious place to look when a face is wrong. */
  var MOUTHS = {
    idle:     "M-26 46 Q0 64 26 46",
    thinking: "M-16 50 Q0 50 16 50",     // a flat, preoccupied line
    speaking: "M-24 44 Q0 70 24 44",     // open
    speaking2:"M-22 46 Q0 54 22 46",     // half-closed, alternated while talking
    happy:    "M-28 42 Q0 76 28 42",
    error:    "M-24 56 Q0 40 24 56"      // turned down
  };

  /**
   * A pebble body: a circle with gentle, fixed asymmetry so it reads as a
   * character rather than a dot. Built from four cubic segments; the `squish`
   * factor lets the caller flatten it slightly for a "breathing" pose.
   */
  function bodyPath(squish) {
    var k = 0.5523;               // circle-to-bezier constant
    var rx = R * (1 + squish * 0.06);
    var ry = R * (1 - squish * 0.06);
    var cx = rx * k;
    var cy = ry * k;
    // Slight lopsidedness, so the silhouette is a pebble and not a ball.
    var lift = R * 0.04;
    return "M0 " + (-ry) +
      "C" + cx + " " + (-ry) + " " + rx + " " + (-cy - lift) + " " + rx + " 0" +
      "C" + rx + " " + cy + " " + cx + " " + ry + " 0 " + ry +
      "C" + (-cx) + " " + ry + " " + (-rx) + " " + cy + " " + (-rx) + " 0" +
      "C" + (-rx) + " " + (-cy + lift) + " " + (-cx) + " " + (-ry) + " 0 " + (-ry) + "Z";
  }

  var uid = 0;

  function create(options) {
    var opts = options || {};
    var size = opts.size || 44;
    var id = "finna-" + (++uid);

    var wrap = document.createElement("div");
    wrap.className = "finna finna-idle";
    wrap.style.width = size + "px";
    wrap.style.height = size + "px";

    /* aria-hidden: Finna carries no information that is not already in the
       text beside her. Announcing "thinking face" to a screen reader would be
       noise on every single answer; the live region on the chat feed is what
       actually reports progress. */
    wrap.innerHTML =
      '<svg viewBox="' + (-VIEW / 2) + ' ' + (-VIEW / 2) + ' ' + VIEW + ' ' + VIEW + '"' +
      ' class="finna-svg" aria-hidden="true" focusable="false">' +
        '<defs>' +
          '<radialGradient id="' + id + '-skin" cx="35%" cy="28%" r="78%">' +
            '<stop offset="0%" stop-color="var(--color-brand-bright)"/>' +
            '<stop offset="100%" stop-color="var(--color-brand)"/>' +
          '</radialGradient>' +
        '</defs>' +
        '<g class="finna-bob">' +
          '<path class="finna-body" d="' + bodyPath(0) + '" fill="url(#' + id + '-skin)"/>' +
          '<g class="finna-face">' +
            '<g class="finna-eyes">' +
              '<rect class="finna-eye finna-eye-l" x="-52" y="-26" width="26" height="40" rx="13"/>' +
              '<rect class="finna-eye finna-eye-r" x="26" y="-26" width="26" height="40" rx="13"/>' +
            '</g>' +
            '<path class="finna-mouth" d="M-26 46 Q0 64 26 46"/>' +
          '</g>' +
          // Three dots that orbit only while she is thinking.
          '<g class="finna-think">' +
            '<circle class="finna-dot finna-dot-1" cx="-30" cy="-118" r="9"/>' +
            '<circle class="finna-dot finna-dot-2" cx="0" cy="-124" r="9"/>' +
            '<circle class="finna-dot finna-dot-3" cx="30" cy="-118" r="9"/>' +
          '</g>' +
        '</g>' +
      '</svg>';

    var blinkTimer = null;
    var talkTimer = null;

    function scheduleBlink() {
      if (reducedMotion()) return;
      // Irregular, because a metronome blink is what makes an avatar look dead.
      var wait = 2600 + Math.random() * 4200;
      blinkTimer = global.setTimeout(function () {
        if (wrap.isConnected && !wrap.classList.contains("finna-thinking")) {
          wrap.classList.add("finna-blink");
          global.setTimeout(function () { wrap.classList.remove("finna-blink"); }, 160);
        }
        scheduleBlink();
      }, wait);
    }
    scheduleBlink();

    var api = {
      el: wrap,
      state: "idle",
      /** Move to one of STATES. Unknown states are ignored, never guessed at. */
      setState: function (next) {
        if (STATES.indexOf(next) === -1) return api;
        STATES.forEach(function (s) { wrap.classList.remove("finna-" + s); });
        wrap.classList.add("finna-" + next);
        api.state = next;

        var mouth = wrap.querySelector(".finna-mouth");
        if (mouth) mouth.setAttribute("d", MOUTHS[next] || MOUTHS.idle);

        /* The talking motion is the mouth alternating between open and
           half-closed. Stopped the moment she leaves `speaking`, so she can
           never appear to keep talking after a request has finished or
           failed. */
        if (talkTimer) { global.clearInterval(talkTimer); talkTimer = null; }
        if (next === "speaking" && !reducedMotion()) {
          var open = true;
          talkTimer = global.setInterval(function () {
            if (!wrap.isConnected || api.state !== "speaking") {
              global.clearInterval(talkTimer); talkTimer = null; return;
            }
            open = !open;
            var m = wrap.querySelector(".finna-mouth");
            if (m) m.setAttribute("d", open ? MOUTHS.speaking : MOUTHS.speaking2);
          }, 210);
        }
        return api;
      },
      /** Stop timers when the chat page is torn down. */
      destroy: function () {
        if (blinkTimer) global.clearTimeout(blinkTimer);
        if (talkTimer) global.clearInterval(talkTimer);
        blinkTimer = null;
        talkTimer = null;
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };
    return api;
  }

  /* ── The one Finna that follows the conversation ─────────────────────────
     A single instance is mounted per chat view and re-anchored to the newest
     assistant message, so she appears to move down the page with the
     conversation rather than being duplicated on every bubble. */
  var current = null;

  var Finna = {
    STATES: STATES,
    create: create,

    /** Mount (or re-mount) the companion into a host element. */
    mount: function (host, options) {
      if (!host) return null;
      if (current) current.destroy();
      current = create(options);
      host.appendChild(current.el);
      return current;
    },

    /** Move her beside a message element — this is the "hovering" part. */
    anchorTo: function (messageEl) {
      if (!current || !messageEl) return;
      var slot = messageEl.querySelector(".finna-slot");
      if (slot && current.el.parentNode !== slot) slot.appendChild(current.el);
    },

    setState: function (state) {
      if (current) current.setState(state);
      return Finna;
    },

    get state() { return current ? current.state : null; },

    destroy: function () {
      if (current) current.destroy();
      current = null;
    }
  };

  global.Finna = Finna;
})(window);
