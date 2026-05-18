#!/usr/bin/env node
// build-cache.js — pre-fetches Overpass tree/vegetation data for specific ZIP codes.
// Pollen/AQ data is always fetched live in the app (it's a daily forecast).
//
// Usage:  node build-cache.js
// Requires Node 18+ (built-in fetch). No dependencies.

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const ZIPS   = ['02176', '01844'];
const RADIUS = 2500; // metres — generous so the app's radius slider always fits inside

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const CACHE_DIR = path.join(__dirname, 'cache');
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocodeZip(zip) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(zip)}&format=json&limit=1&addressdetails=1&countrycodes=us`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'BreatheEasyCache/1.0', 'Accept-Language': 'en' },
  });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  const results = await resp.json();
  if (!results.length) throw new Error(`No geocoding result for ${zip}`);
  const r = results[0];
  const name = r.address?.city || r.address?.town || r.address?.village ||
               r.address?.county || r.address?.state || zip;
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name };
}

async function fetchOverpass(lat, lon, radius) {
  const query = `
[out:json][timeout:60];
(
  node["natural"="tree"](around:${radius},${lat},${lon});
  way["landuse"~"^(grass|meadow|farmland)$"](around:${radius},${lat},${lon});
  way["natural"~"^(grassland|scrub|heath)$"](around:${radius},${lat},${lon});
);
out body;
>;
out skel qt;
`.trim();

  let lastErr;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      process.stdout.write(`    trying ${new URL(mirror).hostname}… `);
      const resp = await fetch(mirror, {
        method: 'POST',
        body:   'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'BreatheEasyCache/1.0',
        },
        signal: AbortSignal.timeout(65_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      console.log(`✓  (${data.elements.length} elements)`);
      return data;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      lastErr = e;
      await sleep(1500);
    }
  }
  throw new Error(`All Overpass mirrors failed for ${lat},${lon}: ${lastErr.message}`);
}

async function buildCache(zip) {
  console.log(`\n── ${zip} ─────────────────────────────`);

  process.stdout.write(`  geocoding… `);
  const geo = await geocodeZip(zip);
  console.log(`${geo.name}  (${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)})`);

  await sleep(1100); // Nominatim rate-limit: 1 req/sec

  console.log(`  fetching Overpass (${RADIUS}m radius):`);
  const osm = await fetchOverpass(geo.lat, geo.lon, RADIUS);

  const record = {
    zip,
    name:    geo.name,
    lat:     geo.lat,
    lon:     geo.lon,
    radius:  RADIUS,
    fetched: new Date().toISOString(),
    osm,
  };

  const outPath = path.join(CACHE_DIR, `${zip}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record));

  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`  saved → cache/${zip}.json  (${kb} KB)`);
}

(async () => {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

  console.log('Breathe Easy — cache builder');
  console.log(`ZIPs: ${ZIPS.join(', ')}   radius: ${RADIUS}m`);

  let ok = 0;
  for (let i = 0; i < ZIPS.length; i++) {
    try {
      await buildCache(ZIPS[i]);
      ok++;
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
    if (i < ZIPS.length - 1) await sleep(2000);
  }

  console.log(`\nDone — ${ok}/${ZIPS.length} cached.`);
  if (ok < ZIPS.length) process.exit(1);
})();
