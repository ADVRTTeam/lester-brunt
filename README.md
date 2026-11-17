# Lester Brunt Wealth Management — pensions landing page

The pensions and Inheritance Tax pillar page, built from the *Lester Brunt ·
Landing Page System* design board (design system v2, November 2026).

Static HTML, CSS and vanilla JavaScript, with one Netlify Function that
receives enquiries and forwards them to whatever you point it at. There is no
build step: what is in `public/` is what is served.

---

## Layout

```
public/                        Published directory
  index.html                   The landing page
  thank-you/index.html         Confirmation page — fires the conversion
  404.html
  robots.txt, sitemap.xml
  assets/
    css/site.css               Design tokens and every component
    js/analytics.js            Consent gate, attribution capture, event tracking
    js/enquiry.js              Multi-step form behaviour
    img/                       Logo, adviser photographs, icons, OG image
netlify/functions/
  enquiry.mjs                  POST /api/enquiry
netlify.toml                   Publish dir, redirects, security headers
.env.example                   Every environment variable, documented
```

### Design tokens

All colour, spacing, radius and elevation values come from the board and live
at the top of `public/assets/css/site.css` as custom properties:

| Token | Value | Role |
| --- | --- | --- |
| `--lb-pine` | `#0d3427` | Primary. Headlines, hero, selected states |
| `--lb-pine-deep` | `#082419` | Footer and regulatory band |
| `--lb-ember` | `#d9340c` | Primary buttons only. White text at 4.7:1 |
| `--lb-signal` | `#f9390e` | Brand orange. Small accents, never text or buttons |
| `--lb-mist` | `#a9c4b8` | Secondary text and outlines on Pine |
| `--lb-paper` | `#f8f5ee` | Page ground |
| `--lb-stone` | `#eeeadd` | Alternate sections |
| `--lb-sage` | `#e3eee8` | Selected option tile fill |
| `--lb-ink` | `#14211c` | Body text |
| `--lb-slate` | `#5a6660` | Captions, labels, regulatory text |

Radius: 6px buttons, 10px fields and tiles, 14px cards. One shadow in the
whole system, on the enquiry form, so it reads as the thing to act on.

---

## The enquiry form

Five steps, auto-advancing as each question is answered.

| Step | Field | Values |
| --- | --- | --- |
| 1 | `situation` | `ACTIVE` `IN_TRANSACTION` `PREPARING` `EXPLORING` `LANDLORD` |
| 2 | `pension_value` | `UNDER_100K` `100K_250K` `250K_500K` `500K_1M` `OVER_1M` `NOT_SURE` |
| 3 | `goal` | `INCOME` `LEGACY` `IHT` `CONSOLIDATE` `OTHER` |
| 4 | `age_band` | `UNDER_55` `55_64` `65_74` `75_PLUS` |
| 5 | contact | `first_name` `phone` `email` `postcode` `call_time` `consent` |

Every option is a real `<input type="radio">` behind a styled label, so the
form works with JavaScript switched off: all five steps are revealed at once
and the browser posts natively. The endpoint answers a plain form post with a
303 redirect to `/thank-you/`.

### Focus mode

Answering question one moves the form into a native `<dialog>`:

- **Desktop** — enlarged and centred at 640px, with the page behind it
  blurred (`::backdrop` + `backdrop-filter`) and dimmed.
- **Phone** — full screen, square corners, scrolling inside itself.
- **Both** — background scrolling is locked, and the exact scroll position is
  restored on close.

The form element itself is moved, so answers already given come with it and
nothing is re-rendered. The hero column is held at its measured height while
the form is away, so the blurred page keeps its shape.

`<dialog>`'s `showModal()` provides the focus trap, Esc and the top layer.
There are three ways out — Esc, the close button, and a click on the backdrop
— and **a dismissal is remembered**: the visitor carries on inline from
whichever step they reached, with every answer intact, and is never pulled
back into the dialog. Trapping someone who has asked to leave would cost more
in goodwill than it gains in completions.

Without JavaScript the dialog never opens and the form stays inline, exactly
as it behaves today.

**The conversion fires on `/thank-you/` only, and only once per submission.**
Submitting writes a short-lived flag to `sessionStorage`; the thank-you page
reads it, fires the conversion, and clears it. Reloading that page or landing
on it directly shows the page but counts nothing.

---

## POST /api/enquiry

Accepts `application/json` or `application/x-www-form-urlencoded`.
`GET /api/enquiry` returns a health summary showing which integrations are
configured — useful for checking a deploy without sending a test lead.

### What it does

1. Rejects spam (honeypot field, sub-2.5s completion, per-instance rate limit).
   Spam gets a normal-looking success response, so bots learn nothing.
2. Validates every field, server-side, regardless of what the browser did.
3. Normalises: name title-cased, email lower-cased, postcode spaced correctly,
   phone converted to E.164 alongside the raw entry.
4. Scores the lead into tier A–D (see below).
5. Forwards the record to every configured webhook, signed, with one retry.
6. Writes the full record to the function log, prefixed `LEAD_RECORD`, so a
   lead is recoverable from Netlify even if every webhook is down.

### Payload delivered to your webhook

