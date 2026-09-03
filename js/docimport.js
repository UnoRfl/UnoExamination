// Generate an exam from a document.
//
// Most professors already have the paper — in Word, in a PDF, in a handout.
// This reads that document and works out where the questions, the options and
// the answer key are, so a 60-item exam becomes a draft in one drop instead of
// sixty clicks.
//
// It is deliberately a parser and not a model: it recognises the shapes real
// exam papers use, and reports anything it had to guess. Nothing is sent
// anywhere, there is no API key, and the same file always gives the same
// result.
import { readZipText } from "./xlsx.js";

// ------------------------------------------------------------ file → text
const decode = (u8) => new TextDecoder().decode(u8);

/** Word stores its text in one XML part; paragraphs and breaks become lines. */
export function docxToText(files) {
  const parts = Object.keys(files)
    .filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
    .sort();
  if (!parts.length) throw new Error("That .docx has no document part — it may be corrupt.");
  let out = "";
  for (const name of parts) {
    if (!name.startsWith("word/document")) continue;
    out += decode(files[name])
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  return out;
}

/**
 * Enough of a PDF reader to recover the text of a digitally-produced paper:
 * find the content streams, inflate them, and collect the string operands of
 * the text operators. Scanned pages hold pictures, not text, and come back
 * empty — the caller says so rather than importing nothing.
 */
export async function pdfToText(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const latin = Array.from(buf, (b) => String.fromCharCode(b)).join("");
  const chunks = [];

  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    const header = latin.slice(Math.max(0, m.index - 400), m.index);
    let raw = buf.subarray(start, end);
    if (/FlateDecode/.test(header)) {
      try { raw = await inflate(raw); } catch { continue; }
    } else if (/DCTDecode|JPXDecode|CCITTFaxDecode|Image/.test(header)) {
      continue;                                   // a picture, not text
    }
    chunks.push(decode(raw));
    re.lastIndex = end;
  }

  let text = "";
  for (const c of chunks) {
    if (!/\bTJ\b|\bTj\b/.test(c)) continue;
    // Tj takes one string; TJ takes an array of strings and kerning numbers.
    for (const op of c.match(/\[(?:[^\][\\]|\\.)*\]\s*TJ|\((?:[^()\\]|\\.)*\)\s*Tj|\bT\*|\bTd\b|\bTD\b|\bET\b/g) || []) {
      if (/^(T\*|Td|TD|ET)$/.test(op.trim())) { text += "\n"; continue; }
      for (const s of op.match(/\((?:[^()\\]|\\.)*\)/g) || []) {
        text += unescapePdf(s.slice(1, -1));
      }
    }
    text += "\n";
  }
  return text;
}

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (map[c] !== undefined) return map[c];
    return String.fromCharCode(parseInt(c, 8));
  });
}

async function inflate(bytes) {
  if (!globalThis.DecompressionStream) throw new Error("no DecompressionStream");
  // PDF Flate streams carry a zlib header; deflate-raw does not want one.
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
      return new Uint8Array(await out.arrayBuffer());
    } catch { /* try the other framing */ }
  }
  throw new Error("could not inflate");
}

