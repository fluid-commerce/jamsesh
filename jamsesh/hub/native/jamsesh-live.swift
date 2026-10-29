// jamsesh-live: streams one Mac app window as JPEG frames and clicks, drags, scrolls and types into
// that window only. The hub starts it for an approved build that opened a desktop app (a native
// .app or an Electron app).
//
//   jamsesh-live --check                      {"screen":true|false,"accessibility":true|false}; never prompts
//   jamsesh-live --windows <app name>         [{"id":..,"title":"..","w":..,"h":..}] for that app's windows
//   jamsesh-live <app name> [fps] [--window <id>] [--crop x,y,w,h]
//                                             stream; --window picks one window, --crop is a rectangle in points inside it
//   stdout  frames: 4-byte big-endian length, then a JPEG
//   stderr  one JSON line per event: {"event":"window","w":..,"h":..} {"event":"error","code":"screen|accessibility|nowindow","text":".."}
//   stdin   {"t":"pause"} / {"t":"resume"} stop and restart the frames (nobody is watching); one JSON line per input: {"t":"tap|down|move|up|scroll|text","x":0..1,"y":0..1,"dx":..,"dy":..,"text":".."}
//           or {"t":"key","key":"return|delete|tab"}. x and y are fractions of the window. The Mac's own cursor never moves.
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

/// The button the hub told us is down: where, for whom, and when we last heard. A button never stays down once the hub is gone or quiet.
var held: (p: CGPoint, pid: pid_t, at: Date)?
let heldLock = NSLock()
func setHeld(_ h: (p: CGPoint, pid: pid_t, at: Date)?) {
  heldLock.lock()
  held = h
  heldLock.unlock()
}
/// Lets go of the held button (if any) where it was last.
func releaseHeld() {
  heldLock.lock()
  let h = held
  held = nil
  heldLock.unlock()
  if let h { mouse(.leftMouseUp, h.p, h.pid) }
}

/// Every way out of this program goes through here, so a button the hub told us is down never outlives it.
func quit(_ code: Int32) -> Never {
  releaseHeld()
  exit(code)
}

func say(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), var s = String(data: d, encoding: .utf8) else { return }
  s += "\n"
  FileHandle.standardError.write(Data(s.utf8))
}

func fail(_ code: String, _ text: String) -> Never {
  say(["event": "error", "code": code, "text": text])
  quit(code == "screen" ? 3 : code == "nowindow" ? 4 : 5)
}

/// Writes all of `data` to stdout; the hub closing the pipe ends the program.
func writeOut(_ data: Data) {
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    guard var p = raw.baseAddress else { return }
    var left = raw.count
    while left > 0 {
      let n = write(1, p, left)
      if n <= 0 { quit(0) }
      p = p.advanced(by: n)
      left -= n
    }
  }
}

let args = CommandLine.arguments

/// Whether the permissions are already granted. Asking the user is the app's job, never this helper's.
if args.count >= 2 && args[1] == "--check" {
  print("{\"screen\":\(CGPreflightScreenCaptureAccess()),\"accessibility\":\(AXIsProcessTrusted())}")
  quit(0)
}

// An app is named by its bundle id, and its windows are the ones its processes own: never another app whose
// name happens to contain the same words.
func pids(_ bundle: String) -> Set<pid_t> {
  Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).map(\.processIdentifier))
}

func windowInfos(_ owners: Set<pid_t>) -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  return list.filter { w in
    guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int32 else { return false }
    return owners.contains(pid)
  }
}

// The running apps with windows of their own, for the hub to find an app by its exact name.
if args.count >= 2 && args[1] == "--apps" {
  let out: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { a in
    guard a.activationPolicy == .regular, let bundle = a.bundleIdentifier, let name = a.localizedName else { return nil }
    return ["pid": Int(a.processIdentifier), "bundle": bundle, "name": name]
  }
  if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }
  quit(0)
}

if args.count >= 3 && args[1] == "--windows" {
  let out: [[String: Any]] = windowInfos(pids(args[2])).compactMap { w in
    guard let id = w[kCGWindowNumber as String] as? UInt32, let b = w[kCGWindowBounds as String] as? [String: CGFloat], let width = b["Width"], let height = b["Height"] else { return nil }
    return ["id": Int(id), "title": (w[kCGWindowName as String] as? String) ?? "", "w": Int(width), "h": Int(height)]
  }
  if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }
  quit(0)
}

guard args.count >= 2, !args[1].isEmpty else { fail("args", "Usage: jamsesh-live <bundle id> [fps] [--window id] [--crop x,y,w,h]") }
let bundle = args[1]
var fps = 30
var wantWindow: UInt32?
var crop: CGRect?
var i = 2
while i < args.count {
  let a = args[i]
  if a == "--window", i + 1 < args.count { wantWindow = UInt32(args[i + 1]); i += 2 }
  else if a == "--crop", i + 1 < args.count {
    let v = args[i + 1].split(separator: ",").compactMap { Double($0) }
    if v.count == 4, v[2] > 0, v[3] > 0 { crop = CGRect(x: v[0], y: v[1], width: v[2], height: v[3]) }
    i += 2
  } else { fps = max(1, min(60, Int(a) ?? 30)); i += 1 }
}

