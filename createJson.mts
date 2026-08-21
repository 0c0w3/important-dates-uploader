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

// See also the `DRY_RUN` const below. When true, only the country is required
// on the command line.

// CSV files should be placed in per-country subdirectories inside the `data`
// directory, one file per locale per year. For example:
//
// | data
//   | US
//     | en-2025.csv
//     | en-2026.csv
//     | es-MX-2025.csv
//     | es-MX-2026.csv
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
// (Mexico). German dates are provided for 2025 and 2026 in both German and
// English.

// To typecheck:
//
// npm run tc

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { KintoClient } from "kinto";

const DRY_RUN = false;
// const DRY_RUN = true;

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

const CSV_COLUMNS: Record<string, number> = {
  DATE_START: 0,
  DATE_END: 1,
  NAME: 2,
  KEYWORDS: 3,
};

const RS_BUCKET = "main-workspace";
const RS_COLLECTION = "quicksuggest-other";

const RS_SERVER_URLS_BY_NAME: Record<string, string> = {
  prod: "https://remote-settings.mozilla.org/v1/",
  stage: "https://remote-settings.allizom.org/v1/",
  dev: "https://remote-settings-dev.allizom.org/v1/",
};

interface Event {
  name: string;
  rawKeyword: string;
  dates: (string | string[])[];
  csvYears: Set<string>;
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

function generateKeywords(event: Event, queries: string[]): Keyword[] {
  let keywords = event.rawKeyword.split(",").map(kw => kw.toLowerCase().trim());
  if (keywords.some(kw => !kw.includes("|"))) {
    error("Event has a raw keyword without a '|'", event);
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

/**
 * @returns whether a date is in the past.
 */
function isPast(date: Date): boolean {
  // Use a 24-hours-ago date as "now" to allow for time zone differences and a
  // general fudge factor.
  return date.getTime() < Date.now() - (24 * 60 * 60 * 1000);
}

let warningsLogged = false;

function info(...args: any[]) {
  console.info("info:", ...args);
}

function warn(...args: any[]) {
  console.warn("warn:", ...args);
  warningsLogged = true;
}

function error(...args: any[]): never {
  console.warn("error:", ...args);
  process.exit();
}

//
// Script starts here
//

// Step 0: Process argv

if (
  (!DRY_RUN && process.argv.length != 5) ||
  (DRY_RUN && (process.argv.length < 3 || 5 < process.argv.length))
) {
  throw new Error("Missing options, see usage");
}

let country = process.argv[2]!;

let serverName = process.argv[3];
if (serverName && !RS_SERVER_URLS_BY_NAME.hasOwnProperty(serverName)) {
  throw new Error("Unknown RS server " + serverName);
}

let authToken = process.argv[4]!;

// Step 1: Parse CSVs into `Event` objects

let dir = path.join("data", country);
let files = await readdir(dir);
files = files.filter(f => f.endsWith(".csv")).map(f => path.join(dir, f));

let rawEventsByNameByLocale: Map<string, Map<string, Event>> = new Map();
let allCsvYears: Set<string> = new Set();

for (let csvPath of files) {
  info(`Parsing ${csvPath}`);

  let filename = path.basename(csvPath);
  let match = filename.match(/^([a-z]{2,}(?:-[A-Z]{2})?)-(\d{4})\.csv$/);
  if (!match) {
    error("File name does not match the expected format", { filename });
    process.exit();
  }

  let locale = match[1]!;
  if (!QUERIES_BY_LOCALE[locale]) {
    error("Unknown locale", { locale, filename });
  }

  let year = match[2]!;

  let text = await readFile(csvPath, { encoding: "utf-8" });
  let lines = Papa.parse(text).data as [string, string, string, string][];
  lines.shift(); // Ignore header.

  allCsvYears.add(year);

  let seenEventNames = new Set();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex]!;
    if (line.length < Math.max(...Object.values(CSV_COLUMNS))) {
      error(`Line has too many columns`, { filename, lineIndex, line });
    }

    let rawDateStart = line[CSV_COLUMNS.DATE_START!]!;
    let rawDateEnd = line[CSV_COLUMNS.DATE_END!]!;
    let eventName = line[CSV_COLUMNS.NAME!]!;
    let rawKeyword = line[CSV_COLUMNS.KEYWORDS!]!;

    if (seenEventNames.has(eventName)) {
      error(`"${eventName}" already defined in this file`, {
        filename,
        lineIndex,
        line,
      });
    }
    seenEventNames.add(eventName);

    let dateStart = new Date(rawDateStart + "Z");
    let dateEnd = rawDateEnd ? new Date(rawDateEnd + "Z") : null;

    if (dateStart.getUTCFullYear() != parseInt(year)) {
      error("Start date year doesn't match CSV file name", {
        dateStart,
        filename,
        lineIndex,
        line,
      });
    }

    let eventsByName = rawEventsByNameByLocale.get(locale);
    if (!eventsByName) {
      eventsByName = new Map();
      rawEventsByNameByLocale.set(locale, eventsByName);
    }

    let event = eventsByName.get(eventName);
    if (!event) {
      event = {
        rawKeyword,
        name: eventName,
        dates: [],
        csvYears: new Set(),
      };
      eventsByName.set(eventName, event);
    }

    event.csvYears.add(year);

    if (rawKeyword) {
      if (!event.rawKeyword) {
        event.rawKeyword = rawKeyword;
      } else if (rawKeyword != event.rawKeyword) {
        error("Event already has a different raw keyword", {
          rawKeyword,
          event,
          filename,
          lineIndex,
          line,
        });
      }
    }

    if (!isPast(dateEnd ?? dateStart)) {
      let startStr = getDateStr(dateStart);
      let date = dateEnd ? [startStr, getDateStr(dateEnd)] : startStr;
      event.dates.push(date);
      event.dates.sort();
    }
  }
}

// Step 2: Sanity-check dates, discard dates in the past, build the final map

let eventsByNameByLocale = new Map();

for (let [locale, rawEventsByName] of rawEventsByNameByLocale) {
  let eventsByName = new Map();
  for (let [name, event] of rawEventsByName) {
    if (!event.dates.length) {
      warn("Event has no non-past dates:", { locale, event });
    } else {
      eventsByName.set(event.name, event);
    }

    if (event.dates.some(Array.isArray) && !event.dates.every(Array.isArray)) {
      error("Event dates are sometimes a range and sometimes a single date", {
        locale,
        event,
      });
    }

    let missingCsvYears = allCsvYears.symmetricDifference(event.csvYears);
    if (missingCsvYears.size) {
      // This is expected for some events like "Inauguration Day".
      warn("Event is not present in all CSV years:", {
        locale,
        event,
        missingCsvYears,
      });
    }
  }

  if (!eventsByName.size) {
    warn("Locale has no non-past events:", { locale });
  } else {
    eventsByNameByLocale.set(locale, eventsByName);
  }
}

if (!eventsByNameByLocale.size) {
  error("No locale has non-past events, stopping");
}

// Step 3: Build JSON'able output from the events map

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

for (let [locale, eventsByName] of eventsByNameByLocale) {
  let suggestions = [];
  let queries = QUERIES_BY_LOCALE[locale]!;

  let events: Event[] = eventsByName.values().toArray();
  let sortedEvents = events.toSorted((a, b) => {
    let aDate = a.dates[0]!;
    let bDate = b.dates[0]!;
    let aStart = Array.isArray(aDate) ? aDate[0]! : aDate;
    let bStart = Array.isArray(bDate) ? bDate[0]! : bDate;
    return aStart.localeCompare(bStart);
  });

  for (let event of sortedEvents) {
    suggestions.push({
      data: {
        result: {
          payload: {
            dates: event.dates,
            name: event.name,
          },
        },
      },
      keywords: generateKeywords(event, queries),
      dismissal_key: event.name,
    });
  }

  suggestionsByLocale.set(locale, suggestions);
}

// Step 4: Scan the output for anomalies

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

  // This tries to find which queries would match multiple events.
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
        error(
          `"${kw1.slice(0, lcp_here)}" would match both "${kw1}" and "${kw2}"`
        );
      }
    }
  }
}

if (warningsLogged) {
  warn("Warnings logged");
}

// Step 5: Upload

let client;
let collection;
if (serverName) {
  let serverUrl = RS_SERVER_URLS_BY_NAME[serverName]!;
  client = new KintoClient(serverUrl, {
    headers: {
      Authorization: authToken,
    },
  });
  collection = client.bucket(RS_BUCKET).collection(RS_COLLECTION);
}

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

  info("Uploading record:", record);
//   console.dir(suggestions, { depth: null });

  await collection?.addAttachment(dataUri, record, {
    filename: `${id}.json`,
  });
}
