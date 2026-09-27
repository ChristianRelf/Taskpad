//! Behaviour tests for the storage layer: hierarchy, completion roll-up,
//! ordering and export/import round trips.

use crate::db::model::TaskPatch;
use crate::db::{tasks, Db};
use crate::transfer;

fn new_pad() -> Db {
    Db::open_in_memory().expect("open in-memory pad")
}

fn add(db: &Db, parent: Option<&str>, title: &str) -> String {
    tasks::create(&db.lock(), parent, None, title)
        .expect("create task")
        .id
}

fn titles_in_order(db: &Db, parent: Option<&str>) -> Vec<String> {
    let snap = tasks::snapshot(&db.lock()).unwrap();
    let mut rows: Vec<_> = snap
        .tasks
        .iter()
        .filter(|t| t.parent_id.as_deref() == parent)
        .collect();
    rows.sort_by(|a, b| a.position.cmp(&b.position));
    rows.into_iter().map(|t| t.title.clone()).collect()
}

fn is_done(db: &Db, id: &str) -> bool {
    tasks::get(&db.lock(), id).unwrap().completed_at.is_some()
}

#[test]
fn creates_and_reads_back_a_task() {
    let db = new_pad();
    let id = add(&db, None, "  Buy stamps  ");
    let task = tasks::get(&db.lock(), &id).unwrap();
    assert_eq!(task.title, "Buy stamps", "title is trimmed on the way in");
    assert!(task.completed_at.is_none());
    assert!(task.parent_id.is_none());
    assert_eq!(tasks::snapshot(&db.lock()).unwrap().tasks.len(), 1);
}

#[test]
fn new_siblings_append_in_order() {
    let db = new_pad();
    for t in ["one", "two", "three"] {
        add(&db, None, t);
    }
    assert_eq!(titles_in_order(&db, None), ["one", "two", "three"]);
}

#[test]
fn a_task_can_be_inserted_between_two_others() {
    let db = new_pad();
    let first = add(&db, None, "one");
    add(&db, None, "three");
    tasks::create(&db.lock(), None, Some(&first), "two").unwrap();
    assert_eq!(titles_in_order(&db, None), ["one", "two", "three"]);
}

#[test]
fn hierarchy_nests_to_arbitrary_depth() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, Some(&a), "b");
    let c = add(&db, Some(&b), "c");
    let d = add(&db, Some(&c), "d");
    assert_eq!(tasks::get(&db.lock(), &d).unwrap().parent_id.as_deref(), Some(c.as_str()));
    assert_eq!(titles_in_order(&db, Some(&c)), ["d"]);
}

#[test]
fn completing_a_parent_completes_its_whole_subtree() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, Some(&a), "b");
    let c = add(&db, Some(&b), "c");

    tasks::set_completed(&db.lock(), &a, true).unwrap();
    assert!(is_done(&db, &a) && is_done(&db, &b) && is_done(&db, &c));

    tasks::set_completed(&db.lock(), &a, false).unwrap();
    assert!(!is_done(&db, &a) && !is_done(&db, &b) && !is_done(&db, &c));
}

#[test]
fn a_parent_closes_once_its_last_child_closes() {
    let db = new_pad();
    let parent = add(&db, None, "parent");
    let one = add(&db, Some(&parent), "one");
    let two = add(&db, Some(&parent), "two");

    tasks::set_completed(&db.lock(), &one, true).unwrap();
    assert!(!is_done(&db, &parent), "still one child open");

    tasks::set_completed(&db.lock(), &two, true).unwrap();
    assert!(is_done(&db, &parent), "all children closed");

    tasks::set_completed(&db.lock(), &two, false).unwrap();
    assert!(!is_done(&db, &parent), "reopening a child reopens the parent");
}

#[test]
fn roll_up_travels_past_the_immediate_parent() {
    let db = new_pad();
    let top = add(&db, None, "top");
    let mid = add(&db, Some(&top), "mid");
    let leaf = add(&db, Some(&mid), "leaf");

    tasks::set_completed(&db.lock(), &leaf, true).unwrap();
    assert!(is_done(&db, &mid) && is_done(&db, &top));

    tasks::set_completed(&db.lock(), &leaf, false).unwrap();
    assert!(!is_done(&db, &mid) && !is_done(&db, &top));
}

#[test]
fn adding_a_child_reopens_a_completed_parent() {
    let db = new_pad();
    let parent = add(&db, None, "parent");
    tasks::set_completed(&db.lock(), &parent, true).unwrap();
    assert!(is_done(&db, &parent));

    add(&db, Some(&parent), "new work");
    assert!(!is_done(&db, &parent), "an open child reopens its parent");
}

