/**
 * Term statistics and ranking for local documentation sections.
 *
 * Sections are scored with a field-weighted BM25 model: headings weigh more than body text,
 * rare terms more than common ones, and long sections are normalized so that a passing
 * mention in a thousand-line table does not outrank a focused entry. Clausewitz identifiers
 * are indexed whole and by their underscore-separated words, so `is_controlled_by` answers
 * both the exact identifier and a question about what is "controlled by" a country.
 */

const stopWords = new Set([
  'a',
  'about',
  'after',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'come',
  'do',
  'does',
  'for',
  'from',
  'get',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'one',
  'or',
  'should',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'this',
  'to',
  'use',
  'used',
  'using',
  'want',
  'way',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'work',
  'you',
]);

const vowels = /[aeiouy]/u;
const MAX_CACHED_STEMS = 100_000;
const stems = new Map<string, string>();
const irregular = new Map([
  ['hidden', 'hide'],
  ['chosen', 'choose'],
  ['given', 'give'],
  ['written', 'write'],
  ['children', 'child'],
]);

/** Conservative suffix folding: `controls`, `controlled`, and `controlling` share `control`. */
export function stemTerm(input: string): string {
  const cached = stems.get(input);
  if (cached !== undefined) return cached;
  const stem = foldTerm(input);
  // Documentation vocabulary repeats heavily; a bounded memo avoids re-folding it.
  if (stems.size >= MAX_CACHED_STEMS) stems.clear();
  stems.set(input, stem);
  return stem;
}

function foldTerm(input: string): string {
  const word = irregular.get(input) ?? input;
  if (word.length <= 3 || /\d/u.test(word)) return word;
  let stem = word;
  if (/i(?:es|ed)$/u.test(stem) && stem.length > 4) stem = `${stem.slice(0, -3)}y`;
  else if (stem.endsWith('sses')) stem = stem.slice(0, -2);
  else if (/(?:x|z|ch|sh)es$/u.test(stem)) stem = stem.slice(0, -2);
  else if (stem.endsWith('s') && !/(?:ss|us|is)$/u.test(stem)) stem = stem.slice(0, -1);
  else if (stem.endsWith('ing') && stem.length > 5 && vowels.test(stem.slice(0, -3)))
    stem = stem.slice(0, -3);
  else if (stem.endsWith('ed') && stem.length > 4 && vowels.test(stem.slice(0, -2)))
    stem = stem.slice(0, -2);
  // Fold a doubled final consonant (`stopp`, `controll`) but keep `ss` and `zz` words.
  if (/([b-df-hj-np-rtv-y])\1$/u.test(stem) && stem.length > 4) stem = stem.slice(0, -1);
  // Derivational endings common in documentation prose: `capitulation`, `capitulates`,
  // `capitulated`, and `capitulating` share `capitul`; `government` shares `govern`.
  if (/(?:ated|ating)$/u.test(word) && stem.length > 6) stem = stem.replace(/at$/u, '');
  else if (stem.endsWith('ation') && stem.length > 8) stem = stem.slice(0, -5);
  else if (stem.endsWith('ate') && stem.length > 6) stem = stem.slice(0, -3);
  else if (stem.endsWith('ment') && stem.length > 7) stem = stem.slice(0, -4);
  if (stem.endsWith('e') && stem.length > 4) stem = stem.slice(0, -1);
  return stem;
}

const tokenPattern = /[a-z0-9]+(?:_[a-z0-9]+)*/gu;

/** Content terms of free text. Identifiers yield themselves and their stemmed words. */
export function textTerms(text: string): string[] {
  const output: string[] = [];
  for (const token of text.toLowerCase().replace(/'s\b/gu, '').match(tokenPattern) ?? []) {
    if (token.includes('_')) {
      output.push(token);
      for (const part of token.split('_'))
        if (part.length > 0 && !stopWords.has(part)) output.push(stemTerm(part));
    } else if (!stopWords.has(token)) output.push(stemTerm(token));
  }
  return output;
}

function counts(terms: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const term of terms) result.set(term, (result.get(term) ?? 0) + 1);
  return result;
}

