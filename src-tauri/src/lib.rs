mod audio;
mod dj;
mod media;
mod shell;
mod volume;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      shell::build_tray(app.handle())?;
      audio::start(app.handle().clone());
      Ok(())
    })
    .on_window_event(|window, event| {
      // Closing the panel keeps SongSeam running in the tray.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      media::now_playing,
      media::now_playing_art,
      media::media_control,
      volume::get_app_volume,
      volume::set_app_volume,
      volume::fade_app_volume,
      shell::overlay_set,
      shell::overlay_is_visible,
      shell::spotify_login,
      dj::dj_start,
      dj::dj_stop,
      dj::dj_status,
      shell::client_log,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
