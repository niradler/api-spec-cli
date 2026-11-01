import MiniSearch, { type SearchOptions } from "minisearch";

export interface SearchDocument {
  id: string;
  name: string;
  path: string;
  summary: string;
  description: string;
  tags: string;
}

export interface SearchIndex {
  search(query: string): string[];
}

const STOP_WORDS = new Set(
  "a an the of on in to for by with from at as is are be this that it its and or into all any my i".split(
    " "
  )
);

const SYNONYMS = new Map<string, string>(
  Object.entries({
    remove: "delete",
    destroy: "delete",
    erase: "delete",
    drop: "delete",
    fetch: "get",
    retrieve: "get",
    read: "get",
    show: "get",
    find: "get",
    lookup: "get",
    add: "create",
    new: "create",
    make: "create",
    insert: "create",
    place: "create",
    modify: "update",
    edit: "update",
    change: "update",
    patch: "update",
    signin: "login",
    logon: "login",
    signout: "logout",
    repository: "repo",
    pr: "pull",
    photo: "image",
    picture: "image",
    me: "authenticated",
    current: "authenticated",
  })
);

const PHRASES: [RegExp, string][] = [
  [/\bsign (in|on)\b/g, "signin"],
  [/\bsign (out|off)\b/g, "signout"],
  [/\bpull requests?\b/g, "pull"],
];

const MAX_QUERY_LENGTH = 256;
const MAX_FUZZY_TERM_LENGTH = 32;

const FIELDS: (keyof SearchDocument)[] = ["name", "path", "summary", "description", "tags"];

const SEARCH_OPTIONS: SearchOptions = {
  boost: { name: 4, summary: 2, path: 1.5, tags: 1, description: 0.5 },
  prefix: (term) => term.length > 3,
  fuzzy: (term) => (term.length > 5 && term.length <= MAX_FUZZY_TERM_LENGTH ? 0.15 : false),
  weights: { fuzzy: 0.3, prefix: 0.5 },
  combineWith: "OR",
};

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 3 && term.endsWith("s") && !/(ss|us)$/.test(term)) return term.slice(0, -1);
  return term;
}

export function searchTerms(text: string): string[] {
  let joined = tokenize(text).join(" ");
  for (const [pattern, replacement] of PHRASES) joined = joined.replace(pattern, replacement);
  return joined
    .split(" ")
    .filter((term) => term && !STOP_WORDS.has(term))
    .map((term) => {
      const stemmed = stem(term);
      return SYNONYMS.get(stemmed) ?? SYNONYMS.get(term) ?? stemmed;
    });
}

export function createSearchIndex(documents: SearchDocument[]): SearchIndex {
  const index = new MiniSearch<SearchDocument>({
    fields: FIELDS,
    tokenize: (text, field) =>
      field === "name" ? [...searchTerms(text), tokenize(text).join("")] : searchTerms(text),
    processTerm: (term) => term,
    searchOptions: SEARCH_OPTIONS,
  });
  index.addAll(documents);
  return {
    search(query) {
      const bounded = query.slice(0, MAX_QUERY_LENGTH);
      if (searchTerms(bounded).length === 0) return [];
      return index.search(bounded).map((result) => String(result.id));
    },
  };
}
