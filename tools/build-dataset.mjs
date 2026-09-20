#!/usr/bin/env node
/**
 * build-dataset.mjs — DepEd Schools Connectivity clone, dataset builder.
 *
 * Fetches the public masterlist CSV from the origin dashboard, trims the
 * 49-column export down to the 13 fields the UI actually reads, and writes a
 * compact array-of-arrays JSON plus a manifest.
 *
 * Why array-of-arrays instead of array-of-objects: repeating 13 key names
 * 47,954 times costs ~8 MB of pure redundancy. The column order is published
 * in the manifest and in COLUMNS below, so the client rehydrates in one map().
 *
 * Measured output (2026-09-15): 8.06 MB raw / 1.49 MB gzip / 1.04 MB brotli.
 * Vercel's edge brotli-compresses static assets automatically, so this replaces
 * the origin's Cloud SQL instance and its 48 paginated /api/schools calls with
 * a single ~1 MB immutable CDN asset.
 *
 * Usage:
 *   node tools/build-dataset.mjs [--out public/data] [--csv <path-or-url>]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createHash, } from "node:crypto";
import { gzipSync, brotliCompressSync } from "node:zlib";
import path from "node:path";

const DEFAULT_CSV =
  "https://deped-schools-connectivity.vercel.app/dict_schools_masterlist_with_congressman.csv";

// ---------------------------------------------------------------------------
// Drift guardrails.
//
// The whole POC ships a point-in-time snapshot of an upstream export we do not
// control. Every one of these allowlists exists because a silent change to the
// upstream data reintroduces a bug we already fixed by hand. The Starlink bug
// in the origin dashboard is exactly this failure mode: a connection type
// nobody anticipated fell into an "Others" bucket and 9,909 schools went
// unlabelled for as long as the dashboard has been live. Fail the build loudly
// instead of shipping a dashboard that quietly undercounts.
// ---------------------------------------------------------------------------

/** Every `type_of_connection` value the UI has a counter for. */
const KNOWN_CONNECTION_TYPES = new Set([
  "", // blank — rendered as the "Not specified" counter
  "fiber",
  "starlink",
  "cable",
  "dsl",
  "mobile data",
  "satellite",
  "wireless broadband",
  "point-to-point",
  "others",
]);

/** Every value `connectivity` is allowed to hold. A third state changes the UI. */
const KNOWN_CONNECTIVITY_VALUES = new Set(["0", "1"]);

/** The 18 regions present as of 2026-09-15. NIR is Negros Island Region. */
const KNOWN_REGIONS = new Set([
  "BARMM", "CAR", "CARAGA", "NCR", "NIR",
  "Region I", "Region II", "Region III", "Region IV-A", "Region IV-B",
  "Region V", "Region VI", "Region VII", "Region VIII", "Region IX",
  "Region X", "Region XI", "Region XII",
]);

/** Map pan bounds from the origin dashboard's CONFIG.MAP.BOUNDS_LIMITS. */
const PH_BOUNDS = { minLat: 4.0, maxLat: 21.2, minLng: 116.0, maxLng: 126.8 };

/** Row count at the last verified build. Guards against a truncated export. */
const EXPECTED_ROW_COUNT = 47954;
const ROW_COUNT_TOLERANCE = 0.02; // ±2%

// Column order of the emitted rows. The client must use this exact order.
const COLUMNS = [
  "id",
  "school_name",
  "latitude",
  "longitude",
  "region",
  "province",
  "legislative_district",
  "municipality",
  "barangay",
  "congressman",
  "connectivity",
  "project_allocation",
  "type_of_connection",
];

function parseArgs(argv) {
  const args = { out: "public/data", csv: DEFAULT_CSV };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key && key in args && argv[i + 1]) args[key] = argv[i + 1];
  }
  return args;
}

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
function splitCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

async function loadCsv(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`CSV fetch failed: HTTP ${response.status} ${source}`);
    }
    return response.text();
  }
  return readFile(source, "utf8");
}

