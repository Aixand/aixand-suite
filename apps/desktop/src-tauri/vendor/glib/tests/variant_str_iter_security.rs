// Regression for RUSTSEC-2024-0429; also run this test with --release.
use glib::prelude::*;

#[test]
fn string_variant_iteration_preserves_out_pointer_writes() {
    let values: &[&str] = &["alpha", "beta", "gamma", "delta"];
    let variant = values.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().collect::<Vec<_>>(), values);
    assert_eq!(variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(), vec!["delta", "gamma", "beta", "alpha"]);
    assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("beta"));
    assert_eq!(variant.array_iter_str().unwrap().nth_back(1), Some("gamma"));
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("delta"));
}