```json
{
  "lead_id": "0b1d9f2a-...",
  "received_at": "2026-11-17T12:00:00.000Z",
  "source": "lester-brunt-pensions-lp",
  "page_variant": "pensions-c",
  "lead": {
    "situation": "ACTIVE",
    "pension_value": "500K_1M",
    "goal": "IHT",
    "age_band": "65_74",
    "first_name": "Margaret",
    "phone": "07700 900123",
    "phone_e164": "+447700900123",
    "email": "margaret@example.com",
    "postcode": "BH21 1JS",
    "call_time": "Morning",
    "consent": true
  },
  "score": { "tier": "A", "qualified": true, "urgent": true },
  "tracking": {
    "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "pensions-brand",
    "utm_term": "", "utm_content": "", "gclid": "abc123", "gbraid": "", "wbraid": "",
    "fbclid": "", "msclkid": "", "ga_client_id": "1234567890.1234567890",
    "landing_path": "/?utm_source=google", "referrer": "https://www.google.com/"
  },
  "meta": { "ip": "203.0.113.4", "city": "Wimborne", "region": "England", "country": "GB", "user_agent": "..." }
}
```

### Lead scoring

`LEAD_VALUE_FLOOR` sets the lowest pension band counted as qualified. The board
left this as *[AWAITING MARKETING PLUS]*, so it currently defaults to
`UNDER_100K` — nothing is disqualified until you set it.

- **A** — qualified, urgent (`ACTIVE` or `IN_TRANSACTION`) and £250k+
- **B** — qualified and either urgent, or £250k+, or retired with an untouched pension
- **C** — qualified, everything else
- **D** — below the value floor

`NOT_SURE` never disqualifies: plenty of good enquiries do not know the figure.

### Verifying the signature

When `LEAD_WEBHOOK_SECRET` is set, every delivery carries:

```
X-LB-Timestamp: 1763380800
X-LB-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

Recompute with the same secret, compare in constant time, and reject anything
older than five minutes.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, timestamp, signature, secret) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return expected.length === signature.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### Environment variables

Set these in Netlify under **Site configuration → Environment variables**.
Every one is optional; see `.env.example` for the annotated list.

| Variable | Purpose |
| --- | --- |
| `LEAD_WEBHOOK_URL` | Primary destination for leads |
| `LEAD_WEBHOOK_URL_2` | Optional second destination, posted in parallel |
| `LEAD_WEBHOOK_SECRET` | Enables HMAC signing of every delivery |
| `SLACK_WEBHOOK_URL` | Optional one-line Slack alert per lead |
| `LEAD_VALUE_FLOOR` | Lowest qualifying pension band |
| `THANK_YOU_PATH` | Redirect target for non-JS posts. Default `/thank-you/` |

### Sending a test lead

```bash
curl -sS -X POST https://YOUR-SITE.netlify.app/api/enquiry \
  -H 'Content-Type: application/json' \
  -d '{"situation":"ACTIVE","pension_value":"500K_1M","goal":"IHT","age_band":"65_74","first_name":"Test","phone":"07700900123","email":"test@example.com","postcode":"BH21 1JS","consent":true,"form_loaded_at":0}'
```

`form_loaded_at` of `0` skips the timing check. A real submission sends the
page-load timestamp.

---

## Analytics and consent

Nothing loads from Google or Meta until someone accepts analytics cookies.
Attribution (`utm_*`, `gclid`, referrer) is captured first-party on landing and
attached to the enquiry regardless of consent, because it never leaves your own
infrastructure.

To switch tagging on, fill in the four ids at the top of
`public/assets/js/analytics.js`:

```js
window.LB_CONFIG = {
  ga4MeasurementId: '',          // G-XXXXXXXXXX
  googleAdsId: '',               // AW-123456789
  googleAdsConversionLabel: '',  // AbC-D_efG
  metaPixelId: ''                // 123456789012345
};
```

Leave any of them empty and that tag simply never loads. The Google Ads
conversion needs **both** the account id and the label.

Events sent: `cta_click`, `click_to_call`, `enquiry_step`, `generate_lead`,
`enquiry_complete`.

---

## Running it locally

```bash
npx netlify dev
```

Serves `public/` and runs the function at `/api/enquiry`, same as production.

```bash
npm run check
```

Syntax-checks the function and both browser scripts.

---

## Before launch

These are deliberate gaps carried over from the design board — placeholders
rather than invented content.

- [ ] **`[RATING]` and `[COUNT]`** in the trust bar (`public/index.html`) —
      replace with the live Google Business Profile figures.
- [ ] **`[SJP TO CONFIRM wording]`** — four places: the tax note, the meeting
      charge FAQ, the "is this financial advice" FAQ, and the footer's general
      information line.
- [ ] **`[CONFIRM: in-person, phone and video meeting options]`** in the
      "Where do you work with clients?" FAQ.
- [ ] **`SJP Approved [DD/MM/YY] · Ref [APPROVAL REF]`** — footer of
      `index.html` and `thank-you/index.html`.
- [ ] **Legal links.** The privacy policy, site disclaimer and terms links
      point at `https://www.lesterbrunt.co.uk/privacy-policy/`,
      `/site-disclaimer/` and `/terms-and-conditions/`. These paths were not
      reachable from the build environment, so confirm them before launch.
      They appear in `index.html` (form small print, FAQ, footer) and
      `thank-you/index.html`.
- [ ] **Canonical URL and sitemap** assume `pensions.lesterbrunt.co.uk`.
      Update `index.html`, `robots.txt` and `sitemap.xml` if the domain differs.
- [ ] **`LEAD_VALUE_FLOOR`** once the qualification floor is agreed.
- [ ] **Analytics ids** in `analytics.js`, and `LEAD_WEBHOOK_URL` in Netlify.

### A note on the Content-Security-Policy

`netlify.toml` sets a CSP that allows `'unsafe-inline'` for scripts, because
the pages carry inline JSON-LD and the thank-you page's conversion snippet. If
you later move those to files, tighten `script-src` to `'self'` plus the Google
and Meta hosts.