if !CGPreflightScreenCaptureAccess() {
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

/** The app's largest window (or the one asked for), from the app's own processes only. */
func findWindow() -> Target? {
  var best: Target?
  for w in windowInfos(pids(bundle)) {
    guard let id = w[kCGWindowNumber as String] as? UInt32, let pid = w[kCGWindowOwnerPID as String] as? Int32,
      let b = w[kCGWindowBounds as String] as? [String: CGFloat],
      let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"], width > 60, height > 60
    else { continue }
    if let only = wantWindow, only != id { continue }
    let t = Target(id: id, pid: pid, bounds: CGRect(x: x, y: y, width: width, height: height))
    if let b = best, b.bounds.width * b.bounds.height >= t.bounds.width * t.bounds.height { continue }
    best = t
  }
  return best
}

guard let first = findWindow() else { fail("nowindow", "No window of \(bundle) is on screen.") }
current = first

/**
 * Where the captured window is now: the same window, still owned by the same process of the same app. Nil once it
 * has closed, gone off screen, or its process has been replaced, and then capture and input stop.
 */
func sameWindow() -> Target? {
  guard NSRunningApplication(processIdentifier: first.pid)?.bundleIdentifier == bundle,
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], first.id) as? [[String: Any]],
    let w = list.first, (w[kCGWindowNumber as String] as? UInt32) == first.id, (w[kCGWindowOwnerPID as String] as? Int32) == first.pid,
    (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
    let b = w[kCGWindowBounds as String] as? [String: CGFloat], let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"]
  else { return nil }
  return Target(id: first.id, pid: first.pid, bounds: CGRect(x: x, y: y, width: width, height: height))
}

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


/// While nobody watches the tile the hub says "pause": frames are dropped before they are encoded, "resume" starts them again.
var paused = false
let pauseLock = NSLock()
func setPaused(_ on: Bool) {
  pauseLock.lock()
  paused = on
  pauseLock.unlock()
}
func isPaused() -> Bool {
  pauseLock.lock()
  defer { pauseLock.unlock() }
  return paused
}

func handle(_ line: String) {
  guard let d = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let t = m["t"] as? String else { return }
  if t == "pause" || t == "resume" { return setPaused(t == "pause") }
  guard canInput else { return }
  let fx = (m["x"] as? Double) ?? 0.5
  let fy = (m["y"] as? Double) ?? 0.5
  switch t {
  case "tap":
    guard let (p, pid) = point(fx, fy) else { return }
    mouse(.leftMouseDown, p, pid)
    usleep(40_000)
    mouse(.leftMouseUp, p, pid)
  case "down":
    releaseHeld()
    if let (p, pid) = point(fx, fy) {
      mouse(.leftMouseDown, p, pid)
      setHeld((p, pid, Date()))
    }
  case "move":
    if let (p, pid) = point(fx, fy) {
      mouse(.leftMouseDragged, p, pid)
      heldLock.lock()
      if held != nil { held = (p, pid, Date()) }
      heldLock.unlock()
    }
  case "up":
    // Where the hub says if the window is still there; else where the button went down. Either way the held button comes up.
    heldLock.lock()
    let was = held
    held = nil
    heldLock.unlock()
    if let (p, pid) = point(fx, fy) { mouse(.leftMouseUp, p, was?.pid ?? pid) } else if let was { mouse(.leftMouseUp, was.p, was.pid) }
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
  case "key":
    lock.lock()
    let pid = current?.pid
    lock.unlock()
    let codes: [String: CGKeyCode] = ["return": 36, "delete": 51, "tab": 48, "escape": 53]
    guard let pid, let name = m["key"] as? String, let code = codes[name] else { return }
    for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.postToPid(pid) }
  default:
    return
  }
}

Thread.detachNewThread {
  while let line = readLine() { handle(line) }
  quit(0)  // the hub closed our stdin: it's done with us
}

// A press the hub never finished (it was killed, or the network behind it dropped) is let go after a few quiet seconds.
Thread.detachNewThread {
  while true {
    sleep(1)
    heldLock.lock()
    let stale = held.map { Date().timeIntervalSince($0.at) > 6 } ?? false
    heldLock.unlock()
    if stale { releaseHeld() }
  }
}
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
term.setEventHandler {
  quit(0)
}
term.resume()

// ---- capture ----
final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  let ci = CIContext()
  var last = Date.distantPast
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !isPaused(), type == .screen, sb.isValid, let px = CMSampleBufferGetImageBuffer(sb) else { return }
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
    let area = crop ?? CGRect(origin: .zero, size: win.frame.size)
    if crop != nil { cfg.sourceRect = area }
    cfg.width = Int(area.width) * scale
    cfg.height = Int(area.height) * scale
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    cfg.capturesAudio = false
    cfg.queueDepth = 3
    let stream = SCStream(filter: filter, configuration: cfg, delegate: output)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
    say(["event": "window", "w": Int(area.width), "h": Int(area.height)])
  } catch {
    fail("screen", "Couldn't start capturing: \(error.localizedDescription)")
  }
}

// Keeps the window's position fresh for input, and notices when it goes away.
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
timer.setEventHandler {
  let t = sameWindow()
  lock.lock()
  current = t
  lock.unlock()
  if t == nil { fail("nowindow", "The window closed.") }
}
timer.resume()
RunLoop.main.run()
