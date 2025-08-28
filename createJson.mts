// Usage: node createJson.mts <locale>
// Locale must be a key of queriesByLocale.
//
// Directory structure:
// | createJson.mts
// | en-us
//   | en-us-2025.csv
//   | en-us-2026.csv
// | de-de
//   | de-de-2025.csv
//   | de-de-2026.csv
// | out
//   | <empty>

import { readdir, readFile, writeFile } from "node:fs/promises";
import Papa from "papaparse";

const queriesByLocale: Record<string, string[]> = {
  "en-us": ["", "when's ", "whens ", "when is "],
  "en-uk": ["", "when's ", "whens ", "when is "],
  "de-de": ["", "wann ist "],
  "it-it": ["", "quando è ", "Quando e ", "Quando cade ", "data "],
  "fr-fr": ["", "quand est ", "C'est quand ", "Cest quand "],
};

interface DateInfo {
  name: string;
  kw: string;
  dates: { [year: string]: Date | Date[] };
}

function addKW(base: DateInfo, kw: string) {
  if (!kw) {
    return;
  }
  if (!base.kw) {
    base.kw = kw;
    return;
  }
  if (base.kw != kw) {
    throw new Error(
      `Tried to add keyword '${kw}' but there already is a keyword'${base.kw}'`
    );
  }
}

/**
 * Removes strings that are prefixed by other (shorter) strings from the set.
 */
function removePrefixedStrings(strings: Set<string>) {
  // Sorted by length, shortest first.
  let sortedStrings = strings
    .keys()
    .toArray()
    .sort((a, b) => a.length - b.length);

  let out: Set<string> = new Set();
  for (let string of sortedStrings) {
    if (!out.keys().some(prefix => string.startsWith(prefix))) {
      out.add(string);
    }
  }
  return out;
}

/**
 * Removes strings that are prefixes of other (longer) strings from the set.
 */
function removePrefixStrings(strings: Set<string>) {
  // Sorted by length, longest first.
  let sortedStrings = strings
    .keys()
    .toArray()
    .sort((a, b) => b.length - a.length);

  let out: Set<string> = new Set();
  for (let string of sortedStrings) {
    if (!out.keys().some(suffix => suffix.startsWith(string))) {
      out.add(string);
    }
  }
  return out;
}

/**
 * Converts a date into a "YYYY-MM-DD" string.
 */
function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function generateKeywords(dateInfo: DateInfo): [string, string[]][] {
  if (!dateInfo.kw) {
    throw new Error(dateInfo.name + " has no keywords");
  }
  let keywords = dateInfo.kw.split(",").map(kw => kw.toLowerCase().trim());
  if (keywords.some(kw => !kw.includes("|"))) {
    throw new Error(dateInfo.name + " has a keyword without a |");
  }

  // Add versions without punctuation (preserve |) and dedupe.
  keywords.push(...keywords.map(kw => kw.replace(/[^\w\s|]/g, "")));
  keywords = new Set(keywords).keys().toArray();

  let out: [string, string[]][] = [];
  let prefixes = new Set(keywords.map(kw => kw.split("|")[0]!));
  keywords = keywords.map(kw => kw.replace("|", ""));
  for (let prefix of removePrefixedStrings(prefixes)) {
    let suffixes = new Set(
      keywords
        .filter(kw => kw.startsWith(prefix))
        .map(kw => kw.slice(prefix.length))
    );
    let cleanedSuffixes = removePrefixStrings(suffixes).keys().toArray();

    for (let query of queries) {
      out.push([query + prefix, cleanedSuffixes]);
    }
  }
  return out;
}

/**
 * @returns the longest common prefix of s1 and s2
 */
function lcp(s1: string, s2: string): number {
  for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
    if (s1[i] != s2[i]) {
      return i;
    }
  }
  return Math.min(s1.length, s2.length);
}

//
// Script starts here
//

if (!Object.keys(queriesByLocale).includes(process.argv[2]!)) {
  throw new Error("Unknown locale " + (process.argv[2] ?? ""));
}
let locale = process.argv[2]!;
let queries = queriesByLocale[locale]!;

// Step 1: Parse CSVs into DateInfo objects
let dir = locale + "/";
let files = await readdir(dir);
files = files.filter(f => f.endsWith(".csv")).map(f => dir + f);

