// Pitch deck behavior: Mermaid theming, keyboard navigation, slide counter.

(function () {
  // ---------- Mermaid init with our paper-editorial theme ----------
  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      themeVariables: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '14px',
        primaryColor: '#FBF7EE',
        primaryTextColor: '#1A1A1A',
        primaryBorderColor: '#1A1A1A',
        lineColor: '#1A1A1A',
        secondaryColor: '#F5F1EA',
        tertiaryColor: '#FBF7EE',
        nodeBorder: '#1A1A1A',
        clusterBkg: 'rgba(193,59,43,0.06)',
        clusterBorder: '#C13B2B',
        edgeLabelBackground: '#FBF7EE',
      },
      flowchart: { curve: 'basis', padding: 16, useMaxWidth: true },
    });
  }

  // ---------- Slide navigation ----------
  const deck = document.querySelector('.deck');
  const slides = Array.from(document.querySelectorAll('.slide'));
  const counter = document.getElementById('counter');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');

  let current = 0;
  const total = slides.length;

  const pad = (n) => String(n).padStart(2, '0');
  const updateCounter = () => {
    counter.textContent = `${pad(current + 1)} / ${pad(total)}`;
  };

  const goTo = (i) => {
    current = Math.max(0, Math.min(total - 1, i));
    slides[current].scrollIntoView({ behavior: 'smooth', block: 'start' });
    updateCounter();
  };

  prev.addEventListener('click', () => goTo(current - 1));
  next.addEventListener('click', () => goTo(current + 1));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      goTo(current + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      goTo(current - 1);
    } else if (e.key === 'Home') {
      goTo(0);
    } else if (e.key === 'End') {
      goTo(total - 1);
    }
  });

  // Keep counter in sync when user scrolls (snap mandatory makes this clean).
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.55) {
          current = slides.indexOf(entry.target);
          updateCounter();
        }
      });
    },
    { root: deck, threshold: [0.55, 0.75] }
  );
  slides.forEach((s) => io.observe(s));

  updateCounter();
})();
