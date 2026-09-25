/*
 * The text a voice is given, made from a segment just before it goes to the engine (js/speech.js).
 *
 * Voices spell out a word written in capitals (README) and read file and code names as best they can.
 * For Korean and English voices:
 *   - a word in capitals that is an English word, or English words run together, is lowered so it's read
 *     as words: README → "read me", CHANGELOG → "change log". The others (API, HTTP), and those of two
 *     letters or fewer (IT, US), stay in capitals to be spelled
 *   - a file name, path or code name is read part by part, the signs between the parts said in the voice's
 *     language: page-ui-host.js → "page 대시 UI 대시 host 쩜 JS", node_modules → "node 언더바 modules".
 *     A part is kept if it's an English word, spelled if it has no vowel (css) or two letters or fewer (ui),
 *     and left to the voice otherwise (codex, json)
 *   - a name in camel case is read word by word (alignSegmentsToSource → "align Segments To Source"), unless
 *     a part of it is left to the voice (McDonald, PyTorch, iPhone): then the whole name is
 *   - a Korean voice pauses at the comma of a number (2,200 → "이, 이백"): thousands separators are left out
 * Everything else is left to the voice. English words: js/english-words.js.
 *
 * The page keeps showing the original segment (Speech getInfo): sourceIndex() maps a position in the
 * spoken text back to it, for the word events of the built-in voices.
 */

//two-letter words read as words when words in capitals run together (TODO → "to do") or make a sentence (DO in
//"DO NOT EDIT"). Not am, it, no and us: in capitals they're as often abbreviations (AM, IT, NO, US)
const SPOKEN_SHORT_WORDS = new Set([
  "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "me", "my", "of", "on", "or", "so", "to", "up", "we"
])

//in lowercase in a file or code name, "no" is a word too (NoSQL, no-console)
const SPOKEN_CODE_SHORT_WORDS = new Set([...SPOKEN_SHORT_WORDS, "no"])

//the signs between the parts of a file or code name, as the voice says them
const SPOKEN_SIGNS = {
  ko: {".": "쩜", "-": "대시", "_": "언더바", "/": "슬래시"},
  en: {".": "dot", "-": "dash", "_": "underscore", "/": "slash"},
}

//splitIntoWords() doesn't look for longer words
const SPOKEN_LONGEST_WORD = 32

