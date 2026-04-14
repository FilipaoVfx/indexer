function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFilterValue(value) {
  return normalizeWhitespace(value).replace(/^"(.*)"$/, "$1");
}

function extractFiltersFromQuery(rawQuery) {
  const filters = {};
  const patterns = [
    { key: "author", regex: /(^|\s)author:(?:"([^"]+)"|(\S+))/gi },
    { key: "domain", regex: /(^|\s)domain:(?:"([^"]+)"|(\S+))/gi },
    { key: "from", regex: /(^|\s)from:(?:"([^"]+)"|(\S+))/gi },
    { key: "to", regex: /(^|\s)to:(?:"([^"]+)"|(\S+))/gi }
  ];

  let remaining = rawQuery;

  for (const { key, regex } of patterns) {
    remaining = remaining.replace(regex, (_match, prefix, quoted, plain) => {
      const value = cleanFilterValue(quoted || plain);
      if (value && !filters[key]) {
        filters[key] = value;
      }
      return prefix || " ";
    });
  }

  return {
    filters,
    remaining: normalizeWhitespace(remaining)
  };
}

function extractQuotedPhrases(rawQuery) {
  const phrases = [];
  const matcher = /"([^"]+)"/g;
  let match;

  while ((match = matcher.exec(rawQuery))) {
    const value = normalizeWhitespace(match[1]);
    if (value) {
      phrases.push(value);
    }
  }

  return phrases;
}

function extractExcludedTerms(rawQuery) {
  const terms = [];
  const matcher = /(^|\s)-([^\s"]+)/g;
  let match;

  while ((match = matcher.exec(rawQuery))) {
    const value = normalizeWhitespace(match[2]);
    if (value) {
      terms.push(value);
    }
  }

  return terms;
}

function extractPositiveTerms(rawQuery) {
  return rawQuery
    .replace(/"[^"]+"/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !token.startsWith("-"))
    .filter((token) => token.toUpperCase() !== "OR");
}

function normalizeDateFilter(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

export function parseSearchQuery({
  q = "",
  author = "",
  domain = "",
  from = "",
  to = ""
} = {}) {
  const rawQuery = normalizeWhitespace(q);
  const extracted = extractFiltersFromQuery(rawQuery);
  const searchText = normalizeWhitespace(extracted.remaining);

  const mergedFilters = {
    author: cleanFilterValue(author) || extracted.filters.author || "",
    domain: cleanFilterValue(domain) || extracted.filters.domain || "",
    from: normalizeDateFilter(from) || normalizeDateFilter(extracted.filters.from),
    to: normalizeDateFilter(to) || normalizeDateFilter(extracted.filters.to)
  };

  return {
    rawQuery,
    searchText,
    phrases: extractQuotedPhrases(searchText),
    exclude: extractExcludedTerms(searchText),
    terms: extractPositiveTerms(searchText),
    filters: mergedFilters,
    hasStructuredFilters: Object.values(mergedFilters).some(Boolean)
  };
}
