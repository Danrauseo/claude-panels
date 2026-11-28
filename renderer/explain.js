// Explain terms: finds glossary terms in a terminal's output, so they can be underlined as they are
// written and explained when the mouse is held over them. Loaded by the window, and by plain Node for tests.
(function (root) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A matcher for one folder's glossary. Longer terms are tried first, so "pull request" wins over
  // "request". Terms only match as whole words, without regard to case.
  function buildMatcher(terms) {
    const byText = new Map(); // lower-case term or alias -> glossary key
    for (const [key, t] of Object.entries(terms || {})) {
      for (const word of [t.term, ...(t.aliases || [])]) {
        const w = String(word || '').trim();
        if (w.length >= 2 && !byText.has(w.toLowerCase())) byText.set(w.toLowerCase(), key);
      }
    }
    if (!byText.size) return null;
    const words = [...byText.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    const source = `(?<![\\w])(?:${words.join('|')})(?![\\w])`;
    return {
      regex: () => new RegExp(source, 'gi'),
      keyFor: (text) => byText.get(text.toLowerCase()),
    };
  }

  // Where glossary terms sit in one line of screen text: [{ start, end, key, text }], end not included.
  function findTerms(line, matcher) {
    if (!matcher || !line) return [];
    const found = [];
    for (const m of line.matchAll(matcher.regex())) {
      found.push({ start: m.index, end: m.index + m[0].length, key: matcher.keyFor(m[0]), text: m[0] });
    }
    return found;
  }

  // Terminal control sequences, which must never be changed. Each is tried at an escape character.
  const SEQUENCES = [
    /\x1b\[[0-?]*[ -/]*[@-~]/y, // CSI, such as colours and cursor moves
    /\x1b\][\s\S]*?(?:\x07|\x1b\\)/y, // OSC, such as links and window titles
    /\x1b[PX^_][\s\S]*?\x1b\\/y, // DCS and other strings
    /\x1b(?![[\]PX^_])[ -/]*[0-~]/y, // short escapes, such as one that picks a character set
  ];
  const UNDERLINE_OFF = '\x1b[59m\x1b[24m';
  const MAX_TAIL = 4096;

  // Adds an underline around each glossary term in a piece of terminal output, leaving control sequences
  // alone. styleFor(key) gives the escape sequence that starts the underline, or '' for none. A control
  // sequence cut off at the end is returned as tail, to be put in front of the next piece of output.
  function markOutput(data, matcher, styleFor) {
    if (!matcher) return { out: data, tail: '' };
    let out = '';
    let i = 0;
    const markText = (text) =>
      text.replace(matcher.regex(), (m) => {
        const style = styleFor(matcher.keyFor(m));
        return style ? style + m + UNDERLINE_OFF : m;
      });
    while (i < data.length) {
      const esc = data.indexOf('\x1b', i);
      if (esc === -1) {
        out += markText(data.slice(i));
        break;
      }
      out += markText(data.slice(i, esc));
      let matched = null;
      for (const re of SEQUENCES) {
        re.lastIndex = esc;
        const m = re.exec(data);
        if (m) {
          matched = m[0];
          break;
        }
      }
      if (matched) {
        out += matched;
        i = esc + matched.length;
        continue;
      }
      // An unfinished sequence at the end. Hold a short one back for the next piece of output.
      const rest = data.slice(esc);
      if (rest.length <= MAX_TAIL) return { out, tail: rest };
      out += rest;
      break;
    }
    return { out, tail: '' };
  }

  // Marks one terminal's output as it arrives. A held-back tail is written on its own after a moment if
  // no more output comes, so nothing is ever lost.
  class OutputMarker {
    constructor(write) {
      this.write = write;
      this.matcher = null;
      this.styleFor = () => '';
      this.tail = '';
      this.timer = null;
    }
    push(data) {
      clearTimeout(this.timer);
      const joined = this.tail + data;
      this.tail = '';
      const { out, tail } = markOutput(joined, this.matcher, this.styleFor);
      if (out) this.write(out);
      if (tail) {
        this.tail = tail;
        this.timer = setTimeout(() => {
          const t = this.tail;
          this.tail = '';
          if (t) this.write(t);
        }, 30);
      }
    }
  }

  const api = { buildMatcher, findTerms, markOutput, OutputMarker, UNDERLINE_OFF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Explain = api;
})(typeof window !== 'undefined' ? window : globalThis);
