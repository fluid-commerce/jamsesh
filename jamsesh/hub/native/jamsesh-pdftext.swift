// jamsesh-pdftext <file.pdf> [max-characters]
// Prints the text of a PDF's first pages (Apple's PDFKit) and nothing else. Used for the card a document sent with no
// request becomes. Exit 0 with text on stdout; exit 2 when there is no text (a scan, a locked file); exit 3 when it is not a
// readable PDF or takes more than five seconds. Output is capped, and stderr carries a one-line reason.
import Foundation
import PDFKit

let limitSeconds = 5.0
let maxPages = 20

func fail(_ code: Int32, _ why: String) -> Never {
    FileHandle.standardError.write(Data((why + "\n").utf8))
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail(3, "usage: jamsesh-pdftext <file.pdf> [max-characters]") }
let cap = args.count >= 3 ? max(1, min(Int(args[2]) ?? 4000, 100_000)) : 4000

// A hard stop, so a hostile or huge file can't hold the caller.
DispatchQueue.global().asyncAfter(deadline: .now() + limitSeconds) { fail(3, "timed out") }

guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { fail(3, "not a readable PDF") }
if doc.isLocked { fail(2, "locked") }

var out = ""
for i in 0..<min(doc.pageCount, maxPages) {
    guard let page = doc.page(at: i), let text = page.string else { continue }
    out += text + "\n"
    if out.count >= cap { break }
}
let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
if trimmed.isEmpty { fail(2, "no text") }
print(String(trimmed.prefix(cap)))
exit(0)
