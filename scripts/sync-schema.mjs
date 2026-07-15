#!/usr/bin/env node
/**
 * Syncs table schemas from the datapackage.json files in the openinterstate
 * and openinterstate-reachability repos into src/data/schema.json.
 * The data page renders from that file, so column docs on the site always
 * match the Data Package descriptors shipped with the data.
 *
 * Usage: node scripts/sync-schema.mjs [path-to-openinterstate] [path-to-openinterstate-reachability]
 * Defaults assume sibling checkouts next to this repo.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const coreRepo = process.argv[2] ?? join(PROJECT_ROOT, "../openinterstate");
const reachabilityRepo = process.argv[3] ?? join(PROJECT_ROOT, "../openinterstate-reachability");

function loadPackage(repoPath) {
  const path = join(repoPath, "datapackage.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(pkg.resources) || pkg.resources.length === 0) {
    throw new Error(`no resources defined in ${path}`);
  }
  const tables = pkg.resources.map((resource) => {
    const fields = resource.schema?.fields;
    if (!resource.name || !resource.description || !Array.isArray(fields) || fields.length === 0) {
      throw new Error(`incomplete resource "${resource.name ?? "?"}" in ${path}`);
    }
    for (const field of fields) {
      if (!field.name || !field.type || !field.description) {
        throw new Error(`incomplete field "${resource.name}.${field.name ?? "?"}" in ${path}`);
      }
    }
    return {
      name: resource.name,
      description: resource.description,
      ...(resource.note ? { note: resource.note } : {}),
      columns: fields.map((field) => ({
        name: field.name,
        type: field.type,
        description: field.description,
      })),
    };
  });
  return { describes_release: pkg.version, tables };
}

const out = {
  core: loadPackage(coreRepo),
  reachability: loadPackage(reachabilityRepo),
};

const outPath = join(PROJECT_ROOT, "src/data/schema.json");
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(
  `wrote src/data/schema.json: ${out.core.tables.length} core tables (${out.core.describes_release}), ` +
    `${out.reachability.tables.length} reachability tables (${out.reachability.describes_release})`
);
