#[test]
fn probe() {
    println!("OUT: {}", crate::redact::redact_credentials("http://user:secret@127.0.0.1:14995/x"));
    println!("OUT2: {}", crate::redact::redact_credentials("https://user:secret@example.com/x"));
}
