/* =============================================================================
   Lester Brunt — enquiry form
   -----------------------------------------------------------------------------
   Five steps, auto-advancing. Without JavaScript every step is shown at once
   and the browser posts the form natively to /api/enquiry, which answers a
   plain form post with a redirect to /thank-you.
   ============================================================================= */
(function () {
  'use strict';

  var form = document.querySelector('[data-enquiry-form]');
  if (!form) return;

  var TOTAL_STEPS = 5;
  var ADVANCE_DELAY = 220;
  var TIME_LEFT = ['About a minute', 'About a minute', 'Under a minute', 'Nearly there', 'Last step'];

  var panels = Array.prototype.slice.call(form.querySelectorAll('[data-panel]'));
  var stepLabel = form.querySelector('[data-step-label]');
  var timeLeft = form.querySelector('[data-time-left]');
  var progressFill = form.querySelector('[data-progress-fill]');
  var backBtn = form.querySelector('[data-back]');
  var submitBtn = form.querySelector('[data-submit]');
  var submitLabel = form.querySelector('[data-submit-label]');
  var errorEl = form.querySelector('[data-form-error]');
  var loadedAt = form.querySelector('[data-loaded-at]');
  var trackingField = form.querySelector('[data-tracking]');

  var step = 1;
  var advanceTimer = null;
  var sending = false;

  if (loadedAt) loadedAt.value = String(Date.now());

  /* ------------------------------------------------------------ navigation */
  function render(focus) {
    panels.forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute('data-panel')) !== step;
    });

    if (stepLabel) stepLabel.textContent = 'Step ' + step + ' of ' + TOTAL_STEPS;
    if (timeLeft) timeLeft.textContent = TIME_LEFT[step - 1] || '';
    if (progressFill) progressFill.style.width = (step * (100 / TOTAL_STEPS)) + '%';
    if (backBtn) backBtn.hidden = step === 1;

    if (focus) {
      var panel = panels[step - 1];
      if (!panel) return;
      var target = panel.querySelector('input:not([type="hidden"]), button, [tabindex]');
      var heading = panel.querySelector('legend, .lb-details__title');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      } else if (target) {
        target.focus({ preventScroll: true });
      }
      /* Keep the top of the form in view when the panel height changes. */
      var rect = form.getBoundingClientRect();
      if (rect.top < 0) form.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function goTo(next, focus) {
    step = Math.min(Math.max(next, 1), TOTAL_STEPS);
    render(focus);
  }

  /* Auto-advance when a question is answered.
     Listens for both events on purpose: `change` catches keyboard selection,
     `click` catches re-confirming an answer that is already selected — which
     is what happens after Back, and fires no change event. The shared timer
     makes the overlap harmless. */
  function onPick(input) {
    if (!input || input.type !== 'radio' || !input.classList.contains('lb-option__input')) return;
    if (!input.checked) return;
    var panel = input.closest('[data-panel]');
    if (!panel) return;
    var panelStep = Number(panel.getAttribute('data-panel'));
    if (panelStep !== step || step >= TOTAL_STEPS) return;

    if (window.LB) window.LB.track('enquiry_step', { step: panelStep, field: input.name, value: input.value });

    window.clearTimeout(advanceTimer);
    advanceTimer = window.setTimeout(function () { goTo(step + 1, true); }, ADVANCE_DELAY);
  }

  form.addEventListener('change', function (event) { onPick(event.target); });
  form.addEventListener('click', function (event) {
    var input = event.target.closest('.lb-option__input');
    if (input) onPick(input);
  });

  if (backBtn) {
    backBtn.addEventListener('click', function () {
      window.clearTimeout(advanceTimer);
      goTo(step - 1, true);
    });
  }

  /* ------------------------------------------------------------ validation */
  var RULES = {
    first_name: function (v) { return v.trim().length > 0; },
    phone: function (v) { return v.replace(/[^0-9]/g, '').length >= 10; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); },
    postcode: function (v) { return /^[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s*[0-9][A-Za-z]{2}$/.test(v.trim()); }
  };

  function validateDetails() {
    var ok = true;
    Object.keys(RULES).forEach(function (name) {
      var input = form.elements[name];
      if (!input) return;
      var valid = RULES[name](input.value || '');
      input.setAttribute('aria-invalid', valid ? 'false' : 'true');
      if (!valid) ok = false;
    });
    var consent = form.elements.consent;
    if (consent && !consent.checked) ok = false;
    return ok;
  }

  /* Clear the invalid flag as soon as someone fixes a field. */
  form.addEventListener('input', function (event) {
    var name = event.target.name;
    if (!RULES[name]) return;
    if (RULES[name](event.target.value || '')) event.target.setAttribute('aria-invalid', 'false');
  });

  function missingAnswers() {
    return ['situation', 'pension_value', 'goal', 'age_band'].filter(function (name) {
      var group = form.elements[name];
      return !group || !group.value;
    });
  }

  /* ---------------------------------------------------------------- submit */
  function collect() {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (key === 'tracking') return;
      data[key] = typeof value === 'string' ? value : String(value);
    });
    data.consent = form.elements.consent && form.elements.consent.checked;
    data.tracking = window.LB ? window.LB.getTracking() : {};
    return data;
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError() {
    if (errorEl) errorEl.hidden = true;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;

    var gaps = missingAnswers();
    if (gaps.length) {
      var firstGap = ['situation', 'pension_value', 'goal', 'age_band'].indexOf(gaps[0]) + 1;
      showError('Please answer every question before sending your enquiry.');
      goTo(firstGap, true);
      return;
    }

    if (!validateDetails()) {
      showError('Please complete the highlighted fields and tick the box to continue.');
      var firstBad = form.querySelector('[aria-invalid="true"]');
      if (firstBad) firstBad.focus();
      else if (form.elements.consent) form.elements.consent.focus();
      return;
    }

    hideError();
    sending = true;
    if (submitBtn) submitBtn.setAttribute('aria-busy', 'true');
    if (submitLabel) submitLabel.textContent = 'Sending your enquiry…';

    var payload = collect();
    if (trackingField) trackingField.value = JSON.stringify(payload.tracking || {});

    fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        }).catch(function () {
          return { ok: response.ok, status: response.status, body: {} };
        });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body && result.body.message ? result.body.message : 'Request failed');

        if (window.LB) {
          window.LB.track('generate_lead', {
            lead_id: result.body.lead_id || '',
            situation: payload.situation,
            pension_value: payload.pension_value
          });
        }

        /* The /thank-you page fires the conversion, but only for a real
           submission — this flag is what tells it this visit is one. */
        try {
          window.sessionStorage.setItem('lb_lead', JSON.stringify({
            lead_id: result.body.lead_id || '',
            first_name: payload.first_name || '',
            at: Date.now()
          }));
        } catch (e) { /* storage blocked — the page copes without it */ }

        window.location.assign('/thank-you/');
      })
      .catch(function () {
        sending = false;
        if (submitBtn) submitBtn.removeAttribute('aria-busy');
        if (submitLabel) submitLabel.textContent = 'Request my no obligation meeting';
        showError('Sorry, something went wrong sending your enquiry. Please try again, or call us on 01202 695 801.');
      });
  });

  /* ------------------------------------------------------------------ boot */
  render(false);

  /* Deep link straight into the form from a CTA. */
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href="#enquiry-form"]');
    if (!link) return;
    window.setTimeout(function () {
      var panel = panels[step - 1];
      if (!panel) return;
      var first = panel.querySelector('input:not([type="hidden"])');
      if (first && window.matchMedia('(min-width: 768px)').matches) first.focus({ preventScroll: true });
    }, 420);
  });

  /* ------------------------------------------------------- mobile sticky CTA */
  var bar = document.querySelector('[data-sticky-bar]');
  var hero = document.getElementById('hero');
  if (bar && hero && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      var entry = entries[0];
      var show = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      bar.classList.toggle('is-visible', show);
      bar.setAttribute('aria-hidden', show ? 'false' : 'true');
      bar.querySelectorAll('a').forEach(function (a) {
        a.setAttribute('tabindex', show ? '0' : '-1');
      });
    }, { threshold: 0 });
    observer.observe(hero);
  }
})();
