mod commands;
mod db;
mod error;
mod links;
mod transfer;

#[cfg(test)]
mod tests;

use tauri::Manager;

/// Resolved on startup so both the app and `app_info` agree on where the pad lives.
pub struct Paths {
    pub database: std::path::PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let database = dir.join("pad.sqlite3");
            let conn = db::Db::open(&database)?;
            app.manage(conn);
            app.manage(Paths { database });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::task_create,
            commands::task_update,
            commands::task_set_completed,
            commands::task_delete,
            commands::task_move,
            commands::tag_attach,
            commands::tag_detach,
            commands::link_preview,
            commands::export_pad,
            commands::import_pad,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pad");
}
