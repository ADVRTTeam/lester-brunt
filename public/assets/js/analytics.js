/* =============================================================================
   Lester Brunt — attribution, consent and tracking
   -----------------------------------------------------------------------------
   Nothing is loaded from Google until someone accepts analytics cookies.
   Attribution (utm_*, gclid, referrer) is first-party only and is attached to
   the enquiry so leads can be matched back to campaigns in the CRM.

   TO GO LIVE WITH TRACKING: fill in the four ids below. Leave any of them empty
   and that tag simply never loads — the page and the form still work.
   ============================================================================= */
window.LB_CONFIG = {
  // GA4 measurement id, e.g. 'G-XXXXXXXXXX'
  ga4MeasurementId: '',
  // Google Ads conversion id, e.g. 'AW-123456789'
  googleAdsId: '',
  // Google Ads conversion label for the enquiry conversion, e.g. 'AbC-D_efG'
  googleAdsConversionLabel: '',
  // Meta pixel id, e.g. '123456789012345'
  metaPixelId: ''
};

(function () {
  'use strict';

  var CONSENT_KEY = 'lb_consent_v1';
  var ATTR_KEY = 'lb_attribution_v1';
  var queue = [];
  var loaded = false;

  /* ---------------------------------------------------------------- storage */
  function readStore(store, key) {
    try {
      return window[store].getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(store, key, value) {
    try {
      window[store].setItem(key, value);
    } catch (e) {
      /* private mode, blocked cookies — tracking is optional, carry on */
    }
  }

  /* ------------------------------------------------------------ attribution */
  function captureAttribution() {
    var existing = readStore('sessionStorage', ATTR_KEY);
    if (existing) {
      try {
        return JSON.parse(existing);
      } catch (e) {
        /* fall through and recapture */
      }
    }

    var params = new URLSearchParams(window.location.search);
    var keys = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'
    ];
    var data = {
      landing_path: window.location.pathname + window.location.search,
      referrer: document.referrer || '',
      captured_at: new Date().toISOString()
    };

    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) data[k] = v.slice(0, 255);
    });

    writeStore('sessionStorage', ATTR_KEY, JSON.stringify(data));
    return data;
  }

  /* Reads the GA4 client id straight off the _ga cookie, so offline
     conversions can be stitched back to the session without the SDK. */
  function gaClientId() {
    var match = document.cookie.match(/_ga=GA\d\.\d\.(\d+\.\d+)/);
    return match ? match[1] : '';
  }

  /* ---------------------------------------------------------------- consent */
  function consentState() {
    return readStore('localStorage', CONSENT_KEY);
  }

  function loadTags() {
    if (loaded) return;
    var cfg = window.LB_CONFIG || {};
    var googleId = cfg.ga4MeasurementId || cfg.googleAdsId;
    if (!googleId && !cfg.metaPixelId) return;
    loaded = true;

    if (googleId) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('consent', 'default', {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        analytics_storage: 'granted'
      });
      if (cfg.ga4MeasurementId) window.gtag('config', cfg.ga4MeasurementId);
      if (cfg.googleAdsId) window.gtag('config', cfg.googleAdsId);

      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(googleId);
      document.head.appendChild(s);
    }

    if (cfg.metaPixelId) {
      /* eslint-disable */
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
      (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', cfg.metaPixelId);
      window.fbq('track', 'PageView');
    }

    /* Flush anything that happened before consent was given. */
    var pending = queue.slice();
    queue.length = 0;
    pending.forEach(function (item) { send(item.name, item.params); });
  }

  function send(name, params) {
    if (!loaded) {
      queue.push({ name: name, params: params });
      return;
    }
    if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    if (typeof window.fbq === 'function' && name === 'generate_lead') {
      window.fbq('track', 'Lead', params || {});
    }
  }

  /* ----------------------------------------------------------- cookie banner */
  function wireBanner() {
    var banner = document.querySelector('[data-cookie-banner]');
    if (!banner) return;

    function open() {
      banner.hidden = false;
      banner.classList.add('is-open');
    }

    function close() {
      banner.classList.remove('is-open');
      banner.hidden = true;
    }

    function decide(value) {
      writeStore('localStorage', CONSENT_KEY, value);
      close();
      if (value === 'granted') loadTags();
    }

    var accept = banner.querySelector('[data-cookie-accept]');
    var reject = banner.querySelector('[data-cookie-reject]');
    if (accept) accept.addEventListener('click', function () { decide('granted'); });
    if (reject) reject.addEventListener('click', function () { decide('denied'); });

    document.querySelectorAll('[data-cookie-settings]').forEach(function (el) {
      el.addEventListener('click', function (event) {
        event.preventDefault();
        open();
        if (accept) accept.focus();
      });
    });

    if (!consentState()) open();
  }

  /* -------------------------------------------------------------- outbound  */
  function wireClickTracking() {
    document.addEventListener('click', function (event) {
      var el = event.target.closest('[data-track]');
      if (!el) return;
      var kind = el.getAttribute('data-track');
      var where = el.getAttribute('data-track-location') || 'unknown';
      if (kind === 'call') send('click_to_call', { location: where });
      if (kind === 'cta') send('cta_click', { location: where });
    });
  }

  /* ------------------------------------------------------------------ boot  */
  var attribution = captureAttribution();

  window.LB = {
    track: send,
    getTracking: function () {
      var out = {};
      Object.keys(attribution).forEach(function (k) { out[k] = attribution[k]; });
      var cid = gaClientId();
      if (cid) out.ga_client_id = cid;
      out.page_path = window.location.pathname;
      return out;
    },
    hasConsent: function () { return consentState() === 'granted'; }
  };

  if (consentState() === 'granted') loadTags();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireBanner();
      wireClickTracking();
    });
  } else {
    wireBanner();
    wireClickTracking();
  }
})();
