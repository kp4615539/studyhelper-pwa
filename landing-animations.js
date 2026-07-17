// StudyHelper — landing page motion layer (GSAP)
// Purely additive: only touches the marketing/landing view, never app-view logic.
(function () {
  if (typeof gsap === 'undefined') return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

  document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.site-header');
    const heroDemo = document.querySelector('.hero-demo');

    // ---------- Hero entrance ----------
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from(header, { y: -30, opacity: 0, duration: 0.6 })
      .from('.eyebrow', { y: 14, opacity: 0, duration: 0.45 }, '-=0.25')
      .from('.hero-copy h1', { y: 26, opacity: 0, duration: 0.7 }, '-=0.25')
      .from('.lede', { y: 16, opacity: 0, duration: 0.55 }, '-=0.4')
      .from('.hero-ctas .btn', { y: 14, opacity: 0, duration: 0.45, stagger: 0.1 }, '-=0.3')
      .from('.hero-points li', { x: -10, opacity: 0, duration: 0.4, stagger: 0.08 }, '-=0.25')
      .from(heroDemo, { x: 50, opacity: 0, duration: 0.8 }, '-=0.55')
      .from('.demo-nav-item, .demo-newchat', { opacity: 0, duration: 0.3, stagger: 0.04 }, '-=0.35')
      .from('.demo-bubble', { y: 12, opacity: 0, duration: 0.4, stagger: 0.15 }, '-=0.3');

    // Gentle perpetual float on the product mockup
    if (heroDemo) {
      gsap.to(heroDemo, { y: -8, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.2 });
    }

    // ---------- Header shrink + border on scroll ----------
    ScrollTrigger.create({
      start: 'top -60',
      onUpdate: (self) => header && header.classList.toggle('scrolled', self.scroll() > 40),
    });

    // ---------- Scroll reveals ----------
    gsap.from('.features h2, .features .section-sub', {
      y: 22, opacity: 0, duration: 0.6,
      scrollTrigger: { trigger: '.features', start: 'top 82%' },
    });

    gsap.utils.toArray('.feature-card').forEach((card, i) => {
      gsap.from(card, {
        y: 34, opacity: 0, duration: 0.55, delay: i * 0.06, ease: 'power2.out',
        scrollTrigger: { trigger: card, start: 'top 88%' },
      });
    });

    gsap.from('.site-footer', {
      y: 16, opacity: 0, duration: 0.5,
      scrollTrigger: { trigger: '.site-footer', start: 'top 95%' },
    });

    // Decorative blobs drift slowly as you scroll
    gsap.utils.toArray('.bg-blob').forEach((blob, i) => {
      gsap.to(blob, {
        y: (i % 2 === 0 ? 60 : -60), x: (i % 2 === 0 ? -30 : 30),
        ease: 'none',
        scrollTrigger: { trigger: '.hero-grid', start: 'top top', end: 'bottom top', scrub: 1 },
      });
    });

    // ---------- Magnetic buttons ----------
    document.querySelectorAll('.btn-lg, .btn-dark, .btn-outline').forEach((btn) => {
      btn.addEventListener('mousemove', (e) => {
        const r = btn.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2;
        const y = e.clientY - r.top - r.height / 2;
        gsap.to(btn, { x: x * 0.18, y: y * 0.35, duration: 0.3, ease: 'power2.out' });
      });
      btn.addEventListener('mouseleave', () => {
        gsap.to(btn, { x: 0, y: 0, duration: 0.5, ease: 'elastic.out(1, 0.4)' });
      });
    });

    // ---------- Smooth in-page nav ----------
    document.querySelectorAll('.main-nav a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href');
        if (id.length > 1) {
          const target = document.querySelector(id);
          if (target) {
            e.preventDefault();
            gsap.to(window, {
              duration: 0.9, ease: 'power2.inOut',
              scrollTo: { y: target, offsetY: 70 },
            });
          }
        }
      });
    });
  });
})();
