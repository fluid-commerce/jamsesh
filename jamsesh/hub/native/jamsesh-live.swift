// jamsesh-live: streams one Mac app window as JPEG frames and clicks, drags, scrolls and types into
// that window only. The hub starts it for an approved build that opened a desktop app (a native
// .app or an Electron app).
//
//   jamsesh-live <app name> [fps]
//   stdout  frames: 4-byte big-endian length, then a JPEG
//   stderr  one JSON line per event: {"event":"window","w":..,"h":..} {"event":"error","code":"screen|accessibility|nowindow","text":".."}
//   stdin   one JSON line per input: {"t":"tap|down|move|up|scroll|text","x":0..1,"y":0..1,"dx":..,"dy":..,"text":".."}
//           x and y are fractions of the window. The Mac's own cursor never moves.
//
// Needs Screen Recording (to see the window) and Accessibility (to send input) for whatever
// started it. Nothing here force-unwraps or traps: every failure is reported and the stream ends.
import AppKit
import ApplicationServices
import CoreImage
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOFBF, 1 << 20)
signal(SIGPIPE, SIG_IGN)

func say(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), var s = String(data: d, encoding: .utf8) else { return }
  s += "\n"
  FileHandle.standardError.write(Data(s.utf8))
}

func fail(_ code: String, _ text: String) -> Never {
  say(["event": "error", "code": code, "text": text])
  exit(code == "screen" ? 3 : code == "nowindow" ? 4 : 5)
}

/// Writes all of `data` to stdout; the hub closing the pipe ends the program.
func writeOut(_ data: Data) {
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    guard var p = raw.baseAddress else { return }
    var left = raw.count
    while left > 0 {
      let n = write(1, p, left)
      if n <= 0 { exit(0) }
      p = p.advanced(by: n)
      left -= n
    }
  }
}

let args = CommandLine.arguments
guard args.count >= 2, !args[1].isEmpty else { fail("args", "Usage: jamsesh-live <app name> [fps]") }
let appName = args[1].lowercased()
let fps = max(1, min(60, args.count > 2 ? (Int(args[2]) ?? 30) : 30))

if !CGPreflightScreenCaptureAccess() {
  // Asks once; macOS shows its own prompt and the grant needs the app restarted.
  _ = CGRequestScreenCaptureAccess()
  fail("screen", "Screen Recording isn't allowed for JamSesh on this Mac (System Settings > Privacy & Security).")
}

/// The window being shown: id, owner process, and where it is on the screen right now.
struct Target {
  var id: CGWindowID
  var pid: pid_t
  var bounds: CGRect
}
var current: Target?
let lock = NSLock()

func findWindow() -> Target? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  var best: Target?
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0,
      let owner = w[kCGWindowOwnerName as String] as? String, owner.lowercased().contains(appName),
      let id = w[kCGWindowNumber as String] as? UInt32, let pid = w[kCGWindowOwnerPID as String] as? Int32,
      let b = w[kCGWindowBounds as String] as? [String: CGFloat],
      let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"], width > 60, height > 60
    else { continue }
    let t = Target(id: id, pid: pid, bounds: CGRect(x: x, y: y, width: width, height: height))
    if let b = best, b.bounds.width * b.bounds.height >= t.bounds.width * t.bounds.height { continue }
    best = t
  }
  return best
}

guard let first = findWindow() else { fail("nowindow", "No window of \(args[1]) is on screen.") }
current = first

// ---- input ----
let canInput = AXIsProcessTrusted()
if !canInput { say(["event": "error", "code": "accessibility", "text": "Accessibility isn't allowed for JamSesh on this Mac, so people can watch but not click."]) }

func point(_ fx: Double, _ fy: Double) -> (CGPoint, pid_t)? {
  lock.lock()
  defer { lock.unlock() }
  guard let t = current, fx.isFinite, fy.isFinite else { return nil }
  let x = t.bounds.minX + min(max(fx, 0), 1) * t.bounds.width
  let y = t.bounds.minY + min(max(fy, 0), 1) * t.bounds.height
  return (CGPoint(x: x, y: y), t.pid)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ pid: pid_t) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.postToPid(pid)
}

func handle(_ line: String) {
  guard canInput, let d = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let t = m["t"] as? String else { return }
  let fx = (m["x"] as? Double) ?? 0.5
  let fy = (m["y"] as? Double) ?? 0.5
  switch t {
  case "tap":
    guard let (p, pid) = point(fx, fy) else { return }
    mouse(.leftMouseDown, p, pid)
    usleep(40_000)
    mouse(.leftMouseUp, p, pid)
  case "down":
    if let (p, pid) = point(fx, fy) { mouse(.leftMouseDown, p, pid) }
  case "move":
    if let (p, pid) = point(fx, fy) { mouse(.leftMouseDragged, p, pid) }
  case "up":
    if let (p, pid) = point(fx, fy) { mouse(.leftMouseUp, p, pid) }
  case "scroll":
    guard let (p, pid) = point(fx, fy) else { return }
    mouse(.mouseMoved, p, pid)
    let dy = Int32(max(-2000, min(2000, (m["dy"] as? Double) ?? 0)))
    let dx = Int32(max(-2000, min(2000, (m["dx"] as? Double) ?? 0)))
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.postToPid(pid)
  case "text":
    guard let s = m["text"] as? String, s.count <= 200 else { return }
    lock.lock()
    let pid = current?.pid
    lock.unlock()
    guard let pid else { return }
    for ch in s.utf16.map({ [$0] }) {
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: ch.count, unicodeString: ch)
        e?.postToPid(pid)
      }
    }
  default:
    return
  }
}

Thread.detachNewThread {
  while let line = readLine() { handle(line) }
  exit(0)  // the hub closed our stdin: it's done with us
}

// ---- capture ----
final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  let ci = CIContext()
  var last = Date.distantPast
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid, let px = CMSampleBufferGetImageBuffer(sb) else { return }
    if let a = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
      let raw = a[.status] as? Int, SCFrameStatus(rawValue: raw) != .complete { return }
    let img = CIImage(cvPixelBuffer: px)
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let jpeg = ci.jpegRepresentation(of: img, colorSpace: space, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.72])
    else { return }
    var n = UInt32(jpeg.count).bigEndian
    writeOut(Data(bytes: &n, count: 4))
    writeOut(jpeg)
    fflush(stdout)
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("nowindow", "The window closed.")
  }
}

let output = Output()
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let win = content.windows.first(where: { $0.windowID == first.id }) else { fail("nowindow", "The window isn't capturable.") }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    let scale = max(1, Int(filter.pointPixelScale))
    cfg.width = Int(win.frame.width) * scale
    cfg.height = Int(win.frame.height) * scale
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    cfg.capturesAudio = false
    cfg.queueDepth = 3
    let stream = SCStream(filter: filter, configuration: cfg, delegate: output)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
    say(["event": "window", "w": Int(win.frame.width), "h": Int(win.frame.height)])
  } catch {
    fail("screen", "Couldn't start capturing: \(error.localizedDescription)")
  }
}

// Keeps the window's position fresh for input, and notices when it goes away.
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
timer.setEventHandler {
  guard let t = findWindow() else { return }
  lock.lock()
  if t.id == first.id || current == nil { current = t }
  lock.unlock()
}
timer.resume()
RunLoop.main.run()
