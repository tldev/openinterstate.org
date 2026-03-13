#!/usr/bin/env node
/**
 * Generates pre-projected SVG map data for the interstate map component.
 * Reads reference_routes.csv, simplifies geometries, projects to Albers Equal Area,
 * and outputs a JSON file for the Astro component.
 *
 * Usage: node scripts/generate-map-data.mjs [path-to-reference_routes.csv]
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const W = 960;
const H = 600;
const PAD = 30;

// --- Albers Equal Area Conic (lower 48 US) ---
const DEG = Math.PI / 180;
const PHI0 = 39 * DEG;
const LAM0 = -96 * DEG;
const PHI1 = 29.5 * DEG;
const PHI2 = 45.5 * DEG;
const n_alb = (Math.sin(PHI1) + Math.sin(PHI2)) / 2;
const C_alb = Math.cos(PHI1) ** 2 + 2 * n_alb * Math.sin(PHI1);
const rho0_alb = Math.sqrt(C_alb - 2 * n_alb * Math.sin(PHI0)) / n_alb;

function project(lon, lat) {
  const lam = lon * DEG;
  const phi = lat * DEG;
  const rho = Math.sqrt(C_alb - 2 * n_alb * Math.sin(phi)) / n_alb;
  const theta = n_alb * (lam - LAM0);
  return [rho * Math.sin(theta), -(rho0_alb - rho * Math.cos(theta))];
}

// --- Douglas-Peucker simplification ---
function perpDistSq(p, a, b) {
  let dx = b[0] - a[0],
    dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq > 0) {
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    dx = a[0] + t * dx - p[0];
    dy = a[1] + t * dy - p[1];
    return dx * dx + dy * dy;
  }
  return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
}

function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const tolSq = tol * tol;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, maxI = s;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistSq(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolSq) {
      keep[maxI] = 1;
      if (maxI - s > 1) stack.push([s, maxI]);
      if (e - maxI > 1) stack.push([maxI, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// --- CSV parser (RFC 4180) ---
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function field() {
    if (i >= len || text[i] === "\n" || text[i] === "\r") return "";
    if (text[i] === '"') {
      i++;
      let v = "";
      while (i < len) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { v += '"'; i += 2; }
          else { i++; break; }
        } else { v += text[i++]; }
      }
      return v;
    }
    let v = "";
    while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") v += text[i++];
    return v;
  }

  while (i < len) {
    const row = [];
    while (true) {
      row.push(field());
      if (i >= len || text[i] === "\n" || text[i] === "\r") break;
      if (text[i] === ",") i++;
    }
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  const hdr = rows[0];
  return rows.slice(1).map((row) => {
    const o = {};
    hdr.forEach((h, j) => (o[h] = row[j] || ""));
    return o;
  });
}

// --- Helpers ---
const rd = (v) => Math.round(v * 10) / 10;

function toPath(pts) {
  if (!pts.length) return "";
  let d = `M${rd(pts[0][0])},${rd(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${rd(pts[i][0])},${rd(pts[i][1])}`;
  return d;
}

function toMultiPath(segments) {
  return segments.map((segment) => toPath(segment)).filter(Boolean).join(" ");
}

// --- Fetch state boundaries ---
async function fetchStates() {
  const url = "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json";
  console.log("Fetching US state boundaries...");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`State fetch failed: ${resp.status}`);
  const geo = await resp.json();
  const skip = new Set(["Alaska", "Hawaii", "Puerto Rico", "American Samoa", "Guam", "U.S. Virgin Islands", "Northern Mariana Islands"]);
  return geo.features.filter((f) => !skip.has(f.properties.name));
}

// --- Main ---
async function main() {
  const csvPath = process.argv[2] || "/tmp/openinterstate-release/release-2026-03-12-coldpath/csv/reference_routes.csv";

  // 1. Parse CSV
  console.log(`Reading ${csvPath}...`);
  const rows = parseCSV(readFileSync(csvPath, "utf-8"));
  console.log(`${rows.length} total reference routes`);

  // 2. Filter to primary interstates (1-2 digit)
  const primary = rows.filter((r) => /^I-\d{1,2}$/.test(r.interstate_name));
  console.log(`${primary.length} primary interstate routes`);

  // 3. Deduplicate directions (one per interstate, prefer NB/EB)
  const groups = new Map();
  for (const r of primary) {
    const k = r.interstate_name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const deduped = [];
  for (const [, routes] of groups) {
    deduped.push(routes.find((r) => r.direction_code === "NB" || r.direction_code === "EB") || routes[0]);
  }
  console.log(`${deduped.length} interstates after direction dedup`);

  // 4. Project all interstate coordinates (preserve route segment breaks)
  const rawInterstates = deduped.map((route) => {
    const geojson = JSON.parse(route.geometry_geojson);
    const segments = geojson.type === "MultiLineString" ? geojson.coordinates : [geojson.coordinates];
    return {
      name: route.interstate_name,
      num: route.interstate_name.replace("I-", ""),
      projectedSegments: segments.map((coords) => coords.map(([lon, lat]) => project(lon, lat))),
    };
  });

  // 5. Fetch and project state boundaries
  const stateFeatures = await fetchStates();
  const rawStates = [];
  for (const feat of stateFeatures) {
    const geom = feat.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    for (const poly of polys) {
      for (const ring of poly) {
        rawStates.push(ring.map(([lon, lat]) => project(lon, lat)));
      }
    }
  }

  // 6. Compute bounding box of all projected data
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function updateBB(pts) {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (const i of rawInterstates) {
    for (const segment of i.projectedSegments) updateBB(segment);
  }
  for (const s of rawStates) updateBB(s);

  // 7. Scale and offset to fit viewport
  const dw = maxX - minX, dh = maxY - minY;
  const sc = Math.min((W - 2 * PAD) / dw, (H - 2 * PAD) / dh);
  const ox = PAD + ((W - 2 * PAD) - dw * sc) / 2 - minX * sc;
  const oy = PAD + ((H - 2 * PAD) - dh * sc) / 2 - minY * sc;
  const tx = ([x, y]) => [x * sc + ox, y * sc + oy];

  // 8. Transform, simplify, and generate paths
  const ROUTE_TOL = 0.7; // px tolerance for routes
  const STATE_TOL = 1.0; // px tolerance for states

  const interstates = rawInterstates.map((r) => {
    const segments = r.projectedSegments
      .map((segment) => simplify(segment.map(tx), ROUTE_TOL))
      .filter((segment) => segment.length >= 2);
    const pts = segments.flat();
    const mid = pts[Math.floor(pts.length / 2)] || [0, 0];
    return {
      name: r.name,
      num: r.num,
      d: toMultiPath(segments),
      lx: rd(mid[0]),
      ly: rd(mid[1]),
      n: pts.length,
    };
  });

  const states = rawStates
    .map((ring) => {
      let pts = ring.map(tx);
      pts = simplify(pts, STATE_TOL);
      return pts.length >= 3 ? toPath(pts) + "Z" : null;
    })
    .filter(Boolean);

  const totalPts = interstates.reduce((s, i) => s + i.n, 0);
  console.log(`Interstate points after simplification: ${totalPts}`);
  console.log(`State boundary paths: ${states.length}`);

  // 9. Write output
  const data = { viewBox: `0 0 ${W} ${H}`, states, interstates };
  const json = JSON.stringify(data);
  const outPath = join(PROJECT_ROOT, "src/data/interstate-map.json");
  writeFileSync(outPath, json);
  console.log(`Wrote ${outPath} (${(json.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