async function main() {
  const { out, csv: csvSource } = parseArgs(process.argv);

  console.log(`Reading ${csvSource}`);
  const csv = await loadCsv(csvSource);
  console.log(`  ${(csv.length / 1048576).toFixed(2)} MB raw CSV`);

  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);

  const indices = COLUMNS.map((column) => {
    const index = header.indexOf(column);
    if (index === -1) {
      throw new Error(
        `Column "${column}" missing from CSV header. ` +
          `The upstream export changed shape — re-verify the schema before shipping.`,
      );
    }
    return index;
  });

  const rows = [];
  const stats = {
    malformed: 0,
    invalidCoords: 0,
    outOfBounds: 0,
    duplicateIds: 0,
    connectivity: {},
    connectionTypes: {},
    regions: new Set(),
  };
  const seenIds = new Set();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fields = splitCsvLine(line);
    if (fields.length < header.length) {
      stats.malformed++;
      continue;
    }

    const row = indices.map((index) => fields[index] ?? "");
    const [, , latRaw, lngRaw] = row;
    const lat = Number.parseFloat(latRaw);
    const lng = Number.parseFloat(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) {
      stats.invalidCoords++;
    } else if (
      lat < PH_BOUNDS.minLat ||
      lat > PH_BOUNDS.maxLat ||
      lng < PH_BOUNDS.minLng ||
      lng > PH_BOUNDS.maxLng
    ) {
      // Valid numbers, but outside the map's pan bounds — these schools count
      // in the sidebar yet can never be reached on the map. Same invisible
      // class as the NaN/0 rows, so they get their own tally.
      stats.outOfBounds++;
    }

    // Marker pooling and cluster caching key on id. Duplicates silently drop
    // or double-render pins.
    const id = row[0];
    if (seenIds.has(id)) stats.duplicateIds++;
    else seenIds.add(id);

    const connectivity = row[COLUMNS.indexOf("connectivity")];
    stats.connectivity[connectivity] = (stats.connectivity[connectivity] ?? 0) + 1;

    const type = (row[COLUMNS.indexOf("type_of_connection")] || "").toLowerCase();
    stats.connectionTypes[type || "(blank)"] =
      (stats.connectionTypes[type || "(blank)"] ?? 0) + 1;

    stats.regions.add(row[COLUMNS.indexOf("region")]);
    rows.push(row);
  }

  const payload = JSON.stringify({ columns: COLUMNS, rows });
  const buffer = Buffer.from(payload);
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 8);
  const filename = `schools.v1.${hash}.json`;

  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, filename), payload);

  const manifest = {
    file: filename,
    builtAt: new Date().toISOString(),
    source: csvSource,
    columns: COLUMNS,
    rowCount: rows.length,
    malformedRows: stats.malformed,
    invalidCoordinateRows: stats.invalidCoords,
    outOfBoundsRows: stats.outOfBounds,
    duplicateIdRows: stats.duplicateIds,
    connectivityValues: stats.connectivity,
    connectionTypeCounts: stats.connectionTypes,
    regions: [...stats.regions].sort(),
    bytes: {
      raw: buffer.length,
      gzip: gzipSync(buffer).length,
      brotli: brotliCompressSync(buffer).length,
    },
  };
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`Wrote ${path.join(out, filename)}`);
  console.log(
    `  ${rows.length.toLocaleString()} rows | ` +
      `${(manifest.bytes.raw / 1048576).toFixed(2)} MB raw / ` +
      `${(manifest.bytes.gzip / 1048576).toFixed(2)} MB gzip / ` +
      `${(manifest.bytes.brotli / 1048576).toFixed(2)} MB brotli`,
  );
  console.log(
    `  ${stats.malformed} malformed, ${stats.invalidCoords} invalid coordinates, ` +
      `${stats.outOfBounds} outside PH map bounds, ${stats.duplicateIds} duplicate ids, ` +
      `${stats.regions.size} regions`,
  );

  // -------------------------------------------------------------------------
  // Drift checks. Any failure here means the upstream export changed shape
  // since the clone was built and QA'd — ship nothing until a human looks.
  // -------------------------------------------------------------------------
  const problems = [];

  const drift = Math.abs(rows.length - EXPECTED_ROW_COUNT) / EXPECTED_ROW_COUNT;
  if (drift > ROW_COUNT_TOLERANCE) {
    problems.push(
      `Row count ${rows.length.toLocaleString()} drifted ${(drift * 100).toFixed(1)}% ` +
        `from the verified ${EXPECTED_ROW_COUNT.toLocaleString()} (tolerance ` +
        `±${ROW_COUNT_TOLERANCE * 100}%). Export may be truncated or expanded.`,
    );
  }

  const unknownTypes = Object.keys(stats.connectionTypes)
    .map((key) => (key === "(blank)" ? "" : key))
    .filter((type) => !KNOWN_CONNECTION_TYPES.has(type));
  if (unknownTypes.length > 0) {
    problems.push(
      `Unknown type_of_connection value(s): ${unknownTypes.map((t) => `"${t}"`).join(", ")}. ` +
        `These would fall into the "Others" bucket unlabelled — the exact bug that hid ` +
        `9,909 Starlink schools in the origin dashboard. Add a counter before shipping.`,
    );
  }

  const unknownConnectivity = Object.keys(stats.connectivity).filter(
    (value) => !KNOWN_CONNECTIVITY_VALUES.has(value),
  );
  if (unknownConnectivity.length > 0) {
    problems.push(
      `Unknown connectivity value(s): ${unknownConnectivity.map((v) => `"${v}"`).join(", ")}. ` +
        `The UI only models connected/unconnected — a third state needs a legend row ` +
        `and a stat bucket, not a silent coercion.`,
    );
  }

  const unknownRegions = [...stats.regions].filter((region) => !KNOWN_REGIONS.has(region));
  if (unknownRegions.length > 0) {
    problems.push(
      `Unknown region(s): ${unknownRegions.map((r) => `"${r}"`).join(", ")}. ` +
        `The region filter, its BARMM master checkboxes, and the province cascade ` +
        `all assume the verified 18-region set.`,
    );
  }

  if (stats.duplicateIds > 0) {
    problems.push(
      `${stats.duplicateIds} duplicate school id(s). Marker pooling and the cluster ` +
        `percent cache key on id — duplicates drop or double-render pins.`,
    );
  }

  if (stats.malformed > 0) {
    console.warn(`  WARNING: ${stats.malformed} malformed rows were dropped.`);
  }
  if (stats.outOfBounds > 0) {
    console.warn(
      `  WARNING: ${stats.outOfBounds} rows have valid coordinates outside the PH map ` +
        `bounds. They count in the sidebar but are unreachable on the map.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Upstream data drift detected — refusing to ship:\n` +
        problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n"),
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
