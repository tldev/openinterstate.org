#!/usr/bin/env node
/**
 * Generates pre-projected SVG map data for the interstate map component.
 * Reads reference_routes.csv, simplifies geometries, projects to Albers Equal Area,
 * and outputs a JSON file for the Astro component.
 *
 * Usage: node scripts/generate-map-data.mjs [path-to-csv-dir-or-reference_routes.csv]
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

function pointInPoly(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function toMultiPath(segments) {
  return segments.map((segment) => toPath(segment)).filter(Boolean).join(" ");
}

// --- Segment merging ---
function ptDist(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function segmentLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += ptDist(pts[i], pts[i - 1]);
  return len;
}

/**
 * Greedily chain segments whose endpoints are within `threshold` SVG px.
 * Drops the redundant near-duplicate point at each join.
 */
function mergeAdjacentSegments(segments, threshold) {
  if (segments.length <= 1) return segments;
  const used = new Uint8Array(segments.length);
  const chains = [];

  for (let seed = 0; seed < segments.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;
    const chain = segments[seed].slice();

    let extended = true;
    while (extended) {
      extended = false;
      const cEnd = chain[chain.length - 1];
      const cStart = chain[0];
      let bestJ = -1, bestD = threshold, bestMode = "";

      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const s = segments[j];
        const sStart = s[0], sEnd = s[s.length - 1];
        let d;

        d = ptDist(cEnd, sStart);
        if (d < bestD) { bestD = d; bestJ = j; bestMode = "append"; }
        d = ptDist(cEnd, sEnd);
        if (d < bestD) { bestD = d; bestJ = j; bestMode = "append-rev"; }
        d = ptDist(cStart, sEnd);
        if (d < bestD) { bestD = d; bestJ = j; bestMode = "prepend"; }
        d = ptDist(cStart, sStart);
        if (d < bestD) { bestD = d; bestJ = j; bestMode = "prepend-rev"; }
      }

      if (bestJ >= 0) {
        used[bestJ] = 1;
        extended = true;
        const s = segments[bestJ];
        switch (bestMode) {
          case "append":
            chain.push(...s.slice(1));
            break;
          case "append-rev":
            for (let k = s.length - 2; k >= 0; k--) chain.push(s[k]);
            break;
          case "prepend":
            chain.unshift(...s.slice(0, -1));
            break;
          case "prepend-rev":
            chain.unshift(...s.slice(1).reverse());
            break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

function segmentsBBox(segments) {
  if (segments.length === 0) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    for (const [x, y] of seg) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
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
  const arg = process.argv[2] || "/tmp/openinterstate-release/release-2026-03-12-coldpath/csv/reference_routes.csv";

  // Resolve CSV directory — accept either a directory or a direct path to reference_routes.csv
  const csvDir = arg.endsWith(".csv") ? dirname(arg) : arg;
  const csvPath = join(csvDir, "reference_routes.csv");

  // 1. Parse CSV
  console.log(`Reading ${csvPath}...`);
  const rows = parseCSV(readFileSync(csvPath, "utf-8"));
  console.log(`${rows.length} total reference routes`);

  // 1b. Parse corridor_exits for exit counts per interstate per direction
  const exitCountsPath = join(csvDir, "corridor_exits.csv");
  const exitCounts = new Map(); // "I-10" -> { east: Set, west: Set }
  try {
    const exitRows = parseCSV(readFileSync(exitCountsPath, "utf-8"));
    for (const r of exitRows) {
      if (!exitCounts.has(r.interstate_name)) exitCounts.set(r.interstate_name, new Map());
      const dirs = exitCounts.get(r.interstate_name);
      if (!dirs.has(r.direction_code)) dirs.set(r.direction_code, new Set());
      dirs.get(r.direction_code).add(r.exit_id);
    }
    console.log(`Loaded exit counts for ${exitCounts.size} interstates`);
  } catch {
    console.log("corridor_exits.csv not found, skipping exit counts");
  }

  // 1c. Sum distances per interstate per direction from reference routes
  const distances = new Map(); // "I-10" -> { EB: meters, WB: meters }
  for (const r of rows) {
    if (!distances.has(r.interstate_name)) distances.set(r.interstate_name, new Map());
    const dirs = distances.get(r.interstate_name);
    dirs.set(r.direction_code, (dirs.get(r.direction_code) || 0) + parseFloat(r.distance_m));
  }

  // 2. Filter to map-display interstates:
  //    - primary interstates (1-2 digit)
  //    - currently supported official signed branches
  const primary = rows.filter((r) => /^(?:I-\d{1,2}|I-35[EW]|I-69[CEW])$/.test(r.interstate_name));
  console.log(`${primary.length} map-display interstate routes`);

  // 3. Choose one display direction per interstate (prefer NB/EB), but keep
  // all route rows in that direction so disjoint systems like I-76 do not lose
  // one side of the country.
  const groups = new Map();
  for (const r of primary) {
    const k = r.interstate_name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const deduped = [];
  for (const [name, routes] of groups) {
    const preferredDirection =
      routes.find((r) => r.direction_code === "NB")?.direction_code ||
      routes.find((r) => r.direction_code === "EB")?.direction_code ||
      routes[0]?.direction_code;
    if (!preferredDirection) continue;
    deduped.push({
      name,
      directionCode: preferredDirection,
      routes: routes.filter((r) => r.direction_code === preferredDirection),
    });
  }
  console.log(`${deduped.length} interstates after direction dedup`);

  // Direction code mapping: corridor_exits uses east/west/north/south,
  // reference_routes uses EB/WB/NB/SB
  const dirMap = { east: "Eastbound", west: "Westbound", north: "Northbound", south: "Southbound" };
  const dirCodeToLabel = { EB: "Eastbound", WB: "Westbound", NB: "Northbound", SB: "Southbound" };

  // 4. Project all interstate coordinates (preserve route segment breaks)
  const rawInterstates = deduped.map((entry) => {
    const segments = [];
    for (const route of entry.routes) {
      const geojson = JSON.parse(route.geometry_geojson);
      const routeSegments = geojson.type === "MultiLineString" ? geojson.coordinates : [geojson.coordinates];
      segments.push(...routeSegments);
    }

    // Build metadata for this interstate
    const name = entry.name;
    const distDirs = distances.get(name) || new Map();
    const exitDirs = exitCounts.get(name) || new Map();

    // Total length in miles (average of both directions)
    const distValues = [...distDirs.values()];
    const avgDist = distValues.length ? distValues.reduce((a, b) => a + b, 0) / distValues.length : 0;
    const lengthMi = Math.round(avgDist / 1609.34);

    // Exit counts per direction label
    const exits = {};
    for (const [code, ids] of exitDirs) {
      const label = dirMap[code];
      if (label) exits[label] = ids.size;
    }

    return {
      name,
      num: name.replace("I-", ""),
      lengthMi,
      exits,
      projectedSegments: segments.map((coords) => coords.map(([lon, lat]) => project(lon, lat))),
    };
  });

  // 5. Fetch and project state boundaries
  const stateFeatures = await fetchStates();
  const rawStates = [];
  for (const feat of stateFeatures) {
    const geom = feat.geometry;
    const name = feat.properties.name;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    for (const poly of polys) {
      for (const ring of poly) {
        rawStates.push({ name, pts: ring.map(([lon, lat]) => project(lon, lat)) });
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
  for (const s of rawStates) updateBB(s.pts);

  // 7. Scale and offset to fit viewport
  const dw = maxX - minX, dh = maxY - minY;
  const sc = Math.min((W - 2 * PAD) / dw, (H - 2 * PAD) / dh);
  const ox = PAD + ((W - 2 * PAD) - dw * sc) / 2 - minX * sc;
  const oy = PAD + ((H - 2 * PAD) - dh * sc) / 2 - minY * sc;
  const tx = ([x, y]) => [x * sc + ox, y * sc + oy];

  // 8. Transform, simplify, and generate paths
  const ROUTE_TOL = 0.7; // px tolerance for routes
  const STATE_TOL = 1.0; // px tolerance for states

  const MERGE_THRESHOLD = 1.5; // SVG px — max endpoint gap to merge
  const MIN_SEGMENT_PX = 5;    // SVG px — drop micro-fragments shorter than this

  let totalGapsMerged = 0, totalMicroRemoved = 0;

  const interstates = rawInterstates.map((r) => {
    let segments = r.projectedSegments
      .map((segment) => simplify(segment.map(tx), ROUTE_TOL))
      .filter((segment) => segment.length >= 2);
    const beforeCount = segments.length;

    // Drop micro-fragments that survive simplification (Bug 2)
    segments = segments.filter((seg) => segmentLength(seg) >= MIN_SEGMENT_PX);
    const microRemoved = beforeCount - segments.length;
    const preMergeBBox = segmentsBBox(segments);

    // Merge adjacent segments with near-matching endpoints (Bug 1)
    segments = mergeAdjacentSegments(segments, MERGE_THRESHOLD);
    const afterCount = segments.length;
    const gapsMerged = beforeCount - microRemoved - afterCount;

    totalGapsMerged += gapsMerged;
    totalMicroRemoved += microRemoved;

    // Validation: segment count never increases, merge preserves bounding box
    if (afterCount > beforeCount) {
      console.error(`  WARNING: ${r.name} segment count increased ${beforeCount} → ${afterCount}`);
    }
    const afterBBox = segmentsBBox(segments);
    const mergeDrift = Math.max(
      ...preMergeBBox.map((v, i) => Math.abs(v - afterBBox[i]))
    );
    if (mergeDrift > MERGE_THRESHOLD) {
      console.error(`  WARNING: ${r.name} merge shifted bounding box by ${mergeDrift.toFixed(1)}px`);
    }

    if (gapsMerged > 0 || microRemoved > 0) {
      console.log(`  ${r.name}: ${beforeCount} → ${afterCount} segments` +
        (gapsMerged > 0 ? ` (${gapsMerged} gaps merged)` : "") +
        (microRemoved > 0 ? ` (${microRemoved} micro removed)` : ""));
    }

    const pts = segments.flat();
    const mid = pts[Math.floor(pts.length / 2)] || [0, 0];
    return {
      name: r.name,
      num: r.num,
      d: toMultiPath(segments),
      lx: rd(mid[0]),
      ly: rd(mid[1]),
      n: pts.length,
      lengthMi: r.lengthMi,
      exits: r.exits,
    };
  });

  if (totalGapsMerged > 0 || totalMicroRemoved > 0) {
    console.log(`Segment cleanup: ${totalGapsMerged} gaps merged, ${totalMicroRemoved} micro-fragments removed`);
  }

  const states = rawStates
    .map((ring) => {
      let pts = ring.pts.map(tx);
      pts = simplify(pts, STATE_TOL);
      return pts.length >= 3 ? { name: ring.name, d: toPath(pts) + "Z" } : null;
    })
    .filter(Boolean);

  const totalPts = interstates.reduce((s, i) => s + i.n, 0);
  console.log(`Interstate points after simplification: ${totalPts}`);
  console.log(`State boundary paths: ${states.length}`);

  // 9. Compute state-to-interstates mapping via point-in-polygon
  const statePolys = rawStates.map((ring) => ({ name: ring.name, pts: ring.pts.map(tx) }));
  const stateInterstates = {};
  for (const r of rawInterstates) {
    const allPts = r.projectedSegments.flatMap((seg) => seg.map(tx));
    const step = Math.max(1, Math.floor(allPts.length / 80));
    const hitStates = new Set();
    for (let i = 0; i < allPts.length; i += step) {
      const [x, y] = allPts[i];
      for (const sp of statePolys) {
        if (!hitStates.has(sp.name) && pointInPoly(x, y, sp.pts)) {
          hitStates.add(sp.name);
        }
      }
    }
    for (const s of hitStates) {
      if (!stateInterstates[s]) stateInterstates[s] = [];
      stateInterstates[s].push(r.name);
    }
  }
  // Sort interstates within each state by number
  for (const s of Object.keys(stateInterstates)) {
    stateInterstates[s].sort((a, b) => parseInt(a.replace("I-", "")) - parseInt(b.replace("I-", "")));
  }
  console.log(`State-interstate mappings: ${Object.keys(stateInterstates).length} states`);

  // 10. Write output
  const data = { viewBox: `0 0 ${W} ${H}`, states, interstates, stateInterstates };
  const json = JSON.stringify(data);
  const outPath = join(PROJECT_ROOT, "src/data/interstate-map.json");
  writeFileSync(outPath, json);
  console.log(`Wrote ${outPath} (${(json.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
