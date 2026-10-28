/*
 * The text a voice is given, made from a segment just before it goes to the engine (js/speech.js).
 *
 * As in the Paseo status bar plugin (2026-10-28: the three apps read alike), moved over step by step from its
 * server/presentation/spokenText.ts makeSpokenText — same steps, same patterns, keep them alike:
 *   - a markdown table becomes a sentence per row, each value with its heading (tableToSentences)
 *   - brackets holding Korean are read without the brackets; those holding a file name or path, or no Korean,
 *     are left out (dropParens)
 *   - a web address is said "URL", a path only its last name (shortenPaths)
 *   - for a Korean voice, numbers in Korean words: times (18:13:02 → 십팔시 십삼분 공이초), dates, versions
 *     (v1.17.2 → 버전 일 점 십칠 점 이), sums, thousands (54,926 → 오만 사천구백이십육), units (readNumbersKo)
 *   - signs aren't said: arrows, middle dots and the like are pauses (", "), the signs in an English name are
 *     spaces (readaloud_text.py → "readaloud text py"), a name in camel case is spaced (alignSegmentsToSource →
 *     "align Segments To Source"), the rest left out
 * Kept from before, for Korean and English voices only (2026-10-28): a word in capitals that is an English word, or
 * English words run together, is lowered so it's read as words: README → "read me", CHANGELOG → "change log";
 * the others (API, HTTP, SSH) and those of two letters or fewer (IT, US) are left in capitals, but for short words
 * among words in capitals (DO in "DO NOT EDIT"). English words: js/english-words.js.
 *
 * The page keeps showing the original segment (Speech getInfo): sourceIndex() maps a position in the
 * spoken text back to it, for the word events of the built-in voices. Each step keeps, for every char it
 * writes, the segment position it comes from (a char matched in what it replaced, or else the one before).
 */
