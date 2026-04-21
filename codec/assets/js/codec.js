/* CoDeC Project Page — Interactivity */

document.addEventListener('DOMContentLoaded', function () {

  /* ---- Scroll-triggered fade-in animations ---- */
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var delay = el.getAttribute('data-delay') || 0;
        setTimeout(function () {
          el.classList.add('visible');
        }, parseInt(delay));
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.fade-in-up').forEach(function (el) {
    observer.observe(el);
  });

  /* ---- BibTeX copy button ---- */
  var copyBtn = document.getElementById('copy-bibtex');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var bibtex = document.getElementById('bibtex-content').textContent;
      navigator.clipboard.writeText(bibtex).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () {
          copyBtn.textContent = 'Copy';
        }, 2000);
      });
    });
  }

  /* ---- Smooth scroll for anchor links ---- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

});