let dates: { [name: string]: DateInfo } = {};
let allYears: Set<string> = new Set();

for (let path of files) {
  console.log(`Info: Parsing ${path}`);
  let text = await readFile(path, { encoding: "utf-8" });
  let lines = Papa.parse(text).data as [string, string, string, string][];
  lines.shift(); // Ignore header.

  let year = path.match(/(\d{4})\.csv$/)?.[1];
  if (!year) throw new Error("Could not determine year");
  allYears.add(year);

  for (let line of lines) {
    if (line.length < 3) throw new Error("Invalid CSV at " + path);
    let [dateStartStr, dateEndStr, name, kw] = line;

    let dateStart = new Date(dateStartStr + "Z");
    let dateEnd = dateEndStr ? new Date(dateEndStr + "Z") : null;

    let date = dateEnd ? [dateStart, dateEnd] : dateStart;

    if (dateStart.getFullYear() != parseInt(year)) throw new Error(line);

    if (name in dates) {
      let dateInfo = dates[name]!;
      if (dateInfo.dates[year]) throw new Error();
      dateInfo.dates[year] = date;
      addKW(dateInfo, kw);
    } else {
      dates[name] = {
        name,
        kw,
        dates: { [year]: date },
      };
    }
  }
}

// Step 2: Build suggest JSON from collected DateInfo objects
console.log();

let output = [];
for (let dateInfo of Object.values(dates)) {
  let sortedYears = Object.keys(dateInfo.dates).sort();
  let dates = [];

  for (let year of sortedYears) {
    let date = dateInfo.dates[year]!;

    if (Array.isArray(date)) {
      if (!date[0] || !date[1]) {
        throw new Error();
      }
      dates.push([getDateStr(date[0]), getDateStr(date[1])]);
    } else {
      dates.push(getDateStr(date));
    }
  }

  let keywords = generateKeywords(dateInfo);

  output.push({
    data: {
      result: {
        isImportantDate: true,
        payload: {
          dates,
          name: dateInfo.name,
        },
      },
    },
    keywords,
    dismissal_key: dateInfo.name,
  });
}

await writeFile(
  "out/important-dates-" + locale + ".json",
  JSON.stringify(output, undefined, 2)
);

// Step 3: Scan output for anomalies

// All keywords as [prefix, suffix, suffixGroup].
// The prefix is the part that is mandatory to type.
let allKW = [] as [string, string, number][];
// A suffix group is an array of suffixes in the output json.
// This counter assigns a number to each suffix group.
let suggestionID = 0;
for (let o of output) {
  let payload = o.data.result.payload;
  let dates = payload.dates;

  // Warn if an event doesn't happen every year.
  // For some (e.g. inauguration day) this is expected.
  let years = new Set(
    dates.map(d => (Array.isArray(d) ? d[0]! : d).slice(0, 4))
  );
  let diff = allYears.symmetricDifference(years);
  if (diff.size) {
    console.log(
      `Warning: ${payload.name} does not exist in year ${diff.keys().toArray()}`
    );
  }

  if (dates.some(Array.isArray) && !dates.every(Array.isArray)) {
    console.log(
      `Warning: ${payload.name} sometimes is a date and sometimes is a range`
    );
  }

  for (let kw of o.keywords) {
    let prefix = kw[0] as string;
    let suffixes = kw[1] as string[];
    for (let suffix of suffixes) {
      allKW.push([prefix, suffix, suggestionID]);
    }
  }
  suggestionID += 1;
}

// This tries to find which queries would match multiple dates.
for (let i = 0; i < allKW.length; i++) {
  let [prefix1, suffix1, id1] = allKW[i]!;
  let kw1 = prefix1 + suffix1;
  for (let j = 0; j < i; j++) {
    let [prefix2, suffix2, id2] = allKW[j]!;
    let kw2 = prefix2 + suffix2;

    if (id1 == id2) {
      // Don't warn if both keywords are for the same suggestion.
      continue;
    }

    // If the of lcp both full keywords is longer or equal to the prefix
    // needed to display each suggestion, both suggestions are displayed.
    let lcp_here = lcp(kw1, kw2);
    if (lcp_here >= Math.max(prefix1.length, prefix2.length)) {
      console.log(
        `Warning: "${kw1.slice(0, lcp_here)}" ` +
          `would match both "${kw1}" and "${kw2}"`
      );
    }
  }
}
