// Usage:
//
// $ npm install
// $ npm start -- <country> <rs_server> <auth_token>
//
// country:
//   Uppercase country code whose dates will be uploaded. A subdirectory with
//   this code must be present in the `data` directory.
// rs_server
//   One of: prod, stage, dev
// auth_token:
//   Server auth token ("Bearer ...")

// CSV files should be placed in per-country subdirectories inside the `data`
// directory, one file per locale per year. For example:
//
// | data
//   | US
//     | en-2025.csv
//     | en-2026.csv
//     | es-MX-2025.csv
//     | ex-MX-2026.csv
//   | DE
//     | de-2025.csv
//     | de-2026.csv
//     | en-2025.csv
//     | en-2026.csv
//
// Each CSV file must be named `{locale}-{year}.csv`
//
// The `en` locale (without a country code like usual) is special. This
// script automatically maps it to all supported `en` locales.
//
// A given CSV file should contain dates for the country represented by its
// parent directory for the language and year in its filename. In the example
// above, US dates are provided for 2025 and 2026 in both English and Spanish
// (as spoken in Mexico). German dates are provided for 2025 and 2026 in both
// German and English.

// To typecheck:
//
// npm run tc

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { KintoClient } from "kinto";

const DRY_RUN = false;

const QUERIES_BY_LOCALE: Record<string, string[]> = {
  "en": ["", "when's ", "whens ", "when is ", "what day is "],
  "de": ["", "wann ist ", "welcher tag ist "],
  "it": [
    "",
    "quando è ",
    "quando e ",
    "quando cade ",
    "data ",
    "che giorno è ",
    "che giorno e ",
    "quale giorno è ",
    "quale giorno e ",
  ],
  "fr": ["", "quand est ", "c'est quand ", "cest quand ", "quel jour est "],
};

const EXPANDED_LOCALES_BY_LANG: Record<string, string[]> = {
  en: ["en-CA", "en-GB", "en-US", "en-ZA"],
};

const CSV_COLUMNS_EN: Record<string, number> = {
  DATE_START: 0,
  DATE_END: 1,
  NAME: 2,
  KEYWORDS: 3,
};

const CSV_COLUMNS_NON_EN: Record<string, number> = {
  DATE_START: 0,
  DATE_END: 1,
  NAME: 3,
  KEYWORDS: 4,
};

const RS_BUCKET = "main-workspace";
const RS_COLLECTION = "quicksuggest-other";

const RS_SERVER_URLS_BY_NAME: Record<string, string> = {
  prod: "https://remote-settings.mozilla.org/v1/",
  stage: "https://remote-settings.allizom.org/v1/",
  dev: "https://remote-settings-dev.allizom.org/v1/",
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

type Keyword = string|[string, string[]];

function generateKeywords(dateInfo: DateInfo, queries: string[]): Keyword[] {
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

  let out: Keyword[] = [];
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
      if (cleanedSuffixes.length && cleanedSuffixes[0]) {
        out.push([query + prefix, cleanedSuffixes]);
      } else {
        out.push(query + prefix);
      }
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

let warningsLogged = false;
let errorsLogged = false;

function logWarning(...args: any[]) {
  console.warn(...args);
  warningsLogged = true;
}

function logError(...args: any[]) {
  console.error(...args);
  errorsLogged = true;
}

//
// Script starts here
//

if (process.argv.length != 5) {
  throw new Error("Missing options, see usage");
}

let country = process.argv[2]!;

let serverName = process.argv[3]!;
if (!RS_SERVER_URLS_BY_NAME.hasOwnProperty(serverName)) {
  throw new Error("Unknown RS server " + serverName);
}

let authToken = process.argv[4]!;

// Step 1: Parse CSVs into DateInfo objects
// let dir = country + "/";
let dir = path.join("data", country);
let files = await readdir(dir);
// files = files.filter(f => f.endsWith(".csv")).map(f => dir + f);
files = files.filter(f => f.endsWith(".csv")).map(f => path.join(dir, f));

let allYears: Set<string> = new Set();

let dateInfosByNameByLocale: Map<string, Record<string, DateInfo>> = new Map();

class CsvError extends Error {
  constructor(filename: string, lineIndex: number, line: string[]) {
    super([
      "CSV Error:",
      filename + ":" + (lineIndex + 1),
      line.join(",")
    ].join(" "));
  }
}

for (let csvPath of files) {
  console.log(`Info: Parsing ${csvPath}`);

  let filename = path.basename(csvPath);
  let match = filename.match(/^([a-z]{2,}(?:-[A-Z]{2})?)-(\d{4})\.csv$/);
  if (!match) {
    throw new Error("Path does not match the expected format");
  }

  let locale = match[1]!;
  let year = match[2]!;

  let text = await readFile(csvPath, { encoding: "utf-8" });
  let lines = Papa.parse(text).data as [string, string, string, string][];
  lines.shift(); // Ignore header.

  allYears.add(year);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex]!;
    let colIndexes = locale.startsWith("en") ? CSV_COLUMNS_EN : CSV_COLUMNS_NON_EN;
    if (line.length < Math.max(...Object.values(colIndexes))) {
      throw new CsvError(filename, lineIndex, line);
    }

    let dateStartStr = line[colIndexes.DATE_START!]!;
    let dateEndStr = line[colIndexes.DATE_END!]!;
    let name = line[colIndexes.NAME!]!;
    let kw = line[colIndexes.KEYWORDS!]!;

    let dateStart = new Date(dateStartStr + "Z");
    let dateEnd = dateEndStr ? new Date(dateEndStr + "Z") : null;

    let date = dateEnd ? [dateStart, dateEnd] : dateStart;

    if (dateStart.getUTCFullYear() != parseInt(year)) {
      throw new CsvError(filename, lineIndex, line);
    }

    let dateInfosByName = dateInfosByNameByLocale.get(locale);
    if (!dateInfosByName) {
      dateInfosByName = {};
      dateInfosByNameByLocale.set(locale, dateInfosByName);
    }

    if (name in dateInfosByName) {
      let dateInfo = dateInfosByName[name]!;
      if (dateInfo.dates[year]) throw new Error();
      dateInfo.dates[year] = date;
      addKW(dateInfo, kw);
    } else {
      dateInfosByName[name] = {
        name,
        kw,
        dates: { [year]: date },
      };
    }
  }
}

