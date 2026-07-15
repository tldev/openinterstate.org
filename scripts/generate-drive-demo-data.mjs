#!/usr/bin/env node
/**
 * Generates the homepage drive-demo dataset: one corridor's exits in
 * driving order, each with its best reachable places and drive times.
 * Joins corridor_exits + exit_place_links + places from an extracted
 * OpenInterstate release with reachability.csv from a reachability release.
 *
 * Usage: node scripts/generate-drive-demo-data.mjs <release-csv-dir> <reachability.csv> \
 *          [--interstate I-90] [--direction east] [--release <tag>] [--score-release <tag>]
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const csvDir = positional[0];
const reachabilityPath = positional[1];
if (!csvDir || !reachabilityPath) {
  console.error("Usage: generate-drive-demo-data.mjs <release-csv-dir> <reachability.csv> [--interstate I-90] [--direction east]");
  process.exit(1);
}

const INTERSTATE = opt("interstate", "I-90");
const DIRECTION = opt("direction", "east");
const RELEASE = opt("release", "release-2026-07-13-gha-33");
const SCORE_RELEASE = opt("score-release", "score-20260715-1351876");

const CATEGORY_LABELS = {
  gas: "gas",
  food: "food",
  lodging: "lodging",
  evCharging: "EV charging",
  restArea: "rest area",
  park: "park",
  dogPark: "dog park",
};

// Split one CSV line into fields (RFC 4180; fields never contain newlines
// in these exports, so per-line parsing is safe and fast).
function splitLine(line) {
  const fields = [];
  let i = 0;
  const len = line.length;
  while (i <= len) {
    let v = "";
    if (line[i] === '"') {
      i++;
      while (i < len) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { v += '"'; i += 2; }
          else { i++; break; }
        } else { v += line[i++]; }
      }
    } else {
      while (i < len && line[i] !== ",") v += line[i++];
    }
    fields.push(v);
    if (i >= len) break;
    i++; // skip comma
  }
  return fields;
}

function* rows(path) {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  const header = splitLine(lines[0].replace(/\r$/, ""));
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, "");
    if (!line) continue;
    const fields = splitLine(line);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = fields[c] ?? "";
    yield row;
  }
}

// 1. Exits for the chosen corridor, in driving order.
const exits = [];
for (const r of rows(join(csvDir, "corridor_exits.csv"))) {
  if (r.interstate_name === INTERSTATE && r.direction_code === DIRECTION) {
    exits.push({
      id: r.exit_id,
      seq: Number(r.sequence_index),
      n: r.exit_number,
      name: r.exit_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
    });
  }
}
exits.sort((a, b) => a.seq - b.seq);
const exitIds = new Set(exits.map((e) => e.id));
console.log(`${INTERSTATE} ${DIRECTION}: ${exits.length} exits`);

// 2. Candidate places per exit.
const linkedPlaces = new Map(); // exit_id -> place_id[]
for (const r of rows(join(csvDir, "exit_place_links.csv"))) {
  if (exitIds.has(r.exit_id)) {
    if (!linkedPlaces.has(r.exit_id)) linkedPlaces.set(r.exit_id, []);
    linkedPlaces.get(r.exit_id).push(r.place_id);
  }
}

// 3. Drive times for reachable pairs.
const reach = new Map(); // "exit|place" -> {min, score}
for (const r of rows(reachabilityPath)) {
  if (exitIds.has(r.exit_id) && r.reachable === "t" && r.route_duration_s !== "") {
    reach.set(`${r.exit_id}|${r.place_id}`, {
      min: Math.max(1, Math.round(Number(r.route_duration_s) / 60)),
      score: Number(r.reachability_score),
    });
  }
}

// 4. Place labels and categories.
const neededPlaces = new Set();
for (const ids of linkedPlaces.values()) for (const p of ids) neededPlaces.add(p);
const places = new Map();
for (const r of rows(join(csvDir, "places.csv"))) {
  if (neededPlaces.has(r.place_id)) {
    const label = r.display_name || r.brand || r.name;
    if (!label) continue;
    let lat = null;
    let lon = null;
    try {
      const geom = JSON.parse(r.geometry_geojson);
      if (geom.type === "Point") [lon, lat] = geom.coordinates;
    } catch {
      continue;
    }
    if (lat === null) continue;
    places.set(r.place_id, { label, cat: CATEGORY_LABELS[r.category] || r.category, lat, lon });
  }
}

// 5. Assemble: top places per exit by score, deduped by label.
// Place coordinates ship as integer deltas from the exit in 1e-4 degrees
// (about 11 m of precision) to keep the payload small.
const out = [];
let withServices = 0;
for (const e of exits) {
  const seen = new Set();
  const scored = [];
  for (const pid of linkedPlaces.get(e.id) || []) {
    const hit = reach.get(`${e.id}|${pid}`);
    const place = places.get(pid);
    if (!hit || !place) continue;
    const key = place.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ ...place, ...hit });
  }
  scored.sort((a, b) => b.score - a.score || a.min - b.min);
  const top = scored
    .slice(0, 6)
    .map((p) => [
      p.label,
      p.cat,
      p.min,
      Math.round((p.lat - e.lat) * 1e4),
      Math.round((p.lon - e.lon) * 1e4),
    ]);
  if (top.length > 0) withServices++;
  out.push({
    n: e.n,
    name: e.name,
    ll: [Number(e.lat.toFixed(5)), Number(e.lon.toFixed(5))],
    p: top,
  });
}
console.log(`exits with scored services: ${withServices}/${out.length}`);

const payload = {
  interstate: INTERSTATE,
  direction: DIRECTION === "east" ? "eastbound" : DIRECTION === "west" ? "westbound" : `${DIRECTION}bound`,
  release: RELEASE,
  scoreRelease: SCORE_RELEASE,
  exits: out,
};

const outPath = join(PROJECT_ROOT, "src/data/drive-demo.json");
writeFileSync(outPath, JSON.stringify(payload) + "\n");
console.log(`wrote ${outPath} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
