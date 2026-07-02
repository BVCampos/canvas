// Renders a small but realistic deck via the patched assembleDeckHtml so we
// can verify the embedded-host guard + new direct-DOM CANVAS_CONTROLLER in a
// real browser, without going through Canvas auth.

import { assembleDeckHtml } from "../src/lib/canvas/assemble";
import { writeFileSync } from "fs";

// A nav.js that mirrors a real client deck's pattern: top-level keydown +
// touchstart/touchend on slidesEl, both calling an internal goTo() that
// writes slidesEl.style.transform. If EMBEDDED_GUARD works these wires are
// silenced; navigation must come from CANVAS_CONTROLLER.navigate() instead.
const NAV_JS = `
const slidesEl = document.getElementById('slides');
const slides = slidesEl.querySelectorAll('.slide');
const total = slides.length;
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const currentEl = document.getElementById('current');
const totalEl = document.getElementById('total');
const dotsNav = document.getElementById('dotsNav');

let index = 0;
totalEl.textContent = total;

for (let i = 0; i < total; i++) {
  const d = document.createElement('button');
  d.className = 'dot-nav' + (i === 0 ? ' active' : '');
  d.setAttribute('aria-label', 'Ir para slide ' + (i + 1));
  d.addEventListener('click', () => goTo(i));
  dotsNav.appendChild(d);
}
const dotsList = dotsNav.querySelectorAll('.dot-nav');

function update() {
  slidesEl.style.transform = 'translateX(-' + (index * 100) + 'vw)';
  currentEl.textContent = index + 1;
  dotsList.forEach((d, i) => d.classList.toggle('active', i === index));
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === total - 1;
  // Diagnostic so the test page can verify the deck DID NOT auto-advance.
  window.__deckGoToCalls = (window.__deckGoToCalls || 0) + 1;
}
function goTo(i) {
  index = Math.max(0, Math.min(total - 1, i));
  update();
}
prevBtn.addEventListener('click', () => goTo(index - 1));
nextBtn.addEventListener('click', () => goTo(index + 1));

document.addEventListener('keydown', e => {
  window.__deckKeydownFired = (window.__deckKeydownFired || 0) + 1;
  if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1); }
});

slidesEl.addEventListener('touchstart', () => { window.__deckTouchFired = true; });
slidesEl.addEventListener('touchend', () => { window.__deckTouchFired = true; });

update();
`;

const THEME = `
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
html, body { height: 100vh; overflow: hidden; background: #f5f5f7; }
.deck { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
.slides {
  position: absolute; top: 0; left: 0;
  width: 100%; height: 100%;
  display: flex;
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
.slide {
  flex: 0 0 100vw; height: 100%;
  background: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 48px; font-weight: 700; color: #1a1a1a;
}
.slide-1 { background: #ffe4e6; }
.slide-2 { background: #fef3c7; }
.slide-3 { background: #d1fae5; }
.slide-4 { background: #dbeafe; }
.slide-5 { background: #ede9fe; }
`;

const slides = [
  { position: 0, title: "Slide 1", html_body: `<section class="slide slide-1">SLIDE 1</section>` },
  { position: 1, title: "Slide 2", html_body: `<section class="slide slide-2">SLIDE 2</section>` },
  { position: 2, title: "Slide 3", html_body: `<section class="slide slide-3">SLIDE 3</section>` },
  { position: 3, title: "Slide 4", html_body: `<section class="slide slide-4">SLIDE 4</section>` },
  { position: 4, title: "Slide 5", html_body: `<section class="slide slide-5">SLIDE 5</section>` },
];

const previewHtml = assembleDeckHtml({
  title: "Embed Test",
  theme_css: THEME,
  nav_js: NAV_JS,
  slides,
  mode: "preview",
});

const exportHtml = assembleDeckHtml({
  title: "Export Test",
  theme_css: THEME,
  nav_js: NAV_JS,
  slides,
  mode: "export",
});

writeFileSync("/tmp/test-deck-preview.html", previewHtml);
writeFileSync("/tmp/test-deck-export.html", exportHtml);
console.log("preview bytes:", previewHtml.length, "export bytes:", exportHtml.length);
console.log("preview has guard:", previewHtml.includes("__canvasEmbedded"));
console.log("export has guard:", exportHtml.includes("__canvasEmbedded"));
