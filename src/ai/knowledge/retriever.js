// KNOWLEDGE RETRIEVAL.
//
// ───────────────────────────────────────────────────────────────────
// WHY THERE IS NO VECTOR DATABASE HERE
// ───────────────────────────────────────────────────────────────────
// The mandate asks whether this project actually needs one yet. It does not,
// and adding one now would cost more than it returns:
//
//   * The corpus is ~25 documents / ~120 chunks of our own writing. Lexical
//     retrieval over a corpus this size is not an approximation of semantic
//     search — at this scale it is usually indistinguishable from it.
//   * The vocabulary is closed and known. Users ask about runway, duplicates,
//     concentration, reconciliation. Rule documents are GENERATED from the
//     registry, so the exact terms a rule uses are already in the index.
//   * Embeddings would add a provider dependency, a network call on every
//     query, an index to build and invalidate, and a failure mode — for a
//     retrieval problem we can currently solve exactly.
//   * Worst case here is a slightly less relevant paragraph of EXPLANATION.
//     No financial number comes from this path, so a retrieval miss degrades
//     helpfulness, never correctness.
//
// WHAT MAKES THIS UPGRADEABLE. Retrieval is expressed as a strategy behind one
// interface (`retrieve(query, options)`), and every chunk carries a stable
// `chunkId`. Adding an embedding backend means implementing a second strategy
// and choosing it in `createRetriever()` — no caller changes. When the corpus
// grows past a few hundred chunks, or starts including third-party accounting
// material with vocabulary we do not control, that is the point to revisit.
//
// ───────────────────────────────────────────────────────────────────
// THE ALGORITHM: BM25-style lexical scoring.
// ───────────────────────────────────────────────────────────────────
// Term frequency saturates (a chunk repeating "runway" ten times is not ten
// times more relevant), rare terms count for more than common ones, and long
// chunks are normalised so they do not win on length alone.

const { loadKnowledge, DOC_KIND } = require("./knowledgeBase");

// BM25 parameters. Standard defaults; tuned only if retrieval quality demands it.
const K1 = 1.5;  // term-frequency saturation
const B = 0.75;  // length normalisation

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "of", "to",
  "in", "on", "for", "with", "and", "or", "but", "if", "then", "than", "that",
  "this", "these", "those", "it", "its", "as", "at", "by", "from", "my", "our",
  "we", "i", "you", "your", "me", "do", "does", "did", "how", "what", "why",
  "when", "which", "who", "can", "could", "should", "would", "will", "shall",
  "have", "has", "had", "not", "no", "yes", "about", "into", "over", "up", "out"
]);

/** Words, lowercased, stopwords dropped, crudely de-pluralised. */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** Build the inverted index once. Cheap enough to hold in memory. */
function buildIndex(knowledge) {
  const chunks = knowledge.chunks.map((chunk) => {
    // Title and tags are part of the searchable text: a chunk from the middle of
    // the duplicate-payment rule should still match the word "duplicate".
    const tokens = tokenize(`${chunk.title} ${chunk.tags.join(" ")} ${chunk.text}`);
    const termFreq = new Map();
    tokens.forEach((t) => termFreq.set(t, (termFreq.get(t) || 0) + 1));
    return { chunk, tokens, termFreq, length: tokens.length };
  });

  const docFreq = new Map();
  chunks.forEach(({ termFreq }) => {
    termFreq.forEach((_, term) => docFreq.set(term, (docFreq.get(term) || 0) + 1));
  });

  const avgLength = chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1);
  return { chunks, docFreq, avgLength, total: chunks.length, version: knowledge.version };
}

let indexCache = null;
function getIndex({ reload = false } = {}) {
  if (!indexCache || reload) indexCache = buildIndex(loadKnowledge({ reload }));
  return indexCache;
}