// Step 2: Build suggest JSON from collected DateInfo objects
console.log();

interface SuggestionResultPayload {
  dates: (string | string[])[];
  name: string;
}

interface SuggestionResult {
  payload: SuggestionResultPayload;
}

interface SuggestionData {
  result: SuggestionResult,
}

interface Suggestion {
  data: SuggestionData;
  keywords: Keyword[];
  dismissal_key: string;
}

let suggestionsByLocale: Map<string, Suggestion[]> = new Map();
for (let [locale, dateInfosByName] of dateInfosByNameByLocale) {
  let suggestions = [];
  let queries = QUERIES_BY_LOCALE[locale];
  if (!queries) {
    throw new Error("Locale not recognized: " + locale);
  }

  for (let dateInfo of Object.values(dateInfosByName)) {
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

    let keywords = generateKeywords(dateInfo, queries);

    suggestions.push({
      data: {
        result: {
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

  suggestionsByLocale.set(locale, suggestions);
}

// Step 3: Scan output for anomalies

for (let [locale, suggestions] of suggestionsByLocale) {
  // All keywords as [prefix, suffix, suffixGroup].
  // The prefix is the part that is mandatory to type.
  let allKW = [] as [string, string, number][];
  // A suffix group is an array of suffixes in the output json.
  // This counter assigns a number to each suffix group.
  let suggestionID = 0;
  for (let o of suggestions) {
    let payload = o.data.result.payload;
    let dates = payload.dates;

    // Warn if an event doesn't happen every year.
    // For some (e.g. inauguration day) this is expected.
    let years = new Set(
      dates.map(d => (Array.isArray(d) ? d[0]! : d).slice(0, 4))
    );
    let diff = allYears.symmetricDifference(years);
    if (diff.size) {
      logWarning(
        `Warning: ${payload.name} does not exist in year ${diff.keys().toArray()}`
      );
    }

    if (dates.some(Array.isArray) && !dates.every(Array.isArray)) {
      logError(
        `Warning: ${payload.name} sometimes is a date and sometimes is a range`
      );
    }

    for (let kw of o.keywords) {
      if (typeof kw == "string") {
        allKW.push([kw, "", suggestionID]);
      } else {
        let prefix = kw[0] as string;
        let suffixes = kw[1] as string[];
        for (let suffix of suffixes) {
          allKW.push([prefix, suffix, suggestionID]);
        }
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
        logError(
          `Warning: "${kw1.slice(0, lcp_here)}" ` +
            `would match both "${kw1}" and "${kw2}"`
        );
      }
    }
  }

  if (errorsLogged) {
    throw new Error("Errors logged, stopping");
  }
}

// Step 4: Upload

let serverUrl = RS_SERVER_URLS_BY_NAME[serverName]!;
let client = new KintoClient(serverUrl, {
  headers: {
    Authorization: authToken,
  },
});
let collection = client.bucket(RS_BUCKET).collection(RS_COLLECTION);

for (let [localeOrLang, suggestions] of suggestionsByLocale) {
  let locales = EXPANDED_LOCALES_BY_LANG[localeOrLang] ?? [localeOrLang];
  let localesStr = locales.toSorted().map(l => `'${l}'`).join(", ");

  let id = `important-dates-${country}-${localeOrLang}`;
  let record = {
    id,
    type: "dynamic-suggestions",
    suggestion_type: "important_dates",
    filter_expression: `env.country == '${country}' && env.locale in [${localesStr}]`,
  };

  let dataUri =
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(suggestions)).toString("base64");

  console.debug("Uploading record:", record);

  if (!DRY_RUN) {
    await collection.addAttachment(dataUri, record, {
      filename: `${id}.json`,
    });
  }
}