const navigationLine = /^\s*(?:[*-]|\d+\.)\s+\[[^\]]*\]\((?:#|<)[^)]*\)\s*$/u;

export interface SectionTerms {
  heading: Map<string, number>;
  title: Map<string, number>;
  body: Map<string, number>;
  bodyLength: number;
  /** Stemmed content words of the heading, used to reward questions that cover it. */
  headingWords: string[];
  /** A table of contents or index of links, which names topics without explaining them. */
  navigation: boolean;
  /** Console commands and engine defines answer only questions that ask for them. */
  specialty: 'console' | 'define' | undefined;
}

export function sectionTerms(
  title: string,
  heading: string,
  lines: readonly string[],
): SectionTerms {
  const bodyTerms = lines.flatMap((line) => textTerms(line));
  const content = lines.filter((line) => line.trim().length > 0);
  const links = content.filter((line) => navigationLine.test(line)).length;
  return {
    heading: counts(textTerms(heading)),
    title: counts(textTerms(title)),
    body: counts(bodyTerms),
    bodyLength: bodyTerms.length,
    headingWords: [
      ...new Set(textTerms(heading.replaceAll('_', ' ')).filter((term) => !term.includes('_'))),
    ],
    navigation:
      heading.trim().toLowerCase() === 'table of contents' ||
      (content.length >= 4 && links / content.length >= 0.6),
    specialty: /console commands/iu.test(title)
      ? 'console'
      : /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(heading.trim())
        ? 'define'
        : undefined,
  };
}

export interface QueryPlan {
  /** Distinct query terms with inverse document frequency and query weight. */
  terms: Array<{ term: string; idf: number; weight: number }>;
  /** Adjacent query words, rewarded when a section uses them as a phrase. */
  pairs: Array<{ pair: string; idf: number }>;
  normalized: string;
  identifiers: Set<string>;
  wants: { console: boolean; define: boolean };
}

/** Script names abbreviate counts as `num_`, as in `num_divisions` or `num_of_factories`. */
const countWords = new Set(['count', 'number', 'amount', 'many', 'much']);

const headingWeight = 4;
const titleWeight = 0.5;
const bodyWeight = 1;
const saturation = 1.2;
const lengthNormalization = 0.75;

/** Corpus statistics for one immutable inventory of sections. */
export class RankingIndex {
  readonly #documentFrequency = new Map<string, number>();
  readonly #averageBodyLength: number;

  constructor(private readonly entries: readonly SectionTerms[]) {
    let total = 0;
    for (const entry of entries) {
      total += entry.bodyLength;
      const seen = new Set([...entry.heading.keys(), ...entry.title.keys(), ...entry.body.keys()]);
      for (const term of seen)
        this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
    }
    this.#averageBodyLength = entries.length === 0 ? 1 : Math.max(1, total / entries.length);
  }

  idf(term: string): number {
    const frequency = this.#documentFrequency.get(term) ?? 0;
    const count = this.entries.length;
    return Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
  }

  plan(query: string): QueryPlan {
    const normalized = query.trim().toLowerCase();
    const sequence = textTerms(normalized);
    const weights = new Map<string, number>(sequence.map((term) => [term, 1]));
    const words = (normalized.replace(/'s\b/gu, '').match(tokenPattern) ?? []).filter(
      (word) => !stopWords.has(word) && !word.includes('_'),
    );
    // Clausewitz names often join two English words: `wargoal`, `manpower`, `warscore`.
    for (let index = 1; index < words.length; index += 1) {
      const joined = stemTerm(`${words[index - 1]}${words[index]}`);
      if (this.#documentFrequency.has(joined) && !weights.has(joined)) weights.set(joined, 1);
    }
    if (words.some((word) => countWords.has(word)) && !weights.has('num')) weights.set('num', 0.6);
    const terms = [...weights].map(([term, weight]) => ({ term, idf: this.idf(term), weight }));
    const plain = sequence.filter((term) => !term.includes('_'));
    const pairs = [...new Set(plain.slice(1).map((term, index) => `${plain[index]} ${term}`))].map(
      (pair) => {
        const [left, right] = pair.split(' ') as [string, string];
        return { pair, idf: (this.idf(left) + this.idf(right)) / 2 };
      },
    );
    return {
      terms,
      pairs,
      normalized,
      identifiers: new Set(terms.map(({ term }) => term).filter((term) => term.includes('_'))),
      wants: {
        console: words.some((word) => word === 'console' || word.startsWith('command')),
        define: words.some((word) => word.startsWith('define')) || /\b[A-Z]{2,}_[A-Z]/u.test(query),
      },
    };
  }

  /** Score one section; undefined when it matches too little of the query to cite. */
  score(plan: QueryPlan, entry: SectionTerms, heading: string): number | undefined {
    if (plan.terms.length === 0) return undefined;
    const lengthFactor =
      1 - lengthNormalization + (lengthNormalization * entry.bodyLength) / this.#averageBodyLength;
    let score = 0;
    let matched = 0;
    for (const { term, idf, weight } of plan.terms) {
      const weighted =
        headingWeight * (entry.heading.get(term) ?? 0) +
        titleWeight * (entry.title.get(term) ?? 0) +
        (bodyWeight * (entry.body.get(term) ?? 0)) / lengthFactor;
      if (weighted === 0) continue;
      matched++;
      score += (weight * idf * weighted * (saturation + 1)) / (weighted + saturation);
    }
    // Meaningful terms must agree; a single shared word rarely answers a longer question.
    const words = plan.terms.filter(
      ({ term, weight }) => !term.includes('_') && weight === 1,
    ).length;
    const required = words >= 3 ? Math.ceil(words * 0.4) : 1;
    if (matched === 0 || (matched < required && plan.identifiers.size === 0)) return undefined;
    // A named identifier must itself appear; its words alone describe something else.
    if (
      plan.identifiers.size > 0 &&
      ![...plan.identifiers].some(
        (term) => entry.heading.has(term) || entry.title.has(term) || entry.body.has(term),
      )
    )
      return undefined;
    const headingText = heading.trim().toLowerCase();
    // An exact heading is the answer; authority, not incidental wording, orders duplicates.
    if (headingText === plan.normalized) return 1000;
    else if (plan.identifiers.has(headingText)) score += 40;
    // A short heading whose every word the question names is usually the topic itself.
    if (entry.headingWords.length > 0) {
      const queryTerms = new Set(plan.terms.map(({ term }) => term));
      const covered = entry.headingWords.filter((word) => queryTerms.has(word));
      const fraction = covered.length / entry.headingWords.length;
      score += fraction * fraction * covered.reduce((sum, word) => sum + this.idf(word), 0) * 0.6;
    }
    if (entry.navigation) score *= 0.25;
    if (entry.specialty === 'console' && !plan.wants.console) score *= 0.7;
    if (entry.specialty === 'define' && !plan.wants.define) score *= 0.6;
    return score;
  }

  /** Extra credit for query words that appear next to each other in the section. */
  phraseBonus(plan: QueryPlan, lines: readonly string[]): number {
    if (plan.pairs.length === 0) return 0;
    const wanted = new Map(plan.pairs.map(({ pair, idf }) => [pair, idf]));
    const found = new Set<string>();
    for (const line of lines) {
      const terms = textTerms(line).filter((term) => !term.includes('_'));
      for (let index = 1; index < terms.length; index += 1) {
        const pair = `${terms[index - 1]} ${terms[index]}`;
        if (wanted.has(pair)) found.add(pair);
      }
      if (found.size === wanted.size) break;
    }
    return [...found].reduce((sum, pair) => sum + wanted.get(pair)!, 0) * 0.5;
  }

  /** The line offset carrying the most query information, for landing a bounded read. */
  bestLine(plan: QueryPlan, lines: readonly string[]): number {
    let best = 0;
    let bestScore = 0;
    const weights = new Map(plan.terms.map(({ term, idf, weight }) => [term, idf * weight]));
    for (const [index, line] of lines.entries()) {
      let lineScore = 0;
      for (const term of new Set(textTerms(line))) lineScore += weights.get(term) ?? 0;
      if (lineScore > bestScore) {
        best = index;
        bestScore = lineScore;
      }
    }
    return best;
  }
}
