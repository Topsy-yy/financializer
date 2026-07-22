(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Nav elevates once the page has scrolled past the hero ───── */
  var nav = document.querySelector('.nav');
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 24) nav.classList.add('is-scrolled');
    else nav.classList.remove('is-scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ── Scroll-reveal ─────────────────────────────────────────────
     Elements marked .reveal fade/slide in the first time they cross
     into the viewport. .reveal-stagger additionally staggers direct
     .stagger-item children via a CSS animation-delay ladder. */
  var revealTargets = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealTargets.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealTargets.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ── Count-up stat numbers ─────────────────────────────────────
     Each .stat-num holds its target as data-count; text content is
     the display fallback for no-JS/reduced-motion. */
  var statEls = document.querySelectorAll('.stat-num[data-count]');
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    if (!isFinite(target)) return;
    var suffix = el.getAttribute('data-suffix') || '';
    var duration = 900;
    var start = null;

    function step(ts) {
      if (start === null) start = ts;
      var progress = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      var value = Math.round(target * eased);
      el.textContent = value + suffix;
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = target + suffix;
    }
    requestAnimationFrame(step);
  }

  if (reduceMotion || !('IntersectionObserver' in window)) {
    statEls.forEach(function (el) {
      el.textContent = el.getAttribute('data-count') + (el.getAttribute('data-suffix') || '');
    });
  } else {
    var statObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          statObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });
    statEls.forEach(function (el) { statObserver.observe(el); });
  }

  /* ── Cursor-reactive hero glow ─────────────────────────────────
     The background orbs drift subtly toward the pointer within the
     hero, a light touch that reads as "alive" without being gimmicky. */
  var hero = document.querySelector('.hero');
  var orbs = document.querySelectorAll('.glow-orb');
  if (hero && orbs.length && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    hero.addEventListener('mousemove', function (e) {
      var rect = hero.getBoundingClientRect();
      var relX = (e.clientX - rect.left) / rect.width - 0.5;
      var relY = (e.clientY - rect.top) / rect.height - 0.5;
      orbs.forEach(function (orb, i) {
        var strength = 18 + i * 6;
        orb.style.transform = 'translate(' + (relX * strength) + 'px, ' + (relY * strength) + 'px)';
      });
    });
    hero.addEventListener('mouseleave', function () {
      orbs.forEach(function (orb) { orb.style.transform = 'translate(0, 0)'; });
    });
  }
})();