/** Inverse document frequency, floored so a ubiquitous term cannot go negative. */
function idf(index, term) {
  const n = index.docFreq.get(term) || 0;
  return Math.max(0.01, Math.log(1 + (index.total - n + 0.5) / (n + 0.5)));
}

/**
 * Retrieve the knowledge chunks most relevant to a query.
 *
 * @param {string} query      the user's question, or a topic
 * @param {object} options
 *   limit    {number}  max chunks to return (default 4 — the prompt has a budget)
 *   kinds    {string[]} restrict to document kinds
 *   boostIds {string[]} rule ids etc. to favour; used to pull in the explanation
 *                       for a finding the user is actually looking at
 *   minScore {number}  drop weak matches rather than padding the prompt
 * @returns {{chunks: Array, query: string, strategy: string, considered: number}}
 */
function retrieve(query, options = {}) {
  const {
    limit = 4,
    kinds = null,
    boostIds = [],
    minScore = 0.5,
    reload = false
  } = options;

  const index = getIndex({ reload });
  const terms = tokenize(query);
  const boost = new Set(boostIds.map((id) => String(id).toLowerCase()));

  if (!terms.length && !boost.size) {
    return Object.freeze({ chunks: [], query, strategy: "lexical-bm25", considered: index.total });
  }

  const scored = index.chunks.map((entry) => {
    let score = 0;
    terms.forEach((term) => {
      const tf = entry.termFreq.get(term) || 0;
      if (!tf) return;
      const norm = 1 - B + B * (entry.length / (index.avgLength || 1));
      score += idf(index, term) * ((tf * (K1 + 1)) / (tf + K1 * norm));
    });

    // A finding the user is looking at names its rule. Pulling that rule's own
    // explanation in is more reliable than hoping the wording matches.
    if (boost.size && (boost.has(entry.chunk.docId.replace(/^rule:/, "")) || boost.has(entry.chunk.docId))) {
      score += 5;
    }
    // Generated rule/methodology docs are authoritative-by-construction; product
    // docs are marketing-adjacent. Break ties toward the generated ones.
    if (entry.chunk.kind === DOC_KIND.RULE || entry.chunk.kind === DOC_KIND.METHODOLOGY) {
      score *= 1.15;
    }
    return { chunk: entry.chunk, score };
  });

  const filtered = scored
    .filter((s) => s.score >= minScore)
    .filter((s) => !kinds || kinds.includes(s.chunk.kind))
    .sort((a, b) => b.score - a.score);

  // At most two chunks from any one document, so a long rule cannot fill the
  // whole budget and crowd out a second relevant topic.
  const perDoc = new Map();
  const picked = [];
  for (const item of filtered) {
    const used = perDoc.get(item.chunk.docId) || 0;
    if (used >= 2) continue;
    perDoc.set(item.chunk.docId, used + 1);
    picked.push(Object.freeze({
      chunkId: item.chunk.chunkId,
      docId: item.chunk.docId,
      title: item.chunk.title,
      kind: item.chunk.kind,
      source: item.chunk.source,
      text: item.chunk.text,
      score: Number(item.score.toFixed(3))
    }));
    if (picked.length >= limit) break;
  }

  return Object.freeze({
    chunks: Object.freeze(picked),
    query,
    strategy: "lexical-bm25",
    considered: index.total,
    knowledgeVersion: index.version
  });
}

/**
 * The retriever interface, so an embedding-backed implementation can be
 * substituted without touching the context builder.
 */
function createRetriever(strategy = "lexical") {
  if (strategy !== "lexical") {
    throw new Error(
      `unknown retrieval strategy "${strategy}". Only "lexical" is implemented; `
      + "see the header of src/ai/knowledge/retriever.js for when to add embeddings.");
  }
  return Object.freeze({
    strategy: "lexical-bm25",
    retrieve,
    stats: () => {
      const index = getIndex();
      return { chunks: index.total, terms: index.docFreq.size, version: index.version };
    }
  });
}

module.exports = { retrieve, createRetriever, tokenize, getIndex };