#[test]
fn indent_and_outdent_reparent_the_task() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, None, "b");

    tasks::move_task(&db.lock(), &b, Some(&a), None).unwrap();
    assert_eq!(titles_in_order(&db, Some(&a)), ["b"]);
    assert_eq!(titles_in_order(&db, None), ["a"]);

    tasks::move_task(&db.lock(), &b, None, Some(&a)).unwrap();
    assert_eq!(titles_in_order(&db, None), ["a", "b"]);
}

#[test]
fn a_task_cannot_be_moved_into_its_own_subtree() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, Some(&a), "b");
    let c = add(&db, Some(&b), "c");

    assert!(tasks::move_task(&db.lock(), &a, Some(&a), None).is_err(), "self");
    assert!(tasks::move_task(&db.lock(), &a, Some(&b), None).is_err(), "child");
    assert!(tasks::move_task(&db.lock(), &a, Some(&c), None).is_err(), "grandchild");
    // The failed moves must not have touched anything.
    assert_eq!(tasks::get(&db.lock(), &a).unwrap().parent_id, None);
}

#[test]
fn reordering_within_a_list_keeps_every_sibling() {
    let db = new_pad();
    let a = add(&db, None, "a");
    add(&db, None, "b");
    let c = add(&db, None, "c");

    tasks::move_task(&db.lock(), &c, None, None).unwrap();
    assert_eq!(titles_in_order(&db, None), ["a", "b", "c"]);

    tasks::move_task(&db.lock(), &c, None, Some(&a)).unwrap();
    assert_eq!(titles_in_order(&db, None), ["a", "c", "b"]);
}

#[test]
fn deleting_a_task_hides_its_descendants_too() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, Some(&a), "b");
    add(&db, Some(&b), "c");
    add(&db, None, "keep");

    tasks::delete(&db.lock(), &a).unwrap();
    let snap = tasks::snapshot(&db.lock()).unwrap();
    assert_eq!(snap.tasks.len(), 1);
    assert_eq!(snap.tasks[0].title, "keep");
}

#[test]
fn deleting_the_last_open_child_closes_the_parent() {
    let db = new_pad();
    let parent = add(&db, None, "parent");
    let done = add(&db, Some(&parent), "done");
    let open = add(&db, Some(&parent), "open");
    tasks::set_completed(&db.lock(), &done, true).unwrap();

    tasks::delete(&db.lock(), &open).unwrap();
    assert!(is_done(&db, &parent));
}

#[test]
fn patches_update_only_the_named_fields() {
    let db = new_pad();
    let id = add(&db, None, "title");
    tasks::update(
        &db.lock(),
        &id,
        &TaskPatch {
            description: Some(Some("a short line".into())),
            ..Default::default()
        },
    )
    .unwrap();
    tasks::update(
        &db.lock(),
        &id,
        &TaskPatch {
            due_at: Some(Some(1_700_000_000_000)),
            ..Default::default()
        },
    )
    .unwrap();

    let t = tasks::get(&db.lock(), &id).unwrap();
    assert_eq!(t.title, "title", "untouched by later patches");
    assert_eq!(t.description.as_deref(), Some("a short line"));
    assert_eq!(t.due_at, Some(1_700_000_000_000));
}

#[test]
fn an_explicit_null_clears_a_field() {
    let db = new_pad();
    let id = add(&db, None, "t");
    tasks::update(
        &db.lock(),
        &id,
        &TaskPatch { due_at: Some(Some(1)), ..Default::default() },
    )
    .unwrap();
    tasks::update(
        &db.lock(),
        &id,
        &TaskPatch { due_at: Some(None), ..Default::default() },
    )
    .unwrap();
    assert_eq!(tasks::get(&db.lock(), &id).unwrap().due_at, None);
}

#[test]
fn tags_are_shared_by_name_and_detached_per_task() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, None, "b");

    let t1 = tasks::attach_tag(&db.lock(), &a, "Home").unwrap();
    let t2 = tasks::attach_tag(&db.lock(), &b, "home").unwrap();
    assert_eq!(t1.id, t2.id, "same name reuses one tag row");

    let snap = tasks::snapshot(&db.lock()).unwrap();
    assert_eq!(snap.tags.len(), 1);
    assert!(snap.tasks.iter().all(|t| t.tag_ids.len() == 1));

    tasks::detach_tag(&db.lock(), &a, &t1.id).unwrap();
    let snap = tasks::snapshot(&db.lock()).unwrap();
    let a_row = snap.tasks.iter().find(|t| t.id == a).unwrap();
    let b_row = snap.tasks.iter().find(|t| t.id == b).unwrap();
    assert!(a_row.tag_ids.is_empty());
    assert_eq!(b_row.tag_ids.len(), 1, "b keeps the tag");
}

