// The macOS permissions a host needs, checked and requested from the app itself. The hub and
// everything it runs (osascript, simctl, screencapture) are child processes of the app, so
// macOS applies these same grants to them.
use std::ffi::c_void;
use std::process::Command;

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::runtime::Bool;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use serde::Serialize;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[repr(C)]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    fn AEDeterminePermissionToAutomateTarget(target: *const AEDesc, event_class: u32, event_id: u32, ask: u8) -> i32;
}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

/// "granted", "denied", "ask" (not decided yet), or "missing" (developer tools).
#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Granted,
    Denied,
    Ask,
    Missing,
}

#[derive(Serialize)]
pub struct Status {
    pub microphone: State,
    pub camera: State,
    pub accessibility: State,
    pub automation: State,
    pub screen: State,
    pub devtools: State,
}

fn av(media: &str) -> State {
    let m = NSString::from_str(media);
    // AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
    let s: isize = unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*m] };
    match s {
        3 => State::Granted,
        0 => State::Ask,
        _ => State::Denied,
    }
}

fn av_request(media: &str) {
    let m = NSString::from_str(media);
    let done = block2::RcBlock::new(|_granted: Bool| {});
    let _: () = unsafe { msg_send![class!(AVCaptureDevice), requestAccessForMediaType: &*m, completionHandler: &*done] };
}

const SYSTEM_EVENTS: &str = "com.apple.systemevents";
const TYPE_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
const WILDCARD: u32 = u32::from_be_bytes(*b"****");

/// Whether this app may send Apple Events to System Events (window placement). `ask` shows
/// macOS's prompt when it hasn't been decided, and blocks until the person answers.
fn automation(ask: bool) -> State {
    // The check needs System Events running; launching it is harmless and invisible.
    let _ = Command::new("/usr/bin/open").args(["-g", "-j", "-b", SYSTEM_EVENTS]).status();
    let mut desc = AEDesc { descriptor_type: 0, data_handle: std::ptr::null_mut() };
    let id = SYSTEM_EVENTS.as_bytes();
    let created = unsafe { AECreateDesc(TYPE_BUNDLE_ID, id.as_ptr().cast(), id.len() as isize, &mut desc) };
    if created != 0 {
        return State::Ask;
    }
    let r = unsafe { AEDeterminePermissionToAutomateTarget(&desc, WILDCARD, WILDCARD, u8::from(ask)) };
    unsafe { AEDisposeDesc(&mut desc) };
    match r {
        0 => State::Granted,
        -1743 => State::Denied,
        _ => State::Ask,
    }
}

fn devtools() -> State {
    let ok = Command::new("/usr/bin/xcrun")
        .args(["simctl", "help"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if ok { State::Granted } else { State::Missing }
}

pub fn status() -> Status {
    Status {
        microphone: av("soun"),
        camera: av("vide"),
        accessibility: if unsafe { AXIsProcessTrusted() } { State::Granted } else { State::Ask },
        automation: automation(false),
        screen: if unsafe { CGPreflightScreenCaptureAccess() } { State::Granted } else { State::Ask },
        devtools: devtools(),
    }
}

/// Shows macOS's own prompt for one permission. Some (Accessibility, Screen Recording) send the
/// person to System Settings instead; `settings_url` opens the exact pane.
pub fn request(kind: &str) {
    match kind {
        "microphone" => av_request("soun"),
        "camera" => av_request("vide"),
        "accessibility" => {
            let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
            let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
            unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef().cast()) };
        }
        "automation" => {
            automation(true);
        }
        "screen" => {
            unsafe { CGRequestScreenCaptureAccess() };
        }
        "devtools" => {
            let _ = Command::new("/usr/bin/open").arg("macappstore://apps.apple.com/app/xcode/id497799835").status();
        }
        _ => {}
    }
}

pub fn settings_url(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "microphone" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "automation" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
        "screen" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        _ => return None,
    })
}
