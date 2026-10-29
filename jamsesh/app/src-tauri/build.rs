// The app's commands get ACL permissions, so a capability can give the session window (a page
// served at 127.0.0.1, not bundled) just the ones it needs: `has_fonts`, `lend_font` and `heartbeat` (capabilities/session.json).
// Every command is listed: with a manifest, a command no capability allows is refused.
const COMMANDS: &[&str] = &[
    "start_info",
    "nearby_hosts",
    "host_here",
    "open_project",
    "join",
    "perm_status",
    "perm_request",
    "perm_settings",
    "finish_setup",
    "relaunch",
    "remote_setup",
    "get_userless",
    "toggle_userless",
    "has_fonts",
    "lend_font",
    "heartbeat",
    "screens_state",
    "screens_preview",
    "screens_save",
    "screens_identify",
    "screens_close",
];

fn main() {
    let attrs = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(e) = tauri_build::try_build(attrs) {
        println!("cargo::error={e:#}");
    }
}