#[test]
fn empty_tag_names_are_refused() {
    let db = new_pad();
    let a = add(&db, None, "a");
    assert!(tasks::attach_tag(&db.lock(), &a, "   ").is_err());
}

#[test]
fn data_survives_reopening_the_file() {
    let dir = std::env::temp_dir().join(format!("pad-test-{}", crate::db::new_id()));
    let path = dir.join("pad.sqlite3");

    let id = {
        let db = Db::open(&path).unwrap();
        let a = add(&db, None, "persist me");
        let b = add(&db, Some(&a), "child");
        tasks::set_completed(&db.lock(), &b, true).unwrap();
        a
    };

    let db = Db::open(&path).unwrap();
    let snap = tasks::snapshot(&db.lock()).unwrap();
    assert_eq!(snap.tasks.len(), 2);
    assert!(is_done(&db, &id), "roll-up survived the restart");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn export_import_round_trips_through_a_file() {
    let db = new_pad();
    let a = add(&db, None, "groceries");
    let b = add(&db, Some(&a), "milk");
    add(&db, Some(&a), "bread");
    tasks::attach_tag(&db.lock(), &a, "errands").unwrap();
    tasks::update(
        &db.lock(),
        &b,
        &TaskPatch {
            notes: Some(Some("semi-skimmed\nhttps://example.com".into())),
            ..Default::default()
        },
    )
    .unwrap();

    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    transfer::write_pack(&db.lock(), &path).unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() > 0);

    let fresh = new_pad();
    let pack = transfer::read_pack(&path).unwrap();
    let report = transfer::import_pack(&mut fresh.lock(), pack).unwrap();
    assert_eq!(report.tasks_added, 3);
    assert_eq!(report.repaired, 0);

    let before = tasks::snapshot(&db.lock()).unwrap();
    let after = tasks::snapshot(&fresh.lock()).unwrap();
    assert_eq!(before.tasks.len(), after.tasks.len());
    assert_eq!(titles_in_order(&fresh, Some(&a)), ["milk", "bread"]);
    let milk = after.tasks.iter().find(|t| t.id == b).unwrap();
    assert_eq!(milk.notes.as_deref(), Some("semi-skimmed\nhttps://example.com"));
    assert_eq!(after.tags.len(), 1);
    assert_eq!(after.tags[0].name, "errands");

    std::fs::remove_file(&path).ok();
}

#[test]
fn importing_the_same_pack_twice_changes_nothing() {
    let db = new_pad();
    add(&db, None, "once");
    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    transfer::write_pack(&db.lock(), &path).unwrap();

    let target = new_pad();
    transfer::import_pack(&mut target.lock(), transfer::read_pack(&path).unwrap()).unwrap();
    let second =
        transfer::import_pack(&mut target.lock(), transfer::read_pack(&path).unwrap()).unwrap();

    assert_eq!(second.tasks_added, 0);
    assert_eq!(second.tasks_updated, 0);
    assert_eq!(second.tasks_skipped, 1);
    assert_eq!(tasks::snapshot(&target.lock()).unwrap().tasks.len(), 1);

    std::fs::remove_file(&path).ok();
}

#[test]
fn a_stale_pack_does_not_overwrite_newer_local_edits() {
    let db = new_pad();
    let id = add(&db, None, "old title");
    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    transfer::write_pack(&db.lock(), &path).unwrap();

    // Force the local row to be strictly newer than the exported copy.
    db.lock()
        .execute(
            "UPDATE tasks SET title = 'new title', updated_at = updated_at + 5000 WHERE id = ?1",
            rusqlite::params![id],
        )
        .unwrap();

    transfer::import_pack(&mut db.lock(), transfer::read_pack(&path).unwrap()).unwrap();
    assert_eq!(tasks::get(&db.lock(), &id).unwrap().title, "new title");

    std::fs::remove_file(&path).ok();
}

#[test]
fn deletions_propagate_through_a_pack() {
    let db = new_pad();
    let a = add(&db, None, "a");
    add(&db, None, "b");
    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));

    let target = imported_copy(&db, &path);
    assert_eq!(tasks::snapshot(&target.lock()).unwrap().tasks.len(), 2);

    tasks::delete(&db.lock(), &a).unwrap();
    transfer::write_pack(&db.lock(), &path).unwrap();
    transfer::import_pack(&mut target.lock(), transfer::read_pack(&path).unwrap()).unwrap();

    let snap = tasks::snapshot(&target.lock()).unwrap();
    assert_eq!(snap.tasks.len(), 1);
    assert_eq!(snap.tasks[0].title, "b");

    std::fs::remove_file(&path).ok();
}