const makeSpokenText = immediate(() => {
  const REPEATED_CHARS_MAX = 3
  const PAUSE = ", "

  //a table's rule line — a dash or more in each cell, alignment marks (:--, :-:, --:) allowed
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
  const tableCells = line => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim())

  //a file name (an extension: work-cli.mjs, readaloud_text.py) or a path (docs/x, C:\, ~/), in English letters only
  const FILE_NAME = /[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?![A-Za-z0-9])|[A-Za-z0-9_.~-]*[\\/][A-Za-z0-9_.-]+|[A-Za-z]:[\\/]/
  const keepParenContent = inner => /\p{Script=Hangul}/u.test(inner) && !FILE_NAME.test(inner)

  //http, ssh://, ws://, file:// — any address
  const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()`]+/gi
  //a path with a clear start (C:\, ~/, ./, ../, /root/x): its last name. A leading / needs another separator after
  //it, so a slash command (/start) stays
  const ANCHORED_PATH = /(?<![\p{L}\p{N}_.~@+\-:/\\])(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/](?=[\p{L}\p{N}_.@+\-]+[\\/]))(?:[\p{L}\p{N}_.@+\-]+[\\/])*[\p{L}\p{N}_.@+\-]*/gu
  //a relative path (src/extension.ts), English names only, when it ends in a file with an extension, has two
  //folders or more, or ends in a separator (docs/) — not the slash of common text (ko/en)
  const RELATIVE_PATH = /(?<![\w.~@+\-:/\\])[\w.@+-]+(?:[\\/][\w.@+-]+)+[\\/]?(?![\w.@+\-\\/])/g
  const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/
  const lastName = path => path.split(/[\\/]/).filter(part => part && part != "~" && part != "." && part != ".." && !/^[A-Za-z]:$/.test(part)).pop()

  //dates, times and sums are said before the signs are left out — for a Korean voice only
  const validMonthDay = (month, day) => +month >= 1 && +month <= 12 && +day >= 1 && +day <= 31
  const MATH_NUMBER = String.raw`\d+(?:[.,]\d+)*%?`
  const MATH_OPERATOR = String.raw`\s*(?:\*(?!\*)|[-−+×÷±=/])\s*`
  const MATH = new RegExp(String.raw`(?<![\w.,])${MATH_NUMBER}(?:${MATH_OPERATOR}${MATH_NUMBER})+(?!\w)`, "g")
  //the particle after a number before "=": 는 after 2, 4, 5, 9, %, else 은
  const equalsJosa = before => /[2459%]\s*$/.test(before) ? "는" : "은"

  const KO_DIGITS = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"]
  const KO_SMALL = ["", "십", "백", "천"]
  const KO_BIG = ["", "만", "억", "조", "경"]
  //a whole number in Sino-Korean words: 80055 → 팔만 오십오, 10000 → 만, 100000000 → 일억
  function koreanNumber(digits) {
    const n = digits.replace(/^0+(?=\d)/, "")
    if (!/^\d+$/.test(n)) return digits
    if (/^0+$/.test(n)) return "영"
    if (n.length > 20) return n
    const groups = []
    for (let end = n.length; end > 0; end -= 4) groups.unshift(n.slice(Math.max(0, end - 4), end))
    const words = []
    groups.forEach((group, gi) => {
      const big = KO_BIG[groups.length - 1 - gi]
      const padded = group.padStart(4, "0")
      let word = ""
      for (let i = 0; i < 4; i++) {
        const d = +padded[i]
        if (!d) continue
        const unit = KO_SMALL[3 - i]
        word += (d === 1 && unit ? "" : KO_DIGITS[d]) + unit
      }
      if (!word) return
      if (word === "일" && big === "만") word = ""
      words.push(word + big)
    })
    return words.join(" ")
  }
  const koreanFraction = frac => ` 점 ${frac.split("").map(d => KO_DIGITS[+d]).join("")}`
  //the numbers of a time as on a clock: 02 → 공이, 00 → 공공, 18 → 십팔
  const clockNumber = digits =>
    digits.length === 2 && digits[0] === "0" ? `공${digits[1] === "0" ? "공" : KO_DIGITS[+digits[1]]}` : koreanNumber(digits)
  const UNIT_WORDS = {
    ms: "밀리초", sec: "초", min: "분", s: "초", h: "시간", px: "픽셀", fps: "프레임",
    KiB: "키비바이트", MiB: "메비바이트", GiB: "기비바이트", TiB: "테비바이트", KB: "킬로바이트", kB: "킬로바이트", MB: "메가바이트", GB: "기가바이트", TB: "테라바이트",
    kHz: "킬로헤르츠", MHz: "메가헤르츠", GHz: "기가헤르츠", Hz: "헤르츠", km: "킬로미터", kg: "킬로그램", "°C": "도", "℃": "도",
  }
  const UNIT_NAMES = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join("|")
  const RANGE_UNIT = "초|분|시간|일|주|개월|달|년|명|개|번|회|배|대|건|줄|쪽|장|마리|권|차|단계|가지|글자|자|살|원|위|곳|층|호|퍼센트|%"

  //an English name: letters, digits and _, joined by . / \ - (and for words in capitals a 's or 'T after it)
  const NAME = /[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*/g
  const NAME_WITH_TAIL = /[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*(?:['’](?:[A-Z]+|s)(?![A-Za-z0-9_]))?/g

  //two-letter words read as words when words in capitals run together (TODO → "to do") or make a sentence (DO in
  //"DO NOT EDIT"). Not am, it, no and us: in capitals they're as often abbreviations (AM, IT, NO, US)
  const SPOKEN_SHORT_WORDS = new Set([
    "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "me", "my", "of", "on", "or", "so", "to", "up", "we"
  ])
  //splitIntoWords() doesn't look for longer words
  const SPOKEN_LONGEST_WORD = 32


  //words: Map of English words (js/english-words.js) — given by tests, null to leave the English words out
  return function makeSpokenText(text, lang, words) {
    if (words === undefined) words = typeof englishWords != "undefined" ? englishWords : null
    const language = /^(ko|en)(?![a-z])/i.exec(String(lang || ""))
    const korean = !!language && language[1].toLowerCase() == "ko"
    if (!language) words = null
    let cur = {text, src: Array.from({length: text.length}, (x, i) => i)}
    const edit = (pattern, replacement) => { cur = replaceTracked(cur, pattern, replacement) }

    edit(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    edit(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    edit(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    edit(URL_PATTERN, "URL")
    //a line break just inside a bracket goes first (a file name in its own box: "파일(" ↵ "~/.claude/settings.json" ↵ ")에")
    edit(/([(（])[ \t]*\n\s*/g, "$1")
    edit(/\s*\n[ \t]*([)）])/g, "$1")
    //tables into sentences before their | are left out, then the brackets (a table cell's "1명(이 계정)" too)
    tableToSentences()
    dropParens()
    shortenPaths()
    //after the paths (their numbers go with them), before the signs are left out
    if (korean) readNumbersKo()
    edit(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    edit(/`+/g, "")
    edit(/\*\*|__|~~/g, "")
    edit(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;])/g, "$1$2")
    edit(/^\s*[-*_]{3,}\s*$/gm, "")
    edit(/[|]/g, " ")
    edit(/→|⇒|->|=>|←|⇐|<-/g, PAUSE)
    edit(/([^\d\s])\1{3,}/gu, (m, char) => char.repeat(REPEATED_CHARS_MAX))
    //the signs in an English name aren't said but spaced (readaloud_text.py → "readaloud text py"); two capitals
    //(PC, OK, DB) are left as they are
    if (words) speakNames()
    else edit(NAME, spacedName)
    //the signs left: in numbers (1.5, 19:41, 1,000) and %, an apostrophe in an English word, the end of a sentence
    edit(/[•◦▪▫▸▹►▶●○■□◆◇★☆※]/g, " ")
    edit(/[·‧∙…]/g, PAUSE)
    edit(/(?<!\d):|:(?!\d)|;/g, PAUSE)
    edit(/[–—―]|(?<=\s)-(?=\s)/g, PAUSE)
    edit(/\p{Extended_Pictographic}|[\uFE0F\u200D\u20E3]/gu, " ")
    edit(/(?<![A-Za-z])['’]|['’](?![A-Za-z])/g, " ")
    //any other sign; the punctuation of the seven reading languages of the plugin (。、，！？：； ، ؛ ؟) are pauses, kept
    edit(/[^\p{L}\p{N}\p{M}\s.,:?!%'’。、，！？：；،؛؟]/gu, " ")
    edit(/[ \t\u00a0]+([.,?!])/g, "$1")
    edit(/([.?!]),+/g, "$1")
    edit(/,(?:[ \t\u00a0]*,)+/g, ",")
    edit(/^[ \t\u00a0]*[,.]+/gm, "")
    edit(/[ \t\u00a0]+/g, " ")
    edit(/ +\n/g, "\n")
    edit(/\n{3,}/g, "\n\n")
    edit(/^\s+|\s+$/g, "")

    const src = cur.src
    return {
      text: cur.text,
      //where the character at i of the spoken text comes from in the segment (i = text.length: its end)
      sourceIndex: i => i >= 0 && i < src.length ? src[i] : text.length,
    }


    //a markdown table (heading line, rule line, rows) becomes "first cell, heading value, heading value." for each
    //row, the rows on one line; empty cells left out
    function tableToSentences() {
      const lines = cur.text.split("\n"), starts = []
      let pos = 0
      for (const line of lines) {
        starts.push(pos)
        pos += line.length + 1
      }
      const edits = []
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("|") || !TABLE_RULE.test(lines[i + 1] || "")) continue
        const head = tableCells(lines[i])
        const sentences = []
        let j = i + 2
        for (; j < lines.length && lines[j].includes("|"); j++) {
          const cells = tableCells(lines[j])
          const parts = cells.map((cell, k) => !cell ? "" : k === 0 || !head[k] ? cell : `${head[k]} ${cell}`).filter(Boolean)
          if (parts.length) sentences.push(`${parts.join(PAUSE)}.`)
        }
        edits.push({from: starts[i], to: starts[j - 1] + lines[j - 1].length, text: sentences.join(" ")})
        i = j - 1
      }
      cur = spliceTracked(cur, edits)
    }

    //brackets read without them (keepParenContent) or left out whole, the inner ones first; a bracket without its
    //pair is left out alone. Left out before Korean, a space or a sign, no space is left ("3대(DB)는" → "3대는")
    function dropParens() {
      let prev
      do {
        prev = cur.text
        edit(/\(([^()\n]*)\)|（([^（）\n]*)）/g, (m, a, b, at, all) => {
          const inner = a != null ? a : b != null ? b : ""
          const next = all.charAt(at + m.length)
          const spaceAfter = /[\p{L}\p{N}]/u.test(next) && !/\p{Script=Hangul}/u.test(next) ? " " : ""
          if (keepParenContent(inner)) return ` ${inner}${spaceAfter}`
          return spaceAfter
        })
      } while (cur.text !== prev)
      edit(/[()（）]/g, " ")
    }

    function shortenPaths() {
      edit(ANCHORED_PATH, path => lastName(path) || path)
      edit(RELATIVE_PATH, path => {
        const parts = path.split(/[\\/]/).filter(Boolean)
        const name = parts[parts.length - 1]
        if (!/[A-Za-z]/.test(name)) return path
        const isPath = parts.length >= 3 || FILE_EXTENSION.test(name) || /[\\/]$/.test(path)
        return isPath ? name : path
      })
    }

    function readNumbersKo() {
      //a date with its year (2026-10-14, 2026/10/14, 2026.10.14); an ISO T right after it is spaced
      edit(/(?<![\d.:/-])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\d/-]|[.:]\d)(T(?=\d{1,2}:\d{2}))?/g,
        (m, year, sep, month, day, iso) => validMonthDay(month, day) ? `${year}년 ${+month}월 ${+day}일${iso ? " " : ""}` : m)
      //a version (v1.17.2, 1.18.1): three numbers joined by dots, a leading v said "버전"; not an address (127.0.0.1)
      edit(/(?<![\w.])([vV](?=\d))?(\d{1,3})\.(\d{1,3})\.(\d{1,4})(?![\w]|\.\d)/g, (m, v, a, b, c) =>
        `${v ? "버전 " : ""}${koreanNumber(a)} 점 ${koreanNumber(b)} 점 ${koreanNumber(c)}`)
      //a time with its last digit an x (18:4x) — "십팔시 사십분쯤", 0x "십팔시쯤"
      edit(/(?<![\d.:])([01]?\d|2[0-3]):([0-5])x(?![A-Za-z0-9])/g, (m, hour, tens) =>
        +tens ? `${clockNumber(hour)}시 ${koreanNumber(`${tens}0`)}분쯤` : `${clockNumber(hour)}시쯤`)
      //a time (9:05, 16:24, 06:51:51): minutes and seconds of 0 left out from the end; an ISO Z said "UTC"
      edit(/(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z(?![A-Za-z0-9]))?(?![\d:]|\.\d)/g, (m, hour, minute, second, utc) => {
        const parts = [`${clockNumber(hour)}시`]
        if (+minute || (second && +second)) parts.push(`${clockNumber(minute)}분`)
        if (second && +second) parts.push(`${clockNumber(second)}초`)
        if (utc) parts.push("UTC")
        return parts.join(" ")
      })
      //a hyphen range right before a Korean unit (3-5초, 1-3명) is "에서" — before the dates
      edit(new RegExp(String.raw`(?<![\w.:/-])(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(?=(?:${RANGE_UNIT}))`, "g"), "$1에서 $2")
      //a hyphen date without a year (10-10) when it's a month and a day; not a sum (10-3=7) nor a phone number
      edit(/(?<![\w.:/=+×*÷±-])(\d{1,2})-(\d{1,2})(?![\d./-]|:\d|\s*[=+×*÷±])/g, (m, month, day) => validMonthDay(month, day) ? `${+month}월 ${+day}일` : m)
      //a sum — plus, times, ÷ and ± always; minus and / only with an equals sign
      edit(MATH, expr => {
        const equation = expr.includes("=")
        return expr.replace(new RegExp(MATH_OPERATOR, "g"), (op, at) => {
          switch (op.trim()) {
            case "+": return " 더하기 "
            case "*": case "×": return " 곱하기 "
            case "÷": return " 나누기 "
            case "±": return " 플러스 마이너스 "
            case "-": case "−": return equation ? " 빼기 " : op
            case "/": return equation ? " 나누기 " : op
            default: return `${equalsJosa(expr.slice(0, at))} `
          }
        })
      })
      //a date of two numbers (10/14) when it's a month and a day
      edit(/(?<![\d./:-])(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d)/g, (m, month, day) => validMonthDay(month, day) ? `${+month}월 ${+day}일` : m)
      //a sign before a number on its own (+9, -30, −5) — 플러스, 마이너스
      edit(/(^|[\s(（,])([+−-])(?=\d)/gm, (m, before, sign) => `${before}${sign === "+" ? "플러스" : "마이너스"} `)
      //thousands and millions (45.6k, 2K, 1.5M) as numbers
      edit(/(?<![\w.,])(\d+(?:\.\d+)?)([kKM])(?![A-Za-z0-9])/g, (m, value, suffix) =>
        koreanNumber(String(Math.round(Number(value) * (suffix === "M" ? 1000000 : 1000)))))
      //times (1.3x, 4x) — 배
      edit(/(?<![\w.,])(\d+(?:\.\d+)?)x(?![A-Za-z0-9])/g, "$1배")
      //a unit right after a number (35ms, 19MB, 30px) in Korean
      edit(new RegExp(String.raw`(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(${UNIT_NAMES})(?![A-Za-z0-9])`, "g"), (m, value, unit) => `${value}${UNIT_WORDS[unit]}`)
      //a number with thousands separators (54,926) in words — a voice stops at the commas
      edit(/(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?(?![\d,])/g, (m, whole, frac) => koreanNumber(whole.replace(/,/g, "")) + (frac ? koreanFraction(frac) : ""))
      edit(/\s*×\s*(?=\d)/g, " 곱하기 ")
      //a tilde range (4~5개, 15:39~15:45) — 에서, when a number or a Korean number follows
      edit(/([\d%가-힣A-Za-z])[ \t]*~[ \t]*(?=[\d일이삼사오육칠팔구십백천만억조영]|공[공영일이삼사오육칠팔구])/g, "$1에서 ")
    }


    //an English name as in the plugin: camel case spaced, signs spaced
    function spacedName(token) {
      return camel(token).replace(/[._/\\-]+/g, " ")
    }
    function camel(token) {
      return token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    }

    //English names with words in capitals read as words (Korean and English voices)
    function speakNames() {
      const tokens = Array.from(cur.text.matchAll(NAME_WITH_TAIL), match => ({text: match[0], at: match.index}))
      const inRun = capitalRuns(tokens)
      edit(NAME_WITH_TAIL, (token, at) => speakName(token, inRun.has(at)))
    }

    function speakName(token, inCapitalRun) {
      const parts = token.split(/[._/\\-]+/)
      //a name all in capitals with an English word in it (IN_PROGRESS) is read like a sentence in capitals
      const capitalName = parts.length > 1 && parts.every(part => /^[A-Z]+$/.test(part))
        && parts.some(part => part.length > 2 && speakCapitals(part, false) != part)
      return parts.map(part => speakPart(part, inCapitalRun || capitalName)).join(" ")
    }

    function speakPart(part, inCapitalRun) {
      if (!part) return part
      const apostrophe = /^([A-Za-z0-9_]+)(['’][A-Za-z]+)$/.exec(part)
      if (apostrophe) return speakApostrophe(part, apostrophe[1], apostrophe[2], inCapitalRun)
      if (/\d/.test(part)) return camel(part)
      //an abbreviation in the plural (APIs, READMEs): the abbreviation, then its s; one of two letters (PCs) as it is
      const plural = /^([A-Z]{2,})s$/.exec(part)
      if (plural) {
        if (plural[1].length <= 2) return part
        const stem = speakCapitals(plural[1], inCapitalRun)
        return stem == plural[1] ? part : stem + "s"
      }
      if (/^[A-Z]+$/.test(part)) return speakCapitals(part, inCapitalRun)
      //camel case (getHTTPResponse, loadREADMEFile) spaced, its words in capitals read as above
      return camel(part).split(" ").map(word => /^[A-Z]{3,}$/.test(word) ? speakCapitals(word, false) : word).join(" ")
    }

    //a word with an apostrophe: in capitals, a contraction (DON'T, I'M) or a word and its 's (README's, USER'S)
    function speakApostrophe(part, stem, tail, inCapitalRun) {
      if (/\d/.test(stem) || stem != stem.toUpperCase()) return camel(stem) + tail
      if (part == part.toUpperCase() && words.has(part.toLowerCase().replace(/’/g, "'"))) return part.toLowerCase()
      if (!/^['’]s$/i.test(tail)) return part
      const spoken = speakCapitals(stem, inCapitalRun)
      return spoken + (spoken == stem ? tail : tail.toLowerCase())
    }

    function speakCapitals(word, inCapitalRun) {
      const lower = word.toLowerCase()
      //left in capitals, but for short words among words in capitals (DO in "DO NOT EDIT")
      if (word.length <= 2) return inCapitalRun && SPOKEN_SHORT_WORDS.has(lower) ? lower : word
      //words without a vowel are sounds (ssh, hmm): in capitals it's an abbreviation (SSH)
      if (!/[aeiouy]/.test(lower)) return word
      if (words.has(lower)) return lower
      const run = splitIntoWords(lower)
      return run ? run.join(" ") : word
    }

    //the fewest English words, then the most common (lowest SCOWL level), making up w. Words of 3 letters or
    //more, or two-letter ones read as words (SPOKEN_SHORT_WORDS); null if it can't be done or is a single word
    function splitIntoWords(w) {
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
    function capitalRuns(tokens) {
      const inRun = new Set()
      const isCapitalWord = token => /^[A-Z]+(?:['’][A-Z]+)?$/.test(token.text)
      const lowers = token => token.text.length > 2 && speakPart(token.text, false) != token.text
      let run = []
      const flush = () => {
        if (run.some(lowers)) for (const token of run) inRun.add(token.at)
        run = []
      }
      for (let k = 0; k < tokens.length; k++) {
        const token = tokens[k], prev = tokens[k - 1]
        if (!isCapitalWord(token)) {
          flush()
          continue
        }
        if (run.length && /[\p{L}\p{N}]/u.test(cur.text.slice(prev.at + prev.text.length, token.at))) flush()
        run.push(token)
      }
      flush()
      return inRun
    }
  }


  //text.replace(pattern, replacement) for a global pattern, keeping for each char the segment position it comes from
  function replaceTracked(t, pattern, replacement) {
    const edits = []
    for (const match of t.text.matchAll(pattern)) {
      const text = typeof replacement == "function"
        ? replacement(...match, match.index, t.text)
        : replacement.replace(/\$(\$|&|\d\d?)/g, (x, n) => n == "$" ? "$" : n == "&" ? match[0] : match[+n] == null ? "" : match[+n])
      edits.push({from: match.index, to: match.index + match[0].length, text})
    }
    return spliceTracked(t, edits)
  }

  //spans (in order, apart) of t replaced. A char written comes from the first of its own in what it replaces, looked
  //for from the last found on (case aside, not for spaces) — or else from where the char before came from
  function spliceTracked(t, edits) {
    if (!edits.length) return t
    let text = "", last = 0
    const src = []
    for (const {from, to, text: written} of edits) {
      text += t.text.slice(last, from) + written
      for (let k = last; k < from; k++) src.push(t.src[k])
      const replaced = t.text.slice(from, to)
      let came = from < t.src.length ? t.src[from] : t.src.length ? t.src[t.src.length - 1] + 1 : 0
      let look = 0
      for (let j = 0; j < written.length; j++) {
        const c = written[j]
        if (!/\s/.test(c)) {
          const lower = c.toLowerCase()
          let k = look
          while (k < replaced.length && replaced[k].toLowerCase() != lower) k++
          if (k < replaced.length) {
            came = t.src[from + k]
            look = k + 1
          }
        }
        src.push(came)
      }
      last = to
    }
    text += t.text.slice(last)
    for (let k = last; k < t.text.length; k++) src.push(t.src[k])
    return {text, src}
  }
})