/** Reads whichever document the professor dropped down to plain text. */
export async function fileToText(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".docx")) return docxToText(await readZipText(await file.arrayBuffer()));
  if (name.endsWith(".pdf")) {
    const text = await pdfToText(await file.arrayBuffer());
    if (text.replace(/\s/g, "").length < 40) {
      throw new Error(
        "No text could be read from that PDF. If it is a scan, the pages are pictures — " +
        "open it in Word (or your scanner's OCR), save as .docx, and drop that instead.");
    }
    return text;
  }
  if (name.endsWith(".doc")) {
    throw new Error("The old .doc format is not supported. In Word choose File → Save As → .docx.");
  }
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    return (await file.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|li|tr|h\d|br)[^>]*>/gi, "\n").replace(/<br[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  return file.text();
}

// ------------------------------------------------------------ text → paper
// The shapes real papers use.
const Q_NUM = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.)\]:-]\s+(.*)$/i;
const OPT = /^\s*\(?([A-Ha-h])\s*[.)\]:-]\s+(.*)$/;
const ANSWER_LINE = /^\s*(?:answer|ans|key|correct(?:\s+answer)?)\s*[:.\-]?\s*(.+)$/i;
// "… ? ANS: B" all on one line
const INLINE_ANSWER = /\s*[(\[]?\s*(?:answer|ans|key)\s*[:.\-]\s*([^)\]]+)[)\]]?\s*$/i;
const POINTS = /[([]\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?|marks?)\s*[)\]]/i;
const SECTION_HEAD = /^\s*(?:part|section|test|[IVX]+)\b.{0,80}$/i;
const TF_HINT = /\b(true\s*(?:or|\/)\s*false|true\/false)\b/i;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Reads an exam paper out of plain text.
 *
 * @returns {{questions: object[], warnings: string[], stats: object}}
 */
export function parseDocument(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));

  const raw = [];       // [{num, prompt, options:[], answer, points, section}]
  let cur = null, sawNumber = false, section = "";

  const push = () => { if (cur && clean(cur.prompt)) raw.push(cur); cur = null; };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    // an explicit answer line belongs to the question above it
    const ans = t.match(ANSWER_LINE);
    if (ans && cur && !OPT.test(t)) { cur.answer = clean(ans[1]); continue; }

    const q = t.match(Q_NUM);
    if (q) {
      push();
      sawNumber = true;
      let prompt = q[2];
      const inline = prompt.match(INLINE_ANSWER);
      let answer = null;
      if (inline) { answer = clean(inline[1]); prompt = prompt.slice(0, inline.index); }
      const pts = prompt.match(POINTS);
      cur = { num: Number(q[1]), prompt: clean(prompt.replace(POINTS, "")), options: [],
              answer, points: pts ? Number(pts[1]) : null, section };
      continue;
    }

    const o = t.match(OPT);
    if (o && cur) {
      // "A." at the start of a line is only an option if we are inside a
      // question; otherwise it is prose that happens to begin with a letter.
      cur.options.push({ letter: o[1].toUpperCase(), text: clean(o[2]) });
      continue;
    }

    // "PART II. TRUE OR FALSE" between questions sets the type for what follows
    if (!cur && SECTION_HEAD.test(t) && t.length < 80) { section = t; continue; }

    if (cur) {
      // A continuation of the prompt — unless it is an obvious heading.
      if (SECTION_HEAD.test(t) && t.length < 60 && !cur.options.length && cur.prompt.length > 20) {
        section = t; push(); continue;
      }
      if (cur.options.length) cur.options[cur.options.length - 1].text += " " + clean(t);
      else cur.prompt += " " + clean(t);
    }
  }
  push();

  if (!raw.length) {
    throw new Error(sawNumber
      ? "Questions were numbered but none had any text under them."
      : "No numbered questions were found. Each question needs to start on its own " +
        "line with a number, like \"1. What is …\". Options go on their own lines as \"A. …\".");
  }

  // ---- turn the raw shapes into real questions
  const questions = [], warnings = [];
  let withKey = 0;
  raw.forEach((r, i) => {
    const at = `Q${r.num || i + 1}`;
    const id = `q${String(i + 1).padStart(3, "0")}`;
    const opts = r.options.map((o) => o.text).filter(Boolean);
    const answer = r.answer;
    const q = { id, prompt: r.prompt, points: r.points || 1, key: {} };

    // A true/false item announces itself three ways: its options ARE True and
    // False, its answer is the word, or it sits under a "TRUE OR FALSE" heading.
    const tfOptions = opts.length === 2 && opts.every((o) => /^(true|false)$/i.test(o.trim()));
    const tfAnswer = answer != null && /^\s*(true|false|t|f)\s*$/i.test(answer);
    const tfContext = !opts.length && (TF_HINT.test(r.prompt) || TF_HINT.test(r.section || ""));

    if (tfOptions || tfAnswer || tfContext) {
      q.type = "tf";
      if (tfOptions && answer != null && !tfAnswer) {
        // "Answer: A" on a True/False item means the first option.
        const [pick] = pickLetters(answer, r.options, opts.length);
        if (pick === undefined) {
          q.key = { correct: true };
          warnings.push(`${at}: could not read "${answer}" — assumed True.`);
        } else {
          q.key = { correct: /^\s*true/i.test(opts[pick]) };
        }
      } else if (answer != null) {
        q.key = { correct: /^\s*(t|true|1|yes|y)\b/i.test(answer) };
      } else {
        q.key = { correct: true };
        warnings.push(`${at}: no answer given — assumed True.`);
      }
    } else if (opts.length >= 2) {
      q.options = opts;
      const picks = pickLetters(answer, r.options, opts.length);
      if (!picks.length) {
        q.type = "mc"; q.key = { correct: 0 };
        warnings.push(`${at}: could not tell which option is correct${answer ? ` from "${answer}"` : ""}.`);
      } else if (picks.length === 1) {
        q.type = "mc"; q.key = { correct: picks[0] };
      } else {
        q.type = "multi"; q.key = { correct: picks, partialCredit: false };
      }
    } else if (answer) {
      q.type = "text";
      q.key = {
        accepted: answer.split(/\s*(?:\||\/|,| or )\s*/i).map(clean).filter(Boolean),
        caseSensitive: false,
      };
    } else {
      // No options and no answer: a question the professor grades by hand.
      q.type = clean(r.prompt).length > 120 || /\b(explain|discuss|describe|why|compare|essay)\b/i.test(r.prompt)
        ? "essay" : "text";
      if (q.type === "text") {
        q.key = { accepted: [], caseSensitive: false };
        warnings.push(`${at}: no answer found — add one, or change it to an essay.`);
      }
    }
    if (Object.keys(q.key).length && (q.key.correct !== undefined || q.key.accepted?.length)) withKey++;
    questions.push(q);
  });

  // A paper where the numbering jumps is usually a paragraph the parser
  // mistook for a question, or a question it missed. Worth saying.
  const nums = raw.map((r) => r.num).filter(Number.isFinite);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) {
      warnings.push(`Numbering jumps from ${nums[i - 1]} to ${nums[i]} — check nothing was missed.`);
      break;
    }
  }

  return {
    questions,
    warnings,
    stats: {
      found: questions.length,
      withKey,
      byType: questions.reduce((a, q) => ((a[q.type] = (a[q.type] || 0) + 1), a), {}),
    },
  };
}

