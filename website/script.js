/* VoidSoul landing — single-file vanilla JS.
   Two jobs:
     1. Reveal-on-scroll animation for sections/cards as they enter view.
     2. Stub CTA hooks so the eventual buy buttons have somewhere to wire to.
   No build step. No framework. Runs after DOMContentLoaded. */

;(() => {
  'use strict'

  /* ------------------------ reveal-on-scroll ------------------------ */

  // Targets — every card, long-row, section head, price card, faq item.
  // The selector is intentionally broad: anything visually substantial
  // animates in, which removes the per-element decoration that used to
  // ship in the prototype site.
  const targets = document.querySelectorAll(
    '.card, .long-row, .section-head, .price-card, .faq-item, .trust-item, .hero-card'
  )

  if ('IntersectionObserver' in window && targets.length > 0) {
    targets.forEach((el) => el.classList.add('reveal'))
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in')
            io.unobserve(entry.target)
          }
        })
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 }
    )
    targets.forEach((el) => io.observe(el))
  } else {
    // No IO support — just show everything.
    targets.forEach((el) => el.classList.add('in'))
  }

  /* ------------------------ stagger pipeline pills ------------------------ */

  // The five pipeline steps in the hero card cascade in instead of
  // landing all at once. Adds about 600ms of choreography that makes
  // the hero feel deliberate without being slow.
  const pipSteps = document.querySelectorAll('.pip-step')
  pipSteps.forEach((step, i) => {
    step.style.opacity = '0'
    step.style.transform = 'translateY(10px)'
    step.style.transition = 'opacity 0.5s ease, transform 0.5s ease'
    setTimeout(
      () => {
        step.style.opacity = '1'
        step.style.transform = 'translateY(0)'
      },
      400 + i * 120
    )
  })

  /* ------------------------ CTA hooks ------------------------ */

  // The pricing CTAs are stubs — wire them to whatever cart / Lemon /
  // Stripe / Gumroad endpoint you end up using. For now they emit a
  // friendly toast-style alert so you know the click registered when
  // testing locally.
  document.querySelectorAll('[data-cta]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      const cta = btn.getAttribute('data-cta')
      // TODO: wire to your payment provider.
      // Default fallback — open the GitHub release page so visitors who
      // hit the buy button before checkout is wired still leave with
      // something to download.
      if (cta === 'buy') {
        // Repo is `SoulVoidAI` — matches PRIVACY.md / TERMS.md / LICENSE /
        // electron-builder.yml. `VoidSoulAssistant` is the local project
        // folder; the GitHub repo is named differently.
        window.location.href = 'https://github.com/Dev-Kyron/SoulVoidAI/releases/latest'
      } else if (cta === 'studio') {
        // hello@voidsoulstudio.com is the canonical studio inbox (matches
        // PRIVACY/TERMS/LICENSE). voidsoul.app was an older alias.
        window.location.href = 'mailto:hello@voidsoulstudio.com?subject=Studio%20license'
      }
    })
  })

  /* ------------------------ subtle parallax on hero card ------------------------ */

  // The 3D-tilted settings-mock card in the hero gets a tiny additional
  // parallax based on cursor position. Disabled on touch + reduced-motion.
  const heroCard = document.querySelector('.hero-card')
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const isTouch = window.matchMedia('(hover: none)').matches
  if (heroCard && !prefersReducedMotion && !isTouch) {
    let ticking = false
    let mx = 0
    let my = 0
    window.addEventListener('mousemove', (e) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2
      my = (e.clientY / window.innerHeight - 0.5) * 2
      if (!ticking) {
        ticking = true
        requestAnimationFrame(() => {
          // Multiply by small constants so it's noticeable but not
          // distracting — the page is still primarily a reading
          // experience.
          const tiltX = 7 + my * -3
          const tiltY = mx * 4
          heroCard.style.transform = `perspective(1400px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`
          ticking = false
        })
      }
    })
  }

  /* ------------------------ smooth scroll for old browsers ------------------------ */

  // CSS `scroll-behavior: smooth` is supported in all evergreen browsers
  // but Safari needed help in older releases. Polyfill the anchor-click
  // case so the in-page nav feels right everywhere.
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href')
      if (!id || id === '#') return
      const el = document.querySelector(id)
      if (!el) return
      e.preventDefault()
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Update the URL hash without forcing a jump (which would defeat
      // the smooth-scroll above).
      history.replaceState(null, '', id)
    })
  })
})()