//a word (with an apostrophe ending: DON'T, README's), or words joined by . - _ / (a file or code name), which may
//start with . or / (.gitignore, ./run.sh, /usr/bin) after a space or a sign (~/.ssh, PATH=/usr/bin). Not in a word
//with other Latin letters (RÉSUMÉ, café)
const SPOKEN_TOKEN = /(?<![\p{Script=Latin}\d])(?:(?<=^|[\s(\[{<"'`“‘=:~])[.\/]{1,3}(?=[A-Za-z]))?[A-Za-z0-9]+(?:['’][A-Za-z]+)?(?:[._\-\/][A-Za-z0-9]+(?:['’][A-Za-z]+)?)*(?![\p{Script=Latin}\d])/gu

//a number with thousands separators (2,200, 1,000,000, 12,345.67), not a list (1,2,3)
const SPOKEN_THOUSANDS = /(?<![\d,.])\d{1,3}(?:,\d{3})+(?!\d|,\d)/g

//words: Map of English words (js/english-words.js), given only by tests
function makeSpokenText(text, lang, words) {
  words = words || englishWords
  const language = /^(ko|en)(?![a-z])/i.exec(String(lang || ""))
  const signs = language && SPOKEN_SIGNS[language[1].toLowerCase()]
  let out = "", src = []

  if (signs) {
    const tokens = Array.from(text.matchAll(SPOKEN_TOKEN), match => ({text: match[0], at: match.index}))
    markCapitalRuns(tokens)
    let last = 0
    for (const token of tokens) {
      put(keep(text.slice(last, token.at), last))
      put(speakToken(token))
      last = token.at + token.text.length
    }
    put(keep(text.slice(last), last))
    if (signs == SPOKEN_SIGNS.ko) dropThousandsSeparators()
  }
  else {
    put(keep(text, 0))
  }

  return {
    text: out,
    //where the character at i of the spoken text comes from in the segment (i = text.length: its end)
    sourceIndex: i => i >= 0 && i < src.length ? src[i] : text.length,
  }


  //numbers are left as they are, so their commas are still where they were in the segment
  function dropThousandsSeparators() {
    const drop = new Set()
    for (const match of out.matchAll(SPOKEN_THOUSANDS)) {
      for (let k = 0; k < match[0].length; k++) if (match[0][k] == ",") drop.add(match.index + k)
    }
    if (!drop.size) return
    let kept = ""
    const keptSrc = []
    for (let i = 0; i < out.length; i++) {
      if (drop.has(i)) continue
      kept += out[i]
      keptSrc.push(src[i])
    }
    out = kept
    src = keptSrc
  }

  //pieces of spoken text, each char with the segment position it comes from
  function put(piece) {
    out += piece.text
    for (const s of piece.src) src.push(s)
  }
  function keep(str, at) {
    return {text: str, src: Array.from({length: str.length}, (x, k) => at + k)}
  }
  //only ASCII letters change case here, so the length stays the same
  function lowered(str, at) {
    return {text: str.toLowerCase(), src: keep(str, at).src}
  }
  function capitals(str, at) {
    return {text: str.toUpperCase(), src: keep(str, at).src}
  }
  //an inserted word or space, taken as coming from the char at "at"
  function inserted(str, at) {
    return {text: str, src: Array.from({length: str.length}, () => at)}
  }
  function join(pieces) {
    const src = []
    for (const piece of pieces) for (const s of piece.src) src.push(s)
    return {text: pieces.map(piece => piece.text).join(""), src}
  }
  //words of a word run together (README → read me), a space before each but the first
  function spaced(parts, at) {
    const pieces = []
    for (const part of parts) {
      if (pieces.length) pieces.push(inserted(" ", at))
      pieces.push(lowered(part, at))
      at += part.length
    }
    return join(pieces)
  }


  function speakToken({text: token, at, inCapitalRun}) {
    if (!/[A-Za-z]/.test(token)) return keep(token, at)
    const lead = /^[.\/]*/.exec(token)[0]
    const body = token.slice(lead.length), bodyAt = at + lead.length
    const parts = body.split(/([._\-\/])/)
    if (parts.length == 1 && !lead) return speakWord(body, bodyAt, false, inCapitalRun)

    //which signs are said. Not between numbers (2026-09-25, 1.5, 24/7) or single letters (T_T), next to a single
    //letter (e-mail, e.g., I/O), a hyphen or dot next to a number (GPT-4, GPT-4o, v2.0; a folder in a path may be
    //one), nor a hyphen between short parts (Wi-Fi): those are left to the voice
    const said = []
    const number = p => /^\d/.test(p)
    const letter = p => /^[A-Za-z]$/.test(p)
    for (let k = 1; k < parts.length; k += 2) {
      const sign = parts[k], left = parts[k-1], right = parts[k+1]
      if (number(left) && number(right) || letter(left) && letter(right)) said.push(false)
      else if (sign == "_") said.push(true)
      else if (letter(left) || letter(right)) said.push(false)
      else if (sign != "/" && (number(left) || number(right))) said.push(false)
      else if (sign == ".") said.push(true)
      else if (sign == "-" && left.length <= 2 && right.length <= 2) said.push(false)
      else said.push(null)
    }
    //a slash is said only in what's clearly a file name or path (js/player.js, /usr/bin), not between two words
    //(UI/UX, and/or). So is a hyphen for an English voice: not in English words (well-known)
    const codeName = !!lead || said.includes(true) || parts.filter(p => p == "/").length >= 2
    for (let k = 0; k < said.length; k++) {
      if (said[k] == null) said[k] = codeName || parts[2*k+1] == "-" && signs == SPOKEN_SIGNS.ko
    }

    //runs of parts between the signs said; a run holding signs not said is left as it is (GPT-4 in GPT-4.pdf)
    const runs = []
    let runStart = 0, runAt = bodyAt
    for (let k = 0; k <= said.length; k++) {
      if (k < said.length && !said[k]) continue
      const run = parts.slice(runStart, 2*k + 1).join("")
      runs.push({text: run, at: runAt, single: runStart == 2*k, sign: k < said.length ? parts[2*k+1] : null})
      runStart = 2*k + 2
      runAt += run.length + 1
    }
    //a name all in capitals with an English word in it (IN_PROGRESS) is read like a sentence in capitals
    const capitalName = runs.every(run => run.single && /^[A-Z]+$/.test(run.text))
      && runs.some(run => run.text.length > 2 && speakCapitals(run.text, run.at, false).text != run.text)

    const pieces = []
    for (let k = 0; k < lead.length; k++) pieces.push(inserted(signs[lead[k]] + " ", at + k))
    for (const run of runs) {
      pieces.push(run.single ? speakWord(run.text, run.at, true, capitalName || inCapitalRun) : keep(run.text, run.at))
      if (run.sign) pieces.push(inserted(" " + signs[run.sign] + " ", run.at + run.text.length))
    }
    return join(pieces)
  }

  //a word, or a part of a file or code name (inCode)
  function speakWord(word, at, inCode, inCapitalRun) {
    if (/['’]/.test(word)) return speakApostrophe(word, at, inCapitalRun)
    //numbers, and letters with digits (MP3, utf8), are left to the voice
    if (!/[A-Za-z]/.test(word) || /\d/.test(word)) return keep(word, at)
    //an abbreviation in the plural (APIs, READMEs): the abbreviation, then its s
    const plural = /^([A-Z]{2,})s$/.exec(word)
    if (plural) {
      const stem = speakCapitals(plural[1], at, inCapitalRun)
      return stem.text == plural[1] ? keep(word, at) : join([stem, keep("s", at + plural[1].length)])
    }
    //a name in camel case (alignSegmentsToSource, getHTTPResponse) is read word by word, unless a part is one the
    //voice has to make out (McDonald, PyTorch, kHz): then it's left to the voice whole
    const camel = word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g)
    if (camel.length > 1) {
      const pieces = []
      let partAt = at
      for (const part of camel) {
        const spoken = speakPart(part, partAt, true)
        if (!spoken) return keep(word, at)
        if (pieces.length) pieces.push(inserted(" ", partAt))
        pieces.push(spoken)
        partAt += part.length
      }
      return join(pieces)
    }
    if (word == word.toUpperCase()) return speakCapitals(word, at, inCapitalRun)
    return inCode && speakPart(word, at, false) || keep(word, at)
  }

  //a word with an apostrophe: in capitals, a contraction (DON'T, I'M) or a word and its 's (README's, USER'S)
  function speakApostrophe(word, at, inCapitalRun) {
    const match = /^([A-Za-z0-9]+)(['’][A-Za-z]+)$/.exec(word)
    if (!match || /\d/.test(match[1]) || match[1] != match[1].toUpperCase()) return keep(word, at)
    const [, stem, tail] = match
    if (word == word.toUpperCase() && words.has(word.toLowerCase().replace(/’/g, "'"))) return lowered(word, at)
    if (!/^['’]s$/i.test(tail)) return keep(word, at)
    const spoken = speakCapitals(stem, at, inCapitalRun)
    const tailAt = at + stem.length
    return join([spoken, spoken.text == stem ? keep(tail, tailAt) : lowered(tail, tailAt)])
  }

  //a part of a file or code name, or of a name in camel case (inCamel); null if it's left to the voice
  function speakPart(part, at, inCamel) {
    if (part.length > 2 && part == part.toUpperCase()) return speakCapitals(part, at, false)
    const lower = part.toLowerCase()
    if (part.length <= 2) {
      if (SPOKEN_CODE_SHORT_WORDS.has(lower)) return keep(part, at)
      //spelled (ui, js), but in camel case it may be the start of a word (PyTorch, LoRA, kHz)
      return inCamel ? null : capitals(part, at)
    }
    //no vowel: can't be read as a word (css, npm, Http)
    if (!/[aeiouy]/.test(lower)) return capitals(part, at)
    //a word, or one the voice makes out (codex, json, config)
    return words.has(lower) ? keep(part, at) : null
  }

  function speakCapitals(word, at, inCapitalRun) {
    const lower = word.toLowerCase()
    //spelled, but for short words among words in capitals (DO in "DO NOT EDIT")
    if (word.length <= 2) return inCapitalRun && SPOKEN_SHORT_WORDS.has(lower) ? lowered(word, at) : keep(word, at)
    //words without a vowel are sounds (ssh, hmm): in capitals it's an abbreviation (SSH)
    if (!/[aeiouy]/.test(lower)) return keep(word, at)
    if (words.has(lower)) return lowered(word, at)
    const run = splitIntoWords(lower)
    return run ? spaced(run, at) : keep(word, at)
  }

  //the fewest English words, then the most common (lowest SCOWL level), making up w. Words of 3 letters or
  //more, or two-letter ones read as words (SPOKEN_SHORT_WORDS); null if it can't be done or is a single word
  function splitIntoWords(w) {
    //best[i]: the best way to make up w.slice(0, i), its last word starting at "from"
    const best = [{count: 0, level: 0}]
    for (let i = 2; i <= w.length; i++) {
      for (let j = Math.max(0, i - SPOKEN_LONGEST_WORD); j <= i - 2; j++) {
        if (!best[j]) continue
        const part = w.slice(j, i)
        const level = part.length > 2 ? words.get(part) : SPOKEN_SHORT_WORDS.has(part) ? 0 : undefined
        if (level == null) continue
        const count = best[j].count + 1, sum = best[j].level + level
        if (!best[i] || count < best[i].count || count == best[i].count && sum < best[i].level) {
          best[i] = {from: j, count, level: sum}
        }
      }
    }
    if (!best[w.length] || best[w.length].count < 2) return null
    const parts = []
    for (let i = w.length; i > 0; i = best[i].from) parts.unshift(w.slice(best[i].from, i))
    return parts
  }

  //words in capitals next to each other (nothing but spaces and punctuation between) that include an English
  //word are a sentence in capitals: their short words are read as words too (DO in "DO NOT EDIT")
  function markCapitalRuns(tokens) {
    const isCapitalWord = token => /^[A-Z]+(?:['’][A-Z]+)?$/.test(token.text)
    const lowers = token => token.text.length > 2 && speakWord(token.text, token.at, false, false).text != token.text
    let run = []
    const flush = () => {
      if (run.some(lowers)) for (const token of run) token.inCapitalRun = true
      run = []
    }
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k], prev = tokens[k-1]
      if (!isCapitalWord(token)) {
        flush()
        continue
      }
      if (run.length && /[\p{L}\p{N}]/u.test(text.slice(prev.at + prev.text.length, token.at))) flush()
      run.push(token)
    }
    flush()
  }
}
