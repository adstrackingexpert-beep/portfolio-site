// Cloudflare Worker: static site + /api/audit (ফ্রি ট্র্যাকিং অডিট)
const UA = 'Mozilla/5.0 (compatible; PixelSetupAudit/1.0)';
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });

function parseUrl(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || !h.includes('.') || h === 'localhost' || /\.(local|internal|localhost)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  return u;
}

async function get(url, ms = 8000, max = 1500000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  let out = '', status = 0, finalUrl = url, ok = false;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/javascript,*/*', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: c.signal });
    status = r.status; ok = r.ok; finalUrl = r.url || url;
    if (r.body) {
      const rd = r.body.getReader(), dec = new TextDecoder(); let n = 0;
      try { for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; out += dec.decode(value, { stream: true }); if (n > max) { c.abort(); break; } } } catch (e) {}
    }
  } catch (e) {} finally { clearTimeout(t); }
  return { ok, status, url: finalUrl, text: out };
}

const uniq = (a) => [...new Set(a || [])];
const NOT_CUSTOM = ['www.googletagmanager.com', 'googletagmanager.com'];

async function audit(u) {
  const target = parseUrl(u.searchParams.get('url'));
  if (!target) return J({ error: 'সঠিক ওয়েবসাইট লিংক দিন (যেমন: example.com)' }, 400);
  const page = await get(target.href);
  if (!page.ok || !parseUrl(page.url)) return J({ error: 'সাইটটি খোলা যায়নি। লিংকটি ঠিক আছে কিনা দেখুন, অথবা সাইটটি বট-ব্লক করে রাখতে পারে।' }, 422);

  const html = page.text, base = page.url;
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => { try { return new URL(m[1].replace(/&amp;/g, '&'), base); } catch { return null; } }).filter(Boolean);
  const gtmIds = uniq(html.match(/GTM-[A-Z0-9]{4,10}/g)).slice(0, 2);

  // GTM লোডার হোস্ট (ফার্স্ট-পার্টি/সার্ভার-সাইড লোডার ধরার জন্য)
  const hosts = new Set();
  srcs.forEach(x => { if (/[?&]id=(GTM|G|AW)-/i.test(x.search)) hosts.add(x.hostname.toLowerCase()); });
  for (const m of html.matchAll(/['"]((?:https?:)?\/\/[a-z0-9.-]+)\/[^'"]*\?id=['"]\s*\+/gi)) { try { hosts.add(new URL(m[1].startsWith('//') ? 'https:' + m[1] : m[1]).hostname.toLowerCase()); } catch {} }
  const customHosts = [...hosts].filter(h => !NOT_CUSTOM.includes(h));

  // GTM কন্টেইনার স্ক্যান (ভেতরের ট্যাগ দেখার জন্য)
  let containers = '';
  for (const id of gtmIds) {
    const hs = [...customHosts, 'www.googletagmanager.com'];
    for (const h of hs.slice(0, 2)) {
      const r = await get(`https://${h}/gtm.js?id=${id}`, 6000, 1200000);
      if (r.ok && r.text.length > 200) { containers += '\n' + r.text; break; }
    }
  }
  const blob = (html + containers).replace(/\\x27|\\x22|\\u0027|\\u0022|\\"|\\'/g, "'");

  // ---- GA4 ----
  const ga4 = uniq(blob.match(/\bG-[A-Z0-9]{8,12}\b/g)).slice(0, 3);
  const ua = /\bUA-\d{4,10}-\d+\b/.test(blob);
  const gaEvents = uniq((blob.match(/['"](view_item|add_to_cart|begin_checkout|purchase|generate_lead)['"]/g) || []).map(x => x.replace(/['"]/g, '')));
  const ga = { key: 'ga4', title: 'Google Analytics 4 (GA4)', found: ga4 };
  if (!ga4.length) { ga.status = 'miss'; ga.detail = ua ? 'শুধু পুরনো Universal Analytics (UA) পাওয়া গেছে, যা বন্ধ হয়ে গেছে।' : 'GA4 ট্যাগ পাওয়া যায়নি।'; ga.fix = 'GTM বা gtag.js দিয়ে GA4 Measurement ID (G-XXXXXXX) বসান এবং view_item, add_to_cart, begin_checkout, purchase ইভেন্ট সেটআপ করুন।'; }
  else if (!gaEvents.includes('purchase') && !gaEvents.includes('generate_lead')) { ga.status = 'warn'; ga.detail = 'GA4 আছে, কিন্তু কনভার্সন ইভেন্ট (purchase / generate_lead) পাওয়া যায়নি।'; ga.fix = 'Ecommerce হলে purchase, সার্ভিস সাইট হলে generate_lead ইভেন্ট পাঠান এবং GA4-এ Key Event হিসেবে মার্ক করুন।'; }
  else { ga.status = 'ok'; ga.detail = 'GA4 ও কনভার্সন ইভেন্টের চিহ্ন পাওয়া গেছে: ' + gaEvents.join(', '); ga.fix = ''; }

  // ---- Meta Pixel ----
  const metaOn = /connect\.facebook\.net\/[^'"\s]*fbevents\.js|fbq\(\s*'init'/.test(blob);
  const metaId = uniq([...blob.matchAll(/fbq\(\s*'init'\s*,\s*'?(\d{10,17})/g)].map(m => m[1])).slice(0, 2);
  const metaEv = uniq([...blob.matchAll(/fbq\(\s*'track(?:Custom)?'\s*,\s*'(\w+)'/g)].map(m => m[1]));
  const dedup = /eventID|event_id|eventId/.test(blob);
  const meta = { key: 'meta', title: 'Meta (Facebook) Pixel', found: metaId };
  if (!metaOn) { meta.status = 'miss'; meta.detail = 'Meta Pixel পাওয়া যায়নি।'; meta.fix = 'GTM-এ Meta Pixel বেস কোড বসিয়ে PageView, ViewContent, AddToCart, Purchase/Lead ইভেন্ট ম্যাপ করুন।'; }
  else if (!metaEv.some(e => /Purchase|Lead|CompleteRegistration|InitiateCheckout/.test(e))) { meta.status = 'warn'; meta.detail = 'Pixel আছে, কিন্তু কনভার্সন ইভেন্ট (Purchase/Lead) পাওয়া যায়নি।'; meta.fix = 'Purchase বা Lead ইভেন্ট যোগ করুন এবং Events Manager-এ টেস্ট ইভেন্ট দিয়ে যাচাই করুন।'; }
  else { meta.status = 'ok'; meta.detail = 'Pixel ও ইভেন্ট পাওয়া গেছে: ' + metaEv.slice(0, 5).join(', '); meta.fix = ''; }

  // ---- TikTok ----
  const ttOn = /analytics\.tiktok\.com\/i18n\/pixel|ttq\.load\(|ttq\.track\(/.test(blob);
  const ttId = uniq([...blob.matchAll(/ttq\.load\(\s*'([A-Z0-9]{10,24})'/g)].map(m => m[1])).slice(0, 2);
  const ttEv = uniq([...blob.matchAll(/ttq\.track\(\s*'(\w+)'/g)].map(m => m[1]));
  const tt = { key: 'tiktok', title: 'TikTok Pixel', found: ttId };
  if (!ttOn) { tt.status = 'miss'; tt.detail = 'TikTok Pixel পাওয়া যায়নি।'; tt.fix = 'TikTok Ads থেকে Pixel ID নিয়ে GTM-এ বসান এবং CompletePayment / SubmitForm ইভেন্ট সেটআপ করুন।'; }
  else if (!ttEv.some(e => /CompletePayment|PlaceAnOrder|SubmitForm|CompleteRegistration|Purchase/i.test(e))) { tt.status = 'warn'; tt.detail = 'Pixel আছে, কিন্তু কনভার্সন ইভেন্ট পাওয়া যায়নি।'; tt.fix = 'CompletePayment বা SubmitForm ইভেন্ট যোগ করে TikTok Events Manager-এ যাচাই করুন।'; }
  else { tt.status = 'ok'; tt.detail = 'Pixel ও ইভেন্ট পাওয়া গেছে: ' + ttEv.slice(0, 5).join(', '); tt.fix = ''; }

  // ---- Google Ads ----
  const aw = uniq(blob.match(/\bAW-\d{8,12}\b/g)).slice(0, 2);
  const awLabel = /AW-\d{8,12}\/[\w-]{10,30}/.test(blob) || /googleadservices\.com\/pagead\/conversion/.test(blob);
  const ec = /enhanced_conversion|allow_enhanced_conversions|sha256_email_address|ec_mode|user_data/.test(blob);
  const ads = { key: 'gads', title: 'Google Ads কনভার্সন ট্র্যাকিং', found: aw };
  if (!aw.length && !awLabel) { ads.status = 'miss'; ads.detail = 'Google Ads ট্যাগ পাওয়া যায়নি।'; ads.fix = 'Google Ads-এ কনভার্সন অ্যাকশন বানিয়ে GTM-এ Conversion ID ও Label দিয়ে ট্যাগ সেটআপ করুন।'; }
  else if (!awLabel) { ads.status = 'warn'; ads.detail = 'Google Ads ট্যাগ আছে, কিন্তু কনভার্সন লেবেল পাওয়া যায়নি (শুধু রিমার্কেটিং হতে পারে)।'; ads.fix = 'কনভার্সন লেবেল সহ Conversion Tracking ট্যাগ বসান।'; }
  else if (!ec) { ads.status = 'warn'; ads.detail = 'কনভার্সন ট্র্যাকিং আছে, কিন্তু Enhanced Conversions-এর চিহ্ন নেই।'; ads.fix = 'Enhanced Conversions চালু করে হ্যাশড ইমেইল/ফোন পাঠান — এতে অ্যাট্রিবিউশন বাড়ে।'; }
  else { ads.status = 'ok'; ads.detail = 'কনভার্সন ট্র্যাকিং ও Enhanced Conversions-এর চিহ্ন পাওয়া গেছে।'; ads.fix = ''; }

  // ---- Server-side ----
  const ssHint = /server_container_url|transport_url|first_party_collection|stape\.(io|net)|\.stape\./i.test(blob);
  const ssOn = customHosts.length > 0 || ssHint;
  const ss = { key: 'ss', title: 'সার্ভার-সাইড ট্র্যাকিং', found: customHosts.slice(0, 2) };
  if (ssOn) { ss.status = 'ok'; ss.detail = customHosts.length ? 'ফার্স্ট-পার্টি/কাস্টম ডোমেইন থেকে GTM লোড হচ্ছে: ' + customHosts[0] : 'সার্ভার কন্টেইনার URL-এর চিহ্ন পাওয়া গেছে।'; ss.fix = ''; }
  else { ss.status = 'miss'; ss.detail = gtmIds.length ? 'GTM আছে, কিন্তু সব কিছু ব্রাউজার থেকে googletagmanager.com-এ যাচ্ছে (ক্লায়েন্ট-সাইড)। সার্ভার-সাইড নেই।' : 'সার্ভার-সাইড ট্র্যাকিংয়ের কোনো চিহ্ন পাওয়া যায়নি।'; ss.fix = 'GTM Server Container + Cloudflare দিয়ে নিজের ডোমেইনে ফার্স্ট-পার্টি সার্ভার-সাইড সেটআপ করুন। এতে অ্যাড ব্লকার ও iOS-এ ডাটা লস কমে।'; }

  // ---- Conversion API ----
  const capi = { key: 'capi', title: 'Conversion API (Meta / TikTok)', found: [] };
  if (!metaOn && !ttOn) { capi.status = 'miss'; capi.detail = 'Pixel না থাকায় Conversion API-ও কাজ করছে না।'; capi.fix = 'আগে Pixel বসান, তারপর সার্ভার-সাইড থেকে Meta CAPI ও TikTok Events API সেটআপ করুন।'; }
  else if (ssOn && dedup) { capi.status = 'ok'; capi.detail = 'সার্ভার-সাইড ও event_id (Deduplication) পাওয়া গেছে — CAPI চলার সম্ভাবনা বেশি।'; capi.fix = 'Events Manager-এ Server ইভেন্ট ও Match Quality দেখে নিশ্চিত হয়ে নিন।'; }
  else if (ssOn) { capi.status = 'warn'; capi.detail = 'সার্ভার-সাইড আছে, কিন্তু event_id (Deduplication) পাওয়া যায়নি — ডুপ্লিকেট ইভেন্টের ঝুঁকি।'; capi.fix = 'ব্রাউজার ও সার্ভার ইভেন্টে একই event_id পাঠান।'; }
  else { capi.status = 'miss'; capi.detail = 'Conversion API-এর কোনো চিহ্ন নেই — শুধু ব্রাউজার Pixel চলছে।'; capi.fix = 'Meta Conversions API ও TikTok Events API সার্ভার-সাইড থেকে পাঠান এবং Deduplication সেট করুন।'; }

  const checks = [ga, meta, tt, ads, ss, capi];
  const pts = checks.reduce((a, c) => a + (c.status === 'ok' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return J({ url: target.hostname, score: Math.round(pts / checks.length * 100), gtm: gtmIds, checks, note: 'এটি পেজের পাবলিক সোর্স স্ক্যান। কনসেন্ট ব্যানারের পরে লোড হওয়া ট্যাগ এবং সার্ভারের ভেতরের ইভেন্ট ১০০% যাচাই করা যায় না — সম্পূর্ণ যাচাই Events Manager ও GA4 DebugView দিয়ে হয়।' });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/api/audit') return audit(u);
    return env.ASSETS.fetch(req);
  }
};
