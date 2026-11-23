#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

// "Open with Quarc Reader": a PDF double-clicked in the file manager, "Open with…", dropped on the app's
// icon, or passed on the command line. The window shows the Quarc Reader server, so the page cannot be
// handed a file directly. Instead:
//   - the path is added to the fs plugin's scope (just that file, just now), and
//   - the page is told with `window.__quarcOpenFiles` + a 'quarc-open-files' event,
// and the page reads the file with the fs plugin (frontend/src/lib/openWith.js).
//   Windows / Linux: the file arrives as a command-line argument — of this process, or (a second launch)
//                    of another one, which the single-instance plugin forwards here.
//   macOS:           the system sends an "open" event to the running app (RunEvent::Opened).

/// Paths not yet told to the page, and whether the page is loaded (before that nobody is listening).
#[derive(Default)]
struct Queue {
    paths: Vec<String>,
    page_ready: bool,
}

struct Pending(Mutex<Queue>);

fn is_pdf(path: &Path) -> bool {
    path.extension().map_or(false, |e| e.eq_ignore_ascii_case("pdf")) && path.is_file()
}

/// A command-line argument that names a PDF: a plain path, or a file:// URL (some Linux launchers).
fn pdf_from_arg(arg: &str) -> Option<PathBuf> {
    let path = match url::Url::parse(arg) {
        Ok(u) if u.scheme() == "file" => u.to_file_path().ok()?,
        _ => PathBuf::from(arg),
    };
    is_pdf(&path).then_some(path)
}

fn pdfs_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter().skip(1).filter_map(|a| pdf_from_arg(&a)).collect()
}

/// Tells the page about whatever is waiting, if it can hear it. Otherwise it waits for the page load.
fn flush(app: &AppHandle) {
    let paths = {
        let pending = app.state::<Pending>();
        let mut queue = pending.0.lock().unwrap();
        if !queue.page_ready || queue.paths.is_empty() {
            return;
        }
        std::mem::take(&mut queue.paths)
    };
    if let (Some(window), Ok(json)) = (app.get_webview_window("main"), serde_json::to_string(&paths)) {
        let _ = window.eval(&format!(
            "window.__quarcOpenFiles=(window.__quarcOpenFiles||[]).concat({json});window.dispatchEvent(new Event('quarc-open-files'));"
        ));
    }
}

fn open_pdfs(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| is_pdf(p)).collect();
    if paths.is_empty() {
        return;
    }
    for path in &paths {
        // The page may read this file (and no other one it was not given).
        let _ = app.fs_scope().allow_file(path);
    }
    app.state::<Pending>()
        .0
        .lock()
        .unwrap()
        .paths
        .extend(paths.iter().map(|p| p.to_string_lossy().into_owned()));
    flush(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        // First, as the plugin requires: a second launch ends here and its arguments come to us.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_pdfs(app, pdfs_from_args(args));
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Pending(Mutex::new(Queue::default())))
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            let app = webview.app_handle();
            match payload.event() {
                PageLoadEvent::Started => app.state::<Pending>().0.lock().unwrap().page_ready = false,
                PageLoadEvent::Finished => {
                    app.state::<Pending>().0.lock().unwrap().page_ready = true;
                    flush(app);
                }
            }
        })
        .setup(|app| {
            open_pdfs(app.handle(), pdfs_from_args(std::env::args()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Quarc Reader");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Opened { urls } = event {
                open_pdfs(app, urls.iter().filter_map(|u| u.to_file_path().ok()).collect());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, event);
        }
    });
}
