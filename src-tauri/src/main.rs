// Windows release builds should not also open a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pad_lib::run()
}
