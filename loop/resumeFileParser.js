// ============================================================================
// RESUME FILE PARSER — turns an uploaded PDF/DOCX/TXT file into plain text,
// which then flows into the existing extractProfileFromResume() analysis —
// no duplicate logic, this only handles getting text OUT of a binary file.
//
// Engineering choice, stated plainly: PDF text extraction uses the system's
// `pdftotext` binary (from poppler-utils) via a child process, rather than a
// pure-JS npm package. This is a deliberate tradeoff:
//   + poppler's PDF parser is mature, battle-tested, and handles far more
//     real-world PDF edge cases correctly than most lightweight JS parsers.
//   + it avoids pulling in a large, fragile dependency tree into this
//     otherwise minimal-dependency project.
//   - it requires `poppler-utils` to be installed on whatever machine runs
//     this (a `sudo apt-get install poppler-utils` on any Debian/Ubuntu
//     host, pre-installed on most CI runners; NOT present on a bare Windows
//     machine without separately installing poppler for Windows).
// If pdftotext isn't found, this fails with a clear, actionable error
// instead of a cryptic stack trace.
// ============================================================================

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const mammoth = require("mammoth");

const MAX_TEXT_LENGTH = 50_000; // matches the existing /api/build-profile limit

function runPdfToText(buffer) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `resume_${crypto.randomBytes(8).toString("hex")}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    execFile("pdftotext", [tmpPath, "-"], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      fs.unlink(tmpPath, () => {}); // best-effort cleanup, don't block on it
      if (err) {
        if (err.code === "ENOENT") {
          return reject(new Error(
            "PDF parsing requires 'poppler-utils' (the pdftotext command) to be installed " +
            "on this server. On Debian/Ubuntu: sudo apt-get install poppler-utils. " +
            "Most CI/hosting environments already have this."
          ));
        }
        return reject(new Error(`pdftotext failed: ${err.message}`));
      }
      resolve(stdout);
    });
  });
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Extracts plain text from an uploaded resume file buffer.
 * @param {Buffer} buffer - the raw file contents
 * @param {string} originalName - the uploaded filename, used to detect type
 * @returns {Promise<string>} plain text, truncated to MAX_TEXT_LENGTH
 */
async function extractTextFromFile(buffer, originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  let text;

  if (ext === ".pdf") {
    text = await runPdfToText(buffer);
  } else if (ext === ".docx") {
    text = await extractTextFromDocx(buffer);
  } else if (ext === ".txt") {
    text = buffer.toString("utf-8");
  } else {
    throw new Error(`Unsupported file type "${ext}". Supported: .pdf, .docx, .txt`);
  }

  if (!text || text.trim().length < 30) {
    throw new Error("Could not extract enough readable text from this file — it may be a scanned image PDF, empty, or corrupted.");
  }

  return text.slice(0, MAX_TEXT_LENGTH);
}

module.exports = { extractTextFromFile };