fn imported_copy(source: &Db, path: &std::path::Path) -> Db {
    transfer::write_pack(&source.lock(), path).unwrap();
    let target = new_pad();
    transfer::import_pack(&mut target.lock(), transfer::read_pack(path).unwrap()).unwrap();
    target
}

#[test]
fn a_newer_format_version_is_refused() {
    let db = new_pad();
    add(&db, None, "x");
    let mut pack = transfer::build_pack(&db.lock()).unwrap();
    pack.format_version = transfer::FORMAT_VERSION + 1;

    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    std::fs::write(&path, serde_json::to_vec(&pack).unwrap()).unwrap();

    let err = transfer::read_pack(&path).unwrap_err().to_string();
    assert!(err.contains("newer version of Pad"), "{err}");

    std::fs::remove_file(&path).ok();
}

#[test]
fn a_foreign_file_is_refused_cleanly() {
    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    std::fs::write(&path, b"{\"hello\":\"world\"}").unwrap();
    assert!(transfer::read_pack(&path).is_err());

    std::fs::write(&path, b"not json at all").unwrap();
    assert!(transfer::read_pack(&path).is_err());

    std::fs::remove_file(&path).ok();
}

#[test]
fn a_pack_with_a_dangling_parent_is_repaired_not_dropped() {
    let db = new_pad();
    let a = add(&db, None, "orphan");
    let mut pack = transfer::build_pack(&db.lock()).unwrap();
    // Stand in for a pack that references a task the sender never included.
    pack.tasks[0].parent_id = Some("does-not-exist".into());

    let target = new_pad();
    let report = transfer::import_pack(&mut target.lock(), pack).unwrap();
    assert_eq!(report.tasks_added, 1);
    assert_eq!(report.repaired, 1);
    assert_eq!(tasks::get(&target.lock(), &a).unwrap().parent_id, None);
}

#[test]
fn a_parent_cycle_in_a_pack_is_broken_on_import() {
    let db = new_pad();
    let a = add(&db, None, "a");
    let b = add(&db, Some(&a), "b");
    let mut pack = transfer::build_pack(&db.lock()).unwrap();
    // Hand-edited pack: a points at its own child, so the pair is unreachable.
    for task in &mut pack.tasks {
        if task.id == a {
            task.parent_id = Some(b.clone());
        }
    }

    let target = new_pad();
    let report = transfer::import_pack(&mut target.lock(), pack).unwrap();
    assert!(report.repaired > 0);
    let snap = tasks::snapshot(&target.lock()).unwrap();
    assert_eq!(snap.tasks.len(), 2, "both tasks remain reachable");
    assert!(snap.tasks.iter().any(|t| t.parent_id.is_none()));
}

#[test]
fn exports_are_actually_compressed() {
    let db = new_pad();
    for i in 0..200 {
        add(&db, None, &format!("a fairly repetitive task title number {i}"));
    }
    let path = std::env::temp_dir().join(format!("pad-{}.padpack", crate::db::new_id()));
    let gz = transfer::write_pack(&db.lock(), &path).unwrap();
    let raw = serde_json::to_vec(&transfer::build_pack(&db.lock()).unwrap())
        .unwrap()
        .len() as u64;
    assert!(gz < raw / 2, "gzip {gz} should be well under raw {raw}");

    std::fs::remove_file(&path).ok();
}

#[test]
fn a_large_pad_snapshots_quickly() {
    let db = new_pad();
    {
        let conn = db.lock();
        conn.execute_batch("BEGIN").unwrap();
        let mut parent: Option<String> = None;
        for i in 0..2000 {
            let t = tasks::create(&conn, parent.as_deref(), None, &format!("task {i}")).unwrap();
            // A wide tree with a shallow spine, closer to real use than a chain.
            if i % 8 == 0 {
                parent = Some(t.id);
            }
        }
        conn.execute_batch("COMMIT").unwrap();
    }
    let start = std::time::Instant::now();
    let snap = tasks::snapshot(&db.lock()).unwrap();
    let elapsed = start.elapsed();
    assert_eq!(snap.tasks.len(), 2000);
    assert!(elapsed.as_millis() < 500, "snapshot took {elapsed:?}");
}
