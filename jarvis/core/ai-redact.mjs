// Remove personal contact data before any ad text leaves the collector.
// Street names, postcodes and prices stay because they are what we extract.

export const MAX_MODEL_INPUT = 8000;

// Capitalised words that follow "I'm", "contact" etc. but are not names.
const NOT_NAMES = new Set(`a an the dutch english german french spanish italian chinese indian turkish polish
international internationals student students master masters bachelor phd postdoc professional delft
rotterdam leiden den haag the hague netherlands nederland tu tud kamernet facebook whatsapp
monday tuesday wednesday thursday friday saturday sunday maandag dinsdag woensdag donderdag vrijdag zaterdag zondag
january february march april may june july august september october november december
januari februari maart mei juni juli augustus oktober
available looking leaving moving subletting renting offering happy interested sorry hi hello hoi hey
studying working graduating`.split(/\s+/));

// Names must start with a capital, so only the intro words are case-insensitive
// (the `i` flag would also make \p{Lu} match lowercase letters).
const ci = (pattern) => pattern.replace(/\\.|\p{L}/gu, (c) => c.length > 1 ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`);
const CONNECTORS = '(?:van|de|der|den|het|ter|ten|te|la|le|el|al|bin|da|di|du|dos|von)';
const NAME = `\\p{Lu}[\\p{Ll}'’]+(?:-\\p{Lu}[\\p{Ll}'’]+)?`;
const FULL_NAME = `(?:${CONNECTORS}\\s+){0,2}${NAME}(?:\\s+(?:${CONNECTORS}\\s+){0,2}${NAME}){0,2}`;
const INTRO = [
  "my name is", "my name's", 'i am', "i'm", 'i’m', 'ik ben', 'ik heet', 'mijn naam is', 'wij zijn', 'we are',
  'groet(?:jes|en)?', 'met vriendelijke groet(?:en)?', 'vriendelijke groet(?:en)?', 'kind regards', 'best regards', 'regards',
  'best', 'cheers', 'thanks', 'thank you', 'bedankt', 'liefs', 'love', 'xx',
  'contact(?:persoon)?', 'ask for', 'vraag naar', 'bel', 'call', 'app', 'whatsapp', 'text', 'message', 'dm', 'mail', 'email', 'e-mail',
  'stuur', 'send', 'reach out to', 'neem contact op met', 'contact opnemen met',
].map(ci).join('|');
const TITLE = ci('(?:mr|mrs|ms|dhr|mevr|mevrouw|meneer|mw)\\.?\\s+');
const VIA = ci('(?:(?:a|an|een) )?(?:message|bericht(?:je)?|dm|mail|mailtje) (?:to|naar|aan) ');
const NAME_AFTER_INTRO = new RegExp(`((?<![\\p{L}])(?:(?:${INTRO})(?![\\p{L}])[ \\t]*[,:;-]?[ \\t]*\\n?[ \\t]*(?:${VIA})?(?:${TITLE})?|${TITLE}))(${FULL_NAME})`, 'gu');

const PATTERNS = [
  ['email', /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+/gu],
  ['link', /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b(?:wa\.me|t\.me|m\.me|fb\.me|instagram\.com|facebook\.com|linkedin\.com|tiktok\.com)\/[^\s<>"')\]]*/gi],
  ['iban', /\b[A-Z]{2}\d{2}[ ]?[A-Z]{4}(?:[ ]?\d{2,4}){2,5}\b/g],
  // International (+31 6 1234 5678, 0031...), Dutch mobile/landline (06-12345678, 015-2123456).
  ['phone', /(?:(?<![\w+])(?:\+|00)\d{1,3}[\s.-]?(?:\(0\)[\s.-]?)?\d(?:[\s.-]?\d){6,11}|(?<![\w€.,])0\d(?:[\s.-]?\d){8}(?![\d,.]*\s?(?:€|eur|euro))(?!\d))/gi],
  ['handle', /(?<![\w.@])@[A-Za-z0-9_.]{2,30}\b/g],
];

function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Redact phone numbers, email addresses, links, social handles, bank numbers
 * and person names where they can be detected. `names` lets a caller pass
 * known names, e.g. the author of a Facebook post, which are removed everywhere.
 */
export function redactForModel(input, { names = [] } = {}) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const counts = { email: 0, link: 0, iban: 0, phone: 0, handle: 0, name: 0 };
  for (const [kind, pattern] of PATTERNS) {
    text = text.replace(pattern, () => { counts[kind]++; return `[${kind}]`; });
  }
  const known = new Set(names.filter((name) => typeof name === 'string' && name.trim().length >= 2).map((name) => name.trim()));
  text = text.replace(NAME_AFTER_INTRO, (match, prefix, name) => {
    const words = name.split(/\s+/);
    const first = words[0].toLowerCase();
    if (NOT_NAMES.has(first)) return match;
    // Keep street-like phrases ("Oude Delft", "Voorstraat") that follow "at"/"in"-free intros.
    if (/(?:straat|laan|weg|gracht|plein|kade|singel|hof|park|dijk|veld|plantsoen|steeg|wal)$/i.test(words.at(-1))) return match;
    known.add(name);
    counts.name++;
    return `${prefix}[name]`;
  });
  for (const name of [...known].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![\\p{L}])${escape(name)}(?![\\p{L}])`, 'giu');
    text = text.replace(pattern, () => { counts.name++; return '[name]'; });
    for (const part of name.split(/\s+/).filter((part) => part.length >= 3 && /^\p{Lu}/u.test(part) && !NOT_NAMES.has(part.toLowerCase()))) {
      text = text.replace(new RegExp(`(?<![\\p{L}])${escape(part)}(?![\\p{L}])`, 'gu'), () => { counts.name++; return '[name]'; });
    }
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > MAX_MODEL_INPUT;
  if (truncated) text = text.slice(0, MAX_MODEL_INPUT);
  return { text, counts, truncated };
}

/** Whitespace-normalised text for cache keys. */
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}