/**
 * Works out which options an answer refers to.
 * Accepts "B", "b)", "A and C", "A, C", "2", or the answer text itself.
 */
function pickLetters(answer, options, count) {
  const a = clean(answer);
  if (!a) return [];
  const out = new Set();

  // letters, as separate tokens so "Cat" is not read as option C
  for (const m of a.matchAll(/(?:^|[\s,;/&]|and\s)\(?([A-Ha-h])\)?(?=$|[\s,;./)&]|\sand\b)/g)) {
    const i = m[1].toUpperCase().charCodeAt(0) - 65;
    if (i < count) out.add(i);
  }
  if (out.size) return [...out].sort((x, y) => x - y);

  for (const m of a.matchAll(/\b(\d{1,2})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= count) out.add(n - 1);
  }
  if (out.size) return [...out].sort((x, y) => x - y);

  // the answer may simply be the option's own words
  const norm = (s) => clean(s).toLowerCase().replace(/[.,;:]+$/, "");
  const hit = options.findIndex((o) => norm(o.text) === norm(a));
  return hit >= 0 ? [hit] : [];
}

/** Everything the import dialog needs from one dropped document. */
export async function parseDocumentFile(file) {
  const text = await fileToText(file);
  const parsed = parseDocument(text);
  return { ...parsed, source: file.name, chars: text.length };
}
