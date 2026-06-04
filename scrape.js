// /functions/scrape.js — Cloudflare Pages Function
// Endpoint: GET /scrape?url=https://www.estatesales.net/...
// Returns JSON with parsed sale data for the LLV plan view.

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get('url');

  if (!target) {
    return Response.json({ error: 'url parameter required' }, { status: 400 });
  }

  // Only allow estatesales.net for now
  let parsed;
  try { parsed = new URL(target); } catch { return Response.json({ error: 'Invalid URL' }, { status: 400 }); }
  if (!parsed.hostname.includes('estatesales.net')) {
    return Response.json({ error: 'Only estatesales.net URLs are supported' }, { status: 400 });
  }

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LLVBot/1.0)',
        'Accept': 'text/html',
      },
    });
    if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
    const html = await resp.text();
    const data = parseEstateSale(html, target);
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}

function parseEstateSale(html, sourceUrl) {
  const out = { link: sourceUrl, saleType: 'ESTATE SALE', source: 'AUCTION SITE' };

  // ── 1. Name from <title>, strip "starts on M/D/YYYY" suffix ──
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  if (titleM) {
    out.name = ent(titleM[1]).replace(/\s*starts on \d+\/\d+\/\d+\s*$/i, '').trim();
  }

  // ── 2. Start date from title: "starts on M/D/YYYY" ──
  const startM = html.match(/starts on (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (startM) {
    out.date = `${startM[3]}-${startM[1].padStart(2, '0')}-${startM[2].padStart(2, '0')}`;
  }

  // ── 3. Meta description → end date + company ──
  const metaM = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const metaText = metaM ? metaM[1] : '';

  // End date: "runs through Thursday, June 4"
  const endM = metaText.match(/runs through \w+,\s+(\w+)\s+(\d+)/i);
  if (endM && startM) {
    const year = parseInt(startM[3]);
    const endISO = monthDayToISO(endM[1], endM[2], year);
    if (endISO) out.dateEnd = endISO;
  }

  // Company: "It is being run by Company Name."
  const coM = metaText.match(/run by\s+([^.]+)/i);
  if (coM) out.company = coM[1].trim();

  // ── 4. Location from URL path: /ST/City/ZIP/ID ──
  const locM = sourceUrl.match(/estatesales\.net\/(\w{2})\/([^/]+)\/(\d{5})/i);
  let city = '', state = '', zip = '';
  if (locM) {
    state = locM[1].toUpperCase();
    city = locM[2].replace(/-/g, ' ');
    zip = locM[3];
    out.address = `${city}, ${state} ${zip}`;
  }

  // ── 5. Street address from body text ──
  // Look for "1234 Something St/Ave/Blvd..." pattern
  const addrM = html.match(/(\d+\s+[A-Za-z][A-Za-z.']+(?:\s+[A-Za-z.']+){0,3}\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Rd|Road|Ln|Lane|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?)\.?)\s*[,.]?\s*([A-Za-z\s]*,\s*[A-Z]{2}(?:\s+\d{5})?)?/);
  if (addrM) {
    let full = addrM[1].trim();
    if (addrM[2]) {
      full += ', ' + addrM[2].trim();
    } else if (city) {
      full += `, ${city}, ${state} ${zip}`;
    }
    out.address = full;
  }

  // ── 6. Description text (between "Description" heading and end markers) ──
  const descM = html.match(/Description[\s\S]{0,60}Details[\s\S]*?<\/[^>]{1,30}>\s*([\s\S]*?)(?=favorite_outlined|<div[^>]*class="[^"]*flag|Find More Sales)/i);
  if (descM) {
    const cleaned = descM[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length > 3) out.notes = cleaned;
  }

  // ── 7. Times from date section (heuristic) ──
  // Look for patterns like "12am", "9am", "2pm" near the date sections
  const timeBlocks = html.match(/Sale\s+Starts[\s\S]{0,200}?(\d{1,2}(?::\d{2})?\s*[ap]m)[\s\S]{0,400}?Sale\s+Ends[\s\S]{0,200}?(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  if (timeBlocks) {
    out.time = normalizeTime(timeBlocks[1]);
    out.timeEnd = normalizeTime(timeBlocks[2]);
  }

  return out;
}

// ── Helpers ──

function ent(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function monthDayToISO(monthStr, dayStr, year) {
  const mon = MONTHS[monthStr.toLowerCase()];
  if (!mon) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${dayStr.padStart(2, '0')}`;
}

function normalizeTime(raw) {
  // "12am" → "00:00", "2pm" → "14:00", "9:30am" → "09:30"
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return '';
  let h = parseInt(m[1]);
  const min = m[2] || '00';
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}
